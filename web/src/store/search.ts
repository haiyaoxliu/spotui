import { create } from 'zustand'
import { search, searchMore, type SearchResults, type SearchTab } from '../api/spotify'

type LoadingMap = Record<SearchTab, boolean>
const NO_LOADING: LoadingMap = {
  tracks: false,
  albums: false,
  artists: false,
  playlists: false,
}

interface SearchState {
  query: string
  results: SearchResults
  loading: boolean
  // Per-tab in-flight flag for incremental loadMore calls. Each tab
  // paginates independently — typing in the tracks tab doesn't block a
  // running albums fetch and vice versa.
  loadingMore: LoadingMap
  error: string | null
  setQuery: (q: string) => void
  loadMore: (tab: SearchTab) => Promise<void>
}

let debounceHandle: number | null = null
let lastSearchId = 0
const DEBOUNCE_MS = 250

export const useSearch = create<SearchState>((set, get) => ({
  query: '',
  results: {},
  loading: false,
  loadingMore: NO_LOADING,
  error: null,
  setQuery: (q) => {
    set({ query: q })

    if (debounceHandle !== null) {
      clearTimeout(debounceHandle)
      debounceHandle = null
    }

    if (!q.trim()) {
      set({ results: {}, loading: false, loadingMore: NO_LOADING, error: null })
      return
    }

    set({ loading: true, loadingMore: NO_LOADING, error: null })
    const id = ++lastSearchId
    debounceHandle = window.setTimeout(async () => {
      try {
        const results = await search(q)
        if (id !== lastSearchId) return // a newer query has fired
        set({ results, loading: false })
      } catch (e) {
        if (id !== lastSearchId) return
        set({
          error: e instanceof Error ? e.message : String(e),
          loading: false,
        })
      }
    }, DEBOUNCE_MS)
  },
  loadMore: async (tab) => {
    const cur = get().results[tab]
    if (!cur?.next || get().loadingMore[tab]) return
    set({ loadingMore: { ...get().loadingMore, [tab]: true } })
    try {
      const slice = await searchMore<typeof tab>(cur.next)
      if (!slice) {
        set({ loadingMore: { ...get().loadingMore, [tab]: false } })
        return
      }
      const cur2 = get().results
      const subCur = cur2[tab]
      if (!subCur) {
        set({ loadingMore: { ...get().loadingMore, [tab]: false } })
        return
      }
      // Append; widen via casts since each tab has a different item type
      // but they all share the same slice shape. Type-safety stays at the
      // tab boundary.
      const merged = {
        ...cur2,
        [tab]: {
          items: [
            ...(subCur.items as unknown[]),
            ...(slice.items as unknown[]),
          ],
          total: slice.total ?? subCur.total,
          next: slice.next ?? null,
        },
      } as SearchResults
      set({ results: merged, loadingMore: { ...get().loadingMore, [tab]: false } })
    } catch (e) {
      set({
        error: e instanceof Error ? e.message : String(e),
        loadingMore: { ...get().loadingMore, [tab]: false },
      })
    }
  },
}))
