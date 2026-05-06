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

/** Split a flat depth-aware entries list into top-level entries (depth=0)
 *  and a per-folder children map. The flat list libraryV3 returns has
 *  folder rows immediately followed by their children at depth+1. */
function indexEntries(flat: LibraryEntry[]): {
  base: LibraryEntry[]
  children: Record<string, LibraryEntry[]>
} {
  const base: LibraryEntry[] = []
  const children: Record<string, LibraryEntry[]> = {}
  let openFolderUri: string | null = null
  for (const e of flat) {
    if (e.depth === 0) {
      base.push(e)
      openFolderUri = e.kind === 'folder' ? e.uri : null
      continue
    }
    if (openFolderUri) {
      ;(children[openFolderUri] ??= []).push(e)
    }
  }
  return { base, children }
}

function deriveAllPlaylists(
  base: LibraryEntry[],
  children: Record<string, LibraryEntry[]>,
): Playlist[] {
  const out: Playlist[] = []
  const push = (e: LibraryEntry) => {
    if (e.kind === 'playlist') out.push(e.playlist)
  }
  for (const e of base) push(e)
  for (const arr of Object.values(children)) for (const e of arr) push(e)
  return out
}

interface LibraryState {
  /** Top-level entries (depth=0) from the latest fetch. The Folders /
   *  Playlists sections in the panel render from this. */
  baseEntries: LibraryEntry[]
  /** Cached children for each folder, keyed by folder URI. Survives
   *  collapse — reopening a folder pulls from here without a refetch. */
  folderChildren: Record<string, LibraryEntry[]>
  /** UI state: which folders are visually expanded right now. */
  expandedFolders: Set<string>
  /** Flat list of every Playlist we've seen (top-level + inside folders).
   *  Other code reads this; do not depend on its order. */
  playlists: Playlist[]
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
  baseEntries: [],
  folderChildren: {},
  expandedFolders: new Set(readExpanded()),
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
      const result = await fetchLibraryEntries({
        expandedFolders: Array.from(get().expandedFolders),
      })
      const { base, children } = indexEntries(result.entries)
      set({
        baseEntries: base,
        folderChildren: children,
        playlists: deriveAllPlaylists(base, children),
        nextPath: result.nextPath,
        total: result.total,
        loaded: true,
        loading: false,
      })
    } catch (e) {
      // Fall back to the legacy public-API route for PKCE-only mode.
      console.warn('[spotui] libraryV3 failed, falling back to /me/playlists:', e)
      try {
        const slice = await fetchPage<Playlist>(PLAYLISTS_PAGE_PATH)
        set({
          baseEntries: [],
          folderChildren: {},
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
      // Only the legacy fallback path paginates; cookie-path libraryV3
      // returns the full library in one shot.
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
    const opening = !next.has(uri)
    if (opening) next.add(uri)
    else next.delete(uri)
    writeExpanded(Array.from(next))
    set({ expandedFolders: next })
    // Closing is purely a UI toggle — keep the cached children around so
    // reopening is instant. Opening only fetches when we don't already
    // have this folder's children in cache.
    if (!opening) return
    if (get().folderChildren[uri]) return

    set({ loading: true })
    try {
      const result = await fetchLibraryEntries({
        expandedFolders: Array.from(next),
      })
      const { base, children } = indexEntries(result.entries)
      // Merge fresh children over the existing cache. baseEntries
      // gets fully replaced because the response is the source of truth
      // for the top-level structure.
      const mergedChildren = { ...get().folderChildren, ...children }
      set({
        baseEntries: base,
        folderChildren: mergedChildren,
        playlists: deriveAllPlaylists(base, mergedChildren),
        loading: false,
      })
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e), loading: false })
    }
  },

  pin: (id) => {
    const cur = get().pinnedIds
    if (cur.includes(id)) return
    const updated = [...cur, id]
    writePinned(updated)
    set({ pinnedIds: updated })
  },
  unpin: (id) => {
    const cur = get().pinnedIds
    if (!cur.includes(id)) return
    const updated = cur.filter((x) => x !== id)
    writePinned(updated)
    set({ pinnedIds: updated })
  },
}))
