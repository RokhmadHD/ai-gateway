import { eq, sql } from 'drizzle-orm'
import { getDb, schema } from '@ai-gateway/db'
import type { ConfigSnapshot } from '@ai-gateway/shared'
import type { MarkBadReason } from './keyPool.js'
import type { FastifyBaseLogger } from 'fastify'

/**
 * Bridge between in-memory KeyPool and the `provider_keys` table.
 * KeyPool only knows secrets; this maps secret → key UUID and writes async
 * status updates (success/failure counts, cooldown, last_used_at) back to PG.
 *
 * Fire-and-forget: never blocks the hot path. Errors are logged but never
 * surfaced — a logging failure must not break request handling.
 */
export interface KeyReporter {
  onOk(providerSlug: string, secret: string): void
  onBad(providerSlug: string, secret: string, reason: MarkBadReason, cooldownMs: number): void
  refresh(snapshot: ConfigSnapshot): void
}

type SecretIndex = Map<string, Map<string, string>>

export function buildSecretIndex(snapshot: ConfigSnapshot): SecretIndex {
  const idx: SecretIndex = new Map()
  for (const p of snapshot.providers) {
    const inner = new Map<string, string>()
    for (const k of p.keys) {
      inner.set(k.secret, k.id)
    }
    idx.set(p.slug, inner)
  }
  return idx
}

export class DbKeyReporter implements KeyReporter {
  private idx: SecretIndex = new Map()

  constructor(private log?: FastifyBaseLogger) {}

  refresh(snapshot: ConfigSnapshot): void {
    this.idx = buildSecretIndex(snapshot)
  }

  onOk(providerSlug: string, secret: string): void {
    const keyId = this.lookup(providerSlug, secret)
    if (!keyId) return
    void this.update(keyId, {
      successCount: sql`${schema.providerKeys.successCount} + 1`,
      lastUsedAt: new Date(),
      status: 'active',
      cooldownUntil: null,
    })
  }

  onBad(
    providerSlug: string,
    secret: string,
    _reason: MarkBadReason,
    cooldownMs: number,
  ): void {
    const keyId = this.lookup(providerSlug, secret)
    if (!keyId) return
    void this.update(keyId, {
      failureCount: sql`${schema.providerKeys.failureCount} + 1`,
      lastUsedAt: new Date(),
      cooldownUntil: new Date(Date.now() + cooldownMs),
      status: 'cooldown',
    })
  }

  private lookup(providerSlug: string, secret: string): string | undefined {
    return this.idx.get(providerSlug)?.get(secret)
  }

  private async update(keyId: string, patch: Record<string, unknown>): Promise<void> {
    try {
      await getDb()
        .update(schema.providerKeys)
        .set(patch)
        .where(eq(schema.providerKeys.id, keyId))
    } catch (err) {
      this.log?.warn({ err, keyId }, 'key reporter: db update failed')
    }
  }
}

/** No-op reporter for TOML mode (no DB to write back to). */
export const noopKeyReporter: KeyReporter = {
  onOk() {},
  onBad() {},
  refresh() {},
}
