import { Suspense } from "react";
import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/database/server";
import { authenticatedUser } from "@/lib/auth/session";
import { SignOutButton } from "./sign-out-button";

async function DashboardContent() {
  const supabase = await createServerSupabaseClient();
  const user = await authenticatedUser(supabase.auth);
  if (!user) redirect("/login");

  return (
    <section className="w-full max-w-xl rounded-2xl border border-slate-800 bg-slate-900 p-6 shadow-xl sm:p-8">
      <p className="text-sm font-semibold uppercase tracking-[0.2em] text-emerald-400">SiteGuard</p>
      <h1 className="mt-3 text-2xl font-semibold">Dashboard</h1>
      <dl className="mt-8 space-y-4 text-sm">
        <div><dt className="text-slate-400">Email</dt><dd className="mt-1 break-all">{user.email ?? "Unavailable"}</dd></div>
        <div><dt className="text-slate-400">Authentication</dt><dd className="mt-1 text-emerald-300">Signed in</dd></div>
      </dl>
      <div className="mt-8"><SignOutButton /></div>
    </section>
  );
}

export default function DashboardPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-950 px-4 py-12 text-slate-100">
      <Suspense fallback={<p role="status">Checking session…</p>}>
        <DashboardContent />
      </Suspense>
    </main>
  );
}
