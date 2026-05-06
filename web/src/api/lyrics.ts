/**
 * Lyrics fetcher. Talks to the sidecar's `/api/proxy/lyrics/:id` route,
 * which calls `spclient.wg.spotify.com/color-lyrics/v2/track/{id}`.
 *
 * Distinguishes "no lyrics" (Spotify returns 404) from real errors so the
 * UI can render an empty state instead of a noisy error message.
 */

export interface LyricsLine {
  startTimeMs: number
  endTimeMs: number
  words: string
}

export interface LyricsResult {
  syncType: 'LINE_SYNCED' | 'UNSYNCED'
  language: string
  provider: string
  lines: LyricsLine[]
}

// Module-scoped cache keyed by track id. Survives component
// remounts (e.g. brief playback gaps where item briefly becomes null,
// or quick away-and-back navigation) so a returning track doesn't
// re-hit the spclient endpoint. We store both successes and "no lyrics"
// (null) results to avoid retrying tracks Spotify has none for.
type CacheEntry = { value: LyricsResult | null; storedAt: number }
const lyricsCache = new Map<string, CacheEntry>()
// In-flight requests deduped by track id so concurrent fetches share a
// single network round trip.
const inflight = new Map<string, Promise<LyricsResult | null>>()
// Spotify lyrics rarely change for a given track id, so a longer TTL is
// fine. 30 minutes balances freshness vs request volume.
const LYRICS_TTL_MS = 30 * 60 * 1000

/** Returns null when Spotify has no lyrics for this track (404). Throws on
 *  transport / auth errors so the caller can surface them. Cached per
 *  track id; identical concurrent calls share one request. */
export async function fetchLyrics(trackId: string): Promise<LyricsResult | null> {
  const cached = lyricsCache.get(trackId)
  if (cached && Date.now() - cached.storedAt < LYRICS_TTL_MS) {
    return cached.value
  }
  const pending = inflight.get(trackId)
  if (pending) return pending

  const promise = (async () => {
    const res = await fetch(`/api/proxy/lyrics/${encodeURIComponent(trackId)}`)
    if (res.status === 404) return null
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`lyrics ${res.status}: ${truncate(body)}`)
    }
    const payload = (await res.json()) as RawLyricsResponse
    const lyrics = payload.lyrics
    if (!lyrics) return null
    const lines: LyricsLine[] = (lyrics.lines ?? []).map((l) => ({
      startTimeMs: parseTime(l.startTimeMs),
      endTimeMs: parseTime(l.endTimeMs),
      words: l.words ?? '',
    }))
    return {
      syncType:
        lyrics.syncType === 'LINE_SYNCED' ? 'LINE_SYNCED' : 'UNSYNCED',
      language: lyrics.language ?? '',
      provider: lyrics.provider ?? '',
      lines,
    } satisfies LyricsResult
  })()
    .then((value) => {
      lyricsCache.set(trackId, { value, storedAt: Date.now() })
      return value
    })
    .finally(() => {
      inflight.delete(trackId)
    })

  inflight.set(trackId, promise)
  return promise
}

interface RawLyricsResponse {
  lyrics?: {
    syncType?: string
    language?: string
    provider?: string
    lines?: { startTimeMs?: string | number; endTimeMs?: string | number; words?: string }[]
  }
}

function parseTime(v: string | number | undefined): number {
  if (typeof v === 'number') return v
  if (typeof v === 'string') {
    const n = Number.parseInt(v, 10)
    return Number.isFinite(n) ? n : 0
  }
  return 0
}

function truncate(s: string): string {
  return s.length > 200 ? `${s.slice(0, 200)}...` : s
}
