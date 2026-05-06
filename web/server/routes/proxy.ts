/**
 * `/api/proxy/*` routes. The SPA calls these; the sidecar attaches cookie
 * auth and talks to Spotify's internal endpoints.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

import { loadCookies, type CookieReadResult } from '../cookies/index.js'
import { fetchBuddylist } from '../spotify/buddylist.js'
import { connectClient } from '../spotify/connect.js'
import { getDealer, type DealerEvent } from '../spotify/dealer.js'
import {
  getCurrentSession,
  leaveSession,
  startSession,
} from '../spotify/jam.js'
import { fetchLyrics, LyricsNotFoundError } from '../spotify/lyrics.js'
import { getMe, MeRateLimitedError } from '../spotify/me.js'
import {
  fetchLibraryTracksVariables,
  fetchPlaylistVariables,
  libraryV3Variables,
  pathfinderQuery,
  searchDesktopVariables,
} from '../spotify/pathfinder.js'
import { fetchClusterSnapshot, fetchRawCluster } from '../spotify/state.js'
import {
  clampInt,
  errMsg,
  error,
  json,
  noContent,
  readJson,
} from './_http.js'

interface PathfinderBody {
  operation?: unknown
  variables?: unknown
}

/** POST /api/proxy/pathfinder
 *  body: { operation: string, variables?: object }
 *  → returns Spotify's raw Pathfinder JSON. */
export async function pathfinderHandler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  let body: PathfinderBody
  try {
    body = (await readJson(req)) as PathfinderBody
  } catch (e) {
    return error(res, 400, `invalid JSON: ${errMsg(e)}`)
  }
  if (typeof body.operation !== 'string' || body.operation.length === 0) {
    return error(res, 400, 'expected { operation: string }')
  }
  const variables: Record<string, unknown> =
    body.variables && typeof body.variables === 'object'
      ? (body.variables as Record<string, unknown>)
      : {}

  const read = await loadCookies()
  if (!read) {
    return error(res, 401, 'no cookies (run /api/auth/discover or paste)')
  }

  try {
    const payload = await pathfinderQuery(read, body.operation, variables)
    json(res, 200, payload)
  } catch (e) {
    error(res, 502, errMsg(e))
  }
}

interface SearchQuery {
  q?: unknown
  limit?: unknown
  offset?: unknown
}

/** GET /api/proxy/search?q=...&limit=...&offset=...
 *  Convenience wrapper around `searchDesktop`. Returns Pathfinder's raw
 *  payload — extraction lives in the SPA so we don't pin a schema here. */
export async function searchHandler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://_')
  const params: SearchQuery = Object.fromEntries(url.searchParams)
  const q = typeof params.q === 'string' ? params.q.trim() : ''
  if (q.length === 0) return error(res, 400, 'q required')
  const limit = clampInt(params.limit, 10, 1, 50)
  const offset = clampInt(params.offset, 0, 0, 1000)

  const read = await loadCookies()
  if (!read) {
    return error(res, 401, 'no cookies (run /api/auth/discover or paste)')
  }

  try {
    const payload = await pathfinderQuery(
      read,
      'searchDesktop',
      searchDesktopVariables(q, limit, offset),
    )
    json(res, 200, payload)
  } catch (e) {
    error(res, 502, errMsg(e))
  }
}

/** GET /api/proxy/library/playlists?limit=…&offset=…&expanded=uri1,uri2
 *  Wraps libraryV3 with `filter: ['Playlists']`. The `expanded` query
 *  param is a comma-separated list of folder URIs Spotify should expand
 *  inline; the response includes those folders' children at depth+1. */
export async function libraryPlaylistsHandler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://_')
  const limit = clampInt(url.searchParams.get('limit'), 50, 1, 200)
  const offset = clampInt(url.searchParams.get('offset'), 0, 0, 100_000)
  const expanded = (url.searchParams.get('expanded') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s.startsWith('spotify:'))
  const read = await loadCookies()
  if (!read) return error(res, 401, 'no cookies')
  try {
    const payload = await pathfinderQuery(
      read,
      'libraryV3',
      libraryV3Variables('Playlists', limit, offset, expanded),
    )
    json(res, 200, payload)
  } catch (e) {
    error(res, 502, errMsg(e))
  }
}

/** GET /api/proxy/library/tracks?limit=…&offset=…
 *  Liked Songs via fetchLibraryTracks. */
export async function libraryTracksHandler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://_')
  const limit = clampInt(url.searchParams.get('limit'), 50, 1, 200)
  const offset = clampInt(url.searchParams.get('offset'), 0, 0, 100_000)
  const read = await loadCookies()
  if (!read) return error(res, 401, 'no cookies')
  try {
    const payload = await pathfinderQuery(
      read,
      'fetchLibraryTracks',
      fetchLibraryTracksVariables(limit, offset),
    )
    json(res, 200, payload)
  } catch (e) {
    error(res, 502, errMsg(e))
  }
}

/** GET /api/proxy/playlist/:id/items?limit=…&offset=…
 *  Tracks of a playlist via fetchPlaylist — works on editorial playlists.
 *  Mounted at the `/api/proxy/playlist` prefix; Connect strips that
 *  before calling us, so we parse `/:id/items` out of the leftover URL. */
export async function playlistTracksHandler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://_')
  const m = url.pathname.match(/^\/([^/]+)\/items$/)
  if (!m) return error(res, 404, 'expected /api/proxy/playlist/:id/items')
  const playlistId = decodeURIComponent(m[1])
  const limit = clampInt(url.searchParams.get('limit'), 100, 1, 500)
  const offset = clampInt(url.searchParams.get('offset'), 0, 0, 100_000)
  const read = await loadCookies()
  if (!read) return error(res, 401, 'no cookies')
  try {
    const payload = await pathfinderQuery(
      read,
      'fetchPlaylist',
      fetchPlaylistVariables(playlistId, limit, offset),
    )
    json(res, 200, payload)
  } catch (e) {
    error(res, 502, errMsg(e))
  }
}

// ---- connect-state writes ---------------------------------------------

/** Build a generic POST handler that pulls cookies, decodes a typed body,
 *  hands off to a connect-client method, and returns 204 / surfaces the
 *  Spotify error verbatim. */
function connectWriteHandler<T>(
  parseBody: (raw: unknown) => T | string,
  invoke: (read: CookieReadResult, body: T) => Promise<void>,
) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    let raw: unknown
    try {
      raw = await readJson(req)
    } catch (e) {
      return error(res, 400, `invalid JSON: ${errMsg(e)}`)
    }
    const parsed = parseBody(raw)
    if (typeof parsed === 'string') return error(res, 400, parsed)
    const read = await loadCookies()
    if (!read) return error(res, 401, 'no cookies')
    try {
      await invoke(read, parsed)
      noContent(res)
    } catch (e) {
      error(res, 502, errMsg(e))
    }
  }
}

export const connectPlayHandler = connectWriteHandler<{
  contextUri?: string
  offsetUri?: string
  uri?: string
  positionMs?: number
}>(
  (raw) => {
    const r = (raw ?? {}) as Record<string, unknown>
    const isOptStr = (v: unknown): v is string | undefined =>
      v === undefined || typeof v === 'string'
    const isOptNum = (v: unknown): v is number | undefined =>
      v === undefined || typeof v === 'number'
    if (
      !isOptStr(r.contextUri) ||
      !isOptStr(r.offsetUri) ||
      !isOptStr(r.uri) ||
      !isOptNum(r.positionMs)
    ) {
      return 'expected { contextUri?, offsetUri?, uri?, positionMs? }'
    }
    return {
      contextUri: r.contextUri,
      offsetUri: r.offsetUri,
      uri: r.uri,
      positionMs: r.positionMs,
    }
  },
  (read, args) => connectClient.play(read, args),
)

export const connectPauseHandler = connectWriteHandler<Record<never, never>>(
  () => ({}),
  (read) => connectClient.pause(read),
)

export const connectNextHandler = connectWriteHandler<Record<never, never>>(
  () => ({}),
  (read) => connectClient.next(read),
)

export const connectPrevHandler = connectWriteHandler<Record<never, never>>(
  () => ({}),
  (read) => connectClient.previous(read),
)

export const connectSeekHandler = connectWriteHandler<{ positionMs: number }>(
  (raw) => {
    const r = raw as Record<string, unknown>
    if (typeof r.positionMs !== 'number') return 'expected { positionMs: number }'
    return { positionMs: r.positionMs }
  },
  (read, { positionMs }) => connectClient.seek(read, positionMs),
)

export const connectVolumeHandler = connectWriteHandler<{ percent: number }>(
  (raw) => {
    const r = raw as Record<string, unknown>
    if (typeof r.percent !== 'number') return 'expected { percent: number }'
    return { percent: r.percent }
  },
  (read, { percent }) => connectClient.volume(read, percent),
)

export const connectShuffleHandler = connectWriteHandler<{ state: boolean }>(
  (raw) => {
    const r = raw as Record<string, unknown>
    if (typeof r.state !== 'boolean') return 'expected { state: boolean }'
    return { state: r.state }
  },
  (read, { state }) => connectClient.shuffle(read, state),
)

export const connectRepeatHandler = connectWriteHandler<{
  mode: 'off' | 'track' | 'context'
}>(
  (raw) => {
    const r = raw as Record<string, unknown>
    if (r.mode !== 'off' && r.mode !== 'track' && r.mode !== 'context') {
      return 'expected { mode: "off" | "track" | "context" }'
    }
    return { mode: r.mode }
  },
  (read, { mode }) => connectClient.repeat(read, mode),
)

export const connectQueueHandler = connectWriteHandler<{ uri: string }>(
  (raw) => {
    const r = raw as Record<string, unknown>
    if (typeof r.uri !== 'string' || r.uri.length === 0)
      return 'expected { uri: string }'
    return { uri: r.uri }
  },
  (read, { uri }) => connectClient.queueAdd(read, uri),
)

export const connectTransferHandler = connectWriteHandler<{
  deviceId: string
  play: boolean
}>(
  (raw) => {
    const r = raw as Record<string, unknown>
    if (typeof r.deviceId !== 'string' || r.deviceId.length === 0)
      return 'expected { deviceId: string, play?: boolean }'
    return { deviceId: r.deviceId, play: r.play === true }
  },
  (read, { deviceId, play }) => connectClient.transfer(read, deviceId, play),
)

/** GET /api/proxy/jam — current jam session (200 with payload), or 404
 *  body if the user isn't in one. Read-only; does NOT auto-create. */
export async function jamGetHandler(
  _req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const read = await loadCookies()
  if (!read) return error(res, 401, 'no cookies')
  try {
    const payload = await getCurrentSession(read)
    if (payload === null) {
      json(res, 404, { error: 'no active jam' })
      return
    }
    json(res, 200, payload)
  } catch (e) {
    error(res, 502, errMsg(e))
  }
}

/** POST /api/proxy/jam/start — create a new jam (or return the existing
 *  one if already in one). The user becomes the owner. */
export async function jamStartHandler(
  _req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const read = await loadCookies()
  if (!read) return error(res, 401, 'no cookies')
  try {
    const payload = await startSession(read)
    json(res, 200, payload)
  } catch (e) {
    error(res, 502, errMsg(e))
  }
}

/** POST /api/proxy/jam/leave  body: { sessionId } — end (if owner) or
 *  leave (if participant) the named jam session. */
export async function jamLeaveHandler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  let body: { sessionId?: unknown }
  try {
    body = (await readJson(req)) as { sessionId?: unknown }
  } catch (e) {
    return error(res, 400, `invalid JSON: ${errMsg(e)}`)
  }
  if (typeof body.sessionId !== 'string' || body.sessionId.length === 0) {
    return error(res, 400, 'expected { sessionId: string }')
  }
  const read = await loadCookies()
  if (!read) return error(res, 401, 'no cookies')
  try {
    await leaveSession(read, body.sessionId)
    noContent(res)
  } catch (e) {
    error(res, 502, errMsg(e))
  }
}

/** GET /api/proxy/state/raw — diagnostic. Returns the unmapped
 *  connect-state cluster alongside the mapped output, so we can audit
 *  field-shape drift between Spotify's `player_state.track` and
 *  `next_tracks[i]` without redeploying the SPA. */
export async function stateRawHandler(
  _req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const read = await loadCookies()
  if (!read) return error(res, 401, 'no cookies')
  try {
    const payload = await fetchRawCluster(read)
    json(res, 200, payload)
  } catch (e) {
    error(res, 502, errMsg(e))
  }
}

/** GET /api/proxy/state — single connect-state pull mapped to the public
 *  Web API shapes the SPA already consumes. Replaces three /v1 calls
 *  (`/me/player`, `/me/player/queue`, `/me/player/devices`) with one
 *  cookie-host call. Snapshot only — push notifications still arrive on
 *  /api/proxy/state/stream. */
export async function stateSnapshotHandler(
  _req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const read = await loadCookies()
  if (!read) return error(res, 401, 'no cookies')
  try {
    const snapshot = await fetchClusterSnapshot(read)
    json(res, 200, snapshot)
  } catch (e) {
    error(res, 502, errMsg(e))
  }
}

/** GET /api/me — cached /v1/me. Once successful, the result is cached in
 *  memory + ~/Library/Application Support/spotui/me.json so a restart
 *  doesn't re-hit /v1. On 429, returns 429 with Retry-After (in seconds)
 *  and skips retries for 60s, since hammering the rate-limited endpoint
 *  only makes the cooldown longer. */
export async function meHandler(
  _req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const read = await loadCookies()
  if (!read) return error(res, 401, 'no cookies')
  try {
    const profile = await getMe(read)
    json(res, 200, profile)
  } catch (e) {
    if (e instanceof MeRateLimitedError) {
      res.setHeader('Retry-After', String(Math.ceil(e.retryAfterMs / 1000)))
      return error(res, 429, 'api.spotify.com rate-limited /v1/me; try again shortly')
    }
    error(res, 502, errMsg(e))
  }
}

/** GET /api/proxy/friends
 *  Recent listening activity for the user's followed friends. Cookie-path
 *  only; no public Web API equivalent. */
export async function friendsHandler(
  _req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const read = await loadCookies()
  if (!read) return error(res, 401, 'no cookies')
  try {
    const payload = await fetchBuddylist(read)
    json(res, 200, payload)
  } catch (e) {
    error(res, 502, errMsg(e))
  }
}

/** GET /api/proxy/lyrics/:trackId
 *  Returns spclient color-lyrics payload, or 404 when Spotify has no
 *  lyrics for that track. Mounted at the `/api/proxy/lyrics` prefix. */
export async function lyricsHandler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://_')
  const m = url.pathname.match(/^\/([A-Za-z0-9]+)$/)
  if (!m) return error(res, 404, 'expected /api/proxy/lyrics/:trackId')
  const trackId = m[1]
  const read = await loadCookies()
  if (!read) return error(res, 401, 'no cookies')
  try {
    const payload = await fetchLyrics(read, trackId)
    json(res, 200, payload)
  } catch (e) {
    if (e instanceof LyricsNotFoundError) {
      json(res, 404, { error: 'no lyrics for this track' })
      return
    }
    error(res, 502, errMsg(e))
  }
}

/** GET /api/proxy/state/stream
 *  Server-Sent Events: emits a tick whenever Spotify pushes anything via
 *  dealer. SPA listens with EventSource and refetches state on each tick. */
export async function stateStreamHandler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  res.statusCode = 200
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  // Vite proxies dev requests through HTTP/1.1 with chunked encoding;
  // explicit flushHeaders() makes sure the response gets to the client
  // before the first event.
  res.flushHeaders?.()

  const dealer = getDealer()
  const send = (event: string, data: unknown): void => {
    if (res.writableEnded) return
    res.write(`event: ${event}\n`)
    res.write(`data: ${JSON.stringify(data)}\n\n`)
  }

  send('hello', { connected: dealer.isConnected() })

  const onEvent = (e: DealerEvent): void => {
    // Don't push pure transport noise (open/close/connection_id) to SPA;
    // SPA only needs the "refetch now" signal. Filter to actual content
    // messages.
    if (e.kind === 'message') {
      send('tick', { at: Date.now(), kind: e.kind })
    } else if (e.kind === 'open') {
      send('open', { at: Date.now() })
    } else if (e.kind === 'close') {
      send('close', { at: Date.now() })
    }
  }
  const unsubscribe = dealer.subscribe(onEvent)

  // Heartbeat comment every 20s to keep the browser from timing out the
  // SSE connection while idle.
  const heartbeat = setInterval(() => {
    if (res.writableEnded) return
    res.write(`: heartbeat\n\n`)
  }, 20_000)
  heartbeat.unref?.()

  const cleanup = (): void => {
    clearInterval(heartbeat)
    unsubscribe()
    if (!res.writableEnded) res.end()
  }
  req.on('close', cleanup)
  req.on('error', cleanup)
}

