/**
 * Spotify Jam (formerly Group Session / Listening Together) via
 * `gae2-spclient.spotify.com/social-connect/v2/sessions/...`. Cookie-only.
 *
 * State model:
 *   GET  /sessions/current        — 200 + payload if user is in a jam,
 *                                    404 if not
 *   GET  /sessions/current_or_new — same as `current` but creates a new
 *                                    session as a side effect when none
 *                                    exists. Use only for explicit "Start
 *                                    Jam" intent.
 *   DELETE /sessions/{id}         — leave / end the session (owner) or
 *                                    leave (participant)
 */

import type { CookieReadResult } from '../cookies/index.js'
import { truncate } from '../util/truncate.js'
import { webPlayerHeaders } from './headers.js'
import { getSessionAuth } from './session.js'

const JAM_BASE = 'https://gae2-spclient.spotify.com/social-connect/v2/sessions'

/** Returns the current jam payload, or null if the user isn't in one. */
export async function getCurrentSession(
  read: CookieReadResult,
): Promise<unknown | null> {
  const auth = await getSessionAuth(read)
  const res = await fetch(`${JAM_BASE}/current`, {
    headers: webPlayerHeaders(auth),
  })
  if (res.status === 404) return null
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`jam current ${res.status}: ${truncate(body)}`)
  }
  return res.json()
}

/** Reads the current session if one exists, else creates a new session
 *  with the user as owner. Returns the resulting payload. */
export async function startSession(read: CookieReadResult): Promise<unknown> {
  const auth = await getSessionAuth(read)
  const res = await fetch(`${JAM_BASE}/current_or_new`, {
    headers: webPlayerHeaders(auth),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`jam start ${res.status}: ${truncate(body)}`)
  }
  return res.json()
}

/** Leave (or end, if owner) the named session. */
export async function leaveSession(
  read: CookieReadResult,
  sessionId: string,
): Promise<void> {
  if (!/^[a-zA-Z0-9]+$/.test(sessionId)) {
    throw new Error('invalid session id')
  }
  const auth = await getSessionAuth(read)
  const res = await fetch(`${JAM_BASE}/${sessionId}`, {
    method: 'DELETE',
    headers: webPlayerHeaders(auth),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`jam leave ${res.status}: ${truncate(body)}`)
  }
}

