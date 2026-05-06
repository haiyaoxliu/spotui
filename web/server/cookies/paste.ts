/**
 * Parse a free-form paste of cookies (typically copied from Chrome DevTools
 * → Application → Cookies, or written by hand) into a `SpotifyCookie[]`.
 *
 * Accepts lines in either form:
 *   sp_dc=AABBCC
 *   sp_dc: AABBCC
 *   sp_dc=AABBCC; sp_t=device-id   (semicolon-joined like a real Cookie header)
 */

import { truncate } from '../util/truncate.js'
import type { SpotifyCookie } from './types.js'

export interface PasteResult {
  cookies: SpotifyCookie[]
  /** Names that the parser saw but couldn't make sense of. */
  warnings: string[]
}

export function parsePaste(raw: string): PasteResult {
  const cookies: SpotifyCookie[] = []
  const warnings: string[] = []

  // Normalize: split on newlines AND semicolons so users can paste a single
  // `Cookie:` header line and it just works.
  const segments = raw
    .split(/[\r\n;]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)

  for (const seg of segments) {
    const cleaned = seg.replace(/^Cookie:\s*/i, '').trim()
    if (cleaned.length === 0) continue

    const eq = cleaned.indexOf('=')
    const colon = cleaned.indexOf(':')
    let split: number
    if (eq !== -1 && (colon === -1 || eq < colon)) {
      split = eq
    } else if (colon !== -1) {
      split = colon
    } else {
      warnings.push(`unrecognized line: ${truncate(seg, 80)}`)
      continue
    }

    const name = cleaned.slice(0, split).trim()
    const value = cleaned.slice(split + 1).trim()
    if (!name || !value) {
      warnings.push(`empty name or value: ${truncate(seg, 80)}`)
      continue
    }
    cookies.push({ name, value, domain: '.spotify.com' })
  }

  return { cookies, warnings }
}
