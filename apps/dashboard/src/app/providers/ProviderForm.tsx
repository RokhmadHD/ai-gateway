"use client";

import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button, Input, Select } from "@/components/ui";

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

const KIRO_MODELS = [
  "auto",
  "claude-sonnet-4.5",
  "claude-sonnet-4",
  "claude-haiku-4.5",
  "deepseek-3.2",
  "minimax-m2.5",
] as const;

const DEFAULT_BASE_URL: Record<(typeof TYPES)[number], string> = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com/v1",
  anthropic_passthrough: "https://api.anthropic.com",
  google: "https://generativelanguage.googleapis.com/v1beta",
  deepseek: "https://api.deepseek.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
  custom_openai: "",
  custom_anthropic: "",
  kiro: "https://q.us-east-1.amazonaws.com",
};

// Default model hint per provider type, used as placeholder if user leaves blank.
const DEFAULT_MODEL_HINT: Record<(typeof TYPES)[number], string> = {
  openai: "gpt-4o-mini",
  anthropic: "claude-sonnet-4-5-20250929",
  anthropic_passthrough: "claude-sonnet-4-5-20250929",
  google: "gemini-2.0-flash",
  deepseek: "deepseek-chat",
  openrouter: "openrouter/auto",
  custom_openai: "gpt-3.5-turbo",
  custom_anthropic: "claude-3-5-sonnet-20241022",
  kiro: "claude-sonnet-4.5",
};

export function ProviderForm({ onDone }: { onDone: () => void }) {
  const [slug, setSlug] = useState("");
  const [name, setName] = useState("");
  const [type, setType] = useState<(typeof TYPES)[number]>("custom_openai");
  const [baseUrl, setBaseUrl] = useState(DEFAULT_BASE_URL.custom_openai);
  const [defaultModel, setDefaultModel] = useState<string>("");
  const [aigAutoExcluded, setAigAutoExcluded] = useState(false);
  const [kiroAccountDir, setKiroAccountDir] = useState<string>("/var/kiro-accounts");

  const create = trpc.providers.create.useMutation();
  const isKiro = type === "kiro";

  function onTypeChange(t: (typeof TYPES)[number]) {
    setType(t);
    setBaseUrl(DEFAULT_BASE_URL[t]);
    // suggest sane default model for new type if user hasn't customized
    if (!defaultModel || defaultModel === DEFAULT_MODEL_HINT[type]) {
      setDefaultModel(DEFAULT_MODEL_HINT[t]);
    }
  }

  return (
    <form
      className="space-y-3"
      onSubmit={async (e) => {
        e.preventDefault();
        try {
          const config: Record<string, unknown> = {
            default_model: defaultModel || DEFAULT_MODEL_HINT[type],
            aig_auto_excluded: aigAutoExcluded,
          };
          if (isKiro) {
            config.account_dir = kiroAccountDir;
          }
          await create.mutateAsync({ slug,
            name,
            type,
            baseUrl: isKiro ? "" : baseUrl,
            config,
          });
          onDone();
        } catch {
          /* error shown below */
        }
      }}
    >
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <label className="block">
          <div className="text-xs text-(--color-text-muted) mb-1">Slug</div>
          <Input
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            required
            placeholder={isKiro ? "kiro" : "openrouter"}
          />
        </label>
        <label className="block">
          <div className="text-xs text-(--color-text-muted) mb-1">Name</div>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            placeholder={isKiro ? "Kiro (Amazon Q)" : "OpenRouter"}
          />
        </label>
        <label className="block">
          <div className="text-xs text-(--color-text-muted) mb-1">Type</div>
          <Select
            value={type}
            onChange={(e) => onTypeChange(e.target.value as (typeof TYPES)[number])}
          >
            {TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </Select>
        </label>
        {!isKiro && (
          <label className="block">
            <div className="text-xs text-(--color-text-muted) mb-1">Base URL</div>
            <Input
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              required
              type="url"
            />
          </label>
        )}
        <label className="block">
          <div className="text-xs text-(--color-text-muted) mb-1">
            Default model{" "}
            <span className="text-(--color-text-muted)/70">(used by aig-auto)</span>
          </div>
          {isKiro ? (
            <Select
              value={defaultModel || DEFAULT_MODEL_HINT.kiro}
              onChange={(e) => setDefaultModel(e.target.value)}
            >
              {KIRO_MODELS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </Select>
          ) : (
            <Input
              value={defaultModel}
              onChange={(e) => setDefaultModel(e.target.value)}
              placeholder={DEFAULT_MODEL_HINT[type]}
            />
          )}
        </label>
        {isKiro && (
          <label className="block md:col-span-2">
            <div className="text-xs text-(--color-text-muted) mb-1">
              Account directory (server-side path)
            </div>
            <Input
              value={kiroAccountDir}
              onChange={(e) => setKiroAccountDir(e.target.value)}
              placeholder="/var/kiro-accounts"
            />
            <div className="text-[11px] text-(--color-text-muted) mt-1">
              Token cache files (one per account) live here. Add accounts via the
              provider detail page after creation.
            </div>
          </label>
        )}
      </div>
      <label className="flex items-center gap-2 pt-1">
        <input
          type="checkbox"
          checked={aigAutoExcluded}
          onChange={(e) => setAigAutoExcluded(e.target.checked)}
        />
        <span className="text-sm">Exclude from aig-auto rotation pool</span>
      </label>
      {create.error && (
        <div className="text-(--color-danger) text-sm">{create.error.message}</div>
      )}
      <div className="flex gap-2 pt-2">
        <Button type="submit" disabled={create.isPending}>
          {create.isPending ? "Creating…" : "Create"}
        </Button>
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
