import { create } from 'zustand'

export type TransportPosition = 'bottom' | 'right'
export type SearchPosition = 'below' | 'above'

// The "focused row" is the most recently clicked row in either the playlist
// pane or the search-results pane. Action keys (q / p / a / l / Enter) target
// this row instead of the playing track. Click sets focus; double-click or
// Enter plays. `isTrack` gates q / a / l (only meaningful for tracks).
//
// `searchType` distinguishes the four search-result tabs so that Enter on a
// playlist or album result loads it into the pane (matching dblclick),
// while Enter on a track plays it. Set on search rows; null on playlist-pane
// rows.
export type FocusedRowPane = 'playlist' | 'search'
export type SearchResultType = 'track' | 'album' | 'artist' | 'playlist'
export interface FocusedRow {
  pane: FocusedRowPane
  uri: string
  isTrack: boolean
  searchType?: SearchResultType
}

// Whether the secondary text on each row (artists / playlist owners / etc.)
// renders below the primary title or right-aligned beside it (just left of
// the duration column, when one exists).
export type DetailLayout = 'below' | 'right'

const TRANSPORT_KEY = 'ui_transport_position'
const SEARCH_KEY = 'ui_search_position'
const DETAIL_KEY = 'ui_detail_layout'
const ACCENT_KEY = 'ui_accent_color'
const EXTERNAL_KEY = 'ui_external_color'

// Defaults match the CSS variable seed in styles.css.
export const DEFAULT_ACCENT = '#4ade80'
export const DEFAULT_EXTERNAL = '#a1a1aa'

function readTransport(): TransportPosition {
  return localStorage.getItem(TRANSPORT_KEY) === 'right' ? 'right' : 'bottom'
}
function readSearch(): SearchPosition {
  return localStorage.getItem(SEARCH_KEY) === 'above' ? 'above' : 'below'
}
function readDetail(): DetailLayout {
  return localStorage.getItem(DETAIL_KEY) === 'right' ? 'right' : 'below'
}
function readAccent(): string {
  return localStorage.getItem(ACCENT_KEY) || DEFAULT_ACCENT
}
function readExternal(): string {
  return localStorage.getItem(EXTERNAL_KEY) || DEFAULT_EXTERNAL
}

function applyColors(accent: string, external: string): void {
  document.documentElement.style.setProperty('--color-accent', accent)
  document.documentElement.style.setProperty('--color-external', external)
}

interface UIState {
  devicePickerOpen: boolean
  openDevicePicker: () => void
  closeDevicePicker: () => void
  helpOpen: boolean
  openHelp: () => void
  closeHelp: () => void
  colorPickerOpen: boolean
  openColorPicker: () => void
  closeColorPicker: () => void
  accentColor: string
  externalColor: string
  setAccentColor: (c: string) => void
  setExternalColor: (c: string) => void
  resetColors: () => void
  // Increments on `/` keypress; the search input watches this and refocuses.
  searchFocusTick: number
  focusSearch: () => void
  // Most recently clicked row in playlist or search panes. Action keys target
  // this; null when nothing is focused.
  focusedRow: FocusedRow | null
  setFocusedRow: (f: FocusedRow | null) => void
  // Spotify user id of the logged-in account. Set once on login; needed by
  // commands that compute editability (canEdit = owner.id === userId ||
  // collaborative) without prop-drilling from App.
  userId: string | null
  setUserId: (id: string | null) => void
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
  colorPickerOpen: false,
  openColorPicker: () => set({ colorPickerOpen: true }),
  closeColorPicker: () => set({ colorPickerOpen: false }),
  accentColor: readAccent(),
  externalColor: readExternal(),
  setAccentColor: (c) => {
    localStorage.setItem(ACCENT_KEY, c)
    applyColors(c, readExternal())
    set({ accentColor: c })
  },
  setExternalColor: (c) => {
    localStorage.setItem(EXTERNAL_KEY, c)
    applyColors(readAccent(), c)
    set({ externalColor: c })
  },
  resetColors: () => {
    localStorage.removeItem(ACCENT_KEY)
    localStorage.removeItem(EXTERNAL_KEY)
    applyColors(DEFAULT_ACCENT, DEFAULT_EXTERNAL)
    set({ accentColor: DEFAULT_ACCENT, externalColor: DEFAULT_EXTERNAL })
  },
  searchFocusTick: 0,
  focusSearch: () => set((s) => ({ searchFocusTick: s.searchFocusTick + 1 })),
  focusedRow: null,
  setFocusedRow: (focusedRow) => set({ focusedRow }),
  userId: null,
  setUserId: (userId) => set({ userId }),
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

// Push the persisted colors into CSS variables on first import so the very
// first paint already reflects user customization.
applyColors(readAccent(), readExternal())
