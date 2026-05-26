"use client";

import { use } from "react";
import Link from "next/link";
import { trpc } from "@/lib/trpc";
import { Card, Button } from "@/components/ui";
import type { Snapshot } from "@/lib/api-types";

export default function ProviderOverviewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const snap = trpc.meta.snapshot.useQuery(
    undefined,
    { refetchInterval: 10_000 },
  );

  const p = (snap.data as Snapshot | undefined)?.providers.find((x) => x.id === id);

  if (snap.isLoading) {
    return <div className="text-(--color-text-muted)">Loading…</div>;
  }
  if (!p) {
    return (
      <Card>
        <div className="text-(--color-text-muted)">Provider not found.</div>
      </Card>
    );
  }

  const totalSuccess = p.keys.reduce((s, k) => s + k.successCount, 0);
  const totalFail = p.keys.reduce((s, k) => s + k.failureCount, 0);
  const totalReqs = totalSuccess + totalFail;
  const rate = totalReqs > 0 ? (totalSuccess / totalReqs) * 100 : null;
  const isAcc = p.type === "kiro" || p.type === "gemini";

  return (
    <div className="space-y-6">
      {!isAcc && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Stat label="Total keys" value={p.keys.length} />
          <Stat
            label="Active"
            value={p.keys.filter((k) => k.status === "active").length}
            tone="success"
          />
          <Stat label="Total requests" value={totalReqs.toLocaleString()} />
          <Stat
            label="Success rate"
            value={rate !== null ? `${rate.toFixed(1)}%` : "—"}
            tone={
              rate === null ? "neutral" : rate >= 95 ? "success" : rate >= 80 ? "warning" : "danger"
            }
          />
        </div>
      )}

      {isAcc ? (
        <Card>
          <div className="flex flex-col md:flex-row space-y-2 items-start justify-between">
            <div>
              <h2 className="font-semibold">{p.type.replace(p.type[0], p.type[0].toUpperCase())} accounts</h2>
              <div className="text-sm text-(--color-text-muted) mt-1">
                {p.type.replace(p.type[0], p.type[0].toUpperCase())} authenticates via OAuth account tokens, not API keys.
              </div>
            </div>
            <Link href={`/providers/${id}/accounts`}>
              <Button variant="secondary">Manage accounts →</Button>
            </Link>
          </div>
        </Card>
      ) : (
        <Card>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between mb-4">
            <h2 className="font-semibold">Key activity</h2>
            <Link href={`/providers/${id}/keys`}>
              <Button variant="secondary">Manage keys →</Button>
            </Link>
          </div>
          <div className="table-scroll">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-(--color-text-muted) border-b border-(--color-border)">
                  <th className="py-2 pr-3 font-medium">Label</th>
                  <th className="py-2 pr-3 font-medium text-right">Success</th>
                  <th className="py-2 pr-3 font-medium text-right">Fail</th>
                  <th className="py-2 pr-3 font-medium">Last used</th>
                </tr>
              </thead>
              <tbody>
                {p.keys.map((k) => (
                  <tr key={k.id} className="border-b border-(--color-border)/50">
                    <td className="py-2 pr-3">{k.label ?? "—"}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{k.successCount}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">
                      {k.failureCount > 0 ? (
                        <span className="text-(--color-danger)">{k.failureCount}</span>
                      ) : (
                        k.failureCount
                      )}
                    </td>
                    <td className="py-2 pr-3 text-(--color-text-muted)">
                      {k.cooldownUntil
                        ? `cooldown until ${new Date(k.cooldownUntil).toLocaleTimeString()}`
                        : "—"}
                    </td>
                  </tr>
                ))}
                {p.keys.length === 0 && (
                  <tr>
                    <td colSpan={4} className="py-4 text-(--color-text-muted) text-center">
                      No keys yet —{" "}
                      <Link href={`/providers/${id}/keys`} className="underline">
                        add one
                      </Link>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <Card>
        <h2 className="font-semibold mb-3">Configuration</h2>
        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-y-2 gap-x-6 text-sm">
          <Row label="ID" value={<span className="font-mono">{p.id}</span>} />
          <Row label="Slug" value={p.slug} />
          <Row label="Type" value={p.type} />
          <Row label="Rotation" value={p.rotationStrategy.replace("_", " ")} />
          <Row label="Base URL" value={<span className="font-mono">{p.baseUrl}</span>} />
        </dl>
      </Card>
    </div>
  );
}

function Stat({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: string | number;
  tone?: "neutral" | "success" | "warning" | "danger";
}) {
  const toneClass = {
    neutral: "text-(--color-text)",
    success: "text-(--color-success)",
    warning: "text-(--color-warning)",
    danger: "text-(--color-danger)",
  }[tone];
  return (
    <div className="bg-(--color-bg) border border-(--color-border) rounded-md px-3 py-2">
      <div className="text-[10px] uppercase tracking-wider text-(--color-text-muted)">{label}</div>
      <div className={`text-lg font-semibold tabular-nums ${toneClass}`}>{value}</div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <>
      <dt className="text-(--color-text-muted)">{label}</dt>
      <dd className="text-(--color-text)">{value}</dd>
    </>
  );
}
