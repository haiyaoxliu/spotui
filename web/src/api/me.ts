/**
 * SPA-side fetcher for the sidecar's cached /api/me route. The sidecar
 * holds a single /v1/me result for the dev-server lifetime, so calling
 * this from boot doesn't hit api.spotify.com on every page reload.
 *
 * When the sidecar fell back to www.spotify.com (because /v1/me was
 * rate-limited), the response carries `_source: 'www-fallback'` and we
 * surface a console-bar warning so the user knows display_name + product
 * are coming from a degraded source.
 */

import { notify } from '../console'

interface Me {
  display_name: string
  id: string
  email?: string
  product: 'premium' | 'free' | 'open'
  country?: string
  _source?: 'www-fallback'
}

export async function fetchMe(): Promise<Me> {
  const res = await fetch('/api/me')
  if (res.status === 429) {
    const retry = Number.parseInt(res.headers.get('Retry-After') ?? '60', 10)
    notify(
      `/v1/me rate-limited; retry in ${retry}s (cookie + Pathfinder still working)`,
      'error',
    )
    throw new Error(`/api/me rate-limited; retry in ${retry}s`)
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`/api/me ${res.status}: ${text}`)
  }
  const me = (await res.json()) as Me
  if (me._source === 'www-fallback') {
    notify(
      'profile from www fallback (api.spotify.com rate-limited); display name and product are degraded',
      'warn',
    )
  }
  return me
}
