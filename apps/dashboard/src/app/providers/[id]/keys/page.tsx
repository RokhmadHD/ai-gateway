"use client";

import { use, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { trpc } from "@/lib/trpc";
import { Card, Badge, Button, Input, Modal, SecretInput } from "@/components/ui";

export default function ProviderKeysPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const provider = trpc.providers.get.useQuery({ id });

  useEffect(() => {
    if (provider.data?.type === "kiro") {
      router.replace(`/providers/${id}/accounts`);
    }
  }, [provider.data?.type, id, router]);

  const keys = trpc.providerKeys.list.useQuery(
    { providerId: id },
    { enabled: provider.data ? provider.data.type !== "kiro" : false },
  );
  const setStatus = trpc.providerKeys.setStatus.useMutation({
    onSuccess: () => keys.refetch(),
  });
  const del = trpc.providerKeys.delete.useMutation({
    onSuccess: () => keys.refetch(),
  });

  const [showAdd, setShowAdd] = useState(false);

  if (provider.data?.type === "kiro") {
    return (
      <Card>
        <div className="text-sm text-(--color-text-muted)">
          Kiro uses accounts, not keys — redirecting…
        </div>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold">
          Keys{" "}
          <span className="text-(--color-text-muted) font-normal">
            ({keys.data?.length ?? "…"})
          </span>
        </h2>
        <Button onClick={() => setShowAdd(true)}>+ Add key</Button>
      </div>

      <div className="grid grid-cols-1 gap-2">
        {keys.data?.map((k) => (
          <Card key={k.id} className="flex items-center justify-between">
            <div>
              <div className="flex items-center gap-2">
                <span className="font-medium">{k.label ?? "(unlabeled)"}</span>
                <Badge tone={statusTone(k.status)}>{k.status}</Badge>
                <span className="text-xs text-(--color-text-muted) font-mono">
                  fp:{k.keyFingerprint.slice(0, 8)}…
                </span>
              </div>
              <div className="text-xs text-(--color-text-muted) mt-1">
                ok={k.successCount} • fail={k.failureCount} • last=
                {k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleString() : "never"}
              </div>
            </div>
            <div className="flex gap-2">
              {k.status === "active" ? (
                <Button
                  variant="secondary"
                  onClick={() =>
                    setStatus.mutate({ id: k.id,
                      status: "disabled",
                    })
                  }
                >
                  Disable
                </Button>
              ) : (
                <Button
                  variant="secondary"
                  onClick={() =>
                    setStatus.mutate({ id: k.id,
                      status: "active",
                      clearCooldown: true,
                    })
                  }
                >
                  Enable
                </Button>
              )}
              <Button
                variant="danger"
                onClick={() => {
                  if (confirm(`Delete key ${k.label ?? k.id.slice(0, 8)}?`)) {
                    del.mutate({ id: k.id });
                  }
                }}
              >
                Delete
              </Button>
            </div>
          </Card>
        ))}
        {keys.data?.length === 0 && (
          <Card>
            <div className="text-sm text-(--color-text-muted)">
              No keys yet — click <em>Add key</em> to create one.
            </div>
          </Card>
        )}
      </div>

      <Modal open={showAdd} onClose={() => setShowAdd(false)} title="Add provider key">
        <AddKeyForm
          providerId={id}
          onDone={() => {
            setShowAdd(false);
            keys.refetch();
          }}
        />
      </Modal>
    </div>
  );
}

function AddKeyForm({
  providerId,
  onDone,
}: {
  providerId: string;
  onDone: () => void;
}) {
  const [label, setLabel] = useState("");
  const [secret, setSecret] = useState("");
  const create = trpc.providerKeys.create.useMutation();

  return (
    <form
      className="space-y-4"
      onSubmit={async (e) => {
        e.preventDefault();
        try {
          await create.mutateAsync({ providerId,
            label: label || undefined,
            secret,
          });
          onDone();
        } catch {
          /* error rendered below */
        }
      }}
    >
      <label className="block">
        <div className="text-xs text-(--color-text-muted) mb-1">
          Label <span className="text-(--color-text-muted)/60">(optional, for identification)</span>
        </div>
        <Input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="e.g. primary, backup, openrouter-personal"
          autoFocus
        />
      </label>
      <label className="block">
        <div className="text-xs text-(--color-text-muted) mb-1">Secret</div>
        <SecretInput
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          required
        />
        <div className="text-[11px] text-(--color-text-muted) mt-1">
          Stored encrypted; only fingerprint is displayed afterwards.
        </div>
      </label>
      {create.error && (
        <div className="text-(--color-danger) text-sm">{create.error.message}</div>
      )}
      <div className="flex justify-end gap-2 pt-2">
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={create.isPending || !secret}>
          {create.isPending ? "Adding…" : "Add key"}
        </Button>
      </div>
    </form>
  );
}

function statusTone(s: string): "success" | "warning" | "danger" | "neutral" {
  switch (s) {
    case "active":
      return "success";
    case "cooldown":
      return "warning";
    case "exhausted":
    case "disabled":
    case "revoked":
      return "danger";
    default:
      return "neutral";
  }
}
