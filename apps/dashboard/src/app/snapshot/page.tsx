"use client";

import { AuthGate } from "@/components/AuthGate";
import { trpc } from "@/lib/trpc";
import { Card, PageHeader, Badge, Button } from "@/components/ui";
import type { Snapshot, SnapshotProvider } from "@/lib/api-types";

export default function SnapshotPage() {
  return (
    <AuthGate>
      <Snapshot />
    </AuthGate>
  );
}

// Distinct hues per key slot — palette stays readable on dark bg.
const KEY_HUES = [200, 145, 80, 25, 295, 250] as const;

function Snapshot() {
  const snap = trpc.meta.snapshot.useQuery(
    undefined,
    { refetchInterval: 5_000 },
  );
  const reload = trpc.meta.reload.useMutation({
    onSuccess: () => snap.refetch(),
  });

  return (
    <>
      {/* ───────── page header ───────── */}
      <PageHeader
        title="Live snapshot"
        subtitle={
          snap.data
            ? `Loaded at ${new Date(snap.data.loadedAt).toLocaleTimeString()} • auto-refresh 5s`
            : "—"
        }
        action={
          <Button
            variant="secondary"
            onClick={() => reload.mutate(undefined)}
            disabled={reload.isPending}
          >
            {reload.isPending ? "Publishing…" : "Force reload"}
          </Button>
        }
      />

      {/* ───────── provider cards ───────── */}
      {(snap.data as Snapshot | undefined)?.providers.map((p) => (
        <ProviderCard key={p.id} provider={p} />
      ))}
    </>
  );
}

type Provider = SnapshotProvider;

function ProviderCard({ provider: p }: { provider: Provider }) {
  if (p.type === "kiro") return <KiroProviderCard provider={p} />;
  if (p.type === "gemini") return <GeminiProviderCard provider={p} />;
  return <KeyedProviderCard provider={p} />;
}

function KiroProviderCard({ provider: p }: { provider: Provider }) {
  const accounts = trpc.kiroAccounts.list.useQuery(undefined, {
    refetchInterval: 5_000,
  });
  const metrics = trpc.metrics.byProviderKey.useQuery(
    { window: "all" },
    { refetchInterval: 5_000 },
  );
  const list = accounts.data?.accounts ?? [];
  const active = list.filter((a) => !a.expired && !a.chainDead).length;
  const expired = list.filter((a) => a.expired && !a.chainDead).length;
  const dead = list.filter((a) => a.chainDead).length;

  const kiroRow = (metrics.data ?? []).find(
    (r) => r.providerId === p.id && r.providerKeyId == null,
  );
  const totalReqs = kiroRow?.requests ?? 0;
  const totalSuccess = kiroRow?.successes ?? 0;
  const totalFail = totalReqs - totalSuccess;
  const successRate = totalReqs > 0 ? totalSuccess / totalReqs : 1;

  return (
    <Card className="mb-4">
      <div className="flex items-center gap-2 mb-4">
        <h2 className="font-semibold">{p.name}</h2>
        <Badge>{p.type}</Badge>
        <Badge tone={p.isActive ? "success" : "neutral"}>
          {p.isActive ? "active" : "inactive"}
        </Badge>
        <span className="text-xs text-(--color-text-muted) ml-auto font-mono truncate max-w-32">{p.baseUrl}</span>
      </div>

      <div className="grid grid-cols-4 gap-3 mb-4">
        <Stat label="Total reqs" value={totalReqs.toLocaleString()} />
        <Stat label="Success" value={totalSuccess.toLocaleString()} tone="success" />
        <Stat
          label="Failures"
          value={totalFail.toLocaleString()}
          tone={totalFail > 0 ? "danger" : "neutral"}
        />
        <Stat
          label="Success rate"
          value={totalReqs > 0 ? `${(successRate * 100).toFixed(1)}%` : "—"}
          tone={successRate >= 0.95 ? "success" : successRate >= 0.8 ? "warning" : "danger"}
        />
      </div>

      <div className="grid grid-cols-4 gap-3 mb-4">
        <Stat label="Total accounts" value={list.length.toString()} />
        <Stat label="Active" value={active.toString()} tone={active > 0 ? "success" : "neutral"} />
        <Stat
          label="Expired"
          value={expired.toString()}
          tone={expired > 0 ? "warning" : "neutral"}
        />
        <Stat
          label="Dead chain"
          value={dead.toString()}
          tone={dead > 0 ? "danger" : "neutral"}
        />
      </div>

      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-(--color-text-muted) border-b border-(--color-border)">
            <th className="py-2 pr-3 font-medium">Label</th>
            <th className="py-2 pr-3 font-medium">Login</th>
            <th className="py-2 pr-3 font-medium">Status</th>
            <th className="py-2 pr-3 font-medium">Expires</th>
            <th className="py-2 pr-3 font-medium">Added</th>
          </tr>
        </thead>
        <tbody>
          {list.map((a) => (
            <tr key={a.id} className="border-b border-(--color-border)/50">
              <td className="py-2 pr-3">{a.label ?? "—"}</td>
              <td className="py-2 pr-3 text-(--color-text-muted)">{a.provider ?? "—"}</td>
              <td className="py-2 pr-3">
                {a.chainDead ? (
                  <Badge tone="danger">needs re-auth</Badge>
                ) : (
                  <Badge tone={a.expired ? "warning" : "success"}>
                    {a.expired ? "expired" : "active"}
                  </Badge>
                )}
              </td>
              <td className="py-2 pr-3 text-(--color-text-muted)">
                {new Date(a.expiresAt).toLocaleString()}
              </td>
              <td className="py-2 pr-3 text-(--color-text-muted)">
                {a.addedAt ? new Date(a.addedAt).toLocaleDateString() : "—"}
              </td>
            </tr>
          ))}
          {list.length === 0 && (
            <tr>
              <td colSpan={5} className="py-3 text-(--color-text-muted) text-center">
                No accounts
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </Card>
  );
}

function GeminiProviderCard({ provider: p }: { provider: Provider }) {
  const accounts = trpc.geminiAccounts.list.useQuery(undefined, {
    refetchInterval: 5_000,
  });
  const metrics = trpc.metrics.byProviderKey.useQuery(
    { window: "all" },
    { refetchInterval: 5_000 },
  );
  const list = accounts.data?.accounts ?? [];
  const active = list.filter((a) => !a.expired && !a.chainDead).length;
  const expired = list.filter((a) => a.expired && !a.chainDead).length;
  const dead = list.filter((a) => a.chainDead).length;

  const row = (metrics.data ?? []).find(
    (r) => r.providerId === p.id && r.providerKeyId == null,
  );
  const totalReqs = row?.requests ?? 0;
  const totalSuccess = row?.successes ?? 0;
  const totalFail = totalReqs - totalSuccess;
  const successRate = totalReqs > 0 ? totalSuccess / totalReqs : 1;

  return (
    <Card className="mb-4">
      <div className="flex items-center gap-2 mb-4">
        <h2 className="font-semibold">{p.name}</h2>
        <Badge>{p.type}</Badge>
        <Badge tone={p.isActive ? "success" : "neutral"}>
          {p.isActive ? "active" : "inactive"}
        </Badge>
        <span className="text-xs text-(--color-text-muted) ml-auto font-mono truncate max-w-32">{p.baseUrl}</span>
      </div>

      <div className="grid grid-cols-4 gap-3 mb-4">
        <Stat label="Total reqs" value={totalReqs.toLocaleString()} />
        <Stat label="Success" value={totalSuccess.toLocaleString()} tone="success" />
        <Stat
          label="Failures"
          value={totalFail.toLocaleString()}
          tone={totalFail > 0 ? "danger" : "neutral"}
        />
        <Stat
          label="Success rate"
          value={totalReqs > 0 ? `${(successRate * 100).toFixed(1)}%` : "—"}
          tone={successRate >= 0.95 ? "success" : successRate >= 0.8 ? "warning" : "danger"}
        />
      </div>

      <div className="grid grid-cols-4 gap-3 mb-4">
        <Stat label="Total accounts" value={list.length.toString()} />
        <Stat label="Active" value={active.toString()} tone={active > 0 ? "success" : "neutral"} />
        <Stat
          label="Expired"
          value={expired.toString()}
          tone={expired > 0 ? "warning" : "neutral"}
        />
        <Stat
          label="Dead chain"
          value={dead.toString()}
          tone={dead > 0 ? "danger" : "neutral"}
        />
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-(--color-text-muted) border-b border-(--color-border)">
            <th className="py-2 pr-3 font-medium">Label</th>
            <th className="py-2 pr-3 font-medium">Email</th>
            <th className="py-2 pr-3 font-medium">Project</th>
            <th className="py-2 pr-3 font-medium">Status</th>
            <th className="py-2 pr-3 font-medium">Expires</th>
            <th className="py-2 pr-3 font-medium">Added</th>
          </tr>
        </thead>
        <tbody>
          {list.map((a) => (
            <tr key={a.id} className="border-b border-(--color-border)/50">
              <td className="py-2 pr-3">{a.label ?? "—"}</td>
              <td className="py-2 pr-3 text-(--color-text-muted)">{a.email ?? "—"}</td>
              <td className="py-2 pr-3 font-mono text-(--color-text-muted)">{a.project ?? "—"}</td>
              <td className="py-2 pr-3">
                {a.chainDead ? (
                  <Badge tone="danger">needs re-auth</Badge>
                ) : (
                  <Badge tone={a.expired ? "warning" : "success"}>
                    {a.expired ? "expired" : "active"}
                  </Badge>
                )}
              </td>
              <td className="py-2 pr-3 text-(--color-text-muted)">
                {new Date(a.expiresAt).toLocaleString()}
              </td>
              <td className="py-2 pr-3 text-(--color-text-muted)">
                {a.addedAt ? new Date(a.addedAt).toLocaleDateString() : "—"}
              </td>
            </tr>
          ))}
          {list.length === 0 && (
            <tr>
              <td colSpan={6} className="py-3 text-(--color-text-muted) text-center">
                No accounts
              </td>
            </tr>
          )}
        </tbody>
      </table>
      </div>
    </Card>
  );
}

function KeyedProviderCard({ provider: p }: { provider: Provider }) {
  const totalSuccess = p.keys.reduce((s, k) => s + k.successCount, 0);
  const totalFail = p.keys.reduce((s, k) => s + k.failureCount, 0);
  const totalReqs = totalSuccess + totalFail;
  const successRate = totalReqs > 0 ? totalSuccess / totalReqs : 1;

  return (
    <Card className="mb-4">
      {/* ───────── card header (name + meta + URL) ───────── */}
      <div className="flex items-center gap-2 mb-4">
        <h2 className="font-semibold">{p.name}</h2>
        <Badge>{p.type}</Badge>
        <Badge tone={p.isActive ? "success" : "neutral"}>
          {p.isActive ? "active" : "inactive"}
        </Badge>
        <span className="text-xs text-(--color-text-muted) ml-auto font-mono">{p.baseUrl}</span>
      </div>

      {/* ───────── stats row ───────── */}
      <div className="grid grid-cols-4 gap-3 mb-4">
        <Stat label="Total reqs" value={totalReqs.toLocaleString()} />
        <Stat label="Success" value={totalSuccess.toLocaleString()} tone="success" />
        <Stat label="Failures" value={totalFail.toLocaleString()} tone={totalFail > 0 ? "danger" : "neutral"} />
        <Stat
          label="Success rate"
          value={totalReqs > 0 ? `${(successRate * 100).toFixed(1)}%` : "—"}
          tone={successRate >= 0.95 ? "success" : successRate >= 0.8 ? "warning" : "danger"}
        />
      </div>

      {/* ───────── load distribution bar ───────── */}
      {totalSuccess > 0 && (
        <div className="mb-4">
          <div className="text-[11px] uppercase tracking-wider text-(--color-text-muted) mb-2">
            Load distribution (success count)
          </div>
          <div className="flex h-3 rounded overflow-hidden bg-(--color-border)/30">
            {p.keys
              .filter((k) => k.successCount > 0)
              .map((k, i) => {
                const pct = (k.successCount / totalSuccess) * 100;
                const hue = KEY_HUES[i % KEY_HUES.length];
                return (
                  <div
                    key={k.id}
                    className="h-full transition-all duration-500"
                    style={{
                      width: `${pct}%`,
                      background: `oklch(0.70 0.18 ${hue})`,
                    }}
                    title={`${k.label}: ${k.successCount} (${pct.toFixed(1)}%)`}
                  />
                );
              })}
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-[11px] text-(--color-text-muted)">
            {p.keys
              .filter((k) => k.successCount > 0)
              .map((k, i) => {
                const hue = KEY_HUES[i % KEY_HUES.length];
                const pct = (k.successCount / totalSuccess) * 100;
                return (
                  <div key={k.id} className="flex items-center gap-1.5">
                    <span
                      className="w-2 h-2 rounded-sm"
                      style={{ background: `oklch(0.70 0.18 ${hue})` }}
                    />
                    <span className="text-(--color-text)">{k.label}</span>
                    <span>{pct.toFixed(1)}%</span>
                  </div>
                );
              })}
          </div>
        </div>
      )}

      {/* ───────── keys table ───────── */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-(--color-text-muted) border-b border-(--color-border)">
            <th className="py-2 pr-3 font-medium">Label</th>
            <th className="py-2 pr-3 font-medium">Status</th>
            <th className="py-2 pr-3 font-medium">Secret</th>
            <th className="py-2 pr-3 font-medium">Usage</th>
            <th className="py-2 pr-3 font-medium text-right">Success</th>
            <th className="py-2 pr-3 font-medium text-right">Fail</th>
            <th className="py-2 pr-3 font-medium">Cooldown</th>
          </tr>
        </thead>
        <tbody>
          {p.keys.map((k, i) => {
            const usage =
              totalSuccess > 0 ? (k.successCount / totalSuccess) * 100 : 0;
            const hue = KEY_HUES[i % KEY_HUES.length];
            return (
              <tr key={k.id} className="border-b border-(--color-border)/50">
                <td className="py-2 pr-3">
                  <div className="flex items-center gap-2">
                    <span
                      className="w-2 h-2 rounded-sm shrink-0"
                      style={{ background: `oklch(0.70 0.18 ${hue})` }}
                    />
                    {k.label ?? "—"}
                  </div>
                </td>
                <td className="py-2 pr-3">
                  <Badge
                    tone={
                      k.status === "active"
                        ? "success"
                        : k.status === "cooldown"
                          ? "warning"
                          : "danger"
                    }
                  >
                    {k.status}
                  </Badge>
                </td>
                <td className="py-2 pr-3 font-mono text-(--color-text-muted)">
                  {k.secretPreview}
                </td>
                <td className="py-2 pr-3 w-32">
                  <div className="flex items-center gap-2">
                    <div className="flex-1 h-1.5 bg-(--color-border)/30 rounded overflow-hidden">
                      <div
                        className="h-full transition-all duration-500"
                        style={{
                          width: `${usage}%`,
                          background: `oklch(0.70 0.18 ${hue})`,
                        }}
                      />
                    </div>
                    <span className="text-[11px] text-(--color-text-muted) tabular-nums w-9 text-right">
                      {usage.toFixed(0)}%
                    </span>
                  </div>
                </td>
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
                    ? new Date(k.cooldownUntil).toLocaleTimeString()
                    : "—"}
                </td>
              </tr>
            );
          })}
          {p.keys.length === 0 && (
            <tr>
              <td colSpan={7} className="py-3 text-(--color-text-muted) text-center">
                No keys
              </td>
            </tr>
          )}
        </tbody>
      </table>
      </div>
    </Card>
  );
}

function Stat({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: string;
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
