import { useEffect, useMemo } from 'react'
import { useLibrary } from '../store/library'
import { useSelection } from '../store/selection'
import { useUI } from '../store/ui'
import type { Playlist } from '../api/spotify'
import { playContext, type Refresh } from '../commands'
import { LoadMoreFooter } from './LoadMoreFooter'

export function LibraryPanel({
  ownerId,
  onAfterAction,
}: {
  ownerId: string
  onAfterAction: Refresh
}) {
  const {
    playlists,
    loaded,
    loading,
    loadingMore,
    error,
    nextPath,
    total,
    pinnedIds,
    load,
    loadMore,
    pin,
    unpin,
  } = useLibrary()
  const selectPlaylist = useSelection((s) => s.selectPlaylist)
  const selectLiked = useSelection((s) => s.selectLiked)
  const selectRecent = useSelection((s) => s.selectRecent)
  const selKind = useSelection((s) => s.kind)
  const selContextUri = useSelection((s) => s.contextUri)
  const focusedRow = useUI((s) => s.focusedRow)
  const setFocusedRow = useUI((s) => s.setFocusedRow)
  // Library and search are mutually-exclusive "current selection" surfaces:
  // when the user is focused on a search result, suppress the library
  // highlight entirely. Other focus panes ('library', 'playlist', or null)
  // leave the loaded-selection highlight visible — so clicking a track
  // inside the open playlist doesn't make the library row appear unloaded.
  const showLibSelection = focusedRow?.pane !== 'search'

  function canEdit(p: Playlist): boolean {
    return p.owner.id === ownerId || p.collaborative
  }

  // Show every playlist the user has in their library — the editable ones
  // and the read-only followed/curated ones. Non-editable rows render in the
  // external color so it's obvious they don't accept `a` (add-to-playlist).
  // Pinned ones are pulled out and rendered above the divider, in the user's
  // pin order.
  const { pinnedPlaylists, regularPlaylists } = useMemo(() => {
    const pinnedSet = new Set(pinnedIds)
    const pinned: Playlist[] = []
    const regular: Playlist[] = []
    for (const p of playlists) {
      if (pinnedSet.has(p.id)) pinned.push(p)
      else regular.push(p)
    }
    pinned.sort((a, b) => pinnedIds.indexOf(a.id) - pinnedIds.indexOf(b.id))
    return { pinnedPlaylists: pinned, regularPlaylists: regular }
  }, [playlists, pinnedIds])

  useEffect(() => {
    void load()
  }, [load])

  // Background lives on the <li> so the active stripe paints flush to the
  // right edge (across the pin slot, even when ☆ is hidden). Inner buttons
  // contribute only text color and padding.
  const liClass = (active: boolean) =>
    'flex items-center group ' +
    (active
      ? 'bg-neutral-200 dark:bg-neutral-800'
      : 'hover:bg-neutral-200/60 dark:hover:bg-neutral-800/40')

  const titleClass = (active: boolean, external: boolean = false) => {
    const color = active
      ? 'text-[var(--color-accent)]'
      : external
        ? 'text-[var(--color-external)]'
        : ''
    return `flex-1 text-left px-4 py-2 text-sm truncate ${color}`
  }

  function PlaylistRow({ pl, pinned }: { pl: Playlist; pinned: boolean }) {
    const active =
      showLibSelection && selKind === 'playlist' && selContextUri === pl.uri
    const editable = canEdit(pl)
    return (
      <li className={liClass(active)}>
        <button
          // Single-click selects the playlist and loads it into the pane;
          // double-click starts playback in the playlist's context. Setting
          // focusedRow here makes Enter target this row and clears any stale
          // focus from a prior search interaction.
          onClick={() => {
            setFocusedRow({ pane: 'library', uri: pl.uri, isTrack: false })
            void selectPlaylist(pl, editable)
          }}
          onDoubleClick={() => void playContext(pl.uri, onAfterAction)}
          className={titleClass(active, !editable)}
          title={
            editable
              ? `${pl.name} — double-click to play`
              : `${pl.name} (read-only — double-click to play)`
          }
        >
          {pl.name}
        </button>
        <button
          onClick={() => (pinned ? unpin(pl.id) : pin(pl.id))}
          className={
            'px-2 py-2 text-xs ' +
            (pinned
              ? 'text-yellow-600 dark:text-yellow-400'
              : 'text-neutral-400 dark:text-neutral-600 opacity-0 group-hover:opacity-100')
          }
          title={pinned ? 'Unpin' : 'Pin to top'}
        >
          {pinned ? '★' : '☆'}
        </button>
      </li>
    )
  }

  return (
    <aside className="border-r border-neutral-200 dark:border-neutral-800 bg-neutral-100/60 dark:bg-neutral-900/40 w-64 flex flex-col overflow-hidden">
      <div className="px-4 py-3 border-b border-neutral-200 dark:border-neutral-800">
        <h2 className="text-xs font-semibold uppercase text-neutral-600 dark:text-neutral-400 tracking-wider">
          Library
        </h2>
      </div>
      <div className="overflow-auto flex-1">
        <ul>
          <li className={liClass(showLibSelection && selKind === 'liked')}>
            <button
              onClick={() => {
                setFocusedRow(null)
                void selectLiked()
              }}
              className={titleClass(showLibSelection && selKind === 'liked')}
            >
              Liked Songs
            </button>
          </li>
          <li className={liClass(showLibSelection && selKind === 'recent')}>
            <button
              onClick={() => {
                setFocusedRow(null)
                void selectRecent()
              }}
              className={titleClass(showLibSelection && selKind === 'recent')}
            >
              Recently Played
            </button>
          </li>
          {pinnedPlaylists.map((pl) => (
            <PlaylistRow key={pl.id} pl={pl} pinned />
          ))}
        </ul>
        <div className="border-t border-neutral-200 dark:border-neutral-800 my-2" />
        {loading && (
          <p className="px-4 py-2 text-sm text-neutral-600 dark:text-neutral-500">Loading playlists…</p>
        )}
        {error && <p className="px-4 py-2 text-sm text-red-600 dark:text-red-400">{error}</p>}
        {loaded && regularPlaylists.length === 0 && pinnedPlaylists.length === 0 && !error && (
          <p className="px-4 py-2 text-sm text-neutral-600 dark:text-neutral-500">No playlists.</p>
        )}
        <ul>
          {regularPlaylists.map((pl) => (
            <PlaylistRow key={pl.id} pl={pl} pinned={false} />
          ))}
        </ul>
        {loaded && (
          <LoadMoreFooter
            loadingMore={loadingMore}
            hasMore={nextPath !== null}
            loadedCount={playlists.length}
            total={total}
            onLoadMore={() => void loadMore()}
            label="Load more playlists"
          />
        )}
      </div>
    </aside>
  )
}
