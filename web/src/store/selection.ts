import { create } from 'zustand'
import type { Playlist, PlaylistItem, Track } from '../api/spotify'
import {
  getPlaylistItems,
  getPlaylistItemsViaFull,
  getRecentlyPlayed,
  getSavedTracks,
} from '../api/spotify'

export type SelectedKind = 'playlist' | 'liked' | 'recent'

interface SelectionState {
  kind: SelectedKind | null
  contextUri: string | null
  contextId: string | null
  name: string
  owner: string | null
  trackCount: number | null
  totalDurationMs: number | null
  minAddedAt: string | null
  tracks: Track[]
  loading: boolean
  error: string | null
  selectPlaylist: (p: Playlist, canEdit: boolean) => Promise<void>
  selectLiked: () => Promise<void>
  selectRecent: () => Promise<void>
}

export const useSelection = create<SelectionState>((set) => ({
  kind: null,
  contextUri: null,
  contextId: null,
  name: '',
  owner: null,
  trackCount: null,
  totalDurationMs: null,
  minAddedAt: null,
  tracks: [],
  loading: false,
  error: null,

  selectPlaylist: async (p, canEdit) => {
    set({
      kind: 'playlist',
      contextUri: p.uri,
      contextId: p.id,
      name: p.name,
      owner: p.owner?.display_name ?? null,
      trackCount: p.items?.total ?? null,
      totalDurationMs: null,
      minAddedAt: null,
      tracks: [],
      loading: true,
      error: null,
    })
    try {
      // /items 403s on non-owned/collab playlists; for those (e.g. pinned
      // Discover Weekly) fall back to GET /playlists/{id}, which embeds the
      // first page of items and is unrestricted (spec line 848 vs 1193).
      const items = canEdit
        ? await getPlaylistItems(p.id)
        : await getPlaylistItemsViaFull(p.id)
      const tracks = items
        .map((i: PlaylistItem) => i.item ?? i.track ?? null)
        .filter((t): t is Track => !!t && t.type === 'track')
      const totalDurationMs = tracks.reduce((acc, t) => acc + t.duration_ms, 0)
      // ISO-8601 timestamps sort lexicographically — min == earliest.
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
    set({
      kind: 'liked',
      contextUri: null,
      contextId: null,
      name: 'Liked Songs',
      owner: null,
      trackCount: null,
      totalDurationMs: null,
      minAddedAt: null,
      tracks: [],
      loading: true,
      error: null,
    })
    try {
      const items = await getSavedTracks()
      set({ tracks: items.map((i) => i.track), loading: false })
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e), loading: false })
    }
  },

  selectRecent: async () => {
    set({
      kind: 'recent',
      contextUri: null,
      contextId: null,
      name: 'Recently Played',
      owner: null,
      trackCount: null,
      totalDurationMs: null,
      minAddedAt: null,
      tracks: [],
      loading: true,
      error: null,
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
}))
