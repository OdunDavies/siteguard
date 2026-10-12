import { handleApi, readJson } from "@/lib/api/errors";
import { requireApiContext } from "@/lib/api/context";
import { createMonitoringWorkerClient } from "@/lib/database/worker";
import { uuidSchema } from "@/lib/validation/incident";
import { failDemo } from "@/lib/recovery/service";
import { failDemoRequestSchema } from "@/lib/recovery/validation";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handleApi(async () => {
    const ctx = await requireApiContext();
    const id = uuidSchema.parse((await params).id);
    const input = failDemoRequestSchema.parse(await readJson(request));
    await failDemo(ctx, createMonitoringWorkerClient(), id, input.reset_behavior);
    return { data: { id, state: "failed", reset_behavior: input.reset_behavior } };
  });
}
