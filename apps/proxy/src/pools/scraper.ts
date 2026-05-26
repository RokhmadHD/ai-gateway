import { spawn } from 'node:child_process'
import { readFile, unlink } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { tmpdir } from 'node:os'
import type { ProxyPool, ProxyEntry, ProxyType } from './proxyPool.js'

export interface MinimalLogger {
  info: (obj: object, msg?: string) => void
  warn: (obj: object, msg?: string) => void
  debug: (obj: object, msg?: string) => void
}

export interface ScraperOptions {
  binPath: string
  types: ProxyType[]
  intervalSec: number
  timeoutMs?: number
  outFile?: string
  concurrency?: number
  proxyTimeoutSec?: number
}

// JSON output schema from proxy-scraper (see tools/scraper/internal/model/proxy.go)
interface ScrapedProxy {
  ip: string
  port: number
  type: string
  alive?: boolean
  country_code?: string
  latency_ms?: number
}

const ALLOWED_TYPES: Record<string, ProxyType> = {
  http: 'http',
  https: 'https',
  socks4: 'socks4',
  socks5: 'socks5',
}

export class ScraperRunner {
  private timer: NodeJS.Timeout | null = null
  private isRunning = false
  private failures = 0
  private stopped = false
  private currentAbort: AbortController | null = null

  constructor(
    private opts: ScraperOptions,
    private pool: ProxyPool,
    private log: MinimalLogger,
  ) {}

  start(): void {
    // Initial scrape, fire-and-forget; subsequent scrapes scheduled after success/failure
    void this.runOnce()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.currentAbort?.abort()
  }

  private scheduleNext(success: boolean): void {
    if (this.stopped) return
    if (success) {
      this.failures = 0
      this.timer = setTimeout(() => void this.runOnce(), this.opts.intervalSec * 1000)
    } else {
      this.failures += 1
      // Exponential backoff: 1m, 2m, 4m, …, cap 30m
      const backoffSec = Math.min(60 * Math.pow(2, this.failures - 1), 30 * 60)
      this.log.warn({ failures: this.failures, backoffSec }, 'scraper: backing off')
      this.timer = setTimeout(() => void this.runOnce(), backoffSec * 1000)
    }
  }

  private async runOnce(): Promise<void> {
    if (this.isRunning || this.stopped) return
    this.isRunning = true
    const outFile = this.opts.outFile ?? join(tmpdir(), `ai-proxy-proxies-${process.pid}.json`)
    const timeoutMs = this.opts.timeoutMs ?? 5 * 60 * 1000
    const abort = new AbortController()
    this.currentAbort = abort
    const timer = setTimeout(() => abort.abort(), timeoutMs)

    try {
      const args = [
        `-types=${this.opts.types.join(',')}`,
        '-alive-only',
        '-tui=off',
        '-quiet',
        `-out=${outFile}`,
      ]
      if (this.opts.concurrency) args.push(`-concurrency=${this.opts.concurrency}`)
      if (this.opts.proxyTimeoutSec) args.push(`-timeout=${this.opts.proxyTimeoutSec}s`)

      this.log.info({ bin: this.opts.binPath, args }, 'scraper: starting')

      const exitCode = await this.spawnAndWait(this.opts.binPath, args, abort.signal)
      if (exitCode !== 0) {
        this.log.warn({ exitCode }, 'scraper: non-zero exit')
        this.scheduleNext(false)
        return
      }

      const raw = await readFile(resolve(outFile), 'utf-8')
      const parsed = JSON.parse(raw) as ScrapedProxy[]
      const entries: ProxyEntry[] = []
      for (const p of parsed) {
        if (p.alive === false) continue
        const t = ALLOWED_TYPES[p.type?.toLowerCase()]
        if (!t) continue
        entries.push({ type: t, host: p.ip, port: p.port })
      }
      const loaded = this.pool.replace(entries)
      this.log.info({ scraped: parsed.length, loaded }, 'scraper: completed')
      await unlink(outFile).catch(() => undefined)
      this.scheduleNext(true)
    } catch (err) {
      this.log.warn({ err: (err as Error).message }, 'scraper: failed')
      this.scheduleNext(false)
    } finally {
      clearTimeout(timer)
      this.currentAbort = null
      this.isRunning = false
    }
  }

  private spawnAndWait(bin: string, args: string[], signal: AbortSignal): Promise<number> {
    return new Promise((res, rej) => {
      const child = spawn(bin, args, { signal, stdio: ['ignore', 'pipe', 'pipe'] })
      let stderr = ''
      child.stderr.on('data', (b: Buffer) => {
        stderr += b.toString()
      })
      child.on('error', (err) => rej(err))
      child.on('close', (code) => {
        if (code !== 0 && stderr) this.log.debug({ stderr: stderr.slice(0, 500) }, 'scraper stderr')
        res(code ?? -1)
      })
    })
  }
}
