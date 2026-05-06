/**
 * Persisted-query SHA256 resolver for Spotify's Pathfinder GraphQL.
 *
 * Pathfinder requests carry `extensions={persistedQuery:{sha256Hash}}` —
 * the operation text isn't on the wire. The hashes change whenever Spotify
 * ships a new web bundle, so we re-resolve at runtime by scraping the
 * live web-player JS:
 *
 *   1. Fetch open.spotify.com → find the `<script src=".../web-player/...js">`.
 *   2. Fetch that bundle → regex `<op_name> ... sha256Hash:"..."` for each
 *      operation we need.
 *   3. If the hash isn't in the main bundle, parse webpack's chunk-name
 *      and chunk-hash maps, fetch each chunk, repeat.
 *
 * Direct port of `openclaw/spogo` `internal/spotify/connect_hash.go`. We
 * cache the result on disk by `clientVersion` so subsequent boots skip
 * the network parse.
 */

import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { _fetchText } from './session.js'

const CACHE_FILE = path.join(
  os.homedir(),
  'Library',
  'Caches',
  'spotui',
  'web-pathfinder-hashes.json',
)

interface CachedHashes {
  clientVersion: string
  byOperation: Record<string, string>
  savedAt: number
}

let memoryCache: CachedHashes | null = null

/** Resolve the SHA256 hash for an operation. Tries (in order): in-memory
 *  cache, on-disk cache (matching `clientVersion`), live JS scrape. */
export async function resolveHash(
  operation: string,
  clientVersion: string,
): Promise<string> {
  if (!operation) throw new Error('operation required')
  const hash = await tryLookup(operation, clientVersion)
  if (hash) return hash

  const found = await scrapeFromWebPlayer([operation])
  if (!found[operation]) {
    throw new Error(`hash for ${operation} not found in web-player bundles`)
  }
  await mergeIntoCache(clientVersion, found)
  return found[operation]
}

/** Bulk variant: resolve many at once. Used for warm-up. */
export async function resolveHashes(
  operations: string[],
  clientVersion: string,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  const need: string[] = []
  for (const op of operations) {
    const hit = await tryLookup(op, clientVersion)
    if (hit) out[op] = hit
    else need.push(op)
  }
  if (need.length === 0) return out

  const scraped = await scrapeFromWebPlayer(need)
  await mergeIntoCache(clientVersion, scraped)
  for (const [op, hash] of Object.entries(scraped)) out[op] = hash

  const missing = need.filter((op) => !scraped[op])
  if (missing.length > 0) {
    throw new Error(`hashes not found: ${missing.join(', ')}`)
  }
  return out
}

async function tryLookup(
  operation: string,
  clientVersion: string,
): Promise<string | null> {
  if (memoryCache && memoryCache.clientVersion === clientVersion) {
    const hit = memoryCache.byOperation[operation]
    if (hit) return hit
  }
  const disk = await readDiskCache()
  if (disk && disk.clientVersion === clientVersion) {
    memoryCache = disk
    const hit = disk.byOperation[operation]
    if (hit) return hit
  }
  return null
}

async function readDiskCache(): Promise<CachedHashes | null> {
  try {
    const body = await fs.readFile(CACHE_FILE, 'utf8')
    return JSON.parse(body) as CachedHashes
  } catch (e: unknown) {
    if (typeof e === 'object' && e && 'code' in e && (e as { code: string }).code === 'ENOENT') {
      return null
    }
    return null
  }
}

async function mergeIntoCache(
  clientVersion: string,
  fresh: Record<string, string>,
): Promise<void> {
  const base: CachedHashes =
    memoryCache && memoryCache.clientVersion === clientVersion
      ? memoryCache
      : { clientVersion, byOperation: {}, savedAt: 0 }
  const merged: CachedHashes = {
    clientVersion,
    byOperation: { ...base.byOperation, ...fresh },
    savedAt: Math.floor(Date.now() / 1000),
  }
  memoryCache = merged
  try {
    await fs.mkdir(path.dirname(CACHE_FILE), { recursive: true })
    await fs.writeFile(CACHE_FILE, JSON.stringify(merged, null, 2), {
      mode: 0o600,
    })
  } catch (e) {
    console.warn('[spotui] failed to persist hash cache:', e)
  }
}

// ---- scraping ----------------------------------------------------------

async function scrapeFromWebPlayer(
  ops: string[],
): Promise<Record<string, string>> {
  const html = await _fetchText('https://open.spotify.com/')
  const bundleURL = pickWebPlayerBundle(html)
  if (!bundleURL) throw new Error('web-player bundle URL not found in HTML')

  const main = await _fetchText(bundleURL)
  const found: Record<string, string> = findOperationHashes(main, ops)
  if (allFound(found, ops)) return found

  // Fall back to webpack chunks. Bundles get split, so the operation we
  // want might live in a separate JS chunk referenced by id+name+hash maps.
  const need = ops.filter((op) => !found[op])
  const baseURL = bundleBaseURL(bundleURL)
  const chunks = parseChunkUrls(main, baseURL)
  for (const chunkURL of chunks) {
    let body: string
    try {
      body = await _fetchText(chunkURL)
    } catch {
      continue
    }
    const more = findOperationHashes(body, need)
    Object.assign(found, more)
    if (allFound(found, ops)) return found
  }
  return found
}

const SCRIPT_SRC_RE = /<script[^>]+src="([^"]+)"/g

export function pickWebPlayerBundle(html: string): string | null {
  for (const m of html.matchAll(SCRIPT_SRC_RE)) {
    const src = m[1]
    if (
      src.endsWith('.js') &&
      (src.includes('/web-player/') || src.includes('/mobile-web-player/'))
    ) {
      return src
    }
  }
  return null
}

export function bundleBaseURL(bundleURL: string): string {
  const idx = bundleURL.lastIndexOf('/')
  if (idx < 0) return 'https://open.spotifycdn.com/cdn/build/web-player/'
  return bundleURL.slice(0, idx + 1)
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function findOperationHashes(
  body: string,
  ops: string[],
): Record<string, string> {
  const found: Record<string, string> = {}
  for (const op of ops) {
    if (!op) continue
    // Pattern A: `searchDesktop ... sha256Hash:"..."` within ~400 chars.
    const a = new RegExp(
      `${escapeRegex(op)}[\\s\\S]{0,400}?sha256Hash["']?\\s*:\\s*["']([a-f0-9]{64})["']`,
    )
    const ma = a.exec(body)
    if (ma) {
      found[op] = ma[1]
      continue
    }
    // Pattern B: `"searchDesktop","query","<hash>"` triple (tuple form some
    // webpack chunks use).
    const b = new RegExp(
      `"${escapeRegex(op)}"\\s*,\\s*"(?:query|mutation)"\\s*,\\s*"([a-f0-9]{64})"`,
    )
    const mb = b.exec(body)
    if (mb) {
      found[op] = mb[1]
    }
  }
  return found
}

const MAP_LITERAL_RE = /\{(?:\d+:"[^"]+",?)+\}/g
const NUM_KEY_RE = /(\d+):/g

export function parseChunkUrls(js: string, baseURL: string): string[] {
  const literals = js.match(MAP_LITERAL_RE) ?? []
  const candidateMaps: Map<number, string>[] = []
  for (const raw of literals) {
    const parsed = parseMapLiteral(raw)
    if (parsed && parsed.size > 0) candidateMaps.push(parsed)
  }
  if (candidateMaps.length < 2) return []

  // Score each candidate: a map is the "hash map" if its values look like
  // 6-12-char hex strings; the "name map" if its values contain `-` or `/`.
  const hashMaps = candidateMaps
    .map((m) => ({ map: m, score: scoreHashMap(m) }))
    .filter((x) => x.score > 0.4)
    .sort((a, b) => b.score - a.score)
  const nameMaps = candidateMaps
    .map((m) => ({ map: m, score: scoreNameMap(m) }))
    .filter((x) => x.score > 0.4)
    .sort((a, b) => b.score - a.score)

  if (hashMaps.length === 0 || nameMaps.length === 0) return []
  const hashes = hashMaps[0].map
  const names = nameMaps[0].map

  const out: string[] = []
  const keys = Array.from(names.keys()).sort((a, b) => a - b)
  for (const k of keys) {
    const name = names.get(k)
    const hash = hashes.get(k)
    if (!name || !hash) continue
    out.push(`${baseURL}${name}.${hash}.js`)
  }
  return out
}

function parseMapLiteral(raw: string): Map<number, string> | null {
  // Convert `{12:"foo",34:"bar"}` to valid JSON `{"12":"foo","34":"bar"}`.
  const json = raw.replace(NUM_KEY_RE, '"$1":')
  let parsed: Record<string, string>
  try {
    parsed = JSON.parse(json) as Record<string, string>
  } catch {
    return null
  }
  const out = new Map<number, string>()
  for (const [k, v] of Object.entries(parsed)) {
    const n = Number.parseInt(k, 10)
    if (Number.isFinite(n) && typeof v === 'string') out.set(n, v)
  }
  return out
}

function scoreHashMap(m: Map<number, string>): number {
  if (m.size === 0) return 0
  let hits = 0
  for (const v of m.values()) {
    if (/^[0-9a-f]{6,12}$/i.test(v)) hits++
  }
  return hits / m.size
}

function scoreNameMap(m: Map<number, string>): number {
  if (m.size === 0) return 0
  let hits = 0
  for (const v of m.values()) {
    if (v.includes('-') || v.includes('/')) hits++
  }
  return hits / m.size
}

function allFound(found: Record<string, string>, ops: string[]): boolean {
  for (const op of ops) if (!found[op]) return false
  return true
}
