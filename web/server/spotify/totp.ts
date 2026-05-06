/**
 * TOTP for the cookie-auth flow. Direct port of `openclaw/spogo`
 * `internal/spotify/totp.go`.
 *
 * Algorithm:
 *   1. XOR each byte of the published secret with `(i % 33) + 9`.
 *   2. Concat the resulting bytes' decimal representations into ASCII; that
 *      string is the HMAC key.
 *   3. HMAC-SHA1(key, counter = unixSeconds / 30); take 6 digits per RFC 6238.
 *
 * Step 2 is non-obvious — the key is the digit-string form, not the raw
 * bytes — and matches what Spotify's TOTP check expects. Step 1 de-obfuscates
 * the published secret.
 *
 * The published secret rotates; we fetch from public mirrors with versioning,
 * fall back to a hardcoded version, and accept `SPOTUI_TOTP_SECRET_URL` as
 * an override.
 */

import crypto from 'node:crypto'
import { promises as fs } from 'node:fs'

const SECRET_ENV = 'SPOTUI_TOTP_SECRET_URL'
const CACHE_TTL_MS = 15 * 60 * 1000
const STEP_SECS = 30
const DIGITS = 6
const HTTP_TIMEOUT_MS = 5_000

const FALLBACK_VERSION = 18
const FALLBACK_SECRET = Uint8Array.from([
  70, 60, 33, 57, 92, 120, 90, 33, 32, 62, 62, 55, 126, 93, 66, 35, 108, 68,
])

const SECRET_URLS = [
  'https://github.com/xyloflake/spot-secrets-go/raw/main/secrets/secretDict.json',
  'https://github.com/Thereallo1026/spotify-secrets/raw/main/secrets/secretDict.json',
] as const

interface CacheEntry {
  version: number
  secret: Uint8Array
  expiresAt: number
}

let cache: CacheEntry | null = null

export interface TotpCode {
  code: string
  version: number
}

/** Generate the current TOTP code; result includes the version to send back
 *  to Spotify as `totpVer`. */
export async function generateTotp(now: Date = new Date()): Promise<TotpCode> {
  const { version, secret } = await loadSecret()
  const code = totpFromSecret(secret, now)
  return { code, version }
}

async function loadSecret(): Promise<{ version: number; secret: Uint8Array }> {
  if (cache && cache.expiresAt > Date.now()) {
    return { version: cache.version, secret: cache.secret }
  }
  try {
    const fresh = await fetchRemoteSecret()
    cache = { ...fresh, expiresAt: Date.now() + CACHE_TTL_MS }
    return fresh
  } catch (e) {
    console.warn('[spotui] totp secret fetch failed, using fallback:', e)
    return { version: FALLBACK_VERSION, secret: FALLBACK_SECRET }
  }
}

async function fetchRemoteSecret(): Promise<{
  version: number
  secret: Uint8Array
}> {
  const sources = sourceUrls()
  let lastErr: unknown = null
  for (const url of sources) {
    try {
      return await fetchOne(url)
    } catch (e) {
      lastErr = e
    }
  }
  throw lastErr ?? new Error('no totp secret sources configured')
}

function sourceUrls(): string[] {
  const override = process.env[SECRET_ENV]?.trim()
  if (override) return [override]
  return [...SECRET_URLS]
}

async function fetchOne(
  source: string,
): Promise<{ version: number; secret: Uint8Array }> {
  if (source.startsWith('file://')) {
    const path = source.slice('file://'.length)
    const body = await fs.readFile(path, 'utf8')
    return parseSecretDict(body)
  }
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS)
  try {
    const res = await fetch(source, { signal: ctrl.signal })
    if (!res.ok) throw new Error(`${source} → ${res.status}`)
    const body = await res.text()
    return parseSecretDict(body)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * The published format is `{ "<version>": [<int byte>, ...] }`. Pick the
 * highest-numbered version.
 */
export function parseSecretDict(body: string): {
  version: number
  secret: Uint8Array
} {
  const dict = JSON.parse(body) as Record<string, number[]>
  let bestVer = -1
  let bestBytes: number[] | null = null
  for (const [k, v] of Object.entries(dict)) {
    const n = Number.parseInt(k, 10)
    if (!Number.isFinite(n) || !Array.isArray(v) || v.length === 0) continue
    if (n > bestVer) {
      bestVer = n
      bestBytes = v
    }
  }
  if (bestVer < 0 || !bestBytes) {
    throw new Error('no usable secret in dict')
  }
  for (const b of bestBytes) {
    if (!Number.isInteger(b) || b < 0 || b > 255) {
      throw new Error(`byte ${b} out of range`)
    }
  }
  return { version: bestVer, secret: Uint8Array.from(bestBytes) }
}

export function totpFromSecret(secret: Uint8Array, now: Date): string {
  if (secret.length === 0) throw new Error('totp secret empty')
  // Step 1: XOR each byte with `(i % 33) + 9`.
  const transformed = new Uint8Array(secret.length)
  for (let i = 0; i < secret.length; i++) {
    const mask = (i % 33) + 9
    transformed[i] = secret[i] ^ mask
  }
  // Step 2: ASCII digit-string of those byte values.
  let joined = ''
  for (const b of transformed) joined += b.toString()
  // Step 3: HMAC-SHA1 HOTP at 30s steps.
  const counter = Math.floor(now.getTime() / 1000 / STEP_SECS)
  return hotp(Buffer.from(joined, 'utf8'), counter)
}

export function hotp(key: Buffer, counter: number): string {
  const counterBuf = Buffer.alloc(8)
  // Node has no writeBigUInt64BE-friendly polyfill story for older versions,
  // but counter fits in 53 bits comfortably for any time within ~10^8 years
  // of the epoch, so we encode high then low halves as 32-bit ints.
  counterBuf.writeUInt32BE(Math.floor(counter / 0x100000000), 0)
  counterBuf.writeUInt32BE(counter >>> 0, 4)

  const mac = crypto.createHmac('sha1', key).update(counterBuf).digest()
  const offset = mac[mac.length - 1] & 0x0f
  const bin =
    ((mac[offset] & 0x7f) << 24) |
    ((mac[offset + 1] & 0xff) << 16) |
    ((mac[offset + 2] & 0xff) << 8) |
    (mac[offset + 3] & 0xff)
  const code = bin % 10 ** DIGITS
  return code.toString().padStart(DIGITS, '0')
}

// Exposed for tests and for force-clearing the cache after dev-mode hot reloads.
export function _resetCache(): void {
  cache = null
}
