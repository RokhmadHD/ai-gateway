import {
  ConfigRuntime,
  RedisConfigBus,
  toLegacyAppConfig,
  type LegacyAppConfig,
  type ServerSettings,
} from '@ai-gateway/config-runtime'
import { loadConfig as loadConfigFromToml, type AppConfig } from './index.js'

export type ConfigSource = 'toml' | 'db'

export interface LoadedConfig {
  source: ConfigSource
  config: AppConfig
  /** Present only when source === 'db'; null otherwise. */
  runtime: ConfigRuntime | null
}

const ENV_SERVER_DEFAULTS: ServerSettings = {
  port: parseInt(process.env.PORT ?? '7777', 10),
  host: process.env.HOST ?? '0.0.0.0',
  log_level: process.env.LOG_LEVEL ?? 'info',
  pretty_logs: process.env.PRETTY_LOGS === '1',
}

export async function loadConfigFromSource(): Promise<LoadedConfig> {
  const source = (process.env.CONFIG_SOURCE ?? 'toml') as ConfigSource

  if (source === 'db') {
    const tenantSlug = process.env.TENANT_SLUG ?? 'default'
    const explicitPoll = process.env.CONFIG_POLL_MS
      ? parseInt(process.env.CONFIG_POLL_MS, 10)
      : undefined
    const redisUrl = process.env.REDIS_URL
    const bus = redisUrl
      ? new RedisConfigBus({ url: redisUrl, tenantSlug })
      : undefined
    const runtime = new ConfigRuntime({
      tenantSlug,
      pollIntervalMs: explicitPoll,
      bus,
    })
    const snapshot = await runtime.load()
    const legacy = toLegacyAppConfig(snapshot, ENV_SERVER_DEFAULTS)
    return { source, config: legacy as AppConfig, runtime }
  }

  return { source: 'toml', config: loadConfigFromToml(), runtime: null }
}

export function rebuildLegacyConfig(
  runtime: ConfigRuntime,
  server: ServerSettings = ENV_SERVER_DEFAULTS,
): LegacyAppConfig {
  return toLegacyAppConfig(runtime.snapshot(), server)
}
