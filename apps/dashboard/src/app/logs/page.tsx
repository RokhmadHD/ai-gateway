"use client";

import { useState, type ReactNode } from "react";
import { AuthGate } from "@/components/AuthGate";
import { trpc } from "@/lib/trpc";
import { Card, PageHeader, Badge, Button, Input, Select, Modal } from "@/components/ui";

type Window = "1h" | "24h" | "7d" | "all";
type StatusFilter = "all" | "success" | "error";

export default function LogsPage() {
  return (
    <AuthGate>
      <Logs />
    </AuthGate>
  );
}

function Logs() {
  const [win, setWin] = useState<Window>("24h");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [endpoint, setEndpoint] = useState<string>("");
  const [search, setSearch] = useState<string>("");
  const [searchDraft, setSearchDraft] = useState<string>("");
  const [openId, setOpenId] = useState<string | null>(null);

  const endpoints = trpc.logs.endpoints.useQuery(undefined);
  const list = trpc.logs.list.useQuery(
    { window: win,
      status: statusFilter,
      endpoint: endpoint || undefined,
      search: search || undefined,
      limit: 50,
    },
    { refetchInterval: 10_000 },
  );

  return (
    <>
      <PageHeader
        title="Request logs"
        subtitle="Per-request audit — clik baris untuk detail"
        action={
          <div className="flex items-center gap-2">
            <Select value={win} onChange={(e) => setWin(e.target.value as Window)}>
              <option value="1h">1h</option>
              <option value="24h">24h</option>
              <option value="7d">7d</option>
              <option value="all">All</option>
            </Select>
            <Button variant="secondary" onClick={() => list.refetch()}>
              Refresh
            </Button>
          </div>
        }
      />

      <Card className="mb-4">
        <div className="flex flex-wrap items-center gap-2">
          <FilterChip
            label="All"
            active={statusFilter === "all"}
            onClick={() => setStatusFilter("all")}
          />
          <FilterChip
            label="Success"
            tone="success"
            active={statusFilter === "success"}
            onClick={() => setStatusFilter("success")}
          />
          <FilterChip
            label="Errors"
            tone="danger"
            active={statusFilter === "error"}
            onClick={() => setStatusFilter("error")}
          />
          <span className="mx-1 h-5 w-px bg-(--color-border)" />
          <Select value={endpoint} onChange={(e) => setEndpoint(e.target.value)}>
            <option value="">All endpoints</option>
            {(endpoints.data ?? []).map((ep) => (
              <option key={ep} value={ep}>
                {ep}
              </option>
            ))}
          </Select>
          <form
            className="flex items-center gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              setSearch(searchDraft.trim());
            }}
          >
            <Input
              value={searchDraft}
              onChange={(e) => setSearchDraft(e.target.value)}
              placeholder="search reqId / model / error…"
              style={{ width: 240 }}
            />
            {search && (
              <Button
                variant="ghost"
                type="button"
                onClick={() => {
                  setSearch("");
                  setSearchDraft("");
                }}
              >
                ✕
              </Button>
            )}
          </form>
        </div>
      </Card>

      {list.isLoading && <div className="text-(--color-text-muted)">Loading…</div>}
      {list.error && (
        <Card>
          <div className="text-(--color-danger) text-sm">{list.error.message}</div>
        </Card>
      )}

      {list.data && (
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-(--color-text-muted) border-b border-(--color-border)">
                  <th className="py-2 pr-3 font-medium">Time</th>
                  <th className="py-2 pr-3 font-medium">Status</th>
                  <th className="py-2 pr-3 font-medium">Endpoint</th>
                  <th className="py-2 pr-3 font-medium">Provider</th>
                  <th className="py-2 pr-3 font-medium">Model</th>
                  <th className="py-2 pr-3 font-medium text-right">Tokens</th>
                  <th className="py-2 pr-3 font-medium text-right">Latency</th>
                  <th className="py-2 pr-3 font-medium">Request ID</th>
                </tr>
              </thead>
              <tbody>
                {list.data.items.map((r) => (
                  <tr
                    key={r.id}
                    onClick={() => setOpenId(r.id)}
                    className="border-b border-(--color-border)/50 hover:bg-(--color-bg-elev)/50 cursor-pointer"
                  >
                    <td className="py-2 pr-3 text-(--color-text-muted) whitespace-nowrap">
                      {formatTime(r.createdAt)}
                    </td>
                    <td className="py-2 pr-3">
                      <StatusBadge status={r.status} httpStatus={r.httpStatus} />
                    </td>
                    <td className="py-2 pr-3 font-mono text-xs">{r.endpoint}</td>
                    <td className="py-2 pr-3">
                      {r.providerSlug ?? <span className="text-(--color-text-muted)">—</span>}
                    </td>
                    <td className="py-2 pr-3 font-mono text-xs">{r.modelName}</td>
                    <td className="py-2 pr-3 text-right tabular-nums whitespace-nowrap">
                      {r.totalTokens || (r.promptTokens || 0) + (r.completionTokens || 0)}
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums whitespace-nowrap">
                      {formatLatency(r.latencyMs)}
                    </td>
                    <td className="py-2 pr-3 font-mono text-[11px] text-(--color-text-muted)">
                      {r.requestId.slice(0, 8)}…
                    </td>
                  </tr>
                ))}
                {list.data.items.length === 0 && (
                  <tr>
                    <td colSpan={8} className="py-6 text-center text-(--color-text-muted)">
                      No logs in this window / filter
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {list.data.nextCursor && (
            <div className="text-xs text-(--color-text-muted) text-center mt-3">
              Showing first 50 — narrow filters to find older entries
            </div>
          )}
        </Card>
      )}

      <LogDetailModal id={openId} onClose={() => setOpenId(null)} />
    </>
  );
}

function LogDetailModal({ id, onClose }: { id: string | null; onClose: () => void }) {
  const detail = trpc.logs.get.useQuery(
    { id: id ?? "" },
    { enabled: !!id },
  );

  return (
    <Modal open={!!id} onClose={onClose} title="Request detail" size="lg">
      {detail.isLoading && <div className="text-(--color-text-muted)">Loading…</div>}
      {detail.error && <div className="text-(--color-danger) text-sm">{detail.error.message}</div>}
      {detail.data && (
        <div className="space-y-4">
          {/* ───── header ───── */}
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={detail.data.status} httpStatus={detail.data.httpStatus} />
            <span className="font-mono text-xs text-(--color-text-muted)">
              {detail.data.requestId}
            </span>
            <span className="ml-auto text-xs text-(--color-text-muted)">
              {new Date(detail.data.createdAt).toLocaleString()}
            </span>
          </div>

          {/* ───── error message (if any) ───── */}
          {detail.data.errorMessage && (
            <div className="bg-(--color-danger)/10 border border-(--color-danger)/30 rounded p-3">
              <div className="text-[10px] uppercase tracking-wider text-(--color-danger) mb-1">
                Error
                {detail.data.errorCode && (
                  <span className="font-mono ml-2">{detail.data.errorCode}</span>
                )}
              </div>
              <div className="text-sm whitespace-pre-wrap break-words text-(--color-text)">
                {detail.data.errorMessage}
              </div>
              {/* Check for upstream error indicators */}
              {(detail.data.errorMessage.includes('Third-party apps now draw from extra usage') ||
                detail.data.errorMessage.includes('upstream_error')) && (
                <div className="mt-2 pt-2 border-t border-(--color-danger)/30">
                  <Badge tone="danger">⚠️ Upstream Error - Provider Dead</Badge>
                  <div className="text-xs text-(--color-text-muted) mt-1">
                    This provider hit an upstream error and should be excluded from rotation
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ───── routing info ───── */}
          <div>
            <SectionTitle>Routing</SectionTitle>
            <dl className="grid grid-cols-2 gap-y-1.5 gap-x-6 text-sm">
              <Row label="Endpoint" value={<code>{detail.data.endpoint}</code>} />
              <Row label="Model" value={<code>{detail.data.modelName}</code>} />
              <Row
                label="Provider"
                value={
                  detail.data.providerSlug
                    ? `${detail.data.providerName} (${detail.data.providerSlug})`
                    : "—"
                }
              />
              <Row
                label="Provider key"
                value={
                  detail.data.providerKeyId
                    ? `${detail.data.keyLabel ?? "(unlabeled)"} · fp:${(detail.data.keyFingerprint ?? "").slice(0, 8)}`
                    : "(none / pooled account)"
                }
              />
              <Row
                label="API key"
                value={
                  detail.data.apiKeyName
                    ? `${detail.data.apiKeyName} · ap_${detail.data.apiKeyPrefix}…`
                    : "—"
                }
              />
              <Row label="HTTP status" value={detail.data.httpStatus ?? "—"} />
            </dl>
          </div>

          {/* ───── usage ───── */}
          <div>
            <SectionTitle>Usage</SectionTitle>
            <dl className="grid grid-cols-2 gap-y-1.5 gap-x-6 text-sm">
              <Row label="Prompt tokens" value={detail.data.promptTokens.toLocaleString()} />
              <Row label="Completion tokens" value={detail.data.completionTokens.toLocaleString()} />
              <Row label="Cached tokens" value={detail.data.cachedTokens.toLocaleString()} />
              <Row label="Total tokens" value={detail.data.totalTokens.toLocaleString()} />
              <Row label="Cost USD" value={detail.data.costUsd ?? "0"} />
            </dl>
          </div>

          {/* ───── timing ───── */}
          <div>
            <SectionTitle>Timing</SectionTitle>
            <dl className="grid grid-cols-2 gap-y-1.5 gap-x-6 text-sm">
              <Row label="Total latency" value={formatLatency(detail.data.latencyMs)} />
              <Row
                label="First token"
                value={
                  detail.data.firstTokenLatencyMs != null
                    ? formatLatency(detail.data.firstTokenLatencyMs)
                    : "—"
                }
              />
            </dl>
          </div>

          {/* ───── client ───── */}
          {(detail.data.clientIp || detail.data.userAgent) && (
            <div>
              <SectionTitle>Client</SectionTitle>
              <dl className="grid grid-cols-1 gap-y-1.5 text-sm">
                {detail.data.clientIp && (
                  <Row label="IP" value={<code>{detail.data.clientIp}</code>} />
                )}
                {detail.data.userAgent && (
                  <Row
                    label="User-Agent"
                    value={
                      <code className="break-all text-xs">{detail.data.userAgent}</code>
                    }
                  />
                )}
              </dl>
            </div>
          )}

          {/* ───── metadata (raw jsonb) ───── */}
          {detail.data.metadata && Object.keys(detail.data.metadata).length > 0 && (
            <div>
              <SectionTitle>Metadata</SectionTitle>
              <pre className="bg-(--color-bg) border border-(--color-border) rounded p-3 text-xs font-mono overflow-x-auto">
                {JSON.stringify(detail.data.metadata, null, 2)}
              </pre>
            </div>
          )}

          {/* ───── request body ───── */}
          {detail.data.requestBody != null && (
            <div>
              <SectionTitle>Request body</SectionTitle>
              <pre className="bg-(--color-bg) border border-(--color-border) rounded p-3 text-xs font-mono overflow-x-auto max-h-80">
                {JSON.stringify(detail.data.requestBody, null, 2)}
              </pre>
            </div>
          )}

          {/* ───── response body ───── */}
          {detail.data.responseBody != null && (
            <div>
              <SectionTitle>Response body</SectionTitle>
              {/* Check for dead providers in aig_auto_attempts */}
              {detail.data.responseBody &&
                typeof detail.data.responseBody === 'object' &&
                'aig_auto_attempts' in detail.data.responseBody &&
                Array.isArray((detail.data.responseBody as any).aig_auto_attempts) && (
                  (() => {
                    const attempts = (detail.data.responseBody as any).aig_auto_attempts;
                    const deadProviders = attempts.filter((a: any) => a.isDead).map((a: any) => a.provider);
                    return deadProviders.length > 0 ? (
                      <div className="mb-3 bg-(--color-danger)/10 border border-(--color-danger)/30 rounded p-3">
                        <Badge tone="danger">⚠️ Dead Providers Detected</Badge>
                        <div className="text-xs mt-2">
                          <span className="text-(--color-text-muted)">Providers hit upstream errors: </span>
                          <span className="font-mono text-(--color-danger)">{deadProviders.join(', ')}</span>
                        </div>
                      </div>
                    ) : null;
                  })()
                )}
              <pre className="bg-(--color-bg) border border-(--color-border) rounded p-3 text-xs font-mono overflow-x-auto max-h-80">
                {JSON.stringify(detail.data.responseBody, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

function StatusBadge({
  status,
  httpStatus,
}: {
  status: string;
  httpStatus: number | null;
}) {
  const tone =
    status === "success" ? "success" : status === "rate_limited" ? "warning" : "danger";
  return (
    <span className="inline-flex items-center gap-1.5">
      <Badge tone={tone}>{status}</Badge>
      {httpStatus != null && (
        <span className="text-[11px] font-mono text-(--color-text-muted)">{httpStatus}</span>
      )}
    </span>
  );
}

function FilterChip({
  label,
  active,
  tone = "neutral",
  onClick,
}: {
  label: string;
  active: boolean;
  tone?: "neutral" | "success" | "danger";
  onClick: () => void;
}) {
  const activeClass =
    tone === "success"
      ? "bg-(--color-success)/15 text-(--color-success) border-(--color-success)/40"
      : tone === "danger"
        ? "bg-(--color-danger)/15 text-(--color-danger) border-(--color-danger)/40"
        : "bg-(--color-accent)/15 text-(--color-text) border-(--color-accent)/40";
  return (
    <button
      onClick={onClick}
      className={`px-2.5 py-1 rounded text-xs border transition-colors ${
        active
          ? activeClass
          : "border-(--color-border) text-(--color-text-muted) hover:text-(--color-text)"
      }`}
    >
      {label}
    </button>
  );
}

function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <div className="text-[10px] uppercase tracking-wider text-(--color-text-muted) mb-2">
      {children}
    </div>
  );
}

function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <>
      <dt className="text-(--color-text-muted)">{label}</dt>
      <dd className="text-(--color-text)">{value}</dd>
    </>
  );
}

function formatTime(d: Date | string): string {
  const date = typeof d === "string" ? new Date(d) : d;
  const diff = Date.now() - date.getTime();
  if (diff < 60_000) return `${Math.round(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return date.toLocaleString();
}

function formatLatency(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}
