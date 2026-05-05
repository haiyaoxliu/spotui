import {
  addItemsToPlaylist,
  addToQueue,
  checkLibraryContains,
  next,
  pause,
  play,
  previous,
  removeFromLibrary,
  saveToLibrary,
  seek,
  setRepeat,
  setShuffle,
  setVolume,
} from './api/spotify'
import { usePlayer } from './store/player'
import { useSearch } from './store/search'
import { useSelection } from './store/selection'
import { useUI } from './store/ui'

// After a transport action, Spotify Connect needs a moment to propagate the
// new state. Refresh too soon and we risk overwriting our optimistic update
// with a stale response. ~300ms feels snappy without flicker.
const PROPAGATION_DELAY_MS = 300

// Per-field suppression: while active, refresh() in App.tsx preserves the
// locally-set value for that field and lets others update normally.
const SUPPRESS_MS = 1500
let suppress = {
  isPlaying: 0,
  shuffle: 0,
  repeat: 0,
  volume: 0,
  position: 0,
}

export function isIsPlayingSuppressed(): boolean {
  return Date.now() < suppress.isPlaying
}
export function isShuffleSuppressed(): boolean {
  return Date.now() < suppress.shuffle
}
export function isRepeatSuppressed(): boolean {
  return Date.now() < suppress.repeat
}
export function isVolumeSuppressed(): boolean {
  return Date.now() < suppress.volume
}
export function isPositionSuppressed(): boolean {
  return Date.now() < suppress.position
}

export type Refresh = () => void | Promise<void>

export async function togglePlayPause(refresh: Refresh): Promise<void> {
  const cur = usePlayer.getState().playback
  if (!cur) return
  const wasPlaying = cur.is_playing
  usePlayer.getState().optimisticIsPlaying(!wasPlaying)
  suppress.isPlaying = Date.now() + SUPPRESS_MS
  try {
    await (wasPlaying ? pause() : play())
  } catch (e) {
    suppress.isPlaying = 0
    console.error('toggle play/pause failed:', e)
    void refresh()
    return
  }
  setTimeout(() => void refresh(), PROPAGATION_DELAY_MS)
}

export async function skipNext(refresh: Refresh): Promise<void> {
  try {
    await next()
  } catch (e) {
    console.error('skip next failed:', e)
    void refresh()
    return
  }
  void refresh()
  setTimeout(() => void refresh(), PROPAGATION_DELAY_MS * 2)
}

export async function skipPrevious(refresh: Refresh): Promise<void> {
  try {
    await previous()
  } catch (e) {
    console.error('skip previous failed:', e)
    void refresh()
    return
  }
  void refresh()
  setTimeout(() => void refresh(), PROPAGATION_DELAY_MS * 2)
}

export async function toggleShuffle(refresh: Refresh): Promise<void> {
  const cur = usePlayer.getState().playback
  if (!cur) return
  const next = !cur.shuffle_state
  usePlayer.getState().patchPlayback({ shuffle_state: next })
  suppress.shuffle = Date.now() + SUPPRESS_MS
  try {
    await setShuffle(next)
  } catch (e) {
    suppress.shuffle = 0
    console.error('toggle shuffle failed:', e)
    void refresh()
    return
  }
  setTimeout(() => void refresh(), PROPAGATION_DELAY_MS)
}

export async function cycleRepeat(refresh: Refresh): Promise<void> {
  const cur = usePlayer.getState().playback
  if (!cur) return
  const order: Array<'off' | 'context' | 'track'> = ['off', 'context', 'track']
  const idx = order.indexOf(cur.repeat_state)
  const nextState = order[(idx + 1) % order.length]
  usePlayer.getState().patchPlayback({ repeat_state: nextState })
  suppress.repeat = Date.now() + SUPPRESS_MS
  try {
    await setRepeat(nextState)
  } catch (e) {
    suppress.repeat = 0
    console.error('cycle repeat failed:', e)
    void refresh()
    return
  }
  setTimeout(() => void refresh(), PROPAGATION_DELAY_MS)
}

export async function adjustVolume(delta: number, refresh: Refresh): Promise<void> {
  const cur = usePlayer.getState().playback
  if (!cur || !cur.device) return
  const current = cur.device.volume_percent ?? 50
  const target = Math.max(0, Math.min(100, current + delta))
  if (target === current) return
  usePlayer.getState().patchDevice({ volume_percent: target })
  suppress.volume = Date.now() + SUPPRESS_MS
  try {
    await setVolume(target)
  } catch (e) {
    suppress.volume = 0
    console.error('adjust volume failed:', e)
    void refresh()
    return
  }
  setTimeout(() => void refresh(), PROPAGATION_DELAY_MS)
}

export async function adjustSeek(deltaMs: number, refresh: Refresh): Promise<void> {
  const cur = usePlayer.getState().playback
  if (!cur || cur.progress_ms == null) return
  const duration = cur.item?.duration_ms ?? Infinity
  const target = Math.max(0, Math.min(duration, cur.progress_ms + deltaMs))
  await seekTo(target, refresh)
}

export async function seekTo(positionMs: number, refresh: Refresh): Promise<void> {
  const cur = usePlayer.getState().playback
  if (!cur) return
  const duration = cur.item?.duration_ms ?? Infinity
  const target = Math.max(0, Math.min(duration, Math.round(positionMs)))
  usePlayer.getState().patchPlayback({ progress_ms: target })
  suppress.position = Date.now() + 800
  try {
    await seek(target)
  } catch (e) {
    suppress.position = 0
    console.error('seek failed:', e)
    void refresh()
    return
  }
  setTimeout(() => void refresh(), PROPAGATION_DELAY_MS)
}

// Enqueue the focused row (track only). No-op if nothing is focused or the
// focused row is not a track.
export async function queueFocused(): Promise<void> {
  const f = useUI.getState().focusedRow
  if (!f || !f.isTrack) return
  try {
    await addToQueue(f.uri)
  } catch (e) {
    console.error('queue focused failed:', e)
  }
}

// Enter / dblclick the focused row. Behavior branches on what the row is:
//
// - Playlist-pane row: play in the open context (rest of the playlist queues
//   up after).
// - Search row, type=track: play stand-alone.
// - Search row, type=playlist or album: LOAD into the playlist pane (browse
//   first, then the user can pick a track to play). Mirrors what dblclick
//   does on those rows.
// - Search row, type=artist (or fallback): start its context playing.
export async function playFocused(refresh: Refresh): Promise<void> {
  const f = useUI.getState().focusedRow
  if (!f) return

  if (f.pane === 'search' && f.searchType === 'playlist') {
    const sel = useSelection.getState()
    const ui = useUI.getState()
    const pl = useSearch
      .getState()
      .results.playlists?.items.find((p) => p?.uri === f.uri)
    if (pl) {
      const canEdit = !!ui.userId && (pl.owner.id === ui.userId || pl.collaborative)
      await sel.selectPlaylist(pl, canEdit)
    }
    return
  }
  if (f.pane === 'search' && f.searchType === 'album') {
    const album = useSearch
      .getState()
      .results.albums?.items.find((a) => a.uri === f.uri)
    if (album) await useSelection.getState().selectAlbum(album)
    return
  }

  try {
    if (f.pane === 'playlist') {
      const ctx = useSelection.getState().contextUri
      if (ctx) await play({ contextUri: ctx, offsetUri: f.uri })
      else await play({ uris: [f.uri] })
    } else if (f.isTrack) {
      await play({ uris: [f.uri] })
    } else {
      await play({ contextUri: f.uri })
    }
  } catch (e) {
    console.error('play focused failed:', e)
    void refresh()
    return
  }
  setTimeout(() => void refresh(), PROPAGATION_DELAY_MS)
}

// Play the focused track stand-alone, ignoring the open playlist's context.
// TUI parity for `Q` (vs Enter, which keeps context). Track rows only.
export async function playFocusedTrackOnly(refresh: Refresh): Promise<void> {
  const f = useUI.getState().focusedRow
  if (!f || !f.isTrack) return
  try {
    await play({ uris: [f.uri] })
  } catch (e) {
    console.error('play focused (track-only) failed:', e)
    void refresh()
    return
  }
  setTimeout(() => void refresh(), PROPAGATION_DELAY_MS)
}

// Add the focused track to the currently-open playlist. No-op unless the
// focused row is a track AND the open selection is an editable playlist
// (owned or collaborative). Read-only playlists like Discover Weekly are
// shown in the library now, but POST /playlists/{id}/items would 403.
export async function addFocusedToOpenPlaylist(): Promise<void> {
  const f = useUI.getState().focusedRow
  if (!f || !f.isTrack) return
  const sel = useSelection.getState()
  if (sel.kind !== 'playlist' || !sel.contextId || !sel.canEdit) return
  try {
    await addItemsToPlaylist(sel.contextId, [f.uri])
  } catch (e) {
    console.error('add focused to playlist failed:', e)
  }
}

// Toggle Liked Songs on the focused track if one is focused; otherwise on
// the playing track (TUI parity for `l`). When the targeted track happens to
// also be the playing track, the playing-track liked indicator updates
// optimistically; otherwise we just fire the API call.
export async function toggleLikeCurrent(): Promise<void> {
  const focused = useUI.getState().focusedRow
  if (focused && focused.isTrack) {
    await toggleLikeFocused(focused.uri)
    return
  }
  const playback = usePlayer.getState().playback
  const item = playback?.item
  if (!item || item.type !== 'track') return
  const wasLiked = usePlayer.getState().liked
  if (wasLiked === null) return // unknown — wait until we've checked
  const next = !wasLiked
  usePlayer.getState().setLiked(next)
  try {
    if (wasLiked) {
      await removeFromLibrary([item.uri])
    } else {
      await saveToLibrary([item.uri])
    }
  } catch (e) {
    usePlayer.getState().setLiked(wasLiked)
    console.error('toggle like failed:', e)
  }
}

async function toggleLikeFocused(uri: string): Promise<void> {
  // We don't track liked state for arbitrary tracks (only the playing one),
  // so probe /me/library/contains first to know which direction to flip.
  let isLiked: boolean
  try {
    const [contains] = await checkLibraryContains([uri])
    isLiked = !!contains
  } catch (e) {
    console.error('like-state probe failed:', e)
    return
  }
  // If the focused track is also the playing track, flip the indicator.
  const playingUri = usePlayer.getState().playback?.item?.uri
  const willLike = !isLiked
  if (playingUri === uri) usePlayer.getState().setLiked(willLike)
  try {
    if (isLiked) await removeFromLibrary([uri])
    else await saveToLibrary([uri])
  } catch (e) {
    if (playingUri === uri) usePlayer.getState().setLiked(isLiked)
    console.error('toggle like (focused) failed:', e)
  }
}
