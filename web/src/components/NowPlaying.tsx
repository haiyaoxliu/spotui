import { usePlayer } from '../store/player'
import { useLibrary } from '../store/library'
import { useSelection } from '../store/selection'
import { toggleLikeCurrent } from '../commands'
import type { PlaybackState, Playlist } from '../api/spotify'

// Friendly label for "next tracks come from": resolves the playback context
// to the playlist / album / artist name when possible, falls back to a
// capitalized type, and returns "Queue" when there's no context (the user
// is consuming a manually built queue or playing tracks one-at-a-time).
function describeSource(
  playback: PlaybackState | null,
  playlists: Playlist[],
  selectionContextUri: string | null,
  selectionName: string,
): string {
  if (!playback) return ''
  const ctx = playback.context
  if (!ctx) return 'Queue'
  // The pane the user just opened often matches what's now playing — reuse
  // its name without an extra lookup.
  if (selectionContextUri === ctx.uri && selectionName) return selectionName
  const id = ctx.uri.split(':').pop() ?? ''
  switch (ctx.type) {
    case 'playlist': {
      const pl = playlists.find((p) => p.id === id)
      return pl ? pl.name : 'Playlist'
    }
    case 'album': {
      const item = playback.item
      if (item?.type === 'track' && item.album.uri === ctx.uri) return item.album.name
      return 'Album'
    }
    case 'artist': {
      const item = playback.item
      if (item?.type === 'track') {
        const a = item.artists.find((x) => x.uri === ctx.uri)
        if (a) return a.name
      }
      return 'Artist'
    }
    case 'collection':
      return 'Liked Songs'
    case 'show':
      return 'Podcast'
    default:
      return ctx.type ? ctx.type[0].toUpperCase() + ctx.type.slice(1) : 'Other'
  }
}

export function NowPlaying() {
  const playback = usePlayer((s) => s.playback)
  const liked = usePlayer((s) => s.liked)
  const playlists = useLibrary((s) => s.playlists)
  const selectionContextUri = useSelection((s) => s.contextUri)
  const selectionName = useSelection((s) => s.name)
  const source = describeSource(playback, playlists, selectionContextUri, selectionName)

  if (!playback) {
    return (
      <div className="p-4 border-b border-neutral-200 dark:border-neutral-800 text-sm text-neutral-500">
        No active device. Press{' '}
        <kbd className="px-1.5 py-0.5 mx-0.5 rounded bg-neutral-200 dark:bg-neutral-800 border border-neutral-300 dark:border-neutral-700 text-xs">
          d
        </kbd>{' '}
        to pick one.
      </div>
    )
  }

  if (!playback.item) {
    return (
      <div className="p-4 border-b border-neutral-200 dark:border-neutral-800 text-sm text-neutral-500">
        Nothing playing.
      </div>
    )
  }

  const item = playback.item
  const albumImage =
    item.type === 'track' && item.album.images.length > 0 ? item.album.images[0].url : null
  const subtitle =
    item.type === 'track'
      ? item.artists.map((a) => a.name).join(', ')
      : item.show?.name ?? ''
  const isTrack = item.type === 'track'
  const heart = liked === null ? '·' : liked ? '♥' : '♡'

  return (
    <div className="p-4 flex gap-3 border-b border-neutral-200 dark:border-neutral-800">
      {albumImage ? (
        <img
          src={albumImage}
          alt=""
          className="w-16 h-16 rounded object-cover flex-shrink-0"
        />
      ) : (
        <div className="w-16 h-16 rounded bg-neutral-200 dark:bg-neutral-800 flex-shrink-0" />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <div className="text-sm font-medium truncate flex-1">{item.name}</div>
          {isTrack && (
            <button
              onClick={() => void toggleLikeCurrent()}
              disabled={liked === null}
              className={
                'text-base leading-none disabled:opacity-40 ' +
                (liked ? 'text-[var(--color-accent)]' : 'text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300')
              }
              title={
                liked === null
                  ? 'Checking…'
                  : liked
                    ? 'Saved · click or press l to unsave'
                    : 'Save · click or press l to save'
              }
            >
              {heart}
            </button>
          )}
        </div>
        <div className="text-xs text-neutral-600 dark:text-neutral-400 truncate">{subtitle}</div>
        {source && (
          <div className="text-[10px] text-neutral-500 truncate mt-0.5">
            from <span className="text-neutral-700 dark:text-neutral-400">{source}</span>
          </div>
        )}
        <div className="text-[10px] text-neutral-500 truncate mt-0.5">
          {playback.device.name} · {playback.is_playing ? 'playing' : 'paused'}
        </div>
      </div>
    </div>
  )
}
