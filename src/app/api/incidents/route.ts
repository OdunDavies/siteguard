import { apiHandlers } from "@/lib/api/routes";
import { connection } from "next/server";

export async function GET(request: Request) {
  await connection();
  return apiHandlers.listIncidents(request);
}
