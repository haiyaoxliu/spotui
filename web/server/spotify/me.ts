/**
 * Sidecar-cached `/v1/me` fetcher with a disk fallback.
 *
 * Spotify rate-limits api.spotify.com per account. Calling /v1/me on
 * every page reload is wasteful, and a single 429 there can lock out
 * boot for ~10 minutes. The profile is also stable for the dev-server
 * lifetime (id/display_name/product don't change between page loads),
 * so we cache:
 *
 *   - In memory (process lifetime).
 *   - On disk under ~/Library/Application Support/spotui/me.json so a
 *     restart doesn't re-hit /v1/me.
 *
 * Cookie-mint tokens work against api.spotify.com/v1, so this stays on
 * the existing bearer pipeline rather than introducing a Pathfinder
 * query (spogo's `connect` engine takes the same approach for
 * `currentUserID`).
 *
 * If /v1/me 429s, we surface a 429 to the SPA and skip retries for 60s
 * so a frustrated page-refresh loop doesn't make things worse.
 */

import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { CookieReadResult } from '../cookies/index.js'
import { getToken } from './token.js'

const ME_URL = 'https://api.spotify.com/v1/me'
const ME_FILE = path.join(
  os.homedir(),
  'Library',
  'Application Support',
  'spotui',
  'me.json',
)
const RATE_LIMIT_COOLDOWN_MS = 60_000

export interface MeProfile {
  id: string
  display_name: string
  email?: string
  product: 'premium' | 'free' | 'open'
  country?: string
}

export class MeRateLimitedError extends Error {
  constructor(readonly retryAfterMs: number) {
    super(`api.spotify.com /v1/me rate-limited; retry in ${retryAfterMs}ms`)
    this.name = 'MeRateLimitedError'
  }
}

let memCache: MeProfile | null = null
let diskLoaded = false
let rateLimitedUntil = 0

/** Returns the cached profile when one exists; otherwise tries disk;
 *  otherwise calls /v1/me. Throws MeRateLimitedError if /v1/me recently
 *  429'd and the cooldown is still active. */
export async function getMe(read: CookieReadResult): Promise<MeProfile> {
  if (memCache) return memCache
  if (!diskLoaded) {
    diskLoaded = true
    const fromDisk = await readDisk()
    if (fromDisk) {
      memCache = fromDisk
      return memCache
    }
  }
  if (Date.now() < rateLimitedUntil) {
    throw new MeRateLimitedError(rateLimitedUntil - Date.now())
  }
  const fresh = await mintFromApi(read)
  memCache = fresh
  // Fire-and-forget — disk failure shouldn't break boot.
  void writeDisk(fresh).catch((err) => {
    console.warn('[spotui] failed to persist me.json:', err)
  })
  return fresh
}

export function clearMeCache(): void {
  memCache = null
  rateLimitedUntil = 0
  void fs.unlink(ME_FILE).catch(() => {})
}

async function mintFromApi(read: CookieReadResult): Promise<MeProfile> {
  const tok = await getToken(read)
  const res = await fetch(ME_URL, {
    headers: {
      Authorization: `Bearer ${tok.accessToken}`,
      Accept: 'application/json',
    },
  })
  if (res.status === 429) {
    rateLimitedUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS
    throw new MeRateLimitedError(RATE_LIMIT_COOLDOWN_MS)
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`/v1/me ${res.status}: ${truncate(body)}`)
  }
  return (await res.json()) as MeProfile
}

async function readDisk(): Promise<MeProfile | null> {
  try {
    const body = await fs.readFile(ME_FILE, 'utf8')
    const parsed = JSON.parse(body) as { profile?: MeProfile }
    if (parsed?.profile?.id) return parsed.profile
    return null
  } catch (e: unknown) {
    if (isNotFound(e)) return null
    console.warn('[spotui] me.json read failed:', e)
    return null
  }
}

async function writeDisk(profile: MeProfile): Promise<void> {
  await fs.mkdir(path.dirname(ME_FILE), { recursive: true })
  const tmp = `${ME_FILE}.tmp`
  await fs.writeFile(
    tmp,
    JSON.stringify({ profile, savedAt: Math.floor(Date.now() / 1000) }, null, 2),
    { mode: 0o600 },
  )
  await fs.rename(tmp, ME_FILE)
}

function isNotFound(e: unknown): boolean {
  return (
    typeof e === 'object' &&
    e !== null &&
    'code' in e &&
    (e as { code: unknown }).code === 'ENOENT'
  )
}

function truncate(s: string): string {
  return s.length > 200 ? `${s.slice(0, 200)}...` : s
}
