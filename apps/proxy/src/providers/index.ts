import type { Provider } from './base.js'
import { OpenAIProvider } from './openai.js'
import { AnthropicProvider, isFreemodelHost } from './anthropic.js'
import { CustomProvider } from './custom.js'
import { RotatingAnthropicProvider } from './anthropic-rotating.js'
import { KiroProvider } from './kiro.js'
import { GeminiProvider } from './gemini.js'
import { type AppConfig, type CustomProviderConfig, getApiKeys } from '../config/index.js'
import { KeyPool } from '../pools/keyPool.js'
import type { ProxyPool } from '../pools/proxyPool.js'
import type { State } from '../pools/state.js'
import type { MinimalLogger } from '../pools/scraper.js'
import type { KeyReporter } from '../pools/keyReporter.js'

export interface ProviderContext {
  state: State
  proxyPool?: ProxyPool
  log: MinimalLogger
  keyReporter?: KeyReporter
}

const keyPoolCache = new WeakMap<CustomProviderConfig, KeyPool>()

function shouldUseRotation(custom: CustomProviderConfig): boolean {
  const keys = getApiKeys(custom)
  if (keys.length > 1) return true
  if (custom.proxy?.enabled) return true
  if (custom.rotation) return true
  if (custom.base_url && isFreemodelHost(custom.base_url)) return true
  // Single key + no proxy + not freemodel → plain provider is fine
  return false
}

export function createProvider(
  name: string,
  config: AppConfig,
  ctx?: ProviderContext,
): Provider {
  switch (name) {
    case 'openai':
      return new OpenAIProvider(config.providers.openai.api_key)
    case 'anthropic':
      return new AnthropicProvider(config.providers.anthropic.api_key)
    default: {
      const custom = config.providers.custom?.[name]
      if (!custom) throw new Error(`Unknown provider: ${name}`)

      if (custom.endpoint_type === 'kiro') {
        return new KiroProvider({
          tokenCache: custom.token_cache,
          tokenCaches: custom.token_caches,
          accountDir: custom.account_dir,
          defaultModel: custom.default_model,
          maxRetries: custom.rotation?.max_retries,
        })
      }

      if (custom.endpoint_type === 'gemini') {
        return new GeminiProvider({
          tokenCache: custom.token_cache,
          tokenCaches: custom.token_caches,
          accountDir: custom.account_dir,
          defaultModel: custom.default_model,
          maxRetries: custom.rotation?.max_retries,
          thinkingLevel: custom.thinking_level,
          includeThoughts: custom.include_thoughts,
        })
      }

      if (custom.endpoint_type === 'anthropic') {
        if (!custom.base_url) throw new Error(`Provider "${name}": base_url required`)
        if (ctx && shouldUseRotation(custom)) {
          let keyPool = keyPoolCache.get(custom)
          if (!keyPool) {
            const keys = getApiKeys(custom)
            if (keys.length === 0) {
              throw new Error(`Provider "${name}": no api keys configured`)
            }
            keyPool = new KeyPool(name, keys, ctx.state, ctx.keyReporter)
            keyPoolCache.set(custom, keyPool)
          }
          const proxyPool = custom.proxy?.enabled ? ctx.proxyPool : undefined
          return new RotatingAnthropicProvider(keyPool, custom.base_url, proxyPool, {
            maxRetries: custom.rotation?.max_retries ?? 3,
            log: ctx.log,
          })
        }
        // Single key, no rotation/proxy — plain
        const single = getApiKeys(custom)[0] ?? custom.api_key ?? ''
        return new AnthropicProvider(single, custom.base_url)
      }
      if (!custom.base_url) throw new Error(`Provider "${name}": base_url required`)
      const single = getApiKeys(custom)[0] ?? custom.api_key ?? ''
      return new CustomProvider(name, custom.base_url, single)
    }
  }
}

export { OpenAIProvider, AnthropicProvider, CustomProvider, RotatingAnthropicProvider, KiroProvider, GeminiProvider }
export type { Provider }
