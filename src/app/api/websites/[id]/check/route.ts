import { handleApi } from "@/lib/api/errors";
import { requireApiContext } from "@/lib/api/context";
import { requireOwnedWebsite } from "@/lib/database/repository";
import { createMonitoringWorkerClient } from "@/lib/database/worker";
import { runMonitoringCheck } from "@/lib/monitoring/service";
import { uuidSchema } from "@/lib/validation/incident";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handleApi(async () => {
    const ctx = await requireApiContext();
    const websiteId = uuidSchema.parse((await params).id);
    await requireOwnedWebsite(ctx, websiteId);
    const result = await runMonitoringCheck(
      createMonitoringWorkerClient(), websiteId, "manual", ctx.userId,
    );
    return { data: result };
  });
}
