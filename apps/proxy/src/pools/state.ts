import { readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

export interface HealthEntry {
  errorCount: number
  lastError?: string
  cooldownUntil?: number
}

export interface StateSnapshot {
  keys: Record<string, HealthEntry>
  proxies: Record<string, HealthEntry>
}

export class State {
  private snapshot: StateSnapshot = { keys: {}, proxies: {} }
  private flushTimer: NodeJS.Timeout | null = null
  private flushing = false
  private dirty = false

  constructor(
    private filePath: string,
    private debounceMs = 1000,
  ) {}

  static async load(filePath: string): Promise<State> {
    const s = new State(filePath)
    try {
      const raw = await readFile(resolve(filePath), 'utf-8')
      const parsed = JSON.parse(raw) as Partial<StateSnapshot>
      s.snapshot = {
        keys: parsed.keys ?? {},
        proxies: parsed.proxies ?? {},
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        // corrupt file — start fresh, log via caller
        s.snapshot = { keys: {}, proxies: {} }
      }
    }
    return s
  }

  getKeys(): Record<string, HealthEntry> {
    return this.snapshot.keys
  }

  getProxies(): Record<string, HealthEntry> {
    return this.snapshot.proxies
  }

  updateKey(key: string, entry: HealthEntry | null): void {
    if (entry === null) delete this.snapshot.keys[key]
    else this.snapshot.keys[key] = entry
    this.scheduleFlush()
  }

  updateProxy(key: string, entry: HealthEntry | null): void {
    if (entry === null) delete this.snapshot.proxies[key]
    else this.snapshot.proxies[key] = entry
    this.scheduleFlush()
  }

  private scheduleFlush(): void {
    this.dirty = true
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      void this.flush()
    }, this.debounceMs)
  }

  async flush(): Promise<void> {
    if (this.flushing || !this.dirty) return
    this.flushing = true
    this.dirty = false
    try {
      const path = resolve(this.filePath)
      await mkdir(dirname(path), { recursive: true })
      const tmp = `${path}.${process.pid}.tmp`
      await writeFile(tmp, JSON.stringify(this.snapshot, null, 2))
      await rename(tmp, path)
    } finally {
      this.flushing = false
    }
  }

  flushSync(): void {
    if (!this.dirty) return
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    // best-effort sync write at shutdown
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('node:fs') as typeof import('node:fs')
    const path = resolve(this.filePath)
    try {
      fs.mkdirSync(dirname(path), { recursive: true })
      const tmp = `${path}.${process.pid}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(this.snapshot, null, 2))
      fs.renameSync(tmp, path)
      this.dirty = false
    } catch {
      // ignore — shutdown
    }
  }
}
