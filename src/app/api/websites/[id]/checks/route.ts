import { apiHandlers } from "@/lib/api/routes";
import { connection } from "next/server";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  await connection();
  return apiHandlers.monitoringHistory(request, (await params).id);
}
