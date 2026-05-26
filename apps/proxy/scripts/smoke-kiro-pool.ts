// Smoke test for multi-account KiroProvider — uses account_dir scan.
// Run: pnpm tsx scripts/smoke-kiro-pool.ts
import { KiroProvider } from '../src/providers/kiro.js'

async function main() {
  const provider = new KiroProvider({
    accountDir: '~/.kiro-accounts',
    tokenCache: '~/.aws/sso/cache/kiro-auth-token-cli.json',
    defaultModel: 'claude-haiku-4.5',
  })

  console.log('pool size:', provider.size())

  console.log('\n--- run 3 chats, observe rotation ---')
  for (let i = 0; i < 3; i++) {
    const res = await provider.chat({
      model: 'claude-haiku-4.5',
      messages: [{ role: 'user', content: `Reply with just the number ${i + 1}.` }],
    })
    console.log(`#${i + 1}:`, res.choices[0].message.content)
  }
}

main().catch((e) => {
  console.error('ERR:', e)
  process.exit(1)
})
