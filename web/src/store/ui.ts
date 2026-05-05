import { create } from 'zustand'

export type TransportPosition = 'bottom' | 'right'
export type SearchPosition = 'below' | 'above'

// The "focused row" is the most recently clicked row in either the playlist
// pane or the search-results pane. Action keys (q / Q / a / l / Enter) target
// this row instead of the playing track. Click sets focus; double-click or
// Enter plays. `isTrack` gates q / a / l (only meaningful for tracks).
export type FocusedRowPane = 'playlist' | 'search'
export interface FocusedRow {
  pane: FocusedRowPane
  uri: string
  isTrack: boolean
}

// Whether the secondary text on each row (artists / playlist owners / etc.)
// renders below the primary title or right-aligned beside it (just left of
// the duration column, when one exists).
export type DetailLayout = 'below' | 'right'

const TRANSPORT_KEY = 'ui_transport_position'
const SEARCH_KEY = 'ui_search_position'
const DETAIL_KEY = 'ui_detail_layout'

function readTransport(): TransportPosition {
  return localStorage.getItem(TRANSPORT_KEY) === 'right' ? 'right' : 'bottom'
}
function readSearch(): SearchPosition {
  return localStorage.getItem(SEARCH_KEY) === 'above' ? 'above' : 'below'
}
function readDetail(): DetailLayout {
  return localStorage.getItem(DETAIL_KEY) === 'right' ? 'right' : 'below'
}

interface UIState {
  devicePickerOpen: boolean
  openDevicePicker: () => void
  closeDevicePicker: () => void
  helpOpen: boolean
  openHelp: () => void
  closeHelp: () => void
  // Increments on `/` keypress; the search input watches this and refocuses.
  searchFocusTick: number
  focusSearch: () => void
  // Most recently clicked row in playlist or search panes. Action keys target
  // this; null when nothing is focused.
  focusedRow: FocusedRow | null
  setFocusedRow: (f: FocusedRow | null) => void
  // Layout prefs (persisted to localStorage).
  transportPosition: TransportPosition
  searchPosition: SearchPosition
  detailLayout: DetailLayout
  setTransportPosition: (p: TransportPosition) => void
  setSearchPosition: (p: SearchPosition) => void
  setDetailLayout: (l: DetailLayout) => void
}

export const useUI = create<UIState>((set) => ({
  devicePickerOpen: false,
  openDevicePicker: () => set({ devicePickerOpen: true }),
  closeDevicePicker: () => set({ devicePickerOpen: false }),
  helpOpen: false,
  openHelp: () => set({ helpOpen: true }),
  closeHelp: () => set({ helpOpen: false }),
  searchFocusTick: 0,
  focusSearch: () => set((s) => ({ searchFocusTick: s.searchFocusTick + 1 })),
  focusedRow: null,
  setFocusedRow: (focusedRow) => set({ focusedRow }),
  transportPosition: readTransport(),
  searchPosition: readSearch(),
  detailLayout: readDetail(),
  setTransportPosition: (p) => {
    localStorage.setItem(TRANSPORT_KEY, p)
    set({ transportPosition: p })
  },
  setSearchPosition: (p) => {
    localStorage.setItem(SEARCH_KEY, p)
    set({ searchPosition: p })
  },
  setDetailLayout: (l) => {
    localStorage.setItem(DETAIL_KEY, l)
    set({ detailLayout: l })
  },
}))
