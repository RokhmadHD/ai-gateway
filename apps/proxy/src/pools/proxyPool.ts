import { Client, ProxyAgent, type Dispatcher } from 'undici'
import { SocksClient } from 'socks'
import * as tls from 'node:tls'
import type { Socket } from 'node:net'
import type { State, HealthEntry } from './state.js'

export type ProxyType = 'http' | 'https' | 'socks4' | 'socks5'

export interface ProxyEntry {
  type: ProxyType
  host: string
  port: number
}

const DEFAULT_BAD_COOLDOWN_MS = 5 * 60 * 1000
const MAX_DISPATCHER_CACHE = 64

function proxyKey(p: ProxyEntry): string {
  return `${p.type}://${p.host}:${p.port}`
}

function parseProxyString(s: string): ProxyEntry | null {
  const m = s.trim().match(/^(http|https|socks4|socks5):\/\/([^:\/\s]+):(\d+)/i)
  if (!m) return null
  const type = m[1]!.toLowerCase() as ProxyType
  return { type, host: m[2]!, port: Number(m[3]!) }
}

interface CacheEntry {
  dispatcher: Dispatcher
  lastUsed: number
}

export class ProxyPool {
  private proxies: ProxyEntry[] = []
  private dispatcherCache = new Map<string, CacheEntry>()

  constructor(private state: State, private allowedTypes: ProxyType[] = ['http', 'https', 'socks5']) {}

  size(): number {
    return this.proxies.length
  }

  isEmpty(): boolean {
    return this.proxies.length === 0
  }

  /** Replace the active proxy list. Filters by allowed types. */
  replace(list: Array<ProxyEntry | string>): number {
    const next: ProxyEntry[] = []
    const seen = new Set<string>()
    for (const item of list) {
      const p = typeof item === 'string' ? parseProxyString(item) : item
      if (!p) continue
      if (!this.allowedTypes.includes(p.type)) continue
      const k = proxyKey(p)
      if (seen.has(k)) continue
      seen.add(k)
      next.push(p)
    }
    this.proxies = next
    return next.length
  }

  /** Pick a healthy proxy at random for the given target origin. Returns undefined if pool empty. */
  pick(targetOrigin: string, exclude: Set<string> = new Set()): ProxyEntry | undefined {
    if (this.proxies.length === 0) return undefined
    const now = Date.now()
    const stateMap = this.state.getProxies()
    const healthy: ProxyEntry[] = []
    for (const p of this.proxies) {
      const k = proxyKey(p)
      if (exclude.has(k)) continue
      const h = stateMap[this.stateKey(targetOrigin, k)]
      if (!h?.cooldownUntil || h.cooldownUntil <= now) healthy.push(p)
    }
    if (healthy.length === 0) return undefined
    return healthy[Math.floor(Math.random() * healthy.length)]
  }

  /** Get an undici Dispatcher for the given proxy + target origin. Caches per (origin, proxy). */
  getDispatcher(targetOrigin: string, proxy: ProxyEntry): Dispatcher {
    const cacheKey = `${targetOrigin}|${proxyKey(proxy)}`
    const cached = this.dispatcherCache.get(cacheKey)
    if (cached) {
      cached.lastUsed = Date.now()
      return cached.dispatcher
    }
    const dispatcher = this.buildDispatcher(targetOrigin, proxy)
    this.ensureCacheSpace()
    this.dispatcherCache.set(cacheKey, { dispatcher, lastUsed: Date.now() })
    return dispatcher
  }

  markBad(proxy: ProxyEntry, targetOrigin: string): void {
    const k = proxyKey(proxy)
    const sk = this.stateKey(targetOrigin, k)
    const existing = this.state.getProxies()[sk]
    const errorCount = (existing?.errorCount ?? 0) + 1
    const entry: HealthEntry = {
      errorCount,
      lastError: 'fail',
      cooldownUntil: Date.now() + DEFAULT_BAD_COOLDOWN_MS,
    }
    this.state.updateProxy(sk, entry)
    // Evict cached dispatcher for this proxy
    const cacheKey = `${targetOrigin}|${k}`
    const cached = this.dispatcherCache.get(cacheKey)
    if (cached) {
      this.dispatcherCache.delete(cacheKey)
      void cached.dispatcher.close().catch(() => undefined)
    }
  }

  async closeAll(): Promise<void> {
    const dispatchers = [...this.dispatcherCache.values()]
    this.dispatcherCache.clear()
    await Promise.all(dispatchers.map((d) => d.dispatcher.close().catch(() => undefined)))
  }

  private buildDispatcher(targetOrigin: string, proxy: ProxyEntry): Dispatcher {
    if (proxy.type === 'http' || proxy.type === 'https') {
      return new ProxyAgent({ uri: `http://${proxy.host}:${proxy.port}` })
    }
    // SOCKS: custom undici Client with connect override
    const socksType = proxy.type === 'socks4' ? 4 : 5
    const isHttps = targetOrigin.startsWith('https://')
    type ConnectCb = (...args: [Error, null] | [null, Socket]) => void
    return new Client(targetOrigin, {
      connect: (
        opts: { hostname: string; port: string | number; protocol?: string; servername?: string },
        cb: ConnectCb,
      ) => {
        const destPort = Number(opts.port) || (isHttps ? 443 : 80)
        SocksClient.createConnection({
          proxy: { host: proxy.host, port: proxy.port, type: socksType },
          command: 'connect',
          destination: { host: opts.hostname, port: destPort },
          timeout: 8000,
        })
          .then((info) => {
            const raw = info.socket as Socket
            if (!isHttps) {
              cb(null, raw)
              return
            }
            const tlsSocket = tls.connect({
              socket: raw,
              servername: opts.servername ?? opts.hostname,
              ALPNProtocols: ['h2', 'http/1.1'],
            })
            tlsSocket.once('secureConnect', () => cb(null, tlsSocket as unknown as Socket))
            tlsSocket.once('error', (err) => {
              raw.destroy()
              cb(err, null)
            })
          })
          .catch((err: Error) => cb(err, null))
      },
    })
  }

  private ensureCacheSpace(): void {
    if (this.dispatcherCache.size < MAX_DISPATCHER_CACHE) return
    let oldestKey: string | undefined
    let oldestTime = Number.POSITIVE_INFINITY
    for (const [k, v] of this.dispatcherCache) {
      if (v.lastUsed < oldestTime) {
        oldestTime = v.lastUsed
        oldestKey = k
      }
    }
    if (oldestKey !== undefined) {
      const evicted = this.dispatcherCache.get(oldestKey)
      this.dispatcherCache.delete(oldestKey)
      void evicted?.dispatcher.close().catch(() => undefined)
    }
  }

  private stateKey(origin: string, proxyKey: string): string {
    return `${origin}|${proxyKey}`
  }
}

export { proxyKey, parseProxyString }
