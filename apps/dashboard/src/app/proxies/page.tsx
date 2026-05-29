"use client";

import { useEffect, useState } from "react";
import { AuthGate } from "@/components/AuthGate";
import { trpc } from "@/lib/trpc";
import {
  Card,
  PageHeader,
  Badge,
  Button,
  Input,
  Select,
  Modal,
} from "@/components/ui";

const TYPE_OPTIONS = ["http", "https", "socks4", "socks5"] as const;
type ProxyType = (typeof TYPE_OPTIONS)[number];

export default function ProxiesPage() {
  return (
    <AuthGate>
      <Proxies />
    </AuthGate>
  );
}

type StatusFilter = "all" | "alive" | "dead" | "unchecked";
type SourceFilter = "all" | "manual" | "scraper";

function Proxies() {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());

  const list = trpc.proxies.list.useQuery({
    status: statusFilter === "all" ? undefined : statusFilter,
    source: sourceFilter === "all" ? undefined : sourceFilter,
  });
  const stats = trpc.proxies.stats.useQuery(undefined, { refetchInterval: 30_000 });
  const scrapeStatus = trpc.proxies.scrapeStatus.useQuery(undefined, {
    refetchInterval: 2_000,
  });

  const setActive = trpc.proxies.setActive.useMutation({ onSuccess: () => list.refetch() });
  const del = trpc.proxies.delete.useMutation({
    onSuccess: () => {
      list.refetch();
      stats.refetch();
    },
  });
  const deleteMany = trpc.proxies.deleteMany.useMutation({
    onSuccess: () => {
      setSelectedIds(new Set());
      list.refetch();
      stats.refetch();
    },
  });
  const scrapeNow = trpc.proxies.scrapeNow.useMutation({
    onSuccess: () => scrapeStatus.refetch(),
  });
  const scrapeStop = trpc.proxies.scrapeStop.useMutation({
    onSuccess: () => scrapeStatus.refetch(),
  });

  const [showCreate, setShowCreate] = useState(false);
  const [editing, setEditing] = useState<NonNullable<typeof list.data>[number] | null>(null);

  const running = scrapeStatus.data?.running ?? false;
  const lastRun = scrapeStatus.data?.lastRun ?? null;
  const progress = scrapeStatus.data?.progress ?? null;
  const visibleIds = list.data?.map((p) => p.id) ?? [];
  const selectedVisibleCount = visibleIds.filter((id) => selectedIds.has(id)).length;
  const allVisibleSelected = visibleIds.length > 0 && selectedVisibleCount === visibleIds.length;

  useEffect(() => {
    setSelectedIds((prev) => {
      if (!list.data) return prev;
      const visible = new Set(list.data.map((p) => p.id));
      const next = new Set([...prev].filter((id) => visible.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [list.data]);

  // Auto-refetch list while a run is in flight (and once when it finishes).
  const [wasRunning, setWasRunning] = useState(false);
  if (wasRunning && !running) {
    list.refetch();
    stats.refetch();
    setWasRunning(false);
  } else if (running && !wasRunning) {
    setWasRunning(true);
  }

  const phaseLabel = (() => {
    if (!progress) return "starting";
    switch (progress.phase) {
      case "starting":
        return "starting";
      case "scraping":
        return `scraping sources (${progress.sourcesDone}/${progress.sourcesTotal || "?"})`;
      case "scraped":
        return "scraped — preparing check";
      case "checking":
        return `checking liveness (${progress.checkDone}/${progress.checkTotal || "?"}, ${progress.aliveSoFar} alive)`;
      case "checked":
        return `checked — ${progress.aliveSoFar} alive`;
      case "geoip":
        return "resolving geoip";
      case "writing":
        return "writing output";
      case "inserting":
        return "inserting into db";
      case "stopping":
        return "stopping";
      case "done":
        return "done";
      default:
        return progress.phase;
    }
  })();

  const progressPct = (() => {
    if (!progress) return 0;
    // Weighted: scraping=30%, checking=60%, the rest=10%.
    if (progress.phase === "scraping") {
      const p = progress.sourcesTotal > 0 ? progress.sourcesDone / progress.sourcesTotal : 0;
      return Math.round(p * 30);
    }
    if (progress.phase === "scraped") return 30;
    if (progress.phase === "checking") {
      const p = progress.checkTotal > 0 ? progress.checkDone / progress.checkTotal : 0;
      return 30 + Math.round(p * 60);
    }
    if (progress.phase === "checked") return 90;
    if (
      progress.phase === "geoip" ||
      progress.phase === "writing" ||
      progress.phase === "inserting" ||
      progress.phase === "stopping"
    ) return 95;
    if (progress.phase === "done") return 100;
    return 5;
  })();

  return (
    <>
      <PageHeader
        title="Proxies"
        subtitle="HTTP/SOCKS proxies the gateway can route provider traffic through"
        action={
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              onClick={() => scrapeNow.mutate(undefined)}
              disabled={running || scrapeNow.isPending}
            >
              {running ? "Scraping…" : "Scrape now"}
            </Button>
            {running && (
              <Button
                variant="danger"
                onClick={() => scrapeStop.mutate()}
                disabled={scrapeStop.isPending}
              >
                {scrapeStop.isPending ? "Stopping…" : "Stop"}
              </Button>
            )}
            <Button onClick={() => setShowCreate(true)}>+ New proxy</Button>
          </div>
        }
      />

      {/* ───────── scraper status ───────── */}
      <Card className="mb-3">
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-xs">
            <div>
              <span className="text-(--color-text-muted)">Scraper:</span>{" "}
              <span className={running ? "text-(--color-accent)" : ""}>
                {running ? "running" : "idle"}
              </span>
            </div>
            {running && progress && (
              <div>
                <span className="text-(--color-text-muted)">Phase:</span>{" "}
                <span className="font-mono">{phaseLabel}</span>
              </div>
            )}
            {lastRun && !running && (
              <>
                <div>
                  <span className="text-(--color-text-muted)">Last run:</span>{" "}
                  {new Date(lastRun.finishedAt).toLocaleString()} ({Math.round(lastRun.durationMs / 1000)}s)
                </div>
                <div>
                  <span className="text-(--color-text-muted)">Scraped:</span>{" "}
                  <span className="font-mono">{lastRun.scraped}</span>
                  {" / "}
                  <span className="text-(--color-text-muted)">alive:</span>{" "}
                  <span className="font-mono text-(--color-success)">{lastRun.alive}</span>
                </div>
                <div>
                  <span className="text-(--color-text-muted)">Updated (this tenant):</span>{" "}
                  <span className="font-mono">
                    {Object.values(lastRun.insertedByTenant).reduce((a, b) => a + b, 0)}
                  </span>
                </div>
                {lastRun.error && (
                  <div className="text-(--color-danger)">{lastRun.error}</div>
                )}
              </>
            )}
            {!lastRun && !running && (
              <div className="text-(--color-text-muted)">no runs yet — click <em>Scrape now</em> or wait for the hourly schedule</div>
            )}
          </div>

          {running && (
            <div>
              <div className="h-1.5 w-full rounded-full bg-(--color-border)/40 overflow-hidden">
                <div
                  className="h-full bg-(--color-accent) transition-all duration-500"
                  style={{ width: `${progressPct}%` }}
                />
              </div>
              <div className="text-[10px] text-(--color-text-muted) mt-0.5 text-right font-mono">
                {progressPct}%
              </div>
            </div>
          )}
        </div>
      </Card>

      {/* ───────── stats ───────── */}
      {stats.data && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
          <StatTile label="Total" value={stats.data.total} />
          <StatTile label="Alive" value={stats.data.alive} tone="success" />
          <StatTile label="Dead" value={stats.data.dead} tone="danger" />
          <StatTile label="Unchecked" value={stats.data.unchecked} tone="muted" />
        </div>
      )}

      {/* ───────── filters ───────── */}
      <Card className="mb-3">
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <label className="flex items-center gap-2">
            <span className="text-(--color-text-muted) text-xs">Status</span>
            <Select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
            >
              <option value="all">all</option>
              <option value="alive">alive</option>
              <option value="dead">dead</option>
              <option value="unchecked">unchecked</option>
            </Select>
          </label>
          <label className="flex items-center gap-2">
            <span className="text-(--color-text-muted) text-xs">Source</span>
            <Select
              value={sourceFilter}
              onChange={(e) => setSourceFilter(e.target.value as SourceFilter)}
            >
              <option value="all">all</option>
              <option value="manual">manual</option>
              <option value="scraper">scraper</option>
            </Select>
          </label>
          <div className="ml-auto flex items-center gap-2">
            {selectedVisibleCount > 0 && (
              <span className="text-xs text-(--color-text-muted)">
                {selectedVisibleCount} selected
              </span>
            )}
            <Button
              variant="danger"
              disabled={selectedVisibleCount === 0 || deleteMany.isPending}
              onClick={() => {
                const ids = visibleIds.filter((id) => selectedIds.has(id));
                if (
                  ids.length > 0 &&
                  confirm(`Delete ${ids.length} selected prox${ids.length === 1 ? "y" : "ies"}?`)
                ) {
                  deleteMany.mutate({ ids });
                }
              }}
            >
              Delete selected
            </Button>
          </div>
        </div>
      </Card>

      {/* ───────── load / error ───────── */}
      {list.isLoading && <div className="text-(--color-text-muted)">Loading…</div>}
      {list.error && (
        <Card>
          <div className="text-(--color-danger) text-sm">{list.error.message}</div>
        </Card>
      )}

      {/* ───────── proxies table ───────── */}
      {list.data && list.data.length > 0 && (
        <Card>
          <div className="overflow-x-auto">
            <table className="min-w-[860px] w-full text-sm">
              <thead>
                <tr className="text-left text-(--color-text-muted) border-b border-(--color-border)">
                  <th className="py-2 pr-3 font-medium w-8">
                    <input
                      type="checkbox"
                      aria-label="Select all visible proxies"
                      checked={allVisibleSelected}
                      onChange={(e) => {
                        const checked = e.currentTarget.checked;
                        setSelectedIds((prev) => {
                          const next = new Set(prev);
                          for (const id of visibleIds) {
                            if (checked) next.add(id);
                            else next.delete(id);
                          }
                          return next;
                        });
                      }}
                    />
                  </th>
                  <th className="py-2 pr-3 font-medium">Endpoint</th>
                  <th className="py-2 pr-3 font-medium">Type</th>
                  <th className="py-2 pr-3 font-medium">Status</th>
                  <th className="py-2 pr-3 font-medium">Source</th>
                  <th className="py-2 pr-3 font-medium">Latency</th>
                  <th className="py-2 pr-3 font-medium">Last check</th>
                  <th className="py-2 pr-3 font-medium">Active</th>
                  <th className="py-2 pr-3 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {list.data.map((p) => (
                  <tr key={p.id} className="border-b border-(--color-border)/50">
                    <td className="py-2 pr-3">
                      <input
                        type="checkbox"
                        aria-label={`Select proxy ${p.type}://${p.host}:${p.port}`}
                        checked={selectedIds.has(p.id)}
                        onChange={(e) => {
                          const checked = e.currentTarget.checked;
                          setSelectedIds((prev) => {
                            const next = new Set(prev);
                            if (checked) next.add(p.id);
                            else next.delete(p.id);
                            return next;
                          });
                        }}
                      />
                    </td>
                    <td className="py-2 pr-3 font-mono">
                      {p.host}:{p.port}
                      {p.label && (
                        <div className="text-[11px] text-(--color-text-muted) font-sans">
                          {p.label}
                        </div>
                      )}
                    </td>
                    <td className="py-2 pr-3 uppercase text-xs text-(--color-text-muted)">
                      {p.type}
                    </td>
                    <td className="py-2 pr-3">
                      <Badge
                        tone={
                          p.status === "alive"
                            ? "success"
                            : p.status === "dead"
                              ? "danger"
                              : "neutral"
                        }
                      >
                        {p.status}
                      </Badge>
                    </td>
                    <td className="py-2 pr-3 text-xs text-(--color-text-muted)">{p.source}</td>
                    <td className="py-2 pr-3 text-(--color-text-muted)">
                      {p.latencyMs != null ? `${p.latencyMs} ms` : "—"}
                    </td>
                    <td className="py-2 pr-3 text-(--color-text-muted)">
                      {p.lastCheckedAt
                        ? new Date(p.lastCheckedAt).toLocaleString()
                        : "never"}
                    </td>
                    <td className="py-2 pr-3">
                      <button
                        type="button"
                        onClick={() =>
                          setActive.mutate({ id: p.id, isActive: !p.isActive })
                        }
                        className={`px-2 py-0.5 rounded text-xs border transition-colors ${
                          p.isActive
                            ? "border-(--color-accent)/30 bg-(--color-accent)/10 text-(--color-accent)"
                            : "border-(--color-border) text-(--color-text-muted) hover:border-(--color-accent)/30"
                        }`}
                        disabled={setActive.isPending}
                      >
                        {p.isActive ? "on" : "off"}
                      </button>
                    </td>
                    <td className="py-2 pr-3 text-right">
                      <div className="flex gap-2 justify-end">
                        <Button variant="secondary" onClick={() => setEditing(p)}>
                          Edit
                        </Button>
                        <Button
                          variant="danger"
                          onClick={() => {
                            if (
                              confirm(`Delete proxy ${p.type}://${p.host}:${p.port}?`)
                            ) {
                              del.mutate({ id: p.id });
                            }
                          }}
                          disabled={del.isPending}
                        >
                          Delete
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* ───────── empty state ───────── */}
      {list.data && list.data.length === 0 && (
        <Card>
          <div className="text-sm text-(--color-text-muted) text-center py-4">
            No proxies yet — click <em>New proxy</em> to add one manually.
          </div>
        </Card>
      )}

      {/* ───────── create modal ───────── */}
      <Modal open={showCreate} onClose={() => setShowCreate(false)} title="Add proxy">
        <ProxyForm
          onSaved={() => {
            setShowCreate(false);
            list.refetch();
            stats.refetch();
          }}
        />
      </Modal>

      {/* ───────── edit modal ───────── */}
      <Modal open={!!editing} onClose={() => setEditing(null)} title="Edit proxy">
        {editing && (
          <ProxyForm
            initial={editing}
            onSaved={() => {
              setEditing(null);
              list.refetch();
            }}
          />
        )}
      </Modal>
    </>
  );
}

function StatTile({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: number;
  tone?: "default" | "success" | "danger" | "muted";
}) {
  const color =
    tone === "success"
      ? "text-(--color-success)"
      : tone === "danger"
        ? "text-(--color-danger)"
        : tone === "muted"
          ? "text-(--color-text-muted)"
          : "text-(--color-text)";
  return (
    <Card>
      <div className="text-[10px] uppercase tracking-wider text-(--color-text-muted)">
        {label}
      </div>
      <div className={`text-2xl font-semibold ${color}`}>{value}</div>
    </Card>
  );
}

type ProxyRow = {
  id: string;
  label: string | null;
  type: ProxyType;
  host: string;
  port: number;
  username: string | null;
  isActive: boolean;
};

function ProxyForm({
  initial,
  onSaved,
}: {
  initial?: ProxyRow;
  onSaved: () => void;
}) {
  const [label, setLabel] = useState(initial?.label ?? "");
  const [type, setType] = useState<ProxyType>(initial?.type ?? "http");
  const [host, setHost] = useState(initial?.host ?? "");
  const [port, setPort] = useState<string>(initial?.port?.toString() ?? "");
  const [username, setUsername] = useState(initial?.username ?? "");
  const [password, setPassword] = useState("");
  const [isActive, setIsActive] = useState(initial?.isActive ?? true);

  const create = trpc.proxies.create.useMutation();
  const update = trpc.proxies.update.useMutation();

  const mutating = initial ? update.isPending : create.isPending;
  const error = initial ? update.error : create.error;

  return (
    <form
      className="space-y-3"
      onSubmit={async (e) => {
        e.preventDefault();
        const payload = {
          label: label.trim() || null,
          type,
          host: host.trim(),
          port: Number(port),
          username: username.trim() || null,
          passwordEncrypted: password.trim() || null,
          isActive,
        };
        if (initial) {
          await update.mutateAsync({ id: initial.id, patch: payload });
        } else {
          await create.mutateAsync({ ...payload, source: "manual" });
        }
        onSaved();
      }}
    >
      <label className="block">
        <div className="text-xs text-(--color-text-muted) mb-1">Label (optional)</div>
        <Input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="e.g. residential-us-1"
        />
      </label>

      <div className="grid grid-cols-3 gap-3">
        <label className="block col-span-1">
          <div className="text-xs text-(--color-text-muted) mb-1">Type</div>
          <Select value={type} onChange={(e) => setType(e.target.value as ProxyType)}>
            {TYPE_OPTIONS.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </Select>
        </label>
        <label className="block col-span-1">
          <div className="text-xs text-(--color-text-muted) mb-1">Host</div>
          <Input
            value={host}
            onChange={(e) => setHost(e.target.value)}
            placeholder="1.2.3.4"
            required
          />
        </label>
        <label className="block col-span-1">
          <div className="text-xs text-(--color-text-muted) mb-1">Port</div>
          <Input
            type="number"
            value={port}
            onChange={(e) => setPort(e.target.value)}
            placeholder="8080"
            required
            min={1}
            max={65535}
          />
        </label>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <label className="block">
          <div className="text-xs text-(--color-text-muted) mb-1">Username (optional)</div>
          <Input value={username} onChange={(e) => setUsername(e.target.value)} />
        </label>
        <label className="block">
          <div className="text-xs text-(--color-text-muted) mb-1">
            Password {initial ? "(leave blank to keep)" : "(optional)"}
          </div>
          <Input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
          />
        </label>
      </div>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={isActive}
          onChange={(e) => setIsActive(e.target.checked)}
        />
        <span>Active (eligible for use by rotation)</span>
      </label>

      {error && <div className="text-(--color-danger) text-sm">{error.message}</div>}

      <div className="flex justify-end gap-2 pt-2">
        <Button type="submit" disabled={mutating || !host.trim() || !port}>
          {mutating ? "Saving…" : initial ? "Save" : "Create"}
        </Button>
      </div>
    </form>
  );
}
