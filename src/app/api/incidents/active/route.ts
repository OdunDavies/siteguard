import { connection } from "next/server";
import { apiHandlers } from "@/lib/api/routes";

export async function GET() {
  await connection();
  return apiHandlers.activeIncidents();
}
