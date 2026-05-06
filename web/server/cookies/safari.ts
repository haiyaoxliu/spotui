/**
 * Read Safari's `Cookies.binarycookies` and filter for `.spotify.com` entries.
 *
 * macOS 10.14+ moved Safari's cookie jar into the app sandbox:
 *   ~/Library/Containers/com.apple.Safari/Data/Library/Cookies/Cookies.binarycookies
 *
 * Older systems (and some non-default Safari profiles) still write to
 *   ~/Library/Cookies/Cookies.binarycookies
 *
 * Reading either path requires the calling process to have **Full Disk Access**
 * granted in System Settings → Privacy & Security → Full Disk Access. Without
 * it, even `stat()` returns EPERM. We surface that case explicitly because
 * the user can't fix it without flipping a system toggle and there's no API
 * to request it programmatically.
 *
 * Format (Apple-internal but stable for years):
 *
 *   "cook"                                  4 bytes magic
 *   uint32 BE                               number of pages
 *   [uint32 BE] * pages                     page sizes
 *   <page bytes> * pages
 *
 * Each page:
 *   0x00000100                              4 bytes page magic
 *   uint32 LE                               cookie count
 *   [uint32 LE] * count                     cookie offsets (within page)
 *   uint32                                  page footer (0)
 *   <cookie bytes> * count
 *
 * Each cookie record:
 *   uint32 LE                               cookie size
 *   uint32                                  unknown (version)
 *   uint32 LE                               flags (1=secure, 4=httpOnly)
 *   uint32                                  unknown
 *   uint32 LE                               domain offset
 *   uint32 LE                               name offset
 *   uint32 LE                               path offset
 *   uint32 LE                               value offset
 *   uint64                                  end-of-record marker (zero)
 *   double LE                               expiry (Mac epoch: 2001-01-01)
 *   double LE                               creation (Mac epoch)
 *   <NUL-terminated strings: domain, name, path, value>
 */

import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { SpotifyCookie } from './types.js'

const SAFARI_COOKIE_PATHS = [
  // Sandboxed path (macOS 10.14+). Try first because that's where modern
  // Safari actually writes.
  path.join(
    os.homedir(),
    'Library',
    'Containers',
    'com.apple.Safari',
    'Data',
    'Library',
    'Cookies',
    'Cookies.binarycookies',
  ),
  // Legacy path. Some users still have it (e.g. very old systems, or
  // Safari Technology Preview which writes to its own container).
  path.join(os.homedir(), 'Library', 'Cookies', 'Cookies.binarycookies'),
] as const

const MAC_EPOCH_OFFSET = 978_307_200

/** Distinguishes "Safari doesn't have spotify cookies" from "the OS won't
 *  let us read them". The dispatcher converts a `permission_denied` into a
 *  user-facing prompt to grant Full Disk Access. */
export type SafariReadError =
  | { kind: 'not_logged_in' } // file present but no spotify entries
  | { kind: 'no_file' } // neither known path exists (Safari never opened?)
  | { kind: 'permission_denied'; path: string } // EPERM/EACCES
  | { kind: 'parse_failed'; reason: string }

export interface SafariReadOk {
  kind: 'ok'
  cookies: SpotifyCookie[]
  path: string
}

export type SafariReadResult = SafariReadOk | SafariReadError

export async function readSafariSpotifyCookies(): Promise<SafariReadResult> {
  let lastNotFound = true
  let lastPermissionDenied: string | null = null

  for (const candidate of SAFARI_COOKIE_PATHS) {
    let buf: Buffer
    try {
      buf = await fs.readFile(candidate)
    } catch (e: unknown) {
      const code = errCode(e)
      if (code === 'ENOENT') continue
      if (code === 'EPERM' || code === 'EACCES') {
        lastPermissionDenied = candidate
        continue
      }
      throw e
    }

    lastNotFound = false
    try {
      const all = parseBinaryCookies(buf)
      const spotify = all.filter((c) => isSpotifyDomain(c.domain ?? ''))
      return { kind: 'ok', cookies: spotify, path: candidate }
    } catch (e) {
      return {
        kind: 'parse_failed',
        reason: e instanceof Error ? e.message : String(e),
      }
    }
  }

  if (lastPermissionDenied) {
    return { kind: 'permission_denied', path: lastPermissionDenied }
  }
  if (lastNotFound) return { kind: 'no_file' }
  return { kind: 'not_logged_in' }
}

function errCode(e: unknown): string | null {
  if (typeof e !== 'object' || e === null) return null
  const code = (e as { code?: unknown }).code
  return typeof code === 'string' ? code : null
}

function isSpotifyDomain(domain: string): boolean {
  // Safari stores domain as either ".spotify.com" or "open.spotify.com".
  // Accept anything that ends in spotify.com so we catch all subdomains.
  const d = domain.toLowerCase()
  return d === 'spotify.com' || d.endsWith('.spotify.com')
}

export function parseBinaryCookies(buf: Buffer): SpotifyCookie[] {
  if (buf.length < 8) throw new Error('binarycookies: file too short')
  const magic = buf.toString('ascii', 0, 4)
  if (magic !== 'cook') throw new Error(`binarycookies: bad magic ${magic}`)

  const pageCount = buf.readUInt32BE(4)
  const pageSizes: number[] = []
  let cursor = 8
  for (let i = 0; i < pageCount; i++) {
    pageSizes.push(buf.readUInt32BE(cursor))
    cursor += 4
  }

  const out: SpotifyCookie[] = []
  for (const pageSize of pageSizes) {
    const pageEnd = cursor + pageSize
    if (pageEnd > buf.length) {
      throw new Error('binarycookies: page extends past EOF')
    }
    parsePage(buf.subarray(cursor, pageEnd), out)
    cursor = pageEnd
  }
  return out
}

function parsePage(page: Buffer, out: SpotifyCookie[]): void {
  if (page.length < 8) throw new Error('binarycookies: page too short')
  const pageMagic = page.readUInt32BE(0)
  if (pageMagic !== 0x00000100) {
    throw new Error(
      `binarycookies: bad page magic 0x${pageMagic.toString(16)}`,
    )
  }

  const cookieCount = page.readUInt32LE(4)
  const offsets: number[] = []
  let cursor = 8
  for (let i = 0; i < cookieCount; i++) {
    offsets.push(page.readUInt32LE(cursor))
    cursor += 4
  }

  for (const off of offsets) {
    if (off >= page.length) continue
    const cookie = parseCookie(page, off)
    if (cookie) out.push(cookie)
  }
}

function parseCookie(page: Buffer, start: number): SpotifyCookie | null {
  if (start + 56 > page.length) return null
  const size = page.readUInt32LE(start)
  if (size < 56 || start + size > page.length) return null

  const domainOff = page.readUInt32LE(start + 16)
  const nameOff = page.readUInt32LE(start + 20)
  const pathOff = page.readUInt32LE(start + 24)
  const valueOff = page.readUInt32LE(start + 28)
  const expiryMac = page.readDoubleLE(start + 40)

  const record = page.subarray(start, start + size)
  const domain = readNulString(record, domainOff)
  const name = readNulString(record, nameOff)
  const cookiePath = readNulString(record, pathOff)
  const value = readNulString(record, valueOff)
  if (!name || !value) return null

  const expires = Number.isFinite(expiryMac)
    ? Math.floor(expiryMac + MAC_EPOCH_OFFSET)
    : undefined

  return { name, value, domain, path: cookiePath, expires }
}

function readNulString(buf: Buffer, off: number): string {
  if (off >= buf.length) return ''
  let end = off
  while (end < buf.length && buf[end] !== 0) end++
  return buf.toString('utf8', off, end)
}

export const _SAFARI_COOKIE_PATHS = SAFARI_COOKIE_PATHS
