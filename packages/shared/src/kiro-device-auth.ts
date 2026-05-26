import { setTimeout as delay } from 'node:timers/promises'
import { randomUUID } from 'node:crypto'

const AUTH_BASE = 'https://prod.us-east-1.auth.desktop.kiro.dev'
const KIRO_AUTH_UA = 'Kiro-CLI'

export type LoginProvider = 'Google' | 'Github' | 'Cognito'

export interface DeviceAuthStart {
  clientId: string
  deviceCode: string
  userCode: string
  verificationUri: string
  verificationUriComplete: string
  expiresInMilliseconds: number
  intervalInMilliseconds: number
}

export interface DeviceAuthPollPending {
  status: 'authorization_pending' | 'slow_down' | string
  accessToken: null
  refreshToken: null
  profileArn: null
  identityProvider: null
}

export interface DeviceAuthPollDone {
  status: 'authorized'
  accessToken: string
  refreshToken: string
  profileArn: string
  identityProvider: 'Google' | 'Github' | 'Cognito' | string
}

export type DeviceAuthPoll = DeviceAuthPollPending | DeviceAuthPollDone | { status: string }

export async function startDeviceAuth(
  loginProvider: LoginProvider = 'Google',
  clientId: string = randomUUID(),
): Promise<DeviceAuthStart> {
  const res = await fetch(`${AUTH_BASE}/oauth/device/authorization`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': KIRO_AUTH_UA,
      Accept: '*/*',
    },
    body: JSON.stringify({ clientId, loginProvider }),
  })
  if (!res.ok) {
    throw new Error(`Kiro device/authorization ${res.status}: ${await res.text()}`)
  }
  const data = (await res.json()) as Omit<DeviceAuthStart, 'clientId'>
  return { clientId, ...data }
}

export async function pollDeviceAuth(
  clientId: string,
  deviceCode: string,
): Promise<DeviceAuthPoll> {
  const res = await fetch(`${AUTH_BASE}/oauth/device/poll`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': KIRO_AUTH_UA,
      Accept: '*/*',
    },
    body: JSON.stringify({ clientId, deviceCode }),
  })
  if (!res.ok) {
    throw new Error(`Kiro device/poll ${res.status}: ${await res.text()}`)
  }
  return (await res.json()) as DeviceAuthPoll
}

export interface WaitOptions {
  signal?: AbortSignal
  onPoll?: (poll: DeviceAuthPoll, attempt: number) => void
  intervalMs?: number
  timeoutMs?: number
}

export async function waitForDeviceAuth(
  start: DeviceAuthStart,
  opts: WaitOptions = {},
): Promise<DeviceAuthPollDone> {
  const interval = opts.intervalMs ?? start.intervalInMilliseconds ?? 5000
  const deadline = Date.now() + (opts.timeoutMs ?? start.expiresInMilliseconds ?? 300000)
  let attempt = 0
  while (Date.now() < deadline) {
    if (opts.signal?.aborted) throw new Error('aborted')
    attempt += 1
    const poll = await pollDeviceAuth(start.clientId, start.deviceCode)
    opts.onPoll?.(poll, attempt)
    if (poll.status === 'authorized') return poll as DeviceAuthPollDone
    if (poll.status !== 'authorization_pending' && poll.status !== 'slow_down') {
      throw new Error(`Kiro device auth failed: status=${poll.status}`)
    }
    await delay(interval, undefined, { signal: opts.signal })
  }
  throw new Error('Kiro device auth timed out')
}

export interface NormalizedTokenFile {
  accessToken: string
  refreshToken: string
  expiresAt: string
  profileArn: string
  authMethod: 'social'
  provider: string
}

/** Normalize device-flow result to on-disk token cache shape used by KiroProvider. */
export function deviceResultToTokenFile(result: DeviceAuthPollDone): NormalizedTokenFile {
  return {
    accessToken: result.accessToken,
    refreshToken: result.refreshToken,
    expiresAt: new Date(Date.now() + 3540 * 1000).toISOString(),
    profileArn: result.profileArn,
    authMethod: 'social',
    provider: String(result.identityProvider).toLowerCase(),
  }
}
