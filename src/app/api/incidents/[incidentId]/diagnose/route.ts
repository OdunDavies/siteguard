import { handleApi, readJson, ApiError } from "@/lib/api/errors";
import { requireApiContext } from "@/lib/api/context";
import { createMonitoringWorkerClient } from "@/lib/database/worker";
import { uuidSchema } from "@/lib/validation/incident";
import { createDiagnosisModel } from "@/lib/agents/model";
import { runDiagnosis } from "@/lib/agents/diagnosis-graph";
import { failRun, startAgentRun, storeDiagnosis } from "@/lib/recovery/service";
import { runRequestSchema } from "@/lib/recovery/validation";
import { agentTelemetry } from "@/lib/observability/agent-telemetry";
import { setAgentTraceId } from "@/lib/recovery/service";

export const maxDuration = 60;

export async function POST(request: Request, { params }: { params: Promise<{ incidentId: string }> }) {
  return handleApi(async () => {
    const ctx = await requireApiContext();
    const incidentId = uuidSchema.parse((await params).incidentId);
    const input = runRequestSchema.parse(await readJson(request));
    const worker = createMonitoringWorkerClient();
    const claim = await startAgentRun(ctx, worker, incidentId, input.idempotency_key, "diagnosis");
    if (!claim.is_new) {
      const { data } = await ctx.supabase.from("agent_runs").select("*").eq("id", claim.run_id).single();
      return { data, status: claim.run_status === "running" ? 202 : 200 };
    }
    return agentTelemetry.run("diagnosis", { runId: claim.run_id, incidentId }, async () => {
      try {
        const state = await runDiagnosis(ctx, incidentId, createDiagnosisModel(), claim.run_id);
        await agentTelemetry.stage("diagnosis.persist_outcome", "CHAIN", {
          "siteguard.run_id": claim.run_id,
        }, () => storeDiagnosis(worker, state));
        return { data: { run_id: claim.run_id, diagnosis: state.diagnosis }, status: 201 };
      } catch {
        await agentTelemetry.stage("diagnosis.persist_failure", "CHAIN", {
          "siteguard.run_id": claim.run_id,
        }, () => failRun(worker, claim.run_id));
        throw new ApiError(500, "DIAGNOSIS_FAILED", "Diagnosis could not be completed");
      }
    }, (traceId) => setAgentTraceId(worker, claim.run_id, traceId));
  });
}
