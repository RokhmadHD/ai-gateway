import { AutoRouter, pickCandidates, runAutoChat, AutoRunError } from '../src/routes/autoRouter.js'
import { RotationExhaustedError } from '../src/pools/rotation.js'
import type { ConfigSnapshot } from '@ai-gateway/shared'
import type { Provider, ChatRequest, ChatResponse } from '../src/providers/base.js'

const snap = {
  tenantId: 't1',
  providers: [
    {
      id: 'p1', slug: 'fake-openai', name: 'fake', type: 'openai',
      baseUrl: '', isActive: true, rotationStrategy: 'round_robin', maxRetries: 3, timeoutMs: 60000,
      config: { default_model: 'gpt-x' },
      keys: [{ id: 'k1', label: 'a', secret: 's1', status: 'active', weight: 1, cooldownUntil: null, failureCount: 0, successCount: 0 }],
    },
    {
      id: 'p2', slug: 'fake-anthropic', name: 'fake2', type: 'anthropic',
      baseUrl: '', isActive: true, rotationStrategy: 'round_robin', maxRetries: 3, timeoutMs: 60000,
      config: { default_model: 'claude-x' },
      keys: [{ id: 'k2', label: 'b', secret: 's2', status: 'active', weight: 1, cooldownUntil: null, failureCount: 0, successCount: 0 }],
    },
    {
      id: 'p3', slug: 'excluded', name: 'x', type: 'openai',
      baseUrl: '', isActive: true, rotationStrategy: 'round_robin', maxRetries: 3, timeoutMs: 60000,
      config: { default_model: 'g', aig_auto_excluded: true },
      keys: [{ id: 'k3', label: 'c', secret: 's3', status: 'active', weight: 1, cooldownUntil: null, failureCount: 0, successCount: 0 }],
    },
    {
      id: 'p4', slug: 'inactive', name: 'i', type: 'openai',
      baseUrl: '', isActive: false, rotationStrategy: 'round_robin', maxRetries: 3, timeoutMs: 60000,
      config: { default_model: 'g' },
      keys: [{ id: 'k4', label: 'd', secret: 's4', status: 'active', weight: 1, cooldownUntil: null, failureCount: 0, successCount: 0 }],
    },
  ],
} as unknown as ConfigSnapshot

const candidates = pickCandidates(snap)
console.log('candidates:', candidates.map(c => `${c.slug}(model=${c.defaultModel})`))

const callCount = new Map<string, number>()
const buildProvider = (slug: string): Provider => ({
  name: slug,
  async chat(req: ChatRequest): Promise<ChatResponse> {
    callCount.set(slug, (callCount.get(slug) ?? 0) + 1)
    return {
      id: 'x', object: 'chat.completion', created: 0, model: req.model,
      choices: [{ index: 0, message: { role: 'assistant', content: `from-${slug}` }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    }
  },
  async chatStream() { throw new Error('not used') }
})

const router = new AutoRouter({ tenantSlug: 'test' })

async function main() {
  console.log('\n=== 5 RR runs (expect alternating fake-openai/fake-anthropic) ===')
  for (let i = 0; i < 5; i++) {
    const res = await runAutoChat({ model: 'aig-auto', messages: [{role:'user',content:'hi'}] }, candidates, buildProvider, router)
    console.log(`#${i+1}: provider=${res.meta.provider.slug} model=${res.meta.modelUsed}`)
  }
  console.log('callCount:', Object.fromEntries(callCount))

  console.log('\n=== retry-next: fake-openai returns 500 ===')
  callCount.clear()
  const bad: Provider = {
    name: 'bad',
    async chat(): Promise<ChatResponse> {
      const e = new Error('upstream 500') as Error & {status?:number}
      e.status = 500
      throw e
    },
    async chatStream() { throw new Error('na') }
  }
  const buildProvider2 = (slug: string): Provider => slug === 'fake-openai' ? bad : buildProvider(slug)
  const router2 = new AutoRouter({ tenantSlug: 'test2' })
  const res = await runAutoChat({ model: 'aig-auto', messages: [{role:'user',content:'hi'}] }, candidates, buildProvider2, router2)
  console.log('final provider:', res.meta.provider.slug)
  console.log('attempts:', JSON.stringify(res.meta.attempts))

  console.log('\n=== all fail → AutoRunError ===')
  try {
    const allBad = (_slug: string): Provider => bad
    const router3 = new AutoRouter({ tenantSlug: 'test3' })
    await runAutoChat({ model: 'aig-auto', messages: [{role:'user',content:'hi'}] }, candidates, allBad, router3)
    console.log('  UNEXPECTED: no error thrown')
  } catch (e) {
    if (e instanceof AutoRunError) {
      console.log('  ✓ AutoRunError thrown, attempts=', e.attempts.length)
    } else {
      console.log('  unexpected error:', (e as Error).message)
    }
  }

  console.log('\n=== 4xx (bug): no retry ===')
  const fourxx: Provider = {
    name: 'bug',
    async chat() {
      const e = new Error('bad request 400') as Error & {status?:number}
      e.status = 400
      throw e
    },
    async chatStream() { throw new Error('na') }
  }
  try {
    const router4 = new AutoRouter({ tenantSlug: 'test4' })
    await runAutoChat({ model: 'aig-auto', messages: [{role:'user',content:'hi'}] }, candidates, () => fourxx, router4)
    console.log('  UNEXPECTED: no error')
  } catch (e) {
    if (e instanceof AutoRunError) {
      console.log('  ✗ should have thrown raw error not AutoRunError')
    } else {
      console.log('  ✓ raw error propagated (no retry):', (e as Error).message)
    }
  }

  console.log('\n=== wrapped upstream status preserved ===')
  const wrapped: Provider = {
    name: 'wrapped',
    async chat() {
      const e = new Error('freemodel upstream busy') as Error & { status?: number }
      e.status = 429
      throw new RotationExhaustedError('rotation exhausted after 1 attempts', e)
    },
    async chatStream() { throw new Error('na') }
  }
  try {
    const router5 = new AutoRouter({ tenantSlug: 'test5' })
    await runAutoChat({ model: 'aig-auto', messages: [{role:'user',content:'hi'}] }, candidates, () => wrapped, router5)
    console.log('  UNEXPECTED: no error')
  } catch (e) {
    if (e instanceof AutoRunError) {
      console.log('  ✓ status:', e.attempts[0]?.status)
    } else {
      console.log('  unexpected error:', (e as Error).message)
    }
  }
}

main().catch(e => { console.error('ERR:', e); process.exit(1) })
