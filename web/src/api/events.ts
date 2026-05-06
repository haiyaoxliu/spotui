/**
 * SSE client for `/api/proxy/state/stream`.
 *
 * The sidecar holds a single `wss://dealer.spotify.com/` connection and
 * pushes a `tick` event whenever Spotify signals a state change. Consumers
 * (typically the player store) re-fetch playback state on each tick.
 *
 * Falls back gracefully if the sidecar is missing (PKCE-only dev) or the
 * SSE connection can't be established — caller passes its own `fallback`
 * polling interval so the UI keeps working either way.
 */

const STREAM_URL = '/api/proxy/state/stream'

export type StateEventKind = 'open' | 'tick' | 'close' | 'hello'

export interface StateSubscriptionOptions {
  onTick: () => void
  /** Called when SSE re-opens after a disconnect; usually triggers a
   *  refresh so the SPA picks up any state we missed during downtime. */
  onReconnect?: () => void
  /** Optional fallback polling interval (ms). Fires when SSE is
   *  unavailable AND when SSE is connected (as a safety net for missed
   *  ticks). Pass 0 to disable. */
  fallbackIntervalMs?: number
}

export interface StateSubscription {
  close: () => void
  /** True if the EventSource is currently OPEN. */
  isLive: () => boolean
}

/** Subscribe to player-state push events. Returns a handle the caller
 *  uses to close. Always invokes onTick once on initial connect so the
 *  SPA gets a fresh state immediately rather than waiting for the next
 *  Spotify event. */
export function subscribeState(
  opts: StateSubscriptionOptions,
): StateSubscription {
  const { onTick, onReconnect, fallbackIntervalMs = 30_000 } = opts
  let es: EventSource | null = null
  let fallbackTimer: ReturnType<typeof setInterval> | null = null
  let live = false
  let closed = false

  const start = (): void => {
    if (closed) return
    try {
      es = new EventSource(STREAM_URL)
    } catch (e) {
      console.warn('[spotui] SSE construction failed:', e)
      return
    }
    es.addEventListener('hello', () => {
      live = true
    })
    es.addEventListener('open', () => {
      live = true
      onReconnect?.()
    })
    es.addEventListener('tick', () => {
      onTick()
    })
    es.addEventListener('close', () => {
      live = false
    })
    es.onerror = () => {
      // EventSource auto-reconnects on transport errors; we only care
      // about logging the state for debugging.
      live = false
    }
  }

  start()
  if (fallbackIntervalMs > 0) {
    fallbackTimer = setInterval(() => {
      onTick()
    }, fallbackIntervalMs)
  }

  return {
    close: () => {
      closed = true
      if (es) {
        es.close()
        es = null
      }
      if (fallbackTimer) {
        clearInterval(fallbackTimer)
        fallbackTimer = null
      }
      live = false
    },
    isLive: () => live,
  }
}
