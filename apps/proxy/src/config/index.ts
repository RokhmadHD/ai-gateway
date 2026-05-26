import { readFileSync, existsSync } from 'fs'
import { parse } from 'smol-toml'
import { resolve, dirname, join } from 'path'

export interface RotationConfig {
  max_retries?: number
}

export interface ProviderProxyConfig {
  enabled?: boolean
  scraper_bin?: string
  scrape_interval_sec?: number
  types?: Array<'http' | 'https' | 'socks4' | 'socks5'>
  required?: boolean
  allow_api_key_leak?: boolean
  concurrency?: number
  proxy_timeout_sec?: number
}

export interface CustomProviderConfig {
  base_url?: string
  api_key?: string
  api_keys?: string[]
  endpoint_type?: 'openai' | 'anthropic' | 'kiro' | 'gemini'
  rotation?: RotationConfig
  proxy?: ProviderProxyConfig
  // Kiro / Gemini token-cache shared
  token_cache?: string
  token_caches?: string[]
  account_dir?: string
  default_model?: string
  // Gemini-specific
  thinking_level?: 'OFF' | 'LOW' | 'MEDIUM' | 'HIGH'
  include_thoughts?: boolean
}

export interface AppConfig {
  server: {
    port: number
    host: string
    log_level: string
    pretty_logs: boolean
  }
  providers: {
    default: string
    openai: { api_key: string }
    anthropic: { api_key: string }
    custom?: Record<string, CustomProviderConfig>
  }
  pool?: {
    state_file?: string
  }
  passthrough?: {
    target?: string
  }
}

export function loadConfig(path?: string): AppConfig {
  const resolved = resolveConfigPath(path)
  const raw = readFileSync(resolved, 'utf-8')
  const cfg = parse(raw) as unknown as AppConfig
  validateConfig(cfg)
  return cfg
}

function resolveConfigPath(explicit?: string): string {
  if (explicit) return resolve(explicit)
  if (process.env.CONFIG_PATH) return resolve(process.env.CONFIG_PATH)

  let dir = process.cwd()
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, 'config.toml')
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  throw new Error(
    'config.toml not found. Set CONFIG_PATH env var or place config.toml in cwd / ancestor dirs.',
  )
}

export function getApiKeys(cfg: CustomProviderConfig): string[] {
  if (cfg.api_keys && cfg.api_keys.length > 0) return cfg.api_keys.filter((k) => k && k.trim())
  if (cfg.api_key) return [cfg.api_key]
  return []
}

function validateConfig(cfg: AppConfig): void {
  const customs = cfg.providers?.custom ?? {}
  for (const [name, c] of Object.entries(customs)) {
    if (c.endpoint_type === 'kiro' || c.endpoint_type === 'gemini') continue
    if (c.proxy?.enabled && c.proxy.allow_api_key_leak !== true) {
      throw new Error(
        `Provider "${name}": proxy.enabled=true requires proxy.allow_api_key_leak=true (api keys will traverse untrusted upstream proxies)`,
      )
    }
    const keys = getApiKeys(c)
    if (keys.length === 0 && c.endpoint_type !== 'openai') {
      // openai-style customs can be keyless (e.g. ollama); anthropic-style must have keys
      if (c.endpoint_type === 'anthropic') {
        throw new Error(`Provider "${name}": no api_key/api_keys configured for anthropic endpoint`)
      }
    }
  }
}
