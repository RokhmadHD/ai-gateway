"use client";

import { AuthGate } from "@/components/AuthGate";
import { trpc } from "@/lib/trpc";
import { Card, PageHeader, Badge, Button, Modal } from "@/components/ui";
import type { SnapshotProvider } from "@/lib/api-types";
import Link from "next/link";
import { useState } from "react";
import { ProviderForm } from "./ProviderForm";

export default function ProvidersPage() {
  return (
    <AuthGate>
      <Providers />
    </AuthGate>
  );
}

function Providers() {
  const snap = trpc.meta.snapshot.useQuery(
    undefined,
    { refetchInterval: 10_000 },
  );
  const [showForm, setShowForm] = useState(false);
  const deadProviderCount = snap.data?.deadProviderCount ?? 0;

  return (
    <>
      {/* ───────── page header ───────── */}
      <PageHeader
        title="Providers"
        subtitle="LLM backends configured for this tenant"
        action={
          <div className="flex items-center gap-2">
            <Badge tone={deadProviderCount > 0 ? "danger" : "success"}>
              {deadProviderCount} dead
            </Badge>
            <Button onClick={() => setShowForm(true)}>+ New provider</Button>
          </div>
        }
      />

      {/* ───────── load / error states ───────── */}
      {snap.isLoading && <div className="text-(--color-text-muted)">Loading…</div>}
      {snap.error && (
        <Card>
          <div className="text-(--color-danger) text-sm">{snap.error.message}</div>
        </Card>
      )}

      {/* ───────── provider grid + add-new tile ───────── */}
      {snap.data && (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {(snap.data as { providers: SnapshotProvider[] }).providers.map((p) => (
            <ProviderCard key={p.id} p={p} onDeleted={() => snap.refetch()} />
          ))}
          <button
            onClick={() => setShowForm(true)}
            className="border-2 border-dashed border-(--color-border) rounded-lg p-6 text-(--color-text-muted) hover:border-(--color-accent) hover:text-(--color-accent) transition-colors flex flex-col items-center justify-center gap-2 min-h-48"
          >
            <span className="text-2xl">+</span>
            <span className="text-sm">Add provider</span>
          </button>
        </div>
      )}

      {/* ───────── new-provider modal ───────── */}
      <Modal open={showForm} onClose={() => setShowForm(false)} title="New provider" size="lg">
        <ProviderForm
          onDone={() => {
            setShowForm(false);
            snap.refetch();
          }}
        />
      </Modal>
    </>
  );
}

type SnapshotProviderItem = SnapshotProvider;

function ProviderCard({
  p,
  onDeleted,
}: {
  p: SnapshotProviderItem;
  onDeleted: () => void;
}) {
  const isKiro = p.type === "kiro";
  const isGemini = p.type === "gemini";
  const isAccountBased = isKiro || isGemini;
  const totalSuccess = p.keys.reduce((s, k) => s + k.successCount, 0);
  const totalFail = p.keys.reduce((s, k) => s + k.failureCount, 0);
  const totalReqs = totalSuccess + totalFail;
  const rate = totalReqs > 0 ? (totalSuccess / totalReqs) * 100 : null;
  const activeKeys = p.keys.filter((k) => k.status === "active").length;
  const cooldownKeys = p.keys.filter((k) => k.status === "cooldown").length;
  const dangerKeys = p.keys.length - activeKeys - cooldownKeys;

  const kiroAccounts = trpc.kiroAccounts.list.useQuery(undefined, {
    enabled: isKiro,
    refetchInterval: 30_000,
  });
  const geminiAccounts = trpc.geminiAccounts.list.useQuery(undefined, {
    enabled: isGemini,
    refetchInterval: 30_000,
  });
  const accList = isGemini
    ? (geminiAccounts.data?.accounts ?? [])
    : (kiroAccounts.data?.accounts ?? []);
  const activeAccounts = accList.filter((a) => !a.expired && !a.chainDead).length;
  const expiredAccounts = accList.filter((a) => a.expired && !a.chainDead).length;
  const deadAccounts = accList.filter((a) => a.chainDead).length;
  const del = trpc.providers.delete.useMutation({
    onSuccess: onDeleted,
  });

  return (
    <div className="group bg-(--color-bg-elev) border border-(--color-border) rounded-lg p-5 hover:border-(--color-accent)/50 transition-colors flex flex-col">
      {/* ───────── card header (name + status + arrow) ───────── */}
      <div className="flex items-start justify-between mb-3">
        <div>
          <div className="flex items-center gap-2">
            <Link href={`/providers/${p.id}`} className="hover:text-(--color-accent)">
              <h3 className="font-semibold">{p.name}</h3>
            </Link>
            <Badge tone={p.isActive ? "success" : "neutral"}>
              {p.isActive ? "active" : "off"}
            </Badge>
            {p.isDead && (
              <Badge tone="danger">
                dead
              </Badge>
            )}
          </div>
          <div className="text-xs text-(--color-text-muted) mt-0.5">{p.type}</div>
        </div>
        <Link
          href={`/providers/${p.id}`}
          aria-label={`Open ${p.name}`}
          className="text-(--color-text-muted) group-hover:text-(--color-accent) transition-colors"
        >
          →
        </Link>
      </div>

      {/* ───────── base URL ───────── */}
      <div className="text-xs font-mono text-(--color-text-muted) mb-4 truncate" title={p.baseUrl}>
        {p.baseUrl}
      </div>

      {p.isDead && (
        <div className="mb-4 rounded border border-(--color-danger)/30 bg-(--color-danger)/10 px-3 py-2">
          <div className="text-[10px] uppercase tracking-wider text-(--color-danger)">
            Provider dead
          </div>
          <div className="mt-1 text-xs text-(--color-text-muted) line-clamp-2" title={p.deadReason ?? undefined}>
            {p.deadReason ?? "Last provider attempt failed with upstream error"}
          </div>
          {p.deadSince && (
            <div className="mt-1 text-[11px] text-(--color-text-muted)">
              since {new Date(p.deadSince).toLocaleString()}
            </div>
          )}
        </div>
      )}

      {/* ───────── stats grid ───────── */}
      <div className="grid grid-cols-2 gap-3 mb-3">
        {isAccountBased ? (
          <div>
            <div className="text-[10px] uppercase tracking-wider text-(--color-text-muted)">Accounts</div>
            <div className="flex items-baseline gap-1.5 mt-0.5">
              <span className="text-xl font-semibold tabular-nums">{accList.length}</span>
              <span className="text-xs text-(--color-text-muted)">total</span>
            </div>
            <div className="flex items-center gap-1.5 mt-1">
              {activeAccounts > 0 && (
                <span className="flex items-center gap-1 text-[11px]">
                  <span className="w-1.5 h-1.5 rounded-full bg-(--color-success)" />
                  <span className="text-(--color-success)">{activeAccounts}</span>
                </span>
              )}
              {expiredAccounts > 0 && (
                <span className="flex items-center gap-1 text-[11px]">
                  <span className="w-1.5 h-1.5 rounded-full bg-(--color-warning)" />
                  <span className="text-(--color-warning)">{expiredAccounts}</span>
                </span>
              )}
              {deadAccounts > 0 && (
                <span className="flex items-center gap-1 text-[11px]" title="Refresh chain dead — needs re-auth">
                  <span className="w-1.5 h-1.5 rounded-full bg-(--color-danger)" />
                  <span className="text-(--color-danger)">{deadAccounts} dead</span>
                </span>
              )}
            </div>
          </div>
        ) : (
          <div>
            <div className="text-[10px] uppercase tracking-wider text-(--color-text-muted)">Keys</div>
            <div className="flex items-baseline gap-1.5 mt-0.5">
              <span className="text-xl font-semibold tabular-nums">{p.keys.length}</span>
              <span className="text-xs text-(--color-text-muted)">total</span>
            </div>
            <div className="flex items-center gap-1.5 mt-1">
              {activeKeys > 0 && (
                <span className="flex items-center gap-1 text-[11px]">
                  <span className="w-1.5 h-1.5 rounded-full bg-(--color-success)" />
                  <span className="text-(--color-success)">{activeKeys}</span>
                </span>
              )}
              {cooldownKeys > 0 && (
                <span className="flex items-center gap-1 text-[11px]">
                  <span className="w-1.5 h-1.5 rounded-full bg-(--color-warning)" />
                  <span className="text-(--color-warning)">{cooldownKeys}</span>
                </span>
              )}
              {dangerKeys > 0 && (
                <span className="flex items-center gap-1 text-[11px]">
                  <span className="w-1.5 h-1.5 rounded-full bg-(--color-danger)" />
                  <span className="text-(--color-danger)">{dangerKeys}</span>
                </span>
              )}
            </div>
          </div>
        )}
        <div>
          <div className="text-[10px] uppercase tracking-wider text-(--color-text-muted)">Requests</div>
          <div className="flex items-baseline gap-1.5 mt-0.5">
            <span className="text-xl font-semibold tabular-nums">{totalReqs.toLocaleString()}</span>
            <span className="text-xs text-(--color-text-muted)">total</span>
          </div>
          {rate !== null && (
            <div className="text-[11px] mt-1">
              <span
                className={
                  rate >= 95
                    ? "text-(--color-success)"
                    : rate >= 80
                      ? "text-(--color-warning)"
                      : "text-(--color-danger)"
                }
              >
                {rate.toFixed(1)}% success
              </span>
            </div>
          )}
        </div>
      </div>

      {/* ───────── footer (rotation + short id + actions) ───────── */}
      <div className="mt-auto pt-3 border-t border-(--color-border)">
        <div className="text-[11px] text-(--color-text-muted) flex justify-between">
          <span>{p.rotationStrategy.replace("_", " ")}</span>
          <span className="font-mono">{p.id.slice(0, 8)}</span>
        </div>
        <div className="mt-3 flex items-center justify-between gap-2">
          <Link href={`/providers/${p.id}`} className="text-sm text-(--color-accent) hover:underline">
            Open
          </Link>
          <Button
            type="button"
            variant="danger"
            disabled={del.isPending}
            onClick={() => {
              if (confirm(`Delete provider "${p.name}" and all its keys?`)) {
                del.mutate({ id: p.id });
              }
            }}
          >
            {del.isPending ? "Deleting…" : "Delete"}
          </Button>
        </div>
        {del.error && (
          <div className="mt-2 text-xs text-(--color-danger)">{del.error.message}</div>
        )}
      </div>
    </div>
  );
}
