import { clearCookieToken, getAccessToken, refresh, tokenKind } from '../auth/auth'

const API_BASE = 'https://api.spotify.com/v1'

export async function api<T = unknown>(
  path: string,
  init: RequestInit = {},
): Promise<T | null> {
  // Capture which pool we're about to use so the 401-retry path knows
  // whether to refresh PKCE or re-mint the cookie bearer.
  const kind = tokenKind()
  let token = await getAccessToken()
  if (!token) throw new Error('Not logged in')

  const send = (t: string): Promise<Response> =>
    fetch(`${API_BASE}${path}`, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        Authorization: `Bearer ${t}`,
      },
    })

  let res = await send(token)
  if (res.status === 401) {
    if (kind === 'pkce') {
      token = await refresh()
    } else {
      clearCookieToken()
      token = (await getAccessToken()) ?? ''
    }
    res = await send(token)
  }
  if (res.status === 204) return null
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Spotify ${init.method ?? 'GET'} ${path}: ${res.status} ${text}`)
  }
  return (await res.json()) as T
}
