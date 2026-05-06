/**
 * SPA client for `/api/proxy/state` — one connect-state pull mapped into
 * the public Web API shapes. Replaces three /v1 calls (`/me/player`,
 * `/me/player/queue`, `/me/player/devices`) on every refresh tick.
 *
 * Concurrent callers share the in-flight fetch so a single dealer tick
 * doesn't trigger three round trips.
 */

import type { Device, PlaybackState, Queue } from './spotify'

export interface ClusterSnapshot {
  playback: PlaybackState | null
  queue: Queue
  devices: Device[]
}

let inflight: Promise<ClusterSnapshot> | null = null

export async function fetchClusterSnapshot(): Promise<ClusterSnapshot> {
  if (inflight) return inflight
  inflight = (async () => {
    try {
      const res = await fetch('/api/proxy/state')
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`/api/proxy/state ${res.status}: ${text}`)
      }
      return (await res.json()) as ClusterSnapshot
    } finally {
      // Clear once the response settles so the next caller fires fresh.
      // Resolves on next tick to dedupe a burst, not over the whole session.
      queueMicrotask(() => {
        inflight = null
      })
    }
  })()
  return inflight
}
