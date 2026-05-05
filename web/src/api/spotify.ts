import { api } from './client'

export interface SpotifyImage {
  url: string
  width: number | null
  height: number | null
}

export interface Artist {
  id: string
  name: string
  uri: string
}

export interface Album {
  id: string
  name: string
  uri: string
  images: SpotifyImage[]
}

export interface Track {
  id: string
  name: string
  uri: string
  duration_ms: number
  artists: Artist[]
  album: Album
  type: 'track'
}

export interface Episode {
  id: string
  name: string
  uri: string
  duration_ms: number
  show?: { id: string; name: string; images: SpotifyImage[] }
  type: 'episode'
}

export type PlayingItem = Track | Episode

export interface Device {
  id: string | null
  name: string
  type: string
  volume_percent: number | null
  is_active: boolean
  is_restricted: boolean
  is_private_session: boolean
  supports_volume?: boolean
}

export interface PlaybackState {
  device: Device
  is_playing: boolean
  progress_ms: number | null
  item: PlayingItem | null
  shuffle_state: boolean
  repeat_state: 'off' | 'track' | 'context'
  context: { uri: string; type: string } | null
  currently_playing_type: 'track' | 'episode' | 'ad' | 'unknown'
}

export interface Queue {
  currently_playing: PlayingItem | null
  queue: PlayingItem[]
}

export async function getPlaybackState(): Promise<PlaybackState | null> {
  return api<PlaybackState>('/me/player')
}

export async function getQueue(): Promise<Queue | null> {
  return api<Queue>('/me/player/queue')
}

export async function addToQueue(uri: string, deviceId?: string): Promise<void> {
  const params = new URLSearchParams({ uri })
  if (deviceId) params.set('device_id', deviceId)
  await api(`/me/player/queue?${params.toString()}`, { method: 'POST' })
}

// ---------- Library / playlists ----------

export interface Playlist {
  id: string
  name: string
  description: string | null
  uri: string
  // Spec line 6255 / 6185: `items` is the canonical PlaylistTracksRefObject
  // on both SimplifiedPlaylistObject and PlaylistObject. The legacy `tracks`
  // sibling field is `deprecated: true` — never read it.
  items: { total: number; href: string }
  images: SpotifyImage[]
  owner: { display_name?: string; id: string }
  collaborative: boolean
  public: boolean | null
}

export interface PlaylistItem {
  added_at: string
  // /items endpoint canonical field. The legacy `track` field on the same
  // object is deprecated per spec (line 4938) — readers should prefer `item`.
  item: Track | Episode | null
  track?: Track | Episode | null
}

export interface SavedTrack {
  added_at: string
  track: Track
}

export interface PlayHistoryItem {
  played_at: string
  track: Track
  context: { uri: string; type: string } | null
}

interface Page<T> {
  items: T[]
  total: number
  next: string | null
  previous: string | null
  limit: number
  offset: number
}

interface CursorPage<T> {
  items: T[]
  next: string | null
  cursors: { after?: string; before?: string } | null
  limit: number
  href: string
}

async function fetchAllPages<T>(initialPath: string, max = 1000): Promise<T[]> {
  const all: T[] = []
  let nextPath: string | null = initialPath
  while (nextPath && all.length < max) {
    const page: Page<T> | null = await api<Page<T>>(nextPath)
    if (!page) break
    all.push(...page.items)
    nextPath = page.next ? page.next.replace('https://api.spotify.com/v1', '') : null
  }
  return all
}

export async function getMyPlaylists(max = 200): Promise<Playlist[]> {
  return fetchAllPages<Playlist>('/me/playlists?limit=50', max)
}

// GET /playlists/{id}/items returns 403 for playlists not owned by or
// collaborated on by the current user (spec line 1193). Use this only for
// editable selections; non-owned (e.g. pinned Spotify-curated playlists like
// Discover Weekly) need getPlaylistItemsViaFull below.
export async function getPlaylistItems(playlistId: string, max = 500): Promise<PlaylistItem[]> {
  return fetchAllPages<PlaylistItem>(`/playlists/${playlistId}/items?limit=100`, max)
}

// Fallback for non-owned/collab playlists: GET /playlists/{id} (spec line
// 848) has no ownership restriction and returns a full PlaylistObject with
// embedded paged items. We pull the first page out of the response, then
// follow `items.next` for the rest using the same pagination as elsewhere.
export async function getPlaylistItemsViaFull(
  playlistId: string,
  max = 500,
): Promise<PlaylistItem[]> {
  const full = await api<{ items?: Page<PlaylistItem> | null }>(
    `/playlists/${playlistId}`,
  )
  const firstPage = full?.items
  if (!firstPage) return []
  const all: PlaylistItem[] = [...firstPage.items]
  let nextPath: string | null = firstPage.next
    ? firstPage.next.replace('https://api.spotify.com/v1', '')
    : null
  while (nextPath && all.length < max) {
    const page: Page<PlaylistItem> | null = await api<Page<PlaylistItem>>(nextPath)
    if (!page) break
    all.push(...page.items)
    nextPath = page.next ? page.next.replace('https://api.spotify.com/v1', '') : null
  }
  return all
}

export async function getSavedTracks(max = 200): Promise<SavedTrack[]> {
  return fetchAllPages<SavedTrack>('/me/tracks?limit=50', max)
}

export async function getRecentlyPlayed(): Promise<PlayHistoryItem[]> {
  const page = await api<CursorPage<PlayHistoryItem>>('/me/player/recently-played?limit=50')
  return page?.items ?? []
}

// ---------- Search ----------

export interface SimplifiedAlbum {
  id: string
  name: string
  uri: string
  album_type: string
  artists: Artist[]
  images: SpotifyImage[]
  release_date: string
  total_tracks: number
}

export interface ArtistObject {
  id: string
  name: string
  uri: string
  images?: SpotifyImage[]
  genres?: string[]
  followers?: { total: number }
}

export interface SearchResults {
  tracks?: { items: Track[]; total: number }
  albums?: { items: SimplifiedAlbum[]; total: number }
  artists?: { items: ArtistObject[]; total: number }
  // Spotify can return null entries here when an item is unavailable.
  playlists?: { items: (Playlist | null)[]; total: number }
}

export async function search(q: string): Promise<SearchResults> {
  const trimmed = q.trim()
  if (!trimmed) return {}
  // Spec line 789: max limit per type is 10.
  const params = new URLSearchParams({
    q: trimmed,
    type: 'track,album,artist,playlist',
    limit: '10',
  })
  const res = await api<SearchResults>(`/search?${params.toString()}`)
  return res ?? {}
}

export async function getDevices(): Promise<Device[]> {
  const res = await api<{ devices: Device[] }>('/me/player/devices')
  return res?.devices ?? []
}

export async function transferPlayback(deviceId: string): Promise<void> {
  await api('/me/player', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_ids: [deviceId] }),
  })
}

export interface PlayOptions {
  contextUri?: string
  uris?: string[]
  offsetUri?: string
  offsetPosition?: number
  positionMs?: number
  deviceId?: string
}

export async function play(opts: PlayOptions = {}): Promise<void> {
  const { deviceId, contextUri, uris, offsetUri, offsetPosition, positionMs } = opts
  const path = deviceId ? `/me/player/play?device_id=${deviceId}` : '/me/player/play'
  const body: Record<string, unknown> = {}
  if (contextUri) body.context_uri = contextUri
  if (uris) body.uris = uris
  if (offsetUri) body.offset = { uri: offsetUri }
  else if (offsetPosition != null) body.offset = { position: offsetPosition }
  if (positionMs != null) body.position_ms = positionMs

  const init: RequestInit = { method: 'PUT' }
  if (Object.keys(body).length > 0) {
    init.headers = { 'Content-Type': 'application/json' }
    init.body = JSON.stringify(body)
  }
  await api(path, init)
}

export async function pause(deviceId?: string): Promise<void> {
  const path = deviceId ? `/me/player/pause?device_id=${deviceId}` : '/me/player/pause'
  await api(path, { method: 'PUT' })
}

export async function next(deviceId?: string): Promise<void> {
  const path = deviceId ? `/me/player/next?device_id=${deviceId}` : '/me/player/next'
  await api(path, { method: 'POST' })
}

export async function previous(deviceId?: string): Promise<void> {
  const path = deviceId ? `/me/player/previous?device_id=${deviceId}` : '/me/player/previous'
  await api(path, { method: 'POST' })
}

export async function setShuffle(state: boolean, deviceId?: string): Promise<void> {
  const params = new URLSearchParams({ state: String(state) })
  if (deviceId) params.set('device_id', deviceId)
  await api(`/me/player/shuffle?${params.toString()}`, { method: 'PUT' })
}

export async function setRepeat(
  state: 'off' | 'context' | 'track',
  deviceId?: string,
): Promise<void> {
  const params = new URLSearchParams({ state })
  if (deviceId) params.set('device_id', deviceId)
  await api(`/me/player/repeat?${params.toString()}`, { method: 'PUT' })
}

export async function setVolume(percent: number, deviceId?: string): Promise<void> {
  const clamped = Math.max(0, Math.min(100, Math.round(percent)))
  const params = new URLSearchParams({ volume_percent: String(clamped) })
  if (deviceId) params.set('device_id', deviceId)
  await api(`/me/player/volume?${params.toString()}`, { method: 'PUT' })
}

export async function seek(positionMs: number, deviceId?: string): Promise<void> {
  const ms = Math.max(0, Math.round(positionMs))
  const params = new URLSearchParams({ position_ms: String(ms) })
  if (deviceId) params.set('device_id', deviceId)
  await api(`/me/player/seek?${params.toString()}`, { method: 'PUT' })
}

// ---------- Library save/remove (unified /me/library) ----------

export async function saveToLibrary(uris: string[]): Promise<void> {
  if (uris.length === 0) return
  const params = new URLSearchParams({ uris: uris.join(',') })
  await api(`/me/library?${params.toString()}`, { method: 'PUT' })
}

export async function removeFromLibrary(uris: string[]): Promise<void> {
  if (uris.length === 0) return
  const params = new URLSearchParams({ uris: uris.join(',') })
  await api(`/me/library?${params.toString()}`, { method: 'DELETE' })
}

export async function checkLibraryContains(uris: string[]): Promise<boolean[]> {
  if (uris.length === 0) return []
  const params = new URLSearchParams({ uris: uris.join(',') })
  const res = await api<boolean[]>(`/me/library/contains?${params.toString()}`)
  return res ?? []
}

// ---------- Playlist mutation ----------

// Spec line 1232 (operationId: add-items-to-playlist) — the canonical add
// endpoint. The legacy POST /playlists/{id}/tracks (line 998) is deprecated.
// Max 100 URIs per call.
export async function addItemsToPlaylist(
  playlistId: string,
  uris: string[],
): Promise<void> {
  if (uris.length === 0) return
  const params = new URLSearchParams({ uris: uris.join(',') })
  await api(`/playlists/${playlistId}/items?${params.toString()}`, {
    method: 'POST',
  })
}
