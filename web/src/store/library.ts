import { create } from 'zustand'
import type { Playlist } from '../api/spotify'
import { getMyPlaylists } from '../api/spotify'

const PINNED_KEY = 'library_pinned_ids'
const DW_AUTOPIN_KEY = 'discover_weekly_autopinned'

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
  error: string | null
  pinnedIds: string[]
  load: () => Promise<void>
  pin: (id: string) => void
  unpin: (id: string) => void
}

export const useLibrary = create<LibraryState>((set, get) => ({
  playlists: [],
  loaded: false,
  loading: false,
  error: null,
  pinnedIds: readPinned(),
  load: async () => {
    if (get().loading || get().loaded) return
    set({ loading: true, error: null })
    try {
      const playlists = await getMyPlaylists()
      set({ playlists, loaded: true, loading: false })
      // One-time auto-pin for Discover Weekly. We only do this once, tracked
      // by a localStorage flag, so an explicit unpin survives reloads.
      if (!localStorage.getItem(DW_AUTOPIN_KEY)) {
        const dw = playlists.find(
          (p) => p.owner.id === 'spotify' && p.name === 'Discover Weekly',
        )
        if (dw) {
          const cur = get().pinnedIds
          if (!cur.includes(dw.id)) {
            const next = [...cur, dw.id]
            writePinned(next)
            set({ pinnedIds: next })
          }
          localStorage.setItem(DW_AUTOPIN_KEY, '1')
        }
      }
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
