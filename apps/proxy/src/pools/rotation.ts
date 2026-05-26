import type { Dispatcher } from 'undici'
import type { KeyPool, MarkBadReason } from './keyPool.js'
import type { ProxyPool, ProxyEntry } from './proxyPool.js'
import type { MinimalLogger } from './scraper.js'

export type FaultBlame = 'key' | 'proxy' | 'fatal'

export interface RotationAttemptInput {
  key: string
  dispatcher?: Dispatcher
  proxy?: ProxyEntry
  attemptIndex: number
}

export interface ClassifiedError {
  blame: FaultBlame
  reason: MarkBadReason
}

export interface RotationOptions {
  maxRetries: number
  targetOrigin: string
  classify: (err: unknown, status?: number) => ClassifiedError
}

export class RotationExhaustedError extends Error {
  constructor(message: string, public lastError: unknown) {
    super(message)
    this.name = 'RotationExhaustedError'
  }
}

export async function withRotation<T>(
  keyPool: KeyPool,
  proxyPool: ProxyPool | undefined,
  attempt: (input: RotationAttemptInput) => Promise<T>,
  opts: RotationOptions,
  log?: MinimalLogger,
): Promise<T> {
  const triedKeys = new Set<string>()
  const triedProxies = new Set<string>()
  let lastErr: unknown
  const maxAttempts = Math.max(1, opts.maxRetries)

  for (let i = 0; i < maxAttempts; i++) {
    let key: string
    try {
      key = keyPool.pick(triedKeys)
    } catch (e) {
      lastErr = e
      break
    }
    let proxy: ProxyEntry | undefined
    let dispatcher: Dispatcher | undefined
    if (proxyPool && !proxyPool.isEmpty()) {
      proxy = proxyPool.pick(opts.targetOrigin, triedProxies)
      if (proxy) dispatcher = proxyPool.getDispatcher(opts.targetOrigin, proxy)
    }

    log?.debug(
      {
        attempt: i + 1,
        key: keyPool.obscure(key),
        proxy: proxy ? `${proxy.type}://${proxy.host}:${proxy.port}` : 'direct',
      },
      'rotation: trying',
    )

    try {
      const result = await attempt({ key, dispatcher, proxy, attemptIndex: i })
      keyPool.markOk(key)
      return result
    } catch (err) {
      lastErr = err
      const status = extractStatus(err)
      const classified = opts.classify(err, status)
      log?.warn(
        {
          attempt: i + 1,
          key: keyPool.obscure(key),
          proxy: proxy ? `${proxy.type}://${proxy.host}:${proxy.port}` : 'direct',
          status,
          blame: classified.blame,
          reason: classified.reason,
          err: (err as Error).message?.slice(0, 200),
        },
        'rotation: attempt failed',
      )
      if (classified.blame === 'fatal') throw err
      if (classified.blame === 'proxy' && proxy) {
        proxyPool!.markBad(proxy, opts.targetOrigin)
        triedProxies.add(`${proxy.type}://${proxy.host}:${proxy.port}`)
      } else if (classified.blame === 'proxy') {
        keyPool.markBad(key, classified.reason)
        triedKeys.add(key)
      } else if (classified.blame === 'key') {
        keyPool.markBad(key, classified.reason)
        triedKeys.add(key)
      }
    }
  }

  throw new RotationExhaustedError(
    `rotation exhausted after ${maxAttempts} attempts`,
    lastErr,
  )
}

function extractStatus(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined
  const e = err as { status?: number; statusCode?: number; response?: { status?: number } }
  return e.status ?? e.statusCode ?? e.response?.status
}
