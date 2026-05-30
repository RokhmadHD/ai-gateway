import type { ChatMessage, ChatRequest, ChatResponse, ToolCall, ToolDef } from '../providers/base.js'

export interface EstimatedChatUsage {
  promptTokens: number
  completionTokens: number
  estimated: boolean
}

function textTokens(text: string): number {
  if (!text) return 0
  const words = text.trim().split(/\s+/).filter(Boolean).length
  const chars = Math.ceil(text.length / 4)
  return Math.max(words, chars)
}

function jsonTokens(value: unknown): number {
  if (value === undefined || value === null) return 0
  if (typeof value === 'string') return textTokens(value)
  try {
    return textTokens(JSON.stringify(value))
  } catch {
    return 0
  }
}

function messageContentTokens(content: ChatMessage['content']): number {
  if (typeof content === 'string') return textTokens(content)
  return jsonTokens(content)
}

function toolCallTokens(toolCalls: ToolCall[] | undefined): number {
  if (!toolCalls?.length) return 0
  return toolCalls.reduce(
    (sum, call) =>
      sum +
      textTokens(call.id) +
      textTokens(call.function.name) +
      textTokens(call.function.arguments),
    0,
  )
}

function toolDefTokens(tools: ToolDef[] | undefined): number {
  if (!tools?.length) return 0
  return tools.reduce(
    (sum, tool) =>
      sum +
      textTokens(tool.function.name) +
      textTokens(tool.function.description ?? '') +
      jsonTokens(tool.function.parameters),
    0,
  )
}

function promptTokens(req: ChatRequest): number {
  const messages = req.messages.reduce((sum, msg) => {
    return (
      sum +
      4 +
      textTokens(msg.role) +
      textTokens(msg.name ?? '') +
      textTokens(msg.tool_call_id ?? '') +
      messageContentTokens(msg.content) +
      toolCallTokens(msg.tool_calls)
    )
  }, 2)
  return Math.max(1, messages + toolDefTokens(req.tools) + jsonTokens(req.tool_choice))
}

function completionTokens(result: ChatResponse): number {
  const choices = result.choices ?? []
  const total = choices.reduce((sum, choice) => {
    const msg = choice.message
    return sum + messageContentTokens(msg.content) + toolCallTokens(msg.tool_calls)
  }, 0)
  return Math.max(0, total)
}

export function chatUsageWithEstimate(
  req: ChatRequest,
  result: ChatResponse,
): EstimatedChatUsage {
  const u = result.usage
  const providerPrompt = u?.prompt_tokens ?? 0
  const providerCompletion = u?.completion_tokens ?? 0
  if (providerPrompt > 0 || providerCompletion > 0) {
    return {
      promptTokens: providerPrompt,
      completionTokens: providerCompletion,
      estimated: false,
    }
  }
  return {
    promptTokens: promptTokens(req),
    completionTokens: completionTokens(result),
    estimated: true,
  }
}
