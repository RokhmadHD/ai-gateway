// Quick smoke test for KiroProvider — calls real API using local token cache.
// Run: pnpm tsx scripts/smoke-kiro.ts
import { KiroProvider } from '../src/providers/kiro.js'

async function main() {
  const provider = new KiroProvider({ defaultModel: 'claude-haiku-4.5' })

  console.log('--- non-stream ---')
  const res = await provider.chat({
    model: 'claude-haiku-4.5',
    messages: [{ role: 'user', content: 'Say "hello from kiro" and nothing else.' }],
  })
  console.log('content:', res.choices[0].message.content)

  console.log('\n--- stream ---')
  const stream = await provider.chatStream({
    model: 'claude-haiku-4.5',
    messages: [{ role: 'user', content: 'Count from 1 to 5, one number per line.' }],
  })
  for await (const chunk of stream) {
    process.stdout.write(chunk)
  }
}

main().catch((e) => {
  console.error('ERR:', e)
  process.exit(1)
})
