import { handleApi } from "@/lib/api/errors";
import { requireApiContext } from "@/lib/api/context";
import { createMonitoringWorkerClient } from "@/lib/database/worker";
import { uuidSchema } from "@/lib/validation/incident";
import { revokeDemoRecovery } from "@/lib/recovery/service";

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handleApi(async () => {
    const ctx = await requireApiContext();
    const id = uuidSchema.parse((await params).id);
    await revokeDemoRecovery(ctx, createMonitoringWorkerClient(), id);
    return { data: { id, revoked: true } };
  });
}
