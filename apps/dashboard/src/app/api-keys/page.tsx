"use client";

import { useState } from "react";
import { AuthGate } from "@/components/AuthGate";
import { trpc } from "@/lib/trpc";
import { Card, PageHeader, Badge, Button, Input, Modal } from "@/components/ui";

export default function ApiKeysPage() {
  return (
    <AuthGate>
      <ApiKeys />
    </AuthGate>
  );
}

function ApiKeys() {
  const list = trpc.apiKeys.list.useQuery(undefined);
  const revoke = trpc.apiKeys.revoke.useMutation({ onSuccess: () => list.refetch() });
  const del = trpc.apiKeys.delete.useMutation({ onSuccess: () => list.refetch() });

  const [showCreate, setShowCreate] = useState(false);
  const [revealed, setRevealed] = useState<{ token: string; name: string } | null>(null);

  return (
    <>
      {/* ───────── page header ───────── */}
      <PageHeader
        title="API keys"
        subtitle="Tokens clients send as Authorization: Bearer to authenticate against the proxy"
        action={<Button onClick={() => setShowCreate(true)}>+ New key</Button>}
      />

      {/* ───────── load / error ───────── */}
      {list.isLoading && <div className="text-(--color-text-muted)">Loading…</div>}
      {list.error && (
        <Card>
          <div className="text-(--color-danger) text-sm">{list.error.message}</div>
        </Card>
      )}

      {/* ───────── keys table ───────── */}
      {list.data && list.data.length > 0 && (
        <Card>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-(--color-text-muted) border-b border-(--color-border)">
                <th className="py-2 pr-3 font-medium">Name</th>
                <th className="py-2 pr-3 font-medium">Prefix</th>
                <th className="py-2 pr-3 font-medium">Status</th>
                <th className="py-2 pr-3 font-medium">Last used</th>
                <th className="py-2 pr-3 font-medium">Created</th>
                <th className="py-2 pr-3 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {list.data.map((k) => (
                <tr key={k.id} className="border-b border-(--color-border)/50">
                  <td className="py-2 pr-3">{k.name}</td>
                  <td className="py-2 pr-3 font-mono text-(--color-text-muted)">
                    ap_{k.prefix}…
                  </td>
                  <td className="py-2 pr-3">
                    <Badge tone={k.status === "active" ? "success" : "danger"}>
                      {k.status}
                    </Badge>
                  </td>
                  <td className="py-2 pr-3 text-(--color-text-muted)">
                    {k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleString() : "never"}
                  </td>
                  <td className="py-2 pr-3 text-(--color-text-muted)">
                    {new Date(k.createdAt).toLocaleDateString()}
                  </td>
                  <td className="py-2 pr-3 text-right">
                    <div className="flex gap-2 justify-end">
                      {k.status === "active" && (
                        <Button
                          variant="secondary"
                          onClick={() =>
                            revoke.mutate({ id: k.id })
                          }
                          disabled={revoke.isPending}
                        >
                          Revoke
                        </Button>
                      )}
                      <Button
                        variant="danger"
                        onClick={() => {
                          if (confirm(`Delete key "${k.name}"? This cannot be undone.`)) {
                            del.mutate({ id: k.id });
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
            No API keys yet — click <em>New key</em> to create one.
          </div>
        </Card>
      )}

      {/* ───────── create modal ───────── */}
      <Modal
        open={showCreate}
        onClose={() => setShowCreate(false)}
        title="Create API key"
      >
        <CreateKeyForm
          onCreated={(res) => {
            setShowCreate(false);
            setRevealed(res);
            list.refetch();
          }}
        />
      </Modal>

      {/* ───────── reveal-once modal ───────── */}
      <Modal
        open={!!revealed}
        onClose={() => setRevealed(null)}
        title="Copy your new API key"
      >
        {revealed && <RevealedToken token={revealed.token} name={revealed.name} />}
      </Modal>
    </>
  );
}

function CreateKeyForm({
  onCreated,
}: {
  onCreated: (res: { token: string; name: string }) => void;
}) {
  const [name, setName] = useState("");
  const create = trpc.apiKeys.create.useMutation();

  return (
    <form
      className="space-y-4"
      onSubmit={async (e) => {
        e.preventDefault();
        const res = await create.mutateAsync({ name });
        onCreated({ token: res.token, name: res.name });
      }}
    >
      <label className="block">
        <div className="text-xs text-(--color-text-muted) mb-1">Name</div>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. opencode-laptop, ci-prod"
          required
          autoFocus
        />
      </label>
      {create.error && (
        <div className="text-(--color-danger) text-sm">{create.error.message}</div>
      )}
      <div className="flex justify-end gap-2 pt-2">
        <Button type="submit" disabled={create.isPending || !name.trim()}>
          {create.isPending ? "Creating…" : "Create"}
        </Button>
      </div>
    </form>
  );
}

function RevealedToken({ token, name }: { token: string; name: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-4">
      <div className="bg-(--color-warning)/10 border border-(--color-warning)/30 rounded px-3 py-2 text-sm text-(--color-warning)">
        This is the only time the token will be shown. Copy it now — once you
        close this dialog it cannot be retrieved.
      </div>
      <div>
        <div className="text-xs text-(--color-text-muted) mb-1">{name}</div>
        <div className="flex gap-2">
          <div className="flex-1 bg-(--color-bg) border border-(--color-border) rounded px-3 py-2 font-mono text-sm break-all">
            {token}
          </div>
          <Button
            variant="secondary"
            onClick={async () => {
              await navigator.clipboard.writeText(token);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            {copied ? "Copied ✓" : "Copy"}
          </Button>
        </div>
      </div>
    </div>
  );
}
