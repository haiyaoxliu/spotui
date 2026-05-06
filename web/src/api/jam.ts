/**
 * SPA client for Spotify Jam (group listening) via the sidecar.
 *
 *   GET  /api/proxy/jam        → 200 + payload | 404 if not in a jam
 *   POST /api/proxy/jam/start  → 200 + payload (creates if needed)
 *   POST /api/proxy/jam/leave  body: { sessionId } → 204
 */

export interface JamMember {
  id: string
  username: string
  displayName?: string
  imageUrl?: string
  largeImageUrl?: string
  isListening: boolean
  isControlling: boolean
  joinedTimestamp: string
  isCurrentUser: boolean
  playbackControl?: 'LISTEN_AND_CONTROL' | 'LISTEN_ONLY' | string
}

export interface JamSession {
  sessionId: string
  joinSessionToken: string
  joinSessionUrl: string
  joinSessionUri: string
  sessionOwnerId: string
  isSessionOwner: boolean
  isListening: boolean
  isControlling: boolean
  isPaused: boolean
  initialSessionType: string
  hostActiveDeviceId: string
  maxMemberCount: number
  queueOnlyMode: boolean
  members: JamMember[]
}

interface RawSession {
  session_id: string
  join_session_token: string
  join_session_url: string
  join_session_uri: string
  session_owner_id: string
  is_session_owner: boolean
  is_listening: boolean
  is_controlling: boolean
  is_paused: boolean
  initialSessionType: string
  hostActiveDeviceId: string
  maxMemberCount: number
  queue_only_mode: boolean
  session_members: RawMember[]
}

interface RawMember {
  id: string
  username: string
  display_name?: string
  image_url?: string
  large_image_url?: string
  is_listening?: boolean
  is_controlling?: boolean
  joined_timestamp: string
  is_current_user?: boolean
  playbackControl?: string
}

function adapt(raw: RawSession): JamSession {
  return {
    sessionId: raw.session_id,
    joinSessionToken: raw.join_session_token,
    joinSessionUrl: raw.join_session_url,
    joinSessionUri: raw.join_session_uri,
    sessionOwnerId: raw.session_owner_id,
    isSessionOwner: raw.is_session_owner,
    isListening: raw.is_listening,
    isControlling: raw.is_controlling,
    isPaused: raw.is_paused,
    initialSessionType: raw.initialSessionType,
    hostActiveDeviceId: raw.hostActiveDeviceId,
    maxMemberCount: raw.maxMemberCount,
    queueOnlyMode: raw.queue_only_mode,
    members: (raw.session_members ?? []).map(
      (m): JamMember => ({
        id: m.id,
        username: m.username,
        displayName: m.display_name,
        imageUrl: m.image_url,
        largeImageUrl: m.large_image_url,
        isListening: !!m.is_listening,
        isControlling: !!m.is_controlling,
        joinedTimestamp: m.joined_timestamp,
        isCurrentUser: !!m.is_current_user,
        playbackControl: m.playbackControl,
      }),
    ),
  }
}

/** Read current jam session, or null if the user isn't in one. */
export async function fetchCurrentJam(): Promise<JamSession | null> {
  const res = await fetch('/api/proxy/jam')
  if (res.status === 404) return null
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`jam ${res.status}: ${truncate(body)}`)
  }
  return adapt((await res.json()) as RawSession)
}

/** Create a new jam (or return the existing one if already in one). */
export async function startJam(): Promise<JamSession> {
  const res = await fetch('/api/proxy/jam/start', { method: 'POST' })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`jam start ${res.status}: ${truncate(body)}`)
  }
  return adapt((await res.json()) as RawSession)
}

/** End (owner) or leave (participant) the named session. */
export async function leaveJam(sessionId: string): Promise<void> {
  const res = await fetch('/api/proxy/jam/leave', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId }),
  })
  if (res.status === 204) return
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`jam leave ${res.status}: ${truncate(body)}`)
  }
}

/** Public-facing share link Spotify uses for jam invites. */
export function jamShareLink(token: string): string {
  return `https://open.spotify.com/socialsession/${encodeURIComponent(token)}`
}

function truncate(s: string): string {
  return s.length > 200 ? `${s.slice(0, 200)}...` : s
}
