/**
 * `/api/proxy/*` routes. The SPA calls these; the sidecar attaches cookie
 * auth and talks to Spotify's internal endpoints.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

import { discoverCookies, type CookieReadResult } from '../cookies/index.js'
import { hasSpDc } from '../cookies/types.js'
import { readFileCookies } from '../cookies/file.js'
import { getDealer, type DealerEvent } from '../spotify/dealer.js'
import { fetchLyrics, LyricsNotFoundError } from '../spotify/lyrics.js'
import {
  fetchLibraryTracksVariables,
  fetchPlaylistVariables,
  libraryV3Variables,
  pathfinderQuery,
  searchDesktopVariables,
} from '../spotify/pathfinder.js'

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

/** GET /api/proxy/library/playlists?limit=…&offset=…
 *  GET /api/proxy/library/albums?limit=…&offset=…
 *  Wraps libraryV3 with the filter set. */
function libraryHandler(filter: 'Playlists' | 'Albums') {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://_')
    const limit = clampInt(url.searchParams.get('limit'), 50, 1, 200)
    const offset = clampInt(url.searchParams.get('offset'), 0, 0, 100_000)
    const read = await loadCookies()
    if (!read) return error(res, 401, 'no cookies')
    try {
      const payload = await pathfinderQuery(
        read,
        'libraryV3',
        libraryV3Variables(filter, limit, offset),
      )
      json(res, 200, payload)
    } catch (e) {
      error(res, 502, errMsg(e))
    }
  }
}

export const libraryPlaylistsHandler = libraryHandler('Playlists')
export const libraryAlbumsHandler = libraryHandler('Albums')

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

// ---- helpers -----------------------------------------------------------

async function loadCookies(): Promise<CookieReadResult | null> {
  const persisted = await readFileCookies()
  if (hasSpDc(persisted)) return { cookies: persisted, source: 'file' }
  const { found } = await discoverCookies()
  return found
}

function clampInt(
  raw: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  if (typeof raw !== 'string') return fallback
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, n))
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(body))
}

function error(res: ServerResponse, status: number, message: string): void {
  json(res, status, { error: message })
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buf = chunk as Buffer
    chunks.push(buf)
    total += buf.length
    if (total > 1_000_000) throw new Error('request body too large')
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  if (raw.length === 0) return {}
  return JSON.parse(raw)
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
