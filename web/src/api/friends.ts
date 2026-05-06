/**
 * SPA client for friend activity (Spotify's "Friend Feed").
 *
 * Endpoint:
 *   GET /api/proxy/friends
 *     → { friends: [{ timestamp, user, track }, ...] }
 *
 * Each entry is the friend's most recent listening event with the track,
 * the album, the artist, and the playing context (playlist/album).
 */

import { truncate } from '../util/truncate'

export interface FriendUser {
  uri: string
  name: string
  imageUrl?: string
}

export interface FriendTrackContext {
  uri: string
  name: string
  index?: number
}

export interface FriendTrack {
  uri: string
  name: string
  imageUrl?: string
  album: { uri: string; name: string }
  artist: { uri: string; name: string }
  context?: FriendTrackContext
}

export interface FriendActivity {
  /** Unix milliseconds — when the friend was last reported listening. */
  timestamp: number
  user: FriendUser
  track: FriendTrack
}

interface RawResponse {
  friends?: FriendActivity[]
}

export async function fetchFriendActivity(): Promise<FriendActivity[]> {
  const res = await fetch('/api/proxy/friends')
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`friends ${res.status}: ${truncate(body)}`)
  }
  const payload = (await res.json()) as RawResponse
  return payload.friends ?? []
}
