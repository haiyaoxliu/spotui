/**
 * Persistent cookie store under the user's config dir. Saved with mode 0600
 * so it isn't world-readable. The TUI uses the same parent directory; the
 * file name is web-specific so the two don't collide.
 */

import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { isNotFound } from '../util/fs.js'
import type { SpotifyCookie } from './types.js'
import { hasSpDc } from './types.js'

function defaultPath(): string {
  // macOS-only for now (matches plan). If we add Linux/Windows later, switch
  // on platform here.
  return path.join(
    os.homedir(),
    'Library',
    'Application Support',
    'spotui',
    'web-cookies.json',
  )
}

export const COOKIE_FILE_PATH = defaultPath()

interface Stored {
  cookies: SpotifyCookie[]
  savedAt: number
}

export async function readFileCookies(
  filePath = COOKIE_FILE_PATH,
): Promise<SpotifyCookie[]> {
  let body: string
  try {
    body = await fs.readFile(filePath, 'utf8')
  } catch (e: unknown) {
    if (isNotFound(e)) return []
    throw e
  }
  const parsed = JSON.parse(body) as Stored
  if (!parsed || !Array.isArray(parsed.cookies)) return []
  return parsed.cookies
}

export async function writeFileCookies(
  cookies: SpotifyCookie[],
  filePath = COOKIE_FILE_PATH,
): Promise<void> {
  if (!hasSpDc(cookies)) {
    throw new Error('refusing to persist cookies without sp_dc')
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const body = JSON.stringify(
    { cookies, savedAt: Math.floor(Date.now() / 1000) } satisfies Stored,
    null,
    2,
  )
  const tmp = `${filePath}.tmp`
  await fs.writeFile(tmp, body, { mode: 0o600 })
  await fs.rename(tmp, filePath)
}

export async function clearFileCookies(
  filePath = COOKIE_FILE_PATH,
): Promise<void> {
  try {
    await fs.unlink(filePath)
  } catch (e: unknown) {
    if (isNotFound(e)) return
    throw e
  }
}
