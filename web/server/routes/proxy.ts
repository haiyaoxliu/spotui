/**
 * `/api/proxy/*` routes. The SPA calls these; the sidecar attaches cookie
 * auth and talks to Spotify's internal endpoints.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

import { discoverCookies, type CookieReadResult } from '../cookies/index.js'
import { hasSpDc } from '../cookies/types.js'
import { readFileCookies } from '../cookies/file.js'
import {
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
