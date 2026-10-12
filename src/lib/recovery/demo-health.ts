import type { SupabaseClient } from "@supabase/supabase-js";

const noStore = { "Cache-Control": "no-store" };

export async function demoHealthResponse(worker: SupabaseClient, id: string): Promise<Response> {
  const { data, error } = await worker.from("demo_services")
    .select("state").eq("id", id).maybeSingle();
  if (error || !data) {
    return Response.json({ status: "unavailable" }, {
      status: error ? 503 : 404, headers: noStore,
    });
  }
  const healthy = data.state === "healthy";
  return Response.json({ status: healthy ? "healthy" : "failed" }, {
    status: healthy ? 200 : 503, headers: noStore,
  });
}
