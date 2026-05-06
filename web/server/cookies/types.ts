/**
 * Cookie types shared across the sidecar.
 */

export interface SpotifyCookie {
  name: string
  value: string
  /** Optional metadata; we don't currently use these but keep them around for
   * future per-cookie expiry handling. */
  domain?: string
  path?: string
  expires?: number // unix seconds
}

export type CookieSourceName = 'safari' | 'file' | 'paste'

export interface CookieReadResult {
  cookies: SpotifyCookie[]
  source: CookieSourceName
}

export function findCookie(
  cookies: SpotifyCookie[],
  name: string,
): string | null {
  const hit = cookies.find((c) => c.name === name)
  return hit ? hit.value : null
}

export function hasSpDc(cookies: SpotifyCookie[]): boolean {
  return cookies.some((c) => c.name === 'sp_dc' && c.value.length > 0)
}

/**
 * Build the `Cookie:` header value for `open.spotify.com`. De-dupes by name
 * so a re-paste doesn't double up `sp_dc`.
 */
export function toCookieHeader(cookies: SpotifyCookie[]): string {
  const byName = new Map<string, string>()
  for (const c of cookies) byName.set(c.name, c.value)
  return Array.from(byName.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join('; ')
}
