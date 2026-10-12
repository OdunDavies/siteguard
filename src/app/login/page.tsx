import { Suspense } from "react";
import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/database/server";
import { authenticatedSubject } from "@/lib/auth/session";
import { LoginForm } from "./login-form";

async function LoginGate() {
  const supabase = await createServerSupabaseClient();
  if (await authenticatedSubject(supabase.auth)) redirect("/dashboard");
  return <LoginForm />;
}

export default function LoginPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-950 px-4 py-12 text-slate-100">
      <section className="w-full max-w-md rounded-2xl border border-slate-800 bg-slate-900 p-6 shadow-xl sm:p-8">
        <p className="text-sm font-semibold uppercase tracking-[0.2em] text-emerald-400">SiteGuard</p>
        <h1 className="mt-3 text-2xl font-semibold">Sign in</h1>
        <p className="mt-2 text-sm text-slate-300">Use your existing SiteGuard account.</p>
        <Suspense fallback={<p className="mt-8 text-sm" role="status">Checking session…</p>}>
          <LoginGate />
        </Suspense>
      </section>
    </main>
  );
}
