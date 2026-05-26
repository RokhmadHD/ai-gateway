import type { ConfigSnapshot, ResolvedProvider } from "@ai-gateway/shared";

/**
 * Bridge from the new DB-driven snapshot back into the legacy AppConfig
 * shape that the proxy already consumes. Lets us swap config source without
 * touching every route/provider in apps/proxy.
 *
 * Mapping:
 *  - server fields come from env (proxy reads from process.env, not config)
 *  - providers.custom.<slug> := each ResolvedProvider with endpoint_type
 *    derived from ProviderType
 *  - openai/anthropic top-level keys: empty (legacy slot, not used in DB mode)
 *  - passthrough.target: first provider with type=anthropic_passthrough,
 *    if any; otherwise undefined
 *
 * Server settings (port/host/log_level/pretty_logs) MUST come from env when
 * CONFIG_SOURCE=db, since the DB schema doesn't model them.
 */
export interface ServerSettings {
  port: number;
  host: string;
  log_level: string;
  pretty_logs: boolean;
}

export interface LegacyAppConfig {
  server: ServerSettings;
  providers: {
    default: string;
    openai: { api_key: string };
    anthropic: { api_key: string };
    custom: Record<string, LegacyCustomProvider>;
  };
  pool?: { state_file?: string };
  passthrough?: { target?: string };
}

export interface LegacyCustomProvider {
  base_url: string;
  api_keys: string[];
  endpoint_type: "openai" | "anthropic" | "kiro" | "gemini";
  rotation: { max_retries: number };
  // kiro / gemini specific (only set when endpoint_type === "kiro" | "gemini")
  default_model?: string;
  account_dir?: string;
  thinking_level?: "OFF" | "LOW" | "MEDIUM" | "HIGH";
  include_thoughts?: boolean;
}

export function toLegacyAppConfig(
  snap: ConfigSnapshot,
  server: ServerSettings,
): LegacyAppConfig {
  const custom: Record<string, LegacyCustomProvider> = {};
  let passthroughTarget: string | undefined;

  const activeProviders = snap.providers.filter((p) => p.isActive);

  for (const p of activeProviders) {
    const isKiro = p.type === "kiro";
    const isGemini = p.type === "gemini";
    const isFileBased = isKiro || isGemini;
    // non-file-based providers need keys; kiro/gemini use file-based account pool
    if (!isFileBased && p.keys.length === 0) continue;

    const endpoint_type = legacyEndpointType(p);
    const entry: LegacyCustomProvider = {
      base_url: p.baseUrl,
      api_keys: isFileBased
        ? []
        : p.keys
            .filter((k) => k.status !== "disabled" && k.status !== "revoked")
            .map((k) => k.secret),
      endpoint_type,
      rotation: { max_retries: p.maxRetries },
    };
    if (isFileBased) {
      const cfg = (p.config ?? {}) as Record<string, unknown>;
      if (typeof cfg.default_model === "string") entry.default_model = cfg.default_model;
      if (typeof cfg.account_dir === "string") entry.account_dir = cfg.account_dir;
      if (
        cfg.thinking_level === "OFF" ||
        cfg.thinking_level === "LOW" ||
        cfg.thinking_level === "MEDIUM" ||
        cfg.thinking_level === "HIGH"
      ) {
        entry.thinking_level = cfg.thinking_level;
      }
      if (typeof cfg.include_thoughts === "boolean") {
        entry.include_thoughts = cfg.include_thoughts;
      }
    }
    custom[p.slug] = entry;
    if (!passthroughTarget && p.type === "anthropic_passthrough") {
      passthroughTarget = p.slug;
    }
  }

  return {
    server,
    providers: {
      default: activeProviders[0]?.slug ?? "openai",
      openai: { api_key: "" },
      anthropic: { api_key: "" },
      custom,
    },
    passthrough: passthroughTarget ? { target: passthroughTarget } : undefined,
  };
}

function legacyEndpointType(p: ResolvedProvider): "openai" | "anthropic" | "kiro" | "gemini" {
  switch (p.type) {
    case "openai":
    case "custom_openai":
    case "deepseek":
    case "openrouter":
    case "google":
      return "openai";
    case "anthropic":
    case "anthropic_passthrough":
    case "custom_anthropic":
      return "anthropic";
    case "kiro":
      return "kiro";
    case "gemini":
      return "gemini";
  }
}
