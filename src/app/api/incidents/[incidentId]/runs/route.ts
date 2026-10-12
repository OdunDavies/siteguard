import { connection } from "next/server";
import { handleApi } from "@/lib/api/errors";
import { requireApiContext } from "@/lib/api/context";
import { uuidSchema } from "@/lib/validation/incident";
import { requireOwnedIncident } from "@/lib/recovery/service";

export async function GET(_request: Request, { params }: { params: Promise<{ incidentId: string }> }) {
  await connection();
  return handleApi(async () => {
    const ctx = await requireApiContext();
    const incidentId = uuidSchema.parse((await params).incidentId);
    await requireOwnedIncident(ctx, incidentId);
    const { data: runs, error } = await ctx.supabase.from("agent_runs").select("*")
      .eq("incident_id", incidentId).order("started_at", { ascending: false }).limit(20);
    if (error) throw new Error("Run lookup failed");
    const ids = (runs ?? []).map((run) => run.id);
    if (!ids.length) return { data: { runs: [], attempts: [] } };
    const { data: attempts, error: attemptError } = await ctx.supabase.from("recovery_attempts")
      .select("*").in("agent_run_id", ids).order("requested_at", { ascending: false }).limit(40);
    if (attemptError) throw new Error("Attempt lookup failed");
    return { data: { runs, attempts } };
  });
}
