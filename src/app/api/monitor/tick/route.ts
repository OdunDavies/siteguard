import { timingSafeEqual } from "node:crypto";
import { connection } from "next/server";
import { ApiError, handleApi } from "@/lib/api/errors";
import { createMonitoringWorkerClient } from "@/lib/database/worker";
import { runMonitoringCheck } from "@/lib/monitoring/service";
import { logEvent } from "@/lib/logging";

function verifyScheduler(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) throw new ApiError(503, "SCHEDULER_NOT_CONFIGURED", "Scheduler is not configured");
  const provided = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  const expectedBytes = Buffer.from(secret);
  const providedBytes = Buffer.from(provided);
  if (providedBytes.length !== expectedBytes.length || !timingSafeEqual(providedBytes, expectedBytes)) {
    throw new ApiError(401, "UNAUTHENTICATED", "Scheduler authentication required");
  }
}

export async function GET(request: Request) {
  await connection();
  return handleApi(async () => {
    verifyScheduler(request);
    const worker = createMonitoringWorkerClient();
    const { data, error } = await worker.from("websites").select("id")
      .eq("is_enabled", true).is("deleted_at", null)
      .lte("next_check_at", new Date().toISOString())
      .order("next_check_at", { ascending: true }).limit(2);
    if (error) throw new ApiError(500, "DATABASE_ERROR", "Could not load due websites");

    const results: Array<{ website_id: string; status: string }> = [];
    for (const site of data ?? []) {
      try {
        const { observation } = await runMonitoringCheck(worker, site.id, "scheduled", null);
        results.push({ website_id: site.id, status: observation.status });
      } catch (error) {
        if (error instanceof ApiError && error.code === "CHECK_NOT_DUE") continue;
        logEvent("warn", "monitor.scheduled_check_failed", { website_id: site.id });
        results.push({ website_id: site.id, status: "failed" });
      }
    }
    return { data: { processed: results.length, results } };
  });
}
