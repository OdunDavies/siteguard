"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createBrowserSupabaseClient } from "@/lib/database/browser";
import { signOutCurrentUser } from "@/lib/auth/session";

export function SignOutButton() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signOut() {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      if (!(await signOutCurrentUser(createBrowserSupabaseClient().auth))) {
        setError("Could not sign out. Please try again.");
        return;
      }
      router.replace("/login");
      router.refresh();
    } catch {
      setError("Could not sign out. Please try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div>
      {error && <p role="alert" className="mb-3 text-sm text-rose-300">{error}</p>}
      <button type="button" onClick={signOut} disabled={pending}
        className="rounded-lg border border-slate-600 px-4 py-2 text-sm font-medium hover:bg-slate-800 disabled:cursor-wait disabled:opacity-60">
        {pending ? "Signing out…" : "Sign out"}
      </button>
    </div>
  );
}
