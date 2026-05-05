import { usePlayer } from '../store/player'
import { toggleLikeCurrent } from '../commands'

export function NowPlaying() {
  const playback = usePlayer((s) => s.playback)
  const liked = usePlayer((s) => s.liked)

  if (!playback) {
    return (
      <div className="p-4 border-b border-neutral-800 text-sm text-neutral-500">
        No active device. Press{' '}
        <kbd className="px-1.5 py-0.5 mx-0.5 rounded bg-neutral-800 border border-neutral-700 text-xs">
          d
        </kbd>{' '}
        to pick one.
      </div>
    )
  }

  if (!playback.item) {
    return (
      <div className="p-4 border-b border-neutral-800 text-sm text-neutral-500">
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
    <div className="p-4 flex gap-3 border-b border-neutral-800">
      {albumImage ? (
        <img
          src={albumImage}
          alt=""
          className="w-16 h-16 rounded object-cover flex-shrink-0"
        />
      ) : (
        <div className="w-16 h-16 rounded bg-neutral-800 flex-shrink-0" />
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
                (liked ? 'text-green-400' : 'text-neutral-500 hover:text-neutral-300')
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
        <div className="text-xs text-neutral-400 truncate">{subtitle}</div>
        <div className="text-[10px] text-neutral-500 truncate mt-0.5">
          {playback.device.name} · {playback.is_playing ? 'playing' : 'paused'}
        </div>
      </div>
    </div>
  )
}
