import { handleApi, readJson, ApiError } from "@/lib/api/errors";
import { requireApiContext } from "@/lib/api/context";
import { createMonitoringWorkerClient } from "@/lib/database/worker";
import { uuidSchema } from "@/lib/validation/incident";
import { createDiagnosisModel } from "@/lib/agents/model";
import { runRecoveryGraph } from "@/lib/recovery/graph";
import { startAgentRun } from "@/lib/recovery/service";
import { recoverRequestSchema } from "@/lib/recovery/validation";

export const maxDuration = 60;

export async function POST(request: Request, { params }: { params: Promise<{ incidentId: string }> }) {
  return handleApi(async () => {
    const ctx = await requireApiContext();
    const incidentId = uuidSchema.parse((await params).incidentId);
    const input = recoverRequestSchema.parse(await readJson(request));
    const worker = createMonitoringWorkerClient();
    const claim = await startAgentRun(ctx, worker, incidentId, input.idempotency_key, "recovery");
    if (!claim.is_new) {
      const { data } = await ctx.supabase.from("agent_runs").select("*").eq("id", claim.run_id).single();
      return { data, status: claim.run_status === "running" ? 202 : 200 };
    }
    try {
      const state = await runRecoveryGraph(ctx, worker, createDiagnosisModel(),
        incidentId, input.authorization_id, claim.run_id);
      return { data: {
        run_id: claim.run_id, outcome: state.outcome,
        attempt_count: state.attemptCount,
        verification_check_id: state.verification?.check_id ?? null,
      }, status: 201 };
    } catch {
      throw new ApiError(500, "RECOVERY_FAILED", "Recovery run could not be completed");
    }
  });
}
