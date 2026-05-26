"use client";

import { useState } from "react";
import { AuthGate } from "@/components/AuthGate";
import { trpc } from "@/lib/trpc";
import { Card, PageHeader, Badge } from "@/components/ui";

type Window = "1h" | "24h" | "7d" | "all";

export default function MetricsPage() {
  return (
    <AuthGate>
      <Metrics />
    </AuthGate>
  );
}

function Metrics() {
  const [win, setWin] = useState<Window>("24h");

  const summary = trpc.metrics.summary.useQuery(
    { window: win },
    { refetchInterval: 15_000 },
  );
  const series = trpc.metrics.timeSeries.useQuery(
    { window: win === "all" || win === "1h" ? "24h" : win },
    { refetchInterval: 15_000, enabled: win !== "1h" },
  );
  const byKey = trpc.metrics.byApiKey.useQuery(
    { window: win },
    { refetchInterval: 15_000 },
  );
  const byProv = trpc.metrics.byProviderKey.useQuery(
    { window: win },
    { refetchInterval: 15_000 },
  );

  return (
    <>
      {/* ───────── page header ───────── */}
      <PageHeader
        title="Token metrics"
        subtitle="Request volume, token usage, and latency"
        action={<WindowSelector value={win} onChange={setWin} />}
      />

      {/* ───────── KPI cards ───────── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <Kpi label="Requests" value={(summary.data?.requests ?? 0).toLocaleString()} />
        <Kpi
          label="Success rate"
          value={
            summary.data && summary.data.requests > 0
              ? `${((summary.data.successes / summary.data.requests) * 100).toFixed(1)}%`
              : "—"
          }
          tone={
            !summary.data || summary.data.requests === 0
              ? "neutral"
              : summary.data.successes / summary.data.requests >= 0.95
                ? "success"
                : summary.data.successes / summary.data.requests >= 0.8
                  ? "warning"
                  : "danger"
          }
        />
        <Kpi
          label="Total tokens"
          value={(summary.data?.totalTokens ?? 0).toLocaleString()}
          hint={`${(summary.data?.promptTokens ?? 0).toLocaleString()} in / ${(summary.data?.completionTokens ?? 0).toLocaleString()} out`}
        />
        <Kpi
          label="P95 latency"
          value={summary.data ? `${(summary.data.p95LatencyMs / 1000).toFixed(2)}s` : "—"}
          hint={summary.data ? `avg ${(summary.data.avgLatencyMs / 1000).toFixed(2)}s` : undefined}
        />
      </div>

      {/* ───────── time-series chart ───────── */}
      {win !== "1h" && (
        <Card className="mb-4">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-semibold">Activity over time</h2>
            <span className="text-[11px] text-(--color-text-muted) uppercase tracking-wider">
              {series.data?.bucket === "hour" ? "per hour" : "per day"}
            </span>
          </div>
          <TimeSeriesChart points={series.data?.points ?? []} />
        </Card>
      )}

      {/* ───────── per API key breakdown ───────── */}
      <Card className="mb-4">
        <h2 className="font-semibold mb-3">By API key (client)</h2>
        <BreakdownTable
          rows={(byKey.data ?? []).map((r) => ({
            key: r.apiKeyId ?? "(none)",
            primary: r.name,
            secondary: `ap_${r.prefix}…`,
            requests: r.requests,
            successes: r.successes,
            totalTokens: r.totalTokens,
            extra:
              r.lastUsedAt
                ? `last ${new Date(r.lastUsedAt).toLocaleString()}`
                : "never",
          }))}
        />
      </Card>

      {/* ───────── per provider key / kiro account breakdown ───────── */}
      <Card>
        <h2 className="font-semibold mb-3">By provider key / account (upstream)</h2>
        <BreakdownTable
          rows={(byProv.data ?? []).map((r) => {
            const isPooled = r.providerKeyId == null;
            return {
              key: r.providerKeyId ?? `pool:${r.providerId ?? r.providerName}`,
              primary: isPooled ? "Pooled accounts" : r.keyLabel,
              secondary: r.providerName,
              requests: r.requests,
              successes: r.successes,
              totalTokens: r.totalTokens,
            };
          })}
        />
      </Card>
    </>
  );
}

function WindowSelector({
  value,
  onChange,
}: {
  value: Window;
  onChange: (w: Window) => void;
}) {
  const opts: { v: Window; label: string }[] = [
    { v: "1h", label: "1h" },
    { v: "24h", label: "24h" },
    { v: "7d", label: "7d" },
    { v: "all", label: "All" },
  ];
  return (
    <div className="inline-flex bg-(--color-bg-elev) border border-(--color-border) rounded-md p-0.5">
      {opts.map((o) => (
        <button
          key={o.v}
          onClick={() => onChange(o.v)}
          className={`px-3 py-1.5 text-sm rounded transition-colors ${
            value === o.v
              ? "bg-(--color-accent) text-(--color-bg) font-medium"
              : "text-(--color-text-muted) hover:text-(--color-text)"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Kpi({
  label,
  value,
  tone = "neutral",
  hint,
}: {
  label: string;
  value: string;
  tone?: "neutral" | "success" | "warning" | "danger";
  hint?: string;
}) {
  const toneClass = {
    neutral: "text-(--color-text)",
    success: "text-(--color-success)",
    warning: "text-(--color-warning)",
    danger: "text-(--color-danger)",
  }[tone];
  return (
    <div className="bg-(--color-bg-elev) border border-(--color-border) rounded-md px-3 py-2.5">
      <div className="text-[10px] uppercase tracking-wider text-(--color-text-muted)">
        {label}
      </div>
      <div className={`text-xl font-semibold tabular-nums mt-0.5 ${toneClass}`}>
        {value}
      </div>
      {hint && <div className="text-[11px] text-(--color-text-muted) mt-1">{hint}</div>}
    </div>
  );
}

interface BreakdownRow {
  key: string;
  primary: string;
  secondary: string;
  requests: number;
  successes: number;
  totalTokens: number;
  extra?: string;
}

function BreakdownTable({ rows }: { rows: BreakdownRow[] }) {
  if (rows.length === 0) {
    return (
      <div className="text-sm text-(--color-text-muted) text-center py-4">
        No data in this window
      </div>
    );
  }
  const maxReq = Math.max(...rows.map((r) => r.requests), 1);
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
      <thead>
        <tr className="text-left text-(--color-text-muted) border-b border-(--color-border)">
          <th className="py-2 pr-3 font-medium">Name</th>
          <th className="py-2 pr-3 font-medium">Provider</th>
          <th className="py-2 pr-3 font-medium w-40">Share</th>
          <th className="py-2 pr-3 font-medium text-right">Requests</th>
          <th className="py-2 pr-3 font-medium text-right">Tokens</th>
          <th className="py-2 pr-3 font-medium text-right">Success</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const pct = (r.requests / maxReq) * 100;
          const successPct =
            r.requests > 0 ? (r.successes / r.requests) * 100 : null;
          return (
            <tr key={r.key} className="border-b border-(--color-border)/50">
              <td className="py-2 pr-3">
                <div>{r.primary}</div>
                {r.extra && (
                  <div className="text-[11px] text-(--color-text-muted)">{r.extra}</div>
                )}
              </td>
              <td className="py-2 pr-3 text-(--color-text-muted) font-mono text-xs">
                {r.secondary}
              </td>
              <td className="py-2 pr-3">
                <div className="h-1.5 bg-(--color-border)/30 rounded overflow-hidden">
                  <div
                    className="h-full bg-(--color-accent) transition-all duration-500"
                    style={{ width: `${pct}%` }}
                  />
                </div>
              </td>
              <td className="py-2 pr-3 text-right tabular-nums">
                {r.requests.toLocaleString()}
              </td>
              <td className="py-2 pr-3 text-right tabular-nums">
                {r.totalTokens.toLocaleString()}
              </td>
              <td className="py-2 pr-3 text-right">
                {successPct === null ? (
                  <span className="text-(--color-text-muted)">—</span>
                ) : (
                  <Badge
                    tone={successPct >= 95 ? "success" : successPct >= 80 ? "warning" : "danger"}
                  >
                    {successPct.toFixed(0)}%
                  </Badge>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
    </div>
  );
}

function TimeSeriesChart({
  points,
}: {
  points: Array<{ t: Date | string; requests: number; totalTokens: number; errors: number }>;
}) {
  if (points.length === 0) {
    return (
      <div className="h-32 flex items-center justify-center text-sm text-(--color-text-muted)">
        No activity in this window
      </div>
    );
  }
  const maxReq = Math.max(...points.map((p) => p.requests), 1);
  const W = 600;
  const H = 100;
  const stepX = W / Math.max(1, points.length - 1);
  const pathReq = points
    .map((p, i) => {
      const x = i * stepX;
      const y = H - (p.requests / maxReq) * H;
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const areaPath = `${pathReq} L${(points.length - 1) * stepX},${H} L0,${H} Z`;
  return (
    <div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="w-full h-32"
      >
        <path d={areaPath} fill="oklch(0.65 0.18 250 / 0.15)" />
        <path
          d={pathReq}
          fill="none"
          stroke="oklch(0.65 0.18 250)"
          strokeWidth="1.5"
          vectorEffect="non-scaling-stroke"
        />
        {points.map((p, i) =>
          p.errors > 0 ? (
            <circle
              key={i}
              cx={i * stepX}
              cy={H - (p.requests / maxReq) * H}
              r="2"
              fill="oklch(0.65 0.18 25)"
            />
          ) : null,
        )}
      </svg>
      <div className="flex justify-between text-[10px] text-(--color-text-muted) mt-1">
        <span>{formatT(points[0]!.t)}</span>
        <span className="font-mono">max {maxReq.toLocaleString()} req</span>
        <span>{formatT(points[points.length - 1]!.t)}</span>
      </div>
    </div>
  );
}

function formatT(t: Date | string): string {
  const d = typeof t === "string" ? new Date(t) : t;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
