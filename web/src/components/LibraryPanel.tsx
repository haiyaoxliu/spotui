import { useEffect, useMemo } from 'react'
import { useLibrary } from '../store/library'
import { useSelection } from '../store/selection'

export function LibraryPanel({ ownerId }: { ownerId: string }) {
  const { playlists, loaded, loading, error, load } = useLibrary()
  const selectPlaylist = useSelection((s) => s.selectPlaylist)
  const selectLiked = useSelection((s) => s.selectLiked)
  const selectRecent = useSelection((s) => s.selectRecent)
  const selKind = useSelection((s) => s.kind)
  const selContextUri = useSelection((s) => s.contextUri)

  // /playlists/{id}/items is restricted to owned + collaborative playlists
  // (returns 403 for followed/public). Hide everything else.
  const visiblePlaylists = useMemo(
    () => playlists.filter((p) => p.owner.id === ownerId || p.collaborative),
    [playlists, ownerId],
  )
  const hiddenCount = playlists.length - visiblePlaylists.length

  useEffect(() => {
    void load()
  }, [load])

  const rowClass = (active: boolean) =>
    'w-full text-left px-4 py-2 text-sm hover:bg-neutral-800 truncate ' +
    (active ? 'bg-neutral-800 text-green-400' : '')

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
              className={rowClass(selKind === 'liked')}
            >
              Liked Songs
            </button>
          </li>
          <li>
            <button
              onClick={() => void selectRecent()}
              className={rowClass(selKind === 'recent')}
            >
              Recently Played
            </button>
          </li>
        </ul>
        <div className="border-t border-neutral-800 my-2" />
        {loading && (
          <p className="px-4 py-2 text-sm text-neutral-500">Loading playlists…</p>
        )}
        {error && <p className="px-4 py-2 text-sm text-red-400">{error}</p>}
        {loaded && visiblePlaylists.length === 0 && !error && (
          <p className="px-4 py-2 text-sm text-neutral-500">No editable playlists.</p>
        )}
        <ul>
          {visiblePlaylists.map((pl) => (
            <li key={pl.id}>
              <button
                onClick={() => void selectPlaylist(pl)}
                className={rowClass(selKind === 'playlist' && selContextUri === pl.uri)}
                title={pl.name}
              >
                {pl.name}
              </button>
            </li>
          ))}
        </ul>
        {loaded && hiddenCount > 0 && (
          <p className="px-4 py-2 text-[11px] text-neutral-600">
            {hiddenCount} followed playlist{hiddenCount === 1 ? '' : 's'} hidden (API restriction)
          </p>
        )}
      </div>
    </aside>
  )
}
