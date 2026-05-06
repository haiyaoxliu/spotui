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
import { toCookieHeader } from '../cookies/types.js'
import { isNotFound } from '../util/fs.js'
import { truncate } from '../util/truncate.js'
import { USER_AGENT } from './headers.js'
import { getToken } from './token.js'

const ME_URL = 'https://api.spotify.com/v1/me'
/**
 * Cookie-only fallback that lives on www.spotify.com (separate rate-limit
 * plane from api.spotify.com). Returns
 * `{ profile: { username, email, country, ... } }`. We use it when /v1/me
 * 429s during initial setup so boot can complete with a degraded profile
 * (no display_name, no product). Once /v1/me succeeds even once, the disk
 * cache means we never hit either path again.
 */
const PROFILE_FALLBACK_URL =
  'https://www.spotify.com/api/account-settings/v1/profile'
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
  /** Set to 'www-fallback' when /v1/me 429'd and we sourced the profile
   *  from www.spotify.com instead. Lets the SPA surface a warning so the
   *  user knows display_name + product are degraded. Absent on /v1/me
   *  responses and on disk-cached entries (which always come from /v1). */
  _source?: 'www-fallback'
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
 *  otherwise calls /v1/me; if /v1/me 429s, falls back to the www profile
 *  endpoint so boot can still complete with a degraded shape. */
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
  // Skip /v1/me while the cooldown is active — go straight to the www
  // fallback so a refresh doesn't extend Spotify's lockout.
  if (Date.now() >= rateLimitedUntil) {
    try {
      const fresh = await mintFromApi(read)
      memCache = fresh
      void writeDisk(fresh).catch((err) => {
        console.warn('[spotui] failed to persist me.json:', err)
      })
      return fresh
    } catch (e) {
      if (!(e instanceof MeRateLimitedError)) throw e
    }
  }
  // /v1/me is rate-limited (or just got rate-limited). Fall back to the
  // www endpoint, which lives on a different rate-limit plane.
  const fromWww = await fetchFromWww(read)
  memCache = fromWww
  // Don't persist the www result to disk — it's missing display_name and
  // product. Next run will retry /v1/me to get the full record.
  return fromWww
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

interface WwwProfileResponse {
  profile?: {
    username?: string
    email?: string
    country?: string
  }
}

/** Fetches the user's profile from www.spotify.com using the sp_dc cookie.
 *  Used when /v1/me is rate-limited. The shape is narrower than /v1/me —
 *  no display_name, no product. We synthesize a display_name from the
 *  email local-part (or the username) and default product to 'open'. */
async function fetchFromWww(read: CookieReadResult): Promise<MeProfile> {
  const res = await fetch(PROFILE_FALLBACK_URL, {
    headers: {
      Accept: 'application/json',
      Cookie: toCookieHeader(read.cookies),
      'User-Agent': USER_AGENT,
    },
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`www profile ${res.status}: ${truncate(body)}`)
  }
  const payload = (await res.json()) as WwwProfileResponse
  const username = payload.profile?.username
  if (!username) {
    throw new Error('www profile response missing username')
  }
  const display = payload.profile?.email?.split('@')[0] || username
  return {
    id: username,
    display_name: display,
    email: payload.profile?.email,
    product: 'open',
    country: payload.profile?.country,
    _source: 'www-fallback',
  }
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
