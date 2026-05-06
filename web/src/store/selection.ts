import { create } from 'zustand'
import type {
  Playlist,
  PlaylistItem,
  SavedTrack,
  SimplifiedAlbum,
  Track,
} from '../api/spotify'
import {
  fetchPage,
  getAlbumTracks,
  getRecentlyPlayed,
  PLAYLIST_ITEMS_PAGE_PATH,
  SAVED_TRACKS_PAGE_PATH,
} from '../api/spotify'

export type SelectedKind = 'playlist' | 'album' | 'liked' | 'recent'

// One-step undo target — the selection that was active immediately before
// the current one. Set on every selectXxx call (unless restoring from prior),
// cleared after goBack(). Captures enough to re-trigger the original loader.
type PriorSelection =
  | { kind: 'playlist'; playlist: Playlist; canEdit: boolean }
  | { kind: 'album'; album: SimplifiedAlbum }
  | { kind: 'liked' }
  | { kind: 'recent' }

interface SelectionState {
  kind: SelectedKind | null
  contextUri: string | null
  contextId: string | null
  name: string
  owner: string | null
  trackCount: number | null
  totalDurationMs: number | null
  minAddedAt: string | null
  // True when the current selection accepts mutations (a / add-to-playlist):
  // owned playlists, collaborative playlists, and Liked Songs. False for
  // read-only followed playlists and Recently Played.
  canEdit: boolean
  tracks: Track[]
  loading: boolean
  error: string | null
  // Pagination state for the loaded track list. Set by the initial selectXxx
  // and consumed by loadMoreTracks. nextPath is null when fully loaded or
  // when the kind doesn't paginate (album, recent, search-sourced read-only
  // playlist).
  tracksNextPath: string | null
  loadingMoreTracks: boolean
  // The reference object backing the current selection, if any. Held so
  // that goBack can re-select by passing the original object back into the
  // matching selectXxx.
  lastPlaylist: Playlist | null
  lastAlbum: SimplifiedAlbum | null
  prior: PriorSelection | null
  selectPlaylist: (p: Playlist, canEdit: boolean) => Promise<void>
  selectAlbum: (a: SimplifiedAlbum) => Promise<void>
  selectLiked: () => Promise<void>
  selectRecent: () => Promise<void>
  loadMoreTracks: () => Promise<void>
  goBack: () => Promise<void>
}

function snapshotOf(s: SelectionState): PriorSelection | null {
  if (s.kind === 'playlist' && s.lastPlaylist) {
    return { kind: 'playlist', playlist: s.lastPlaylist, canEdit: s.canEdit }
  }
  if (s.kind === 'album' && s.lastAlbum) {
    return { kind: 'album', album: s.lastAlbum }
  }
  if (s.kind === 'liked') return { kind: 'liked' }
  if (s.kind === 'recent') return { kind: 'recent' }
  return null
}

/**
 * Per-id cache of fetched playlist track lists. Lets the user click between
 * playlists and back without re-fetching. 5-min TTL is a pragmatic balance
 * between freshness (Spotify-side edits show up reasonably fast) and
 * avoiding the dev-mode quota churn.
 *
 * Module-scoped so it survives across selection-state changes; cleared
 * on hard reload like every other in-memory cache.
 */
interface CachedTracks {
  tracks: Track[]
  tracksNextPath: string | null
  totalDurationMs: number | null
  minAddedAt: string | null
  trackCount: number | null
  fetchedAt: number
}

const PLAYLIST_TRACKS_TTL_MS = 5 * 60 * 1000
const playlistTracksCache = new Map<string, CachedTracks>()

function readCachedTracks(playlistId: string): CachedTracks | null {
  const hit = playlistTracksCache.get(playlistId)
  if (!hit) return null
  if (Date.now() - hit.fetchedAt > PLAYLIST_TRACKS_TTL_MS) {
    playlistTracksCache.delete(playlistId)
    return null
  }
  return hit
}

function writeCachedTracks(playlistId: string, value: CachedTracks): void {
  playlistTracksCache.set(playlistId, value)
}

export const useSelection = create<SelectionState>((set, get) => {
  // Internal: was this selectXxx call invoked from goBack? If so, don't
  // overwrite `prior`. Set transiently inside goBack and consumed on the
  // next selectXxx entry.
  let restoring = false

  function maybeCapturePrior(): PriorSelection | null {
    if (restoring) return get().prior
    return snapshotOf(get())
  }

  return {
    kind: null,
    contextUri: null,
    contextId: null,
    name: '',
    owner: null,
    trackCount: null,
    totalDurationMs: null,
    minAddedAt: null,
    canEdit: false,
    tracks: [],
    loading: false,
    error: null,
    tracksNextPath: null,
    loadingMoreTracks: false,
    lastPlaylist: null,
    lastAlbum: null,
    prior: null,

    selectPlaylist: async (p, canEdit) => {
      const prior = maybeCapturePrior()
      // If we have a fresh cache hit for this playlist, render it
      // immediately and skip the network entirely. This makes
      // playlist-A → playlist-B → playlist-A feel instant.
      const cached = readCachedTracks(p.id)
      set({
        kind: 'playlist',
        contextUri: p.uri,
        contextId: p.id,
        name: p.name,
        owner: p.owner?.display_name ?? null,
        trackCount: cached?.trackCount ?? p.items?.total ?? null,
        totalDurationMs: cached?.totalDurationMs ?? null,
        minAddedAt: cached?.minAddedAt ?? null,
        canEdit,
        tracks: cached?.tracks ?? [],
        loading: cached === null,
        error: null,
        tracksNextPath: cached?.tracksNextPath ?? null,
        loadingMoreTracks: false,
        lastPlaylist: p,
        lastAlbum: null,
        prior,
      })
      if (cached) return

      // Pathfinder's fetchPlaylist (via fetchPage) works on every playlist
      // regardless of ownership. One code path for all callers; canEdit
      // is used purely to gate write ops.
      try {
        const slice = await fetchPage<PlaylistItem>(PLAYLIST_ITEMS_PAGE_PATH(p.id))
        // Race guard: if the user has already navigated away to a
        // different selection by the time we get here, drop the response
        // on the floor — but still populate the cache so a later return
        // is instant.
        const tracks = slice.items
          .map((i: PlaylistItem) => i.item ?? i.track ?? null)
          .filter((t): t is Track => !!t && t.type === 'track')
        const totalDurationMs = tracks.reduce((acc, t) => acc + t.duration_ms, 0)
        let minAddedAt: string | null = null
        for (const i of slice.items) {
          if (i.added_at && (minAddedAt === null || i.added_at < minAddedAt)) {
            minAddedAt = i.added_at
          }
        }
        const trackCount = slice.total ?? get().trackCount
        writeCachedTracks(p.id, {
          tracks,
          tracksNextPath: slice.nextPath,
          totalDurationMs,
          minAddedAt,
          trackCount,
          fetchedAt: Date.now(),
        })
        if (get().contextId !== p.id) return
        set({
          tracks,
          totalDurationMs,
          minAddedAt,
          tracksNextPath: slice.nextPath,
          trackCount,
          loading: false,
        })
      } catch (e) {
        if (get().contextId === p.id) {
          set({ error: e instanceof Error ? e.message : String(e), loading: false })
        }
      }
    },

    selectAlbum: async (a) => {
      const prior = maybeCapturePrior()
      const artistsLabel = a.artists.map((x) => x.name).join(', ')
      set({
        kind: 'album',
        contextUri: a.uri,
        contextId: a.id,
        name: a.name,
        owner: artistsLabel,
        trackCount: a.total_tracks,
        totalDurationMs: null,
        minAddedAt: null,
        canEdit: false,
        tracks: [],
        loading: true,
        error: null,
        tracksNextPath: null,
        loadingMoreTracks: false,
        lastPlaylist: null,
        lastAlbum: a,
        prior,
      })
      try {
        const simplified = await getAlbumTracks(a.id)
        // /albums/{id}/tracks returns SimplifiedTrack — no embedded album.
        // Hydrate to full Track shape using the SimplifiedAlbum we already
        // have (cover art / name / uri all live there).
        const album = { id: a.id, name: a.name, uri: a.uri, images: a.images }
        const tracks: Track[] = simplified.map((t) => ({ ...t, album }))
        const totalDurationMs = tracks.reduce((acc, t) => acc + t.duration_ms, 0)
        set({ tracks, totalDurationMs, loading: false })
      } catch (e) {
        set({ error: e instanceof Error ? e.message : String(e), loading: false })
      }
    },

    selectLiked: async () => {
      const prior = maybeCapturePrior()
      set({
        kind: 'liked',
        contextUri: null,
        contextId: null,
        name: 'Liked Songs',
        owner: null,
        trackCount: null,
        totalDurationMs: null,
        minAddedAt: null,
        canEdit: false,
        tracks: [],
        loading: true,
        error: null,
        tracksNextPath: null,
        loadingMoreTracks: false,
        lastPlaylist: null,
        lastAlbum: null,
        prior,
      })
      try {
        const slice = await fetchPage<SavedTrack>(SAVED_TRACKS_PAGE_PATH)
        const tracks = slice.items.map((i) => i.track)
        const totalDurationMs = tracks.reduce((acc, t) => acc + t.duration_ms, 0)
        set({
          tracks,
          totalDurationMs,
          tracksNextPath: slice.nextPath,
          trackCount: slice.total,
          loading: false,
        })
      } catch (e) {
        set({ error: e instanceof Error ? e.message : String(e), loading: false })
      }
    },

    selectRecent: async () => {
      const prior = maybeCapturePrior()
      set({
        kind: 'recent',
        contextUri: null,
        contextId: null,
        name: 'Recently Played',
        owner: null,
        trackCount: null,
        totalDurationMs: null,
        minAddedAt: null,
        canEdit: false,
        tracks: [],
        loading: true,
        error: null,
        tracksNextPath: null,
        loadingMoreTracks: false,
        lastPlaylist: null,
        lastAlbum: null,
        prior,
      })
      try {
        const items = await getRecentlyPlayed()
        // Recently-played can repeat the same track. De-dupe in display order.
        const seen = new Set<string>()
        const tracks: Track[] = []
        for (const i of items) {
          if (!seen.has(i.track.id)) {
            seen.add(i.track.id)
            tracks.push(i.track)
          }
        }
        set({ tracks, loading: false })
      } catch (e) {
        set({ error: e instanceof Error ? e.message : String(e), loading: false })
      }
    },

    loadMoreTracks: async () => {
      const state = get()
      if (!state.tracksNextPath || state.loadingMoreTracks) return
      // Only playlist + liked paginate; album / recent / search-sourced
      // read-only playlist all set tracksNextPath to null upstream.
      if (state.kind !== 'playlist' && state.kind !== 'liked') return
      set({ loadingMoreTracks: true })
      try {
        if (state.kind === 'playlist') {
          const slice = await fetchPage<PlaylistItem>(state.tracksNextPath)
          const newTracks = slice.items
            .map((i: PlaylistItem) => i.item ?? i.track ?? null)
            .filter((t): t is Track => !!t && t.type === 'track')
          let minAddedAt = state.minAddedAt
          for (const i of slice.items) {
            if (i.added_at && (minAddedAt === null || i.added_at < minAddedAt)) {
              minAddedAt = i.added_at
            }
          }
          const addedDuration = newTracks.reduce((acc, t) => acc + t.duration_ms, 0)
          set({
            tracks: [...state.tracks, ...newTracks],
            tracksNextPath: slice.nextPath,
            totalDurationMs: (state.totalDurationMs ?? 0) + addedDuration,
            minAddedAt,
            loadingMoreTracks: false,
          })
        } else {
          // liked
          const slice = await fetchPage<SavedTrack>(state.tracksNextPath)
          const newTracks = slice.items.map((i) => i.track)
          const addedDuration = newTracks.reduce((acc, t) => acc + t.duration_ms, 0)
          set({
            tracks: [...state.tracks, ...newTracks],
            tracksNextPath: slice.nextPath,
            totalDurationMs: (state.totalDurationMs ?? 0) + addedDuration,
            loadingMoreTracks: false,
          })
        }
      } catch (e) {
        set({
          error: e instanceof Error ? e.message : String(e),
          loadingMoreTracks: false,
        })
      }
    },

    goBack: async () => {
      const p = get().prior
      if (!p) return
      restoring = true
      try {
        if (p.kind === 'playlist') await get().selectPlaylist(p.playlist, p.canEdit)
        else if (p.kind === 'album') await get().selectAlbum(p.album)
        else if (p.kind === 'liked') await get().selectLiked()
        else if (p.kind === 'recent') await get().selectRecent()
      } finally {
        restoring = false
      }
      // Single-shot: clear prior so a second click goes nowhere unless the
      // user makes another selection first.
      set({ prior: null })
    },
  }
})
