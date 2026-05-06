/**
 * Connect-state → public-Web-API shape mapping. The SPA's existing UI
 * consumes the public `/v1/me/player`, `/v1/me/player/queue`, and
 * `/v1/me/player/devices` shapes; this module produces them from the
 * cluster pull `connectClient.state(read)` returns.
 *
 * Why bother: api.spotify.com/v1 is rate-limited per account and was
 * 429'ing during normal browsing. Connect-state lives on a different host
 * (`*-spclient.spotify.com`) with a separate budget, and we already pull
 * it for the dealer SSE — one fetch covers playback + queue + devices.
 *
 * Metadata fidelity caveat: connect-state's player_state.track surfaces
 * a flat `metadata` dict with strings like `artist_name`, `album_title`,
 * `image_url`. That's enough for the SPA's transport bar / now-playing
 * (single artist string, single image), but multi-artist tracks lose the
 * per-artist breakdown vs. /v1/me/player. If we ever need full artist
 * objects we'd have to follow up with a Pathfinder lookup keyed by the
 * track URI. Falls back to URI parsing when even metadata is missing.
 */

import type { CookieReadResult } from '../cookies/index.js'
import { idFromUri, typeFromUri } from '../util/uri.js'

import { connectClient } from './connect.js'

// Server-side shapes that match the SPA's `src/api/spotify.ts` interfaces.
// Duplicated here to keep server/ and src/ tsconfigs separable (server's
// include list doesn't reach into src/).
interface SpotifyImage {
  url: string
  width: number | null
  height: number | null
}
interface Artist {
  id: string
  name: string
  uri: string
}
interface Album {
  id: string
  name: string
  uri: string
  images: SpotifyImage[]
}
/** Connect-state's `next_tracks[].provider` tells us where each upcoming
 *  track came from. The Web Player UI sections by this:
 *    - 'queue' — user-added via Add to Queue
 *    - 'context' — continues the active album/playlist/show
 *    - 'autoplay' — algorithmic recommendations after the context ends
 *  Anything else is preserved as-is so we don't silently drop new values. */
type QueueProvider = 'queue' | 'context' | 'autoplay' | string
interface Track {
  id: string
  name: string
  uri: string
  duration_ms: number
  artists: Artist[]
  album: Album
  type: 'track'
  /** Cookie-mode only; absent when sourced from /v1/me/player. */
  _provider?: QueueProvider
}
interface Episode {
  id: string
  name: string
  uri: string
  duration_ms: number
  show?: { id: string; name: string; images: SpotifyImage[] }
  type: 'episode'
  _provider?: QueueProvider
}
type PlayingItem = Track | Episode
interface Device {
  id: string | null
  name: string
  type: string
  volume_percent: number | null
  is_active: boolean
  is_restricted: boolean
  is_private_session: boolean
  supports_volume?: boolean
}
interface PlaybackState {
  device: Device
  is_playing: boolean
  progress_ms: number | null
  item: PlayingItem | null
  shuffle_state: boolean
  repeat_state: 'off' | 'track' | 'context'
  context: { uri: string; type: string } | null
  currently_playing_type: 'track' | 'episode' | 'ad' | 'unknown'
}
interface Queue {
  currently_playing: PlayingItem | null
  /** Public-Web-API contract: a flat list of upcoming items. Cookie-mode
   *  preserves the same shape but each item carries a `_provider` tag so
   *  the UI can filter user-added entries from autoplay/context
   *  continuation. The /v1/me/player/queue path leaves `_provider`
   *  undefined, since the public API doesn't expose it. */
  queue: PlayingItem[]
}

interface RawCluster {
  player_state?: RawPlayerState | null
  devices?: Record<string, RawDevice> | null
  active_device_id?: string | null
}

interface RawPlayerState {
  is_playing?: boolean
  is_paused?: boolean
  // Spotify reports position as `position_as_of_timestamp` plus a server
  // `timestamp`; for non-playing states `position_ms` may be present.
  position_as_of_timestamp?: number | string
  position_ms?: number | string
  timestamp?: number | string
  duration?: number | string
  shuffle?: boolean
  options?: { shuffling_context?: boolean; repeating_track?: boolean; repeating_context?: boolean }
  repeat?: string
  repeat_mode?: string
  context_uri?: string
  context_url?: string
  track?: RawTrack
  next_tracks?: RawTrack[]
  prev_tracks?: RawTrack[]
}

interface RawTrack {
  uri?: string
  uid?: string
  /** Connect-state encodes the "currently playing" track and queued
   *  `next_tracks` entries with subtly different shapes. The current
   *  track is usually a flat `metadata` dict; queued entries sometimes
   *  include richer nested fields (Pathfinder-style) at the top level.
   *  We probe both — see `mapTrack`. */
  metadata?: Record<string, string>
  provider?: string
  // Sometimes-present richer fields (mirror what spogo finds via
  // `findFirstArtistNames` / `findFirstName`).
  name?: string
  title?: string
  duration_ms?: number | string
  artists?: unknown
}

interface RawDevice {
  device_id?: string
  name?: string
  device_type?: string
  is_active?: boolean
  is_currently_playing?: boolean
  is_active_device?: boolean
  is_private_session?: boolean
  volume?: number | string
  /** Connect-state device capability map. We read `disable_volume` here —
   *  iOS reports `disable_volume: true` because PUT /me/player/volume
   *  silently 403s on those devices. The public Web API surfaces the same
   *  state as `supports_volume: false` + `volume_percent: null`. */
  capabilities?: {
    disable_volume?: boolean
  }
}

export interface ClusterSnapshot {
  playback: PlaybackState | null
  queue: Queue
  devices: Device[]
}

export type { Device, PlaybackState, PlayingItem, Queue, Track }

export async function fetchClusterSnapshot(
  read: CookieReadResult,
): Promise<ClusterSnapshot> {
  const cluster = (await connectClient.state(read)) as RawCluster
  return {
    playback: mapPlayback(cluster),
    queue: mapQueue(cluster),
    devices: mapDevices(cluster),
  }
}

/** Diagnostic-only: returns the raw cluster pull plus the mapped output
 *  so we can audit field-shape drift. Mounted at /api/proxy/state/raw.
 *  Safe to leave in — the cluster contains nothing the cookie holder
 *  doesn't already see in their /v1/me/player feed. */
export async function fetchRawCluster(
  read: CookieReadResult,
): Promise<{ cluster: unknown; mapped: ClusterSnapshot }> {
  const cluster = (await connectClient.state(read)) as RawCluster
  return {
    cluster,
    mapped: {
      playback: mapPlayback(cluster),
      queue: mapQueue(cluster),
      devices: mapDevices(cluster),
    },
  }
}

// ---- mapping ----------------------------------------------------------

function mapDevices(cluster: RawCluster): Device[] {
  const map = cluster.devices ?? {}
  const activeId = cluster.active_device_id ?? ''
  const out: Device[] = []
  for (const [id, raw] of Object.entries(map)) {
    const isActive = id === activeId
    const supportsVolume = raw.capabilities?.disable_volume !== true
    out.push({
      id,
      name: raw.name ?? '',
      type: (raw.device_type ?? '').toLowerCase(),
      // Devices with disable_volume still report a `volume` value (often
      // 65535) but it's meaningless. Mirror the public Web API which
      // returns volume_percent: null on supports_volume: false devices.
      volume_percent: supportsVolume ? volumeToPercent(raw.volume) : null,
      is_active: isActive || !!raw.is_active || !!raw.is_active_device,
      is_restricted: false,
      is_private_session: !!raw.is_private_session,
      supports_volume: supportsVolume,
    })
  }
  return out
}

function mapPlayback(cluster: RawCluster): PlaybackState | null {
  const player = cluster.player_state
  if (!player) return null
  const devices = mapDevices(cluster)
  const activeDevice = devices.find((d) => d.is_active) ?? devices[0]
  if (!activeDevice) return null
  const item = mapTrack(player.track)
  const isPlaying = derivePlaying(player)
  return {
    device: activeDevice,
    is_playing: isPlaying,
    progress_ms: deriveProgress(player, isPlaying),
    item,
    shuffle_state:
      player.options?.shuffling_context ?? player.shuffle ?? false,
    repeat_state: deriveRepeat(player),
    context: player.context_uri
      ? { uri: player.context_uri, type: typeFromUri(player.context_uri) }
      : null,
    currently_playing_type: item?.type ?? 'unknown',
  }
}

function mapQueue(cluster: RawCluster): Queue {
  const player = cluster.player_state
  if (!player) return { currently_playing: null, queue: [] }
  const rawNext = player.next_tracks ?? []
  const next = rawNext.flatMap((t) => {
    const m = mapTrack(t)
    if (!m) return []
    if (t.provider) m._provider = t.provider
    return [m]
  })
  return {
    currently_playing: mapTrack(player.track),
    queue: next,
  }
}

function mapTrack(raw: RawTrack | undefined): PlayingItem | null {
  if (!raw?.uri) return null
  const kind = typeFromUri(raw.uri)
  if (kind === 'episode') return mapEpisodeShape(raw)
  if (kind !== 'track') return null
  const md = raw.metadata ?? {}
  // Title: prefer flat metadata, fall back to top-level (next_tracks
  // entries sometimes carry Pathfinder-shaped fields directly).
  const name = md.title ?? raw.name ?? raw.title ?? ''
  // Duration: metadata.duration (string ms), then top-level numeric.
  const duration =
    parseIntStr(md.duration ?? '', NaN) ||
    parseIntStr(raw.duration_ms ?? '', NaN) ||
    0
  return {
    id: idFromUri(raw.uri),
    uri: raw.uri,
    name,
    duration_ms: duration,
    artists: mapArtists(md, raw),
    album: {
      id: md.album_uri ? idFromUri(md.album_uri) : '',
      name: md.album_title ?? '',
      uri: md.album_uri ?? '',
      images: mapAlbumImages(md),
    },
    type: 'track',
  }
}

function mapEpisodeShape(raw: RawTrack): PlayingItem | null {
  if (!raw.uri) return null
  const md = raw.metadata ?? {}
  return {
    id: idFromUri(raw.uri),
    uri: raw.uri,
    name: md.title ?? '',
    duration_ms: parseIntStr(md.duration ?? '0', 0),
    type: 'episode',
    show:
      md.album_uri || md.album_title
        ? {
            id: md.album_uri ? idFromUri(md.album_uri) : '',
            name: md.album_title ?? '',
            images: mapAlbumImages(md),
          }
        : undefined,
  }
}

/** Connect-state encodes track artists in at least three ways depending
 *  on which list the track came from:
 *    1. Flat metadata: `artist_name`, then `artist_name_1`, _2, …
 *       (with parallel `artist_uri_*`). Used by `next_tracks` entries
 *       in the queue.
 *    2. Top-level `artists` array of `{name, uri}` or `{profile: {name}, uri}`.
 *       Used by some `player_state.track` shapes the player normalized.
 *    3. Top-level `artists.items[].profile.name` (Pathfinder-style).
 *  We try each in order so player_state.track and next_tracks[i] both
 *  resolve to a populated list. */
function mapArtists(
  md: Record<string, string>,
  raw: RawTrack,
): Track['artists'] {
  // (1) flat metadata
  const out: Track['artists'] = []
  if (md.artist_name) {
    out.push({
      id: md.artist_uri ? idFromUri(md.artist_uri) : '',
      name: md.artist_name,
      uri: md.artist_uri ?? '',
    })
  }
  for (let i = 1; i < 16; i++) {
    const name = md[`artist_name_${i}`]
    if (!name) break
    const uri = md[`artist_uri_${i}`] ?? ''
    out.push({ id: uri ? idFromUri(uri) : '', name, uri })
  }
  if (out.length > 0) return out
  // (2) + (3) top-level — walk whatever shape we find.
  return extractArtistList(raw.artists)
}

/** Recursively probe an unknown value for `{name, uri}` artist entries.
 *  Handles both bare arrays (`[{name, uri}, ...]`) and the GraphQL
 *  container variants (`{items: [...]}`, `{nodes: [...]}`,
 *  `{edges: [{node: {...}}, ...]}`) that Pathfinder responses use. */
function extractArtistList(value: unknown): Track['artists'] {
  const out: Track['artists'] = []
  walk(value, (m) => {
    // Bail early once we have at least one named artist; recursion runs
    // depth-first so the first hit is the topmost match.
    if (out.length > 0) return
    const list = (m as { items?: unknown[]; nodes?: unknown[]; edges?: unknown[] })
    const entries = list.items ?? list.nodes ?? list.edges
    if (Array.isArray(entries)) {
      for (const entry of entries) {
        const a = artistFromEntry(entry)
        if (a) out.push(a)
      }
    }
  })
  if (out.length === 0 && Array.isArray(value)) {
    for (const entry of value) {
      const a = artistFromEntry(entry)
      if (a) out.push(a)
    }
  }
  return out
}

function artistFromEntry(entry: unknown): Track['artists'][number] | null {
  if (!entry || typeof entry !== 'object') return null
  const e = entry as { uri?: string; name?: string; profile?: { name?: string }; node?: unknown }
  if (e.node) return artistFromEntry(e.node)
  const name = e.profile?.name ?? e.name
  if (!name) return null
  return {
    id: e.uri ? idFromUri(e.uri) : '',
    name,
    uri: e.uri ?? '',
  }
}

function walk(value: unknown, fn: (m: object) => void): void {
  if (value === null || value === undefined) return
  if (Array.isArray(value)) {
    for (const v of value) walk(v, fn)
    return
  }
  if (typeof value === 'object') {
    fn(value)
    for (const v of Object.values(value)) walk(v, fn)
  }
}

function mapAlbumImages(md: Record<string, string>): Track['album']['images'] {
  const images: Track['album']['images'] = []
  // Spotify's player_state metadata usually has small/large variants.
  // image_xlarge_url > image_large_url > image_url > image_small_url is the
  // resolution order; preserve descending order so consumers picking [0]
  // get the largest.
  for (const key of [
    'image_xlarge_url',
    'image_large_url',
    'image_url',
    'image_small_url',
  ]) {
    const raw = md[key]
    if (typeof raw === 'string' && raw.length > 0) {
      const url = normalizeImageUrl(raw)
      if (url) images.push({ url, width: null, height: null })
    }
  }
  return images
}

/** Connect-state's currently-playing track returns image_url as Spotify's
 *  internal URI form (`spotify:image:ab67…`); the queue entries return
 *  full https URLs (`https://i.scdn.co/image/ab67…`). The browser can't
 *  load the URI form. Convert when we detect it; pass https through. */
function normalizeImageUrl(value: string): string {
  if (value.startsWith('spotify:image:')) {
    const id = value.slice('spotify:image:'.length)
    if (!/^[A-Za-z0-9]+$/.test(id)) return ''
    return `https://i.scdn.co/image/${id}`
  }
  if (value.startsWith('http://') || value.startsWith('https://')) return value
  return ''
}

// ---- helpers ----------------------------------------------------------

function derivePlaying(player: RawPlayerState): boolean {
  if (typeof player.is_paused === 'boolean') return !player.is_paused
  if (typeof player.is_playing === 'boolean') return player.is_playing
  return false
}

/** Connect-state encodes progress as `position_as_of_timestamp` plus a
 *  server `timestamp`. While playing, the *current* position is
 *  `position_as_of_timestamp + (now - timestamp)`. The SPA already smooths
 *  position locally between SSE ticks, so we report the snapshotted
 *  `position_as_of_timestamp` and let the SPA do its thing. */
function deriveProgress(player: RawPlayerState, isPlaying: boolean): number | null {
  const snap = parseIntStr(player.position_as_of_timestamp, NaN)
  if (Number.isFinite(snap)) {
    if (!isPlaying) return snap
    const ts = parseIntStr(player.timestamp, NaN)
    if (Number.isFinite(ts)) {
      const advanced = snap + (Date.now() - ts)
      return Math.max(0, advanced)
    }
    return snap
  }
  const fallback = parseIntStr(player.position_ms, NaN)
  return Number.isFinite(fallback) ? fallback : null
}

function deriveRepeat(player: RawPlayerState): 'off' | 'track' | 'context' {
  if (player.options?.repeating_track) return 'track'
  if (player.options?.repeating_context) return 'context'
  const r = (player.repeat_mode ?? player.repeat ?? '').toLowerCase()
  if (r === 'track') return 'track'
  if (r === 'context') return 'context'
  return 'off'
}

function volumeToPercent(v: RawDevice['volume']): number | null {
  const n = parseIntStr(v, NaN)
  if (!Number.isFinite(n)) return null
  // Heuristic: ≤100 is already a percent (some devices report it that
  // way); >100 is the 0..65535 scale.
  if (n <= 100) return Math.round(n)
  return Math.round((n / 65535) * 100)
}

function parseIntStr(v: unknown, fallback: number): number {
  if (typeof v === 'number') return v
  if (typeof v === 'string') {
    const n = Number.parseInt(v, 10)
    return Number.isFinite(n) ? n : fallback
  }
  return fallback
}

