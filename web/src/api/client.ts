import {
  clearCookieToken,
  getAccessToken,
  getPkceAccessToken,
  hasPkce,
  refresh,
  tokenKind,
} from '../auth/auth'
import { notify } from '../console'

const API_BASE = 'https://api.spotify.com/v1'

export async function api<T = unknown>(
  path: string,
  init: RequestInit = {},
): Promise<T | null> {
  // Snapshot which pool we picked up — drives the 401 re-mint path and
  // lets us know whether the 429 escalation to PKCE is even applicable.
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

  // 401: refresh-then-retry on the same pool. Token rotation is normal;
  // a fresh bearer almost always succeeds.
  if (res.status === 401) {
    if (kind === 'cookie') {
      clearCookieToken()
      token = (await getAccessToken()) ?? ''
    } else {
      token = await refresh()
    }
    res = await send(token)
  }

  // 429 on the cookie pool with PKCE connected: escape to the private-app
  // pool. Cookie bearers share a rate-limit budget with all of
  // open.spotify.com so they 429 quickly under heavy use; PKCE has its
  // own budget and is the documented escape hatch. We don't escalate the
  // other direction (PKCE → cookie) since cookie is already the primary
  // — if PKCE 429s, falling back would just push the same load onto the
  // pool we were trying to relieve.
  if (res.status === 429 && kind === 'cookie' && hasPkce()) {
    const pkceToken = await getPkceAccessToken()
    if (pkceToken) {
      notify(`/v1${path.split('?')[0]} cookie pool 429d; retrying via PKCE`, 'warn')
      res = await send(pkceToken)
    }
  }

  if (res.status === 204) return null
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Spotify ${init.method ?? 'GET'} ${path}: ${res.status} ${text}`)
  }
  return (await res.json()) as T
}
