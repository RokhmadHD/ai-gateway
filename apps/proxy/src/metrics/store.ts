import Database from 'better-sqlite3'
import { dirname } from 'node:path'
import { mkdirSync, existsSync } from 'node:fs'

export interface RequestRecord {
  ts: number
  provider: string
  endpoint: string
  model?: string
  key_id?: string
  proxy?: string
  status?: number
  latency_ms?: number
  input_tokens?: number
  output_tokens?: number
  cache_read_tokens?: number
  cache_write_tokens?: number
  attempts?: number
  stream?: number
  error?: string
}

export class MetricsStore {
  private db: Database.Database
  private insertStmt: Database.Statement<unknown[]>

  constructor(path: string) {
    if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true })
    this.db = new Database(path)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('synchronous = NORMAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        provider TEXT NOT NULL,
        endpoint TEXT NOT NULL,
        model TEXT,
        key_id TEXT,
        proxy TEXT,
        status INTEGER,
        latency_ms INTEGER,
        input_tokens INTEGER,
        output_tokens INTEGER,
        cache_read_tokens INTEGER,
        cache_write_tokens INTEGER,
        attempts INTEGER,
        stream INTEGER,
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_requests_ts ON requests(ts);
      CREATE INDEX IF NOT EXISTS idx_requests_provider ON requests(provider);
      CREATE INDEX IF NOT EXISTS idx_requests_key ON requests(key_id);
    `)
    this.insertStmt = this.db.prepare(`
      INSERT INTO requests
      (ts, provider, endpoint, model, key_id, proxy, status, latency_ms,
       input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
       attempts, stream, error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
  }

  record(r: RequestRecord): void {
    try {
      this.insertStmt.run(
        r.ts,
        r.provider,
        r.endpoint,
        r.model ?? null,
        r.key_id ?? null,
        r.proxy ?? null,
        r.status ?? null,
        r.latency_ms ?? null,
        r.input_tokens ?? null,
        r.output_tokens ?? null,
        r.cache_read_tokens ?? null,
        r.cache_write_tokens ?? null,
        r.attempts ?? null,
        r.stream ?? null,
        r.error ?? null,
      )
    } catch {
      // never let metrics break the request path
    }
  }

  close(): void {
    this.db.close()
  }

  raw(): Database.Database {
    return this.db
  }
}

let singleton: MetricsStore | undefined
export function getMetrics(path = 'metrics.db'): MetricsStore {
  if (!singleton) singleton = new MetricsStore(path)
  return singleton
}
