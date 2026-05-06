/** Last colon-separated segment of a Spotify URI: `spotify:track:abc` → `abc`.
 *  Returns "" for empty / undefined / malformed input so callers don't have
 *  to null-check. */
export function idFromUri(uri: string | undefined): string {
  if (!uri) return ''
  const parts = uri.split(':')
  return parts[parts.length - 1] ?? ''
}

/** Penultimate colon-separated segment: `spotify:track:abc` → `track`. */
export function typeFromUri(uri: string | undefined): string {
  if (!uri) return ''
  const parts = uri.split(':')
  return parts.length >= 3 ? (parts[parts.length - 2] ?? '') : ''
}
