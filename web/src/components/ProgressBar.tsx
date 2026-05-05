import { useEffect, useRef, useState } from 'react'
import { usePlayer } from '../store/player'
import { seekTo, type Refresh } from '../commands'

function fmtTime(ms: number | null): string {
  if (ms == null) return '–:––'
  const s = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(s / 60)
  return `${m}:${String(s % 60).padStart(2, '0')}`
}

// Shows playback position with a 250ms client-side interpolation between
// 3s server polls, plus pointer-drag scrubbing. Click anywhere on the bar
// to jump; press-drag-release to scrub continuously. While the user is
// dragging, server polls don't overwrite the displayed position.
export function ProgressBar({ onAfterAction }: { onAfterAction: Refresh }) {
  const playback = usePlayer((s) => s.playback)
  const item = playback?.item ?? null
  const duration = item?.duration_ms ?? null
  const serverProgress = playback?.progress_ms ?? null
  const isPlaying = playback?.is_playing ?? false

  const [localProgress, setLocalProgress] = useState<number | null>(serverProgress)
  const [isDragging, setIsDragging] = useState(false)
  const baseRef = useRef<{ ms: number; at: number } | null>(null)
  const barRef = useRef<HTMLDivElement>(null)

  // Server-side position changed (poll, optimistic seek, track change). Reset
  // the interpolation base. Skip the local-state write while the user is
  // dragging — they own the displayed value until pointer-up.
  useEffect(() => {
    if (serverProgress == null) {
      baseRef.current = null
      if (!isDragging) setLocalProgress(null)
      return
    }
    baseRef.current = { ms: serverProgress, at: Date.now() }
    if (!isDragging) setLocalProgress(serverProgress)
  }, [serverProgress, isDragging])

  // 250ms tick that linearly extrapolates progress while playing. Polling
  // every 3s would otherwise show a janky jump; this keeps the bar smooth.
  useEffect(() => {
    if (!isPlaying || isDragging || baseRef.current == null) return
    const id = setInterval(() => {
      const base = baseRef.current
      if (!base) return
      const next = base.ms + (Date.now() - base.at)
      setLocalProgress(duration != null ? Math.min(next, duration) : next)
    }, 250)
    return () => clearInterval(id)
  }, [isPlaying, isDragging, duration])

  function ratioFromEvent(e: React.PointerEvent<HTMLDivElement>): number {
    const rect = barRef.current!.getBoundingClientRect()
    return Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
  }

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (!barRef.current || duration == null) return
    e.currentTarget.setPointerCapture(e.pointerId)
    setIsDragging(true)
    setLocalProgress(Math.round(ratioFromEvent(e) * duration))
  }

  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!isDragging || duration == null) return
    setLocalProgress(Math.round(ratioFromEvent(e) * duration))
  }

  function onPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    if (!isDragging) return
    e.currentTarget.releasePointerCapture(e.pointerId)
    // Fire seek before clearing isDragging so the [serverProgress] effect
    // doesn't briefly snap to the pre-seek server value during the gap
    // between optimistic patch and the next poll.
    if (localProgress != null && duration != null) {
      void seekTo(localProgress, onAfterAction)
    }
    setIsDragging(false)
  }

  const ratio =
    localProgress != null && duration != null && duration > 0
      ? Math.min(localProgress / duration, 1)
      : 0

  return (
    <div className="flex items-center gap-2 text-[10px] text-neutral-500 select-none">
      <span className="tabular-nums w-10 text-right">{fmtTime(localProgress)}</span>
      <div
        ref={barRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        className={
          'flex-1 h-1.5 bg-neutral-800 rounded-full ' +
          (duration != null ? 'cursor-pointer hover:h-2 transition-[height]' : 'opacity-50')
        }
      >
        <div
          className="h-full bg-neutral-300 rounded-full"
          style={{ width: `${ratio * 100}%` }}
        />
      </div>
      <span className="tabular-nums w-10">{fmtTime(duration)}</span>
    </div>
  )
}
