import type { State, HealthEntry } from './state.js'
import type { KeyReporter } from './keyReporter.js'
import type { ResolvedProvider, RotationStrategy } from '@ai-gateway/shared'

const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000 // 5 min
const SHORT_COOLDOWN_MS = 30 * 1000 // 30s for 429
const MAX_ERROR_COUNT_BEFORE_LONG_COOLDOWN = 3
const LONG_COOLDOWN_MS = 60 * 60 * 1000 // 1h

export type MarkBadReason = 'auth' | 'rate_limit' | 'server' | 'network' | 'other'

interface KeyMeta {
  weight: number
  /** In-memory usage counter; resets on process restart but survives snapshot refresh. */
  uses: number
}

function obscureKey(key: string): string {
  if (key.length <= 8) return key
  return `${key.slice(0, 4)}…${key.slice(-4)}`
}

export class KeyPool {
  readonly id: string
  private keys: string[] = []
  private meta = new Map<string, KeyMeta>()
  private strategy: RotationStrategy = 'random'
  private rrIndex = 0
  private stickyKey: string | null = null
  private reporter?: KeyReporter

  constructor(id: string, keys: string[], private state: State, reporter?: KeyReporter) {
    if (keys.length === 0) throw new Error(`KeyPool ${id}: empty key list`)
    this.id = id
    this.reporter = reporter
    this.setKeys(keys)
  }

  /** Replace keys + per-key metadata from a fresh snapshot. Preserves in-memory `uses` counter. */
  refresh(provider: ResolvedProvider): void {
    const usable = provider.keys.filter(
      (k) => k.status !== 'disabled' && k.status !== 'revoked',
    )
    const seen = new Set<string>()
    for (const k of usable) {
      seen.add(k.secret)
      const existing = this.meta.get(k.secret)
      this.meta.set(k.secret, {
        weight: k.weight,
        uses: existing?.uses ?? 0,
      })
    }
    for (const k of [...this.meta.keys()]) {
      if (!seen.has(k)) {
        this.meta.delete(k)
        if (this.stickyKey === k) this.stickyKey = null
      }
    }
    this.keys = [...seen]
    this.strategy = provider.rotationStrategy
    if (this.rrIndex >= this.keys.length) this.rrIndex = 0
  }

  size(): number {
    return this.keys.length
  }

  /** Pick a healthy key according to the active rotation strategy. */
  pick(exclude: Set<string> = new Set()): string {
    const now = Date.now()
    const stateMap = this.state.getKeys()
    const healthy: string[] = []
    for (const k of this.keys) {
      if (exclude.has(k)) continue
      const h = stateMap[this.stateKey(k)]
      if (!h?.cooldownUntil || h.cooldownUntil <= now) healthy.push(k)
    }

    if (healthy.length === 0) {
      // All in cooldown — return oldest-cooldown candidate.
      const candidates = this.keys.filter((k) => !exclude.has(k))
      if (candidates.length === 0) {
        throw new Error(`KeyPool ${this.id}: all ${this.keys.length} keys exhausted`)
      }
      candidates.sort((a, b) => {
        const ha = stateMap[this.stateKey(a)]?.cooldownUntil ?? 0
        const hb = stateMap[this.stateKey(b)]?.cooldownUntil ?? 0
        return ha - hb
      })
      return candidates[0]!
    }

    let pick: string
    switch (this.strategy) {
      case 'round_robin': {
        pick = healthy[this.rrIndex % healthy.length]!
        this.rrIndex = (this.rrIndex + 1) % healthy.length
        break
      }
      case 'least_used': {
        pick = healthy.reduce((min, k) => {
          const mu = this.meta.get(min)?.uses ?? 0
          const ku = this.meta.get(k)?.uses ?? 0
          return ku < mu ? k : min
        }, healthy[0]!)
        break
      }
      case 'weighted': {
        const weights = healthy.map((k) => Math.max(1, this.meta.get(k)?.weight ?? 1))
        const total = weights.reduce((s, w) => s + w, 0)
        let r = Math.random() * total
        pick = healthy[0]!
        for (let i = 0; i < healthy.length; i++) {
          r -= weights[i]!
          if (r <= 0) {
            pick = healthy[i]!
            break
          }
        }
        break
      }
      case 'sticky': {
        if (this.stickyKey && healthy.includes(this.stickyKey)) {
          pick = this.stickyKey
        } else {
          pick = healthy[0]!
          this.stickyKey = pick
        }
        break
      }
      case 'random':
      default:
        pick = healthy[Math.floor(Math.random() * healthy.length)]!
    }

    const m = this.meta.get(pick)
    if (m) m.uses++
    return pick
  }

  markBad(key: string, reason: MarkBadReason): void {
    const stateMap = this.state.getKeys()
    const existing = stateMap[this.stateKey(key)]
    const errorCount = (existing?.errorCount ?? 0) + 1
    const cooldownMs = this.cooldownFor(reason, errorCount)
    const entry: HealthEntry = {
      errorCount,
      lastError: reason,
      cooldownUntil: Date.now() + cooldownMs,
    }
    this.state.updateKey(this.stateKey(key), entry)
    if (this.stickyKey === key) this.stickyKey = null
    this.reporter?.onBad(this.id, key, reason, cooldownMs)
  }

  markOk(key: string): void {
    const stateMap = this.state.getKeys()
    if (stateMap[this.stateKey(key)]) {
      this.state.updateKey(this.stateKey(key), null)
    }
    this.reporter?.onOk(this.id, key)
  }

  obscure(key: string): string {
    return obscureKey(key)
  }

  private setKeys(keys: string[]): void {
    this.keys = [...new Set(keys)]
    for (const k of this.keys) {
      if (!this.meta.has(k)) this.meta.set(k, { weight: 1, uses: 0 })
    }
  }

  private cooldownFor(reason: MarkBadReason, errorCount: number): number {
    if (reason === 'rate_limit') return SHORT_COOLDOWN_MS
    if (errorCount >= MAX_ERROR_COUNT_BEFORE_LONG_COOLDOWN) return LONG_COOLDOWN_MS
    return DEFAULT_COOLDOWN_MS
  }

  private stateKey(key: string): string {
    return `${this.id}|${key}`
  }
}
