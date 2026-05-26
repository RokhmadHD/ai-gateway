import Database from 'better-sqlite3'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

const RESET = '\x1b[0m'
const BOLD = '\x1b[1m'
const DIM = '\x1b[2m'
const GREEN = '\x1b[32m'
const RED = '\x1b[31m'
const YELLOW = '\x1b[33m'
const CYAN = '\x1b[36m'

interface Args {
  db: string
  since?: number
  limit: number
  follow: boolean
  byKey: boolean
  byProxy: boolean
  errors: boolean
  json: boolean
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    db: 'metrics.db',
    limit: 20,
    follow: false,
    byKey: false,
    byProxy: false,
    errors: false,
    json: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--db') args.db = argv[++i]
    else if (a === '--since') {
      const v = argv[++i]
      args.since = parseSince(v)
    } else if (a === '--limit') args.limit = parseInt(argv[++i], 10)
    else if (a === '--follow' || a === '-f') args.follow = true
    else if (a === '--keys') args.byKey = true
    else if (a === '--proxies') args.byProxy = true
    else if (a === '--errors') args.errors = true
    else if (a === '--json') args.json = true
    else if (a === '--help' || a === '-h') {
      printHelp()
      process.exit(0)
    }
  }
  return args
}

function parseSince(v: string): number {
  // formats: 30m, 2h, 1d, ISO date, or epoch ms
  const m = v.match(/^(\d+)(s|m|h|d)$/)
  if (m) {
    const n = parseInt(m[1], 10)
    const unit = m[2]
    const mul = unit === 's' ? 1000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000
    return Date.now() - n * mul
  }
  const n = parseInt(v, 10)
  if (!isNaN(n)) return n
  return new Date(v).getTime()
}

function printHelp(): void {
  console.log(`Usage: npm run metric -- [options]

Options:
  --db <path>       sqlite path (default: metrics.db)
  --since <range>   e.g. 30m, 2h, 1d, or epoch ms (default: all)
  --limit <n>       rows for recent table (default: 20)
  --keys            show per-key breakdown
  --proxies         show per-proxy breakdown
  --errors          show recent error rows only
  --follow, -f      live tail mode
  --json            output JSON instead of tables
`)
}

interface Row {
  id: number
  ts: number
  provider: string
  endpoint: string
  model: string | null
  key_id: string | null
  proxy: string | null
  status: number | null
  latency_ms: number | null
  input_tokens: number | null
  output_tokens: number | null
  cache_read_tokens: number | null
  cache_write_tokens: number | null
  attempts: number | null
  stream: number | null
  error: string | null
}

function fmtAge(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return `${Math.floor(diff / 86_400_000)}d ago`
}

function fmtTokens(n: number | null): string {
  if (n === null || n === undefined) return '-'
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

function statusColor(s: number | null): string {
  if (s === null) return RED
  if (s < 300) return GREEN
  if (s < 500) return YELLOW
  return RED
}

function table(rows: Array<Record<string, string>>, cols: string[]): string {
  if (rows.length === 0) return DIM + '  (no data)' + RESET
  const widths: Record<string, number> = {}
  for (const c of cols) {
    widths[c] = c.length
    for (const r of rows) {
      const v = stripAnsi(r[c] ?? '')
      if (v.length > widths[c]) widths[c] = v.length
    }
  }
  const lines: string[] = []
  lines.push(BOLD + cols.map((c) => c.padEnd(widths[c])).join('  ') + RESET)
  lines.push(DIM + cols.map((c) => '-'.repeat(widths[c])).join('  ') + RESET)
  for (const r of rows) {
    lines.push(
      cols
        .map((c) => {
          const v = r[c] ?? ''
          const pad = widths[c] - stripAnsi(v).length
          return v + ' '.repeat(Math.max(0, pad))
        })
        .join('  '),
    )
  }
  return lines.join('\n')
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '')
}

function summary(db: Database.Database, since?: number): void {
  const where = since ? 'WHERE ts >= ?' : ''
  const params = since ? [since] : []
  const total = db
    .prepare(`SELECT COUNT(*) as c FROM requests ${where}`)
    .get(...params) as { c: number }
  if (total.c === 0) {
    console.log(DIM + '  (no requests recorded yet)' + RESET)
    return
  }
  const ok = db
    .prepare(`SELECT COUNT(*) as c FROM requests ${where ? where + ' AND' : 'WHERE'} status >= 200 AND status < 300`)
    .get(...params) as { c: number }
  const fail = total.c - ok.c
  const stats = db
    .prepare(
      `SELECT
        AVG(latency_ms) as avg_lat,
        MIN(latency_ms) as min_lat,
        MAX(latency_ms) as max_lat,
        SUM(input_tokens) as in_tok,
        SUM(output_tokens) as out_tok,
        SUM(cache_read_tokens) as cr_tok,
        SUM(cache_write_tokens) as cw_tok
      FROM requests ${where}`,
    )
    .get(...params) as {
    avg_lat: number | null
    min_lat: number | null
    max_lat: number | null
    in_tok: number | null
    out_tok: number | null
    cr_tok: number | null
    cw_tok: number | null
  }

  const successRate = ((ok.c / total.c) * 100).toFixed(1)
  const rateColor = ok.c === total.c ? GREEN : fail > ok.c ? RED : YELLOW

  console.log(BOLD + 'Summary' + RESET + (since ? DIM + ` (since ${fmtAge(since)})` + RESET : ''))
  console.log(`  total      ${BOLD}${total.c}${RESET}`)
  console.log(`  ok / fail  ${GREEN}${ok.c}${RESET} / ${RED}${fail}${RESET}  (${rateColor}${successRate}%${RESET})`)
  if (stats.avg_lat !== null) {
    console.log(
      `  latency    avg ${Math.round(stats.avg_lat)}ms  min ${stats.min_lat}ms  max ${stats.max_lat}ms`,
    )
  }
  console.log(
    `  tokens     in ${CYAN}${fmtTokens(stats.in_tok)}${RESET}  out ${CYAN}${fmtTokens(stats.out_tok)}${RESET}  cache r/w ${fmtTokens(stats.cr_tok)}/${fmtTokens(stats.cw_tok)}`,
  )
}

function byProvider(db: Database.Database, since?: number): void {
  const where = since ? 'WHERE ts >= ?' : ''
  const params = since ? [since] : []
  const rows = db
    .prepare(
      `SELECT provider, model, COUNT(*) as n,
        SUM(CASE WHEN status >= 200 AND status < 300 THEN 1 ELSE 0 END) as ok,
        AVG(latency_ms) as avg_lat,
        SUM(input_tokens) as in_tok,
        SUM(output_tokens) as out_tok
       FROM requests ${where}
       GROUP BY provider, model
       ORDER BY n DESC`,
    )
    .all(...params) as Array<{
    provider: string
    model: string | null
    n: number
    ok: number
    avg_lat: number | null
    in_tok: number | null
    out_tok: number | null
  }>
  console.log('\n' + BOLD + 'By provider × model' + RESET)
  console.log(
    table(
      rows.map((r) => ({
        provider: r.provider,
        model: r.model ?? '-',
        n: String(r.n),
        ok: `${r.ok}/${r.n}`,
        'avg ms': r.avg_lat !== null ? String(Math.round(r.avg_lat)) : '-',
        'in tok': fmtTokens(r.in_tok),
        'out tok': fmtTokens(r.out_tok),
      })),
      ['provider', 'model', 'n', 'ok', 'avg ms', 'in tok', 'out tok'],
    ),
  )
}

function byKey(db: Database.Database, since?: number): void {
  const where = since ? 'WHERE ts >= ?' : ''
  const params = since ? [since] : []
  const rows = db
    .prepare(
      `SELECT key_id, COUNT(*) as n,
        SUM(CASE WHEN status >= 200 AND status < 300 THEN 1 ELSE 0 END) as ok,
        AVG(latency_ms) as avg_lat,
        SUM(input_tokens) as in_tok,
        SUM(output_tokens) as out_tok
       FROM requests ${where ? where + ' AND' : 'WHERE'} key_id IS NOT NULL
       GROUP BY key_id
       ORDER BY n DESC`,
    )
    .all(...params) as Array<{
    key_id: string
    n: number
    ok: number
    avg_lat: number | null
    in_tok: number | null
    out_tok: number | null
  }>
  console.log('\n' + BOLD + 'By key' + RESET)
  console.log(
    table(
      rows.map((r) => ({
        key: r.key_id,
        n: String(r.n),
        ok: `${r.ok}/${r.n}`,
        'avg ms': r.avg_lat !== null ? String(Math.round(r.avg_lat)) : '-',
        'in tok': fmtTokens(r.in_tok),
        'out tok': fmtTokens(r.out_tok),
      })),
      ['key', 'n', 'ok', 'avg ms', 'in tok', 'out tok'],
    ),
  )
}

function byProxy(db: Database.Database, since?: number): void {
  const where = since ? 'WHERE ts >= ?' : ''
  const params = since ? [since] : []
  const rows = db
    .prepare(
      `SELECT COALESCE(proxy, 'direct') as proxy, COUNT(*) as n,
        SUM(CASE WHEN status >= 200 AND status < 300 THEN 1 ELSE 0 END) as ok,
        AVG(latency_ms) as avg_lat
       FROM requests ${where}
       GROUP BY proxy
       ORDER BY n DESC`,
    )
    .all(...params) as Array<{ proxy: string; n: number; ok: number; avg_lat: number | null }>
  console.log('\n' + BOLD + 'By proxy' + RESET)
  console.log(
    table(
      rows.map((r) => ({
        proxy: r.proxy,
        n: String(r.n),
        ok: `${r.ok}/${r.n}`,
        'avg ms': r.avg_lat !== null ? String(Math.round(r.avg_lat)) : '-',
      })),
      ['proxy', 'n', 'ok', 'avg ms'],
    ),
  )
}

function recent(db: Database.Database, args: Args): void {
  const where = args.since ? 'WHERE ts >= ?' : ''
  const params = args.since ? [args.since] : []
  const rows = db
    .prepare(
      `SELECT * FROM requests ${where} ORDER BY id DESC LIMIT ?`,
    )
    .all(...params, args.limit) as Row[]
  console.log('\n' + BOLD + 'Recent requests' + RESET)
  console.log(
    table(
      rows
        .reverse()
        .map((r) => ({
          when: fmtAge(r.ts),
          provider: r.provider,
          ep: shortEp(r.endpoint),
          model: shortModel(r.model),
          status: statusColor(r.status) + (r.status ?? 'ERR') + RESET,
          ms: r.latency_ms !== null ? String(r.latency_ms) : '-',
          'in/out': `${fmtTokens(r.input_tokens)}/${fmtTokens(r.output_tokens)}`,
          key: r.key_id ?? '-',
          proxy: r.proxy ?? 'direct',
          try: r.attempts !== null ? String(r.attempts) : '-',
          err: r.error ? DIM + r.error.slice(0, 30) + RESET : '',
        })),
      ['when', 'provider', 'ep', 'model', 'status', 'ms', 'in/out', 'key', 'proxy', 'try', 'err'],
    ),
  )
}

function shortEp(s: string): string {
  return s.replace('/v1/', '').replace('chat/completions', 'chat').replace('messages', 'msg')
}
function shortModel(s: string | null): string {
  if (!s) return '-'
  return s.replace('claude-', '').replace(/-\d{8}$/, '')
}

function errorRows(db: Database.Database, args: Args): void {
  const where = args.since ? 'AND ts >= ?' : ''
  const params = args.since ? [args.since] : []
  const rows = db
    .prepare(
      `SELECT * FROM requests WHERE (error IS NOT NULL OR status >= 400) ${where}
       ORDER BY id DESC LIMIT ?`,
    )
    .all(...params, args.limit) as Row[]
  console.log('\n' + BOLD + 'Errors' + RESET)
  console.log(
    table(
      rows
        .reverse()
        .map((r) => ({
          when: fmtAge(r.ts),
          provider: r.provider,
          status: statusColor(r.status) + (r.status ?? 'ERR') + RESET,
          key: r.key_id ?? '-',
          proxy: r.proxy ?? 'direct',
          error: r.error ? r.error.slice(0, 80) : '-',
        })),
      ['when', 'provider', 'status', 'key', 'proxy', 'error'],
    ),
  )
}

async function follow(db: Database.Database, args: Args): Promise<void> {
  let lastId =
    (db.prepare('SELECT MAX(id) as m FROM requests').get() as { m: number | null }).m ?? 0
  console.log(DIM + 'tail mode — Ctrl-C to exit' + RESET)
  console.log(
    BOLD +
      ['when', 'provider', 'ep', 'status', 'ms', 'in/out', 'key', 'proxy'].join(' | ') +
      RESET,
  )
  const stmt = db.prepare('SELECT * FROM requests WHERE id > ? ORDER BY id ASC')
  while (true) {
    const rows = stmt.all(lastId) as Row[]
    for (const r of rows) {
      lastId = r.id
      console.log(
        [
          fmtAge(r.ts),
          r.provider,
          shortEp(r.endpoint),
          statusColor(r.status) + (r.status ?? 'ERR') + RESET,
          r.latency_ms !== null ? r.latency_ms + 'ms' : '-',
          `${fmtTokens(r.input_tokens)}/${fmtTokens(r.output_tokens)}`,
          r.key_id ?? '-',
          r.proxy ?? 'direct',
        ].join(' | '),
      )
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const dbPath = resolve(args.db)
  if (!existsSync(dbPath)) {
    console.error(RED + `metrics db not found at ${dbPath}` + RESET)
    console.error(DIM + 'start the proxy first; metrics are recorded automatically' + RESET)
    process.exit(1)
  }
  const db = new Database(dbPath, { readonly: false, fileMustExist: true })
  db.pragma('journal_mode = WAL')

  if (args.follow) {
    await follow(db, args)
    return
  }

  if (args.json) {
    const where = args.since ? 'WHERE ts >= ?' : ''
    const params = args.since ? [args.since] : []
    const rows = db
      .prepare(`SELECT * FROM requests ${where} ORDER BY id DESC LIMIT ?`)
      .all(...params, args.limit)
    console.log(JSON.stringify(rows, null, 2))
    return
  }

  summary(db, args.since)
  byProvider(db, args.since)
  if (args.byKey) byKey(db, args.since)
  if (args.byProxy) byProxy(db, args.since)
  if (args.errors) errorRows(db, args)
  else recent(db, args)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
