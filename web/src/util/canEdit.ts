import type { Playlist } from '../api/spotify'

/** True when the current user can mutate this playlist (POST items, etc).
 *  Owned by the user OR collaborative. libraryV3 (cookie path) doesn't
 *  return owner.id on each row, so an empty owner.id is treated as
 *  "unknown — assume editable" until fetchPlaylist fills it in on click;
 *  callers that actually have the owner already (search results, fully
 *  hydrated rows) get an accurate answer. */
export function canEditPlaylist(p: Playlist, userId: string): boolean {
  if (!p.owner.id) return true
  return p.owner.id === userId || p.collaborative
}
