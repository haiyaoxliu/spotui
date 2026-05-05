import { useEffect, useMemo, useRef, useState } from 'react'
import { useSelection } from '../store/selection'
import { useSearch } from '../store/search'
import { useUI, type SearchPosition, type SearchResultType } from '../store/ui'
import {
  play,
  type ArtistObject,
  type Playlist,
  type SimplifiedAlbum,
  type Track,
} from '../api/spotify'
import type { Refresh } from '../commands'

type Tab = 'tracks' | 'albums' | 'artists' | 'playlists'

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000)
  const m = Math.floor(s / 60)
  return `${m}:${String(s % 60).padStart(2, '0')}`
}

function formatDurationLong(ms: number): string {
  const secs = Math.floor(ms / 1000)
  const h = Math.floor(secs / 3600)
  const m = Math.floor((secs % 3600) / 60)
  return h > 0 ? `${h}h${String(m).padStart(2, '0')}m` : `${m}m`
}

export function SelectedPlaylist({
  onAfterPlay,
  searchPosition,
  ownerId,
}: {
  onAfterPlay: Refresh
  searchPosition: SearchPosition
  ownerId: string
}) {
  const kind = useSelection((s) => s.kind)
  const name = useSelection((s) => s.name)
  const contextUri = useSelection((s) => s.contextUri)
  const selectPlaylist = useSelection((s) => s.selectPlaylist)
  const selectAlbum = useSelection((s) => s.selectAlbum)
  const owner = useSelection((s) => s.owner)
  const trackCount = useSelection((s) => s.trackCount)
  const totalDurationMs = useSelection((s) => s.totalDurationMs)
  const minAddedAt = useSelection((s) => s.minAddedAt)
  const tracks = useSelection((s) => s.tracks)
  const loading = useSelection((s) => s.loading)
  const error = useSelection((s) => s.error)
  const canEditSelection = useSelection((s) => s.canEdit)

  const query = useSearch((s) => s.query)
  const setQuery = useSearch((s) => s.setQuery)
  const results = useSearch((s) => s.results)
  const searchLoading = useSearch((s) => s.loading)
  const searchError = useSearch((s) => s.error)

  const focusTick = useUI((s) => s.searchFocusTick)
  const focusedRow = useUI((s) => s.focusedRow)
  const setFocusedRow = useUI((s) => s.setFocusedRow)
  const detailLayout = useUI((s) => s.detailLayout)
  const inputRef = useRef<HTMLInputElement>(null)
  const [tab, setTab] = useState<Tab>('tracks')

  useEffect(() => {
    if (focusTick > 0) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [focusTick])

  // Local substring filter on the currently-loaded collection.
  const filteredTracks = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return tracks
    return tracks.filter(
      (t) =>
        t.name.toLowerCase().includes(q) ||
        t.artists.some((a) => a.name.toLowerCase().includes(q)),
    )
  }, [tracks, query])

  async function playFromCollection(uri: string) {
    try {
      if (contextUri) await play({ contextUri, offsetUri: uri })
      else await play({ uris: [uri] })
    } catch (e) {
      console.error('play track failed:', e)
    } finally {
      void onAfterPlay()
    }
  }

  async function playFromSearch(uri: string, kind: 'track' | 'context') {
    try {
      if (kind === 'track') await play({ uris: [uri] })
      else await play({ contextUri: uri })
    } catch (e) {
      console.error('play from search failed:', e)
    } finally {
      void onAfterPlay()
    }
  }

  const hasQuery = query.trim() !== ''
  const sTracks = results.tracks?.items ?? []
  const sAlbums = results.albums?.items ?? []
  const sArtists = results.artists?.items ?? []
  const sPlaylists = (results.playlists?.items ?? []).filter(
    (p): p is NonNullable<typeof p> => p !== null,
  )
  const counts: Record<Tab, number> = {
    tracks: sTracks.length,
    albums: sAlbums.length,
    artists: sArtists.length,
    playlists: sPlaylists.length,
  }

  const playlistSection = (
    <section className="flex flex-col overflow-hidden min-h-0" style={{ flex: 1 }}>
      {!kind ? (
        <div className="flex-1 flex items-center justify-center text-neutral-500 text-sm px-6 text-center">
          Select a playlist, Liked Songs, or Recently Played from the left.
        </div>
      ) : (
        <>
          <div
            className={
              'px-6 py-4 border-b border-neutral-800 ' +
              (detailLayout === 'right' ? 'flex items-baseline gap-3' : '')
            }
          >
            <h2
              className={
                'text-lg font-semibold truncate ' +
                (detailLayout === 'right' ? 'flex-1 min-w-0' : '')
              }
            >
              {name}
            </h2>
            <p
              className={
                'text-xs text-neutral-500 truncate ' +
                (detailLayout === 'right' ? 'text-right' : '')
              }
            >
              {(() => {
                if (loading) return 'loading…'
                const count = trackCount ?? tracks.length
                const parts: string[] = []
                if (owner) parts.push(`by ${owner}`)
                parts.push(
                  hasQuery
                    ? `${filteredTracks.length} of ${count} match`
                    : `${count} track${count === 1 ? '' : 's'}`,
                )
                if (totalDurationMs != null) parts.push(formatDurationLong(totalDurationMs))
                if (minAddedAt) parts.push(`since ${minAddedAt.slice(0, 7)}`)
                return parts.join(' · ')
              })()}
            </p>
          </div>
          {error && <p className="px-6 py-4 text-sm text-red-400">{error}</p>}
          {!loading && !error && filteredTracks.length === 0 && (
            <p className="px-6 py-4 text-sm text-neutral-500">
              {hasQuery
                ? 'No tracks match.'
                : kind === 'playlist' && !canEditSelection && tracks.length === 0
                  ? 'Externally owned — cannot show tracks due to API limitation.'
                  : 'No tracks.'}
            </p>
          )}
          {filteredTracks.length > 0 && (
            <ul className="overflow-auto flex-1 min-h-0">
              {filteredTracks.map((t, idx) => {
                const artists = t.artists.map((a) => a.name).join(', ')
                const isFocused =
                  focusedRow?.pane === 'playlist' && focusedRow.uri === t.uri
                return (
                  <li
                    key={`${t.id}-${idx}`}
                    onClick={() =>
                      setFocusedRow({ pane: 'playlist', uri: t.uri, isTrack: true })
                    }
                    onDoubleClick={() => void playFromCollection(t.uri)}
                    className={
                      'px-6 py-2 cursor-pointer flex items-center gap-3 border-b border-neutral-900 ' +
                      (isFocused ? 'bg-neutral-800' : 'hover:bg-neutral-800/60')
                    }
                  >
                    <span className="text-neutral-600 text-xs w-6 text-right tabular-nums">
                      {idx + 1}
                    </span>
                    {detailLayout === 'right' ? (
                      <>
                        <div className="flex-1 min-w-0 text-sm truncate">{t.name}</div>
                        <span className="text-xs text-neutral-400 truncate text-right max-w-[40%]">
                          {artists}
                        </span>
                      </>
                    ) : (
                      <div className="flex-1 min-w-0">
                        <div className="text-sm truncate">{t.name}</div>
                        <div className="text-xs text-neutral-400 truncate">{artists}</div>
                      </div>
                    )}
                    <span className="text-xs text-neutral-500 tabular-nums">
                      {formatDuration(t.duration_ms)}
                    </span>
                  </li>
                )
              })}
            </ul>
          )}
        </>
      )}
    </section>
  )

  const searchInput = (
    <div
      className={
        'p-3 flex-shrink-0 ' +
        (searchPosition === 'above' ? 'border-b' : 'border-t') +
        ' border-neutral-800'
      }
    >
      <input
        ref={inputRef}
        type="text"
        placeholder="Search…  (/)"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            if (query) setQuery('')
            else inputRef.current?.blur()
          }
        }}
        className="w-full px-3 py-2 rounded bg-neutral-800 border border-neutral-700 text-sm focus:outline-none focus:border-neutral-500"
      />
    </div>
  )

  const searchResults = hasQuery ? (
    <section
      className={
        'flex flex-col overflow-hidden min-h-0 ' +
        (searchPosition === 'above' ? 'border-b' : 'border-t') +
        ' border-neutral-800'
      }
      style={{ flex: 1 }}
    >
      <div className="flex flex-wrap flex-shrink-0 border-b border-neutral-800">
        {(['tracks', 'albums', 'artists', 'playlists'] as Tab[]).map((t) => {
          const active = tab === t
          const c = counts[t]
          return (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={
                'flex-1 min-w-[25%] px-4 py-1.5 text-[10px] uppercase tracking-wider text-center hover:bg-neutral-800 border-r border-neutral-800 last:border-r-0 ' +
                (active ? 'text-[var(--color-accent)]' : 'text-neutral-500')
              }
            >
              {t}
              {c > 0 && (
                <span className="ml-1 text-neutral-600 normal-case tracking-normal">
                  ({c})
                </span>
              )}
            </button>
          )
        })}
      </div>
      <div className="overflow-auto flex-1 min-h-0">
        {searchError && (
          <p className="px-4 py-2 text-sm text-red-400">{searchError}</p>
        )}
        {searchLoading && (
          <p className="px-4 py-2 text-sm text-neutral-500">Searching…</p>
        )}
        {!searchLoading && !searchError && (
          <>
            {tab === 'tracks' && (
              <ResultList
                items={sTracks}
                searchType="track"
                render={(t: Track) => ({
                  key: t.id,
                  uri: t.uri,
                  isTrack: true,
                  title: t.name,
                  subtitle: t.artists.map((a) => a.name).join(', '),
                  durationMs: t.duration_ms,
                  onPlay: () => void playFromSearch(t.uri, 'track'),
                })}
              />
            )}
            {tab === 'albums' && (
              <ResultList
                items={sAlbums}
                searchType="album"
                render={(a: SimplifiedAlbum) => ({
                  key: a.id,
                  uri: a.uri,
                  isTrack: false,
                  title: a.name,
                  subtitle: a.artists.map((x) => x.name).join(', '),
                  // Double-click loads the album into the playlist pane
                  // (browse first), matching what Enter does on the focused
                  // row. To play the album immediately, pick a track.
                  onPlay: () => void selectAlbum(a),
                })}
              />
            )}
            {tab === 'artists' && (
              <ResultList
                items={sArtists}
                searchType="artist"
                render={(a: ArtistObject) => ({
                  key: a.id,
                  uri: a.uri,
                  isTrack: false,
                  title: a.name,
                  subtitle: 'artist',
                  onPlay: () => void playFromSearch(a.uri, 'context'),
                })}
              />
            )}
            {tab === 'playlists' && (
              <ResultList
                items={sPlaylists}
                searchType="playlist"
                render={(p: Playlist) => ({
                  key: p.id,
                  uri: p.uri,
                  isTrack: false,
                  title: p.name,
                  subtitle: p.owner.display_name ?? '',
                  onPlay: () =>
                    void selectPlaylist(
                      p,
                      p.owner.id === ownerId || p.collaborative,
                      true,
                    ),
                })}
              />
            )}
          </>
        )}
      </div>
    </section>
  ) : null

  return (
    <div className="flex-1 flex flex-col overflow-hidden min-w-0">
      {searchPosition === 'above' ? (
        <>
          {searchInput}
          {searchResults}
          {playlistSection}
        </>
      ) : (
        // search: below — keep the input pinned at the bottom of the pane
        // and float the results above it so they read upward toward the
        // playlist listing.
        <>
          {playlistSection}
          {searchResults}
          {searchInput}
        </>
      )}
    </div>
  )
}

function ResultList<T>({
  items,
  searchType,
  render,
}: {
  items: T[]
  searchType: SearchResultType
  render: (item: T) => {
    key: string
    uri: string
    isTrack: boolean
    title: string
    subtitle: string
    durationMs?: number
    onPlay: () => void
  }
}) {
  const focusedRow = useUI((s) => s.focusedRow)
  const setFocusedRow = useUI((s) => s.setFocusedRow)
  const detailLayout = useUI((s) => s.detailLayout)
  if (items.length === 0) {
    return <p className="px-4 py-2 text-sm text-neutral-500">No results.</p>
  }
  return (
    <ul>
      {items.map((it) => {
        const r = render(it)
        const isFocused =
          focusedRow?.pane === 'search' && focusedRow.uri === r.uri
        return (
          <li
            key={r.key}
            onClick={() =>
              setFocusedRow({
                pane: 'search',
                uri: r.uri,
                isTrack: r.isTrack,
                searchType,
              })
            }
            onDoubleClick={r.onPlay}
            className={
              'px-4 py-2 cursor-pointer border-b border-neutral-900 ' +
              (isFocused ? 'bg-neutral-800' : 'hover:bg-neutral-800/60') +
              (detailLayout === 'right' ? ' flex items-center gap-3' : '')
            }
          >
            {detailLayout === 'right' ? (
              <>
                <div className="flex-1 min-w-0 text-sm truncate">{r.title}</div>
                {r.subtitle && (
                  <span className="text-xs text-neutral-500 truncate text-right max-w-[50%]">
                    {r.subtitle}
                  </span>
                )}
                {r.durationMs != null && (
                  <span className="text-xs text-neutral-500 tabular-nums">
                    {formatDuration(r.durationMs)}
                  </span>
                )}
              </>
            ) : (
              <>
                <div className="text-sm truncate">{r.title}</div>
                {r.subtitle && (
                  <div className="text-xs text-neutral-500 truncate">{r.subtitle}</div>
                )}
              </>
            )}
          </li>
        )
      })}
    </ul>
  )
}
