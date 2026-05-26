"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/app/AuthContext";

export default function AcceptInvitePage() {
  // Next.js 15 requires useSearchParams() to live inside a Suspense boundary.
  return (
    <Suspense fallback={<Shell><p className="text-sm text-(--color-text-muted)">Loading…</p></Shell>}>
      <AcceptInvite />
    </Suspense>
  );
}

function AcceptInvite() {
  const params = useSearchParams();
  const router = useRouter();
  const token = params.get("token");
  const { isLoading, isAuthed } = useAuth();
  const accept = trpc.invitations.accept.useMutation();
  const [status, setStatus] = useState<"idle" | "joining" | "done" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (isLoading) return;
    if (!token) {
      setStatus("error");
      setMessage("missing invite token");
      return;
    }
    if (!isAuthed) {
      router.replace(`/sign-up?invite=${encodeURIComponent(token)}`);
      return;
    }
    if (status !== "idle") return;
    setStatus("joining");
    accept
      .mutateAsync({ token })
      .then(() => {
        setStatus("done");
        setTimeout(() => router.replace("/"), 1500);
      })
      .catch((e) => {
        setStatus("error");
        setMessage(e.message ?? "could not accept invite");
      });
  }, [isLoading, isAuthed, token, status, accept, router]);

  return (
    <Shell>
      {status === "joining" && <p className="text-sm text-(--color-text-muted)">Adding you to the workspace…</p>}
      {status === "done" && (
        <p className="text-sm text-(--color-success)">Joined. Redirecting…</p>
      )}
      {status === "error" && (
        <>
          <p className="text-sm text-(--color-danger) mb-3">{message}</p>
          <Link href="/" className="text-sm text-(--color-accent) hover:underline">
            Back to dashboard
          </Link>
        </>
      )}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-sm bg-(--color-bg-elev) border border-(--color-border) rounded-lg p-6">
        <h1 className="text-lg font-semibold mb-2">Accept invitation</h1>
        {children}
      </div>
    </div>
  );
}
