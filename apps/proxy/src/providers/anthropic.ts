import { fetch } from 'undici'
import { randomBytes, randomUUID } from 'node:crypto'
import type {
  ChatMessage,
  ChatRequest,
  ChatResponse,
  Provider,
  ToolCall,
  ToolChoice,
  ToolDef,
} from './base.js'

export const ANTHROPIC_VERSION = '2023-06-01'
export const CC_USER_AGENT = 'claude-cli/2.1.150 (external, sdk-cli)'
export const CC_ANTHROPIC_BETA =
  'claude-code-20250219,context-1m-2025-08-07,interleaved-thinking-2025-05-14,context-management-2025-06-27,prompt-caching-scope-2026-01-05,effort-2025-11-24'
export const CC_BILLING_HEADER =
  'x-anthropic-billing-header: cc_version=2.1.150.474; cc_entrypoint=sdk-cli; cch=15ddd;'
export const CC_AGENT_PREFIX = "You are a Claude agent, built on Anthropic's Claude Agent SDK."

export function ccHeaders(apiKey: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'x-api-key': apiKey,
    Authorization: `Bearer ${apiKey}`,
    'anthropic-version': ANTHROPIC_VERSION,
    'anthropic-beta': CC_ANTHROPIC_BETA,
    'anthropic-dangerous-direct-browser-access': 'true',
    'User-Agent': CC_USER_AGENT,
  }
}

export function ccSystemBlocks(userSystem?: string): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [
    { type: 'text', text: CC_BILLING_HEADER },
    { type: 'text', text: CC_AGENT_PREFIX },
  ]
  if (userSystem) blocks.push({ type: 'text', text: userSystem })
  return blocks
}

export function ccMetadata(): { user_id: string } {
  return {
    user_id: JSON.stringify({
      device_id: randomBytes(32).toString('hex'),
      account_uuid: '',
      session_id: randomUUID(),
    }),
  }
}

export function isFreemodelHost(url: string): boolean {
  return url.includes('freemodel.dev')
}

// Map OpenAI model names to Anthropic equivalents
const MODEL_MAP: Record<string, string> = {
  'gpt-4': 'claude-3-5-sonnet-20241022',
  'gpt-3.5-turbo': 'claude-3-haiku-20240307',
}

export function toAnthropicModel(model: string): string {
  return MODEL_MAP[model] ?? model
}

export function splitSystemMessages(messages: ChatMessage[]): {
  system?: string
  messages: Array<{ role: 'user' | 'assistant'; content: unknown }>
} {
  const sysMsg = messages.find((m) => m.role === 'system')
  const system = typeof sysMsg?.content === 'string' ? sysMsg.content : undefined

  type Block = Record<string, unknown>
  type Turn = { role: 'user' | 'assistant'; content: Block[] }
  const out: Turn[] = []
  let pendingToolResults: Block[] = []

  const pushUserBlocks = (extra: Block[]) => {
    if (extra.length === 0) return
    const last = out[out.length - 1]
    if (last && last.role === 'user') {
      last.content.push(...extra)
    } else {
      out.push({ role: 'user', content: extra })
    }
  }

  for (const m of messages) {
    if (m.role === 'system') continue
    if (m.role === 'tool') {
      const text =
        typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '')
      pendingToolResults.push({
        type: 'tool_result',
        tool_use_id: m.tool_call_id ?? '',
        content: text,
      })
      continue
    }
    if (m.role === 'user') {
      const blocks: Block[] = []
      if (pendingToolResults.length) {
        blocks.push(...pendingToolResults)
        pendingToolResults = []
      }
      if (typeof m.content === 'string' && m.content.length > 0) {
        blocks.push({ type: 'text', text: m.content })
      }
      if (blocks.length === 0) blocks.push({ type: 'text', text: '' })
      pushUserBlocks(blocks)
      continue
    }
    // assistant
    if (pendingToolResults.length) {
      pushUserBlocks(pendingToolResults)
      pendingToolResults = []
    }
    const blocks: Block[] = []
    if (typeof m.content === 'string' && m.content.length > 0) {
      blocks.push({ type: 'text', text: m.content })
    }
    if (m.tool_calls) {
      for (const tc of m.tool_calls) {
        let input: unknown = {}
        try { input = JSON.parse(tc.function.arguments || '{}') } catch { /* */ }
        blocks.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.function.name,
          input,
        })
      }
    }
    if (blocks.length === 0) blocks.push({ type: 'text', text: '' })
    out.push({ role: 'assistant', content: blocks })
  }
  if (pendingToolResults.length) {
    pushUserBlocks(pendingToolResults)
  }
  return { system, messages: out }
}

export function mapAnthropicTools(tools: ToolDef[] | undefined): unknown[] | undefined {
  if (!tools || tools.length === 0) return undefined
  return tools.map((t) => ({
    name: t.function.name,
    description: t.function.description ?? '',
    input_schema: t.function.parameters ?? { type: 'object', properties: {} },
  }))
}

export function mapAnthropicToolChoice(c: ToolChoice | undefined): unknown {
  if (!c) return undefined
  if (c === 'auto') return { type: 'auto' }
  if (c === 'required') return { type: 'any' }
  if (c === 'none') return undefined
  if (typeof c === 'object' && c.type === 'function') {
    return { type: 'tool', name: c.function.name }
  }
  return undefined
}

export class AnthropicProvider implements Provider {
  name = 'anthropic'

  constructor(
    private apiKey: string,
    private baseUrl = 'https://api.anthropic.com/v1',
  ) {}

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const { system, messages } = splitSystemMessages(req.messages)
    const isFreemodel = isFreemodelHost(this.baseUrl)
    const body: Record<string, unknown> = {
      model: toAnthropicModel(req.model),
      messages,
      max_tokens: req.max_tokens ?? 1024,
    }
    if (isFreemodel) {
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

    const url = isFreemodel ? `${this.baseUrl}/messages?beta=true` : `${this.baseUrl}/messages`
    const res = await fetch(url, {
      method: 'POST',
      headers: ccHeaders(this.apiKey),
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      const err = await res.text()
      throw new Error(`Anthropic error ${res.status}: ${err}`)
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = (await res.json()) as any
    return toOpenAIResponse(data, req.model)
  }

  async chatStream(req: ChatRequest): Promise<AsyncIterable<string>> {
    const { system, messages } = splitSystemMessages(req.messages)
    const isFreemodel = isFreemodelHost(this.baseUrl)
    const body: Record<string, unknown> = {
      model: toAnthropicModel(req.model),
      messages,
      max_tokens: req.max_tokens ?? 1024,
      stream: true,
    }
    if (isFreemodel) {
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

    const url = isFreemodel ? `${this.baseUrl}/messages?beta=true` : `${this.baseUrl}/messages`
    const res = await fetch(url, {
      method: 'POST',
      headers: ccHeaders(this.apiKey),
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      const err = await res.text()
      throw new Error(`Anthropic error ${res.status}: ${err}`)
    }

    if (!res.body) throw new Error('No response body')

    return anthropicToOpenAIStream(res.body as unknown as AsyncIterable<Uint8Array>, req.model)
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function toOpenAIResponse(data: any, model: string): ChatResponse {
  let text = ''
  const toolCalls: ToolCall[] = []
  for (const b of data.content ?? []) {
    if (b?.type === 'text' && typeof b.text === 'string') {
      text += b.text
    } else if (b?.type === 'tool_use') {
      toolCalls.push({
        id: b.id,
        type: 'function',
        function: {
          name: b.name,
          arguments: JSON.stringify(b.input ?? {}),
        },
      })
    }
  }
  const message: ChatMessage = {
    role: 'assistant',
    content: text.length > 0 ? text : toolCalls.length ? null : '',
  }
  if (toolCalls.length) message.tool_calls = toolCalls
  const stopReason = data.stop_reason
  const finishReason =
    stopReason === 'tool_use'
      ? 'tool_calls'
      : stopReason === 'end_turn'
        ? 'stop'
        : stopReason === 'max_tokens'
          ? 'length'
          : (stopReason ?? 'stop')
  return {
    id: data.id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: finishReason,
      },
    ],
    usage: {
      prompt_tokens: data.usage?.input_tokens ?? 0,
      completion_tokens: data.usage?.output_tokens ?? 0,
      total_tokens: (data.usage?.input_tokens ?? 0) + (data.usage?.output_tokens ?? 0),
    },
  }
}

export async function* anthropicToOpenAIStream(
  body: AsyncIterable<Uint8Array>,
  model: string,
): AsyncIterable<string> {
  const decoder = new TextDecoder()
  let buf = ''
  const chatId = `chatcmpl-${Date.now()}`

  type ToolBlock = { id: string; name: string; index: number }
  const toolBlocks = new Map<number, ToolBlock>()
  let nextToolIndex = 0
  let finishReason: string | null = 'stop'
  let finishSent = false

  const emit = (delta: Record<string, unknown>, finish: string | null = null) => {
    const chunk = {
      id: chatId,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    }
    return `data: ${JSON.stringify(chunk)}\n\n`
  }

  for await (const chunk of body) {
    buf += decoder.decode(chunk, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      const raw = line.slice(6).trim()
      if (!raw || raw === '[DONE]') continue
      try {
        const ev = JSON.parse(raw)
        if (ev.type === 'content_block_start' && ev.content_block?.type === 'tool_use') {
          const idx = nextToolIndex++
          const block: ToolBlock = {
            id: ev.content_block.id,
            name: ev.content_block.name,
            index: idx,
          }
          toolBlocks.set(ev.index, block)
          yield emit({
            tool_calls: [
              {
                index: idx,
                id: block.id,
                type: 'function',
                function: { name: block.name, arguments: '' },
              },
            ],
          })
        } else if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
          yield emit({ content: ev.delta.text })
        } else if (
          ev.type === 'content_block_delta' &&
          ev.delta?.type === 'input_json_delta'
        ) {
          const block = toolBlocks.get(ev.index)
          if (!block) continue
          yield emit({
            tool_calls: [
              {
                index: block.index,
                function: { arguments: ev.delta.partial_json ?? '' },
              },
            ],
          })
        } else if (ev.type === 'message_delta' && ev.delta?.stop_reason) {
          const sr = ev.delta.stop_reason
          finishReason =
            sr === 'tool_use'
              ? 'tool_calls'
              : sr === 'end_turn'
                ? 'stop'
                : sr === 'max_tokens'
                  ? 'length'
                  : sr
        } else if (ev.type === 'message_stop') {
          if (!finishSent) {
            yield emit({}, finishReason ?? 'stop')
            yield 'data: [DONE]\n\n'
            finishSent = true
          }
        }
      } catch {
        // skip malformed
      }
    }
  }
  if (!finishSent) {
    yield emit({}, finishReason ?? 'stop')
    yield 'data: [DONE]\n\n'
  }
}
