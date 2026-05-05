import { create } from 'zustand'
import { search, type SearchResults } from '../api/spotify'

interface SearchState {
  query: string
  results: SearchResults
  loading: boolean
  error: string | null
  setQuery: (q: string) => void
}

let debounceHandle: number | null = null
let lastSearchId = 0
const DEBOUNCE_MS = 250

export const useSearch = create<SearchState>((set) => ({
  query: '',
  results: {},
  loading: false,
  error: null,
  setQuery: (q) => {
    set({ query: q })

    if (debounceHandle !== null) {
      clearTimeout(debounceHandle)
      debounceHandle = null
    }

    if (!q.trim()) {
      set({ results: {}, loading: false, error: null })
      return
    }

    set({ loading: true, error: null })
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
}))
