"use client";

import { use } from "react";
import { trpc } from "@/lib/trpc";
import { Card } from "@/components/ui";
import { KiroAccountsPanel } from "@/components/KiroAccountsPanel";
import { GeminiAccountsPanel } from "@/components/GeminiAccountsPanel";

export default function ProviderAccountsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const provider = trpc.providers.get.useQuery({ id });

  if (provider.isLoading) {
    return <div className="text-(--color-text-muted)">Loading…</div>;
  }
  if (!provider.data) {
    return (
      <Card>
        <div className="text-(--color-text-muted)">Provider not found.</div>
      </Card>
    );
  }
  if (provider.data.type === "kiro") return <KiroAccountsPanel />;
  if (provider.data.type === "gemini") return <GeminiAccountsPanel />;
  return (
    <Card>
      <div className="text-(--color-text-muted) text-sm">
        Accounts tab is only available for{" "}
        <span className="font-mono">kiro</span> and{" "}
        <span className="font-mono">gemini</span> providers.
      </div>
    </Card>
  );
}
