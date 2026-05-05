import { create } from 'zustand'
import type { Playlist } from '../api/spotify'
import { fetchPage, PLAYLISTS_PAGE_PATH } from '../api/spotify'

const PINNED_KEY = 'library_pinned_ids'

function readPinned(): string[] {
  try {
    const raw = localStorage.getItem(PINNED_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string') : []
  } catch {
    return []
  }
}

function writePinned(ids: string[]): void {
  localStorage.setItem(PINNED_KEY, JSON.stringify(ids))
}

interface LibraryState {
  playlists: Playlist[]
  loaded: boolean
  loading: boolean
  loadingMore: boolean
  error: string | null
  // Spotify URL for the next page of /me/playlists, or null when fully
  // loaded. Set after each successful fetch.
  nextPath: string | null
  // Total count reported by /me/playlists; lets the UI render "N of M".
  total: number | null
  pinnedIds: string[]
  load: () => Promise<void>
  loadMore: () => Promise<void>
  pin: (id: string) => void
  unpin: (id: string) => void
}

export const useLibrary = create<LibraryState>((set, get) => ({
  playlists: [],
  loaded: false,
  loading: false,
  loadingMore: false,
  error: null,
  nextPath: null,
  total: null,
  pinnedIds: readPinned(),
  load: async () => {
    if (get().loading || get().loaded) return
    set({ loading: true, error: null })
    try {
      const slice = await fetchPage<Playlist>(PLAYLISTS_PAGE_PATH)
      set({
        playlists: slice.items,
        nextPath: slice.nextPath,
        total: slice.total,
        loaded: true,
        loading: false,
      })
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e), loading: false })
    }
  },
  loadMore: async () => {
    const { nextPath, loadingMore, playlists } = get()
    if (!nextPath || loadingMore) return
    set({ loadingMore: true })
    try {
      const slice = await fetchPage<Playlist>(nextPath)
      set({
        playlists: [...playlists, ...slice.items],
        nextPath: slice.nextPath,
        total: slice.total ?? get().total,
        loadingMore: false,
      })
    } catch (e) {
      set({
        error: e instanceof Error ? e.message : String(e),
        loadingMore: false,
      })
    }
  },
  pin: (id) => {
    const cur = get().pinnedIds
    if (cur.includes(id)) return
    const next = [...cur, id]
    writePinned(next)
    set({ pinnedIds: next })
  },
  unpin: (id) => {
    const cur = get().pinnedIds
    if (!cur.includes(id)) return
    const next = cur.filter((x) => x !== id)
    writePinned(next)
    set({ pinnedIds: next })
  },
}))
