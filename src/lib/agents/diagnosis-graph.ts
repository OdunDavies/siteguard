import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import type { ApiContext } from "@/lib/api/context";
import { ApiError } from "@/lib/api/errors";
import { requireOwnedWebsite } from "@/lib/database/repository";
import { uuidSchema } from "@/lib/validation/incident";
import { agentTelemetry, type AgentTelemetry } from "@/lib/observability/agent-telemetry";
import type { HealthCheck, Incident } from "@/types/domain";
import { diagnosisSchema, modelAssessmentSchema, type Diagnosis, type DiagnosticToolId, type ModelAssessment } from "./diagnosis-schema";
import { createDiagnosticTools, type DiagnosticToolResult, type ToolName } from "./diagnostic-tools";
import type { DiagnosisModel } from "./model";

const MAX_STEPS = 15;
const MAX_TOOLS = 4;
const MAX_MODELS = 2;
const MAX_WALL_MS = 30_000;

const State = Annotation.Root({
  agentRunId: Annotation<string>(),
  incidentId: Annotation<string>(),
  websiteId: Annotation<string>(),
  currentIncident: Annotation<Incident | null>(),
  monitoringHistory: Annotation<HealthCheck[]>(),
  diagnosticResults: Annotation<DiagnosticToolResult[]>(),
  selectedDiagnosticActions: Annotation<ToolName[]>(),
  selectedTool: Annotation<DiagnosticToolId | null>(),
  assessment: Annotation<ModelAssessment | null>(),
  probableRootCauses: Annotation<ModelAssessment["probable_causes"]>(),
  confidence: Annotation<"low" | "medium" | "high">(),
  recoveryRecommendations: Annotation<Diagnosis["recommended_recovery_actions"]>(),
  verificationFindings: Annotation<string[]>(),
  diagnosis: Annotation<Diagnosis | null>(),
  executionStatus: Annotation<"running" | "completed" | "inconclusive">(),
  errorCodes: Annotation<string[]>(),
  iterationCount: Annotation<number>(),
  stepCount: Annotation<number>(),
  toolCalls: Annotation<number>(),
  modelCalls: Annotation<number>(),
  deadlineAt: Annotation<number>(),
});

export type DiagnosisState = typeof State.State;

function observedNode<T>(telemetry: AgentTelemetry, name: string, kind: "CHAIN" | "AGENT" | "GUARDRAIL",
  work: (state: DiagnosisState, span?: Parameters<Parameters<typeof import("neatlogs").trace>[1]>[0]) => Promise<T>) {
  return (state: DiagnosisState) => telemetry.stage(`diagnosis.${name}`, kind, {
    "siteguard.run_id": state.agentRunId,
    "siteguard.incident_id": state.incidentId,
    "siteguard.website_id": state.websiteId,
  }, (span) => work(state, span));
}

function step(state: DiagnosisState) {
  if (state.stepCount >= MAX_STEPS || Date.now() >= state.deadlineAt) {
    throw new Error("Diagnosis execution limit reached");
  }
  return state.stepCount + 1;
}

function evidence(state: DiagnosisState) {
  return [
    ...(state.currentIncident ? [{ ref: `incident:${state.incidentId}`, observation: `Incident ${state.currentIncident.status}; failure category ${state.currentIncident.failure_kind ?? "unknown"}; ${state.currentIncident.consecutive_failures} consecutive failures` }] : []),
    ...state.diagnosticResults.flatMap((result) => result.evidence),
  ].slice(0, 12);
}

function modelContext(state: DiagnosisState): string {
  return JSON.stringify({
    incident_id: state.incidentId,
    failure_kind: state.currentIncident?.failure_kind ?? null,
    evidence: evidence(state),
    failed_tools: state.diagnosticResults.filter((result) => !result.ok).map((result) => result.tool),
    instruction: "Distinguish observations from possible causes. Select at most one further tool from the allowed IDs. If evidence is insufficient, use low confidence and list unknowns.",
  });
}

function fallbackTool(state: DiagnosisState): DiagnosticToolId | null {
  const preferred: DiagnosticToolId[] = state.currentIncident?.failure_kind === "timeout"
    ? ["response_time_analysis", "incident_history", "http_error_analysis"]
    : state.currentIncident?.failure_kind === "http_error"
      ? ["http_error_analysis", "incident_history", "response_time_analysis"]
      : ["incident_history", "http_error_analysis", "response_time_analysis"];
  const ordered = state.assessment?.next_tool
    ? [state.assessment.next_tool, ...preferred] : preferred;
  return ordered.find((tool) => !state.selectedDiagnosticActions.includes(tool)) ?? null;
}

function recommendations(state: DiagnosisState): Diagnosis["recommended_recovery_actions"] {
  if (!state.monitoringHistory.length) return [
    { action_id: "continue_monitoring", rationale: "No monitoring checks were available for diagnosis", requires_human_approval: false },
    { action_id: "escalate_human", rationale: "An operator should investigate the missing evidence", requires_human_approval: true },
  ];
  const kind = state.currentIncident?.failure_kind;
  if (kind === "http_error") return [
    { action_id: "inspect_application_logs", rationale: "Correlate repeated HTTP failures with application errors", requires_human_approval: true },
    { action_id: "investigate_deployment", rationale: "Check whether a recent deployment coincided with the failures", requires_human_approval: true },
  ];
  if (kind === "timeout") return [
    { action_id: "inspect_application_logs", rationale: "Investigate slow requests and upstream dependencies", requires_human_approval: true },
    { action_id: "retry_health_check", rationale: "Confirm whether the timeout continues", requires_human_approval: false },
  ];
  return [
    { action_id: "continue_monitoring", rationale: "Collect more checks before choosing an intervention", requires_human_approval: false },
    { action_id: "escalate_human", rationale: "Investigate the unresolved failure category", requires_human_approval: true },
  ];
}

export function createDiagnosisGraph(ctx: ApiContext, model: DiagnosisModel,
  telemetry: AgentTelemetry = agentTelemetry) {
  const graph = new StateGraph(State)
    .addNode("load_incident", observedNode(telemetry, "load_incident", "CHAIN", async (state) => {
      const stepCount = step(state);
      const { data, error } = await ctx.supabase.from("incidents").select("*")
        .eq("id", state.incidentId).maybeSingle();
      if (error) throw new ApiError(500, "DATABASE_ERROR", "Could not load incident");
      if (!data) throw new ApiError(404, "NOT_FOUND", "Incident not found");
      const incident = data as Incident;
      await requireOwnedWebsite(ctx, incident.website_id);
      return { currentIncident: incident, websiteId: incident.website_id, stepCount };
    }))
    .addNode("gather_initial_evidence", observedNode(telemetry, "gather_evidence", "CHAIN", async (state, span) => {
      const stepCount = step(state);
      const tools = createDiagnosticTools(ctx, state.websiteId, telemetry);
      const results = await Promise.all([
        tools.execute("monitoring_history"), tools.execute("service_metadata"),
      ]);
      span?.setAttribute("siteguard.check_count", results[0].checks?.length ?? 0);
      return {
        monitoringHistory: results[0].checks ?? [], diagnosticResults: results,
        selectedDiagnosticActions: ["monitoring_history", "service_metadata"] as ToolName[],
        toolCalls: 2, stepCount,
      };
    }))
    .addNode("analyze_incident", observedNode(telemetry, "analyze_incident", "AGENT", async (state) => {
      const stepCount = step(state);
      if (!state.monitoringHistory.length) return { stepCount, errorCodes: [...state.errorCodes, "INSUFFICIENT_HISTORY"] };
      if (state.modelCalls >= MAX_MODELS) return { stepCount };
      try {
        const assessment = modelAssessmentSchema.parse(await model.assess(modelContext(state)));
        return { assessment, modelCalls: state.modelCalls + 1, stepCount };
      } catch {
        return { modelCalls: state.modelCalls + 1, errorCodes: [...state.errorCodes, "MODEL_FAILED"], stepCount };
      }
    }))
    .addNode("select_diagnostic_tool", observedNode(telemetry, "select_diagnostic_tool", "AGENT", async (state, span) => {
      const stepCount = step(state);
      const selectedTool = state.toolCalls < MAX_TOOLS ? fallbackTool(state) : null;
      span?.setAttribute("siteguard.diagnostic_action", selectedTool ?? "none");
      return { selectedTool, stepCount };
    }))
    .addNode("execute_approved_tool", observedNode(telemetry, "execute_approved_tool", "CHAIN", async (state) => {
      const stepCount = step(state);
      if (!state.selectedTool || state.toolCalls >= MAX_TOOLS) return { stepCount };
      const result = await createDiagnosticTools(ctx, state.websiteId, telemetry).execute(state.selectedTool, state.monitoringHistory);
      return {
        diagnosticResults: [...state.diagnosticResults, result],
        selectedDiagnosticActions: [...state.selectedDiagnosticActions, state.selectedTool],
        toolCalls: state.toolCalls + 1, iterationCount: state.iterationCount + 1, stepCount,
        errorCodes: result.ok ? state.errorCodes : [...state.errorCodes, result.code],
      };
    }))
    .addNode("update_evidence", observedNode(telemetry, "update_evidence", "CHAIN", async (state) => ({ stepCount: step(state) })))
    .addNode("reassess_diagnosis", observedNode(telemetry, "reassess_diagnosis", "AGENT", async (state) => {
      const stepCount = step(state);
      if (!state.monitoringHistory.length || state.modelCalls >= MAX_MODELS) return { stepCount };
      try {
        const assessment = modelAssessmentSchema.parse(await model.assess(modelContext(state)));
        return { assessment, modelCalls: state.modelCalls + 1, stepCount };
      } catch {
        return { modelCalls: state.modelCalls + 1, errorCodes: [...state.errorCodes, "MODEL_FAILED"], stepCount };
      }
    }))
    .addNode("verify_evidence", observedNode(telemetry, "verify_evidence", "GUARDRAIL", async (state) => {
      const stepCount = step(state);
      const refs = new Set(evidence(state).map((item) => item.ref));
      const supported = state.assessment?.probable_causes.filter((cause) =>
        cause.evidence_refs.length > 0 && cause.evidence_refs.every((ref) => refs.has(ref))) ?? [];
      const findings = state.assessment?.probable_causes.length !== supported.length
        ? ["Unsupported model claims were omitted"] : [];
      if (state.diagnosticResults.some((result) => !result.ok)) findings.push("One or more diagnostic tools failed");
      if (!state.monitoringHistory.length) findings.push("No monitoring history was available");
      return {
        probableRootCauses: supported,
        confidence: supported.length && state.monitoringHistory.length >= 2 ? (state.assessment?.confidence ?? "low") : "low",
        verificationFindings: findings, stepCount,
      };
    }))
    .addNode("generate_recovery_plan", observedNode(telemetry, "generate_recovery_plan", "AGENT", async (state, span) => {
      const stepCount = step(state);
      const incident = state.currentIncident;
      if (!incident) throw new Error("Incident state missing");
      const actions = recommendations(state);
      const supportingEvidence = evidence(state);
      const inconclusive = !state.probableRootCauses.length || !state.monitoringHistory.length;
      const diagnosis = diagnosisSchema.parse({
        agent_run_id: state.agentRunId,
        incident_id: state.incidentId,
        website_id: state.websiteId,
        incident_summary: `Monitoring incident: ${incident.failure_kind ?? "unknown failure"}`,
        observed_symptoms: supportingEvidence.filter((item) => item.ref.startsWith("check:") || item.ref.startsWith("incident:") || item.ref.startsWith("pattern:")).slice(0, 8).map((item) => item.observation),
        probable_causes: state.probableRootCauses,
        supporting_evidence: supportingEvidence,
        unknowns: [...(state.assessment?.unknowns ?? []), ...state.verificationFindings].slice(0, 8),
        confidence: inconclusive ? "low" : state.confidence,
        status: inconclusive ? "inconclusive" : "conclusive",
        recommended_recovery_actions: actions,
        risk_assessment: "Recommendations are advisory. No recovery operation was executed.",
        human_approval_required: actions.some((action) => action.requires_human_approval),
        diagnosed_at: new Date().toISOString(),
      });
      span?.setAttribute("siteguard.diagnosis_status", diagnosis.status);
      span?.setAttribute("siteguard.diagnostic_tool_failures", state.diagnosticResults.filter((result) => !result.ok).length);
      return { diagnosis, recoveryRecommendations: actions, executionStatus: inconclusive ? "inconclusive" : "completed", stepCount };
    }))
    .addEdge(START, "load_incident")
    .addEdge("load_incident", "gather_initial_evidence")
    .addEdge("gather_initial_evidence", "analyze_incident")
    .addEdge("analyze_incident", "select_diagnostic_tool")
    .addConditionalEdges("select_diagnostic_tool", (state) => state.selectedTool ? "execute" : "verify", {
      execute: "execute_approved_tool", verify: "verify_evidence",
    })
    .addEdge("execute_approved_tool", "update_evidence")
    .addConditionalEdges("update_evidence", (state) => {
      const latest = state.diagnosticResults.at(-1);
      return latest && !latest.ok && state.toolCalls < MAX_TOOLS ? "fallback" : "reassess";
    }, { fallback: "select_diagnostic_tool", reassess: "reassess_diagnosis" })
    .addEdge("reassess_diagnosis", "verify_evidence")
    .addEdge("verify_evidence", "generate_recovery_plan")
    .addEdge("generate_recovery_plan", END);
  return graph.compile();
}

export async function runDiagnosis(ctx: ApiContext, incidentId: string, model: DiagnosisModel,
  runId = crypto.randomUUID(), telemetry: AgentTelemetry = agentTelemetry): Promise<DiagnosisState> {
  uuidSchema.parse(incidentId);
  uuidSchema.parse(runId);
  const initial: DiagnosisState = {
    agentRunId: runId, incidentId, websiteId: "",
    currentIncident: null, monitoringHistory: [], diagnosticResults: [],
    selectedDiagnosticActions: [], selectedTool: null, assessment: null,
    probableRootCauses: [], confidence: "low", recoveryRecommendations: [],
    verificationFindings: [], diagnosis: null, executionStatus: "running",
    errorCodes: [], iterationCount: 0, stepCount: 0, toolCalls: 0, modelCalls: 0,
    deadlineAt: Date.now() + MAX_WALL_MS,
  };
  return createDiagnosisGraph(ctx, model, telemetry).invoke(initial, {
    recursionLimit: MAX_STEPS + 2,
    signal: AbortSignal.timeout(MAX_WALL_MS),
  });
}
