import type { FastifyInstance } from 'fastify'
import { createProvider, type ProviderContext } from '../providers/index.js'
import type { AppConfig } from '../config/index.js'
import type { ChatRequest, ChatResponse } from '../providers/base.js'
import { logUsage } from '../metrics/usageLogger.js'
import { chatUsageWithEstimate } from '../metrics/tokenEstimator.js'
import type { ConfigSnapshot } from '@ai-gateway/shared'
import {
  AIG_AUTO_MODEL,
  AutoRouter,
  AutoRunError,
  isAutoModel,
  pickCandidates,
  runAutoChat,
  runAutoChatStream,
} from './autoRouter.js'

const chatBodySchema = {
  type: 'object',
  required: ['messages'],
  properties: {
    model: { type: 'string' },
    messages: {
      type: 'array',
      items: {
        type: 'object',
        required: ['role'],
        properties: {
          role: {
            type: 'string',
            enum: ['system', 'user', 'assistant', 'tool'],
          },
          content: {},
          name: { type: 'string' },
          tool_call_id: { type: 'string' },
          tool_calls: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                type: { type: 'string' },
                function: {
                  type: 'object',
                  properties: {
                    name: { type: 'string' },
                    arguments: { type: 'string' },
                  },
                },
              },
            },
          },
        },
      },
    },
    stream: { type: 'boolean' },
    temperature: { type: 'number' },
    max_tokens: { type: 'number' },
    provider: { type: 'string' },
    tools: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string' },
          function: {
            type: 'object',
            required: ['name'],
            properties: {
              name: { type: 'string' },
              description: { type: 'string' },
              parameters: { type: 'object', additionalProperties: true },
            },
          },
        },
      },
    },
    tool_choice: {},
  },
}

function findProviderIdBySlug(
  snap: ConfigSnapshot | null | undefined,
  slug: string,
): string | undefined {
  return snap?.providers.find((p) => p.slug === slug)?.id
}

export async function chatRoutes(fastify: FastifyInstance) {
  const config = fastify.config as AppConfig
  const ctx: ProviderContext = {
    state: fastify.pools.state,
    proxyPool: fastify.pools.proxyPool,
    log: fastify.log,
  }
  const tenantSlug = process.env.TENANT_SLUG ?? 'default'
  const router = new AutoRouter({
    redis: fastify.autoRouterRedis ?? null,
    tenantSlug,
  })

  fastify.post<{ Body: ChatRequest & { provider?: string } }>(
    '/v1/chat/completions',
    { schema: { body: chatBodySchema } },
    async (request, reply) => {
      const { provider: providerName, ...chatReq } = request.body
      const startedAt = Date.now()
      const modelRequested =
        typeof chatReq.model === 'string' ? chatReq.model : 'unknown'

      // ───── aig-auto routing ─────
      if (isAutoModel(chatReq.model)) {
        const snapshot = fastify.configRuntime?.snapshot() ?? null
        const candidates = pickCandidates(snapshot)
        if (candidates.length === 0) {
          if (request.apiKey) {
            logUsage(
              {
                tenantId: request.apiKey.tenantId,
                apiKeyId: request.apiKey.id,
                modelName: modelRequested,
                endpoint: '/v1/chat/completions',
                requestId: request.id,
                status: 'provider_error',
                httpStatus: 503,
                latencyMs: Date.now() - startedAt,
                errorCode: 'no_providers',
                errorMessage: 'aig-auto: no eligible providers',
                requestBody: request.body,
              },
              fastify.log,
            )
          }
          reply.code(503)
          return { error: { message: 'aig-auto: no eligible providers', code: 'no_providers' } }
        }
        if (chatReq.stream) {
          try {
            const { stream, meta } = await runAutoChatStream(
              chatReq,
              candidates,
              (slug) => createProvider(slug, config, ctx),
              router,
            )
            reply.raw.setHeader('Content-Type', 'text/event-stream')
            reply.raw.setHeader('Cache-Control', 'no-cache')
            reply.raw.setHeader('Connection', 'keep-alive')
            reply.raw.setHeader('X-AIG-Provider', meta.provider.slug)
            reply.raw.setHeader('X-AIG-Model', meta.modelUsed)
            if (meta.deadProviders && meta.deadProviders.length > 0) {
              reply.raw.setHeader('X-AIG-Dead-Providers', meta.deadProviders.join(','))
              fastify.log.warn({ deadProviders: meta.deadProviders }, 'Upstream errors detected - providers marked as dead')
            }
            reply.raw.flushHeaders()
            try {
              for await (const chunk of stream) reply.raw.write(chunk)
            } finally {
              reply.raw.end()
            }
            if (request.apiKey) {
              logUsage(
                {
                  tenantId: request.apiKey.tenantId,
                  apiKeyId: request.apiKey.id,
                  providerId: meta.provider.id,
                  providerSlug: meta.provider.slug,
                  modelName: meta.modelUsed,
                  endpoint: '/v1/chat/completions',
                  requestId: request.id,
                  status: 'success',
                  httpStatus: 200,
                  latencyMs: Date.now() - startedAt,
                  requestBody: request.body,
                  metadata: meta.deadProviders ? { deadProviders: meta.deadProviders } : undefined,
                },
                fastify.log,
              )
            }
            return reply
          } catch (err) {
            const e = err as AutoRunError & { status?: number; message?: string }
            const status =
              err instanceof AutoRunError ? 502 : (e.status ?? 500)
            if (request.apiKey) {
              logUsage(
                {
                  tenantId: request.apiKey.tenantId,
                  apiKeyId: request.apiKey.id,
                  modelName: modelRequested,
                  endpoint: '/v1/chat/completions',
                  requestId: request.id,
                  status: status === 429 ? 'rate_limited' : 'provider_error',
                  httpStatus: status,
                  latencyMs: Date.now() - startedAt,
                  errorMessage: (e.message ?? String(err)).slice(0, 500),
                  requestBody: request.body,
                  responseBody:
                    err instanceof AutoRunError
                      ? { aig_auto_attempts: err.attempts }
                      : undefined,
                  metadata:
                    err instanceof AutoRunError
                      ? { deadProviders: err.attempts.filter((a) => a.isDead).map((a) => a.provider) }
                      : undefined,
                },
                fastify.log,
              )
            }
            if (err instanceof AutoRunError) {
              const deadProviders = err.attempts.filter(a => a.isDead).map(a => a.provider)
              if (deadProviders.length > 0) {
                reply.header('X-AIG-Dead-Providers', deadProviders.join(','))
                fastify.log.warn({ deadProviders }, 'All providers failed - some marked as dead due to upstream errors')
              }
              reply.code(502)
              return { error: { message: err.message, attempts: err.attempts } }
            }
            throw err
          }
        }
        try {
          const { result, meta } = await runAutoChat(
            chatReq,
            candidates,
            (slug) => createProvider(slug, config, ctx),
            router,
          )
          reply.header('X-AIG-Provider', meta.provider.slug)
          reply.header('X-AIG-Model', meta.modelUsed)
          if (meta.deadProviders && meta.deadProviders.length > 0) {
            reply.header('X-AIG-Dead-Providers', meta.deadProviders.join(','))
            fastify.log.warn({ deadProviders: meta.deadProviders }, 'Upstream errors detected - providers marked as dead')
          }
          if (request.apiKey) {
            const u = chatUsageWithEstimate(chatReq, result)
            logUsage(
              {
                tenantId: request.apiKey.tenantId,
                apiKeyId: request.apiKey.id,
                providerId: meta.provider.id,
                providerSlug: meta.provider.slug,
                modelName: meta.modelUsed,
                endpoint: '/v1/chat/completions',
                requestId: request.id,
                status: 'success',
                httpStatus: 200,
                latencyMs: Date.now() - startedAt,
                promptTokens: u.promptTokens,
                completionTokens: u.completionTokens,
                requestBody: request.body,
                responseBody: result,
                metadata: {
                  ...(meta.deadProviders ? { deadProviders: meta.deadProviders } : {}),
                  ...(u.estimated ? { usageEstimated: true } : {}),
                },
              },
              fastify.log,
            )
          }
          return result
        } catch (err) {
          const e = err as AutoRunError & { status?: number; message?: string }
          const status =
            err instanceof AutoRunError ? 502 : (e.status ?? 500)
          if (request.apiKey) {
            logUsage(
              {
                tenantId: request.apiKey.tenantId,
                apiKeyId: request.apiKey.id,
                modelName: modelRequested,
                endpoint: '/v1/chat/completions',
                requestId: request.id,
                status: status === 429 ? 'rate_limited' : 'provider_error',
                httpStatus: status,
                latencyMs: Date.now() - startedAt,
                errorMessage: (e.message ?? String(err)).slice(0, 500),
                requestBody: request.body,
                responseBody:
                  err instanceof AutoRunError
                    ? { aig_auto_attempts: err.attempts }
                    : undefined,
                metadata:
                  err instanceof AutoRunError
                    ? { deadProviders: err.attempts.filter((a) => a.isDead).map((a) => a.provider) }
                    : undefined,
              },
              fastify.log,
            )
          }
          if (err instanceof AutoRunError) {
            const deadProviders = err.attempts.filter(a => a.isDead).map(a => a.provider)
            if (deadProviders.length > 0) {
              reply.header('X-AIG-Dead-Providers', deadProviders.join(','))
              fastify.log.warn({ deadProviders }, 'All providers failed - some marked as dead due to upstream errors')
            }
            reply.code(502)
            return { error: { message: err.message, attempts: err.attempts } }
          }
          throw err
        }
      }

      // ───── normal routing ─────
      const name = providerName ?? config.providers.default
      const provider = createProvider(name, config, ctx)
      const snap = fastify.configRuntime?.snapshot()
      const providerId = findProviderIdBySlug(snap, name)

      if (chatReq.stream) {
        reply.raw.setHeader('Content-Type', 'text/event-stream')
        reply.raw.setHeader('Cache-Control', 'no-cache')
        reply.raw.setHeader('Connection', 'keep-alive')
        reply.raw.flushHeaders()
        try {
          const stream = await provider.chatStream(chatReq)
          for await (const chunk of stream) reply.raw.write(chunk)
        } catch (err) {
          const e = err as { status?: number; message?: string }
          const status = e.status ?? 500
          if (request.apiKey) {
            logUsage(
              {
                tenantId: request.apiKey.tenantId,
                apiKeyId: request.apiKey.id,
                providerId,
                providerSlug: name,
                modelName: modelRequested,
                endpoint: '/v1/chat/completions',
                requestId: request.id,
                status: status === 429 ? 'rate_limited' : 'provider_error',
                httpStatus: status,
                latencyMs: Date.now() - startedAt,
                errorMessage: e.message?.slice(0, 500),
                requestBody: request.body,
              },
              fastify.log,
            )
          }
          throw err
        } finally {
          reply.raw.end()
        }
        if (request.apiKey) {
          logUsage(
            {
              tenantId: request.apiKey.tenantId,
              apiKeyId: request.apiKey.id,
              providerId,
              providerSlug: name,
              modelName: modelRequested,
              endpoint: '/v1/chat/completions',
              requestId: request.id,
              status: 'success',
              httpStatus: 200,
              latencyMs: Date.now() - startedAt,
              requestBody: request.body,
            },
            fastify.log,
          )
        }
        return reply
      }

      try {
        const result = await provider.chat(chatReq)
        if (request.apiKey) {
          const u = chatUsageWithEstimate(chatReq, result)
          logUsage(
            {
              tenantId: request.apiKey.tenantId,
              apiKeyId: request.apiKey.id,
              providerId,
              providerSlug: name,
              modelName: modelRequested,
              endpoint: '/v1/chat/completions',
              requestId: request.id,
              status: 'success',
              httpStatus: 200,
              latencyMs: Date.now() - startedAt,
              promptTokens: u.promptTokens,
              completionTokens: u.completionTokens,
              requestBody: request.body,
              responseBody: result,
              metadata: u.estimated ? { usageEstimated: true } : undefined,
            },
            fastify.log,
          )
        }
        return result
      } catch (err) {
        const e = err as { status?: number; message?: string }
        const status = e.status ?? 500
        if (request.apiKey) {
          logUsage(
            {
              tenantId: request.apiKey.tenantId,
              apiKeyId: request.apiKey.id,
              providerId,
              providerSlug: name,
              modelName: modelRequested,
              endpoint: '/v1/chat/completions',
              requestId: request.id,
              status: status === 429 ? 'rate_limited' : 'provider_error',
              httpStatus: status,
              latencyMs: Date.now() - startedAt,
              errorMessage: e.message?.slice(0, 500),
              requestBody: request.body,
            },
            fastify.log,
          )
        }
        throw err
      }
    },
  )

  fastify.log.info({ autoModel: AIG_AUTO_MODEL }, 'chat routes registered')
}
