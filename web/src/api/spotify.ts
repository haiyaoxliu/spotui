import { api } from './client'
import { isCookieMode } from '../auth/auth'
import { notify } from '../console'
import { fetchClusterSnapshot } from './state'
import {
  connectNext,
  connectPause,
  connectPlay,
  connectPrev,
  connectQueueAdd,
  connectRepeat,
  connectSeek,
  connectShuffle,
  connectTransfer,
  connectVolume,
  tryConnect,
} from './connect'
import {
  addToPlaylistViaPathfinder,
  buildPathfinderNextUrl,
  fetchAlbumTracksViaPathfinder,
  fetchPageViaPathfinder,
  isPathfinderNextUrl,
  isRetryablePathfinderError,
  searchMoreViaPathfinder,
  searchViaPathfinder,
} from './pathfinder'

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

/** Where an upcoming queue entry came from. Connect-state populates this
 *  in cookie mode; the public Web API (`/v1/me/player/queue`) doesn't
 *  expose it, so the field is absent in PKCE-only mode. */
export type QueueProvider = 'queue' | 'context' | 'autoplay' | string

export interface Track {
  id: string
  name: string
  uri: string
  duration_ms: number
  artists: Artist[]
  album: Album
  type: 'track'
  _provider?: QueueProvider
}

export interface Episode {
  id: string
  name: string
  uri: string
  duration_ms: number
  show?: { id: string; name: string; images: SpotifyImage[] }
  type: 'episode'
  _provider?: QueueProvider
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
  if (isCookieMode()) {
    try {
      return (await fetchClusterSnapshot()).playback
    } catch (e) {
      notify('connect-state snapshot failed; falling back to /v1/me/player', 'warn')
      console.warn('[spotui] connect-state snapshot failed, falling back:', e)
    }
  }
  return api<PlaybackState>('/me/player')
}

export async function getQueue(): Promise<Queue | null> {
  if (isCookieMode()) {
    try {
      return (await fetchClusterSnapshot()).queue
    } catch (e) {
      notify('connect-state queue failed; falling back to /v1/me/player/queue', 'warn')
      console.warn('[spotui] connect-state queue failed, falling back:', e)
    }
  }
  return api<Queue>('/me/player/queue')
}

export async function addToQueue(uri: string, deviceId?: string): Promise<void> {
  await tryConnect(
    () => connectQueueAdd(uri),
    async () => {
      const params = new URLSearchParams({ uri })
      if (deviceId) params.set('device_id', deviceId)
      await api(`/me/player/queue?${params.toString()}`, { method: 'POST' })
    },
  )
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

// Single-page version of the same. Used by stores that paginate on demand
// (loadMore-style) instead of pulling the whole collection up-front. The
// returned `nextPath` is already stripped of the API base so the caller can
// hand it straight back as the next URL.
export interface PageSlice<T> {
  items: T[]
  nextPath: string | null
  total: number | null
}
export async function fetchPage<T>(path: string): Promise<PageSlice<T>> {
  // Cookie/Pathfinder path first; falls back to public Web API only on
  // 429 / network errors (mirrors spogo's `auto` engine). GraphQL errors
  // surface so we notice schema drift instead of silently DDOSing /v1.
  if (isCookieMode()) {
    try {
      const slice = await fetchPageViaPathfinder<T>(path)
      if (slice) return slice
    } catch (e) {
      if (!isRetryablePathfinderError(e)) throw e
      notify(`pathfinder ${path} rate-limited; falling back to /v1`, 'warn')
      console.warn('[spotui] pathfinder fetchPage rate-limited/transport, falling back:', e)
    }
  }
  const page = await api<Page<T>>(path)
  if (!page) return { items: [], nextPath: null, total: null }
  return {
    items: page.items,
    nextPath: page.next ? page.next.replace('https://api.spotify.com/v1', '') : null,
    total: typeof page.total === 'number' ? page.total : null,
  }
}

export const PLAYLISTS_PAGE_PATH = '/me/playlists?limit=50'

export const PLAYLIST_ITEMS_PAGE_PATH = (id: string) =>
  `/playlists/${id}/items?limit=100`
export const SAVED_TRACKS_PAGE_PATH = '/me/tracks?limit=50'

// Album tracks come from /albums/{id}/tracks as SimplifiedTrack objects: no
// embedded album field (since they're already nested under the album).
// selectAlbum hydrates them to full Track shape using the SimplifiedAlbum we
// already have from the search result.
interface SimplifiedAlbumTrack {
  id: string
  name: string
  uri: string
  duration_ms: number
  artists: Artist[]
  type: 'track'
}

export async function getAlbumTracks(albumId: string, max = 200): Promise<SimplifiedAlbumTrack[]> {
  if (isCookieMode()) {
    try {
      return await fetchAlbumTracksViaPathfinder(albumId, max)
    } catch (e) {
      notify('pathfinder getAlbum failed; falling back to /v1/albums/.../tracks', 'warn')
      console.warn('[spotui] pathfinder getAlbum failed, falling back:', e)
    }
  }
  return fetchAllPages<SimplifiedAlbumTrack>(`/albums/${albumId}/tracks?limit=50`, max)
}

// Stays on /v1 — spogo doesn't implement a connect-state path either, and
// the official Pathfinder op name isn't documented. Low risk of triggering
// rate limits because this only fires when the user opens the recently-
// played view, not on every page load. If this becomes a problem, the spclient
// `recently-played-tracks/v3/user-listening-history-tracks` endpoint is the
// next thing to try.
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
  tracks?: { items: Track[]; total: number; next?: string | null }
  albums?: { items: SimplifiedAlbum[]; total: number; next?: string | null }
  artists?: { items: ArtistObject[]; total: number; next?: string | null }
  // Spotify can return null entries here when an item is unavailable.
  playlists?: { items: (Playlist | null)[]; total: number; next?: string | null }
}

export type SearchTab = 'tracks' | 'albums' | 'artists' | 'playlists'

// Per-tab page size for the cookie/Pathfinder path. 50 is the actual hard
// cap searchDesktop returns — asking for more is silently clamped. The
// public Web API used to cap at 10 in dev mode; that constraint no longer
// applies. Bumping to 50 fills four tabs (200 rows total) on first response
// and keeps loadMore at the same step size.
const SEARCH_LIMIT = 50

export async function search(q: string): Promise<SearchResults> {
  const trimmed = q.trim()
  if (!trimmed) return {}
  // Cookie/Pathfinder path first; only fall back to /v1 on 429 / network
  // errors so a Pathfinder schema drift doesn't quietly redirect every
  // search to the rate-limited public API.
  if (isCookieMode()) {
    try {
      const pf = await searchViaPathfinder(trimmed, SEARCH_LIMIT, 0)
      return synthesizeNexts(trimmed, pf)
    } catch (e) {
      if (!isRetryablePathfinderError(e)) throw e
      notify('pathfinder search rate-limited; falling back to /v1/search', 'warn')
      console.warn('[spotui] pathfinder search rate-limited/transport, falling back:', e)
    }
  }
  const params = new URLSearchParams({
    q: trimmed,
    type: 'track,album,artist,playlist',
    limit: '10',
  })
  const res = await api<SearchResults>(`/search?${params.toString()}`)
  return res ?? {}
}

// Follow a per-type next URL — either a Pathfinder synthetic
// (`pathfinder:search?...`) or a real Spotify Web API URL.
export async function searchMore<K extends SearchTab>(
  nextUrl: string,
): Promise<SearchResults[K] | null> {
  if (isPathfinderNextUrl(nextUrl)) {
    try {
      const result = await searchMoreViaPathfinder(nextUrl)
      if (!result) return null
      return result.slice as SearchResults[K]
    } catch (e) {
      if (!isRetryablePathfinderError(e)) throw e
      notify('pathfinder searchMore rate-limited; falling back to /v1', 'warn')
      console.warn('[spotui] pathfinder searchMore rate-limited/transport, falling back:', e)
      // Can't translate a synthetic URL into a public-API URL, so fall
      // through to a fresh public-API page as a best-effort backstop.
    }
  }
  const path = nextUrl.replace('https://api.spotify.com/v1', '')
  const res = await api<SearchResults>(path)
  if (!res) return null
  // The single-type response only has the requested tab populated.
  for (const k of ['tracks', 'albums', 'artists', 'playlists'] as SearchTab[]) {
    if (res[k]) return res[k] as SearchResults[K]
  }
  return null
}

/** Pathfinder doesn't return next URLs — it's offset-based. We synthesize
 *  per-tab next URLs so the existing `searchMore` flow keeps working. */
function synthesizeNexts(q: string, results: SearchResults): SearchResults {
  const out: SearchResults = {}
  if (results.tracks) {
    out.tracks = withNext(results.tracks, q, 'tracks', SEARCH_LIMIT)
  }
  if (results.albums) {
    out.albums = withNext(results.albums, q, 'albums', SEARCH_LIMIT)
  }
  if (results.artists) {
    out.artists = withNext(results.artists, q, 'artists', SEARCH_LIMIT)
  }
  if (results.playlists) {
    out.playlists = withNext(results.playlists, q, 'playlists', SEARCH_LIMIT)
  }
  return out
}

function withNext<T extends { items: unknown[]; total: number; next?: string | null }>(
  slice: T,
  q: string,
  tab: SearchTab,
  limit: number,
): T {
  const fetched = slice.items.length
  const next =
    fetched > 0 && fetched < slice.total
      ? buildPathfinderNextUrl(q, tab, fetched, limit)
      : null
  return { ...slice, next }
}

export async function getDevices(): Promise<Device[]> {
  if (isCookieMode()) {
    try {
      return (await fetchClusterSnapshot()).devices
    } catch (e) {
      notify('connect-state devices failed; falling back to /v1/me/player/devices', 'warn')
      console.warn('[spotui] connect-state devices failed, falling back:', e)
    }
  }
  const res = await api<{ devices: Device[] }>('/me/player/devices')
  return res?.devices ?? []
}

export async function transferPlayback(deviceId: string, play = false): Promise<void> {
  await tryConnect(
    () => connectTransfer(deviceId, play),
    () =>
      api('/me/player', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_ids: [deviceId], play }),
      }),
  )
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
  const { contextUri, uris, offsetUri, offsetPosition, positionMs } = opts
  // Connect-state path handles resume, single-context, single-track, and
  // contextUri+offsetUri. Multi-URI ad-hoc lists and offsetPosition (numeric
  // index) fall back to the public Web API which has richer semantics.
  const multi = !!uris && uris.length > 1
  const usesPosition = offsetPosition != null
  if (!multi && !usesPosition) {
    const single = uris && uris.length === 1 ? uris[0] : undefined
    return tryConnect(
      () =>
        connectPlay({
          contextUri,
          offsetUri,
          uri: single,
          positionMs: positionMs ?? undefined,
        }),
      () => publicPlay(opts),
    )
  }
  return publicPlay(opts)
}

async function publicPlay(opts: PlayOptions): Promise<void> {
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
  await tryConnect(connectPause, async () => {
    const path = deviceId ? `/me/player/pause?device_id=${deviceId}` : '/me/player/pause'
    await api(path, { method: 'PUT' })
  })
}

export async function next(deviceId?: string): Promise<void> {
  await tryConnect(connectNext, async () => {
    const path = deviceId ? `/me/player/next?device_id=${deviceId}` : '/me/player/next'
    await api(path, { method: 'POST' })
  })
}

export async function previous(deviceId?: string): Promise<void> {
  await tryConnect(connectPrev, async () => {
    const path = deviceId ? `/me/player/previous?device_id=${deviceId}` : '/me/player/previous'
    await api(path, { method: 'POST' })
  })
}

export async function setShuffle(state: boolean, deviceId?: string): Promise<void> {
  await tryConnect(
    () => connectShuffle(state),
    async () => {
      const params = new URLSearchParams({ state: String(state) })
      if (deviceId) params.set('device_id', deviceId)
      await api(`/me/player/shuffle?${params.toString()}`, { method: 'PUT' })
    },
  )
}

export async function setRepeat(
  state: 'off' | 'context' | 'track',
  deviceId?: string,
): Promise<void> {
  await tryConnect(
    () => connectRepeat(state),
    async () => {
      const params = new URLSearchParams({ state })
      if (deviceId) params.set('device_id', deviceId)
      await api(`/me/player/repeat?${params.toString()}`, { method: 'PUT' })
    },
  )
}

export async function setVolume(percent: number, deviceId?: string): Promise<void> {
  const clamped = Math.max(0, Math.min(100, Math.round(percent)))
  await tryConnect(
    () => connectVolume(clamped),
    async () => {
      const params = new URLSearchParams({ volume_percent: String(clamped) })
      if (deviceId) params.set('device_id', deviceId)
      await api(`/me/player/volume?${params.toString()}`, { method: 'PUT' })
    },
  )
}

export async function seek(positionMs: number, deviceId?: string): Promise<void> {
  const ms = Math.max(0, Math.round(positionMs))
  await tryConnect(
    () => connectSeek(ms),
    async () => {
      const params = new URLSearchParams({ position_ms: String(ms) })
      if (deviceId) params.set('device_id', deviceId)
      await api(`/me/player/seek?${params.toString()}`, { method: 'PUT' })
    },
  )
}

// ---------- Library save/remove (unified /me/library) ----------

// Per-URI cache for /me/library/contains. App.tsx re-runs the contains
// check on every track change, so without this we'd hit /v1/me/library
// on every skip — the public Web API is the rate-limited host. Cache is
// a Map<uri, boolean> populated on read and updated on save/remove.
const libraryContainsCache = new Map<string, boolean>()

export async function saveToLibrary(uris: string[]): Promise<void> {
  if (uris.length === 0) return
  const params = new URLSearchParams({ uris: uris.join(',') })
  await api(`/me/library?${params.toString()}`, { method: 'PUT' })
  for (const uri of uris) libraryContainsCache.set(uri, true)
}

export async function removeFromLibrary(uris: string[]): Promise<void> {
  if (uris.length === 0) return
  const params = new URLSearchParams({ uris: uris.join(',') })
  await api(`/me/library?${params.toString()}`, { method: 'DELETE' })
  for (const uri of uris) libraryContainsCache.set(uri, false)
}

export async function checkLibraryContains(uris: string[]): Promise<boolean[]> {
  if (uris.length === 0) return []
  // Slot every URI: known values come from the cache; misses get a single
  // batched /v1 call. Preserves caller order.
  const result: (boolean | null)[] = uris.map((uri) =>
    libraryContainsCache.has(uri) ? (libraryContainsCache.get(uri) as boolean) : null,
  )
  const missingIndices: number[] = []
  const missingUris: string[] = []
  result.forEach((v, i) => {
    if (v === null) {
      missingIndices.push(i)
      missingUris.push(uris[i])
    }
  })
  if (missingUris.length > 0) {
    const params = new URLSearchParams({ uris: missingUris.join(',') })
    const fetched = (await api<boolean[]>(
      `/me/library/contains?${params.toString()}`,
    )) ?? []
    missingIndices.forEach((idx, k) => {
      const v = fetched[k] ?? false
      libraryContainsCache.set(uris[idx], v)
      result[idx] = v
    })
  }
  return result.map((v) => v ?? false)
}

// ---------- Playlist mutation ----------

// Cookie path: Pathfinder `addToPlaylist` mutation (no /v1 traffic).
// PKCE path: legacy POST /v1/playlists/{id}/items (max 100 URIs/call).
export async function addItemsToPlaylist(
  playlistId: string,
  uris: string[],
): Promise<void> {
  if (uris.length === 0) return
  if (isCookieMode()) {
    try {
      await addToPlaylistViaPathfinder(playlistId, uris)
      return
    } catch (e) {
      notify('pathfinder addToPlaylist failed; falling back to /v1', 'warn')
      console.warn('[spotui] pathfinder addToPlaylist failed, falling back:', e)
    }
  }
  const params = new URLSearchParams({ uris: uris.join(',') })
  await api(`/playlists/${playlistId}/items?${params.toString()}`, {
    method: 'POST',
  })
}
