import { useEffect, useMemo } from 'react'
import { useLibrary } from '../store/library'
import { useSelection } from '../store/selection'
import type { Playlist } from '../api/spotify'

export function LibraryPanel({ ownerId }: { ownerId: string }) {
  const { playlists, loaded, loading, error, pinnedIds, load, pin, unpin } = useLibrary()
  const selectPlaylist = useSelection((s) => s.selectPlaylist)
  const selectLiked = useSelection((s) => s.selectLiked)
  const selectRecent = useSelection((s) => s.selectRecent)
  const selKind = useSelection((s) => s.kind)
  const selContextUri = useSelection((s) => s.contextUri)

  function canEdit(p: Playlist): boolean {
    return p.owner.id === ownerId || p.collaborative
  }

  // Pinned playlists are exempt from the editable filter (so Discover Weekly
  // and other Spotify-curated picks can be kept around). Unpinned playlists
  // still hide non-editable rows since clicking them would 403 unhelpfully
  // unless the user explicitly pins them.
  const { pinnedPlaylists, regularPlaylists, hiddenCount } = useMemo(() => {
    const pinnedSet = new Set(pinnedIds)
    const pinned: Playlist[] = []
    const regular: Playlist[] = []
    let hidden = 0
    for (const p of playlists) {
      if (pinnedSet.has(p.id)) {
        pinned.push(p)
      } else if (canEdit(p)) {
        regular.push(p)
      } else {
        hidden++
      }
    }
    // Sort pinned in the order they appear in pinnedIds so the user's pin
    // order is preserved across reloads.
    pinned.sort((a, b) => pinnedIds.indexOf(a.id) - pinnedIds.indexOf(b.id))
    return { pinnedPlaylists: pinned, regularPlaylists: regular, hiddenCount: hidden }
    // canEdit closes over ownerId; eslint-disable rationale: ownerId is the
    // only mutable input besides playlists/pinnedIds, and we want recompute
    // when any of them change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playlists, pinnedIds, ownerId])

  useEffect(() => {
    void load()
  }, [load])

  const rowClass = (active: boolean) =>
    'flex-1 text-left px-4 py-2 text-sm truncate ' +
    (active ? 'bg-neutral-800 text-green-400' : 'hover:bg-neutral-800')

  function PlaylistRow({ pl, pinned }: { pl: Playlist; pinned: boolean }) {
    const active = selKind === 'playlist' && selContextUri === pl.uri
    return (
      <li className="flex items-center group hover:bg-neutral-800/40">
        <button
          onClick={() => void selectPlaylist(pl, canEdit(pl))}
          className={rowClass(active)}
          title={pl.name}
        >
          {pl.name}
        </button>
        <button
          onClick={() => (pinned ? unpin(pl.id) : pin(pl.id))}
          className={
            'px-2 py-2 text-xs ' +
            (pinned
              ? 'text-yellow-400'
              : 'text-neutral-600 opacity-0 group-hover:opacity-100')
          }
          title={pinned ? 'Unpin' : 'Pin to top'}
        >
          {pinned ? '★' : '☆'}
        </button>
      </li>
    )
  }

  return (
    <aside className="border-r border-neutral-800 bg-neutral-900/40 w-64 flex flex-col overflow-hidden">
      <div className="px-4 py-3 border-b border-neutral-800">
        <h2 className="text-xs font-semibold uppercase text-neutral-400 tracking-wider">
          Library
        </h2>
      </div>
      <div className="overflow-auto flex-1">
        <ul>
          <li>
            <button
              onClick={() => void selectLiked()}
              className={'w-full ' + rowClass(selKind === 'liked')}
            >
              Liked Songs
            </button>
          </li>
          <li>
            <button
              onClick={() => void selectRecent()}
              className={'w-full ' + rowClass(selKind === 'recent')}
            >
              Recently Played
            </button>
          </li>
          {pinnedPlaylists.map((pl) => (
            <PlaylistRow key={pl.id} pl={pl} pinned />
          ))}
        </ul>
        <div className="border-t border-neutral-800 my-2" />
        {loading && (
          <p className="px-4 py-2 text-sm text-neutral-500">Loading playlists…</p>
        )}
        {error && <p className="px-4 py-2 text-sm text-red-400">{error}</p>}
        {loaded && regularPlaylists.length === 0 && pinnedPlaylists.length === 0 && !error && (
          <p className="px-4 py-2 text-sm text-neutral-500">No editable playlists.</p>
        )}
        <ul>
          {regularPlaylists.map((pl) => (
            <PlaylistRow key={pl.id} pl={pl} pinned={false} />
          ))}
        </ul>
        {loaded && hiddenCount > 0 && (
          <p className="px-4 py-2 text-[11px] text-neutral-600">
            {hiddenCount} followed playlist{hiddenCount === 1 ? '' : 's'} hidden — pin to show
          </p>
        )}
      </div>
    </aside>
  )
}
