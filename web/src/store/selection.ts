import { create } from 'zustand'
import type { Track } from '../api/spotify'
import { getPlaylistItems, getRecentlyPlayed, getSavedTracks } from '../api/spotify'

export type SelectedKind = 'playlist' | 'liked' | 'recent'

interface SelectionState {
  kind: SelectedKind | null
  contextUri: string | null
  contextId: string | null
  name: string
  tracks: Track[]
  loading: boolean
  error: string | null
  selectPlaylist: (p: { id: string; name: string; uri: string }) => Promise<void>
  selectLiked: () => Promise<void>
  selectRecent: () => Promise<void>
}

export const useSelection = create<SelectionState>((set) => ({
  kind: null,
  contextUri: null,
  contextId: null,
  name: '',
  tracks: [],
  loading: false,
  error: null,

  selectPlaylist: async (p) => {
    set({
      kind: 'playlist',
      contextUri: p.uri,
      contextId: p.id,
      name: p.name,
      tracks: [],
      loading: true,
      error: null,
    })
    try {
      const items = await getPlaylistItems(p.id)
      const tracks = items
        .map((i) => i.item ?? i.track ?? null)
        .filter((t): t is Track => !!t && t.type === 'track')
      set({ tracks, loading: false })
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
