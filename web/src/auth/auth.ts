import { generateCodeChallenge, generateCodeVerifier, generateState } from './pkce'

const CLIENT_ID = import.meta.env.VITE_SPOTIFY_CLIENT_ID as string | undefined
const REDIRECT_URI = 'http://127.0.0.1:8888/callback'
const AUTH_URL = 'https://accounts.spotify.com/authorize'
const TOKEN_URL = 'https://accounts.spotify.com/api/token'

const SCOPES = [
  'user-read-private',
  'user-read-email',
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-currently-playing',
  'user-read-recently-played',
  'playlist-read-private',
  'playlist-read-collaborative',
  'playlist-modify-private',
  'playlist-modify-public',
  'user-library-read',
  'user-library-modify',
  'user-follow-read',
  'user-follow-modify',
].join(' ')

interface Tokens {
  access_token: string
  refresh_token: string
  expires_at: number
}

const TOKEN_KEY = 'spotify_tokens'

// Cookie-auth bootstrap state. When the sidecar reports `mode: "cookie"`,
// we mint bearers from `/api/auth/token` instead of running the PKCE flow.
// `bootstrapAuth()` populates this on app start; the rest of the auth
// surface (`getAccessToken`, `isLoggedIn`) consults it before falling
// through to PKCE.
let cookieMode = false
interface CookieToken {
  accessToken: string
  expiresAt: number
}
let cookieToken: CookieToken | null = null

interface AuthStatus {
  mode: 'cookie' | 'none'
  source: string | null
  tokenExpiresAt: number | null
  clientId: string | null
}

export type AuthKind = 'cookie' | 'pkce' | 'none'

export async function bootstrapAuth(): Promise<AuthKind> {
  try {
    let status = await fetchStatus('/api/auth/status')
    if (status?.mode === 'none') {
      // No on-disk cookies — try Safari auto-discovery once.
      const discovered = await fetchStatus('/api/auth/discover', { method: 'POST' })
      if (discovered?.mode === 'cookie') status = discovered
    }
    if (status?.mode === 'cookie') {
      cookieMode = true
      return 'cookie'
    }
  } catch {
    // Sidecar unreachable — fall through to PKCE.
  }
  return loadTokens() ? 'pkce' : 'none'
}

async function fetchStatus(path: string, init?: RequestInit): Promise<AuthStatus | null> {
  const res = await fetch(path, init)
  if (!res.ok) return null
  return (await res.json()) as AuthStatus
}

async function getCookieToken(): Promise<string> {
  if (cookieToken && Date.now() < cookieToken.expiresAt - 60_000) {
    return cookieToken.accessToken
  }
  const res = await fetch('/api/auth/token')
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`/api/auth/token: ${res.status} ${body}`)
  }
  cookieToken = (await res.json()) as CookieToken
  return cookieToken.accessToken
}

export function isCookieMode(): boolean {
  return cookieMode
}

/** Drop the cached cookie bearer so the next call re-mints via the sidecar.
 *  Used on 401 from api.spotify.com to recover from token rotation. */
export function clearCookieToken(): void {
  cookieToken = null
}

function requireClientId(): string {
  if (!CLIENT_ID) {
    throw new Error(
      'VITE_SPOTIFY_CLIENT_ID is not set. Copy .env.example to .env.local and fill it in.',
    )
  }
  return CLIENT_ID
}

export async function login(): Promise<void> {
  const clientId = requireClientId()
  const verifier = generateCodeVerifier()
  const challenge = await generateCodeChallenge(verifier)
  const state = generateState()
  sessionStorage.setItem('pkce_verifier', verifier)
  sessionStorage.setItem('pkce_state', state)

  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    code_challenge_method: 'S256',
    code_challenge: challenge,
    state,
    scope: SCOPES,
  })
  window.location.href = `${AUTH_URL}?${params.toString()}`
}

export async function handleCallback(): Promise<void> {
  const clientId = requireClientId()
  const params = new URLSearchParams(window.location.search)
  const code = params.get('code')
  const returnedState = params.get('state')
  const expectedState = sessionStorage.getItem('pkce_state')
  const verifier = sessionStorage.getItem('pkce_verifier')

  const errorParam = params.get('error')
  if (errorParam) throw new Error(`Spotify returned: ${errorParam}`)
  if (!code) throw new Error('No code in callback')
  if (returnedState !== expectedState) throw new Error('State mismatch')
  if (!verifier) throw new Error('Missing PKCE verifier')

  const body = new URLSearchParams({
    client_id: clientId,
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
    code_verifier: verifier,
  })
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  if (!res.ok) {
    throw new Error(`Token exchange failed: ${res.status} ${await res.text()}`)
  }
  const data = (await res.json()) as {
    access_token: string
    refresh_token: string
    expires_in: number
  }
  saveTokens({
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + data.expires_in * 1000,
  })
  sessionStorage.removeItem('pkce_verifier')
  sessionStorage.removeItem('pkce_state')
  window.history.replaceState({}, '', '/')
}

function saveTokens(t: Tokens): void {
  localStorage.setItem(TOKEN_KEY, JSON.stringify(t))
}

function loadTokens(): Tokens | null {
  const raw = localStorage.getItem(TOKEN_KEY)
  return raw ? (JSON.parse(raw) as Tokens) : null
}

export async function refresh(): Promise<string> {
  const clientId = requireClientId()
  const tokens = loadTokens()
  if (!tokens) throw new Error('Not logged in')
  const body = new URLSearchParams({
    client_id: clientId,
    grant_type: 'refresh_token',
    refresh_token: tokens.refresh_token,
  })
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  if (!res.ok) {
    logout()
    throw new Error(`Refresh failed: ${res.status}`)
  }
  const data = (await res.json()) as {
    access_token: string
    refresh_token?: string
    expires_in: number
  }
  const next: Tokens = {
    access_token: data.access_token,
    refresh_token: data.refresh_token ?? tokens.refresh_token,
    expires_at: Date.now() + data.expires_in * 1000,
  }
  saveTokens(next)
  return next.access_token
}

/** Bearer for `api.spotify.com/v1` calls. Prefers the cookie-mint bearer
 *  when available so that `/v1` traffic stays on the same auth pool as
 *  Pathfinder / connect-state / spclient — keeps the app on a single
 *  consistent identity for Spotify's per-account rate-limit accounting,
 *  and matches the preference used everywhere else in the SPA.
 *
 *  PKCE is the fallback. It uses our private dev-app `client_id` (a
 *  separate rate-limit pool from Spotify's Web Player), which `api/client.ts`
 *  escalates to on a 429 from the cookie pool, and which we fall through
 *  to here when the sidecar can't mint a cookie bearer at all. */
export async function getAccessToken(): Promise<string | null> {
  if (cookieMode) {
    try {
      return await getCookieToken()
    } catch (e) {
      // Sidecar mint failed (cookies expired, network blip, etc). Fall
      // through to PKCE if it's connected — that's the "lack of coverage"
      // half of the policy.
      console.warn('[spotui] cookie bearer mint failed, trying PKCE:', e)
    }
  }
  const tokens = loadTokens()
  if (tokens) {
    if (Date.now() >= tokens.expires_at - 60_000) return refresh()
    return tokens.access_token
  }
  return null
}

/** PKCE bearer specifically — bypasses the cookie-first preference in
 *  `getAccessToken`. Used by `api/client.ts` to escape Web Player rate
 *  limits on 429 by retrying with the private-app pool. Returns null
 *  when PKCE isn't connected; callers must fall back gracefully. */
export async function getPkceAccessToken(): Promise<string | null> {
  const tokens = loadTokens()
  if (!tokens) return null
  if (Date.now() >= tokens.expires_at - 60_000) return refresh()
  return tokens.access_token
}

/** Which bearer pool getAccessToken() will produce on the *next* call.
 *  Lets `api/client.ts` route 401-retries to the right refresh path
 *  (cookie-mint re-mint vs. PKCE token rotation). */
export function tokenKind(): 'pkce' | 'cookie' | null {
  if (cookieMode) return 'cookie'
  if (loadTokens()) return 'pkce'
  return null
}

/** True when PKCE tokens are persisted. UI uses this to gate the
 *  "Connect Spotify dev app" affordance and to surface "/v1 via PKCE"
 *  status. */
export function hasPkce(): boolean {
  return loadTokens() !== null
}

export function isLoggedIn(): boolean {
  return cookieMode || hasPkce()
}

export function logout(): void {
  localStorage.removeItem(TOKEN_KEY)
}
