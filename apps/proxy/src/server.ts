import Fastify from 'fastify'
import { loadConfigFromSource } from './config/source.js'
import { chatRoutes } from './routes/chat.js'
import { messagesRoutes } from './routes/messages.js'
import { healthRoutes } from './routes/health.js'
import { loggerMiddleware } from './middleware/logger.js'
import { registerApiKeyAuth } from './middleware/apiKeyAuth.js'
import type { AppConfig, CustomProviderConfig, ProviderProxyConfig } from './config/index.js'
import { State } from './pools/state.js'
import { ProxyPool, type ProxyType } from './pools/proxyPool.js'
import { ScraperRunner } from './pools/scraper.js'
import { DbKeyReporter, noopKeyReporter, type KeyReporter } from './pools/keyReporter.js'
import { KiroBackgroundRefresher } from './providers/kiroBackgroundRefresher.js'
import { GeminiBackgroundRefresher } from './providers/geminiBackgroundRefresher.js'
import type { ConfigRuntime, CursorRedis } from '@ai-gateway/config-runtime'
import { createRedisClient } from '@ai-gateway/config-runtime'
import type { ConfigSnapshot } from '@ai-gateway/shared'

declare module 'fastify' {
  interface FastifyInstance {
    config: AppConfig
    pools: {
      state: State
      proxyPool?: ProxyPool
    }
    keyReporter: KeyReporter
    configRuntime?: ConfigRuntime
    autoRouterRedis?: CursorRedis | null
  }
}

function pickProxyConfig(config: AppConfig): ProviderProxyConfig | undefined {
  const customs = Object.values(config.providers?.custom ?? {}) as CustomProviderConfig[]
  for (const c of customs) {
    if (c.proxy?.enabled) return c.proxy
  }
  return undefined
}

async function build() {
  const { source, config, runtime } = await loadConfigFromSource()

  const fastify = Fastify({
    logger: {
      level: config.server.log_level,
      transport: config.server.pretty_logs
        ? { target: 'pino-pretty', options: { colorize: true } }
        : undefined,
    },
  })

  fastify.log.info({ source, providers: Object.keys(config.providers?.custom ?? {}) }, 'config loaded')

  let keyReporter: KeyReporter = noopKeyReporter
  if (runtime) {
    const dbReporter = new DbKeyReporter(fastify.log)
    dbReporter.refresh(runtime.snapshot())
    keyReporter = dbReporter
    runtime.on('error', (err) => fastify.log.error({ err }, 'config-runtime poll failed'))
    runtime.on('update', (snap) => {
      dbReporter.refresh(snap)
      fastify.log.info({ providers: snap.providers.length }, 'config snapshot updated')
    })
    await runtime.start()
  }

  const stateFile = config.pool?.state_file ?? 'state.json'
  const state = await State.load(stateFile)

  let proxyPool: ProxyPool | undefined
  let scraper: ScraperRunner | undefined

  // ───── DB-driven proxy pool (preferred) ─────
  // If config-runtime is available, the proxies table is the source of truth.
  // We create the pool unconditionally so that adding the first proxy in the
  // dashboard activates rotation without a restart.
  if (runtime) {
    const initialSnap = runtime.snapshot()
    proxyPool = new ProxyPool(state, ['http', 'https', 'socks4', 'socks5'])
    const applied = proxyPool.replace(
      initialSnap.proxies.map((p) => ({ type: p.type, host: p.host, port: p.port })),
    )
    fastify.log.info({ proxies: applied }, 'proxy pool initialised from db snapshot')
    runtime.on('update', (snap: ConfigSnapshot) => {
      const n = proxyPool!.replace(
        snap.proxies.map((p) => ({ type: p.type, host: p.host, port: p.port })),
      )
      fastify.log.info({ proxies: n }, 'proxy pool updated from snapshot')
    })
  }

  // ───── Legacy toml-driven scraper path ─────
  // Kept for deployments that still rely on the Go scraper writing into
  // state.json. Skipped automatically when runtime is providing proxies.
  const proxyConfig = pickProxyConfig(config)
  if (!runtime && proxyConfig?.enabled) {
    const types: ProxyType[] = proxyConfig.types ?? ['http', 'socks5']
    proxyPool = new ProxyPool(state, types)
    const binPath = proxyConfig.scraper_bin ?? 'tools/scraper/proxy-scraper'
    scraper = new ScraperRunner(
      {
        binPath,
        types,
        intervalSec: proxyConfig.scrape_interval_sec ?? 600,
        concurrency: proxyConfig.concurrency,
        proxyTimeoutSec: proxyConfig.proxy_timeout_sec,
      },
      proxyPool,
      fastify.log,
    )
    scraper.start()
    fastify.log.info({ bin: binPath, types }, 'proxy scraper enabled (legacy toml mode)')
  }

  fastify.decorate('config', config)
  fastify.decorate('pools', { state, proxyPool })
  fastify.decorate('keyReporter', keyReporter)
  if (runtime) fastify.decorate('configRuntime', runtime)

  // ───── Kiro background token refresher ─────
  // Walks account_dir periodically, refreshes any token within leeway window.
  // Uses proxyPool when available to avoid IP-based rate limits on the OAuth endpoint.
  let kiroRefresher: KiroBackgroundRefresher | undefined
  const kiroCustom = config.providers?.custom?.kiro as
    | { account_dir?: string }
    | undefined
  const kiroDir =
    process.env.KIRO_ACCOUNTS_DIR ?? kiroCustom?.account_dir ?? undefined
  if (kiroDir) {
    kiroRefresher = new KiroBackgroundRefresher({
      accountDir: kiroDir,
      log: fastify.log,
      proxyPool,
    })
    kiroRefresher.start()
  }

  // ───── Gemini background token refresher ─────
  let geminiRefresher: GeminiBackgroundRefresher | undefined
  const geminiCustom = config.providers?.custom?.gemini as
    | { account_dir?: string }
    | undefined
  const geminiDir =
    process.env.GEMINI_ACCOUNTS_DIR ?? geminiCustom?.account_dir ?? undefined
  if (geminiDir) {
    geminiRefresher = new GeminiBackgroundRefresher({
      accountDir: geminiDir,
      log: fastify.log,
      proxyPool,
    })
    geminiRefresher.start()
  }

  // Optional Redis client for aig-auto rotation cursor (multi-instance safe).
  let autoRouterRedis: CursorRedis | null = null
  let autoRouterRedisClose: (() => Promise<void>) | undefined
  if (process.env.REDIS_URL) {
    try {
      const client = createRedisClient(process.env.REDIS_URL)
      client.on('error', (err) =>
        fastify.log.warn({ err }, 'autoRouter redis error'),
      )
      await client.connect()
      autoRouterRedis = client
      autoRouterRedisClose = () =>
        client
          .quit()
          .then(() => undefined)
          .catch(() => undefined)
      fastify.log.info('autoRouter: using redis cursor')
    } catch (err) {
      fastify.log.warn({ err }, 'autoRouter redis connect failed — fallback to in-memory cursor')
      autoRouterRedis = null
    }
  }
  fastify.decorate('autoRouterRedis', autoRouterRedis)

  // ───── Background job: clear expired cooldowns ─────
  let cooldownCleaner: NodeJS.Timeout | undefined
  if (runtime) {
    const { getDb } = await import('@ai-gateway/db')
    const { schema } = await import('@ai-gateway/db')
    const { and, eq, lt } = await import('drizzle-orm')

    cooldownCleaner = setInterval(async () => {
      try {
        await getDb()
          .update(schema.providerKeys)
          .set({ status: 'active', cooldownUntil: null })
          .where(
            and(
              eq(schema.providerKeys.status, 'cooldown'),
              lt(schema.providerKeys.cooldownUntil, new Date())
            )
          )
      } catch (err) {
        fastify.log.warn({ err }, 'cooldown cleaner: failed')
      }
    }, 60_000) // every 1 minute

    fastify.log.info('cooldown cleaner: started')
  }

  const shutdown = async () => {
    if (cooldownCleaner) clearInterval(cooldownCleaner)
    await runtime?.stop()
    scraper?.stop()
    kiroRefresher?.stop()
    geminiRefresher?.stop()
    state.flushSync()
    if (proxyPool) await proxyPool.closeAll()
    if (autoRouterRedisClose) await autoRouterRedisClose()
  }
  process.once('SIGTERM', () => void shutdown().then(() => process.exit(0)))
  process.once('SIGINT', () => void shutdown().then(() => process.exit(0)))

  await fastify.register(loggerMiddleware)
  registerApiKeyAuth(fastify)
  await fastify.register(healthRoutes)
  await fastify.register(chatRoutes)
  await fastify.register(messagesRoutes)

  return fastify
}

async function start() {
  const fastify = await build()
  const { port, host } = fastify.config.server

  try {
    await fastify.listen({ port, host })
  } catch (err) {
    fastify.log.error(err)
    process.exit(1)
  }
}

start()
