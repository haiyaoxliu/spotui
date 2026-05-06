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
import { truncate } from '../util/truncate.js'
import { resolveHash } from './hash.js'
import { webPlayerHeaders } from './headers.js'
import { getSessionAuth, type SessionAuth } from './session.js'

const PATHFINDER_URL = 'https://api-partner.spotify.com/pathfinder/v1/query'

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
    throw new Error(`pathfinder ${operation} ${res.status}: ${truncate(body, 400)}`)
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
    ...webPlayerHeaders(auth, { fetchSite: 'same-site' }),
    'Accept-Language': 'en',
  }
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

/** Saved playlists / saved albums. Filter is `Playlists` or `Albums`.
 *  Variables match spogo's `libraryV3Variables`. `expandedFolders` lets the
 *  caller request the contents of named folder URIs at depth+1. */
export function libraryV3Variables(
  filter: 'Playlists' | 'Albums',
  limit: number,
  offset: number,
  expandedFolders: string[] = [],
): Record<string, unknown> {
  return {
    filters: [filter],
    order: null,
    textFilter: '',
    features: ['LIKED_SONGS', 'YOUR_EPISODES'],
    limit,
    offset,
    flatten: false,
    expandedFolders,
    folderUri: null,
    includeFoldersWhenFlattening: true,
    withCuration: false,
  }
}

/** Saved tracks (Liked Songs). Different operation from libraryV3. */
export function fetchLibraryTracksVariables(
  limit: number,
  offset: number,
): Record<string, unknown> {
  return {
    uri: 'spotify:collection:tracks',
    offset,
    limit,
  }
}

/** Tracks of a specific playlist by id. Editorial playlists work here. */
export function fetchPlaylistVariables(
  playlistId: string,
  limit: number,
  offset: number,
): Record<string, unknown> {
  return {
    uri: `spotify:playlist:${playlistId}`,
    offset,
    limit,
    enableWatchFeedEntrypoint: false,
  }
}
