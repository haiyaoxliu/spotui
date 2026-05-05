import { create } from 'zustand'
import type { Playlist, PlaylistItem, Track } from '../api/spotify'
import {
  getPlaylistItems,
  getPlaylistItemsViaFull,
  getRecentlyPlayed,
  getSavedTracks,
} from '../api/spotify'

export type SelectedKind = 'playlist' | 'liked' | 'recent'

// One-step undo target — the selection that was active immediately before
// the current one. Set on every selectXxx call (unless restoring from prior),
// cleared after goBack(). Captures enough to re-trigger the original loader.
type PriorSelection =
  | { kind: 'playlist'; playlist: Playlist; canEdit: boolean }
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
  // The Playlist object backing the current selection, if any. Held so that
  // goBack can re-select a previous playlist by passing the original object
  // back into selectPlaylist.
  lastPlaylist: Playlist | null
  prior: PriorSelection | null
  selectPlaylist: (p: Playlist, canEdit: boolean) => Promise<void>
  selectLiked: () => Promise<void>
  selectRecent: () => Promise<void>
  goBack: () => Promise<void>
}

function snapshotOf(s: SelectionState): PriorSelection | null {
  if (s.kind === 'playlist' && s.lastPlaylist) {
    return { kind: 'playlist', playlist: s.lastPlaylist, canEdit: s.canEdit }
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
    lastPlaylist: null,
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
        lastPlaylist: p,
        prior,
      })
      try {
        // /items 403s on non-owned/collab playlists; for those (e.g.
        // Discover Weekly) fall back to GET /playlists/{id}, which embeds
        // the first page of items and is unrestricted (spec line 848 vs
        // 1193).
        const items = canEdit
          ? await getPlaylistItems(p.id)
          : await getPlaylistItemsViaFull(p.id)
        const tracks = items
          .map((i: PlaylistItem) => i.item ?? i.track ?? null)
          .filter((t): t is Track => !!t && t.type === 'track')
        const totalDurationMs = tracks.reduce((acc, t) => acc + t.duration_ms, 0)
        let minAddedAt: string | null = null
        for (const i of items) {
          if (i.added_at && (minAddedAt === null || i.added_at < minAddedAt)) {
            minAddedAt = i.added_at
          }
        }
        set({ tracks, totalDurationMs, minAddedAt, loading: false })
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
        lastPlaylist: null,
        prior,
      })
      try {
        const items = await getSavedTracks()
        set({ tracks: items.map((i) => i.track), loading: false })
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
        lastPlaylist: null,
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

    goBack: async () => {
      const p = get().prior
      if (!p) return
      restoring = true
      try {
        if (p.kind === 'playlist') await get().selectPlaylist(p.playlist, p.canEdit)
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
