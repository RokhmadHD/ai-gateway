import { readdirSync, readFileSync, writeFileSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fetch, type Dispatcher } from 'undici'
import type { ProxyPool } from '../pools/proxyPool.js'
import type { MinimalLogger } from '../pools/scraper.js'
import {
  GEMINI_OAUTH_CLIENT_ID,
  GEMINI_OAUTH_CLIENT_SECRET,
} from './gemini.js'

const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const OAUTH_ORIGIN = new URL(OAUTH_TOKEN_URL).origin
// Wider than lazy REFRESH_LEEWAY_MS (60s in gemini.ts) so background catches
// tokens before the request-time path has to wait on a refresh round-trip.
const BACKGROUND_LEEWAY_MS = 10 * 60_000
const DEFAULT_TICK_MS = 5 * 60_000

interface TokenFile {
  access_token: string
  refresh_token: string
  scope?: string
  token_type?: string
  id_token?: string
  expiry_date: number
  cloudaicompanion_project?: string
  label?: string
  email?: string
  added_at?: string
  _chainDead?: boolean
  _chainDeadAt?: string
  _chainDeadReason?: string
}

export interface GeminiRefresherOptions {
  accountDir: string
  log: MinimalLogger
  proxyPool?: ProxyPool
  tickMs?: number
  leewayMs?: number
}

export class GeminiBackgroundRefresher {
  private timer?: NodeJS.Timeout
  private running = false
  private tickMs: number
  private leewayMs: number

  constructor(private opts: GeminiRefresherOptions) {
    this.tickMs = opts.tickMs ?? DEFAULT_TICK_MS
    this.leewayMs = opts.leewayMs ?? BACKGROUND_LEEWAY_MS
  }

  start(): void {
    if (this.timer) return
    setTimeout(() => void this.tick(), 5_000).unref()
    this.timer = setInterval(() => void this.tick(), this.tickMs)
    this.timer.unref()
    this.opts.log.info(
      { dir: this.opts.accountDir, tickMs: this.tickMs, leewayMs: this.leewayMs },
      'gemini-refresher: started',
    )
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  private async tick(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      if (!existsSync(this.opts.accountDir)) return
      const files: string[] = []
      for (const entry of readdirSync(this.opts.accountDir)) {
        const p = join(this.opts.accountDir, entry)
        try {
          const s = statSync(p)
          if (s.isFile() && entry.endsWith('.json')) {
            files.push(p)
          } else if (s.isDirectory()) {
            for (const sub of readdirSync(p)) {
              if (!sub.endsWith('.json')) continue
              const subPath = join(p, sub)
              try {
                if (statSync(subPath).isFile()) files.push(subPath)
              } catch {}
            }
          }
        } catch {}
      }

      for (const path of files) {
        try {
          const raw = readFileSync(path, 'utf-8')
          const tok = JSON.parse(raw) as TokenFile
          if (tok._chainDead) continue
          if (!Number.isFinite(tok.expiry_date)) continue
          if (tok.expiry_date - Date.now() > this.leewayMs) continue
          await this.refreshOne(path, tok)
        } catch (err) {
          this.opts.log.warn({ err, path }, 'gemini-refresher: file refresh failed')
        }
      }
    } catch (err) {
      this.opts.log.warn({ err }, 'gemini-refresher: tick failed')
    } finally {
      this.running = false
    }
  }

  private async refreshOne(path: string, tok: TokenFile): Promise<void> {
    const dispatcher = this.pickDispatcher()
    const body = new URLSearchParams({
      client_id: GEMINI_OAUTH_CLIENT_ID,
      client_secret: GEMINI_OAUTH_CLIENT_SECRET,
      refresh_token: tok.refresh_token,
      grant_type: 'refresh_token',
    })
    const res = await fetch(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      dispatcher,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      // Google returns 400 invalid_grant when the refresh chain is rotated /
      // revoked. 401 also implies a dead chain. Mark file so request-time path
      // surfaces re-auth instead of hammering the endpoint.
      const isChainDead = res.status === 400 || res.status === 401
      if (isChainDead) {
        const dead: TokenFile = {
          ...tok,
          _chainDead: true,
          _chainDeadAt: new Date().toISOString(),
          _chainDeadReason: `refresh ${res.status}: ${text.slice(0, 200)}`,
        }
        try {
          writeFileSync(path, JSON.stringify(dead, null, 2), { mode: 0o600 })
        } catch {
          // ignore — next tick will retry
        }
        this.opts.log.warn(
          { path, status: res.status },
          'gemini-refresher: chain dead — account needs re-auth',
        )
        return
      }
      this.opts.log.warn(
        { path, status: res.status, body: text.slice(0, 200) },
        'gemini-refresher: refresh rejected by upstream',
      )
      return
    }
    const data = (await res.json()) as {
      access_token: string
      expires_in: number
      token_type: string
      scope?: string
      id_token?: string
      refresh_token?: string
    }
    const merged: TokenFile = {
      ...tok,
      access_token: data.access_token,
      refresh_token: data.refresh_token ?? tok.refresh_token,
      scope: data.scope ?? tok.scope,
      token_type: data.token_type ?? tok.token_type,
      id_token: data.id_token ?? tok.id_token,
      expiry_date: Date.now() + data.expires_in * 1000,
    }
    writeFileSync(path, JSON.stringify(merged, null, 2), { mode: 0o600 })
    this.opts.log.info(
      { path, expiryDate: merged.expiry_date, viaProxy: !!dispatcher },
      'gemini-refresher: token refreshed',
    )
  }

  private pickDispatcher(): Dispatcher | undefined {
    const pool = this.opts.proxyPool
    if (!pool || pool.isEmpty()) return undefined
    const proxy = pool.pick(OAUTH_ORIGIN)
    if (!proxy) return undefined
    try {
      return pool.getDispatcher(OAUTH_ORIGIN, proxy)
    } catch {
      return undefined
    }
  }
}
