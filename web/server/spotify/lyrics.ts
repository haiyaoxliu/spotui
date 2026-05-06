/**
 * Spotify lyrics via `spclient.wg.spotify.com/color-lyrics/v2/track/{id}`.
 *
 * Returns line-level timed lyrics + extracted color metadata. Public Web
 * API has no lyrics endpoint at all; this is a cookie-path-only feature.
 *
 * Format (typical):
 * {
 *   "lyrics": {
 *     "syncType": "LINE_SYNCED" | "UNSYNCED",
 *     "lines": [{"startTimeMs":"12345","endTimeMs":"...","words":"…"}],
 *     "language": "en",
 *     "provider": "MusixMatch",
 *     ...
 *   },
 *   "colors": {"background": -16777216, "text": -1, "highlightText": -65536}
 * }
 */

import type { CookieReadResult } from '../cookies/index.js'
import { truncate } from '../util/truncate.js'
import { webPlayerHeaders } from './headers.js'
import { getSessionAuth } from './session.js'

export class LyricsNotFoundError extends Error {
  constructor(public readonly trackId: string) {
    super(`no lyrics for track ${trackId}`)
    this.name = 'LyricsNotFoundError'
  }
}

export async function fetchLyrics(
  read: CookieReadResult,
  trackId: string,
): Promise<unknown> {
  if (!/^[A-Za-z0-9]+$/.test(trackId)) {
    throw new Error(`invalid track id: ${trackId}`)
  }
  const auth = await getSessionAuth(read)
  const url = `https://spclient.wg.spotify.com/color-lyrics/v2/track/${trackId}?format=json&vocalRemoval=false`
  const res = await fetch(url, { headers: webPlayerHeaders(auth) })
  if (res.status === 404) {
    throw new LyricsNotFoundError(trackId)
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`lyrics ${res.status}: ${truncate(body)}`)
  }
  return await res.json()
}
