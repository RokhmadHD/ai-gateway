import type { ConfigSnapshot, ResolvedProvider } from '@ai-gateway/shared'
import type { CursorRedis } from '@ai-gateway/config-runtime'
import { createProvider, type ProviderContext } from '../providers/index.js'
import type { AppConfig } from '../config/index.js'
import type { ChatRequest, ChatResponse, Provider } from '../providers/base.js'

export type { CursorRedis }

export const AIG_AUTO_MODEL = 'aig-auto'

const FALLBACK_MODEL_BY_TYPE: Record<string, string> = {
  openai: 'gpt-4o-mini',
  anthropic: 'claude-sonnet-4-5-20250929',
  anthropic_passthrough: 'claude-sonnet-4-5-20250929',
  google: 'gemini-2.0-flash',
  deepseek: 'deepseek-chat',
  openrouter: 'openrouter/auto',
  custom_openai: 'gpt-3.5-turbo',
  custom_anthropic: 'claude-3-5-sonnet-20241022',
  kiro: 'claude-sonnet-4.5',
  gemini: 'gemini-3-flash-preview',
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504])

// Upstream errors that should mark provider as dead
function isUpstreamError(err: unknown): boolean {
  const msg = (err as { message?: string })?.message ?? ''
  if (msg.includes('Third-party apps now draw from extra usage')) return true
  if (msg.includes('upstream_error')) return true

  // Check in error object
  if (typeof err === 'object' && err !== null && 'error' in err) {
    const errObj = (err as { error?: { type?: string; message?: string } }).error
    if (errObj?.type === 'upstream_error') return true
    if (errObj?.message?.includes('Third-party apps now draw from extra usage')) return true
  }

  return false
}

interface ProviderCandidate {
  id: string
  slug: string
  type: string
  defaultModel: string
}

function getDefaultModel(p: ResolvedProvider): string {
  const cfg = (p.config ?? {}) as Record<string, unknown>
  if (typeof cfg.default_model === 'string' && cfg.default_model.trim()) {
    return cfg.default_model
  }
  return FALLBACK_MODEL_BY_TYPE[p.type] ?? 'auto'
}

function isExcluded(p: ResolvedProvider): boolean {
  const cfg = (p.config ?? {}) as Record<string, unknown>
  return cfg.aig_auto_excluded === true
}

export { getDefaultModel as getProviderDefaultModel, isExcluded as isAigAutoExcluded }

export function pickCandidates(snapshot: ConfigSnapshot | null): ProviderCandidate[] {
  if (!snapshot) return []
  const out: ProviderCandidate[] = []
  for (const p of snapshot.providers) {
    if (!p.isActive) continue
    if (isExcluded(p)) continue
    // kiro / gemini pool accounts themselves; for others require at least one active key
    if (p.type !== 'kiro' && p.type !== 'gemini') {
      const hasKey = p.keys.some((k) => k.status === 'active')
      if (!hasKey) continue
    }
    out.push({
      id: p.id,
      slug: p.slug,
      type: p.type,
      defaultModel: getDefaultModel(p),
    })
  }
  return out
}

export interface AutoRouterOptions {
  redis?: CursorRedis | null
  tenantSlug: string
  maxRetries?: number
}

export class AutoRouter {
  private memCursor = 0

  constructor(private opts: AutoRouterOptions) {}

  private async nextCursor(modulus: number): Promise<number> {
    if (modulus <= 0) return 0
    if (this.opts.redis) {
      try {
        const key = `aig:cursor:${this.opts.tenantSlug}`
        const v = await this.opts.redis.incr(key)
        // bound key TTL to prevent unbounded growth (refresh on each incr)
        await this.opts.redis.expire(key, 24 * 3600)
        return (v - 1) % modulus
      } catch {
        // fall through to in-memory
      }
    }
    const v = this.memCursor++
    return v % modulus
  }

  /** Iterate items in RR order starting at cursor. Generic over T so callers
   * can reuse the cursor for any candidate shape (chat-completions providers,
   * /v1/messages passthrough providers, etc). */
  async order<T>(items: T[]): Promise<T[]> {
    if (items.length === 0) return []
    const start = await this.nextCursor(items.length)
    const out: T[] = []
    for (let i = 0; i < items.length; i++) {
      out.push(items[(start + i) % items.length])
    }
    return out
  }
}

function getStatus(err: unknown): number | undefined {
  if (typeof err === 'object' && err !== null && 'status' in err) {
    const s = (err as { status: unknown }).status
    if (typeof s === 'number') return s
  }
  if (typeof err === 'object' && err !== null && 'statusCode' in err) {
    const s = (err as { statusCode: unknown }).statusCode
    if (typeof s === 'number') return s
  }
  if (typeof err === 'object' && err !== null && 'response' in err) {
    const s = (err as { response?: { status?: unknown } }).response?.status
    if (typeof s === 'number') return s
  }
  if (typeof err === 'object' && err !== null && 'lastError' in err) {
    const s = getStatus((err as { lastError?: unknown }).lastError)
    if (s !== undefined) return s
  }
  if (typeof err === 'object' && err !== null && 'cause' in err) {
    const s = getStatus((err as { cause?: unknown }).cause)
    if (s !== undefined) return s
  }
  // parse from "Provider error 429: ..." style messages
  const msg = (err as { message?: string })?.message
  if (typeof msg === 'string') {
    const m = msg.match(/\b(4\d\d|5\d\d)\b/)
    if (m) return parseInt(m[1], 10)
  }
  return undefined
}

function isRetryable(err: unknown): boolean {
  // Upstream errors should not be retried - provider is dead
  if (isUpstreamError(err)) return false

  const s = getStatus(err)
  if (s === undefined) return true // network / timeout — retry
  return RETRYABLE_STATUS.has(s)
}

export interface AutoRunResult {
  provider: ProviderCandidate
  modelUsed: string
  attempts: Array<{ provider: string; error?: string; status?: number; isDead?: boolean }>
  deadProviders?: string[] // providers that hit upstream errors
}

export class AutoRunError extends Error {
  constructor(
    public attempts: Array<{ provider: string; error: string; status?: number; isDead?: boolean }>,
  ) {
    super(
      `aig-auto: all ${attempts.length} provider(s) failed: ` +
        attempts.map((a) => `${a.provider}=${a.status ?? '?'}`).join(', '),
    )
  }
}

interface ChatRunResult {
  result: ChatResponse
  meta: AutoRunResult
}

export async function runAutoChat(
  req: ChatRequest,
  candidates: ProviderCandidate[],
  buildProvider: (slug: string) => Provider,
  router: AutoRouter,
  maxRetries = 3,
): Promise<ChatRunResult> {
  const ordered = await router.order(candidates)
  const limit = Math.min(maxRetries, ordered.length)
  const attempts: Array<{ provider: string; error: string; status?: number; isDead?: boolean }> = []
  const deadProviders: string[] = []

  for (let i = 0; i < limit; i++) {
    const cand = ordered[i]
    try {
      const provider = buildProvider(cand.slug)
      const req2: ChatRequest = { ...req, model: cand.defaultModel }
      const result = await provider.chat(req2)
      return {
        result,
        meta: {
          provider: cand,
          modelUsed: cand.defaultModel,
          attempts: attempts.map((a) => ({
            provider: a.provider,
            error: a.error,
            status: a.status,
            isDead: a.isDead,
          })),
          deadProviders: deadProviders.length > 0 ? deadProviders : undefined,
        },
      }
    } catch (err) {
      const status = getStatus(err)
      const msg = (err as Error).message ?? String(err)
      const isDead = isUpstreamError(err)

      if (isDead) {
        deadProviders.push(cand.slug)
      }

      attempts.push({ provider: cand.slug, error: msg.slice(0, 300), status, isDead })
      if (!isRetryable(err) && !isDead) {
        throw err
      }
      continue
    }
  }

  throw new AutoRunError(attempts)
}

export async function runAutoChatStream(
  req: ChatRequest,
  candidates: ProviderCandidate[],
  buildProvider: (slug: string) => Provider,
  router: AutoRouter,
  maxRetries = 3,
): Promise<{ stream: AsyncIterable<string>; meta: AutoRunResult }> {
  const ordered = await router.order(candidates)
  const limit = Math.min(maxRetries, ordered.length)
  const attempts: Array<{ provider: string; error: string; status?: number; isDead?: boolean }> = []
  const deadProviders: string[] = []

  for (let i = 0; i < limit; i++) {
    const cand = ordered[i]
    try {
      const provider = buildProvider(cand.slug)
      const req2: ChatRequest = { ...req, model: cand.defaultModel }
      const stream = await provider.chatStream(req2)
      return {
        stream,
        meta: {
          provider: cand,
          modelUsed: cand.defaultModel,
          attempts: attempts.map((a) => ({
            provider: a.provider,
            error: a.error,
            status: a.status,
            isDead: a.isDead,
          })),
          deadProviders: deadProviders.length > 0 ? deadProviders : undefined,
        },
      }
    } catch (err) {
      const status = getStatus(err)
      const msg = (err as Error).message ?? String(err)
      const isDead = isUpstreamError(err)

      if (isDead) {
        deadProviders.push(cand.slug)
      }

      attempts.push({ provider: cand.slug, error: msg.slice(0, 300), status, isDead })
      if (!isRetryable(err) && !isDead) throw err
      continue
    }
  }

  throw new AutoRunError(attempts)
}

/** Returns true when client is asking for aig-auto routing. */
export function isAutoModel(model: string | undefined): boolean {
  return model === AIG_AUTO_MODEL
}

/** Convenience: build candidates + run chat in one go. Throws AutoRunError on total failure. */
export async function autoChat(
  req: ChatRequest,
  snapshot: ConfigSnapshot | null,
  appConfig: AppConfig,
  ctx: ProviderContext,
  router: AutoRouter,
  maxRetries?: number,
): Promise<ChatRunResult> {
  const candidates = pickCandidates(snapshot)
  if (candidates.length === 0) {
    throw new Error('aig-auto: no eligible providers (none active or all excluded)')
  }
  return runAutoChat(
    req,
    candidates,
    (slug) => createProvider(slug, appConfig, ctx),
    router,
    maxRetries ?? appConfig.providers?.default ? 3 : 3,
  )
}

export async function autoChatStream(
  req: ChatRequest,
  snapshot: ConfigSnapshot | null,
  appConfig: AppConfig,
  ctx: ProviderContext,
  router: AutoRouter,
  maxRetries?: number,
): Promise<{ stream: AsyncIterable<string>; meta: AutoRunResult }> {
  const candidates = pickCandidates(snapshot)
  if (candidates.length === 0) {
    throw new Error('aig-auto: no eligible providers (none active or all excluded)')
  }
  return runAutoChatStream(
    req,
    candidates,
    (slug) => createProvider(slug, appConfig, ctx),
    router,
    maxRetries ?? 3,
  )
}
