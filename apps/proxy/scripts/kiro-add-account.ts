#!/usr/bin/env -S pnpm tsx
// Add a Kiro account interactively via device authorization flow.
// Usage: pnpm tsx scripts/kiro-add-account.ts [--provider Google|Github|Cognito] [--dir ~/.kiro-accounts]
import { writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve, join } from 'node:path'
import { createHash } from 'node:crypto'
import {
  startDeviceAuth,
  waitForDeviceAuth,
  deviceResultToTokenFile,
  type LoginProvider,
} from '../src/providers/kiro-device-auth.js'

function expand(p: string): string {
  return p.startsWith('~') ? resolve(homedir() + p.slice(1)) : resolve(p)
}

function parseArgs(): { provider: LoginProvider; dir: string } {
  const args = process.argv.slice(2)
  let provider: LoginProvider = 'Google'
  let dir = '~/.kiro-accounts'
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--provider' && args[i + 1]) {
      const v = args[i + 1]
      if (v !== 'Google' && v !== 'Github' && v !== 'Cognito') {
        throw new Error(`invalid --provider: ${v}`)
      }
      provider = v
      i++
    } else if (args[i] === '--dir' && args[i + 1]) {
      dir = args[i + 1]
      i++
    }
  }
  return { provider, dir }
}

async function main() {
  const { provider, dir } = parseArgs()
  const outDir = expand(dir)
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true, mode: 0o700 })

  console.log(`provider: ${provider}`)
  const start = await startDeviceAuth(provider)
  console.log()
  console.log('👉 Open this URL and complete login:')
  console.log(`   ${start.verificationUriComplete}`)
  console.log()
  console.log(`(user code: ${start.userCode}, expires in ${Math.round(start.expiresInMilliseconds / 1000)}s)`)
  console.log()
  console.log('Polling...')

  const result = await waitForDeviceAuth(start, {
    onPoll: (p, n) => {
      if (p.status === 'authorization_pending' && n % 6 === 0) {
        process.stdout.write(`  still waiting (${n * 5}s)\n`)
      } else if (p.status !== 'authorization_pending') {
        process.stdout.write(`  status=${p.status}\n`)
      } else {
        process.stdout.write('.')
      }
    },
  })

  const token = deviceResultToTokenFile(result)
  const id = createHash('sha1')
    .update(token.profileArn + token.accessToken.slice(0, 32))
    .digest('hex')
    .slice(0, 12)
  const file = join(outDir, `acc-${id}.json`)
  writeFileSync(file, JSON.stringify(token, null, 2), { mode: 0o600 })
  chmodSync(file, 0o600)

  console.log()
  console.log(`✓ saved → ${file}`)
  console.log(`  profileArn:  ${token.profileArn}`)
  console.log(`  provider:    ${token.provider}`)
  console.log(`  expiresAt:   ${token.expiresAt}`)
}

main().catch((e) => {
  console.error('ERR:', e?.message ?? e)
  process.exit(1)
})
