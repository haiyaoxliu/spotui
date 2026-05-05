import { create } from 'zustand'
import type { Playlist } from '../api/spotify'
import { getMyPlaylists } from '../api/spotify'

interface LibraryState {
  playlists: Playlist[]
  loaded: boolean
  loading: boolean
  error: string | null
  load: () => Promise<void>
}

export const useLibrary = create<LibraryState>((set, get) => ({
  playlists: [],
  loaded: false,
  loading: false,
  error: null,
  load: async () => {
    if (get().loading || get().loaded) return
    set({ loading: true, error: null })
    try {
      const playlists = await getMyPlaylists()
      set({ playlists, loaded: true, loading: false })
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e), loading: false })
    }
  },
}))
