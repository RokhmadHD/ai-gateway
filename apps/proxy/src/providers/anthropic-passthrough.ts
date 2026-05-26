import { fetch, type Dispatcher, type HeadersInit } from 'undici'
import {
  ccHeaders,
  ccSystemBlocks,
  ccMetadata,
  isFreemodelHost,
  CC_BILLING_HEADER,
} from './anthropic.js'
import type { KeyPool } from '../pools/keyPool.js'
import type { ProxyPool } from '../pools/proxyPool.js'
import { withRotation, type ClassifiedError } from '../pools/rotation.js'
import type { MinimalLogger } from '../pools/scraper.js'

export interface AttemptTrace {
  key_id?: string
  proxy?: string
  attempts: number
  status?: number
  latency_ms: number
  input_tokens?: number
  output_tokens?: number
  cache_read_tokens?: number
  cache_write_tokens?: number
  error?: string
}

export interface PassthroughOptions {
  maxRetries?: number
  log?: MinimalLogger
  onAttemptComplete?: (trace: AttemptTrace) => void
}

export interface PassthroughStreamResult {
  body: AsyncIterable<Uint8Array>
  headers: Record<string, string>
  trace?: AttemptTrace
}

interface SystemBlock {
  type: string
  text?: string
  cache_control?: unknown
}

function hasBillingPrefix(system: unknown): boolean {
  if (!Array.isArray(system)) return false
  const first = system[0] as SystemBlock | undefined
  return typeof first?.text === 'string' && first.text.includes('x-anthropic-billing-header')
}

function ensureCcShape(body: Record<string, unknown>): Record<string, unknown> {
  const out = { ...body }
  if (!hasBillingPrefix(out.system)) {
    let userSystem: string | undefined
    if (typeof out.system === 'string') {
      userSystem = out.system
    } else if (Array.isArray(out.system)) {
      const blocks = out.system as SystemBlock[]
      userSystem = blocks
        .map((b) => (typeof b.text === 'string' ? b.text : ''))
        .filter((s) => s)
        .join('\n')
    }
    out.system = ccSystemBlocks(userSystem)
  }
  if (!out.metadata) out.metadata = ccMetadata()
  return out
}

export class AnthropicPassthroughProvider {
  private targetOrigin: string
  private isFreemodel: boolean

  constructor(
    private keys: KeyPool,
    private baseUrl: string,
    private proxies?: ProxyPool,
    private opts: PassthroughOptions = {},
  ) {
    this.targetOrigin = new URL(baseUrl).origin
    this.isFreemodel = isFreemodelHost(baseUrl)
  }

  private url(): string {
    return this.isFreemodel ? `${this.baseUrl}/messages?beta=true` : `${this.baseUrl}/messages`
  }

  private prepareBody(raw: Record<string, unknown>): Record<string, unknown> {
    return this.isFreemodel ? ensureCcShape(raw) : raw
  }

  /** Non-streaming pass-through. Returns parsed JSON from upstream. */
  async send(body: Record<string, unknown>): Promise<{ status: number; data: unknown; key: string; latencyMs: number }> {
    const finalBody = this.prepareBody(body)
    return withRotation(
      this.keys,
      this.proxies,
      async ({ key, dispatcher }) => {
        const ac = new AbortController()
        const timeoutId = setTimeout(() => ac.abort(), 120000)
        const startedAt = Date.now()
        try {
          const res = await fetch(this.url(), {
            method: 'POST',
            headers: ccHeaders(key) as HeadersInit,
            body: JSON.stringify(finalBody),
            signal: ac.signal,
            dispatcher,
          })
          if (!res.ok) {
            const errText = await res.text().catch(() => '')
            throw Object.assign(
              new Error(`upstream ${res.status}: ${errText.slice(0, 200)}`),
              { status: res.status, body: errText },
            )
          }
          const data = (await res.json()) as { content?: Array<{ text?: string }> }
          const t = data?.content?.[0]?.text
          if (typeof t === 'string' && t === 'Please use Claude Code CLI') {
            throw Object.assign(new Error('freemodel rejected: config mismatch'), {
              status: 403,
              softReject: true,
            })
          }
          return { status: res.status, data, key, latencyMs: Date.now() - startedAt }
        } finally {
          clearTimeout(timeoutId)
        }
      },
      {
        maxRetries: this.opts.maxRetries ?? 3,
        targetOrigin: this.targetOrigin,
        classify: classify,
      },
      this.opts.log,
    )
  }

  /** Streaming pass-through. Returns raw upstream byte stream after first-byte validation. */
  async sendStream(body: Record<string, unknown>): Promise<PassthroughStreamResult & { key: string; startedAt: number }> {
    const finalBody = this.prepareBody({ ...body, stream: true })
    return withRotation(
      this.keys,
      this.proxies,
      async ({ key, dispatcher }) => {
        const startedAt = Date.now()
        const ac = new AbortController()
        const res = await fetch(this.url(), {
          method: 'POST',
          headers: ccHeaders(key) as HeadersInit,
          body: JSON.stringify(finalBody),
          signal: ac.signal,
          dispatcher,
        })
        if (!res.ok) {
          const errText = await res.text().catch(() => '')
          ac.abort()
          throw Object.assign(
            new Error(`upstream ${res.status}: ${errText.slice(0, 200)}`),
            { status: res.status, body: errText },
          )
        }
        if (!res.body) {
          ac.abort()
          throw new Error('no response body')
        }
        const iter = res.body as unknown as AsyncIterable<Uint8Array>
        const reader = iter[Symbol.asyncIterator]()
        const first = await reader.next()
        if (first.done) {
          ac.abort()
          throw new Error('empty stream')
        }
        const firstText = new TextDecoder().decode(first.value)
        if (firstText.includes('Please use Claude Code CLI')) {
          ac.abort()
          throw Object.assign(new Error('freemodel rejected: config mismatch'), {
            status: 403,
            softReject: true,
          })
        }
        const upstreamHeaders: Record<string, string> = {}
        for (const [k, v] of res.headers as unknown as Iterable<[string, string]>) {
          // forward only safe content headers
          const lk = k.toLowerCase()
          if (
            lk === 'content-type' ||
            lk === 'cache-control' ||
            lk === 'anthropic-ratelimit-requests-remaining' ||
            lk === 'anthropic-ratelimit-tokens-remaining'
          ) {
            upstreamHeaders[k] = v
          }
        }
        async function* replay(): AsyncIterable<Uint8Array> {
          yield first.value
          while (true) {
            const n = await reader.next()
            if (n.done) return
            yield n.value
          }
        }
        return { body: replay(), headers: upstreamHeaders, key, startedAt }
      },
      {
        maxRetries: this.opts.maxRetries ?? 3,
        targetOrigin: this.targetOrigin,
        classify: classify,
      },
      this.opts.log,
    )
  }
}

function classify(err: unknown, status?: number): ClassifiedError {
  if (typeof err === 'object' && err && (err as { softReject?: boolean }).softReject) {
    return { blame: 'fatal', reason: 'other' }
  }
  if (status !== undefined) {
    if (status === 401 || status === 403) return { blame: 'key', reason: 'auth' }
    if (status === 429) return { blame: 'key', reason: 'rate_limit' }
    if (status >= 500) return { blame: 'proxy', reason: 'server' }
    if (status === 400 || status === 404 || status === 422) {
      return { blame: 'fatal', reason: 'other' }
    }
  }
  const code = (err as { code?: string }).code
  if (
    code === 'ECONNREFUSED' ||
    code === 'ECONNRESET' ||
    code === 'ETIMEDOUT' ||
    code === 'ENOTFOUND' ||
    code === 'EAI_AGAIN' ||
    code === 'UND_ERR_SOCKET' ||
    code === 'UND_ERR_CONNECT_TIMEOUT' ||
    (err as Error).name === 'AbortError'
  ) {
    return { blame: 'proxy', reason: 'network' }
  }
  return { blame: 'proxy', reason: 'other' }
}

export { CC_BILLING_HEADER }
