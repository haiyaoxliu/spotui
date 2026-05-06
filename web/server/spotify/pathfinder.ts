/**
 * Pathfinder GraphQL client. POSTs persisted-query operations against
 * `api-partner.spotify.com/pathfinder/v1/query`.
 *
 * Direct port of `openclaw/spogo` `internal/spotify/connect_pathfinder.go`.
 *
 * Persisted-query semantics:
 *   - Variables go in the query string as JSON.
 *   - The operation text isn't sent; we send `extensions={persistedQuery:{
 *     version:1, sha256Hash}}` instead. Hash is resolved at runtime by
 *     `./hash.ts`.
 *   - Despite "POST", the body is empty — Spotify reads everything from the
 *     query string.
 */

import type { CookieReadResult } from '../cookies/index.js'
import { resolveHash } from './hash.js'
import { getSessionAuth, type SessionAuth } from './session.js'

const PATHFINDER_URL = 'https://api-partner.spotify.com/pathfinder/v1/query'
const SEC_CH_UA =
  '"Chromium";v="131", "Not_A Brand";v="24", "Google Chrome";v="131"'

export interface PathfinderResponse {
  data?: unknown
  errors?: PathfinderError[]
  extensions?: unknown
}

interface PathfinderError {
  message?: string
  path?: unknown
  extensions?: unknown
}

/**
 * Run a persisted query. Throws on transport errors and on Pathfinder
 * `errors[]` (caller can `.catch` and downgrade to a fallback).
 */
export async function pathfinderQuery(
  read: CookieReadResult,
  operation: string,
  variables: Record<string, unknown>,
): Promise<PathfinderResponse> {
  const auth = await getSessionAuth(read)
  const hash = await resolveHash(operation, auth.clientVersion)
  const url = buildUrl(operation, variables, hash)

  const res = await fetch(url, {
    method: 'POST',
    headers: pathfinderHeaders(auth),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`pathfinder ${operation} ${res.status}: ${truncate(body)}`)
  }
  const payload = (await res.json()) as PathfinderResponse
  if (payload.errors && payload.errors.length > 0) {
    const first = payload.errors[0]
    throw new Error(
      `pathfinder ${operation}: ${first.message ?? 'unknown error'}`,
    )
  }
  return payload
}

function buildUrl(
  operation: string,
  variables: Record<string, unknown>,
  hash: string,
): string {
  const params = new URLSearchParams()
  params.set('operationName', operation)
  params.set('variables', JSON.stringify(variables ?? {}))
  params.set(
    'extensions',
    JSON.stringify({ persistedQuery: { version: 1, sha256Hash: hash } }),
  )
  return `${PATHFINDER_URL}?${params.toString()}`
}

function pathfinderHeaders(auth: SessionAuth): Record<string, string> {
  return {
    Accept: 'application/json',
    Authorization: `Bearer ${auth.accessToken}`,
    'client-token': auth.clientToken,
    'app-platform': 'WebPlayer',
    'spotify-app-version': auth.clientVersion,
    'Accept-Language': 'en',
    Origin: 'https://open.spotify.com',
    Referer: 'https://open.spotify.com/',
    'Sec-Fetch-Site': 'same-site',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Dest': 'empty',
    'Sec-CH-UA': SEC_CH_UA,
    'Sec-CH-UA-Platform': '"macOS"',
    'Sec-CH-UA-Mobile': '?0',
  }
}

function truncate(s: string): string {
  return s.length > 400 ? `${s.slice(0, 400)}...` : s
}

// ---- variable builders for the operations we use ----------------------

export function searchDesktopVariables(
  query: string,
  limit: number,
  offset: number,
): Record<string, unknown> {
  return {
    searchTerm: query,
    offset,
    limit,
    numberOfTopResults: 5,
    includeAudiobooks: true,
    includePreReleases: true,
    includeLocalConcertsField: false,
    includeArtistHasConcertsField: false,
  }
}
