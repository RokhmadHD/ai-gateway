import { readdirSync, readFileSync, writeFileSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fetch, type Dispatcher } from 'undici'
import type { ProxyPool } from '../pools/proxyPool.js'
import type { MinimalLogger } from '../pools/scraper.js'

const OAUTH_TOKEN_URL = 'https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken'
const OAUTH_ORIGIN = new URL(OAUTH_TOKEN_URL).origin
// Refresh proactively if token expires within this window — wider than lazy
// REFRESH_LEEWAY_MS (60s) so background catches them before request-time path.
const BACKGROUND_LEEWAY_MS = 10 * 60_000
const DEFAULT_TICK_MS = 5 * 60_000

interface TokenFile {
  accessToken: string
  refreshToken: string
  expiresAt: string
  profileArn: string
  authMethod?: string
  provider?: string
  addedAt?: string
  label?: string
  /** Set when /refreshToken returns 401 Bad credentials — refresh chain rotated
   *  by another process (kiro-cli local). Account needs device-flow re-auth. */
  _chainDead?: boolean
  _chainDeadAt?: string
  _chainDeadReason?: string
}

export interface KiroRefresherOptions {
  accountDir: string
  log: MinimalLogger
  proxyPool?: ProxyPool
  tickMs?: number
  leewayMs?: number
}

export class KiroBackgroundRefresher {
  private timer?: NodeJS.Timeout
  private running = false
  private tickMs: number
  private leewayMs: number

  constructor(private opts: KiroRefresherOptions) {
    this.tickMs = opts.tickMs ?? DEFAULT_TICK_MS
    this.leewayMs = opts.leewayMs ?? BACKGROUND_LEEWAY_MS
  }

  start(): void {
    if (this.timer) return
    // Run one tick shortly after boot so freshly-launched proxy heals expired tokens.
    setTimeout(() => void this.tick(), 5_000).unref()
    this.timer = setInterval(() => void this.tick(), this.tickMs)
    this.timer.unref()
    this.opts.log.info(
      { dir: this.opts.accountDir, tickMs: this.tickMs, leewayMs: this.leewayMs },
      'kiro-refresher: started',
    )
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  private async tick(): Promise<void> {
    if (this.running) return // skip if previous tick still going
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
          if (tok._chainDead) continue // skip dead chains — wait for re-auth
          const exp = Date.parse(tok.expiresAt)
          if (!Number.isFinite(exp)) continue
          if (exp - Date.now() > this.leewayMs) continue // still fresh enough
          await this.refreshOne(path, tok)
        } catch (err) {
          this.opts.log.warn({ err, path }, 'kiro-refresher: file refresh failed')
        }
      }
    } catch (err) {
      this.opts.log.warn({ err }, 'kiro-refresher: tick failed')
    } finally {
      this.running = false
    }
  }

  private async refreshOne(path: string, tok: TokenFile): Promise<void> {
    const dispatcher = this.pickDispatcher()
    const res = await fetch(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Kiro-CLI',
        Accept: '*/*',
      },
      body: JSON.stringify({ refreshToken: tok.refreshToken }),
      dispatcher,
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      // 401 "Bad credentials" = refresh chain rotated by another process
      // (e.g. kiro-cli local refreshed independently). Mark file dead so we
      // stop hammering the endpoint and surface to dashboard for re-auth.
      const isChainDead =
        res.status === 401 && body.toLowerCase().includes('bad credentials')
      if (isChainDead) {
        const dead: TokenFile = {
          ...tok,
          _chainDead: true,
          _chainDeadAt: new Date().toISOString(),
          _chainDeadReason: `refresh returned 401: ${body.slice(0, 200)}`,
        }
        try {
          writeFileSync(path, JSON.stringify(dead, null, 2), { mode: 0o600 })
        } catch {
          // ignore — next tick will retry the write
        }
        this.opts.log.warn(
          { path, status: res.status },
          'kiro-refresher: chain dead — account needs device-flow re-auth',
        )
        return
      }
      this.opts.log.warn(
        { path, status: res.status, body: body.slice(0, 200) },
        'kiro-refresher: refresh rejected by upstream',
      )
      return
    }
    const data = (await res.json()) as {
      accessToken: string
      refreshToken?: string
      expiresIn: number
      profileArn: string
    }
    const merged: TokenFile = {
      ...tok,
      accessToken: data.accessToken,
      refreshToken: data.refreshToken ?? tok.refreshToken,
      expiresAt: new Date(Date.now() + data.expiresIn * 1000).toISOString(),
      profileArn: data.profileArn,
    }
    writeFileSync(path, JSON.stringify(merged, null, 2), { mode: 0o600 })
    this.opts.log.info(
      { path, expiresAt: merged.expiresAt, viaProxy: !!dispatcher },
      'kiro-refresher: token refreshed',
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
