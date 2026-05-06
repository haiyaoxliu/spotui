/** True when a Node fs error is ENOENT. Used by the JSON-on-disk caches
 *  (cookies, me.json) to distinguish "first run" from real read failures. */
export function isNotFound(e: unknown): boolean {
  return (
    typeof e === 'object' &&
    e !== null &&
    'code' in e &&
    (e as { code: unknown }).code === 'ENOENT'
  )
}
