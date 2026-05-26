import { getDb, schema } from '@ai-gateway/db'
import type { FastifyBaseLogger } from 'fastify'

const { usageLogs, providerKeys } = schema

export interface UsageLogInput {
  tenantId: string
  apiKeyId?: string
  providerId?: string
  /** Plaintext secret of the provider key actually used; resolved to providerKeyId internally. */
  providerSecret?: string
  modelName: string
  endpoint: string
  requestId: string
  status: 'success' | 'client_error' | 'provider_error' | 'rate_limited' | 'timeout' | 'blocked'
  httpStatus?: number
  latencyMs: number
  firstTokenLatencyMs?: number
  promptTokens?: number
  completionTokens?: number
  cachedTokens?: number
  errorCode?: string
  errorMessage?: string
  requestBody?: unknown
  responseBody?: unknown
  metadata?: Record<string, unknown>
}

const MAX_BODY_BYTES = 64 * 1024 // 64 KB hard cap per body

function clampJson(value: unknown): unknown {
  if (value === undefined || value === null) return null
  try {
    const s = JSON.stringify(value)
    if (s.length <= MAX_BODY_BYTES) return value
    return { _truncated: true, _bytes: s.length, preview: s.slice(0, MAX_BODY_BYTES) }
  } catch {
    return { _unserializable: true, type: typeof value }
  }
}

type SecretToKeyId = Map<string, Map<string, string>>

let secretIndex: SecretToKeyId = new Map()

/** Refresh secret→providerKeyId map. Call on every config snapshot update. */
export function refreshSecretIndex(snapshot: {
  providers: Array<{ slug: string; id: string; keys: Array<{ id: string; secret: string }> }>
}) {
  const next: SecretToKeyId = new Map()
  for (const p of snapshot.providers) {
    const inner = new Map<string, string>()
    for (const k of p.keys) inner.set(k.secret, k.id)
    next.set(p.slug, inner)
  }
  secretIndex = next
}

function resolveProviderKeyId(providerSlug: string | undefined, secret: string | undefined): string | undefined {
  if (!providerSlug || !secret) return undefined
  return secretIndex.get(providerSlug)?.get(secret)
}

/**
 * Fire-and-forget insert. Logging failures must never break the hot path.
 */
export function logUsage(
  input: UsageLogInput & { providerSlug?: string },
  log?: FastifyBaseLogger,
): void {
  const providerKeyId = resolveProviderKeyId(input.providerSlug, input.providerSecret)
  const promptTokens = input.promptTokens ?? 0
  const completionTokens = input.completionTokens ?? 0
  const totalTokens = promptTokens + completionTokens

  void getDb()
    .insert(usageLogs)
    .values({
      tenantId: input.tenantId,
      apiKeyId: input.apiKeyId ?? null,
      providerId: input.providerId ?? null,
      providerKeyId: providerKeyId ?? null,
      modelName: input.modelName,
      endpoint: input.endpoint,
      requestId: input.requestId,
      status: input.status,
      httpStatus: input.httpStatus ?? null,
      promptTokens,
      completionTokens,
      totalTokens,
      cachedTokens: input.cachedTokens ?? 0,
      latencyMs: input.latencyMs,
      firstTokenLatencyMs: input.firstTokenLatencyMs ?? null,
      errorCode: input.errorCode ?? null,
      errorMessage: input.errorMessage ?? null,
      requestBody: input.requestBody !== undefined ? clampJson(input.requestBody) : null,
      responseBody: input.responseBody !== undefined ? clampJson(input.responseBody) : null,
      metadata: input.metadata ?? {},
    })
    .catch((err) => log?.warn({ err, requestId: input.requestId }, 'usage log insert failed'))
}

/**
 * Streaming SSE parser — feed chunks, accumulate Anthropic `usage` info.
 * Returns final usage when stream completes.
 */
export class AnthropicStreamUsageParser {
  private buffer = ''
  private input_tokens = 0
  private output_tokens = 0
  private cache_read = 0
  private cache_write = 0
  private firstTokenAt: number | undefined
  private readonly startedAt: number

  constructor(startedAt = Date.now()) {
    this.startedAt = startedAt
  }

  feed(chunk: Uint8Array | string): void {
    const text = typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk)
    this.buffer += text
    let nl: number
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl).trim()
      this.buffer = this.buffer.slice(nl + 1)
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (!payload || payload === '[DONE]') continue
      try {
        const obj = JSON.parse(payload) as {
          type?: string
          message?: { usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } }
          usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }
          delta?: { type?: string }
        }
        // First content delta marks first-token latency.
        if (
          this.firstTokenAt === undefined &&
          obj.type === 'content_block_delta'
        ) {
          this.firstTokenAt = Date.now()
        }
        const u = obj.message?.usage ?? obj.usage
        if (u) {
          if (typeof u.input_tokens === 'number') this.input_tokens = u.input_tokens
          if (typeof u.output_tokens === 'number') this.output_tokens = u.output_tokens
          if (typeof u.cache_read_input_tokens === 'number') this.cache_read = u.cache_read_input_tokens
          if (typeof u.cache_creation_input_tokens === 'number') this.cache_write = u.cache_creation_input_tokens
        }
      } catch {
        // skip malformed line
      }
    }
  }

  result() {
    return {
      promptTokens: this.input_tokens,
      completionTokens: this.output_tokens,
      cachedTokens: this.cache_read + this.cache_write,
      firstTokenLatencyMs: this.firstTokenAt ? this.firstTokenAt - this.startedAt : undefined,
    }
  }
}

export function parseNonStreamUsage(data: unknown): {
  promptTokens?: number
  completionTokens?: number
  cachedTokens?: number
  modelName?: string
} {
  const d = data as {
    usage?: {
      input_tokens?: number
      output_tokens?: number
      cache_read_input_tokens?: number
      cache_creation_input_tokens?: number
    }
    model?: string
  } | null
  if (!d || typeof d !== 'object') return {}
  const u = d.usage ?? {}
  return {
    promptTokens: u.input_tokens,
    completionTokens: u.output_tokens,
    cachedTokens: (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
    modelName: d.model,
  }
}
