import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ApiContext } from "@/lib/api/context";
import { runDiagnosis, type DiagnosisState } from "@/lib/agents/diagnosis-graph";
import type { DiagnosisModel } from "@/lib/agents/model";
import { logEvent } from "@/lib/logging";
import { agentTelemetry, type AgentTelemetry } from "@/lib/observability/agent-telemetry";
import { beginAttempt, demoResourceExists, escalateRun, storeDiagnosis,
  setAgentTraceId, verifyAttempt, type Verification } from "./service";
import { executeRecoveryTool, type RecoveryToolResult } from "./tools";

const State = Annotation.Root({
  runId: Annotation<string>(),
  incidentId: Annotation<string>(),
  authorizationId: Annotation<string>(),
  websiteId: Annotation<string>(),
  diagnosis: Annotation<DiagnosisState | null>(),
  actionId: Annotation<"reset_demo_service" | null>(),
  attemptId: Annotation<string | null>(),
  attemptCount: Annotation<number>(),
  toolResult: Annotation<RecoveryToolResult | null>(),
  verification: Annotation<Verification | null>(),
  outcome: Annotation<"running" | "recovered" | "escalated" | "duplicate">(),
  reason: Annotation<string | null>(),
  stepCount: Annotation<number>(),
});

export type RecoveryState = typeof State.State;

function observedNode<T>(telemetry: AgentTelemetry, name: string, kind: "CHAIN" | "AGENT" | "TOOL" | "GUARDRAIL",
  work: (state: RecoveryState, span?: Parameters<Parameters<typeof import("neatlogs").trace>[1]>[0]) => Promise<T>) {
  return (state: RecoveryState) => telemetry.stage(`recovery.${name}`, kind, {
    "siteguard.run_id": state.runId,
    "siteguard.incident_id": state.incidentId,
    "siteguard.website_id": state.websiteId,
    "siteguard.attempt_number": state.attemptCount,
  }, (span) => work(state, span));
}

export function createRecoveryGraph(ctx: ApiContext, worker: SupabaseClient, model: DiagnosisModel,
  telemetry: AgentTelemetry = agentTelemetry) {
  return new StateGraph(State)
    .addNode("diagnose", observedNode(telemetry, "diagnose", "CHAIN", async (state) => {
      const diagnosis = await runDiagnosis(ctx, state.incidentId, model, state.runId, telemetry);
      await telemetry.stage("recovery.persist_diagnosis", "CHAIN", {
        "siteguard.run_id": state.runId,
      }, () => storeDiagnosis(worker, diagnosis));
      return { diagnosis, websiteId: diagnosis.websiteId, stepCount: state.stepCount + 1 };
    }))
    .addNode("select_action", observedNode(telemetry, "select_action", "AGENT", async (state, span) => {
      const evidence = state.diagnosis?.diagnosis;
      const isDemo = state.websiteId && await demoResourceExists(ctx, state.websiteId);
      const safe = Boolean(isDemo && evidence?.status === "conclusive" &&
        evidence.supporting_evidence.some((item) => item.ref.startsWith("check:")) &&
        (state.diagnosis?.monitoringHistory.filter((check) => check.status !== "healthy").length ?? 0) >= 2);
      span?.setAttribute("siteguard.selected_action", safe ? "reset_demo_service" : "none");
      return { actionId: safe ? "reset_demo_service" as const : null,
        reason: safe ? null : "no_safe_action", stepCount: state.stepCount + 1 };
    }))
    .addNode("authorize", observedNode(telemetry, "authorize", "GUARDRAIL", async (state, span) => {
      const nextAttempt = state.attemptCount + 1 as 1 | 2;
      const claim = await beginAttempt(worker, state.runId, ctx.userId,
        state.authorizationId, nextAttempt);
      span?.setAttribute("siteguard.authorization_decision", claim.decision);
      if (claim.attempt_id) span?.setAttribute("siteguard.attempt_id", claim.attempt_id);
      if (claim.decision === "denied") return {
        outcome: "escalated" as const, reason: "authorization_denied",
        stepCount: state.stepCount + 1,
      };
      if (claim.decision === "duplicate" || !claim.attempt_id) return {
        outcome: "duplicate" as const, reason: "duplicate_attempt",
        stepCount: state.stepCount + 1,
      };
      return { attemptId: claim.attempt_id, attemptCount: nextAttempt,
        stepCount: state.stepCount + 1 };
    }))
    .addNode("execute", observedNode(telemetry, "execute", "TOOL", async (state, span) => {
      if (!state.actionId || !state.attemptId) throw new Error("Recovery attempt missing");
      span?.setAttribute("neatlogs.tool.name", state.actionId);
      span?.setAttribute("siteguard.attempt_id", state.attemptId);
      const toolResult = await executeRecoveryTool(worker, {
        action_id: state.actionId, resource_id: state.websiteId,
        attempt_id: state.attemptId,
      });
      span?.setAttribute("siteguard.tool_result", toolResult.result_code);
      if (toolResult.result_code !== "RESET_APPLIED") {
        span?.setStatus({ code: 2, message: toolResult.result_code });
      }
      return { toolResult, stepCount: state.stepCount + 1 };
    }))
    .addNode("verify", observedNode(telemetry, "verify", "GUARDRAIL", async (state, span) => {
      if (!state.attemptId) throw new Error("Recovery attempt missing");
      span?.setAttribute("siteguard.attempt_id", state.attemptId);
      const verification = await telemetry.stage("recovery.persist_verification_outcome", "CHAIN", {
        "siteguard.run_id": state.runId,
        "siteguard.attempt_id": state.attemptId,
      }, () => verifyAttempt(worker, state.attemptId!));
      span?.setAttribute("siteguard.verification_outcome", verification.outcome);
      if (verification.outcome !== "recovered") {
        span?.setStatus({ code: 2, message: verification.outcome });
      }
      if (verification.check_id) span?.setAttribute("siteguard.verification_check_id", verification.check_id);
      return { verification, outcome: verification.outcome === "recovered"
        ? "recovered" as const : verification.outcome === "escalated"
          ? "escalated" as const : "running" as const,
        reason: verification.outcome === "escalated" ? "verification_failed" : null,
        stepCount: state.stepCount + 1 };
    }))
    .addNode("escalate", observedNode(telemetry, "escalate", "CHAIN", async (state, span) => {
      const reason = state.reason === "authorization_denied" ? "authorization_denied"
        : state.reason === "no_safe_action" ? "no_safe_action"
          : state.reason === "verification_failed" ? "verification_failed" : "run_failed";
      await telemetry.stage("recovery.persist_escalation", "CHAIN", {
        "siteguard.run_id": state.runId, "siteguard.reason": reason,
      }, () => escalateRun(worker, state.runId, reason));
      span?.setAttribute("siteguard.escalation_reason", reason);
      return { outcome: "escalated" as const, reason, stepCount: state.stepCount + 1 };
    }))
    .addEdge(START, "diagnose")
    .addEdge("diagnose", "select_action")
    .addConditionalEdges("select_action", (state) => state.actionId ? "authorize" : "escalate", {
      authorize: "authorize", escalate: "escalate",
    })
    .addConditionalEdges("authorize", (state) => state.outcome === "running" ? "execute" : "end", {
      execute: "execute", end: END,
    })
    .addConditionalEdges("execute", (state) => state.toolResult?.result_code === "AUTHORIZATION_REVOKED" ? "escalate" : "verify", {
      escalate: "escalate", verify: "verify",
    })
    .addConditionalEdges("verify", (state) => state.outcome === "running" && state.attemptCount < 2
      ? "retry" : "end", { retry: "authorize", end: END })
    .addEdge("escalate", END)
    .compile();
}

export async function runRecoveryGraph(ctx: ApiContext, worker: SupabaseClient,
  model: DiagnosisModel, incidentId: string, authorizationId: string, runId: string,
  telemetry: AgentTelemetry = agentTelemetry): Promise<RecoveryState> {
  const initial: RecoveryState = {
    runId, incidentId, authorizationId, websiteId: "", diagnosis: null,
    actionId: null, attemptId: null, attemptCount: 0, toolResult: null,
    verification: null, outcome: "running", reason: null, stepCount: 0,
  };
  return telemetry.run("recovery", { runId, incidentId }, async () => {
    try {
      const final = await createRecoveryGraph(ctx, worker, model, telemetry).invoke(initial, {
      recursionLimit: 16, signal: AbortSignal.timeout(47_000),
      });
      logEvent("info", "recovery.run_finished", {
        run_id: runId, incident_id: incidentId, outcome: final.outcome,
        attempt_count: final.attemptCount,
      });
      return final;
    } catch {
      await telemetry.stage("recovery.persist_failure", "CHAIN", {
        "siteguard.run_id": runId,
      }, () => escalateRun(worker, runId, "run_failed"));
      throw new Error("Recovery run failed");
    }
  }, (traceId) => setAgentTraceId(worker, runId, traceId));
}
