/**
 * SPA-side fetcher for the sidecar's cached /api/me route. The sidecar
 * holds a single /v1/me result for the dev-server lifetime, so calling
 * this from boot doesn't hit api.spotify.com on every page reload.
 */

interface Me {
  display_name: string
  id: string
  email?: string
  product: 'premium' | 'free' | 'open'
  country?: string
}

export async function fetchMe(): Promise<Me> {
  const res = await fetch('/api/me')
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`/api/me ${res.status}: ${text}`)
  }
  return (await res.json()) as Me
}
