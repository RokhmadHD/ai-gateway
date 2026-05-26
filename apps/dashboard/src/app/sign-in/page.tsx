"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { authClient } from "@/lib/auth";
import { AuthShell, Field, Divider, SocialButton } from "@/components/AuthFormBits";

export default function SignInPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await authClient.signIn.email({ email, password });
    setBusy(false);
    if (res.error) {
      setError(res.error.message ?? "sign-in failed");
      return;
    }
    router.replace("/");
  }

  async function social(provider: "google" | "github") {
    setBusy(true);
    setError(null);
    const res = await authClient.signIn.social({ provider, callbackURL: "/" });
    if (res.error) {
      setError(res.error.message ?? `${provider} sign-in failed`);
      setBusy(false);
    }
  }

  return (
    <AuthShell title="Sign in" subtitle="Access your AI Gateway workspace">
      <form onSubmit={onSubmit} className="flex flex-col gap-3">
        <Field label="Email">
          <input
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full bg-(--color-bg) border border-(--color-border) rounded px-3 py-2 outline-none focus:border-(--color-accent)"
          />
        </Field>
        <Field label="Password">
          <input
            type="password"
            required
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full bg-(--color-bg) border border-(--color-border) rounded px-3 py-2 outline-none focus:border-(--color-accent)"
          />
        </Field>
        {error && <p className="text-sm text-(--color-danger)">{error}</p>}
        <button
          type="submit"
          disabled={busy}
          className="mt-1 bg-(--color-accent) text-(--color-bg) font-medium py-2 rounded hover:bg-(--color-accent-hover) disabled:opacity-50"
        >
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>

      <Divider />

      <div className="flex flex-col gap-2">
        <SocialButton onClick={() => social("google")} disabled={busy} label="Continue with Google" />
        <SocialButton onClick={() => social("github")} disabled={busy} label="Continue with GitHub" />
      </div>

      <p className="text-sm text-(--color-text-muted) text-center mt-4">
        New here?{" "}
        <Link href="/sign-up" className="text-(--color-accent) hover:underline">
          Create an account
        </Link>
      </p>
    </AuthShell>
  );
}
