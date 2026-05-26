import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { createHash } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { getDb, schema } from '@ai-gateway/db'

const { apiKeys } = schema

declare module 'fastify' {
  interface FastifyRequest {
    apiKey?: { id: string; tenantId: string }
  }
}

// Routes that bypass auth entirely (liveness + readiness probes).
const PUBLIC_PATHS = new Set(['/healthz', '/readyz'])

type CacheEntry = { id: string; tenantId: string; cachedAt: number }

const CACHE_TTL_MS = 60_000
const LAST_USED_THROTTLE_MS = 60_000

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}

function extractBearer(req: FastifyRequest): string | null {
  // Standard OpenAI-style header.
  const h = req.headers.authorization
  if (typeof h === 'string' && h.startsWith('Bearer ')) {
    const t = h.slice(7).trim()
    if (t) return t
  }
  // Anthropic-style header — @ai-sdk/anthropic, native Anthropic SDK, Claude Code CLI all use this.
  const xapi = req.headers['x-api-key']
  if (typeof xapi === 'string' && xapi.trim()) return xapi.trim()
  return null
}

function reject(reply: FastifyReply, code: number, message: string) {
  reply.code(code).send({ error: { message, type: 'auth_error' } })
}

export function registerApiKeyAuth(fastify: FastifyInstance) {
  if (process.env.PROXY_AUTH_REQUIRED === 'false') {
    fastify.log.warn('PROXY_AUTH_REQUIRED=false — apiKey auth bypassed (dev only)')
    return
  }

  const cache = new Map<string, CacheEntry>()
  const lastUsedFlushed = new Map<string, number>()

  fastify.addHook('onRequest', async (req, reply) => {
    if (PUBLIC_PATHS.has(req.url.split('?')[0]!)) return

    const token = extractBearer(req)
    if (!token) {
      return reject(reply, 401, 'missing api key (Authorization: Bearer <token> or x-api-key: <token>)')
    }
    const hash = sha256(token)

    const now = Date.now()
    const cached = cache.get(hash)
    let entry: CacheEntry | undefined =
      cached && now - cached.cachedAt < CACHE_TTL_MS ? cached : undefined

    if (!entry) {
      const db = getDb()
      const row = await db.query.apiKeys.findFirst({
        where: and(eq(apiKeys.keyHash, hash), eq(apiKeys.status, 'active')),
        columns: { id: true, tenantId: true, expiresAt: true },
      })
      if (!row) {
        cache.delete(hash)
        return reject(reply, 401, 'invalid or revoked api key')
      }
      if (row.expiresAt && row.expiresAt.getTime() < now) {
        return reject(reply, 401, 'api key expired')
      }
      entry = { id: row.id, tenantId: row.tenantId, cachedAt: now }
      cache.set(hash, entry)
    }

    // Expose to route handlers for usage logging.
    req.apiKey = { id: entry.id, tenantId: entry.tenantId }

    // Throttled lastUsedAt update — fire and forget.
    const lastFlush = lastUsedFlushed.get(entry.id) ?? 0
    if (now - lastFlush > LAST_USED_THROTTLE_MS) {
      lastUsedFlushed.set(entry.id, now)
      void getDb()
        .update(apiKeys)
        .set({ lastUsedAt: new Date(now) })
        .where(eq(apiKeys.id, entry.id))
        .catch((err) => fastify.log.warn({ err }, 'apiKeys lastUsedAt update failed'))
    }
  })
}
