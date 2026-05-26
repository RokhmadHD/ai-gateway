import { fetch } from 'undici'
import {
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  statSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { resolve, join } from 'node:path'
import { randomUUID, randomBytes } from 'node:crypto'
import type {
  ChatMessage,
  ChatRequest,
  ChatResponse,
  Provider,
  ToolCall,
  ToolDef,
} from './base.js'

const CODE_ASSIST_ORIGIN = 'https://cloudcode-pa.googleapis.com'
const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token'
// Use environment variables for OAuth credentials
export const GEMINI_OAUTH_CLIENT_ID =
  process.env.GEMINI_OAUTH_CLIENT_ID || ''
export const GEMINI_OAUTH_CLIENT_SECRET =
  process.env.GEMINI_OAUTH_CLIENT_SECRET || ''
export const GEMINI_OAUTH_SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
]
const DEFAULT_TOKEN_PATH = '~/.gemini/oauth_creds.json'
const REFRESH_LEEWAY_MS = 60_000
const UA = 'GeminiCLI/0.43.0 (linux; x64)'

// ─── Free-tier preemptive budget (Code Assist personal Google account) ──────
// Caps per official Gemini Code Assist free tier limits. We track sliding
// 60-second windows so we skip the account *before* upstream returns 429.
// PT-day boundary matches Google's quota reset.
const RPM_WINDOW_MS = 60_000
const ACCOUNT_RPM_CAP = 60
const ACCOUNT_RPD_CAP = 1000
const MODEL_RPM_CAP = 5

function ptDayBucket(now: number): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(now))
}

class RateBudget {
  private times: number[] = []
  private dayKey = ptDayBucket(Date.now())
  private dayCount = 0
  constructor(
    private rpm: number,
    private rpd?: number,
  ) {}
  canConsume(now: number = Date.now()): boolean {
    this.prune(now)
    if (this.times.length >= this.rpm) return false
    if (this.rpd !== undefined && this.dayCount >= this.rpd) return false
    return true
  }
  record(now: number = Date.now()): void {
    this.prune(now)
    this.times.push(now)
    this.dayCount++
  }
  private prune(now: number): void {
    const cutoff = now - RPM_WINDOW_MS
    while (this.times.length && this.times[0] < cutoff) this.times.shift()
    const today = ptDayBucket(now)
    if (today !== this.dayKey) {
      this.dayKey = today
      this.dayCount = 0
    }
  }
}

const MODEL_ALIAS: Record<string, string> = {
  'gpt-4': 'gemini-3-flash-preview',
  'gpt-4o': 'gemini-3-flash-preview',
  'gpt-3.5-turbo': 'gemini-3.1-flash-lite',
  'gemini-pro': 'gemini-3-flash-preview',
  'gemini-flash': 'gemini-3-flash-preview',
}

interface TokenCache {
  access_token: string
  refresh_token: string
  scope?: string
  token_type?: string
  id_token?: string
  expiry_date: number
  /** Cached Code Assist project id (auto-generated per Google account). */
  cloudaicompanion_project?: string
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
  private bootstrapping?: Promise<string>
  private cooldownUntil = 0
  private accountBudget = new RateBudget(ACCOUNT_RPM_CAP, ACCOUNT_RPD_CAP)
  private modelBudgets = new Map<string, RateBudget>()

  constructor(path?: string) {
    this.path = expandPath(path ?? DEFAULT_TOKEN_PATH)
  }

  private load(): TokenCache {
    if (!existsSync(this.path)) {
      throw new Error(`Gemini token cache not found at ${this.path}. Run gemini-add-account first.`)
    }
    const raw = readFileSync(this.path, 'utf-8')
    try { this.cacheMtimeMs = statSync(this.path).mtimeMs } catch { this.cacheMtimeMs = 0 }
    return JSON.parse(raw) as TokenCache
  }

  private save(t: TokenCache): void {
    writeFileSync(this.path, JSON.stringify(t, null, 2), { mode: 0o600 })
    try { this.cacheMtimeMs = statSync(this.path).mtimeMs } catch { /* */ }
  }

  private maybeInvalidateOnDiskChange(): void {
    if (!this.cache) return
    try {
      const m = statSync(this.path).mtimeMs
      if (m > this.cacheMtimeMs) this.cache = undefined
    } catch { /* */ }
  }

  private isExpired(t: TokenCache): boolean {
    if (!t.expiry_date) return true
    return t.expiry_date - Date.now() < REFRESH_LEEWAY_MS
  }

  isAvailable(): boolean { return Date.now() >= this.cooldownUntil }
  cooldown(ms: number): void { this.cooldownUntil = Date.now() + ms }
  invalidate(): void { this.cache = undefined }

  private modelBudget(model: string): RateBudget {
    let b = this.modelBudgets.get(model)
    if (!b) {
      b = new RateBudget(MODEL_RPM_CAP)
      this.modelBudgets.set(model, b)
    }
    return b
  }

  canUseModel(model: string): boolean {
    return this.accountBudget.canConsume() && this.modelBudget(model).canConsume()
  }

  recordUse(model: string): void {
    const now = Date.now()
    this.accountBudget.record(now)
    this.modelBudget(model).record(now)
  }

  /** True if the account is permanently broken (chain-dead) per disk state. */
  isDead(): boolean {
    this.maybeInvalidateOnDiskChange()
    if (!this.cache) {
      try { this.cache = this.load() } catch { return false }
    }
    return this.cache?._chainDead === true
  }

  async get(): Promise<{ accessToken: string; project: string }> {
    this.maybeInvalidateOnDiskChange()
    if (!this.cache) this.cache = this.load()
    if (this.cache._chainDead) {
      throw Object.assign(
        new Error(
          `Gemini account at ${this.path} unavailable (${this.cache._chainDeadReason ?? 'chain dead'})`,
        ),
        { status: 401, chainDead: true },
      )
    }
    if (this.isExpired(this.cache)) {
      if (!this.refreshing) this.refreshing = this.refresh(this.cache.refresh_token)
      try { this.cache = await this.refreshing } finally { this.refreshing = undefined }
    }
    let project = this.cache.cloudaicompanion_project
    if (!project) {
      if (!this.bootstrapping) this.bootstrapping = this.bootstrapProject(this.cache.access_token)
      try {
        project = await this.bootstrapping
        this.cache = { ...this.cache, cloudaicompanion_project: project }
        this.save(this.cache)
      } catch (e) {
        // Persist permanent failures (not eligible, etc.) so we stop retrying.
        const err = e as { status?: number; ineligible?: boolean; message?: string }
        if (err.ineligible && this.cache) {
          const dead: TokenCache = {
            ...this.cache,
            _chainDead: true,
            _chainDeadAt: new Date().toISOString(),
            _chainDeadReason: err.message?.slice(0, 200) ?? 'ineligible',
          }
          try { this.save(dead); this.cache = dead } catch { /* */ }
        }
        throw e
      } finally {
        this.bootstrapping = undefined
      }
    }
    return { accessToken: this.cache.access_token, project }
  }

  private async refresh(refresh_token: string): Promise<TokenCache> {
    const body = new URLSearchParams({
      client_id: GEMINI_OAUTH_CLIENT_ID,
      client_secret: GEMINI_OAUTH_CLIENT_SECRET,
      refresh_token,
      grant_type: 'refresh_token',
    })
    const res = await fetch(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    })
    if (!res.ok) {
      const text = await res.text()
      if (res.status === 400 || res.status === 401) {
        if (this.cache) {
          const dead: TokenCache = {
            ...this.cache,
            _chainDead: true,
            _chainDeadAt: new Date().toISOString(),
            _chainDeadReason: `refresh ${res.status}: ${text.slice(0, 200)}`,
          }
          try { this.save(dead); this.cache = dead } catch { /* */ }
        }
        throw Object.assign(
          new Error(`Gemini refresh chain dead — re-auth required (${text.slice(0, 120)})`),
          { status: 401, chainDead: true },
        )
      }
      throw new Error(`Gemini refresh failed ${res.status}: ${text}`)
    }
    const data = (await res.json()) as {
      access_token: string
      expires_in: number
      token_type: string
      scope?: string
      id_token?: string
      refresh_token?: string
    }
    const merged: TokenCache = {
      ...(this.cache ?? ({} as TokenCache)),
      access_token: data.access_token,
      refresh_token: data.refresh_token ?? refresh_token,
      scope: data.scope ?? this.cache?.scope,
      token_type: data.token_type ?? this.cache?.token_type ?? 'Bearer',
      id_token: data.id_token ?? this.cache?.id_token,
      expiry_date: Date.now() + data.expires_in * 1000,
    }
    this.save(merged)
    return merged
  }

  /** Resolve cloudaicompanionProject. Onboards if not yet onboarded. */
  private async bootstrapProject(accessToken: string): Promise<string> {
    const load = await fetch(`${CODE_ASSIST_ORIGIN}/v1internal:loadCodeAssist`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
        'User-Agent': UA,
      },
      body: JSON.stringify({
        metadata: { ideType: 'IDE_UNSPECIFIED', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI' },
      }),
    })
    if (!load.ok) {
      throw Object.assign(
        new Error(`Gemini loadCodeAssist ${load.status}: ${await load.text()}`),
        { status: load.status },
      )
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const loadJson = (await load.json()) as any
    if (typeof loadJson?.cloudaicompanionProject === 'string') {
      return loadJson.cloudaicompanionProject
    }
    // Need to onboard.
    const onboard = await fetch(`${CODE_ASSIST_ORIGIN}/v1internal:onboardUser`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
        'User-Agent': UA,
      },
      body: JSON.stringify({
        tierId: 'free-tier',
        metadata: { ideType: 'IDE_UNSPECIFIED', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI' },
      }),
    })
    if (!onboard.ok) {
      const text = await onboard.text()
      const ineligible =
        onboard.status === 403 &&
        (text.includes('FREE_TIER_USER_NOT_ELIGIBLE') ||
          text.includes('not eligible'))
      throw Object.assign(
        new Error(`Gemini onboardUser ${onboard.status}: ${text}`),
        { status: onboard.status, ineligible },
      )
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const op = (await onboard.json()) as any
    const opName: string | undefined = op?.name
    if (!opName) throw new Error('Gemini onboardUser: missing operation name')
    // Poll LRO
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 1000))
      const poll = await fetch(`${CODE_ASSIST_ORIGIN}/v1internal/${opName}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${accessToken}`, 'User-Agent': UA },
      })
      if (!poll.ok) continue
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pj = (await poll.json()) as any
      if (pj?.done) {
        const proj = pj?.response?.cloudaicompanionProject?.id
        if (typeof proj === 'string') return proj
        throw new Error(`Gemini onboard: unexpected response ${JSON.stringify(pj).slice(0, 200)}`)
      }
    }
    throw new Error('Gemini onboardUser: timeout waiting for LRO')
  }
}

class TokenStorePool {
  private stores: TokenStore[]
  private cursor = 0
  constructor(stores: TokenStore[]) {
    if (stores.length === 0) throw new Error('Gemini: no token stores configured')
    this.stores = stores
  }
  size(): number { return this.stores.length }
  /** Pick next available, non-dead store with budget for `model` in RR order. */
  next(model: string): TokenStore {
    for (let i = 0; i < this.stores.length; i++) {
      const idx = (this.cursor + i) % this.stores.length
      const s = this.stores[idx]
      if (s.isAvailable() && !s.isDead() && s.canUseModel(model)) {
        this.cursor = (idx + 1) % this.stores.length
        return s
      }
    }
    const err = new Error(
      'Gemini: all accounts in cooldown / quota / ineligible',
    ) as Error & { status?: number }
    err.status = 429
    throw err
  }
}

function discoverTokenFiles(dir: string): string[] {
  // Admin now writes tokens to <base>/<tenant_slug>/acc-*.json. Older deploys
  // had them flat at <base>/acc-*.json. Scan both layouts so the proxy works
  // either way until per-tenant routing is wired through (S6.5+).
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
  return model || 'gemini-3-flash-preview'
}

// ---------------- request translation ----------------
// thoughtSignature is a per-turn opaque blob the upstream requires us to relay
// back inside assistant→model turns that contain functionCall parts. Since the
// OpenAI protocol has no place for it, we stash it inside the first tool_call.id
// using a sentinel separator. Clients echo the id verbatim, so it round-trips.
const TS_SEP = '~~ts~~'
function encodeIdWithSig(id: string, sig: string | undefined): string {
  if (!sig) return id
  return `${id}${TS_SEP}${Buffer.from(sig, 'utf8').toString('base64url')}`
}
function decodeIdAndSig(id: string): { id: string; sig?: string } {
  const i = id.indexOf(TS_SEP)
  if (i < 0) return { id }
  return {
    id: id.slice(0, i),
    sig: Buffer.from(id.slice(i + TS_SEP.length), 'base64url').toString('utf8'),
  }
}

interface GeminiPart {
  text?: string
  thought?: boolean
  thoughtSignature?: string
  functionCall?: { name: string; args: Record<string, unknown> }
  functionResponse?: { name: string; response: Record<string, unknown>; id?: string }
}
interface GeminiContent { role: 'user' | 'model'; parts: GeminiPart[] }

function findToolCallName(messages: ChatMessage[], tool_call_id: string): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== 'assistant' || !m.tool_calls) continue
    const hit = m.tool_calls.find((tc) => tc.id === tool_call_id)
    if (hit) return hit.function.name
  }
  return 'unknown'
}

function safeParseObject(s: string | undefined | null): Record<string, unknown> {
  if (!s) return {}
  try {
    const v = JSON.parse(s)
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
  } catch { return {} }
}

function buildContents(messages: ChatMessage[]): {
  systemInstruction?: { role: 'user'; parts: GeminiPart[] }
  contents: GeminiContent[]
} {
  let systemText = ''
  const contents: GeminiContent[] = []
  const pushUserParts = (parts: GeminiPart[]) => {
    if (parts.length === 0) return
    const last = contents[contents.length - 1]
    if (last && last.role === 'user') last.parts.push(...parts)
    else contents.push({ role: 'user', parts })
  }
  for (const m of messages) {
    if (m.role === 'system') {
      systemText += (systemText ? '\n\n' : '') + (typeof m.content === 'string' ? m.content : '')
      continue
    }
    if (m.role === 'tool') {
      const name = findToolCallName(messages, m.tool_call_id ?? '')
      const { id: decodedId } = decodeIdAndSig(m.tool_call_id ?? '')
      let response: Record<string, unknown>
      const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '')
      try {
        const parsed = JSON.parse(text)
        response =
          parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : { result: parsed }
      } catch {
        response = { result: text }
      }
      pushUserParts([{ functionResponse: { name, response, id: decodedId } }])
      continue
    }
    if (m.role === 'user') {
      const text = typeof m.content === 'string' ? m.content : ''
      pushUserParts(text ? [{ text }] : [{ text: '' }])
      continue
    }
    // assistant
    const parts: GeminiPart[] = []
    let assistantSig: string | undefined
    if (typeof m.content === 'string' && m.content.length > 0) {
      parts.push({ text: m.content })
    }
    if (m.tool_calls) {
      for (let ti = 0; ti < m.tool_calls.length; ti++) {
        const tc = m.tool_calls[ti]
        const { sig } = decodeIdAndSig(tc.id)
        if (sig && !assistantSig) assistantSig = sig
        const part: GeminiPart = {
          functionCall: { name: tc.function.name, args: safeParseObject(tc.function.arguments) },
        }
        // Upstream emits thoughtSignature on the SAME part as the functionCall.
        // Stash it on the first functionCall part so the model accepts the turn.
        if (ti === 0 && assistantSig) part.thoughtSignature = assistantSig
        parts.push(part)
      }
    }
    if (parts.length === 0) parts.push({ text: '' })
    contents.push({ role: 'model', parts })
  }
  if (contents.length === 0) contents.push({ role: 'user', parts: [{ text: '' }] })
  const systemInstruction = systemText
    ? { role: 'user' as const, parts: [{ text: systemText }] }
    : undefined
  return { systemInstruction, contents }
}

function mapTools(tools: ToolDef[] | undefined): unknown[] | undefined {
  if (!tools || tools.length === 0) return undefined
  return [
    {
      functionDeclarations: tools.map((t) => ({
        name: t.function.name,
        description: t.function.description ?? '',
        parametersJsonSchema:
          t.function.parameters ?? { type: 'object', properties: {} },
      })),
    },
  ]
}

// ---------------- SSE decoder ----------------
async function* decodeSse(
  body: AsyncIterable<Uint8Array>,
): AsyncIterable<unknown> {
  const td = new TextDecoder()
  let buf = ''
  for await (const chunk of body) {
    buf += td.decode(chunk, { stream: true })
    let idx: number
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, '')
      buf = buf.slice(idx + 1)
      if (!line.startsWith('data: ')) continue
      const raw = line.slice(6).trim()
      if (!raw) continue
      try { yield JSON.parse(raw) } catch { /* ignore */ }
    }
  }
}

function mapFinishReason(fr: string | undefined, hadToolCall: boolean): string {
  if (hadToolCall) return 'tool_calls'
  if (!fr) return 'stop'
  if (fr === 'STOP') return 'stop'
  if (fr === 'MAX_TOKENS') return 'length'
  if (fr === 'SAFETY' || fr === 'RECITATION' || fr === 'BLOCKLIST' || fr === 'PROHIBITED_CONTENT') {
    return 'content_filter'
  }
  return fr.toLowerCase()
}

function newCallId(): string { return `call_${randomBytes(12).toString('hex')}` }

interface CollectedGemini {
  content: string
  toolCalls: ToolCall[]
  finishReason: string
  usage: { prompt: number; completion: number; total: number }
}

async function collectGemini(body: AsyncIterable<Uint8Array>): Promise<CollectedGemini> {
  let text = ''
  const toolCalls: ToolCall[] = []
  let pendingSig: string | undefined
  let finishReason: string | undefined
  let usage = { prompt: 0, completion: 0, total: 0 }
  for await (const ev of decodeSse(body)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = (ev as any)?.response
    if (!r) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const err = (ev as any)?.error || (Array.isArray(ev) && (ev[0] as any)?.error)
      if (err) {
        throw Object.assign(new Error(`Gemini: ${err.message ?? JSON.stringify(err)}`), {
          status: err.code ?? 500,
        })
      }
      continue
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cand = r?.candidates?.[0] as any
    if (cand?.finishReason) finishReason = cand.finishReason
    const parts: GeminiPart[] = cand?.content?.parts ?? []
    for (const p of parts) {
      if (p.thought) continue
      if (typeof p.thoughtSignature === 'string') pendingSig = p.thoughtSignature
      if (typeof p.text === 'string') text += p.text
      if (p.functionCall) {
        toolCalls.push({
          id: newCallId(),
          type: 'function',
          function: {
            name: p.functionCall.name,
            arguments: JSON.stringify(p.functionCall.args ?? {}),
          },
        })
      }
    }
    if (r?.usageMetadata) {
      usage = {
        prompt: r.usageMetadata.promptTokenCount ?? 0,
        completion: r.usageMetadata.candidatesTokenCount ?? 0,
        total: r.usageMetadata.totalTokenCount ?? 0,
      }
    }
  }
  // Stash signature on the first tool_call.id so it round-trips back to upstream
  // on the next turn (required for gemini-3 thinking models).
  if (pendingSig && toolCalls.length > 0) {
    toolCalls[0] = { ...toolCalls[0], id: encodeIdWithSig(toolCalls[0].id, pendingSig) }
  }
  return { content: text, toolCalls, finishReason: mapFinishReason(finishReason, toolCalls.length > 0), usage }
}

async function* geminiToOpenAIStream(
  body: AsyncIterable<Uint8Array>,
  model: string,
): AsyncIterable<string> {
  const chatId = `chatcmpl-${Date.now()}`
  let finishReason: string | undefined
  // Buffer tool calls because the thoughtSignature may arrive in a separate
  // event AFTER the functionCall, and we need to stash it on the FIRST
  // tool_call's id before emitting.
  interface PendingTC { name: string; argsStr: string; id: string }
  const pending: PendingTC[] = []
  let pendingSig: string | undefined
  const emit = (delta: Record<string, unknown>, finish: string | null = null) =>
    `data: ${JSON.stringify({
      id: chatId,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`
  for await (const ev of decodeSse(body)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = (ev as any)?.response
    if (!r) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const err = (ev as any)?.error || (Array.isArray(ev) && (ev[0] as any)?.error)
      if (err) {
        throw Object.assign(new Error(`Gemini: ${err.message ?? JSON.stringify(err)}`), {
          status: err.code ?? 500,
        })
      }
      continue
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cand = r?.candidates?.[0] as any
    if (cand?.finishReason) finishReason = cand.finishReason
    const parts: GeminiPart[] = cand?.content?.parts ?? []
    for (const p of parts) {
      if (p.thought) continue
      if (typeof p.thoughtSignature === 'string') pendingSig = p.thoughtSignature
      if (typeof p.text === 'string' && p.text.length > 0) {
        yield emit({ content: p.text })
      }
      if (p.functionCall) {
        pending.push({
          name: p.functionCall.name,
          argsStr: JSON.stringify(p.functionCall.args ?? {}),
          id: newCallId(),
        })
      }
    }
  }
  // Flush tool calls (with signature stashed on the first id).
  if (pending.length > 0 && pendingSig) {
    pending[0] = { ...pending[0], id: encodeIdWithSig(pending[0].id, pendingSig) }
  }
  for (let i = 0; i < pending.length; i++) {
    const tc = pending[i]
    yield emit({
      tool_calls: [{ index: i, id: tc.id, type: 'function', function: { name: tc.name, arguments: '' } }],
    })
    yield emit({ tool_calls: [{ index: i, function: { arguments: tc.argsStr } }] })
  }
  yield emit({}, mapFinishReason(finishReason, pending.length > 0))
  yield 'data: [DONE]\n\n'
}

// ---------------- provider ----------------
export interface GeminiProviderOptions {
  tokenCache?: string
  tokenCaches?: string[]
  accountDir?: string
  defaultModel?: string
  maxRetries?: number
  thinkingLevel?: 'OFF' | 'LOW' | 'MEDIUM' | 'HIGH'
  includeThoughts?: boolean
}

const COOLDOWN_429_MS = 60_000
const COOLDOWN_401_MS = 300_000

export class GeminiProvider implements Provider {
  name = 'gemini'
  private pool: TokenStorePool
  private defaultModel: string
  private maxRetries: number
  private thinkingLevel: 'OFF' | 'LOW' | 'MEDIUM' | 'HIGH'
  private includeThoughts: boolean

  constructor(opts: GeminiProviderOptions = {}) {
    const paths = new Set<string>()
    if (opts.tokenCaches) opts.tokenCaches.forEach((p) => paths.add(expandPath(p)))
    if (opts.accountDir) discoverTokenFiles(opts.accountDir).forEach((p) => paths.add(p))
    if (opts.tokenCache) paths.add(expandPath(opts.tokenCache))
    if (paths.size === 0) paths.add(expandPath(DEFAULT_TOKEN_PATH))
    this.pool = new TokenStorePool(Array.from(paths).map((p) => new TokenStore(p)))
    this.defaultModel = opts.defaultModel ?? 'gemini-3-flash-preview'
    this.maxRetries = opts.maxRetries ?? this.pool.size()
    this.thinkingLevel = opts.thinkingLevel ?? 'OFF'
    this.includeThoughts = opts.includeThoughts ?? false
  }

  size(): number { return this.pool.size() }

  private buildBody(req: ChatRequest, modelId: string, project: string): Record<string, unknown> {
    const { systemInstruction, contents } = buildContents(req.messages)
    const tools = mapTools(req.tools)
    const generationConfig: Record<string, unknown> = {}
    if (req.temperature !== undefined) generationConfig.temperature = req.temperature
    if (req.max_tokens !== undefined) generationConfig.maxOutputTokens = req.max_tokens
    if (this.thinkingLevel === 'OFF') {
      // Gemini-3 models default to thinking ON, which makes the upstream require
      // thoughtSignature relay for every model turn — impossible from an OpenAI
      // client. Explicitly disable to allow stateless multi-turn.
      generationConfig.thinkingConfig = { thinkingBudget: 0, includeThoughts: false }
    } else {
      generationConfig.thinkingConfig = {
        thinkingLevel: this.thinkingLevel,
        includeThoughts: this.includeThoughts,
      }
    }
    const request: Record<string, unknown> = { contents, session_id: randomUUID() }
    if (systemInstruction) request.systemInstruction = systemInstruction
    if (tools) request.tools = tools
    if (Object.keys(generationConfig).length) request.generationConfig = generationConfig
    return {
      model: modelId,
      project,
      user_prompt_id: `${randomUUID()}########0`,
      request,
    }
  }

  private async requestOnce(req: ChatRequest, store: TokenStore) {
    const { accessToken, project } = await store.get()
    const modelId = mapModel(req.model || this.defaultModel)
    const body = this.buildBody(req, modelId, project)
    const res = await fetch(`${CODE_ASSIST_ORIGIN}/v1internal:streamGenerateContent?alt=sse`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'User-Agent': UA,
        'x-goog-api-client': 'gl-node/22.0.0',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
    })
    if (res.status === 401) {
      store.invalidate(); store.cooldown(COOLDOWN_401_MS)
    } else if (res.status === 403) {
      store.invalidate()
    } else if (res.status === 429) {
      store.cooldown(COOLDOWN_429_MS)
    }
    if (!res.ok) {
      const text = await res.text()
      const err = new Error(`Gemini error ${res.status}: ${text.slice(0, 300)}`) as Error & { status?: number }
      err.status = res.status
      throw err
    }
    if (!res.body) throw new Error('Gemini: no response body')
    return { body: res.body as unknown as AsyncIterable<Uint8Array>, modelId }
  }

  private async request(req: ChatRequest) {
    let lastErr: unknown
    const tries = Math.min(this.maxRetries, this.pool.size())
    const modelId = mapModel(req.model || this.defaultModel)
    for (let i = 0; i < tries; i++) {
      const store = this.pool.next(modelId)
      store.recordUse(modelId)
      try {
        return await this.requestOnce(req, store)
      } catch (e) {
        const status = (e as { status?: number })?.status
        if (status === 401 || status === 429 || status === 403 || !status || status >= 500) {
          lastErr = e
          continue
        }
        throw e
      }
    }
    throw lastErr ?? new Error('Gemini: all accounts failed')
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const { body, modelId } = await this.request(req)
    const { content, toolCalls, finishReason, usage } = await collectGemini(body)
    const message: ChatMessage = {
      role: 'assistant',
      content: content.length > 0 ? content : toolCalls.length ? null : '',
    }
    if (toolCalls.length) message.tool_calls = toolCalls
    return {
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: modelId,
      choices: [{ index: 0, message, finish_reason: finishReason }],
      usage: {
        prompt_tokens: usage.prompt,
        completion_tokens: usage.completion,
        total_tokens: usage.total,
      },
    }
  }

  async chatStream(req: ChatRequest): Promise<AsyncIterable<string>> {
    const { body, modelId } = await this.request(req)
    return geminiToOpenAIStream(body, modelId)
  }
}
