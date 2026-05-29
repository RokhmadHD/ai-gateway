import { spawn } from "node:child_process";
import { readFile, unlink, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import { getDb, schema } from "@ai-gateway/db";
import { notifyConfigChange } from "../notifier";

const { proxies, tenants } = schema;

const BIN_PATH = process.env.PROXY_SCRAPER_BIN ?? "/usr/local/bin/proxy-scraper";
const DEFAULT_INTERVAL_MS = 60 * 60 * 1000; // 1h
const DEFAULT_TIMEOUT_MS = Number(process.env.PROXY_SCRAPER_TIMEOUT_MS ?? 30 * 60 * 1000); // 30m
const DEFAULT_TYPES = "http,https,socks4,socks5";
const DEFAULT_CONCURRENCY = 200;

export interface ScraperLogger {
  info: (obj: object, msg?: string) => void;
  warn: (obj: object, msg?: string) => void;
  error: (obj: object, msg?: string) => void;
}

interface ScrapedProxy {
  ip: string;
  port: number;
  type: string;
  alive: boolean;
  country_code?: string;
  latency_ms?: number;
}

export interface LastRun {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  scraped: number;
  alive: number;
  insertedByTenant: Record<string, number>;
  error: string | null;
}

export interface Progress {
  phase:
    | "starting"
    | "scraping"
    | "scraped"
    | "checking"
    | "checked"
    | "geoip"
    | "writing"
    | "inserting"
    | "stopping"
    | "done";
  sourcesDone: number;
  sourcesTotal: number;
  checkDone: number;
  checkTotal: number;
  aliveSoFar: number;
}

const initialProgress: Progress = {
  phase: "starting",
  sourcesDone: 0,
  sourcesTotal: 0,
  checkDone: 0,
  checkTotal: 0,
  aliveSoFar: 0,
};

interface State {
  running: boolean;
  startedAt: number | null;
  lastRun: LastRun | null;
  progress: Progress;
  timer: NodeJS.Timeout | null;
  stopped: boolean;
}

const state: State = {
  running: false,
  startedAt: null,
  lastRun: null,
  progress: { ...initialProgress },
  timer: null,
  stopped: false,
};

export function getScraperStatus() {
  return {
    running: state.running,
    startedAt: state.startedAt ? new Date(state.startedAt).toISOString() : null,
    lastRun: state.lastRun,
    progress: state.running ? state.progress : null,
  };
}

export interface RunOpts {
  types?: string;
  concurrency?: number;
  /** Restrict insert to a single tenant (e.g. when triggered by dashboard). */
  tenantId?: string;
}

/**
 * Scrape once and bulk-insert into the proxies table.
 * Returns the LastRun summary. Sets the singleton lastRun state.
 *
 * Concurrency-safe: if already running, returns the current promise (single-flight).
 */
let inflight: Promise<LastRun> | null = null;
let currentAbort: AbortController | null = null;
export function runScrape(log: ScraperLogger, opts: RunOpts = {}): Promise<LastRun> {
  if (inflight) return inflight;
  inflight = doRun(log, opts).finally(() => {
    inflight = null;
  });
  return inflight;
}

export function stopScrape(): boolean {
  if (!state.running || !currentAbort) return false;
  state.progress.phase = "stopping";
  currentAbort.abort();
  return true;
}

async function doRun(log: ScraperLogger, opts: RunOpts): Promise<LastRun> {
  const startedAt = Date.now();
  state.running = true;
  state.startedAt = startedAt;
  state.progress = { ...initialProgress };

  let scraped = 0;
  let alive = 0;
  const insertedByTenant: Record<string, number> = {};
  let errorMsg: string | null = null;

  try {
    const list = await spawnScraper(log, opts);
    scraped = list.length;
    const aliveOnly = list.filter((p) => p.alive);
    alive = aliveOnly.length;

    if (list.length > 0) {
      state.progress.phase = "inserting";
      const tenantIds = opts.tenantId
        ? [opts.tenantId]
        : await listAllTenantIds();

      for (const tid of tenantIds) {
        const inserted = await bulkUpsert(tid, list);
        insertedByTenant[tid] = inserted;
        if (inserted > 0) {
          await notifyConfigChange(`scraper-job/${tid}`).catch((e) =>
            log.warn({ err: String(e), tid }, "scraper: notify failed"),
          );
        }
      }
    }
    state.progress.phase = "done";
  } catch (err) {
    errorMsg =
      err instanceof Error && err.name === "AbortError"
        ? "stopped"
        : err instanceof Error
          ? err.message
          : String(err);
    if (errorMsg === "stopped") {
      log.warn({ err: errorMsg }, "scraper: run stopped");
    } else {
      log.error({ err: errorMsg }, "scraper: run failed");
    }
  }

  const finishedAt = Date.now();
  const summary: LastRun = {
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date(finishedAt).toISOString(),
    durationMs: finishedAt - startedAt,
    scraped,
    alive,
    insertedByTenant,
    error: errorMsg,
  };

  state.lastRun = summary;
  state.running = false;
  state.startedAt = null;

  log.info(
    { scraped, alive, insertedByTenant, durationMs: summary.durationMs, error: errorMsg },
    "scraper: run finished",
  );
  return summary;
}

async function spawnScraper(log: ScraperLogger, opts: RunOpts): Promise<ScrapedProxy[]> {
  const tmp = await mkdtemp(join(tmpdir(), "scraper-"));
  const outFile = join(tmp, "proxies.json");
  const args = [
    `-types=${opts.types ?? DEFAULT_TYPES}`,
    "-tui=off",
    "-quiet",
    "-progress",
    "-geoip=false",
    `-concurrency=${opts.concurrency ?? DEFAULT_CONCURRENCY}`,
    `-out=${outFile}`,
  ];

  log.info({ bin: BIN_PATH, args }, "scraper: spawning");

  const ctl = new AbortController();
  currentAbort = ctl;
  const killTimer = setTimeout(() => ctl.abort(), DEFAULT_TIMEOUT_MS);

  try {
    const exit = await new Promise<number>((resolve, reject) => {
      const child = spawn(BIN_PATH, args, {
        signal: ctl.signal,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stderrTail = "";
      let stderrBuf = "";
      child.stderr.on("data", (b: Buffer) => {
        stderrBuf += b.toString();
        let nl: number;
        while ((nl = stderrBuf.indexOf("\n")) !== -1) {
          const line = stderrBuf.slice(0, nl).trim();
          stderrBuf = stderrBuf.slice(nl + 1);
          if (!line) continue;
          handleProgressLine(line, log);
          // Keep last ~500 chars in case we need to surface an error.
          stderrTail = (stderrTail + line + "\n").slice(-500);
        }
      });
      child.on("error", (e) => reject(e));
      child.on("close", (code) => {
        if (code !== 0 && stderrTail) log.warn({ stderrTail }, "scraper: stderr");
        resolve(code ?? -1);
      });
    });
    if (exit !== 0) throw new Error(`scraper exited ${exit}`);

    const raw = await readFile(outFile, "utf-8");
    const parsed = JSON.parse(raw) as ScrapedProxy[];
    return Array.isArray(parsed) ? parsed : [];
  } finally {
    clearTimeout(killTimer);
    if (currentAbort === ctl) currentAbort = null;
    await unlink(outFile).catch(() => undefined);
  }
}

function handleProgressLine(line: string, log: ScraperLogger): void {
  if (!line.startsWith("{")) return; // ignore human-readable lines
  let evt: Record<string, unknown>;
  try {
    evt = JSON.parse(line);
  } catch {
    return;
  }
  const event = String(evt.event ?? "");
  switch (event) {
    case "phase": {
      const name = String(evt.name ?? "");
      if (name === "scraping") {
        state.progress.phase = "scraping";
        state.progress.sourcesTotal = Number(evt.sources_total ?? 0);
      } else if (name === "scraped") {
        state.progress.phase = "scraped";
      } else if (name === "checking") {
        state.progress.phase = "checking";
        state.progress.checkTotal = Number(evt.check_total ?? 0);
      } else if (name === "checked") {
        state.progress.phase = "checked";
        state.progress.aliveSoFar = Number(evt.alive ?? state.progress.aliveSoFar);
      } else if (name === "geoip") {
        state.progress.phase = "geoip";
      } else if (name === "writing") {
        state.progress.phase = "writing";
      }
      break;
    }
    case "source_done": {
      state.progress.sourcesDone = Number(evt.done ?? state.progress.sourcesDone + 1);
      if (evt.total) state.progress.sourcesTotal = Number(evt.total);
      break;
    }
    case "check_progress": {
      state.progress.checkDone = Number(evt.done ?? 0);
      state.progress.checkTotal = Number(evt.total ?? state.progress.checkTotal);
      state.progress.aliveSoFar = Number(evt.alive ?? 0);
      break;
    }
    case "error": {
      log.warn({ err: String(evt.err ?? "") }, "scraper: error event");
      break;
    }
    // 'done' is handled implicitly when the bin exits and Node reads the output file.
  }
}

const ALLOWED_TYPES = new Set(["http", "https", "socks4", "socks5"]);
const MAX_PROXY_PORT = 65535;
const MAX_PG_INTEGER = 2147483647;

function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= MAX_PROXY_PORT;
}

function normalizeLatencyMs(value: number | undefined): number | null {
  if (value === undefined || !Number.isFinite(value) || value < 0) return null;
  const ms = value > 60_000 ? Math.round(value / 1_000_000) : Math.round(value);
  return Math.min(ms, MAX_PG_INTEGER);
}

async function bulkUpsert(tenantId: string, list: ScrapedProxy[]): Promise<number> {
  const db = getDb();
  const runStartedAt = new Date();
  const rows = list
    .filter((p) => ALLOWED_TYPES.has(p.type?.toLowerCase()) && isValidPort(p.port))
    .map((p) => ({
      tenantId,
      type: p.type.toLowerCase() as "http" | "https" | "socks4" | "socks5",
      host: p.ip,
      port: p.port,
      source: "scraper" as const,
      status: p.alive ? ("alive" as const) : ("dead" as const),
      isActive: p.alive,
      latencyMs: normalizeLatencyMs(p.latency_ms),
      lastCheckedAt: new Date(),
      metadata: p.country_code ? { country_code: p.country_code } : {},
    }));

  if (rows.length === 0) return 0;

  let touched = 0;
  for (let i = 0; i < rows.length; i += 1000) {
    const chunk = rows.slice(i, i + 1000);
    const result = await db
      .insert(proxies)
      .values(chunk)
      .onConflictDoUpdate({
        target: [proxies.tenantId, proxies.type, proxies.host, proxies.port],
        set: {
          status: sql`case when ${proxies.source} = 'scraper' then excluded.status else ${proxies.status} end`,
          isActive: sql`case when ${proxies.source} = 'scraper' then excluded.is_active else ${proxies.isActive} end`,
          latencyMs: sql`case when ${proxies.source} = 'scraper' then excluded.latency_ms else ${proxies.latencyMs} end`,
          lastCheckedAt: sql`case when ${proxies.source} = 'scraper' then excluded.last_checked_at else ${proxies.lastCheckedAt} end`,
          metadata: sql`case when ${proxies.source} = 'scraper' then excluded.metadata else ${proxies.metadata} end`,
          updatedAt: sql`case when ${proxies.source} = 'scraper' then excluded.updated_at else ${proxies.updatedAt} end`,
        },
      })
      .returning({ id: proxies.id });
    touched += result.length;
  }

  const stale = await db
    .update(proxies)
    .set({
      status: "dead",
      isActive: false,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(proxies.tenantId, tenantId),
        eq(proxies.source, "scraper"),
        or(isNull(proxies.lastCheckedAt), lt(proxies.lastCheckedAt, runStartedAt)),
      ),
    )
    .returning({ id: proxies.id });
  touched += stale.length;

  return touched;
}

async function listAllTenantIds(): Promise<string[]> {
  const db = getDb();
  const rows = await db.query.tenants.findMany({ columns: { id: true } });
  return rows.map((r) => r.id);
}

export function startScraperSchedule(log: ScraperLogger, intervalMs: number = DEFAULT_INTERVAL_MS) {
  if (state.timer) return;
  state.stopped = false;
  // Slight delay on boot so the bin / DB / migrations finish first.
  const firstDelay = 60_000;
  const tick = () => {
    if (state.stopped) return;
    void runScrape(log).catch((e) => log.error({ err: String(e) }, "scraper: scheduled run threw"));
    state.timer = setTimeout(tick, intervalMs);
    if (typeof state.timer.unref === "function") state.timer.unref();
  };
  state.timer = setTimeout(tick, firstDelay);
  if (typeof state.timer.unref === "function") state.timer.unref();
  log.info({ intervalMs }, "scraper: schedule started");
}

export function stopScraperSchedule() {
  state.stopped = true;
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
}

void tenants;
