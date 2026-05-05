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

export async function getAccessToken(): Promise<string | null> {
  const tokens = loadTokens()
  if (!tokens) return null
  if (Date.now() >= tokens.expires_at - 60_000) return refresh()
  return tokens.access_token
}

export function isLoggedIn(): boolean {
  return loadTokens() !== null
}

export function logout(): void {
  localStorage.removeItem(TOKEN_KEY)
}
