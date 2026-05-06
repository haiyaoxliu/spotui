/** Shared response/request helpers for `/api/*` route handlers. Both auth
 *  and proxy modules used to define identical copies of these. */
import type { IncomingMessage, ServerResponse } from 'node:http'

const MAX_BODY_BYTES = 1_000_000

export function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(body))
}

export function noContent(res: ServerResponse): void {
  res.statusCode = 204
  res.end()
}

export function error(res: ServerResponse, status: number, message: string): void {
  json(res, status, { error: message })
}

export async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buf = chunk as Buffer
    chunks.push(buf)
    total += buf.length
    if (total > MAX_BODY_BYTES) throw new Error('request body too large')
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  if (raw.length === 0) return {}
  return JSON.parse(raw)
}

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** Parse + clamp an integer query param. Returns `fallback` for missing,
 *  non-numeric, or out-of-range inputs. Accepts both raw strings (URL
 *  search params already give strings) and unknown for paranoid callers. */
export function clampInt(
  raw: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  if (typeof raw !== 'string') return fallback
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, n))
}
