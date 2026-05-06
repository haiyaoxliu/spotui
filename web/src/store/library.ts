import { create } from 'zustand'
import type { Playlist } from '../api/spotify'
import { fetchPage, PLAYLISTS_PAGE_PATH } from '../api/spotify'
import { fetchLibraryEntries, type LibraryEntry } from '../api/pathfinder'

const PINNED_KEY = 'library_pinned_ids'
const EXPANDED_KEY = 'library_expanded_folders'

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

function readExpanded(): string[] {
  try {
    const raw = localStorage.getItem(EXPANDED_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string') : []
  } catch {
    return []
  }
}

function writeExpanded(uris: string[]): void {
  localStorage.setItem(EXPANDED_KEY, JSON.stringify(uris))
}

interface LibraryState {
  /** Hierarchical entries from libraryV3 — playlists + folders, depth-aware.
   *  Empty when running in PKCE-only mode (no cookie path); falls back to
   *  flat playlists in that case. */
  entries: LibraryEntry[]
  /** Flat list — derived from entries (or fetched directly via the legacy
   *  /me/playlists route in PKCE-only mode). Existing code outside the
   *  LibraryPanel uses this. */
  playlists: Playlist[]
  /** Folder URIs the user has currently expanded; persists across reloads. */
  expandedFolders: Set<string>
  loaded: boolean
  loading: boolean
  loadingMore: boolean
  error: string | null
  nextPath: string | null
  total: number | null
  pinnedIds: string[]
  load: () => Promise<void>
  loadMore: () => Promise<void>
  toggleFolder: (uri: string) => Promise<void>
  pin: (id: string) => void
  unpin: (id: string) => void
}

export const useLibrary = create<LibraryState>((set, get) => ({
  entries: [],
  playlists: [],
  expandedFolders: new Set(readExpanded()),
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
      const result = await fetchLibraryEntries({
        expandedFolders: Array.from(get().expandedFolders),
      })
      set({
        entries: result.entries,
        playlists: derivePlaylists(result.entries),
        nextPath: result.nextPath,
        total: result.total,
        loaded: true,
        loading: false,
      })
    } catch (e) {
      // Fall back to the legacy public-API route. Mostly hit in PKCE-only
      // mode; in cookie mode the sidecar should always answer.
      console.warn('[spotui] libraryV3 failed, falling back to /me/playlists:', e)
      try {
        const slice = await fetchPage<Playlist>(PLAYLISTS_PAGE_PATH)
        set({
          entries: [],
          playlists: slice.items,
          nextPath: slice.nextPath,
          total: slice.total,
          loaded: true,
          loading: false,
        })
      } catch (e2) {
        set({
          error: e2 instanceof Error ? e2.message : String(e2),
          loading: false,
        })
      }
    }
  },

  loadMore: async () => {
    const { nextPath, loadingMore } = get()
    if (!nextPath || loadingMore) return
    set({ loadingMore: true })
    try {
      // The cookie path always returns the full library in one shot, so
      // loadMore only fires in legacy fallback mode (entries are empty).
      const slice = await fetchPage<Playlist>(nextPath)
      set({
        playlists: [...get().playlists, ...slice.items],
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

  toggleFolder: async (uri: string) => {
    const cur = get().expandedFolders
    const next = new Set(cur)
    if (next.has(uri)) next.delete(uri)
    else next.add(uri)
    writeExpanded(Array.from(next))
    set({ expandedFolders: next })
    // Refetch with new expansion. Reset nextPath since limits change.
    set({ loading: true })
    try {
      const result = await fetchLibraryEntries({
        expandedFolders: Array.from(next),
      })
      set({
        entries: result.entries,
        playlists: derivePlaylists(result.entries),
        nextPath: result.nextPath,
        total: result.total,
        loading: false,
      })
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e), loading: false })
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

function derivePlaylists(entries: LibraryEntry[]): Playlist[] {
  return entries.flatMap((e) => (e.kind === 'playlist' ? [e.playlist] : []))
}
