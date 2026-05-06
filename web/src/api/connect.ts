/**
 * SPA-side client for connect-state writes via the sidecar. Each function
 * mirrors a Spotify Web API write but routes through `/api/proxy/connect/*`
 * so the cookie bearer + connect-state path handles the action — no
 * dev-mode quota for writes.
 *
 * `tryConnect` is the wrapper the public spotify.ts write fns use:
 *   `await tryConnect(() => connectPlay({uri}), () => publicPlayApi(...))`.
 */

import { truncate } from '../util/truncate'

interface PostJsonOptions {
  path: string
  body?: Record<string, unknown>
}

async function postJson({ path, body }: PostJsonOptions): Promise<void> {
  const res = await fetch(`/api/proxy/connect${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
  if (res.status === 204) return
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`connect ${path} ${res.status}: ${truncate(text)}`)
  }
}

/** Wrap a cookie-path write with public-API fallback. Logs the cookie
 *  failure once per call so we can spot patterns without spamming. */
export async function tryConnect<T>(
  primary: () => Promise<T>,
  fallback: () => Promise<T>,
): Promise<T> {
  try {
    return await primary()
  } catch (e) {
    console.warn('[spotui] connect-state failed, falling back:', e)
    return await fallback()
  }
}

export interface ConnectPlayArgs {
  contextUri?: string
  offsetUri?: string
  uri?: string
  positionMs?: number
}

export const connectPlay = (args: ConnectPlayArgs = {}): Promise<void> =>
  postJson({ path: '/play', body: args as Record<string, unknown> })

export const connectPause = (): Promise<void> => postJson({ path: '/pause' })

export const connectNext = (): Promise<void> => postJson({ path: '/next' })

export const connectPrev = (): Promise<void> => postJson({ path: '/prev' })

export const connectSeek = (positionMs: number): Promise<void> =>
  postJson({ path: '/seek', body: { positionMs } })

export const connectVolume = (percent: number): Promise<void> =>
  postJson({ path: '/volume', body: { percent } })

export const connectShuffle = (state: boolean): Promise<void> =>
  postJson({ path: '/shuffle', body: { state } })

export const connectRepeat = (mode: 'off' | 'track' | 'context'): Promise<void> =>
  postJson({ path: '/repeat', body: { mode } })

export const connectQueueAdd = (uri: string): Promise<void> =>
  postJson({ path: '/queue', body: { uri } })

export const connectTransfer = (deviceId: string, play = false): Promise<void> =>
  postJson({ path: '/transfer', body: { deviceId, play } })
