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
  Playlist,
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
  duration?: { totalMilliseconds?: number }
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
  return {
    id,
    name: t.name,
    uri: t.uri,
    duration_ms: t.duration?.totalMilliseconds ?? 0,
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
