import { fetch } from 'undici'
import type { ChatRequest, ChatResponse, Provider } from './base.js'

const OPENAI_BASE = 'https://api.openai.com/v1'

export class OpenAIProvider implements Provider {
  name = 'openai'

  constructor(private apiKey: string) {}

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const res = await fetch(`${OPENAI_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ ...req, stream: false }),
    })

    if (!res.ok) {
      const err = await res.text()
      throw new Error(`OpenAI error ${res.status}: ${err}`)
    }

    return res.json() as Promise<ChatResponse>
  }

  async chatStream(req: ChatRequest): Promise<AsyncIterable<string>> {
    const res = await fetch(`${OPENAI_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ ...req, stream: true }),
    })

    if (!res.ok) {
      const err = await res.text()
      throw new Error(`OpenAI error ${res.status}: ${err}`)
    }

    if (!res.body) throw new Error('No response body')

    return streamLines(res.body as unknown as AsyncIterable<Uint8Array>)
  }
}

async function* streamLines(body: AsyncIterable<Uint8Array>): AsyncIterable<string> {
  const decoder = new TextDecoder()
  let buf = ''
  for await (const chunk of body) {
    buf += decoder.decode(chunk, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop() ?? ''
    for (const line of lines) {
      if (line.startsWith('data: ')) yield line + '\n'
    }
  }
  if (buf.startsWith('data: ')) yield buf + '\n'
}
