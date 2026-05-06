/**
 * Friend activity ("Friend Feed" in the official mobile app) via
 * `guc-spclient.spotify.com/presence-view/v1/buddylist`. Cookie-only —
 * Spotify's public Web API has no equivalent endpoint.
 *
 * Returns each followed friend's most recent listening event, including
 * the track + the context (playlist / album / artist) it was played in.
 */

import type { CookieReadResult } from '../cookies/index.js'
import { getSessionAuth } from './session.js'

const BUDDYLIST_URL =
  'https://guc-spclient.spotify.com/presence-view/v1/buddylist'

const SEC_CH_UA =
  '"Chromium";v="131", "Not_A Brand";v="24", "Google Chrome";v="131"'

export async function fetchBuddylist(read: CookieReadResult): Promise<unknown> {
  const auth = await getSessionAuth(read)
  const res = await fetch(BUDDYLIST_URL, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${auth.accessToken}`,
      'client-token': auth.clientToken,
      'app-platform': 'WebPlayer',
      'spotify-app-version': auth.clientVersion,
      Origin: 'https://open.spotify.com',
      Referer: 'https://open.spotify.com/',
      'Sec-CH-UA': SEC_CH_UA,
      'Sec-CH-UA-Platform': '"macOS"',
      'Sec-CH-UA-Mobile': '?0',
    },
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`buddylist ${res.status}: ${truncate(body)}`)
  }
  return res.json()
}

function truncate(s: string): string {
  return s.length > 200 ? `${s.slice(0, 200)}...` : s
}
