"use client";

import { AuthGate } from "@/components/AuthGate";
import { trpc } from "@/lib/trpc";
import { Card, PageHeader, Badge } from "@/components/ui";
import type { Snapshot } from "@/lib/api-types";
import Link from "next/link";

export default function Home() {
  return (
    <AuthGate>
      <Overview />
    </AuthGate>
  );
}

function Overview() {
  const snap = trpc.meta.snapshot.useQuery(undefined);
  const data = snap.data as Snapshot | undefined;

  return (
    <>
      <PageHeader title="Overview" subtitle="Live snapshot from proxy memory" />

      {snap.isLoading && <div className="text-(--color-text-muted)">Loading…</div>}
      {snap.error && (
        <Card>
          <div className="text-(--color-danger) text-sm">
            Failed: {snap.error.message}
          </div>
        </Card>
      )}

      {snap.data && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Card>
            <div className="text-xs text-(--color-text-muted) uppercase tracking-wide">Tenant</div>
            <div className="text-xl font-semibold mt-1">{snap.data.tenantSlug}</div>
            <div className="text-xs text-(--color-text-muted) mt-2 font-mono">
              {snap.data.tenantId.slice(0, 8)}…
            </div>
          </Card>
          <Card>
            <div className="text-xs text-(--color-text-muted) uppercase tracking-wide">Providers</div>
            <div className="text-xl font-semibold mt-1">{snap.data.providers.length}</div>
            <Link href="/providers" className="text-xs mt-2 inline-block">
              Manage →
            </Link>
          </Card>
          <Card>
            <div className="text-xs text-(--color-text-muted) uppercase tracking-wide">Total keys</div>
            <div className="text-xl font-semibold mt-1">
              {snap.data.providers.reduce((sum, p) => sum + p.keys.length, 0)}
            </div>
            <div className="text-xs text-(--color-text-muted) mt-2">
              Active:{" "}
              <Badge tone="success">
                {snap.data.providers.reduce(
                  (sum, p) => sum + p.keys.filter((k) => k.status === "active").length,
                  0,
                )}
              </Badge>
            </div>
          </Card>
        </div>
      )}
    </>
  );
}
