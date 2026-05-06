/**
 * Cookie source dispatcher.
 *
 * Discovery order: safari → file. Returns the first source that yields a
 * valid `sp_dc`; on Safari hits we silently mirror the cookies to the
 * persistent file so subsequent boots don't depend on Safari being open or
 * Full Disk Access being granted.
 *
 * Paste isn't part of auto-discovery — it's user-driven via
 * `/api/auth/paste`, which writes through to the persistent file.
 */

import { clearFileCookies, readFileCookies, writeFileCookies } from './file.js'
import { readSafariSpotifyCookies, type SafariReadResult } from './safari.js'
import type { CookieReadResult, SpotifyCookie } from './types.js'
import { hasSpDc } from './types.js'

export type DiscoveryDiagnostic =
  | { source: 'safari'; status: 'ok' | 'no_file' | 'not_logged_in' }
  | { source: 'safari'; status: 'permission_denied'; path: string }
  | { source: 'safari'; status: 'parse_failed'; reason: string }
  | { source: 'file'; status: 'ok' | 'empty' }

export interface DiscoveryResult {
  found: CookieReadResult | null
  diagnostics: DiscoveryDiagnostic[]
}

export async function discoverCookies(): Promise<DiscoveryResult> {
  const diagnostics: DiscoveryDiagnostic[] = []

  const safari = await readSafariSpotifyCookies()
  diagnostics.push(safariDiagnostic(safari))

  if (safari.kind === 'ok' && hasSpDc(safari.cookies)) {
    try {
      await writeFileCookies(safari.cookies)
    } catch (e) {
      console.warn('[spotui] failed to mirror Safari cookies to disk:', e)
    }
    return {
      found: { cookies: safari.cookies, source: 'safari' },
      diagnostics,
    }
  }

  const fromFile = await readFileSafe()
  if (fromFile && hasSpDc(fromFile)) {
    diagnostics.push({ source: 'file', status: 'ok' })
    return { found: { cookies: fromFile, source: 'file' }, diagnostics }
  }
  diagnostics.push({ source: 'file', status: 'empty' })
  return { found: null, diagnostics }
}

function safariDiagnostic(r: SafariReadResult): DiscoveryDiagnostic {
  switch (r.kind) {
    case 'ok':
      return r.cookies.length > 0
        ? { source: 'safari', status: 'ok' }
        : { source: 'safari', status: 'not_logged_in' }
    case 'no_file':
      return { source: 'safari', status: 'no_file' }
    case 'not_logged_in':
      return { source: 'safari', status: 'not_logged_in' }
    case 'permission_denied':
      return { source: 'safari', status: 'permission_denied', path: r.path }
    case 'parse_failed':
      return { source: 'safari', status: 'parse_failed', reason: r.reason }
  }
}

async function readFileSafe(): Promise<SpotifyCookie[]> {
  try {
    return await readFileCookies()
  } catch (e) {
    console.warn('[spotui] cookie file read failed:', e)
    return []
  }
}

export async function persistPastedCookies(
  cookies: SpotifyCookie[],
): Promise<void> {
  await writeFileCookies(cookies)
}

export async function clearAllCookies(): Promise<void> {
  await clearFileCookies()
}

/** Convenience used by routes + the dealer client: try the on-disk file
 *  first, fall through to discovery if missing. Returns null if neither
 *  source has a usable `sp_dc`. */
export async function loadCookies(): Promise<CookieReadResult | null> {
  const persisted = await readFileCookies()
  if (hasSpDc(persisted)) return { cookies: persisted, source: 'file' }
  const { found } = await discoverCookies()
  return found
}

export type {
  CookieReadResult,
  CookieSourceName,
  SpotifyCookie,
} from './types.js'
