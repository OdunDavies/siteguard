import { Suspense } from "react";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { createServerSupabaseClient } from "@/lib/database/server";
import { authenticatedUser } from "@/lib/auth/session";
import { loadDashboardSnapshot } from "@/lib/dashboard/snapshot";
import { DashboardClient } from "./dashboard-client";

async function DashboardContent() {
  await connection();
  const supabase = await createServerSupabaseClient();
  const user = await authenticatedUser(supabase.auth);
  if (!user) redirect("/login");

  const snapshot = await loadDashboardSnapshot({ supabase, userId: user.id });
  return <DashboardClient initialSnapshot={snapshot} email={user.email ?? "Signed in"} />;
}

export default function DashboardPage() {
  return (
    <main className="min-h-screen bg-slate-950 text-slate-100">
      <Suspense fallback={<p className="p-8" role="status">Loading SiteGuard…</p>}>
        <DashboardContent />
      </Suspense>
    </main>
  );
}
