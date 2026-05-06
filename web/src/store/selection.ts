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

export const useSelection = create<SelectionState>((set, get) => {
  // Internal: was this selectXxx call invoked from goBack? If so, don't
  // overwrite `prior`. Set transiently inside goBack and consumed on the
  // next selectXxx entry.
  let restoring = false

  function maybeCaptureprior(): PriorSelection | null {
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
      const prior = maybeCaptureprior()
      set({
        kind: 'playlist',
        contextUri: p.uri,
        contextId: p.id,
        name: p.name,
        owner: p.owner?.display_name ?? null,
        trackCount: p.items?.total ?? null,
        totalDurationMs: null,
        minAddedAt: null,
        canEdit,
        tracks: [],
        loading: true,
        error: null,
        tracksNextPath: null,
        loadingMoreTracks: false,
        lastPlaylist: p,
        lastAlbum: null,
        prior,
      })
      // Pathfinder's fetchPlaylist works on every playlist regardless of
      // ownership — including editorial / followed picks that 403 against
      // the public Web API in dev mode. fetchPage routes through it
      // automatically, so a single code path covers all four cases
      // (canEdit × fromSearch). The legacy GET /playlists/{id} fallback
      // is kept as a safety net inside fetchPage's catch path but is
      // unreachable for these reads now.
      try {
        const slice = await fetchPage<PlaylistItem>(PLAYLIST_ITEMS_PAGE_PATH(p.id))
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
        set({
          tracks,
          totalDurationMs,
          minAddedAt,
          tracksNextPath: slice.nextPath,
          trackCount: slice.total ?? get().trackCount,
          loading: false,
        })
      } catch (e) {
        set({ error: e instanceof Error ? e.message : String(e), loading: false })
      }
    },

    selectAlbum: async (a) => {
      const prior = maybeCaptureprior()
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
      const prior = maybeCaptureprior()
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
      const prior = maybeCaptureprior()
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
