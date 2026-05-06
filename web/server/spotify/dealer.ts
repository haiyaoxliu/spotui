/**
 * Persistent connection to `wss://dealer.spotify.com/`.
 *
 * Spotify pushes player-state updates and other events to this WebSocket.
 * We don't try to fully parse the message payloads (their schema is
 * undocumented and shifts with web-player releases). Instead we use
 * dealer as a *signal*: any non-ping message means "something changed,
 * refetch state" — the SPA refetches `/me/player` and `/me/player/queue`
 * on each signal. That's enough to replace the existing polling loops
 * without reverse-engineering the message protocol.
 *
 * Lifecycle:
 *   - Single shared connection per sidecar process (lazy: opens on first
 *     subscriber, closes when none).
 *   - Token refresh: dealer's bearer is the cookie-derived web token. We
 *     re-mint when expiry is < 1 minute away and reconnect.
 *   - Reconnects on close with exponential backoff (1s → 2s → 4s → … 30s).
 *   - Sends pong on dealer ping frames; dealer disconnects if it doesn't
 *     hear back within ~30s.
 */

import { EventEmitter } from 'node:events'

import WebSocket from 'ws'

import { discoverCookies } from '../cookies/index.js'
import { hasSpDc } from '../cookies/types.js'
import { readFileCookies } from '../cookies/file.js'
import { getToken } from './token.js'

const DEALER_URL = 'wss://dealer.spotify.com/'
const RECONNECT_BASE_MS = 1_000
const RECONNECT_MAX_MS = 30_000
const TOKEN_SLACK_MS = 60_000

export interface DealerEvent {
  /** Type from the dealer message (e.g. 'message', 'pong', 'connection_id').
   *  Consumers usually only care that *something* happened. */
  kind: string
  /** Parsed payload, for debugging. Do not depend on its shape. */
  raw?: unknown
}

class DealerClient extends EventEmitter {
  private ws: WebSocket | null = null
  private subscribers = 0
  private reconnectAttempts = 0
  private reconnectTimer: NodeJS.Timeout | null = null
  private connectionId: string | null = null
  private closedIntentionally = false
  private connecting = false

  /** Subscribe to state-changed events. Returns an unsubscribe function. */
  subscribe(handler: (e: DealerEvent) => void): () => void {
    this.on('event', handler)
    this.subscribers++
    if (this.subscribers === 1) {
      void this.ensureConnected()
    }
    return () => {
      this.off('event', handler)
      this.subscribers = Math.max(0, this.subscribers - 1)
      if (this.subscribers === 0) this.disconnect()
    }
  }

  /** True if the dealer WS is in OPEN state. */
  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN
  }

  connectionIdOrNull(): string | null {
    return this.connectionId
  }

  private async ensureConnected(): Promise<void> {
    if (this.isConnected() || this.connecting) return
    this.connecting = true
    try {
      const cookies = await loadCookies()
      if (!cookies) {
        console.warn('[spotui] dealer: no cookies; will retry on next subscribe')
        return
      }
      const tok = await getToken({ cookies, source: 'file' })
      const url = new URL(DEALER_URL)
      url.searchParams.set('access_token', tok.accessToken)

      this.closedIntentionally = false
      const ws = new WebSocket(url, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        },
      })
      this.ws = ws
      ws.on('open', () => {
        this.reconnectAttempts = 0
        this.emit('event', { kind: 'open' } satisfies DealerEvent)
      })
      ws.on('message', (data) => this.handleFrame(data))
      ws.on('ping', (data) => {
        try {
          ws.pong(data)
        } catch {
          /* connection might already be closing */
        }
      })
      ws.on('error', (err) => {
        console.warn('[spotui] dealer error:', err.message)
      })
      ws.on('close', (code, reason) => {
        this.ws = null
        this.connectionId = null
        this.emit('event', { kind: 'close', raw: { code, reason: reason.toString() } })
        if (!this.closedIntentionally && this.subscribers > 0) {
          this.scheduleReconnect()
        }
      })

      // Schedule a refresh-and-reconnect a few seconds before token expiry.
      const ttl = tok.expiresAt - Date.now() - TOKEN_SLACK_MS
      if (ttl > 0) {
        setTimeout(() => {
          if (this.isConnected()) {
            this.closedIntentionally = false
            ws.close(1000, 'token refresh')
          }
        }, ttl).unref?.()
      }
    } finally {
      this.connecting = false
    }
  }

  private handleFrame(data: WebSocket.RawData): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(typeof data === 'string' ? data : data.toString('utf8'))
    } catch {
      return
    }
    const obj = parsed as Record<string, unknown>
    const type = typeof obj.type === 'string' ? obj.type : 'unknown'

    // First frame includes the Spotify-Connection-Id header. Capture it
    // so the connect-state HTTP path can reuse it later (phase 3.5+).
    if (this.connectionId === null) {
      const headers = obj.headers as Record<string, unknown> | undefined
      if (headers && typeof headers === 'object') {
        for (const [k, v] of Object.entries(headers)) {
          if (k.toLowerCase() === 'spotify-connection-id' && typeof v === 'string') {
            this.connectionId = v
            this.emit('event', { kind: 'connection_id', raw: v } satisfies DealerEvent)
            return
          }
        }
      }
    }

    // Pings come through as `type: "ping"` JSON; respond and don't propagate.
    if (type === 'ping') {
      try {
        this.ws?.send(JSON.stringify({ type: 'pong' }))
      } catch {
        /* connection closing */
      }
      return
    }

    this.emit('event', { kind: type, raw: parsed } satisfies DealerEvent)
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return
    const delay = Math.min(
      RECONNECT_BASE_MS * 2 ** this.reconnectAttempts,
      RECONNECT_MAX_MS,
    )
    this.reconnectAttempts++
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.ensureConnected()
    }, delay)
    // Don't keep the process alive solely for a reconnect timer.
    this.reconnectTimer.unref?.()
  }

  private disconnect(): void {
    this.closedIntentionally = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.close(1000, 'no subscribers')
    }
    this.ws = null
    this.connectionId = null
    this.reconnectAttempts = 0
  }
}

async function loadCookies(): Promise<
  Awaited<ReturnType<typeof readFileCookies>> | null
> {
  const persisted = await readFileCookies()
  if (hasSpDc(persisted)) return persisted
  const { found } = await discoverCookies()
  return found?.cookies ?? null
}

let singleton: DealerClient | null = null

export function getDealer(): DealerClient {
  if (!singleton) singleton = new DealerClient()
  return singleton
}
