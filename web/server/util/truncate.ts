/** Cap a string at `max` chars, appending "..." when clipped. Used to keep
 *  Spotify error bodies readable in our re-thrown messages without dumping
 *  multi-KB HTML responses into the console. */
export function truncate(s: string, max = 200): string {
  return s.length > max ? `${s.slice(0, max)}...` : s
}
