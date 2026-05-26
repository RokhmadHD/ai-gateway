import { fetch } from 'undici'
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  ChatMessage,
  ChatRequest,
  ChatResponse,
  Provider,
  ToolCall,
  ToolDef,
} from './base.js'

const Q_ENDPOINT = 'https://q.us-east-1.amazonaws.com/'
const OAUTH_TOKEN_URL = 'https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken'
const DEFAULT_TOKEN_PATH = '~/.aws/sso/cache/kiro-auth-token-cli.json'
const KIRO_USER_AGENT =
  'aws-sdk-rust/1.3.15 ua/2.1 api/codewhispererruntime/0.1.16551 os/linux lang/rust/1.92.0 md/appVersion-2.4.0 app/AmazonQ-For-CLI'
const REFRESH_LEEWAY_MS = 60_000

const MODEL_ALIAS: Record<string, string> = {
  'gpt-4': 'claude-sonnet-4.5',
  'gpt-4o': 'claude-sonnet-4.5',
  'gpt-3.5-turbo': 'claude-haiku-4.5',
  'claude-3-5-sonnet': 'claude-sonnet-4.5',
  'claude-3-haiku': 'claude-haiku-4.5',
}

interface TokenCache {
  accessToken: string
  refreshToken: string
  expiresAt: string
  profileArn: string
  authMethod?: string
  provider?: string
  _chainDead?: boolean
  _chainDeadAt?: string
  _chainDeadReason?: string
}

function expandPath(p: string): string {
  if (p.startsWith('~')) return resolve(homedir() + p.slice(1))
  return resolve(p)
}

class TokenStore {
  readonly path: string
  private cache?: TokenCache
  private cacheMtimeMs = 0
  private refreshing?: Promise<TokenCache>
  private cooldownUntil = 0

  constructor(path?: string) {
    this.path = expandPath(path ?? DEFAULT_TOKEN_PATH)
  }

  private load(): TokenCache {
    if (!existsSync(this.path)) {
      throw new Error(`Kiro token cache not found at ${this.path}. Run kiro-cli login first.`)
    }
    const raw = readFileSync(this.path, 'utf-8')
    try {
      this.cacheMtimeMs = statSync(this.path).mtimeMs
    } catch {
      this.cacheMtimeMs = 0
    }
    return JSON.parse(raw) as TokenCache
  }

  private save(t: TokenCache): void {
    writeFileSync(this.path, JSON.stringify(t, null, 2), { mode: 0o600 })
    try {
      this.cacheMtimeMs = statSync(this.path).mtimeMs
    } catch {
      // ignore — next get() will reload via mtime check failure path
    }
  }

  /** Reload from disk if file was modified externally (e.g. background refresher
   *  wrote a new access token while we held a stale in-memory copy). */
  private maybeInvalidateOnDiskChange(): void {
    if (!this.cache) return
    try {
      const m = statSync(this.path).mtimeMs
      if (m > this.cacheMtimeMs) this.cache = undefined
    } catch {
      // ignore — load() will surface a clearer error
    }
  }

  private isExpired(t: TokenCache): boolean {
    const exp = Date.parse(t.expiresAt)
    if (Number.isNaN(exp)) return true
    return exp - Date.now() < REFRESH_LEEWAY_MS
  }

  isAvailable(): boolean {
    return Date.now() >= this.cooldownUntil
  }

  cooldown(ms: number): void {
    this.cooldownUntil = Date.now() + ms
  }

  async get(): Promise<{ accessToken: string; profileArn: string }> {
    this.maybeInvalidateOnDiskChange()
    if (!this.cache) this.cache = this.load()
    if (this.cache._chainDead) {
      throw Object.assign(
        new Error(
          `Kiro account at ${this.path} needs re-auth (refresh chain dead${this.cache._chainDeadAt ? ` since ${this.cache._chainDeadAt}` : ''})`,
        ),
        { status: 401, chainDead: true },
      )
    }
    if (this.isExpired(this.cache)) {
      if (!this.refreshing) this.refreshing = this.refresh(this.cache.refreshToken)
      try {
        this.cache = await this.refreshing
      } finally {
        this.refreshing = undefined
      }
    }
    return { accessToken: this.cache.accessToken, profileArn: this.cache.profileArn }
  }

  private async refresh(refreshToken: string): Promise<TokenCache> {
    const res = await fetch(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Kiro-CLI',
        Accept: '*/*',
      },
      body: JSON.stringify({ refreshToken }),
    })
    if (!res.ok) {
      const body = await res.text()
      // 401 Bad credentials = chain rotated by another process. Mark dead so we
      // stop retrying with this refreshToken; needs device-flow re-auth.
      if (res.status === 401 && body.toLowerCase().includes('bad credentials')) {
        if (this.cache) {
          const dead: TokenCache = {
            ...this.cache,
            _chainDead: true,
            _chainDeadAt: new Date().toISOString(),
            _chainDeadReason: `refresh returned 401: ${body.slice(0, 200)}`,
          }
          try {
            this.save(dead)
            this.cache = dead
          } catch {
            // ignore — request will still fail below
          }
        }
        throw Object.assign(
          new Error(
            `Kiro refresh chain dead — re-auth required (${body.slice(0, 120)})`,
          ),
          { status: 401, chainDead: true },
        )
      }
      throw new Error(`Kiro refresh failed ${res.status}: ${body}`)
    }
    const data = (await res.json()) as {
      accessToken: string
      refreshToken?: string
      expiresIn: number
      profileArn: string
    }
    const expiresAt = new Date(Date.now() + data.expiresIn * 1000).toISOString()
    const merged: TokenCache = {
      ...(this.cache ?? ({} as TokenCache)),
      accessToken: data.accessToken,
      refreshToken: data.refreshToken ?? refreshToken,
      expiresAt,
      profileArn: data.profileArn,
    }
    this.save(merged)
    return merged
  }

  // Force reload from disk (e.g. on 401).
  invalidate(): void {
    this.cache = undefined
  }
}

class TokenStorePool {
  private stores: TokenStore[]
  private cursor = 0

  constructor(stores: TokenStore[]) {
    if (stores.length === 0) throw new Error('Kiro: no token stores configured')
    this.stores = stores
  }

  size(): number {
    return this.stores.length
  }

  /** Pick next available store in round-robin order. */
  next(): TokenStore {
    for (let i = 0; i < this.stores.length; i++) {
      const idx = (this.cursor + i) % this.stores.length
      const s = this.stores[idx]
      if (s.isAvailable()) {
        this.cursor = (idx + 1) % this.stores.length
        return s
      }
    }
    throw new Error('Kiro: all accounts in cooldown / rate-limited')
  }
}

function discoverTokenFiles(dir: string): string[] {
  // Admin writes tokens to <base>/<tenant_slug>/acc-*.json. Pre-S6 deploys
  // had them flat at <base>/acc-*.json. Scan both so the proxy keeps working.
  const root = expandPath(dir)
  if (!existsSync(root)) return []
  const out: string[] = []
  for (const entry of readdirSync(root)) {
    const p = join(root, entry)
    try {
      const s = statSync(p)
      if (s.isFile() && entry.endsWith('.json')) {
        out.push(p)
      } else if (s.isDirectory()) {
        for (const sub of readdirSync(p)) {
          if (!sub.endsWith('.json')) continue
          const subPath = join(p, sub)
          if (statSync(subPath).isFile()) out.push(subPath)
        }
      }
    } catch {
      // unreadable entry; skip silently
    }
  }
  return out.sort()
}

function mapModel(model: string): string {
  if (MODEL_ALIAS[model]) return MODEL_ALIAS[model]
  return model || 'auto'
}

function mapToolsToSpec(tools: ToolDef[] | undefined): unknown[] | undefined {
  if (!tools || tools.length === 0) return undefined
  return tools.map((t) => ({
    toolSpecification: {
      name: t.function.name,
      description: t.function.description ?? '',
      inputSchema: { json: t.function.parameters ?? { type: 'object', properties: {} } },
    },
  }))
}

function safeParseJSON(s: string | undefined | null): unknown {
  if (!s) return {}
  try { return JSON.parse(s) } catch { return {} }
}

/** Sanitize tool IDs to match Kiro's ^[a-zA-Z0-9_-]+$ pattern */
function sanitizeToolId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_')
}

// Kiro has no system role. Prepend system content to first user message.
function buildConversation(
  req: ChatRequest,
  modelId: string,
): {
  conversationId: string
  history: Array<Record<string, unknown>>
  currentMessage: Record<string, unknown>
} {
  let systemPrefix = ''
  const rest: ChatMessage[] = []
  for (const m of req.messages) {
    if (m.role === 'system') {
      systemPrefix += (systemPrefix ? '\n\n' : '') + (m.content ?? '')
    } else {
      rest.push(m)
    }
  }

  type Turn =
    | {
        kind: 'user'
        content: string
        toolResults?: Array<{
          toolUseId: string
          content: Array<{ text?: string; json?: unknown }>
          status: 'success' | 'error'
        }>
      }
    | {
        kind: 'assistant'
        content: string
        toolUses?: Array<{ toolUseId: string; name: string; input: unknown }>
      }

  const turns: Turn[] = []
  let pendingResults: Array<{
    toolUseId: string
    content: Array<{ text?: string; json?: unknown }>
    status: 'success' | 'error'
  }> = []

  for (const m of rest) {
    if (m.role === 'tool') {
      const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '')
      pendingResults.push({
        toolUseId: sanitizeToolId(m.tool_call_id ?? ''),
        content: [{ text }],
        status: 'success',
      })
    } else if (m.role === 'user') {
      turns.push({
        kind: 'user',
        content: typeof m.content === 'string' ? m.content : '',
        toolResults: pendingResults.length ? pendingResults : undefined,
      })
      pendingResults = []
    } else if (m.role === 'assistant') {
      const toolUses = m.tool_calls?.map((tc) => ({
        toolUseId: sanitizeToolId(tc.id),
        name: tc.function.name,
        input: safeParseJSON(tc.function.arguments),
      }))
      turns.push({
        kind: 'assistant',
        content: typeof m.content === 'string' ? m.content : '',
        toolUses: toolUses && toolUses.length ? toolUses : undefined,
      })
    }
  }

  // Any leftover tool results without a following user → synthesize empty user turn.
  if (pendingResults.length) {
    turns.push({ kind: 'user', content: '', toolResults: pendingResults })
    pendingResults = []
  }

  // Inject system prefix into first user turn (or create one).
  if (systemPrefix) {
    const firstUserIdx = turns.findIndex((t) => t.kind === 'user')
    if (firstUserIdx >= 0) {
      const t = turns[firstUserIdx] as Turn & { kind: 'user' }
      t.content = `${systemPrefix}\n\n${t.content}`
    } else {
      turns.unshift({ kind: 'user', content: systemPrefix })
    }
  }

  if (turns.length === 0) {
    turns.push({ kind: 'user', content: '' })
  }

  // CW requires last turn to be userInputMessage. Pad if last is assistant.
  if (turns[turns.length - 1].kind === 'assistant') {
    turns.push({ kind: 'user', content: '' })
  }

  const last = turns[turns.length - 1] as Turn & { kind: 'user' }
  const historyTurns = turns.slice(0, -1)

  const history = historyTurns.map((t) => {
    if (t.kind === 'assistant') {
      const a: Record<string, unknown> = { content: t.content }
      if (t.toolUses) a.toolUses = t.toolUses
      return { assistantResponseMessage: a }
    }
    const u: Record<string, unknown> = { content: t.content, origin: 'KIRO_CLI' }
    if (t.toolResults) {
      u.userInputMessageContext = { toolResults: t.toolResults }
    }
    return { userInputMessage: u }
  })

  const toolsSpec = mapToolsToSpec(req.tools)
  const currentContext: Record<string, unknown> = {
    envState: {
      operatingSystem: 'linux',
      currentWorkingDirectory: process.cwd(),
    },
    tools: toolsSpec ?? [],
  }
  if (last.toolResults) currentContext.toolResults = last.toolResults

  const currentMessage = {
    userInputMessage: {
      content: last.content,
      userInputMessageContext: currentContext,
      origin: 'KIRO_CLI',
      modelId,
    },
  }

  return { conversationId: randomUUID(), history, currentMessage }
}

// ---------------- AWS event-stream binary decoder ----------------
// Frame: [total_len:u32][headers_len:u32][prelude_crc:u32][headers][payload][message_crc:u32]
interface EventFrame {
  headers: Record<string, string>
  payload: Uint8Array
}

async function* decodeEventStream(
  body: AsyncIterable<Uint8Array>,
): AsyncIterable<EventFrame> {
  let buf = new Uint8Array(0)
  const append = (chunk: Uint8Array) => {
    const next = new Uint8Array(buf.length + chunk.length)
    next.set(buf, 0)
    next.set(chunk, buf.length)
    buf = next
  }

  for await (const chunk of body) {
    append(chunk)
    while (buf.length >= 12) {
      const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
      const totalLen = view.getUint32(0, false)
      if (totalLen < 16 || totalLen > 16 * 1024 * 1024) {
        throw new Error(`eventstream: bad frame length ${totalLen}`)
      }
      if (buf.length < totalLen) break
      const headersLen = view.getUint32(4, false)
      const headersStart = 12
      const headersEnd = headersStart + headersLen
      const payloadEnd = totalLen - 4
      const headers = parseHeaders(buf.subarray(headersStart, headersEnd))
      const payload = buf.slice(headersEnd, payloadEnd)
      yield { headers, payload }
      buf = buf.slice(totalLen)
    }
  }
}

function parseHeaders(bytes: Uint8Array): Record<string, string> {
  const headers: Record<string, string> = {}
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const td = new TextDecoder('utf-8')
  let i = 0
  while (i < bytes.length) {
    const nameLen = bytes[i]
    i += 1
    const name = td.decode(bytes.subarray(i, i + nameLen))
    i += nameLen
    const type = bytes[i]
    i += 1
    if (type === 7) {
      // string
      const vlen = view.getUint16(i, false)
      i += 2
      headers[name] = td.decode(bytes.subarray(i, i + vlen))
      i += vlen
    } else if (type === 6) {
      // boolean false
      headers[name] = 'false'
    } else if (type === 0) {
      headers[name] = 'true'
    } else if (type === 4) {
      // int32
      headers[name] = String(view.getInt32(i, false))
      i += 4
    } else if (type === 5) {
      // int64 (truncate to safe range)
      const hi = view.getInt32(i, false)
      const lo = view.getUint32(i + 4, false)
      headers[name] = String(hi * 2 ** 32 + lo)
      i += 8
    } else if (type === 8) {
      // timestamp ms (int64)
      const hi = view.getInt32(i, false)
      const lo = view.getUint32(i + 4, false)
      headers[name] = String(hi * 2 ** 32 + lo)
      i += 8
    } else if (type === 9) {
      // uuid
      const v = bytes.subarray(i, i + 16)
      headers[name] = Array.from(v).map((b) => b.toString(16).padStart(2, '0')).join('')
      i += 16
    } else {
      // unknown type, skip rest
      break
    }
  }
  return headers
}

interface ToolUseAccumulator {
  id: string
  name: string
  inputBuf: string
  emittedIndex: number
}

async function* eventsToOpenAIStream(
  body: AsyncIterable<Uint8Array>,
  model: string,
): AsyncIterable<string> {
  const td = new TextDecoder('utf-8')
  const chatId = `chatcmpl-${Date.now()}`
  const toolUses = new Map<string, ToolUseAccumulator>()
  let toolOrder: string[] = []
  let finishReason: 'stop' | 'tool_calls' = 'stop'

  const emitChunk = (delta: Record<string, unknown>, finish: string | null = null) => {
    const chunk = {
      id: chatId,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    }
    return `data: ${JSON.stringify(chunk)}\n\n`
  }

  for await (const frame of decodeEventStream(body)) {
    const eventType = frame.headers[':event-type']
    const messageType = frame.headers[':message-type']
    if (messageType === 'exception' || messageType === 'error') {
      const errText = td.decode(frame.payload)
      throw new Error(`Kiro stream error (${eventType}): ${errText}`)
    }
    if (eventType === 'assistantResponseEvent') {
      try {
        const ev = JSON.parse(td.decode(frame.payload)) as { content?: string }
        if (ev.content) yield emitChunk({ content: ev.content })
      } catch {
        // ignore malformed payload
      }
    } else if (eventType === 'toolUseEvent') {
      try {
        const ev = JSON.parse(td.decode(frame.payload)) as {
          toolUseId?: string
          name?: string
          input?: string
          stop?: boolean
        }
        if (!ev.toolUseId) continue
        let acc = toolUses.get(ev.toolUseId)
        if (!acc) {
          acc = {
            id: ev.toolUseId,
            name: ev.name ?? '',
            inputBuf: '',
            emittedIndex: toolOrder.length,
          }
          toolUses.set(ev.toolUseId, acc)
          toolOrder.push(ev.toolUseId)
          yield emitChunk({
            tool_calls: [
              {
                index: acc.emittedIndex,
                id: acc.id,
                type: 'function',
                function: { name: acc.name, arguments: '' },
              },
            ],
          })
        }
        if (ev.input) {
          acc.inputBuf += ev.input
          yield emitChunk({
            tool_calls: [
              {
                index: acc.emittedIndex,
                function: { arguments: ev.input },
              },
            ],
          })
        }
        if (ev.stop) finishReason = 'tool_calls'
      } catch {
        // ignore malformed payload
      }
    }
    // other event types (messageMetadataEvent, contextUsageEvent, meteringEvent) ignored
  }
  if (toolOrder.length > 0) finishReason = 'tool_calls'
  yield emitChunk({}, finishReason)
  yield 'data: [DONE]\n\n'
}

interface CollectedResponse {
  content: string
  toolCalls: ToolCall[]
}

async function collectEventStream(
  body: AsyncIterable<Uint8Array>,
): Promise<CollectedResponse> {
  const td = new TextDecoder('utf-8')
  let content = ''
  const order: string[] = []
  const acc = new Map<string, { name: string; inputBuf: string }>()
  for await (const frame of decodeEventStream(body)) {
    const eventType = frame.headers[':event-type']
    if (eventType === 'assistantResponseEvent') {
      try {
        const ev = JSON.parse(td.decode(frame.payload)) as { content?: string }
        if (ev.content) content += ev.content
      } catch {
        /* skip */
      }
    } else if (eventType === 'toolUseEvent') {
      try {
        const ev = JSON.parse(td.decode(frame.payload)) as {
          toolUseId?: string
          name?: string
          input?: string
        }
        if (!ev.toolUseId) continue
        let entry = acc.get(ev.toolUseId)
        if (!entry) {
          entry = { name: ev.name ?? '', inputBuf: '' }
          acc.set(ev.toolUseId, entry)
          order.push(ev.toolUseId)
        }
        if (ev.input) entry.inputBuf += ev.input
      } catch {
        /* skip */
      }
    } else if (frame.headers[':message-type'] === 'exception') {
      throw new Error(`Kiro: ${td.decode(frame.payload)}`)
    }
  }
  const toolCalls: ToolCall[] = order.map((id) => {
    const e = acc.get(id)!
    return {
      id,
      type: 'function',
      function: { name: e.name, arguments: e.inputBuf || '{}' },
    }
  })
  return { content, toolCalls }
}

export interface KiroProviderOptions {
  /** Single token cache path. Default ~/.aws/sso/cache/kiro-auth-token-cli.json */
  tokenCache?: string
  /** Multi-account: explicit list of token cache paths */
  tokenCaches?: string[]
  /** Multi-account: directory scanned for *.json token files */
  accountDir?: string
  defaultModel?: string
  /** Max accounts to try per request when one fails (default = pool size). */
  maxRetries?: number
}

const COOLDOWN_429_MS = 60_000
const COOLDOWN_401_MS = 300_000

export class KiroProvider implements Provider {
  name = 'kiro'
  private pool: TokenStorePool
  private defaultModel: string
  private maxRetries: number

  constructor(opts: KiroProviderOptions = {}) {
    const paths = new Set<string>()
    if (opts.tokenCaches) opts.tokenCaches.forEach((p) => paths.add(expandPath(p)))
    if (opts.accountDir) discoverTokenFiles(opts.accountDir).forEach((p) => paths.add(p))
    if (opts.tokenCache) paths.add(expandPath(opts.tokenCache))
    if (paths.size === 0) paths.add(expandPath(DEFAULT_TOKEN_PATH))
    const stores = Array.from(paths).map((p) => new TokenStore(p))
    this.pool = new TokenStorePool(stores)
    this.defaultModel = opts.defaultModel ?? 'auto'
    this.maxRetries = opts.maxRetries ?? this.pool.size()
  }

  size(): number {
    return this.pool.size()
  }

  private async requestOnce(req: ChatRequest, store: TokenStore) {
    const { accessToken, profileArn } = await store.get()
    const modelId = mapModel(req.model || this.defaultModel)
    const { conversationId, history, currentMessage } = buildConversation(req, modelId)

    const body = {
      conversationState: {
        conversationId,
        history,
        currentMessage,
        chatTriggerType: 'MANUAL',
        agentTaskType: 'vibe',
      },
      profileArn,
    }

    const res = await fetch(Q_ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-amz-json-1.0',
        'x-amz-target': 'AmazonCodeWhispererStreamingService.GenerateAssistantResponse',
        authorization: `Bearer ${accessToken}`,
        'user-agent': KIRO_USER_AGENT,
        'x-amz-user-agent': KIRO_USER_AGENT,
        'x-amzn-codewhisperer-optout': 'false',
        accept: '*/*',
        'amz-sdk-invocation-id': randomUUID(),
        'amz-sdk-request': 'attempt=1; max=3',
      },
      body: JSON.stringify(body),
    })

    if (res.status === 401) {
      store.invalidate()
      store.cooldown(COOLDOWN_401_MS)
    } else if (res.status === 403) {
      // Token rotated externally (background refresher wrote newer token). Drop
      // in-memory cache so next attempt reloads from disk. No cooldown — the
      // freshly-read token should work immediately.
      store.invalidate()
    } else if (res.status === 429) {
      store.cooldown(COOLDOWN_429_MS)
    }
    if (!res.ok) {
      const text = await res.text()
      const err = new Error(`Kiro error ${res.status}: ${text}`) as Error & { status?: number }
      err.status = res.status
      throw err
    }
    if (!res.body) throw new Error('Kiro: no response body')
    return { body: res.body as unknown as AsyncIterable<Uint8Array>, modelId }
  }

  private async request(req: ChatRequest, _stream: boolean) {
    let lastErr: unknown
    const tries = Math.min(this.maxRetries, this.pool.size())
    for (let i = 0; i < tries; i++) {
      const store = this.pool.next()
      try {
        return await this.requestOnce(req, store)
      } catch (e) {
        const status = (e as { status?: number })?.status
        // 4xx auth/quota → try next account. 5xx/network → also retry next.
        if (status === 401 || status === 429 || status === 403 || !status || status >= 500) {
          lastErr = e
          continue
        }
        // 400/404/etc → bug in our request, don't waste other accounts
        throw e
      }
    }
    throw lastErr ?? new Error('Kiro: all accounts failed')
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const { body, modelId } = await this.request(req, false)
    const { content, toolCalls } = await collectEventStream(body)
    const message: ChatMessage = {
      role: 'assistant',
      content: content || null,
    }
    if (toolCalls.length) message.tool_calls = toolCalls
    return {
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: modelId,
      choices: [
        {
          index: 0,
          message,
          finish_reason: toolCalls.length ? 'tool_calls' : 'stop',
        },
      ],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    }
  }

  async chatStream(req: ChatRequest): Promise<AsyncIterable<string>> {
    const { body, modelId } = await this.request(req, true)
    return eventsToOpenAIStream(body, modelId)
  }
}
