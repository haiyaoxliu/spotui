/**
 * Lyrics for the currently playing track. Fetches once per track id, shows
 * synced lines when Spotify has them, plain text otherwise. Highlights the
 * line whose `startTimeMs` last passed and auto-scrolls it into view.
 *
 * Position smoothing: `playback.progress_ms` only updates on dealer ticks
 * (whenever Spotify pushes a state change). Between ticks we extrapolate
 * locally using wall-clock so the highlight glides instead of jumping.
 */

import { useEffect, useMemo, useRef, useState } from 'react'

import { fetchLyrics, type LyricsResult } from '../api/lyrics'
import { usePlayer } from '../store/player'

export function LyricsPanel() {
  const item = usePlayer((s) => s.playback?.item ?? null)
  const isPlaying = usePlayer((s) => s.playback?.is_playing ?? false)
  const progressMs = usePlayer((s) => s.playback?.progress_ms ?? 0)

  const trackId = item?.type === 'track' ? item.id : null
  const [lyrics, setLyrics] = useState<LyricsResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Refetch whenever the track changes. Track-id is the cache key.
  useEffect(() => {
    setError(null)
    if (!trackId) {
      setLyrics(null)
      return
    }
    let cancelled = false
    setLoading(true)
    fetchLyrics(trackId)
      .then((r) => {
        if (!cancelled) setLyrics(r)
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [trackId])

  // Wall-clock-extrapolated current position. Anchored to `progressMs` and
  // advances at 1ms per ms while playing. Reset when progress jumps from
  // a dealer push (seek, track change, pause).
  const localPos = useExtrapolatedPosition(progressMs, isPlaying)

  const activeIndex = useMemo(() => {
    if (!lyrics || lyrics.lines.length === 0) return -1
    let lo = 0
    let hi = lyrics.lines.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (lyrics.lines[mid].startTimeMs <= localPos) lo = mid + 1
      else hi = mid
    }
    return lo - 1
  }, [lyrics, localPos])

  const activeRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (activeRef.current) {
      activeRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  }, [activeIndex])

  if (!trackId) return null
  if (loading && !lyrics) {
    return <Frame muted>loading lyrics…</Frame>
  }
  if (error) {
    return <Frame muted>lyrics unavailable</Frame>
  }
  if (!lyrics) {
    return <Frame muted>no lyrics for this track</Frame>
  }
  if (lyrics.lines.length === 0) {
    return <Frame muted>no lyrics available</Frame>
  }

  return (
    <div
      className="px-4 py-3 border-t border-neutral-200 dark:border-neutral-800 overflow-y-auto max-h-64 text-sm leading-relaxed"
    >
      {lyrics.lines.map((line, i) => {
        const active = i === activeIndex
        return (
          <div
            key={`${line.startTimeMs}-${i}`}
            ref={active ? activeRef : null}
            className={
              'transition-opacity duration-150 ' +
              (active
                ? 'text-[var(--color-accent)] font-medium opacity-100'
                : i < activeIndex
                  ? 'text-neutral-500 opacity-60'
                  : 'text-neutral-700 dark:text-neutral-300 opacity-90')
            }
          >
            {line.words || ' '}
          </div>
        )
      })}
      <div className="mt-2 text-[10px] text-neutral-500">
        {lyrics.syncType === 'LINE_SYNCED' ? 'synced' : 'unsynced'}
        {lyrics.provider ? ` · ${lyrics.provider}` : ''}
      </div>
    </div>
  )
}

function Frame({ children, muted }: { children: React.ReactNode; muted?: boolean }) {
  return (
    <div
      className={
        'px-4 py-3 border-t border-neutral-200 dark:border-neutral-800 text-xs ' +
        (muted ? 'text-neutral-500' : 'text-neutral-700 dark:text-neutral-300')
      }
    >
      {children}
    </div>
  )
}

/**
 * Smooth-time helper. Returns a position that advances locally between
 * dealer pushes — driven by requestAnimationFrame while `playing` is true,
 * snapping to the latest `serverPos` on each push.
 */
function useExtrapolatedPosition(serverPos: number, playing: boolean): number {
  const [pos, setPos] = useState(serverPos)
  const anchorRef = useRef({ serverPos, wallTime: Date.now() })

  // Snap whenever the server-pushed value changes (track change, seek, etc).
  useEffect(() => {
    anchorRef.current = { serverPos, wallTime: Date.now() }
    setPos(serverPos)
  }, [serverPos])

  // Tick locally while playing. ~30fps is plenty for line highlighting.
  useEffect(() => {
    if (!playing) return
    let raf = 0
    const tick = () => {
      const { serverPos: anchor, wallTime } = anchorRef.current
      setPos(anchor + (Date.now() - wallTime))
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing])

  return pos
}
