import { handleApi, readJson } from "@/lib/api/errors";
import { requireApiContext } from "@/lib/api/context";
import { createMonitoringWorkerClient } from "@/lib/database/worker";
import { uuidSchema } from "@/lib/validation/incident";
import { grantDemoRecovery } from "@/lib/recovery/service";
import { grantRequestSchema } from "@/lib/recovery/validation";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handleApi(async () => {
    const ctx = await requireApiContext();
    const id = uuidSchema.parse((await params).id);
    const input = grantRequestSchema.parse(await readJson(request));
    return { data: await grantDemoRecovery(ctx, createMonitoringWorkerClient(),
      id, input.expires_at, input.max_uses), status: 201 };
  });
}
