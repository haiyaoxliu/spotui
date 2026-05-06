/**
 * SPA-side client for the cookie-auth Pathfinder proxy. Calls the local
 * sidecar at `/api/proxy/*` and adapts Pathfinder's GraphQL response shape
 * back into the same `SearchResults` shape the components already consume.
 *
 * The adapter is deliberately permissive: Spotify's GraphQL response
 * fields can be `null` when an item is unavailable, and we drop those
 * silently rather than failing the whole search. Each helper is its own
 * function so we can extend per-tab without touching the others.
 */

import type {
  ArtistObject,
  Episode,
  PageSlice,
  Playlist,
  PlaylistItem,
  SavedTrack,
  SearchResults,
  SearchTab,
  SimplifiedAlbum,
  SpotifyImage,
  Track,
} from './spotify'

interface PathfinderEnvelope {
  data?: {
    searchV2?: PathfinderSearchV2
  }
  errors?: { message?: string }[]
}

interface PathfinderSearchV2 {
  tracksV2?: { items?: TrackHit[]; totalCount?: number }
  albumsV2?: { items?: AlbumHit[]; totalCount?: number }
  artists?: { items?: ArtistHit[]; totalCount?: number }
  playlists?: { items?: PlaylistHit[]; totalCount?: number }
}

interface TrackHit {
  item?: { data?: PfTrack | null } | null
}
interface AlbumHit {
  data?: PfAlbum | null
}
interface ArtistHit {
  data?: PfArtist | null
}
interface PlaylistHit {
  data?: PfPlaylist | null
}

interface PfImageSource {
  url?: string
  width?: number | null
  height?: number | null
}
interface PfCoverArt {
  sources?: PfImageSource[] | null
}
interface PfArtistsContainer {
  items?: { uri?: string; profile?: { name?: string } }[] | null
}

interface PfTrack {
  id?: string
  uri?: string
  name?: string
  // search & library responses use `duration`; fetchPlaylist responses
  // use `trackDuration` for the same field. We accept either.
  duration?: { totalMilliseconds?: number }
  trackDuration?: { totalMilliseconds?: number }
  artists?: PfArtistsContainer
  albumOfTrack?: {
    id?: string
    uri?: string
    name?: string
    coverArt?: PfCoverArt
  } | null
}

interface PfAlbum {
  uri?: string
  name?: string
  type?: string
  date?: { year?: number | string; month?: number | string; day?: number | string }
  artists?: PfArtistsContainer
  coverArt?: PfCoverArt
}

interface PfArtist {
  uri?: string
  profile?: { name?: string }
  visuals?: { avatarImage?: { sources?: PfImageSource[] } | null } | null
}

interface PfPlaylist {
  uri?: string
  name?: string
  description?: string
  images?: { items?: { sources?: PfImageSource[] }[] } | null
  ownerV2?: {
    data?: { username?: string; displayName?: string; uri?: string }
  } | null
}

const PROXY_SEARCH_URL = '/api/proxy/search'

/** Fetch search results via Pathfinder. Throws on transport / sidecar errors;
 *  callers should catch and fall back to the public Web API. */
export async function searchViaPathfinder(
  q: string,
  limit = 10,
  offset = 0,
): Promise<SearchResults> {
  const params = new URLSearchParams({
    q,
    limit: String(limit),
    offset: String(offset),
  })
  const res = await fetch(`${PROXY_SEARCH_URL}?${params.toString()}`)
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`pathfinder search ${res.status}: ${truncate(text)}`)
  }
  const envelope = (await res.json()) as PathfinderEnvelope
  if (envelope.errors && envelope.errors.length > 0) {
    throw new Error(envelope.errors[0].message ?? 'pathfinder error')
  }
  return adaptSearchV2(envelope.data?.searchV2)
}

/** Synthetic next-URL form so the existing `searchMore` wiring keeps working.
 *  Encodes the query + tab + offset as a relative URL the sidecar can read. */
export function buildPathfinderNextUrl(
  q: string,
  tab: SearchTab,
  nextOffset: number,
  limit = 10,
): string {
  const params = new URLSearchParams({
    q,
    tab,
    offset: String(nextOffset),
    limit: String(limit),
  })
  return `pathfinder:search?${params.toString()}`
}

export function isPathfinderNextUrl(url: string): boolean {
  return url.startsWith('pathfinder:search?')
}

export async function searchMoreViaPathfinder(
  url: string,
): Promise<{ tab: SearchTab; slice: NonNullable<SearchResults[SearchTab]> } | null> {
  if (!isPathfinderNextUrl(url)) return null
  const params = new URLSearchParams(url.slice('pathfinder:search?'.length))
  const q = params.get('q') ?? ''
  const tab = (params.get('tab') ?? 'tracks') as SearchTab
  const offset = Number.parseInt(params.get('offset') ?? '0', 10)
  const limit = Number.parseInt(params.get('limit') ?? '10', 10)
  if (!q) return null

  const results = await searchViaPathfinder(q, limit, offset)
  const slice = results[tab]
  if (!slice) return null

  // Synthesize the *next* page's URL if more results remain. Without this
  // the store's loadMore would fire once and stop, capping pagination at
  // the second page (offset+limit, i.e. 20 with the default limit=10).
  const fetched = slice.items.length
  const nextOffset = offset + fetched
  const sliceWithNext = {
    ...slice,
    next:
      fetched > 0 && nextOffset < slice.total
        ? buildPathfinderNextUrl(q, tab, nextOffset, limit)
        : null,
  } as NonNullable<SearchResults[SearchTab]>

  return { tab, slice: sliceWithNext }
}

function adaptSearchV2(sv: PathfinderSearchV2 | undefined): SearchResults {
  if (!sv) return {}
  const out: SearchResults = {}
  if (sv.tracksV2) out.tracks = adaptTracks(sv.tracksV2)
  if (sv.albumsV2) out.albums = adaptAlbums(sv.albumsV2)
  if (sv.artists) out.artists = adaptArtists(sv.artists)
  if (sv.playlists) out.playlists = adaptPlaylists(sv.playlists)
  return out
}

function adaptTracks(
  page: NonNullable<PathfinderSearchV2['tracksV2']>,
): NonNullable<SearchResults['tracks']> {
  const items: Track[] = []
  for (const hit of page.items ?? []) {
    const t = hit.item?.data
    if (!t) continue
    const mapped = mapTrack(t)
    if (mapped) items.push(mapped)
  }
  return { items, total: page.totalCount ?? items.length }
}

function adaptAlbums(
  page: NonNullable<PathfinderSearchV2['albumsV2']>,
): NonNullable<SearchResults['albums']> {
  const items: SimplifiedAlbum[] = []
  for (const hit of page.items ?? []) {
    const mapped = mapAlbum(hit.data)
    if (mapped) items.push(mapped)
  }
  return { items, total: page.totalCount ?? items.length }
}

function adaptArtists(
  page: NonNullable<PathfinderSearchV2['artists']>,
): NonNullable<SearchResults['artists']> {
  const items: ArtistObject[] = []
  for (const hit of page.items ?? []) {
    const mapped = mapArtist(hit.data)
    if (mapped) items.push(mapped)
  }
  return { items, total: page.totalCount ?? items.length }
}

function adaptPlaylists(
  page: NonNullable<PathfinderSearchV2['playlists']>,
): NonNullable<SearchResults['playlists']> {
  // Playlist items can be null in the legacy public-API shape; preserve
  // that nullability for the existing component code.
  const items: (Playlist | null)[] = []
  for (const hit of page.items ?? []) {
    items.push(mapPlaylist(hit.data))
  }
  return { items, total: page.totalCount ?? items.length }
}

// ---- per-entity mappers ------------------------------------------------

function idFromUri(uri: string | undefined): string {
  if (!uri) return ''
  const parts = uri.split(':')
  return parts[parts.length - 1] ?? ''
}

function mapImages(sources: PfImageSource[] | undefined | null): SpotifyImage[] {
  if (!sources) return []
  return sources
    .filter((s): s is PfImageSource & { url: string } => typeof s.url === 'string')
    .map((s) => ({
      url: s.url,
      width: typeof s.width === 'number' ? s.width : null,
      height: typeof s.height === 'number' ? s.height : null,
    }))
}

function mapArtistsContainer(c: PfArtistsContainer | undefined): {
  id: string
  name: string
  uri: string
}[] {
  if (!c?.items) return []
  return c.items.flatMap((a) => {
    if (!a.uri || !a.profile?.name) return []
    return [{ id: idFromUri(a.uri), name: a.profile.name, uri: a.uri }]
  })
}

function mapTrack(t: PfTrack): Track | null {
  if (!t.uri || !t.name) return null
  const id = t.id ?? idFromUri(t.uri)
  const album = t.albumOfTrack
  const durationMs =
    t.duration?.totalMilliseconds ??
    t.trackDuration?.totalMilliseconds ??
    0
  return {
    id,
    name: t.name,
    uri: t.uri,
    duration_ms: durationMs,
    artists: mapArtistsContainer(t.artists),
    album: {
      id: album?.id ?? idFromUri(album?.uri ?? ''),
      name: album?.name ?? '',
      uri: album?.uri ?? '',
      images: mapImages(album?.coverArt?.sources),
    },
    type: 'track',
  }
}

function mapAlbum(a: PfAlbum | null | undefined): SimplifiedAlbum | null {
  if (!a?.uri || !a.name) return null
  return {
    id: idFromUri(a.uri),
    name: a.name,
    uri: a.uri,
    album_type: (a.type ?? 'album').toLowerCase(),
    artists: mapArtistsContainer(a.artists),
    images: mapImages(a.coverArt?.sources),
    release_date: formatReleaseDate(a.date),
    total_tracks: 0, // Not exposed on AlbumResponseWrapper; left at 0.
  }
}

function mapArtist(a: PfArtist | null | undefined): ArtistObject | null {
  if (!a?.uri || !a.profile?.name) return null
  return {
    id: idFromUri(a.uri),
    name: a.profile.name,
    uri: a.uri,
    images: mapImages(a.visuals?.avatarImage?.sources),
  }
}

function mapPlaylist(p: PfPlaylist | null | undefined): Playlist | null {
  if (!p?.uri || !p.name) return null
  const sources = p.images?.items?.[0]?.sources
  return {
    id: idFromUri(p.uri),
    name: p.name,
    uri: p.uri,
    description: p.description ?? null,
    items: { total: 0, href: '' },
    images: mapImages(sources),
    owner: {
      id: idFromUri(p.ownerV2?.data?.uri ?? ''),
      display_name: p.ownerV2?.data?.displayName ?? p.ownerV2?.data?.username,
    },
    collaborative: false,
    public: null,
  }
}

function formatReleaseDate(
  d: PfAlbum['date'] | undefined,
): string {
  if (!d) return ''
  const year = d.year != null ? String(d.year) : ''
  if (!year) return ''
  const month = d.month != null ? String(d.month).padStart(2, '0') : ''
  const day = d.day != null ? String(d.day).padStart(2, '0') : ''
  if (month && day) return `${year}-${month}-${day}`
  if (month) return `${year}-${month}`
  return year
}

function truncate(s: string): string {
  return s.length > 200 ? `${s.slice(0, 200)}...` : s
}

// ============================================================
// Library reads (libraryV3 / fetchLibraryTracks / fetchPlaylist)
// ============================================================

/** Try to satisfy a paged-API path via Pathfinder. Returns null if the path
 *  isn't one we know how to route — caller should fall back to public API. */
export async function fetchPageViaPathfinder<T>(
  path: string,
): Promise<PageSlice<T> | null> {
  const m = matchPagedPath(path)
  if (!m) return null
  switch (m.kind) {
    case 'me-playlists': {
      const slice = await libraryPlaylistsViaPathfinder(m.limit, m.offset)
      return slice as unknown as PageSlice<T>
    }
    case 'me-tracks': {
      const slice = await libraryTracksViaPathfinder(m.limit, m.offset)
      return slice as unknown as PageSlice<T>
    }
    case 'playlist-items': {
      const slice = await playlistTracksViaPathfinder(
        m.playlistId,
        m.limit,
        m.offset,
      )
      return slice as unknown as PageSlice<T>
    }
  }
}

type PagedPathMatch =
  | { kind: 'me-playlists'; limit: number; offset: number }
  | { kind: 'me-tracks'; limit: number; offset: number }
  | { kind: 'playlist-items'; playlistId: string; limit: number; offset: number }

function matchPagedPath(path: string): PagedPathMatch | null {
  const u = new URL(path, 'http://_')
  const limit = clampInt(u.searchParams.get('limit'), 50, 1, 200)
  const offset = clampInt(u.searchParams.get('offset'), 0, 0, 100_000)
  // /me/playlists or /me/tracks
  if (u.pathname === '/me/playlists') return { kind: 'me-playlists', limit, offset }
  if (u.pathname === '/me/tracks') return { kind: 'me-tracks', limit, offset }
  // /playlists/{id}/items
  const pm = u.pathname.match(/^\/playlists\/([^/]+)\/items$/)
  if (pm) {
    return {
      kind: 'playlist-items',
      playlistId: pm[1],
      limit: clampInt(u.searchParams.get('limit'), 100, 1, 500),
      offset,
    }
  }
  return null
}

function clampInt(
  raw: string | null,
  fallback: number,
  min: number,
  max: number,
): number {
  if (!raw) return fallback
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, n))
}

function nextPath(
  basePath: string,
  fetched: number,
  offset: number,
  total: number,
  limit: number,
): string | null {
  if (fetched <= 0 || offset + fetched >= total) return null
  const u = new URL(basePath, 'http://_')
  u.searchParams.set('limit', String(limit))
  u.searchParams.set('offset', String(offset + fetched))
  return `${u.pathname}?${u.searchParams.toString()}`
}

// ---- libraryV3 (Playlists) ---------------------------------------------

interface LibraryV3Page {
  totalCount?: number
  items?: LibraryV3Item[]
}

interface LibraryV3Item {
  addedAt?: { isoString?: string }
  pinned?: boolean
  depth?: number
  item?: {
    _uri?: string
    data?: LibraryV3ItemData
  }
}

interface LibraryV3ItemData {
  __typename?: string // 'Playlist' | 'PseudoPlaylist' | 'Album' | 'Folder'
  uri?: string
  name?: string
  count?: number
  image?: {
    sources?: PfImageSource[]
  } | null
  // Folder-only fields:
  playlistCount?: number
  folderCount?: number
}

/** Discriminated union covering everything libraryV3 can hand back when
 *  filter=Playlists. The library panel uses this to render the folder
 *  hierarchy; `playlists`-only consumers (legacy fetchPage callers) get
 *  a filtered Playlist[] view. */
export type LibraryEntry =
  | {
      kind: 'playlist'
      depth: number
      pinned: boolean
      playlist: Playlist
    }
  | {
      kind: 'folder'
      depth: number
      uri: string
      name: string
      playlistCount: number
      folderCount: number
    }

export interface LibraryEntriesResult {
  entries: LibraryEntry[]
  total: number
  nextPath: string | null
}

/** Folder-aware library fetcher. Pass currently-expanded folder URIs and
 *  Spotify will inline their children at depth+1. Used by the library
 *  store; the legacy fetchPage(/me/playlists) interceptor below still
 *  works for code that just wants Playlist[]. */
export async function fetchLibraryEntries(opts: {
  limit?: number
  offset?: number
  expandedFolders?: string[]
} = {}): Promise<LibraryEntriesResult> {
  const limit = opts.limit ?? 200
  const offset = opts.offset ?? 0
  const expanded = opts.expandedFolders ?? []
  const params = new URLSearchParams({
    limit: String(limit),
    offset: String(offset),
  })
  if (expanded.length > 0) params.set('expanded', expanded.join(','))
  const res = await fetch(`/api/proxy/library/playlists?${params}`)
  if (!res.ok) throw new Error(`library playlists ${res.status}`)
  const env = (await res.json()) as { data?: { me?: { libraryV3?: LibraryV3Page } } }
  const page = env.data?.me?.libraryV3
  const entries = (page?.items ?? []).flatMap((it) => {
    const mapped = mapLibraryEntry(it)
    return mapped ? [mapped] : []
  })
  const total = page?.totalCount ?? entries.length
  return {
    entries,
    total,
    nextPath: nextPath('/me/playlists', entries.length, offset, total, limit),
  }
}

async function libraryPlaylistsViaPathfinder(
  limit: number,
  offset: number,
): Promise<PageSlice<Playlist>> {
  const result = await fetchLibraryEntries({ limit, offset })
  const items = result.entries.flatMap((e) =>
    e.kind === 'playlist' ? [e.playlist] : [],
  )
  return { items, nextPath: result.nextPath, total: result.total }
}

function mapLibraryEntry(it: LibraryV3Item): LibraryEntry | null {
  const data = it.item?.data
  if (!data) return null
  // Skip PseudoPlaylist (Liked Songs) — it's rendered as a hardcoded
  // sidebar entry that calls selectLiked() instead of going through the
  // playlist-row path.
  if (data.__typename === 'PseudoPlaylist') return null
  const depth = typeof it.depth === 'number' ? it.depth : 0
  if (data.__typename === 'Folder') {
    if (!data.uri || !data.name) return null
    return {
      kind: 'folder',
      depth,
      uri: data.uri,
      name: data.name,
      playlistCount: data.playlistCount ?? 0,
      folderCount: data.folderCount ?? 0,
    }
  }
  if (!data.uri || !data.name) return null
  return {
    kind: 'playlist',
    depth,
    pinned: !!it.pinned,
    playlist: {
      id: idFromUri(data.uri),
      name: data.name,
      uri: data.uri,
      description: null,
      items: { total: data.count ?? 0, href: '' },
      images: mapImages(data.image?.sources),
      // libraryV3 doesn't expose owner; LibraryPanel.canEdit treats empty
      // owner.id as "unknown — assume editable". The real owner gets
      // filled in lazily when fetchPlaylist runs on click.
      owner: { id: '' },
      collaborative: false,
      public: null,
    },
  }
}

// ---- fetchLibraryTracks (Liked Songs) ----------------------------------

interface LibraryTracksPage {
  totalCount?: number
  items?: LibraryTrackItem[]
}

interface LibraryTrackItem {
  addedAt?: { isoString?: string } | string
  track?: {
    _uri?: string
    data?: PfTrack
  }
}

async function libraryTracksViaPathfinder(
  limit: number,
  offset: number,
): Promise<PageSlice<SavedTrack>> {
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset) })
  const res = await fetch(`/api/proxy/library/tracks?${params}`)
  if (!res.ok) throw new Error(`library tracks ${res.status}`)
  const env = (await res.json()) as {
    data?: { me?: { library?: { tracks?: LibraryTracksPage } } }
  }
  const page = env.data?.me?.library?.tracks
  const items = (page?.items ?? []).flatMap((it) => {
    const mapped = mapSavedTrack(it)
    return mapped ? [mapped] : []
  })
  const total = page?.totalCount ?? items.length
  return {
    items,
    nextPath: nextPath('/me/tracks', items.length, offset, total, limit),
    total,
  }
}

function mapSavedTrack(it: LibraryTrackItem): SavedTrack | null {
  const wrapper = it.track
  const data = wrapper?.data
  if (!wrapper || !data) return null
  const uri = wrapper._uri ?? data.uri
  if (!uri) return null
  const track = mapTrack({ ...data, uri })
  if (!track) return null
  return {
    added_at:
      typeof it.addedAt === 'string'
        ? it.addedAt
        : (it.addedAt?.isoString ?? ''),
    track,
  }
}

// ---- fetchPlaylist (playlist tracks) -----------------------------------

interface PlaylistV2 {
  name?: string
  content?: PlaylistContentPage
}

interface PlaylistContentPage {
  totalCount?: number
  items?: PlaylistContentItem[]
}

interface PlaylistContentItem {
  addedAt?: { isoString?: string } | string
  uid?: string
  itemV2?: {
    _uri?: string
    data?: PfTrack | PfEpisodePartial
  }
}

interface PfEpisodePartial {
  __typename?: string
  uri?: string
  name?: string
  duration?: { totalMilliseconds?: number }
}

async function playlistTracksViaPathfinder(
  playlistId: string,
  limit: number,
  offset: number,
): Promise<PageSlice<PlaylistItem>> {
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset) })
  const res = await fetch(
    `/api/proxy/playlist/${encodeURIComponent(playlistId)}/items?${params}`,
  )
  if (!res.ok) throw new Error(`playlist items ${res.status}`)
  const env = (await res.json()) as { data?: { playlistV2?: PlaylistV2 } }
  const pl = env.data?.playlistV2
  const items = (pl?.content?.items ?? []).flatMap((it) => {
    const mapped = mapPlaylistItem(it)
    return mapped ? [mapped] : []
  })
  const total = pl?.content?.totalCount ?? items.length
  return {
    items,
    nextPath: nextPath(
      `/playlists/${playlistId}/items`,
      items.length,
      offset,
      total,
      limit,
    ),
    total,
  }
}

function mapPlaylistItem(it: PlaylistContentItem): PlaylistItem | null {
  const wrapper = it.itemV2
  const data = wrapper?.data
  if (!wrapper || !data) return null
  const uri = wrapper._uri ?? data.uri
  if (!uri) return null
  const typename = (data as { __typename?: string }).__typename
  let item: Track | Episode | null = null
  if (typename === 'Episode') {
    item = mapEpisode(data as PfEpisodePartial)
  } else {
    item = mapTrack({ ...(data as PfTrack), uri })
  }
  if (!item) return null
  return {
    added_at:
      typeof it.addedAt === 'string'
        ? it.addedAt
        : (it.addedAt?.isoString ?? ''),
    item,
  }
}

function mapEpisode(e: PfEpisodePartial): Episode | null {
  if (!e.uri || !e.name) return null
  return {
    id: idFromUri(e.uri),
    name: e.name,
    uri: e.uri,
    duration_ms: e.duration?.totalMilliseconds ?? 0,
    type: 'episode',
  }
}
