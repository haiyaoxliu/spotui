/** Cap a string at `max` chars, appending "..." when clipped. Used to
 *  shorten Spotify error bodies before re-throwing them — keeps thrown
 *  messages readable in the console without dumping multi-KB payloads. */
export function truncate(s: string, max = 200): string {
  return s.length > max ? `${s.slice(0, max)}...` : s
}
