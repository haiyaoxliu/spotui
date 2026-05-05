import { useEffect, useRef, useState } from 'react'
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

// Below this px width, the volume slider stops being readable in the right
// panel and we drop to a − / number / + button group instead. The full bar
// (label + 48px slider + number) renders at ~116px, so 120 leaves a hair of
// breathing room before the swap.
const VOLUME_BAR_MIN_WIDTH = 120

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

  // Width-driven swap between the slider and a +/- group. Only matters in
  // compact mode (the bottom transport always has plenty of room).
  const volumeWrapperRef = useRef<HTMLDivElement>(null)
  const [volumeMode, setVolumeMode] = useState<'bar' | 'buttons'>('bar')
  useEffect(() => {
    if (!compact) return
    const el = volumeWrapperRef.current
    if (!el) return
    const obs = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0
      setVolumeMode(w >= VOLUME_BAR_MIN_WIDTH ? 'bar' : 'buttons')
    })
    obs.observe(el)
    return () => obs.disconnect()
  }, [compact])

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

  const barWidthClass = compact ? 'w-12' : 'w-20'
  const volumeBarUI = (
    <div
      className="flex items-center gap-2 text-xs text-neutral-500 select-none"
      onWheel={(e) => {
        if (disabled) return
        e.preventDefault()
        void adjustVolume(e.deltaY > 0 ? -5 : 5, onAfterAction)
      }}
    >
      <span>vol</span>
      <div className={`${barWidthClass} h-1 bg-neutral-800 rounded overflow-hidden`}>
        <div className="h-full bg-neutral-500" style={{ width: `${volume ?? 0}%` }} />
      </div>
      <span className="tabular-nums w-8 text-right">{volume == null ? '—' : volume}</span>
    </div>
  )

  const volumeButtonsUI = (
    <div className="flex items-center gap-1 text-xs text-neutral-500 select-none">
      <button
        onClick={() => void adjustVolume(-5, onAfterAction)}
        disabled={disabled}
        className="px-1.5 rounded bg-neutral-800 hover:bg-neutral-700 disabled:opacity-40 leading-tight"
        title="Volume -5 (-)"
      >
        −
      </button>
      <span className="tabular-nums w-7 text-center">
        {volume == null ? '—' : volume}
      </span>
      <button
        onClick={() => void adjustVolume(5, onAfterAction)}
        disabled={disabled}
        className="px-1.5 rounded bg-neutral-800 hover:bg-neutral-700 disabled:opacity-40 leading-tight"
        title="Volume +5 (=)"
      >
        +
      </button>
    </div>
  )

  const volumeUI = compact && volumeMode === 'buttons' ? volumeButtonsUI : volumeBarUI

  if (compact) {
    // Two-column grid so column 1 (auto) snaps to whichever child is widest
    // — that's the playButtons row, ~150px. The scrub bar in row 2 then
    // inherits the same 150px and visually sits directly under prev/play/
    // next. Column 2 (1fr) holds modes and the compressed volume on the
    // right; volumeUI swaps to a +/- group when its cell drops below
    // VOLUME_BAR_MIN_WIDTH.
    return (
      <div className="border-b border-neutral-800 px-3 py-2 grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2">
        {playButtons}
        <div className="flex justify-end">{modes}</div>
        <ProgressBar onAfterAction={onAfterAction} />
        <div ref={volumeWrapperRef} className="flex justify-end min-w-0">
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
