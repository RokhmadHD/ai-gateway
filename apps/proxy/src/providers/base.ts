export interface ToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface ToolFunctionDef {
  name: string
  description?: string
  parameters?: Record<string, unknown>
}

export interface ToolDef {
  type: 'function'
  function: ToolFunctionDef
}

export type ToolChoice =
  | 'auto'
  | 'none'
  | 'required'
  | { type: 'function'; function: { name: string } }

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: ToolCall[]
  tool_call_id?: string
  name?: string
}

export interface ChatRequest {
  model: string
  messages: ChatMessage[]
  stream?: boolean
  temperature?: number
  max_tokens?: number
  tools?: ToolDef[]
  tool_choice?: ToolChoice
}

export interface ChatResponse {
  id: string
  object: 'chat.completion'
  created: number
  model: string
  choices: Array<{
    index: number
    message: ChatMessage
    finish_reason: string
  }>
  usage: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  }
}

export interface Provider {
  name: string
  chat(req: ChatRequest): Promise<ChatResponse>
  chatStream(req: ChatRequest): Promise<AsyncIterable<string>>
}
