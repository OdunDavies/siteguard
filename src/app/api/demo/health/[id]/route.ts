import { connection } from "next/server";
import { createMonitoringWorkerClient } from "@/lib/database/worker";
import { demoHealthResponse } from "@/lib/recovery/demo-health";
import { uuidSchema } from "@/lib/validation/incident";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  await connection();
  const parsed = uuidSchema.safeParse((await params).id);
  if (!parsed.success) return Response.json({ status: "unavailable" }, {
    status: 404, headers: { "Cache-Control": "no-store" },
  });
  return demoHealthResponse(createMonitoringWorkerClient(), parsed.data);
}
