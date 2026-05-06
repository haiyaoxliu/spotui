import { clearCookieToken, getAccessToken, isCookieMode, refresh } from '../auth/auth'

const API_BASE = 'https://api.spotify.com/v1'

export async function api<T = unknown>(
  path: string,
  init: RequestInit = {},
): Promise<T | null> {
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
    if (isCookieMode()) {
      clearCookieToken()
      token = (await getAccessToken()) ?? ''
    } else {
      token = await refresh()
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
