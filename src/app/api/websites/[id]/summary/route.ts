import { connection } from "next/server";
import { apiHandlers } from "@/lib/api/routes";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  await connection();
  return apiHandlers.websiteSummary((await params).id);
}
