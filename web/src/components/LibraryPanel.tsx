import { useEffect, useMemo } from 'react'
import { useLibrary } from '../store/library'
import { useSelection } from '../store/selection'
import { useUI } from '../store/ui'
import type { Playlist } from '../api/spotify'
import type { LibraryEntry } from '../api/pathfinder'
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
    entries,
    playlists,
    expandedFolders,
    loaded,
    loading,
    loadingMore,
    error,
    nextPath,
    total,
    pinnedIds,
    load,
    loadMore,
    toggleFolder,
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
  const showLibSelection = focusedRow?.pane !== 'search'

  function canEdit(p: Playlist): boolean {
    // libraryV3 (cookie path) doesn't return owner.id on each row, so we
    // treat empty owner.id as "unknown — assume editable". /me/playlists
    // is mostly the user's own; the few followed playlists will misreport
    // until fetchPlaylist runs on click and fills in the real owner.
    if (!p.owner.id) return true
    return p.owner.id === ownerId || p.collaborative
  }

  // Pinning operates on flat playlists — we pull pinned ones to the top
  // regardless of folder placement. Non-pinned ones render as the
  // hierarchical entries list below the pin divider.
  const pinnedPlaylists = useMemo(() => {
    const pinnedSet = new Set(pinnedIds)
    const pinned = playlists.filter((p) => pinnedSet.has(p.id))
    pinned.sort(
      (a, b) => pinnedIds.indexOf(a.id) - pinnedIds.indexOf(b.id),
    )
    return pinned
  }, [playlists, pinnedIds])

  // Skip pinned entries from the hierarchical list — they're shown above.
  const regularEntries = useMemo(() => {
    const pinnedSet = new Set(pinnedIds)
    return entries.filter(
      (e) => e.kind !== 'playlist' || !pinnedSet.has(e.playlist.id),
    )
  }, [entries, pinnedIds])

  // Fallback flat list for PKCE-only mode (entries empty).
  const regularPlaylistsFlat = useMemo(() => {
    if (entries.length > 0) return [] // entries-mode renders via regularEntries
    const pinnedSet = new Set(pinnedIds)
    return playlists.filter((p) => !pinnedSet.has(p.id))
  }, [entries, playlists, pinnedIds])

  useEffect(() => {
    void load()
  }, [load])

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

  function PlaylistRow({
    pl,
    pinned,
    depth = 0,
  }: {
    pl: Playlist
    pinned: boolean
    depth?: number
  }) {
    const active =
      showLibSelection && selKind === 'playlist' && selContextUri === pl.uri
    const editable = canEdit(pl)
    return (
      <li className={liClass(active)}>
        <button
          onClick={() => {
            setFocusedRow({ pane: 'library', uri: pl.uri, isTrack: false })
            void selectPlaylist(pl, editable)
          }}
          onDoubleClick={() => void playContext(pl.uri, onAfterAction)}
          className={titleClass(active, !editable)}
          style={depth > 0 ? { paddingLeft: `${depth * 12 + 16}px` } : undefined}
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

  function FolderRow({
    uri,
    name,
    depth,
    playlistCount,
    folderCount,
  }: {
    uri: string
    name: string
    depth: number
    playlistCount: number
    folderCount: number
  }) {
    const expanded = expandedFolders.has(uri)
    const childTotal = playlistCount + folderCount
    return (
      <li className={liClass(false)}>
        <button
          onClick={() => void toggleFolder(uri)}
          className="flex-1 text-left px-4 py-2 text-sm truncate flex items-center gap-1 text-neutral-700 dark:text-neutral-300"
          style={depth > 0 ? { paddingLeft: `${depth * 12 + 16}px` } : undefined}
          title={`${name} — ${childTotal} item${childTotal === 1 ? '' : 's'}`}
        >
          <span className="inline-block w-3 text-neutral-500 text-xs">
            {expanded ? '▾' : '▸'}
          </span>
          <span className="truncate flex-1">{name}</span>
          {childTotal > 0 && (
            <span className="text-[10px] text-neutral-500 ml-1">
              {childTotal}
            </span>
          )}
        </button>
      </li>
    )
  }

  function renderEntry(e: LibraryEntry, idx: number) {
    if (e.kind === 'folder') {
      return (
        <FolderRow
          key={`f:${e.uri}:${idx}`}
          uri={e.uri}
          name={e.name}
          depth={e.depth}
          playlistCount={e.playlistCount}
          folderCount={e.folderCount}
        />
      )
    }
    return (
      <PlaylistRow
        key={`p:${e.playlist.id}:${idx}`}
        pl={e.playlist}
        pinned={false}
        depth={e.depth}
      />
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
            <PlaylistRow key={`pin:${pl.id}`} pl={pl} pinned />
          ))}
        </ul>
        <div className="border-t border-neutral-200 dark:border-neutral-800 my-2" />
        {loading && (
          <p className="px-4 py-2 text-sm text-neutral-600 dark:text-neutral-500">
            Loading playlists…
          </p>
        )}
        {error && (
          <p className="px-4 py-2 text-sm text-red-600 dark:text-red-400">{error}</p>
        )}
        {loaded &&
          regularEntries.length === 0 &&
          regularPlaylistsFlat.length === 0 &&
          pinnedPlaylists.length === 0 &&
          !error && (
            <p className="px-4 py-2 text-sm text-neutral-600 dark:text-neutral-500">
              No playlists.
            </p>
          )}
        <ul>
          {entries.length > 0
            ? regularEntries.map((e, idx) => renderEntry(e, idx))
            : regularPlaylistsFlat.map((pl) => (
                <PlaylistRow key={pl.id} pl={pl} pinned={false} />
              ))}
        </ul>
        {loaded && entries.length === 0 && (
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
