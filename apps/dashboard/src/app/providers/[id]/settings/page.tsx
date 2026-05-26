"use client";

import { use, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { trpc } from "@/lib/trpc";
import { Card, Button, Input, Select } from "@/components/ui";

const TYPES = [
  "openai",
  "anthropic",
  "anthropic_passthrough",
  "google",
  "deepseek",
  "openrouter",
  "custom_openai",
  "custom_anthropic",
  "kiro",
] as const;

const ROTATION = [
  "round_robin",
  "weighted",
  "least_used",
  "sticky",
  "random",
] as const;

export default function ProviderSettingsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const provider = trpc.providers.get.useQuery({ id });

  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [type, setType] = useState<(typeof TYPES)[number]>("custom_openai");
  const [baseUrl, setBaseUrl] = useState("");
  const [rotation, setRotation] = useState<(typeof ROTATION)[number]>("round_robin");
  const [maxRetries, setMaxRetries] = useState(3);
  const [timeoutMs, setTimeoutMs] = useState(60_000);
  const [isActive, setIsActive] = useState(true);
  const [defaultModel, setDefaultModel] = useState("");
  const [aigAutoExcluded, setAigAutoExcluded] = useState(false);

  useEffect(() => {
    if (provider.data) {
      setName(provider.data.name);
      setSlug(provider.data.slug);
      setType(provider.data.type as (typeof TYPES)[number]);
      setBaseUrl(provider.data.baseUrl);
      setRotation(provider.data.rotationStrategy as (typeof ROTATION)[number]);
      setMaxRetries(provider.data.maxRetries);
      setTimeoutMs(provider.data.timeoutMs);
      setIsActive(provider.data.isActive);
      const cfg = (provider.data.config ?? {}) as Record<string, unknown>;
      setDefaultModel(typeof cfg.default_model === "string" ? cfg.default_model : "");
      setAigAutoExcluded(cfg.aig_auto_excluded === true);
    }
  }, [provider.data]);

  const update = trpc.providers.update.useMutation({
    onSuccess: () => provider.refetch(),
  });
  const del = trpc.providers.delete.useMutation({
    onSuccess: () => router.push("/providers"),
  });

  return (
    <div className="space-y-6 max-w-2xl">
      <Card>
        <h2 className="font-semibold mb-4">General</h2>
        <form
          className="space-y-3"
          onSubmit={async (e) => {
            e.preventDefault();
            const prevCfg = (provider.data?.config ?? {}) as Record<string, unknown>;
            const config = {
              ...prevCfg,
              default_model: defaultModel,
              aig_auto_excluded: aigAutoExcluded,
            };
            await update.mutateAsync({ id,
              patch: {
                name,
                slug,
                type,
                baseUrl,
                rotationStrategy: rotation,
                maxRetries,
                timeoutMs,
                isActive,
                config,
              },
            });
          }}
        >
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <Field label="Name">
              <Input value={name} onChange={(e) => setName(e.target.value)} required />
            </Field>
            <Field label="Slug">
              <Input value={slug} onChange={(e) => setSlug(e.target.value)} required />
            </Field>
            <Field label="Type">
              <Select value={type} onChange={(e) => setType(e.target.value as (typeof TYPES)[number])}>
                {TYPES.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </Select>
            </Field>
            <Field label="Rotation strategy">
              <Select value={rotation} onChange={(e) => setRotation(e.target.value as (typeof ROTATION)[number])}>
                {ROTATION.map((r) => (
                  <option key={r} value={r}>{r}</option>
                ))}
              </Select>
            </Field>
            <Field label="Base URL" wide>
              <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} type="url" />
            </Field>
            <Field label="Default model (aig-auto)" wide>
              <Input
                value={defaultModel}
                onChange={(e) => setDefaultModel(e.target.value)}
                placeholder="e.g. gpt-4o-mini / claude-sonnet-4.5"
              />
            </Field>
            <Field label="Max retries">
              <Input
                type="number"
                min={1}
                max={20}
                value={maxRetries}
                onChange={(e) => setMaxRetries(parseInt(e.target.value || "3", 10))}
              />
            </Field>
            <Field label="Timeout (ms)">
              <Input
                type="number"
                min={1000}
                step={1000}
                value={timeoutMs}
                onChange={(e) => setTimeoutMs(parseInt(e.target.value || "60000", 10))}
              />
            </Field>
          </div>
          <label className="flex items-center gap-2 pt-2 text-sm cursor-pointer">
            <input
              type="checkbox"
              checked={isActive}
              onChange={(e) => setIsActive(e.target.checked)}
              className="accent-(--color-accent)"
            />
            <span>Active (proxy will route requests to this provider)</span>
          </label>
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input
              type="checkbox"
              checked={aigAutoExcluded}
              onChange={(e) => setAigAutoExcluded(e.target.checked)}
              className="accent-(--color-accent)"
            />
            <span>Exclude from aig-auto rotation pool</span>
          </label>
          {update.error && (
            <div className="text-(--color-danger) text-sm">{update.error.message}</div>
          )}
          {update.isSuccess && (
            <div className="text-(--color-success) text-sm">Saved ✓</div>
          )}
          <div className="pt-2">
            <Button type="submit" disabled={update.isPending}>
              {update.isPending ? "Saving…" : "Save changes"}
            </Button>
          </div>
        </form>
      </Card>

      <Card className="border-(--color-danger)/40">
        <h2 className="font-semibold mb-2 text-(--color-danger)">Danger zone</h2>
        <p className="text-sm text-(--color-text-muted) mb-3">
          Deleting a provider also deletes all its keys, models, and routes. This cannot be undone.
        </p>
        <Button
          variant="danger"
          disabled={del.isPending}
          onClick={() => {
            if (confirm(`Delete provider "${name}" and all its keys?`)) {
              del.mutate({ id });
            }
          }}
        >
          {del.isPending ? "Deleting…" : "Delete provider"}
        </Button>
        {del.error && (
          <div className="text-(--color-danger) text-sm mt-2">{del.error.message}</div>
        )}
      </Card>
    </div>
  );
}

function Field({
  label,
  children,
  wide = false,
}: {
  label: string;
  children: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <label className={`block ${wide ? "md:col-span-2" : ""}`}>
      <div className="text-xs text-(--color-text-muted) mb-1">{label}</div>
      {children}
    </label>
  );
}
