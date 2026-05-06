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
interface Track {
  id: string
  name: string
  uri: string
  duration_ms: number
  artists: Artist[]
  album: Album
  type: 'track'
}
interface Episode {
  id: string
  name: string
  uri: string
  duration_ms: number
  show?: { id: string; name: string; images: SpotifyImage[] }
  type: 'episode'
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
  metadata?: Record<string, string>
  provider?: string
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

// ---- mapping ----------------------------------------------------------

function mapDevices(cluster: RawCluster): Device[] {
  const map = cluster.devices ?? {}
  const activeId = cluster.active_device_id ?? ''
  const out: Device[] = []
  for (const [id, raw] of Object.entries(map)) {
    const isActive = id === activeId
    out.push({
      id,
      name: raw.name ?? '',
      type: (raw.device_type ?? '').toLowerCase(),
      // Connect-state volume is a 0..65535 short; convert to 0..100 percent.
      volume_percent: volumeToPercent(raw.volume),
      is_active: isActive || !!raw.is_active || !!raw.is_active_device,
      is_restricted: false,
      is_private_session: !!raw.is_private_session,
      supports_volume: true,
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
  const next = (player.next_tracks ?? []).flatMap((t) => {
    const m = mapTrack(t)
    return m ? [m] : []
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
  return {
    id: idFromUri(raw.uri),
    uri: raw.uri,
    name: md.title ?? '',
    duration_ms: parseIntStr(md.duration ?? '0', 0),
    artists: mapArtists(md, raw.uri),
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

/** Connect-state metadata enumerates artists as `artist_name`, then
 *  `artist_name_1`, `artist_name_2`, … (with matching `artist_uri_*`).
 *  Walk numerically until a gap appears. */
function mapArtists(
  md: Record<string, string>,
  trackUri: string,
): Track['artists'] {
  const out: Track['artists'] = []
  const primary = md.artist_name
  if (primary) {
    out.push({
      id: md.artist_uri ? idFromUri(md.artist_uri) : '',
      name: primary,
      uri: md.artist_uri ?? '',
    })
  }
  for (let i = 1; i < 16; i++) {
    const name = md[`artist_name_${i}`]
    if (!name) break
    const uri = md[`artist_uri_${i}`] ?? ''
    out.push({ id: uri ? idFromUri(uri) : '', name, uri })
  }
  // Fall back to a synthetic empty array. The SPA already handles this
  // (e.g. `playback.item.artists.map((a) => a.name).join(', ')`).
  if (out.length === 0) {
    void trackUri
  }
  return out
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
    const url = md[key]
    if (typeof url === 'string' && url.length > 0) {
      images.push({ url, width: null, height: null })
    }
  }
  return images
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

function idFromUri(uri: string): string {
  const parts = uri.split(':')
  return parts[parts.length - 1] ?? ''
}

function typeFromUri(uri: string): string {
  const parts = uri.split(':')
  return parts.length >= 3 ? (parts[parts.length - 2] ?? '') : ''
}
