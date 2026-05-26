"use client";

import { useEffect, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/app/AuthContext";

export function AuthGate({ children }: { children: ReactNode }) {
  const { isLoading, isAuthed } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!isLoading && !isAuthed) {
      router.replace("/sign-in");
    }
  }, [isLoading, isAuthed, router]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh] text-(--color-text-muted) text-sm">
        Loading…
      </div>
    );
  }
  if (!isAuthed) return null;
  return <>{children}</>;
}
