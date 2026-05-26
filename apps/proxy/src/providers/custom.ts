import { fetch } from 'undici'
import type { ChatRequest, ChatResponse, Provider } from './base.js'

export class CustomProvider implements Provider {
  name: string

  constructor(
    name: string,
    private baseUrl: string,
    private apiKey: string,
  ) {
    this.name = name
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify({ ...req, stream: false }),
    })

    if (!res.ok) {
      const err = await res.text()
      throw new Error(`${this.name} error ${res.status}: ${err}`)
    }

    return res.json() as Promise<ChatResponse>
  }

  async chatStream(req: ChatRequest): Promise<AsyncIterable<string>> {
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify({ ...req, stream: true }),
    })

    if (!res.ok) {
      const err = await res.text()
      throw new Error(`${this.name} error ${res.status}: ${err}`)
    }

    if (!res.body) throw new Error('No response body')

    return passthrough(res.body as unknown as AsyncIterable<Uint8Array>)
  }
}

async function* passthrough(body: AsyncIterable<Uint8Array>): AsyncIterable<string> {
  const decoder = new TextDecoder()
  for await (const chunk of body) {
    yield decoder.decode(chunk, { stream: true })
  }
}
