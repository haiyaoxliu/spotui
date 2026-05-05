import { create } from 'zustand'

export type TransportPosition = 'bottom' | 'right'
export type SearchPosition = 'below' | 'above'

const TRANSPORT_KEY = 'ui_transport_position'
const SEARCH_KEY = 'ui_search_position'

function readTransport(): TransportPosition {
  return localStorage.getItem(TRANSPORT_KEY) === 'right' ? 'right' : 'bottom'
}
function readSearch(): SearchPosition {
  return localStorage.getItem(SEARCH_KEY) === 'above' ? 'above' : 'below'
}

interface UIState {
  devicePickerOpen: boolean
  openDevicePicker: () => void
  closeDevicePicker: () => void
  // Increments on `/` keypress; the search input watches this and refocuses.
  searchFocusTick: number
  focusSearch: () => void
  // Layout prefs (persisted to localStorage).
  transportPosition: TransportPosition
  searchPosition: SearchPosition
  setTransportPosition: (p: TransportPosition) => void
  setSearchPosition: (p: SearchPosition) => void
}

export const useUI = create<UIState>((set) => ({
  devicePickerOpen: false,
  openDevicePicker: () => set({ devicePickerOpen: true }),
  closeDevicePicker: () => set({ devicePickerOpen: false }),
  searchFocusTick: 0,
  focusSearch: () => set((s) => ({ searchFocusTick: s.searchFocusTick + 1 })),
  transportPosition: readTransport(),
  searchPosition: readSearch(),
  setTransportPosition: (p) => {
    localStorage.setItem(TRANSPORT_KEY, p)
    set({ transportPosition: p })
  },
  setSearchPosition: (p) => {
    localStorage.setItem(SEARCH_KEY, p)
    set({ searchPosition: p })
  },
}))
