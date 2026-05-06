/**
 * Friend activity ("Friend Feed" in the official mobile app) via
 * `guc-spclient.spotify.com/presence-view/v1/buddylist`. Cookie-only —
 * Spotify's public Web API has no equivalent endpoint.
 *
 * Returns each followed friend's most recent listening event, including
 * the track + the context (playlist / album / artist) it was played in.
 */

import type { CookieReadResult } from '../cookies/index.js'
import { truncate } from '../util/truncate.js'
import { webPlayerHeaders } from './headers.js'
import { getSessionAuth } from './session.js'

const BUDDYLIST_URL =
  'https://guc-spclient.spotify.com/presence-view/v1/buddylist'

export async function fetchBuddylist(read: CookieReadResult): Promise<unknown> {
  const auth = await getSessionAuth(read)
  const res = await fetch(BUDDYLIST_URL, { headers: webPlayerHeaders(auth) })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`buddylist ${res.status}: ${truncate(body)}`)
  }
  return res.json()
}
