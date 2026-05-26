"use client";

import { Suspense, useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { authClient } from "@/lib/auth";
import { trpc } from "@/lib/trpc";
import { AuthShell, Field, Divider, SocialButton } from "@/components/AuthFormBits";

export default function SignUpPage() {
  // Next.js 15 requires useSearchParams() to live inside a Suspense boundary.
  return (
    <Suspense
      fallback={
        <AuthShell title="Create your account">
          <p className="text-sm text-(--color-text-muted)">Loading…</p>
        </AuthShell>
      }
    >
      <SignUp />
    </Suspense>
  );
}

function SignUp() {
  const router = useRouter();
  const params = useSearchParams();
  const inviteToken = params.get("invite");

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const acceptInvite = trpc.invitations.accept.useMutation();

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await authClient.signUp.email({ email, password, name });
    if (res.error) {
      setError(res.error.message ?? "sign-up failed");
      setBusy(false);
      return;
    }
    // If they came via invite, attach to that tenant too.
    if (inviteToken) {
      try {
        await acceptInvite.mutateAsync({ token: inviteToken });
      } catch (e) {
        // non-fatal — they can re-try from /accept-invite
        console.error("invite accept failed", e);
      }
    }
    setBusy(false);
    router.replace("/");
  }

  async function social(provider: "google" | "github") {
    setBusy(true);
    setError(null);
    const callbackURL = inviteToken ? `/accept-invite?token=${inviteToken}` : "/";
    const res = await authClient.signIn.social({ provider, callbackURL });
    if (res.error) {
      setError(res.error.message ?? `${provider} sign-up failed`);
      setBusy(false);
    }
  }

  return (
    <AuthShell
      title="Create your account"
      subtitle={
        inviteToken
          ? "You've been invited — finish setting up your account."
          : "A personal workspace will be created automatically."
      }
    >
      <form onSubmit={onSubmit} className="flex flex-col gap-3">
        <Field label="Name">
          <input
            type="text"
            autoComplete="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full bg-(--color-bg) border border-(--color-border) rounded px-3 py-2 outline-none focus:border-(--color-accent)"
          />
        </Field>
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
            minLength={8}
            autoComplete="new-password"
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
          {busy ? "Creating account…" : "Create account"}
        </button>
      </form>

      <Divider />

      <div className="flex flex-col gap-2">
        <SocialButton onClick={() => social("google")} disabled={busy} label="Continue with Google" />
        <SocialButton onClick={() => social("github")} disabled={busy} label="Continue with GitHub" />
      </div>

      <p className="text-sm text-(--color-text-muted) text-center mt-4">
        Already have an account?{" "}
        <Link href="/sign-in" className="text-(--color-accent) hover:underline">
          Sign in
        </Link>
      </p>
    </AuthShell>
  );
}
