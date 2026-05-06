/**
 * Common header sets for spclient / Pathfinder / connect-state requests.
 *
 * Spotify's internal endpoints check a Chromium-shaped browser fingerprint
 * (Sec-CH-UA, App-Platform, etc.) plus our session bearer + client-token.
 * Centralizing the assembly avoids drift between callers and keeps the
 * one-off variations explicit.
 */
import type { SessionAuth } from './session.js'

export const SEC_CH_UA =
  '"Chromium";v="131", "Not_A Brand";v="24", "Google Chrome";v="131"'

export const APP_PLATFORM = 'WebPlayer'

export const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

export interface WebPlayerHeaderOptions {
  /** Add `Content-Type: application/json`. Set on POST/PUT bodies. */
  json?: boolean
  /** Add `Sec-Fetch-Site` value. spclient + Pathfinder use 'same-site';
   *  the token mint endpoint at open.spotify.com uses 'same-origin'. Most
   *  callers can omit this. */
  fetchSite?: 'same-site' | 'same-origin'
  /** Add an explicit `X-Spotify-Connection-Id` header (connect-state only). */
  connectionId?: string
}

/** Build the common `authorization: Bearer …` + `client-token: …` +
 *  `spotify-app-version: …` + Sec-CH-* header set used across spclient,
 *  Pathfinder, and connect-state. */
export function webPlayerHeaders(
  auth: SessionAuth,
  opts: WebPlayerHeaderOptions = {},
): Record<string, string> {
  const h: Record<string, string> = {
    Accept: 'application/json',
    Authorization: `Bearer ${auth.accessToken}`,
    'client-token': auth.clientToken,
    'app-platform': APP_PLATFORM,
    'spotify-app-version': auth.clientVersion,
    Origin: 'https://open.spotify.com',
    Referer: 'https://open.spotify.com/',
    'Sec-CH-UA': SEC_CH_UA,
    'Sec-CH-UA-Mobile': '?0',
    'Sec-CH-UA-Platform': '"macOS"',
  }
  if (opts.json) h['Content-Type'] = 'application/json'
  if (opts.fetchSite) {
    h['Sec-Fetch-Site'] = opts.fetchSite
    h['Sec-Fetch-Mode'] = 'cors'
    h['Sec-Fetch-Dest'] = 'empty'
  }
  if (opts.connectionId) h['X-Spotify-Connection-Id'] = opts.connectionId
  return h
}
