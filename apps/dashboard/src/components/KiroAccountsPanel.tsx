"use client";

import { useEffect, useRef, useState } from "react";
import { trpc } from "@/lib/trpc";
import { Card, Badge, Button, Input, Modal, Select } from "@/components/ui";

export function KiroAccountsPanel() {
  const list = trpc.kiroAccounts.list.useQuery(undefined, {
    refetchInterval: 15_000,
  });
  const del = trpc.kiroAccounts.delete.useMutation({
    onSuccess: () => list.refetch(),
  });
  const rename = trpc.kiroAccounts.rename.useMutation({
    onSuccess: () => list.refetch(),
  });

  const [showAdd, setShowAdd] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [labelDraft, setLabelDraft] = useState("");

  const expiringSoon = (iso: string) => {
    const t = Date.parse(iso);
    return Number.isFinite(t) && t - Date.now() < 5 * 60 * 1000;
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-semibold">Kiro accounts</h2>
          <p className="text-xs text-(--color-text-muted)">
            Token caches in the pool — proxy rotates across these per request.
          </p>
        </div>
        <Button onClick={() => setShowAdd(true)}>+ Add account</Button>
      </div>

      {list.isLoading && <div className="text-(--color-text-muted)">Loading…</div>}
      {!list.isLoading && list.isFetching && (
        <div className="text-xs text-(--color-text-muted) flex items-center gap-2">
          <Spinner /> Refreshing accounts…
        </div>
      )}
      {list.error && (
        <Card>
          <div className="text-(--color-danger) text-sm">{list.error.message}</div>
        </Card>
      )}

      {list.data && list.data.accounts.length > 0 && (
        <Card>
          <div className="text-xs text-(--color-text-muted) mb-3">
            Storage: <span className="font-mono">{list.data.dir}</span>
          </div>
          <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-(--color-text-muted) border-b border-(--color-border)">
                <th className="py-2 pr-3 font-medium">Label / ID</th>
                <th className="py-2 pr-3 font-medium">Provider</th>
                <th className="py-2 pr-3 font-medium">Profile ARN</th>
                <th className="py-2 pr-3 font-medium">Token</th>
                <th className="py-2 pr-3 font-medium">Added</th>
                <th className="py-2 pr-3 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {list.data.accounts.map((a) => (
                <tr key={a.id} className="border-b border-(--color-border)/50">
                  <td className="py-2 pr-3">
                    {editingId === a.id ? (
                      <form
                        className="flex gap-2"
                        onSubmit={async (e) => {
                          e.preventDefault();
                          await rename.mutateAsync({ id: a.id, label: labelDraft });
                          setEditingId(null);
                        }}
                      >
                        <Input
                          value={labelDraft}
                          onChange={(e) => setLabelDraft(e.target.value)}
                          autoFocus
                        />
                        <Button type="submit" disabled={rename.isPending}>
                          Save
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          onClick={() => setEditingId(null)}
                        >
                          ✕
                        </Button>
                      </form>
                    ) : (
                      <button
                        className="text-left hover:text-(--color-accent)"
                        onClick={() => {
                          setEditingId(a.id);
                          setLabelDraft(a.label ?? "");
                        }}
                      >
                        <div>
                          {a.label || (
                            <em className="text-(--color-text-muted)">no label</em>
                          )}
                        </div>
                        <div className="text-[11px] text-(--color-text-muted) font-mono">
                          {a.id}
                        </div>
                      </button>
                    )}
                  </td>
                  <td className="py-2 pr-3 text-(--color-text-muted)">
                    {a.provider ?? "?"}
                  </td>
                  <td
                    className="py-2 pr-3 font-mono text-[11px] text-(--color-text-muted) max-w-xs truncate"
                    title={a.profileArn}
                  >
                    {a.profileArn}
                  </td>
                  <td className="py-2 pr-3">
                    {a.chainDead ? (
                      <>
                        <Badge tone="danger">needs re-auth</Badge>
                        {a.chainDeadAt && (
                          <div
                            className="text-[11px] text-(--color-text-muted) mt-0.5"
                            title={a.chainDeadReason}
                          >
                            chain died {new Date(a.chainDeadAt).toLocaleString()}
                          </div>
                        )}
                      </>
                    ) : a.expired ? (
                      <Badge tone="warning">expired</Badge>
                    ) : expiringSoon(a.expiresAt) ? (
                      <Badge tone="warning">refresh soon</Badge>
                    ) : (
                      <Badge tone="success">fresh</Badge>
                    )}
                    {!a.chainDead && (
                      <div className="text-[11px] text-(--color-text-muted) mt-0.5">
                        exp {new Date(a.expiresAt).toLocaleString()}
                      </div>
                    )}
                  </td>
                  <td className="py-2 pr-3 text-(--color-text-muted)">
                    {a.addedAt ? new Date(a.addedAt).toLocaleDateString() : "—"}
                  </td>
                  <td className="py-2 pr-3 text-right">
                    <Button
                      variant="danger"
                      onClick={() => {
                        if (confirm(`Delete account "${a.label || a.id}"?`)) {
                          del.mutate({ id: a.id });
                        }
                      }}
                      disabled={del.isPending}
                    >
                      Delete
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </Card>
      )}

      {list.data && list.data.accounts.length === 0 && (
        <Card>
          <div className="text-sm text-(--color-text-muted) text-center py-4">
            No Kiro accounts yet — click <em>Add account</em> to start the device
            authorization flow.
          </div>
        </Card>
      )}

      <Modal open={showAdd} onClose={() => setShowAdd(false)} title="Add Kiro account">
        <AddAccountFlow
          onDone={async () => {
            await list.refetch();
            setShowAdd(false);
          }}
        />
      </Modal>
    </div>
  );
}

function AddAccountFlow({ onDone }: { onDone: () => Promise<void> | void }) {
  const [stage, setStage] = useState<"form" | "verifying" | "done">("form");
  const [loginProvider, setLoginProvider] = useState<"Google" | "Github" | "Cognito">(
    "Google",
  );
  const [label, setLabel] = useState("");
  const [session, setSession] = useState<{
    sessionId: string;
    userCode: string;
    verificationUriComplete: string;
    intervalMs: number;
    expiresAt: number;
  } | null>(null);
  const [pollStatus, setPollStatus] = useState<string>("authorization_pending");
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [finishing, setFinishing] = useState(false);

  const start = trpc.kiroAccounts.startDeviceAuth.useMutation();
  const poll = trpc.kiroAccounts.pollDeviceAuth.useMutation();
  const cancel = trpc.kiroAccounts.cancelDeviceAuth.useMutation();

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // After "authorized" → automatically finalize (refetch + close modal).
  useEffect(() => {
    if (stage !== "done" || finishing) return;
    setFinishing(true);
    void Promise.resolve(onDone());
  }, [stage, finishing, onDone]);

  useEffect(() => {
    if (stage !== "verifying" || !session) return;
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      if (Date.now() > session.expiresAt) {
        setPollStatus("expired_token");
        setErr("Code expired. Try again.");
        return;
      }
      try {
        const res = await poll.mutateAsync({ sessionId: session.sessionId });
        if (cancelled) return;
        setPollStatus(res.status);
        if (res.status === "authorized") {
          setStage("done");
          return;
        }
        if (
          res.status !== "authorization_pending" &&
          res.status !== "slow_down"
        ) {
          setErr(`Login failed: ${res.status}`);
          return;
        }
      } catch (e) {
        if (cancelled) return;
        setErr((e as Error).message);
        return;
      }
      timerRef.current = setTimeout(tick, session.intervalMs);
    };
    tick();
    return () => {
      cancelled = true;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [stage, session, poll]);

  if (stage === "done") {
    return (
      <div className="space-y-4">
        <div className="bg-(--color-success)/10 border border-(--color-success)/30 rounded px-3 py-2 text-sm text-(--color-success) flex items-center gap-2">
          <Spinner /> Account added — refreshing list…
        </div>
      </div>
    );
  }

  if (stage === "verifying" && session) {
    return (
      <div className="space-y-4">
        <div className="bg-(--color-bg) border border-(--color-border) rounded px-4 py-3 text-sm">
          <p className="mb-3">
            Open this URL and complete login with <strong>{loginProvider}</strong>:
          </p>
          <div className="flex gap-2 mb-3">
            <a
              href={session.verificationUriComplete}
              target="_blank"
              rel="noopener noreferrer"
              className="flex-1 text-(--color-accent) hover:underline font-mono text-xs break-all bg-(--color-bg-elev) border border-(--color-border) rounded px-3 py-2"
            >
              {session.verificationUriComplete}
            </a>
            <Button
              variant="secondary"
              onClick={async () => {
                await navigator.clipboard.writeText(session.verificationUriComplete);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
            >
              {copied ? "Copied ✓" : "Copy"}
            </Button>
          </div>
          <div className="text-xs text-(--color-text-muted)">
            Verification code:{" "}
            <span className="font-mono font-semibold text-(--color-text)">
              {session.userCode}
            </span>
          </div>
        </div>

        <div className="text-sm">
          {pollStatus === "authorization_pending" && (
            <div className="flex items-center gap-2 text-(--color-text-muted)">
              <Spinner /> Waiting for you to complete login…
            </div>
          )}
          {pollStatus === "slow_down" && (
            <div className="text-(--color-warning)">
              Polling rate limited, retrying slower…
            </div>
          )}
          {pollStatus === "expired_token" && (
            <div className="text-(--color-danger)">Code expired.</div>
          )}
        </div>

        {err && <div className="text-(--color-danger) text-sm">{err}</div>}

        <div className="flex justify-end gap-2 pt-2">
          <Button
            variant="ghost"
            onClick={async () => {
              await cancel.mutateAsync({ sessionId: session.sessionId });
              onDone();
            }}
          >
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  return (
    <form
      className="space-y-4"
      onSubmit={async (e) => {
        e.preventDefault();
        setErr(null);
        try {
          const res = await start.mutateAsync({
            loginProvider,
            label: label || undefined,
          });
          setSession({
            sessionId: res.sessionId,
            userCode: res.userCode,
            verificationUriComplete: res.verificationUriComplete,
            intervalMs: res.intervalMs,
            expiresAt: Date.now() + res.expiresInMs,
          });
          setStage("verifying");
        } catch (e) {
          setErr((e as Error).message);
        }
      }}
    >
      <label className="block">
        <div className="text-xs text-(--color-text-muted) mb-1">Login with</div>
        <Select
          value={loginProvider}
          onChange={(e) =>
            setLoginProvider(e.target.value as "Google" | "Github" | "Cognito")
          }
        >
          <option value="Google">Google</option>
          <option value="Github">Github</option>
          <option value="Cognito">Cognito</option>
        </Select>
      </label>
      <label className="block">
        <div className="text-xs text-(--color-text-muted) mb-1">Label (optional)</div>
        <Input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="e.g. acc-1@gmail.com"
        />
      </label>
      {err && <div className="text-(--color-danger) text-sm">{err}</div>}
      <div className="flex justify-end gap-2 pt-2">
        <Button type="submit" disabled={start.isPending}>
          {start.isPending ? "Starting…" : "Start login"}
        </Button>
      </div>
    </form>
  );
}

function Spinner() {
  return (
    <svg
      className="animate-spin"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
    >
      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
    </svg>
  );
}
