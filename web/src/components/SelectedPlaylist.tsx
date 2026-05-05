import { useEffect, useMemo, useRef, useState } from 'react'
import { useSelection } from '../store/selection'
import { useSearch } from '../store/search'
import { useUI, type SearchPosition } from '../store/ui'
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

export function SelectedPlaylist({
  onAfterPlay,
  searchPosition,
}: {
  onAfterPlay: Refresh
  searchPosition: SearchPosition
}) {
  const kind = useSelection((s) => s.kind)
  const name = useSelection((s) => s.name)
  const contextUri = useSelection((s) => s.contextUri)
  const tracks = useSelection((s) => s.tracks)
  const loading = useSelection((s) => s.loading)
  const error = useSelection((s) => s.error)

  const query = useSearch((s) => s.query)
  const setQuery = useSearch((s) => s.setQuery)
  const results = useSearch((s) => s.results)
  const searchLoading = useSearch((s) => s.loading)
  const searchError = useSearch((s) => s.error)

  const focusTick = useUI((s) => s.searchFocusTick)
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
          <div className="px-6 py-4 border-b border-neutral-800">
            <h2 className="text-lg font-semibold truncate">{name}</h2>
            <p className="text-xs text-neutral-500">
              {loading
                ? 'loading…'
                : hasQuery
                  ? `${filteredTracks.length} of ${tracks.length} match`
                  : `${tracks.length} track${tracks.length === 1 ? '' : 's'}`}
            </p>
          </div>
          {error && <p className="px-6 py-4 text-sm text-red-400">{error}</p>}
          {!loading && !error && filteredTracks.length === 0 && (
            <p className="px-6 py-4 text-sm text-neutral-500">
              {hasQuery ? 'No tracks match.' : 'No tracks.'}
            </p>
          )}
          {filteredTracks.length > 0 && (
            <ul className="overflow-auto flex-1 min-h-0">
              {filteredTracks.map((t, idx) => (
                <li
                  key={`${t.id}-${idx}`}
                  onClick={() => void playFromCollection(t.uri)}
                  className="px-6 py-2 hover:bg-neutral-800 cursor-pointer flex items-center gap-3 border-b border-neutral-900"
                >
                  <span className="text-neutral-600 text-xs w-6 text-right tabular-nums">
                    {idx + 1}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm truncate">{t.name}</div>
                    <div className="text-xs text-neutral-400 truncate">
                      {t.artists.map((a) => a.name).join(', ')}
                    </div>
                  </div>
                  <span className="text-xs text-neutral-500 tabular-nums">
                    {formatDuration(t.duration_ms)}
                  </span>
                </li>
              ))}
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
                (active ? 'text-green-400' : 'text-neutral-500')
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
                render={(t: Track) => ({
                  key: t.id,
                  title: t.name,
                  subtitle: t.artists.map((a) => a.name).join(', '),
                  onClick: () => void playFromSearch(t.uri, 'track'),
                })}
              />
            )}
            {tab === 'albums' && (
              <ResultList
                items={sAlbums}
                render={(a: SimplifiedAlbum) => ({
                  key: a.id,
                  title: a.name,
                  subtitle: a.artists.map((x) => x.name).join(', '),
                  onClick: () => void playFromSearch(a.uri, 'context'),
                })}
              />
            )}
            {tab === 'artists' && (
              <ResultList
                items={sArtists}
                render={(a: ArtistObject) => ({
                  key: a.id,
                  title: a.name,
                  subtitle: 'artist',
                  onClick: () => void playFromSearch(a.uri, 'context'),
                })}
              />
            )}
            {tab === 'playlists' && (
              <ResultList
                items={sPlaylists}
                render={(p: Playlist) => ({
                  key: p.id,
                  title: p.name,
                  subtitle: p.owner.display_name ?? '',
                  onClick: () => void playFromSearch(p.uri, 'context'),
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
        <>
          {playlistSection}
          {searchInput}
          {searchResults}
        </>
      )}
    </div>
  )
}

function ResultList<T>({
  items,
  render,
}: {
  items: T[]
  render: (item: T) => {
    key: string
    title: string
    subtitle: string
    onClick: () => void
  }
}) {
  if (items.length === 0) {
    return <p className="px-4 py-2 text-sm text-neutral-500">No results.</p>
  }
  return (
    <ul>
      {items.map((it) => {
        const r = render(it)
        return (
          <li
            key={r.key}
            onClick={r.onClick}
            className="px-4 py-2 hover:bg-neutral-800 cursor-pointer border-b border-neutral-900"
          >
            <div className="text-sm truncate">{r.title}</div>
            {r.subtitle && (
              <div className="text-xs text-neutral-500 truncate">{r.subtitle}</div>
            )}
          </li>
        )
      })}
    </ul>
  )
}
