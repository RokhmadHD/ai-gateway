import { fetch } from 'undici'
import type { ChatRequest, ChatResponse, Provider } from './base.js'
import {
  ccHeaders,
  ccSystemBlocks,
  ccMetadata,
  isFreemodelHost,
  splitSystemMessages,
  toAnthropicModel,
  toOpenAIResponse,
  anthropicToOpenAIStream,
  mapAnthropicTools,
  mapAnthropicToolChoice,
} from './anthropic.js'
import type { KeyPool } from '../pools/keyPool.js'
import type { ProxyPool } from '../pools/proxyPool.js'
import { withRotation, type ClassifiedError } from '../pools/rotation.js'
import type { MinimalLogger } from '../pools/scraper.js'

export interface RotatingAnthropicOptions {
  maxRetries?: number
  log?: MinimalLogger
}

export class RotatingAnthropicProvider implements Provider {
  name = 'anthropic-rotating'
  private targetOrigin: string
  private isFreemodel: boolean

  constructor(
    private keys: KeyPool,
    private baseUrl: string,
    private proxies?: ProxyPool,
    private opts: RotatingAnthropicOptions = {},
  ) {
    this.targetOrigin = new URL(baseUrl).origin
    this.isFreemodel = isFreemodelHost(baseUrl)
  }

  private buildBody(req: ChatRequest, stream: boolean): Record<string, unknown> {
    const { system, messages } = splitSystemMessages(req.messages)
    const body: Record<string, unknown> = {
      model: toAnthropicModel(req.model),
      messages,
      max_tokens: req.max_tokens ?? 1024,
    }
    if (stream) body.stream = true
    if (this.isFreemodel) {
      body.system = ccSystemBlocks(system)
      body.metadata = ccMetadata()
    } else if (system) {
      body.system = system
    }
    if (req.temperature !== undefined) body.temperature = req.temperature
    const tools = mapAnthropicTools(req.tools)
    if (tools) body.tools = tools
    const toolChoice = mapAnthropicToolChoice(req.tool_choice)
    if (toolChoice) body.tool_choice = toolChoice
    return body
  }

  private url(): string {
    return this.isFreemodel ? `${this.baseUrl}/messages?beta=true` : `${this.baseUrl}/messages`
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const body = this.buildBody(req, false)
    const url = this.url()
    return withRotation(
      this.keys,
      this.proxies,
      async ({ key, dispatcher }) => {
        const ac = new AbortController()
        const timeoutId = setTimeout(() => ac.abort(), 120000)
        try {
          const res = await fetch(url, {
            method: 'POST',
            headers: ccHeaders(key),
            body: JSON.stringify(body),
            signal: ac.signal,
            dispatcher,
          })
          if (!res.ok) {
            const errText = await res.text().catch(() => '')
            const err = Object.assign(
              new Error(`upstream ${res.status}: ${errText.slice(0, 200)}`),
              { status: res.status, body: errText },
            )
            throw err
          }
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const data = (await res.json()) as any
          // Detect freemodel soft-reject (200 OK with rejection text)
          const text = data?.content?.[0]?.text
          if (typeof text === 'string' && text === 'Please use Claude Code CLI') {
            throw Object.assign(new Error('freemodel rejected: config mismatch'), {
              status: 403,
              softReject: true,
            })
          }
          return toOpenAIResponse(data, req.model)
        } finally {
          clearTimeout(timeoutId)
        }
      },
      {
        maxRetries: this.opts.maxRetries ?? 3,
        targetOrigin: this.targetOrigin,
        classify: classifyAnthropicError,
      },
      this.opts.log,
    )
  }

  async chatStream(req: ChatRequest): Promise<AsyncIterable<string>> {
    const body = this.buildBody(req, true)
    const url = this.url()
    return withRotation(
      this.keys,
      this.proxies,
      async ({ key, dispatcher }) => {
        const ac = new AbortController()
        const res = await fetch(url, {
          method: 'POST',
          headers: ccHeaders(key),
          body: JSON.stringify(body),
          signal: ac.signal,
          dispatcher,
        })
        if (!res.ok) {
          const errText = await res.text().catch(() => '')
          ac.abort()
          throw Object.assign(
            new Error(`upstream ${res.status}: ${errText.slice(0, 200)}`),
            { status: res.status, body: errText },
          )
        }
        if (!res.body) {
          ac.abort()
          throw new Error('No response body')
        }
        // Buffer first chunk to validate it's a real stream (not a soft-reject)
        const bodyIter = res.body as unknown as AsyncIterable<Uint8Array>
        const reader = bodyIter[Symbol.asyncIterator]()
        const first = await reader.next()
        if (first.done) {
          ac.abort()
          throw new Error('empty stream')
        }
        const firstText = new TextDecoder().decode(first.value)
        if (firstText.includes('Please use Claude Code CLI')) {
          ac.abort()
          throw Object.assign(new Error('freemodel rejected: config mismatch'), {
            status: 403,
            softReject: true,
          })
        }
        // Replay buffered first chunk + drain rest
        async function* replay(): AsyncIterable<Uint8Array> {
          yield first.value
          while (true) {
            const n = await reader.next()
            if (n.done) return
            yield n.value
          }
        }
        return anthropicToOpenAIStream(replay(), req.model)
      },
      {
        maxRetries: this.opts.maxRetries ?? 3,
        targetOrigin: this.targetOrigin,
        classify: classifyAnthropicError,
      },
      this.opts.log,
    )
  }
}

function classifyAnthropicError(err: unknown, status?: number): ClassifiedError {
  // Soft-reject from freemodel: actually a config/gate problem, not a key/proxy fault
  if (typeof err === 'object' && err && (err as { softReject?: boolean }).softReject) {
    return { blame: 'fatal', reason: 'other' }
  }
  if (status !== undefined) {
    if (status === 401 || status === 403) return { blame: 'key', reason: 'auth' }
    if (status === 429) return { blame: 'key', reason: 'rate_limit' }
    if (status >= 500) return { blame: 'proxy', reason: 'server' }
    if (status === 400 || status === 404 || status === 422) {
      return { blame: 'fatal', reason: 'other' }
    }
  }
  // Network errors → blame proxy
  const code = (err as { code?: string }).code
  if (
    code === 'ECONNREFUSED' ||
    code === 'ECONNRESET' ||
    code === 'ETIMEDOUT' ||
    code === 'ENOTFOUND' ||
    code === 'EAI_AGAIN' ||
    code === 'UND_ERR_SOCKET' ||
    code === 'UND_ERR_CONNECT_TIMEOUT' ||
    (err as Error).name === 'AbortError'
  ) {
    return { blame: 'proxy', reason: 'network' }
  }
  return { blame: 'proxy', reason: 'other' }
}
