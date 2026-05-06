import { create } from 'zustand'

export type TransportPosition = 'bottom' | 'right'
export type SearchPosition = 'below' | 'above'
export type Theme = 'dark' | 'light'

// The "focused row" is the user's most recently clicked row anywhere in the
// app — a library entry, a search result, or a track inside the playlist
// pane. Only one row across all three panes is ever "selected" at a time;
// the previous one is implicitly cleared on the next click.
//
// Action keys (q / p / a / l / Enter) target this row. Click sets focus;
// double-click or Enter plays whatever it points at. `isTrack` gates q / a /
// l (only meaningful for tracks). `searchType` distinguishes the four
// search-result tabs so playFocused can decide between play-track,
// play-context, etc.
export type FocusedRowPane = 'library' | 'playlist' | 'search'
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
const THEME_KEY = 'ui_theme'
// Legacy single-color keys (pre-theme). Read once on first run as a
// migration source for the dark-theme values, then ignored.
const LEGACY_ACCENT_KEY = 'ui_accent_color'
const LEGACY_EXTERNAL_KEY = 'ui_external_color'
const ACCENT_DARK_KEY = 'ui_accent_color_dark'
const ACCENT_LIGHT_KEY = 'ui_accent_color_light'
const EXTERNAL_DARK_KEY = 'ui_external_color_dark'
const EXTERNAL_LIGHT_KEY = 'ui_external_color_light'

// Per-theme defaults — colors that read well on each background.
export const DEFAULT_ACCENT_DARK = '#4ade80'
export const DEFAULT_ACCENT_LIGHT = '#16a34a'
export const DEFAULT_EXTERNAL_DARK = '#a1a1aa'
export const DEFAULT_EXTERNAL_LIGHT = '#71717a'

function readTransport(): TransportPosition {
  return localStorage.getItem(TRANSPORT_KEY) === 'right' ? 'right' : 'bottom'
}
function readSearch(): SearchPosition {
  return localStorage.getItem(SEARCH_KEY) === 'above' ? 'above' : 'below'
}
function readDetail(): DetailLayout {
  return localStorage.getItem(DETAIL_KEY) === 'right' ? 'right' : 'below'
}
function readTheme(): Theme {
  return localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark'
}
function readAccent(theme: Theme): string {
  const key = theme === 'dark' ? ACCENT_DARK_KEY : ACCENT_LIGHT_KEY
  const stored = localStorage.getItem(key)
  if (stored) return stored
  // One-time migration: if the user previously customized in single-theme
  // mode, carry that value forward as their dark accent.
  if (theme === 'dark') {
    const legacy = localStorage.getItem(LEGACY_ACCENT_KEY)
    if (legacy) return legacy
  }
  return theme === 'dark' ? DEFAULT_ACCENT_DARK : DEFAULT_ACCENT_LIGHT
}
function readExternal(theme: Theme): string {
  const key = theme === 'dark' ? EXTERNAL_DARK_KEY : EXTERNAL_LIGHT_KEY
  const stored = localStorage.getItem(key)
  if (stored) return stored
  if (theme === 'dark') {
    const legacy = localStorage.getItem(LEGACY_EXTERNAL_KEY)
    if (legacy) return legacy
  }
  return theme === 'dark' ? DEFAULT_EXTERNAL_DARK : DEFAULT_EXTERNAL_LIGHT
}

function applyTheme(theme: Theme): void {
  const root = document.documentElement
  if (theme === 'dark') root.classList.add('dark')
  else root.classList.remove('dark')
}

function applyColors(accent: string, external: string): void {
  const root = document.documentElement
  root.style.setProperty('--color-accent', accent)
  root.style.setProperty('--color-external', external)
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
  // Right-edge slide-in drawer that holds the unified toggles + log out.
  // Opens with the `s` key (and the gear button in the console bar);
  // closes with esc or `s` again.
  controlPaneOpen: boolean
  openControlPane: () => void
  closeControlPane: () => void
  toggleControlPane: () => void
  // Theme + per-theme color profiles. The active --color-accent and
  // --color-external CSS vars always reflect the current theme's pair, so
  // consumers don't care which profile produced them.
  theme: Theme
  setTheme: (t: Theme) => void
  toggleTheme: () => void
  accentColorDark: string
  accentColorLight: string
  externalColorDark: string
  externalColorLight: string
  setAccentColor: (theme: Theme, c: string) => void
  setExternalColor: (theme: Theme, c: string) => void
  resetColors: (theme: Theme) => void
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

const initialTheme = readTheme()
const initialAccentDark = readAccent('dark')
const initialAccentLight = readAccent('light')
const initialExternalDark = readExternal('dark')
const initialExternalLight = readExternal('light')

export const useUI = create<UIState>((set, get) => ({
  devicePickerOpen: false,
  openDevicePicker: () => set({ devicePickerOpen: true }),
  closeDevicePicker: () => set({ devicePickerOpen: false }),
  helpOpen: false,
  openHelp: () => set({ helpOpen: true }),
  closeHelp: () => set({ helpOpen: false }),
  colorPickerOpen: false,
  openColorPicker: () => set({ colorPickerOpen: true }),
  closeColorPicker: () => set({ colorPickerOpen: false }),
  controlPaneOpen: false,
  openControlPane: () => set({ controlPaneOpen: true }),
  closeControlPane: () => set({ controlPaneOpen: false }),
  toggleControlPane: () => set((s) => ({ controlPaneOpen: !s.controlPaneOpen })),
  theme: initialTheme,
  setTheme: (t) => {
    localStorage.setItem(THEME_KEY, t)
    applyTheme(t)
    const s = get()
    applyColors(
      t === 'dark' ? s.accentColorDark : s.accentColorLight,
      t === 'dark' ? s.externalColorDark : s.externalColorLight,
    )
    set({ theme: t })
  },
  toggleTheme: () => {
    const next: Theme = get().theme === 'dark' ? 'light' : 'dark'
    get().setTheme(next)
  },
  accentColorDark: initialAccentDark,
  accentColorLight: initialAccentLight,
  externalColorDark: initialExternalDark,
  externalColorLight: initialExternalLight,
  setAccentColor: (theme, c) => {
    localStorage.setItem(theme === 'dark' ? ACCENT_DARK_KEY : ACCENT_LIGHT_KEY, c)
    set(theme === 'dark' ? { accentColorDark: c } : { accentColorLight: c })
    if (get().theme === theme) {
      applyColors(
        c,
        theme === 'dark' ? get().externalColorDark : get().externalColorLight,
      )
    }
  },
  setExternalColor: (theme, c) => {
    localStorage.setItem(theme === 'dark' ? EXTERNAL_DARK_KEY : EXTERNAL_LIGHT_KEY, c)
    set(theme === 'dark' ? { externalColorDark: c } : { externalColorLight: c })
    if (get().theme === theme) {
      applyColors(
        theme === 'dark' ? get().accentColorDark : get().accentColorLight,
        c,
      )
    }
  },
  resetColors: (theme) => {
    if (theme === 'dark') {
      localStorage.removeItem(ACCENT_DARK_KEY)
      localStorage.removeItem(EXTERNAL_DARK_KEY)
      set({
        accentColorDark: DEFAULT_ACCENT_DARK,
        externalColorDark: DEFAULT_EXTERNAL_DARK,
      })
      if (get().theme === 'dark') {
        applyColors(DEFAULT_ACCENT_DARK, DEFAULT_EXTERNAL_DARK)
      }
    } else {
      localStorage.removeItem(ACCENT_LIGHT_KEY)
      localStorage.removeItem(EXTERNAL_LIGHT_KEY)
      set({
        accentColorLight: DEFAULT_ACCENT_LIGHT,
        externalColorLight: DEFAULT_EXTERNAL_LIGHT,
      })
      if (get().theme === 'light') {
        applyColors(DEFAULT_ACCENT_LIGHT, DEFAULT_EXTERNAL_LIGHT)
      }
    }
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

// Push the persisted theme + colors before first paint so the initial render
// already reflects the user's choices (no light-mode flash on a dark setup).
applyTheme(initialTheme)
applyColors(
  initialTheme === 'dark' ? initialAccentDark : initialAccentLight,
  initialTheme === 'dark' ? initialExternalDark : initialExternalLight,
)
