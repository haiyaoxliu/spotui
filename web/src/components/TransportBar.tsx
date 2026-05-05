import { usePlayer } from '../store/player'
import {
  adjustVolume,
  cycleRepeat,
  skipNext,
  skipPrevious,
  toggleShuffle,
  togglePlayPause,
  type Refresh,
} from '../commands'
import { ProgressBar } from './ProgressBar'

export function TransportBar({
  onAfterAction,
  compact = false,
}: {
  onAfterAction: Refresh
  compact?: boolean
}) {
  const playback = usePlayer((s) => s.playback)
  const isPlaying = playback?.is_playing ?? false
  const item = playback?.item ?? null
  const device = playback?.device ?? null
  const shuffle = playback?.shuffle_state ?? false
  const repeat = playback?.repeat_state ?? 'off'
  const volume = device?.volume_percent ?? null
  const disabled = !playback

  const repeatLabel = repeat === 'track' ? '↻¹' : '↻'
  const repeatActive = repeat !== 'off'

  const playButtons = (
    <div className="flex items-center gap-2">
      <button
        onClick={() => void skipPrevious(onAfterAction)}
        disabled={disabled}
        className="px-3 py-1.5 rounded bg-neutral-800 hover:bg-neutral-700 disabled:opacity-40"
        title="Previous (k)"
      >
        ◀◀
      </button>
      <button
        onClick={() => void togglePlayPause(onAfterAction)}
        disabled={disabled}
        className="px-3 py-1.5 rounded bg-neutral-200 text-neutral-900 hover:bg-white disabled:opacity-40 min-w-[48px]"
        title="Play/Pause (Space)"
      >
        {isPlaying ? '❚❚' : '▶'}
      </button>
      <button
        onClick={() => void skipNext(onAfterAction)}
        disabled={disabled}
        className="px-3 py-1.5 rounded bg-neutral-800 hover:bg-neutral-700 disabled:opacity-40"
        title="Next (j)"
      >
        ▶▶
      </button>
    </div>
  )

  const modes = (
    <div className="flex items-center gap-1">
      <button
        onClick={() => void toggleShuffle(onAfterAction)}
        disabled={disabled}
        className={
          'px-2 py-1 rounded text-sm hover:bg-neutral-800 disabled:opacity-40 ' +
          (shuffle ? 'text-[var(--color-accent)]' : 'text-neutral-500')
        }
        title="Shuffle (s)"
      >
        ⇆
      </button>
      <button
        onClick={() => void cycleRepeat(onAfterAction)}
        disabled={disabled}
        className={
          'px-2 py-1 rounded text-sm hover:bg-neutral-800 disabled:opacity-40 tabular-nums ' +
          (repeatActive ? 'text-[var(--color-accent)]' : 'text-neutral-500')
        }
        title={`Repeat: ${repeat} (r)`}
      >
        {repeatLabel}
      </button>
    </div>
  )

  const volumeUI = (
    <div
      className="flex items-center gap-2 text-xs text-neutral-500 select-none"
      onWheel={(e) => {
        if (disabled) return
        e.preventDefault()
        void adjustVolume(e.deltaY > 0 ? -5 : 5, onAfterAction)
      }}
    >
      <span>vol</span>
      <div className="w-20 h-1 bg-neutral-800 rounded overflow-hidden">
        <div className="h-full bg-neutral-500" style={{ width: `${volume ?? 0}%` }} />
      </div>
      <span className="tabular-nums w-8 text-right">{volume == null ? '—' : volume}</span>
    </div>
  )

  if (compact) {
    return (
      <div className="border-b border-neutral-800 px-3 py-2 flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          {playButtons}
          {modes}
        </div>
        <div className="flex items-center gap-3">
          <div className="flex-1 min-w-0">
            <ProgressBar onAfterAction={onAfterAction} />
          </div>
          {volumeUI}
        </div>
      </div>
    )
  }

  const subtitle =
    item?.type === 'track'
      ? item.artists.map((a) => a.name).join(', ')
      : item?.type === 'episode'
        ? item.show?.name ?? ''
        : ''

  return (
    <div className="border-t border-neutral-800 bg-neutral-950 flex flex-col">
      <div className="px-4 pt-2">
        <ProgressBar onAfterAction={onAfterAction} />
      </div>
      <div className="px-4 py-2 flex items-center gap-4">
        {playButtons}
        {modes}
        <div className="flex-1 min-w-0">
          <div className="truncate text-sm">{item?.name ?? '—'}</div>
          <div className="truncate text-xs text-neutral-400">{subtitle}</div>
        </div>
        {volumeUI}
        <div className="text-xs text-neutral-500 truncate max-w-[20%]">
          {device ? `${device.name} (${device.type})` : 'no active device'}
        </div>
      </div>
    </div>
  )
}
