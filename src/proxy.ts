import type { NextRequest } from "next/server";
import { refreshSupabaseSession } from "@/lib/database/proxy";

export async function proxy(request: NextRequest) {
  return refreshSupabaseSession(request);
}

export const config = {
  // Route Handlers can write refreshed cookies themselves; proxy is for future Server Components.
  matcher: ["/dashboard/:path*"],
};
