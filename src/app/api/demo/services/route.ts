import { handleApi, readJson } from "@/lib/api/errors";
import { requireApiContext } from "@/lib/api/context";
import { createMonitoringWorkerClient } from "@/lib/database/worker";
import { provisionDemo } from "@/lib/recovery/service";
import { z } from "zod";

export async function POST(request: Request) {
  return handleApi(async () => {
    const ctx = await requireApiContext();
    z.strictObject({}).parse(await readJson(request));
    return { data: await provisionDemo(ctx, createMonitoringWorkerClient()), status: 201 };
  });
}
