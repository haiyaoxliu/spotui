/**
 * `/api/auth/*` route handlers. Each export is a Connect-style middleware
 * suitable for `vite.server.middlewares.use(path, handler)`.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

import {
  clearAllCookies,
  discoverCookies,
  persistPastedCookies,
  type CookieReadResult,
  type DiscoveryDiagnostic,
} from '../cookies/index.js'
import { hasSpDc } from '../cookies/types.js'
import { parsePaste } from '../cookies/paste.js'
import { readFileCookies } from '../cookies/file.js'
import {
  clearCachedToken,
  getToken,
  peekCachedToken,
  type WebToken,
} from '../spotify/token.js'
import { errMsg, error, json, readJson } from './_http.js'

interface StatusBody {
  mode: 'cookie' | 'none'
  source: 'safari' | 'file' | 'paste' | null
  tokenExpiresAt: number | null
  clientId: string | null
  diagnostics?: DiscoveryDiagnostic[]
  /** Set when discovery hit `EPERM`/`EACCES` reading Safari's cookie jar.
   *  The SPA shows a one-time guide; user has to grant Full Disk Access in
   *  System Settings → Privacy & Security → Full Disk Access for the
   *  terminal that runs `npm run dev`. There's no programmatic way to
   *  request this. */
  needsFullDiskAccess?: boolean
}

export async function statusHandler(
  _req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const cookies = await readFileCookies()
  const tok = peekCachedToken()
  // We don't know whether the on-disk cookies came from Safari or paste
  // anymore — for status purposes, treat any persisted-and-loaded cookies
  // as `file`. Discovery routes will overwrite this field accurately.
  const body: StatusBody = {
    mode: hasSpDc(cookies) || tok ? 'cookie' : 'none',
    source: hasSpDc(cookies) ? 'file' : null,
    tokenExpiresAt: tok?.expiresAt ?? null,
    clientId: tok?.clientId ?? null,
  }
  json(res, 200, body)
}

export async function discoverHandler(
  _req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    const { found, diagnostics } = await discoverCookies()
    const needsFullDiskAccess = diagnostics.some(
      (d) => d.source === 'safari' && d.status === 'permission_denied',
    )
    if (!found) {
      json(res, 200, {
        mode: 'none',
        source: null,
        tokenExpiresAt: null,
        clientId: null,
        diagnostics,
        needsFullDiskAccess,
      } satisfies StatusBody)
      return
    }
    const tok = await mintAndCache(found)
    json(res, 200, {
      mode: 'cookie',
      source: found.source,
      tokenExpiresAt: tok.expiresAt,
      clientId: tok.clientId,
      diagnostics,
      needsFullDiskAccess,
    } satisfies StatusBody)
  } catch (e) {
    error(res, 500, errMsg(e))
  }
}

export async function pasteHandler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  let body: { raw?: string }
  try {
    body = (await readJson(req)) as { raw?: string }
  } catch (e) {
    return error(res, 400, `invalid JSON: ${errMsg(e)}`)
  }
  if (!body.raw || typeof body.raw !== 'string') {
    return error(res, 400, 'expected { raw: string }')
  }
  const parsed = parsePaste(body.raw)
  if (!parsed.cookies.some((c) => c.name === 'sp_dc')) {
    return error(
      res,
      400,
      'paste must include sp_dc=... (copy from DevTools → Application → Cookies → open.spotify.com)',
    )
  }
  try {
    await persistPastedCookies(parsed.cookies)
    const tok = await mintAndCache({ cookies: parsed.cookies, source: 'paste' })
    json(res, 200, {
      mode: 'cookie',
      source: 'paste',
      tokenExpiresAt: tok.expiresAt,
      clientId: tok.clientId,
      warnings: parsed.warnings,
    })
  } catch (e) {
    error(res, 500, `mint failed: ${errMsg(e)}`)
  }
}

export async function clearHandler(
  _req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  await clearAllCookies()
  clearCachedToken()
  json(res, 200, { mode: 'none', source: null })
}

export async function tokenHandler(
  _req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    const cookies = await readFileCookies()
    if (!hasSpDc(cookies)) {
      const { found } = await discoverCookies()
      if (!found) {
        return error(res, 401, 'no cookies (run /api/auth/discover or paste)')
      }
      const tok = await mintAndCache(found)
      return json(res, 200, {
        accessToken: tok.accessToken,
        expiresAt: tok.expiresAt,
      })
    }
    const tok = await mintAndCache({ cookies, source: 'file' })
    json(res, 200, { accessToken: tok.accessToken, expiresAt: tok.expiresAt })
  } catch (e) {
    error(res, 500, errMsg(e))
  }
}

async function mintAndCache(read: CookieReadResult): Promise<WebToken> {
  return getToken(read)
}
