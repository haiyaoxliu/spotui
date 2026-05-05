import { useCallback, useEffect, useState } from 'react'
import { handleCallback, isLoggedIn, login, logout } from './auth/auth'
import { api } from './api/client'
import { checkLibraryContains, getPlaybackState, getQueue } from './api/spotify'
import { usePlayer } from './store/player'
import { useSelection } from './store/selection'
import { useUI } from './store/ui'
import {
  addFocusedToOpenPlaylist,
  adjustSeek,
  adjustVolume,
  cycleRepeat,
  isIsPlayingSuppressed,
  isPositionSuppressed,
  isRepeatSuppressed,
  isShuffleSuppressed,
  isVolumeSuppressed,
  playFocused,
  playFocusedTrackOnly,
  queueFocused,
  skipNext,
  skipPrevious,
  toggleLikeCurrent,
  togglePlayPause,
  toggleShuffle,
} from './commands'
import { TransportBar } from './components/TransportBar'
import { ColorPicker } from './components/ColorPicker'
import { DevicePicker } from './components/DevicePicker'
import { HelpOverlay } from './components/HelpOverlay'
import { LibraryPanel } from './components/LibraryPanel'
import { SelectedPlaylist } from './components/SelectedPlaylist'
import { RightPanel } from './components/RightPanel'

// StrictMode in dev runs effects twice; the OAuth code is single-use, so
// dedupe across mounts by sharing the in-flight handleCallback() promise.
let callbackInflight: Promise<void> | null = null

interface Me {
  display_name: string
  id: string
  email?: string
  product: 'premium' | 'free' | 'open'
  country?: string
}

export function App() {
  const [me, setMe] = useState<Me | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    async function init() {
      try {
        if (window.location.pathname === '/callback') {
          if (!callbackInflight) callbackInflight = handleCallback()
          await callbackInflight
        }
        if (isLoggedIn()) {
          const data = await api<Me>('/me')
          if (!cancelled && data) {
            setMe(data)
            useUI.getState().setUserId(data.id)
          }
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    init()
    return () => {
      cancelled = true
    }
  }, [])

  if (loading) return <div className="p-8 text-neutral-400">Loading…</div>

  if (error) {
    return (
      <div className="p-8 max-w-xl space-y-3">
        <h1 className="text-xl font-semibold text-red-400">Error</h1>
        <pre className="whitespace-pre-wrap text-sm text-neutral-300">{error}</pre>
        <button
          onClick={() => {
            logout()
            sessionStorage.removeItem('pkce_verifier')
            sessionStorage.removeItem('pkce_state')
            window.location.replace('/')
          }}
          className="px-3 py-1.5 rounded bg-neutral-800 hover:bg-neutral-700 text-sm"
        >
          Reset
        </button>
      </div>
    )
  }

  if (!me) {
    return (
      <div className="p-8 space-y-4">
        <h1 className="text-2xl font-semibold">Spotify Controller</h1>
        <p className="text-neutral-400 text-sm max-w-md">
          Local web controller for the Spotify Web API. Drives whichever Spotify Connect device is
          active (phone, desktop app, speaker).
        </p>
        <button
          onClick={() => {
            void login()
          }}
          className="px-4 py-2 rounded bg-green-600 hover:bg-green-500 text-black font-medium"
        >
          Log in with Spotify
        </button>
      </div>
    )
  }

  return <Player me={me} />
}

function Player({ me }: { me: Me }) {
  const setPlayback = usePlayer((s) => s.setPlayback)
  const setQueue = usePlayer((s) => s.setQueue)
  const openDevicePicker = useUI((s) => s.openDevicePicker)
  const devicePickerOpen = useUI((s) => s.devicePickerOpen)
  const openHelp = useUI((s) => s.openHelp)
  const helpOpen = useUI((s) => s.helpOpen)
  const openColorPicker = useUI((s) => s.openColorPicker)
  const colorPickerOpen = useUI((s) => s.colorPickerOpen)
  const focusSearch = useUI((s) => s.focusSearch)
  const transportPosition = useUI((s) => s.transportPosition)
  const searchPosition = useUI((s) => s.searchPosition)
  const detailLayout = useUI((s) => s.detailLayout)
  const goBack = useSelection((s) => s.goBack)
  const setTransportPosition = useUI((s) => s.setTransportPosition)
  const setSearchPosition = useUI((s) => s.setSearchPosition)
  const setDetailLayout = useUI((s) => s.setDetailLayout)

  const refresh = useCallback(async () => {
    const [stateRes, queueRes] = await Promise.allSettled([getPlaybackState(), getQueue()])
    if (stateRes.status === 'fulfilled') {
      let fresh = stateRes.value
      // Per-field suppression: while a recent local change is in flight,
      // keep the locally-set value for that field and let others update.
      if (fresh) {
        const cur = usePlayer.getState().playback
        if (cur) {
          if (isIsPlayingSuppressed()) fresh = { ...fresh, is_playing: cur.is_playing }
          if (isShuffleSuppressed()) fresh = { ...fresh, shuffle_state: cur.shuffle_state }
          if (isRepeatSuppressed()) fresh = { ...fresh, repeat_state: cur.repeat_state }
          if (isPositionSuppressed() && cur.progress_ms != null) {
            fresh = { ...fresh, progress_ms: cur.progress_ms }
          }
          if (isVolumeSuppressed() && fresh.device && cur.device) {
            fresh = {
              ...fresh,
              device: { ...fresh.device, volume_percent: cur.device.volume_percent },
            }
          }
        }
      }
      setPlayback(fresh)
    } else {
      console.error('refresh /me/player failed:', stateRes.reason)
    }
    if (queueRes.status === 'fulfilled') {
      setQueue(queueRes.value)
    } else {
      console.error('refresh /me/player/queue failed:', queueRes.reason)
    }
  }, [setPlayback, setQueue])

  // Initial fetch + 3s polling.
  useEffect(() => {
    void refresh()
    const id = setInterval(() => void refresh(), 3000)
    return () => clearInterval(id)
  }, [refresh])

  // Re-check whether the currently playing track is in Liked Songs whenever
  // the track changes. Liked state isn't part of /me/player.
  const playingTrackUri = usePlayer((s) =>
    s.playback?.item?.type === 'track' ? s.playback.item.uri : null,
  )
  const setLiked = usePlayer((s) => s.setLiked)
  useEffect(() => {
    setLiked(null)
    if (!playingTrackUri) return
    let cancelled = false
    checkLibraryContains([playingTrackUri])
      .then(([contains]) => {
        if (!cancelled) setLiked(contains ?? null)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [playingTrackUri, setLiked])

  // Global keybinds (skip when a modal is open or text input is focused).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as Element | null
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return
      if (devicePickerOpen || helpOpen || colorPickerOpen) return

      switch (e.key) {
        case ' ':
          e.preventDefault()
          void togglePlayPause(refresh)
          break
        case 'j':
        case 'ArrowRight':
          e.preventDefault()
          void skipNext(refresh)
          break
        case 'k':
        case 'ArrowLeft':
          e.preventDefault()
          void skipPrevious(refresh)
          break
        case 's':
          e.preventDefault()
          void toggleShuffle(refresh)
          break
        case 'r':
          e.preventDefault()
          void cycleRepeat(refresh)
          break
        case ',':
          e.preventDefault()
          void adjustSeek(-10_000, refresh)
          break
        case '.':
          e.preventDefault()
          void adjustSeek(10_000, refresh)
          break
        case '-':
          e.preventDefault()
          void adjustVolume(-5, refresh)
          break
        case '=':
        case '+':
          e.preventDefault()
          void adjustVolume(5, refresh)
          break
        case 'l':
          e.preventDefault()
          void toggleLikeCurrent()
          break
        case 'q':
          e.preventDefault()
          void queueFocused()
          break
        case 'p':
          e.preventDefault()
          void playFocusedTrackOnly(refresh)
          break
        case 'a':
          e.preventDefault()
          void addFocusedToOpenPlaylist()
          break
        case 'Enter':
          e.preventDefault()
          void playFocused(refresh)
          break
        case 'd':
          e.preventDefault()
          openDevicePicker()
          break
        case '/':
          e.preventDefault()
          focusSearch()
          break
        case '?':
          e.preventDefault()
          openHelp()
          break
        case 'c':
          e.preventDefault()
          openColorPicker()
          break
        case 'b':
          e.preventDefault()
          void goBack()
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [
    devicePickerOpen,
    helpOpen,
    colorPickerOpen,
    openDevicePicker,
    openHelp,
    openColorPicker,
    focusSearch,
    goBack,
    refresh,
  ])

  return (
    <div className="h-screen flex flex-col">
      <header className="px-4 py-2 border-b border-neutral-800 flex items-center justify-between text-sm">
        <span>
          <span className="text-neutral-500">Logged in as </span>
          <span className="font-medium">{me.display_name}</span>
          {me.product !== 'premium' && (
            <span className="ml-2 text-yellow-400">(non-premium — controls will fail)</span>
          )}
        </span>
        <div className="flex items-center gap-2">
          <button
            onClick={() =>
              setSearchPosition(searchPosition === 'below' ? 'above' : 'below')
            }
            className="px-2 py-1 rounded bg-neutral-800 hover:bg-neutral-700 text-xs"
            title="Toggle search bar position"
          >
            search: {searchPosition}
          </button>
          <button
            onClick={() => setDetailLayout(detailLayout === 'below' ? 'right' : 'below')}
            className="px-2 py-1 rounded bg-neutral-800 hover:bg-neutral-700 text-xs"
            title="Toggle row detail layout"
          >
            details: {detailLayout}
          </button>
          <button
            onClick={() =>
              setTransportPosition(transportPosition === 'bottom' ? 'right' : 'bottom')
            }
            className="px-2 py-1 rounded bg-neutral-800 hover:bg-neutral-700 text-xs"
            title="Toggle transport bar position"
          >
            controls: {transportPosition}
          </button>
          <button
            onClick={openDevicePicker}
            className="px-2 py-1 rounded bg-neutral-800 hover:bg-neutral-700 text-xs"
            title="Pick device (d)"
          >
            Device (d)
          </button>
          <button
            onClick={openColorPicker}
            className="px-2 py-1 rounded bg-neutral-800 hover:bg-neutral-700 text-xs"
            title="Customize colors (c)"
          >
            Colors (c)
          </button>
          <button
            onClick={openHelp}
            className="px-2 py-1 rounded bg-neutral-800 hover:bg-neutral-700 text-xs"
            title="Show keybinds (?)"
          >
            ?
          </button>
          <button
            onClick={() => {
              logout()
              window.location.reload()
            }}
            className="px-2 py-1 rounded bg-neutral-800 hover:bg-neutral-700 text-xs"
          >
            Log out
          </button>
        </div>
      </header>
      <main className="flex-1 overflow-hidden flex">
        <LibraryPanel ownerId={me.id} />
        <SelectedPlaylist
          onAfterPlay={() => void refresh()}
          searchPosition={searchPosition}
          ownerId={me.id}
        />
        <RightPanel
          showTransport={transportPosition === 'right'}
          onAfterAction={() => void refresh()}
        />
      </main>
      {transportPosition === 'bottom' && (
        <TransportBar onAfterAction={() => void refresh()} />
      )}
      <DevicePicker onAfterTransfer={() => void refresh()} />
      <HelpOverlay />
      <ColorPicker />
    </div>
  )
}
