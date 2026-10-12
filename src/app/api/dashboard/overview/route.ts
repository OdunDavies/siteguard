import { connection } from "next/server";
import { requireApiContext } from "@/lib/api/context";
import { handleApi } from "@/lib/api/errors";
import { loadDashboardSnapshot } from "@/lib/dashboard/snapshot";

export async function GET() {
  await connection();
  return handleApi(async () => ({ data: await loadDashboardSnapshot(await requireApiContext()) }));
}
