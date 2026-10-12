"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { createBrowserSupabaseClient } from "@/lib/database/browser";
import { signInExistingUser } from "@/lib/auth/session";

export function LoginForm() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);
    const form = event.currentTarget;
    const fields = new FormData(form);
    try {
      const signedIn = await signInExistingUser(
        createBrowserSupabaseClient().auth,
        String(fields.get("email") ?? "").trim(),
        String(fields.get("password") ?? ""),
      );
      if (!signedIn) {
        setError("Sign in failed. Check your email and password.");
        return;
      }
      form.reset();
      router.replace("/dashboard");
      router.refresh();
    } catch {
      setError("Sign in is unavailable. Please try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className="mt-8 space-y-5">
      <div>
        <label htmlFor="email" className="block text-sm font-medium">Email</label>
        <input id="email" name="email" type="email" autoComplete="username" required disabled={pending}
          className="mt-2 w-full rounded-lg border border-slate-600 bg-slate-950 px-3 py-2 text-white outline-none focus:border-emerald-400 disabled:opacity-60" />
      </div>
      <div>
        <label htmlFor="password" className="block text-sm font-medium">Password</label>
        <input id="password" name="password" type="password" autoComplete="current-password" required disabled={pending}
          className="mt-2 w-full rounded-lg border border-slate-600 bg-slate-950 px-3 py-2 text-white outline-none focus:border-emerald-400 disabled:opacity-60" />
      </div>
      {error && <p role="alert" className="text-sm text-rose-300">{error}</p>}
      <button type="submit" disabled={pending}
        className="w-full rounded-lg bg-emerald-400 px-4 py-2.5 font-semibold text-slate-950 hover:bg-emerald-300 disabled:cursor-wait disabled:opacity-60">
        {pending ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
