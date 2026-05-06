/**
 * Spotify session: bearer + client-token + clientVersion + device-id (`sp_t`).
 *
 * Pathfinder, spclient, and connect-state all want **two** auth headers:
 * `authorization: Bearer <web-token>` (from `./token.ts`) AND
 * `client-token: <minted client-token>`. The client-token mint at
 * `clienttoken.spotify.com/v1/clienttoken` itself wants the `clientVersion`
 * Spotify embeds in the live web-player HTML and a stable device id
 * (`sp_t`).
 *
 * Direct port of `openclaw/spogo` `internal/spotify/connect_session.go`,
 * with one departure: spogo bails if `sp_t` isn't in the cookies. We
 * synthesize one and persist it back to the cookie file instead, so a
 * paste of just `sp_dc` is enough to bootstrap. Spotify treats `sp_t` as
 * an opaque random hex string — any stable value works for client-token
 * mint and Pathfinder reads. Real Connect playback (phase 3) will benefit
 * from the actual cookie when present.
 */

import crypto from 'node:crypto'
import os from 'node:os'

import {
  persistPastedCookies,
  type CookieReadResult,
  type SpotifyCookie,
} from '../cookies/index.js'
import { findCookie, hasSpDc } from '../cookies/types.js'
import { readFileCookies } from '../cookies/file.js'
import { getToken, type WebToken } from './token.js'

const APP_PLATFORM = 'WebPlayer'
const SEC_CH_UA =
  '"Chromium";v="131", "Not_A Brand";v="24", "Google Chrome";v="131"'

const CLIENT_TOKEN_URL = 'https://clienttoken.spotify.com/v1/clienttoken'
const WEB_PLAYER_URL = 'https://open.spotify.com/'

const CLIENT_VERSION_ENV = 'SPOTUI_CONNECT_VERSION'
const REFRESH_SLACK_MS = 60_000

export interface SessionAuth {
  /** Bearer for `authorization: Bearer …`. */
  accessToken: string
  /** `client-token: …` header value. */
  clientToken: string
  /** `client-version: harmony:X.Y.Z-...` header value. Also embedded in the
   *  client-token mint payload. */
  clientVersion: string
  /** Device id (`sp_t` cookie or synthesized fallback). Used as
   *  `device_id` in client-token mint and as the connect-state device id
   *  in phase 3. */
  deviceId: string
  /** The clientId field returned by `/api/token` — needed by the
   *  client-token mint's `client_data.client_id`. */
  clientId: string
}

interface CachedClientToken {
  token: string
  expiresAt: number
}

interface CachedAppConfig {
  clientVersion: string
}

let cachedClientToken: CachedClientToken | null = null
let cachedAppConfig: CachedAppConfig | null = null

/** Resolve the full set of headers/values needed to call Pathfinder /
 *  spclient / connect-state. Cookies are read from the discover dispatcher
 *  by the caller; we don't re-discover here so that the route layer stays
 *  in control of which cookies to use. */
export async function getSessionAuth(
  read: CookieReadResult,
): Promise<SessionAuth> {
  const tok = await getToken(read)
  const clientVersion = await ensureClientVersion()
  const deviceId = await ensureDeviceId(read.cookies)
  const clientToken = await ensureClientToken(tok, clientVersion, deviceId)

  return {
    accessToken: tok.accessToken,
    clientToken,
    clientVersion,
    deviceId,
    clientId: tok.clientId,
  }
}

export function clearSessionCaches(): void {
  cachedClientToken = null
  cachedAppConfig = null
}

// ---- clientVersion -----------------------------------------------------

async function ensureClientVersion(): Promise<string> {
  const override = process.env[CLIENT_VERSION_ENV]?.trim()
  if (override) return override
  if (cachedAppConfig) return cachedAppConfig.clientVersion

  const html = await fetchText(WEB_PLAYER_URL)
  const cv = extractClientVersion(html)
  cachedAppConfig = { clientVersion: cv }
  return cv
}

const APP_SERVER_CONFIG_RE =
  /<script id="appServerConfig" type="text\/plain">([^<]+)<\/script>/i

export function extractClientVersion(html: string): string {
  const match = APP_SERVER_CONFIG_RE.exec(html)
  if (!match) {
    throw new Error('appServerConfig script tag not found in web-player HTML')
  }
  const decoded = Buffer.from(match[1], 'base64').toString('utf8')
  const payload = JSON.parse(decoded) as { clientVersion?: string }
  if (!payload.clientVersion) {
    throw new Error('appServerConfig has no clientVersion')
  }
  let cv = payload.clientVersion
  // spogo trims at `.g` because the suffix shifts on every push but the
  // prefix is what `clienttoken` actually keys on.
  const idx = cv.indexOf('.g')
  if (idx > 0) cv = cv.slice(0, idx)
  return cv
}

// ---- deviceId (sp_t) ---------------------------------------------------

async function ensureDeviceId(cookies: SpotifyCookie[]): Promise<string> {
  const fromCookie = findCookie(cookies, 'sp_t')
  if (fromCookie) return fromCookie

  // No sp_t in the user's paste; check whether we already synthesized one
  // and persisted it to the cookie file.
  const persisted = await readFileCookies()
  const fromFile = findCookie(persisted, 'sp_t')
  if (fromFile) return fromFile

  // First time: synthesize, then persist alongside whatever cookies we have.
  const synthesized = randomDeviceId()
  if (hasSpDc(persisted)) {
    await persistPastedCookies([
      ...persisted.filter((c) => c.name !== 'sp_t'),
      { name: 'sp_t', value: synthesized, domain: '.spotify.com' },
    ])
  } else if (hasSpDc(cookies)) {
    await persistPastedCookies([
      ...cookies.filter((c) => c.name !== 'sp_t'),
      { name: 'sp_t', value: synthesized, domain: '.spotify.com' },
    ])
  }
  return synthesized
}

function randomDeviceId(): string {
  return crypto.randomBytes(20).toString('hex') // 40-char hex; matches typical sp_t length
}

// ---- clientToken -------------------------------------------------------

async function ensureClientToken(
  tok: WebToken,
  clientVersion: string,
  deviceId: string,
): Promise<string> {
  if (
    cachedClientToken &&
    cachedClientToken.expiresAt > Date.now() + REFRESH_SLACK_MS
  ) {
    return cachedClientToken.token
  }
  if (!tok.clientId) {
    throw new Error('cannot mint client-token: missing clientId from /api/token')
  }
  const fresh = await mintClientToken(tok.clientId, clientVersion, deviceId)
  cachedClientToken = fresh
  return fresh.token
}

async function mintClientToken(
  clientId: string,
  clientVersion: string,
  deviceId: string,
): Promise<CachedClientToken> {
  const { osName, osVersion } = runtimeOs()
  const body = {
    client_data: {
      client_version: clientVersion,
      client_id: clientId,
      js_sdk_data: {
        device_brand: 'unknown',
        device_model: 'unknown',
        os: osName,
        os_version: osVersion,
        device_id: deviceId,
        device_type: 'computer',
      },
    },
  }
  const res = await fetch(CLIENT_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Origin: 'https://open.spotify.com',
      Referer: 'https://open.spotify.com/',
      'App-Platform': APP_PLATFORM,
      'Sec-CH-UA': SEC_CH_UA,
      'Sec-CH-UA-Mobile': '?0',
      'Sec-CH-UA-Platform': '"macOS"',
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const errBody = await res.text().catch(() => '')
    throw new Error(`client-token mint ${res.status}: ${truncate(errBody)}`)
  }
  const payload = (await res.json()) as {
    response_type?: string
    granted_token?: { token?: string; expires_in?: number }
  }
  const granted = payload.granted_token
  if (!granted?.token) {
    throw new Error(`client-token response missing granted_token.token`)
  }
  const expiresAt = Date.now() + (granted.expires_in ?? 30 * 60) * 1000
  return { token: granted.token, expiresAt }
}

function runtimeOs(): { osName: string; osVersion: string } {
  switch (os.platform()) {
    case 'darwin':
      return { osName: 'macos', osVersion: 'unknown' }
    case 'win32':
      return { osName: 'windows', osVersion: 'unknown' }
    default:
      return { osName: 'linux', osVersion: 'unknown' }
  }
}

// ---- helpers -----------------------------------------------------------

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Sec-CH-UA': SEC_CH_UA,
      'Sec-CH-UA-Mobile': '?0',
      'Sec-CH-UA-Platform': '"macOS"',
    },
  })
  if (!res.ok) throw new Error(`${url} → ${res.status}`)
  return res.text()
}

function truncate(s: string): string {
  return s.length > 200 ? `${s.slice(0, 200)}...` : s
}

export { fetchText as _fetchText }
