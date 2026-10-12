import { apiHandlers } from "@/lib/api/routes";
import { connection } from "next/server";

export async function GET() {
  await connection();
  return apiHandlers.listWebsites();
}

export async function POST(request: Request) {
  return apiHandlers.registerWebsite(request);
}
