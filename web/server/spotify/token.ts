/**
 * Mint a web-player access token from `sp_dc` cookies, and cache it.
 *
 * Hits `https://open.spotify.com/api/token` with the cookies attached and a
 * TOTP from `./totp.ts`. The `totpServer` query param is set to the same
 * code as `totp` — that's the trick that currently passes Spotify's check
 * (mirrors `openclaw/spogo` `internal/spotify/token.go`).
 *
 * The minted token has elevated scopes vs. PKCE: it can call `spclient`,
 * `api-partner.spotify.com/pathfinder`, and `connect-state` endpoints.
 * Lifetime ~1 hour.
 */

import type { CookieReadResult } from '../cookies/index.js'
import { toCookieHeader } from '../cookies/types.js'
import { truncate } from '../util/truncate.js'

import { APP_PLATFORM, SEC_CH_UA } from './headers.js'
import { generateTotp } from './totp.js'

const TOKEN_URL = 'https://open.spotify.com/api/token'
const REFRESH_SLACK_MS = 60_000

export interface WebToken {
  accessToken: string
  expiresAt: number // unix ms
  isAnonymous: boolean
  clientId: string
}

interface TokenResponse {
  accessToken: string
  expiresIn?: number
  accessTokenExpirationTimestampMs?: number
  isAnonymous?: boolean
  clientId?: string
}

let cached: WebToken | null = null

/** Returns a fresh token if one is cached and has > 1 minute of life left;
 *  otherwise mints a new one. The mint uses whatever cookies the dispatcher
 *  hands us — caller is responsible for re-running discovery if mint fails. */
export async function getToken(read: CookieReadResult): Promise<WebToken> {
  if (cached && cached.expiresAt > Date.now() + REFRESH_SLACK_MS) {
    return cached
  }
  const fresh = await mintToken(read)
  cached = fresh
  return fresh
}

export function clearCachedToken(): void {
  cached = null
}

export function peekCachedToken(): WebToken | null {
  return cached
}

async function mintToken(read: CookieReadResult): Promise<WebToken> {
  const cookieHeader = toCookieHeader(read.cookies)
  const { code, version } = await generateTotp()
  const url = new URL(TOKEN_URL)
  url.searchParams.set('reason', 'init')
  url.searchParams.set('productType', 'web-player')
  url.searchParams.set('totp', code)
  url.searchParams.set('totpVer', String(version))
  url.searchParams.set('totpServer', code)

  const res = await fetch(url, {
    headers: {
      Cookie: cookieHeader,
      Accept: 'application/json',
      'Accept-Language': 'en-US,en;q=0.9',
      'App-Platform': APP_PLATFORM,
      Origin: 'https://open.spotify.com',
      Referer: 'https://open.spotify.com/',
      'Sec-Fetch-Site': 'same-origin',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Dest': 'empty',
      'Sec-CH-UA': SEC_CH_UA,
      'Sec-CH-UA-Platform': '"macOS"',
      'Sec-CH-UA-Mobile': '?0',
    },
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`token mint ${res.status}: ${truncate(body)}`)
  }
  const payload = (await res.json()) as TokenResponse
  if (!payload.accessToken) {
    throw new Error('token response missing accessToken')
  }
  const expiresAt =
    payload.accessTokenExpirationTimestampMs && payload.accessTokenExpirationTimestampMs > 0
      ? payload.accessTokenExpirationTimestampMs
      : payload.expiresIn && payload.expiresIn > 0
        ? Date.now() + payload.expiresIn * 1000
        : Date.now() + 60 * 60 * 1000

  return {
    accessToken: payload.accessToken,
    expiresAt,
    isAnonymous: !!payload.isAnonymous,
    clientId: payload.clientId ?? '',
  }
}
