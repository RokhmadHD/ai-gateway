#!/usr/bin/env -S pnpm tsx
// Add a Gemini account interactively via OAuth loopback flow.
// Usage:
//   pnpm tsx scripts/gemini-add-account.ts [--dir ~/.gemini-accounts] [--port 0]
//   pnpm tsx scripts/gemini-add-account.ts --import ~/.gemini/oauth_creds.json
//
// The --import variant just copies an existing gemini-cli oauth_creds.json
// (run `gemini` once + login first) into the accounts dir. Easiest path.
import {
  writeFileSync,
  mkdirSync,
  existsSync,
  chmodSync,
  readFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { resolve, join } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { fetch } from 'undici'
import {
  GEMINI_OAUTH_CLIENT_ID,
  GEMINI_OAUTH_CLIENT_SECRET,
  GEMINI_OAUTH_SCOPES,
} from '../src/providers/gemini.js'

function expand(p: string): string {
  return p.startsWith('~') ? resolve(homedir() + p.slice(1)) : resolve(p)
}

interface Args {
  dir: string
  port: number
  importPath?: string
}

function parseArgs(): Args {
  const args = process.argv.slice(2)
  const out: Args = { dir: '~/.gemini-accounts', port: 0 }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--dir' && args[i + 1]) { out.dir = args[i + 1]; i++ }
    else if (a === '--port' && args[i + 1]) { out.port = Number(args[i + 1]); i++ }
    else if (a === '--import' && args[i + 1]) { out.importPath = args[i + 1]; i++ }
  }
  return out
}

function saveToken(outDir: string, token: Record<string, unknown>): string {
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true, mode: 0o700 })
  const fp = (token.access_token as string) ?? ''
  const id = createHash('sha1').update(fp).digest('hex').slice(0, 12)
  const file = join(outDir, `acc-${id}.json`)
  writeFileSync(file, JSON.stringify(token, null, 2), { mode: 0o600 })
  chmodSync(file, 0o600)
  return file
}

async function doImport(srcPath: string, outDir: string): Promise<void> {
  const src = expand(srcPath)
  if (!existsSync(src)) throw new Error(`not found: ${src}`)
  const raw = readFileSync(src, 'utf-8')
  const token = JSON.parse(raw) as Record<string, unknown>
  if (!token.access_token || !token.refresh_token) {
    throw new Error('source file missing access_token/refresh_token')
  }
  const file = saveToken(expand(outDir), token)
  console.log(`✓ imported → ${file}`)
}

interface OAuthBundle {
  code: string
  state: string
  codeVerifier: string
  redirectUri: string
}

function captureCode(port: number): Promise<OAuthBundle> {
  const state = randomBytes(32).toString('hex')
  return new Promise((resolveP, rejectP) => {
    const server = createServer((req, res) => {
      try {
        const url = new URL(req.url ?? '/', `http://127.0.0.1:${port || (server.address() as { port: number }).port}`)
        if (url.pathname !== '/oauth2callback') {
          res.writeHead(404).end('not found')
          return
        }
        const code = url.searchParams.get('code')
        const gotState = (url.searchParams.get('state') ?? '').replace(/\s+/g, '')
        if (!code || gotState !== state) {
          res.writeHead(400).end(`got state="${gotState}" expected="${state}"`)
          rejectP(new Error(`OAuth callback state mismatch: got "${gotState}", expected "${state}"`))
          server.close()
          return
        }
        res.writeHead(200, { 'Content-Type': 'text/html' }).end(
          '<html><body><h2>✓ Login complete</h2>You can close this tab.</body></html>',
        )
        const addr = server.address() as { port: number }
        resolveP({ code, state, codeVerifier: '', redirectUri: `http://127.0.0.1:${addr.port}/oauth2callback` })
        setTimeout(() => server.close(), 500)
      } catch (e) {
        rejectP(e as Error)
      }
    })
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address() as { port: number }
      const redirectUri = `http://127.0.0.1:${addr.port}/oauth2callback`
      // Google OAuth pre-validates query — must use %20 for scope separator,
      // not + (URLSearchParams default). Build manually with encodeURIComponent.
      const q = (k: string, v: string) => `${k}=${encodeURIComponent(v)}`
      const authUrl =
        'https://accounts.google.com/o/oauth2/v2/auth?' +
        [
          q('redirect_uri', redirectUri),
          q('access_type', 'offline'),
          q('scope', GEMINI_OAUTH_SCOPES.join(' ')),
          q('state', state),
          q('response_type', 'code'),
          q('client_id', GEMINI_OAUTH_CLIENT_ID),
        ].join('&')
      console.log('Loopback callback:', redirectUri)
      console.log('\n👉 Open this URL and complete login:\n')
      console.log(authUrl)
      console.log('\nWaiting for callback...')
    })
    server.on('error', rejectP)
  })
}

async function exchangeCode(bundle: OAuthBundle): Promise<Record<string, unknown>> {
  const body = new URLSearchParams({
    code: bundle.code,
    client_id: GEMINI_OAUTH_CLIENT_ID,
    client_secret: GEMINI_OAUTH_CLIENT_SECRET,
    redirect_uri: bundle.redirectUri,
    grant_type: 'authorization_code',
  })
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })
  if (!res.ok) throw new Error(`token exchange ${res.status}: ${await res.text()}`)
  const data = (await res.json()) as {
    access_token: string
    refresh_token: string
    expires_in: number
    token_type: string
    scope?: string
    id_token?: string
  }
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    scope: data.scope,
    token_type: data.token_type,
    id_token: data.id_token,
    expiry_date: Date.now() + data.expires_in * 1000,
  }
}

async function main(): Promise<void> {
  const args = parseArgs()
  const outDir = expand(args.dir)
  if (args.importPath) {
    await doImport(args.importPath, outDir)
    return
  }
  const bundle = await captureCode(args.port)
  console.log('Got auth code; exchanging for tokens...')
  const token = await exchangeCode(bundle)
  const file = saveToken(outDir, token)
  console.log(`✓ saved → ${file}`)
  console.log(`  expiry_date: ${new Date(token.expiry_date as number).toISOString()}`)
}

main().catch((e: Error) => {
  console.error('ERR:', e.message ?? e)
  process.exit(1)
})
