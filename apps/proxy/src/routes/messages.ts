import type { FastifyInstance } from 'fastify'
import type { ConfigSnapshot, ResolvedProvider } from '@ai-gateway/shared'
import type { AppConfig, CustomProviderConfig } from '../config/index.js'
import { getApiKeys } from '../config/index.js'
import { KeyPool } from '../pools/keyPool.js'
import { AnthropicPassthroughProvider } from '../providers/anthropic-passthrough.js'
import {
  logUsage,
  parseNonStreamUsage,
  AnthropicStreamUsageParser,
  refreshSecretIndex,
} from '../metrics/usageLogger.js'
import {
  AIG_AUTO_MODEL,
  AutoRouter,
  getProviderDefaultModel,
  isAigAutoExcluded,
  isAutoModel,
} from './autoRouter.js'

function findPassthroughTarget(config: AppConfig): { name: string; cfg: CustomProviderConfig } | undefined {
  const explicit = config.passthrough?.target
  const customs = config.providers.custom ?? {}
  if (explicit && customs[explicit]) {
    return { name: explicit, cfg: customs[explicit] }
  }
  for (const [name, cfg] of Object.entries(customs)) {
    if (cfg.endpoint_type === 'anthropic') return { name, cfg }
  }
  return undefined
}

function findResolvedProvider(snap: ConfigSnapshot, slug: string): ResolvedProvider | undefined {
  return snap.providers.find((p) => p.slug === slug && p.isActive)
}

const ANTHROPIC_NATIVE_TYPES = new Set<string>([
  'anthropic',
  'anthropic_passthrough',
  'custom_anthropic',
])

interface AigAutoEntry {
  slug: string
  providerId: string
  defaultModel: string
  provider: AnthropicPassthroughProvider
}

// Beta/extension fields some upstreams (e.g. freemodel) reject with 400.
// Stripped from the request body before forwarding via aig-auto so a single
// unsupported feature doesn't blow up every candidate.
const AIG_AUTO_STRIP_FIELDS = ['thinking', 'effort', 'output_config'] as const

function sanitizeAigAutoBody(body: Record<string, unknown>, model: string): Record<string, unknown> {
  const out: Record<string, unknown> = { ...body, model }
  for (const f of AIG_AUTO_STRIP_FIELDS) delete out[f]
  return out
}

function providerProxyEnabled(config: Record<string, unknown>): boolean {
  const proxy = config.proxy as { enabled?: unknown; allow_api_key_leak?: unknown } | undefined
  return proxy?.enabled === true && proxy.allow_api_key_leak === true
}

export async function messagesRoutes(fastify: FastifyInstance) {
  const config = fastify.config as AppConfig
  const target = findPassthroughTarget(config)

  if (!target) {
    fastify.log.warn('passthrough: no anthropic custom provider configured; /v1/messages disabled')
    return
  }

  const keys = getApiKeys(target.cfg)
  if (keys.length === 0) {
    fastify.log.warn({ target: target.name }, 'passthrough: target has no api keys; /v1/messages disabled')
    return
  }
  if (!target.cfg.base_url) {
    fastify.log.warn({ target: target.name }, 'passthrough: target has no base_url; /v1/messages disabled')
    return
  }
  const baseUrl = target.cfg.base_url

  const keyPool = new KeyPool(target.name, keys, fastify.pools.state, fastify.keyReporter)
  const dbProxyPool = fastify.pools.proxyPool
  let providerId: string | undefined

  // Seed strategy + per-key weight + providerId from initial snapshot.
  const initialSnap = fastify.configRuntime?.snapshot()
  if (initialSnap) {
    refreshSecretIndex(initialSnap)
    const resolved = findResolvedProvider(initialSnap, target.name)
    if (resolved) {
      keyPool.refresh(resolved)
      providerId = resolved.id
    }
  }

  // ───── aig-auto pool: separate KeyPools keyed by slug, rebuilt on snapshot updates ─────
  const aigAutoKeyPools = new Map<string, KeyPool>()
  let aigAutoEntries: AigAutoEntry[] = []

  function rebuildAigAutoPool(snap: ConfigSnapshot) {
    const next: AigAutoEntry[] = []
    const seen = new Set<string>()
    for (const p of snap.providers) {
      if (!p.isActive) continue
      if (!ANTHROPIC_NATIVE_TYPES.has(p.type)) continue
      if (isAigAutoExcluded(p)) continue
      if (!p.baseUrl) continue
      const secrets = p.keys.filter((k) => k.status === 'active').map((k) => k.secret)
      if (secrets.length === 0) continue

      let kp = aigAutoKeyPools.get(p.slug)
      if (!kp) {
        kp = new KeyPool(p.slug, secrets, fastify.pools.state, fastify.keyReporter)
        aigAutoKeyPools.set(p.slug, kp)
      }
      kp.refresh(p)

      const provider = new AnthropicPassthroughProvider(
        kp,
        p.baseUrl,
        providerProxyEnabled(p.config) ? dbProxyPool : undefined,
        {
          maxRetries: Math.max(p.maxRetries ?? 3, secrets.length),
          log: fastify.log,
        },
      )
      next.push({
        slug: p.slug,
        providerId: p.id,
        defaultModel: getProviderDefaultModel(p),
        provider,
      })
      seen.add(p.slug)
    }
    // drop key pools for providers that disappeared
    for (const slug of Array.from(aigAutoKeyPools.keys())) {
      if (!seen.has(slug)) aigAutoKeyPools.delete(slug)
    }
    aigAutoEntries = next
  }

  if (initialSnap) rebuildAigAutoPool(initialSnap)

  // Hot-reload: re-apply provider + key changes on every snapshot update.
  fastify.configRuntime?.on('update', (snap: ConfigSnapshot) => {
    refreshSecretIndex(snap)
    const resolved = findResolvedProvider(snap, target.name)
    if (!resolved) {
      fastify.log.warn({ target: target.name }, 'passthrough: provider removed/inactive in snapshot')
    } else {
      keyPool.refresh(resolved)
      providerId = resolved.id
      fastify.log.info(
        { target: target.name, strategy: resolved.rotationStrategy, keys: keyPool.size() },
        'passthrough: keyPool refreshed',
      )
    }
    rebuildAigAutoPool(snap)
    fastify.log.info(
      { candidates: aigAutoEntries.map((e) => e.slug) },
      'passthrough: aig-auto pool refreshed',
    )
  })

  const proxyPool = target.cfg.proxy?.enabled ? fastify.pools.proxyPool : undefined
  const provider = new AnthropicPassthroughProvider(
    keyPool,
    baseUrl,
    proxyPool,
    {
      maxRetries: target.cfg.rotation?.max_retries ?? 3,
      log: fastify.log,
    },
  )

  const tenantSlug = process.env.TENANT_SLUG ?? 'default'
  const router = new AutoRouter({
    redis: fastify.autoRouterRedis ?? null,
    tenantSlug,
  })

  fastify.log.info(
    { target: target.name, keys: keys.length, proxy: !!proxyPool },
    'passthrough: /v1/messages enabled',
  )

  fastify.post<{ Body: Record<string, unknown> }>(
    '/v1/messages',
    {
      schema: { body: { type: 'object', additionalProperties: true } },
    },
    async (request, reply) => {
      const body = request.body
      const wantsStream = body?.stream === true
      const modelName = typeof body?.model === 'string' ? body.model : 'unknown'
      const startedAt = Date.now()

      // ═════════ aig-auto branch ═════════
      if (isAutoModel(modelName)) {
        if (aigAutoEntries.length === 0) {
          reply.code(503).send({
            error: { message: 'aig-auto: no eligible /v1/messages providers', code: 'no_providers' },
          })
          return reply
        }

        const ordered = await router.order(aigAutoEntries)
        const limit = Math.min(3, ordered.length)
        const attempts: Array<{ slug: string; status?: number; error: string }> = []

        for (let i = 0; i < limit; i++) {
          const cand = ordered[i]
          const reqBody = sanitizeAigAutoBody(body, cand.defaultModel)

          if (wantsStream) {
            try {
              const { body: stream, headers, key, startedAt: providerStart } =
                await cand.provider.sendStream(reqBody)
              reply.raw.statusCode = 200
              reply.raw.setHeader(
                'Content-Type',
                headers['Content-Type'] ?? 'text/event-stream',
              )
              reply.raw.setHeader('Cache-Control', 'no-cache')
              reply.raw.setHeader('Connection', 'keep-alive')
              reply.raw.setHeader('X-AIG-Provider', cand.slug)
              reply.raw.setHeader('X-AIG-Model', cand.defaultModel)
              reply.raw.flushHeaders()
              const parser = new AnthropicStreamUsageParser(providerStart)
              try {
                for await (const chunk of stream) {
                  parser.feed(chunk)
                  reply.raw.write(chunk)
                }
              } finally {
                reply.raw.end()
              }
              const u = parser.result()
              if (request.apiKey) {
                logUsage(
                  {
                    tenantId: request.apiKey.tenantId,
                    apiKeyId: request.apiKey.id,
                    providerId: cand.providerId,
                    providerSlug: cand.slug,
                    providerSecret: key,
                    modelName: cand.defaultModel,
                    endpoint: '/v1/messages',
                    requestId: request.id,
                    status: 'success',
                    httpStatus: 200,
                    latencyMs: Date.now() - startedAt,
                    firstTokenLatencyMs: u.firstTokenLatencyMs,
                    promptTokens: u.promptTokens,
                    completionTokens: u.completionTokens,
                    cachedTokens: u.cachedTokens,
                    requestBody: body,
                  },
                  fastify.log,
                )
              }
              return reply
            } catch (err) {
              const status = getErrorStatus(err)
              attempts.push({
                slug: cand.slug,
                status,
                error: getErrorMessage(err).slice(0, 300),
              })
              if (reply.raw.headersSent) {
                // headers already flushed for this candidate — can't retry on another provider
                reply.raw.end()
                return reply
              }
              if (!isRetryableStatus(status)) break
              continue
            }
          } else {
            try {
              const { data, key, latencyMs } = await cand.provider.send(reqBody)
              const u = parseNonStreamUsage(data)
              reply.header('X-AIG-Provider', cand.slug)
              reply.header('X-AIG-Model', cand.defaultModel)
              if (request.apiKey) {
                logUsage(
                  {
                    tenantId: request.apiKey.tenantId,
                    apiKeyId: request.apiKey.id,
                    providerId: cand.providerId,
                    providerSlug: cand.slug,
                    providerSecret: key,
                    modelName: u.modelName ?? cand.defaultModel,
                    endpoint: '/v1/messages',
                    requestId: request.id,
                    status: 'success',
                    httpStatus: 200,
                    latencyMs,
                    promptTokens: u.promptTokens,
                    completionTokens: u.completionTokens,
                    cachedTokens: u.cachedTokens,
                    requestBody: body,
                    responseBody: data,
                  },
                  fastify.log,
                )
              }
              return data
            } catch (err) {
              const status = getErrorStatus(err)
              attempts.push({
                slug: cand.slug,
                status,
                error: getErrorMessage(err).slice(0, 300),
              })
              if (!isRetryableStatus(status)) break
              continue
            }
          }
        }

        // All candidates failed — log + 502
        const last = attempts[attempts.length - 1]
        const httpStatus = last?.status ?? 502
        if (request.apiKey) {
          logUsage(
            {
              tenantId: request.apiKey.tenantId,
              apiKeyId: request.apiKey.id,
              providerSlug: AIG_AUTO_MODEL,
              modelName: AIG_AUTO_MODEL,
              endpoint: '/v1/messages',
              requestId: request.id,
              status: httpStatus === 429 ? 'rate_limited' : 'provider_error',
              httpStatus,
              latencyMs: Date.now() - startedAt,
              errorMessage: `aig-auto: ${attempts.map((a) => `${a.slug}=${a.status ?? '?'}`).join(', ')}`.slice(
                0,
                500,
              ),
              requestBody: body,
              responseBody: { aig_auto_attempts: attempts },
            },
            fastify.log,
          )
        }
        reply.code(502).send({
          error: {
            message: `aig-auto: all ${attempts.length} provider(s) failed`,
            attempts,
          },
        })
        return reply
      }

      // ═════════ single-target passthrough (existing behavior) ═════════
      if (wantsStream) {
        try {
          const { body: stream, headers, key, startedAt: providerStart } = await provider.sendStream(body)
          reply.raw.statusCode = 200
          reply.raw.setHeader('Content-Type', headers['Content-Type'] ?? 'text/event-stream')
          reply.raw.setHeader('Cache-Control', 'no-cache')
          reply.raw.setHeader('Connection', 'keep-alive')
          reply.raw.flushHeaders()
          const parser = new AnthropicStreamUsageParser(providerStart)
          try {
            for await (const chunk of stream) {
              parser.feed(chunk)
              reply.raw.write(chunk)
            }
          } finally {
            reply.raw.end()
          }
          const u = parser.result()
          if (request.apiKey) {
            logUsage(
              {
                tenantId: request.apiKey.tenantId,
                apiKeyId: request.apiKey.id,
                providerId,
                providerSlug: target.name,
                providerSecret: key,
                modelName,
                endpoint: '/v1/messages',
                requestId: request.id,
                status: 'success',
                httpStatus: 200,
                latencyMs: Date.now() - startedAt,
                firstTokenLatencyMs: u.firstTokenLatencyMs,
                promptTokens: u.promptTokens,
                completionTokens: u.completionTokens,
                cachedTokens: u.cachedTokens,
                requestBody: body,
              },
              fastify.log,
            )
          }
          return reply
        } catch (err) {
          const status = getErrorStatus(err) ?? 500
          const message = getErrorMessage(err)
          if (request.apiKey) {
            logUsage(
              {
                tenantId: request.apiKey.tenantId,
                apiKeyId: request.apiKey.id,
                providerId,
                providerSlug: target.name,
                modelName,
                endpoint: '/v1/messages',
                requestId: request.id,
                status: status === 429 ? 'rate_limited' : 'provider_error',
                httpStatus: status,
                latencyMs: Date.now() - startedAt,
                errorMessage: message.slice(0, 500),
                requestBody: body,
              },
              fastify.log,
            )
          }
          reply.code(status).send({ error: { message, type: 'proxy_error' } })
          return reply
        }
      }

      try {
        const { data, key, latencyMs } = await provider.send(body)
        const u = parseNonStreamUsage(data)
        if (request.apiKey) {
          logUsage(
            {
              tenantId: request.apiKey.tenantId,
              apiKeyId: request.apiKey.id,
              providerId,
              providerSlug: target.name,
              providerSecret: key,
              modelName: u.modelName ?? modelName,
              endpoint: '/v1/messages',
              requestId: request.id,
              status: 'success',
              httpStatus: 200,
              latencyMs,
              promptTokens: u.promptTokens,
              completionTokens: u.completionTokens,
              cachedTokens: u.cachedTokens,
              requestBody: body,
              responseBody: data,
            },
            fastify.log,
          )
        }
        return data
      } catch (err) {
        const status = getErrorStatus(err) ?? 500
        const message = getErrorMessage(err)
        if (request.apiKey) {
          logUsage(
            {
              tenantId: request.apiKey.tenantId,
              apiKeyId: request.apiKey.id,
              providerId,
              providerSlug: target.name,
              modelName,
              endpoint: '/v1/messages',
              requestId: request.id,
              status: status === 429 ? 'rate_limited' : 'provider_error',
              httpStatus: status,
              latencyMs: Date.now() - startedAt,
              errorMessage: message.slice(0, 500),
              requestBody: body,
            },
            fastify.log,
          )
        }
        reply.code(status).send({ error: { message, type: 'proxy_error' } })
        return reply
      }
    },
  )
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504])

function isRetryableStatus(status: number | undefined): boolean {
  if (status === undefined) return true // network / timeout / unknown — retry
  return RETRYABLE_STATUS.has(status)
}

function getErrorStatus(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined
  const e = err as {
    status?: unknown
    statusCode?: unknown
    response?: { status?: unknown }
    lastError?: unknown
    cause?: unknown
  }
  if (typeof e.status === 'number') return e.status
  if (typeof e.statusCode === 'number') return e.statusCode
  if (typeof e.response?.status === 'number') return e.response.status
  const lastErrorStatus = getErrorStatus(e.lastError)
  if (lastErrorStatus !== undefined) return lastErrorStatus
  return getErrorStatus(e.cause)
}

function getErrorMessage(err: unknown): string {
  if (typeof err === 'object' && err !== null) {
    const e = err as { message?: unknown; lastError?: unknown; cause?: unknown }
    const nested = getErrorMessage(e.lastError ?? e.cause)
    if (nested !== 'upstream failure') return nested
    if (typeof e.message === 'string' && e.message) return e.message
  }
  return typeof err === 'string' && err ? err : 'upstream failure'
}
