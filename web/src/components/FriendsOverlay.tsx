/**
 * Friend activity overlay — shows the user's followed friends and what
 * they're currently listening to. Cookie-only feature; the public Web
 * API has no equivalent.
 *
 * Triggered by `f` or the people icon in the console bar. Auto-refreshes
 * every 60s while open. Click a friend's track to play it; click the
 * playing-context (playlist/album) to navigate the user's library to it
 * (TODO: wire context navigation, currently click-track only).
 */

import { useEffect, useRef, useState } from 'react'

import { fetchFriendActivity, type FriendActivity } from '../api/friends'
import { play } from '../api/spotify'
import { useUI } from '../store/ui'

const REFRESH_MS = 60_000

export function FriendsOverlay() {
  const open = useUI((s) => s.friendsOpen)
  const close = useUI((s) => s.closeFriends)
  const [friends, setFriends] = useState<FriendActivity[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const lastRefreshAtRef = useRef(0)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        close()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, close])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    const refresh = async () => {
      setLoading(true)
      try {
        const list = await fetchFriendActivity()
        if (cancelled) return
        list.sort((a, b) => b.timestamp - a.timestamp)
        setFriends(list)
        setError(null)
        lastRefreshAtRef.current = Date.now()
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e))
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void refresh()
    const id = setInterval(() => void refresh(), REFRESH_MS)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [open])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-16 px-4"
      onClick={close}
    >
      <div
        className="absolute inset-0 bg-black/40"
        aria-hidden
      />
      <div
        onClick={(e) => e.stopPropagation()}
        className="relative bg-neutral-50 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-lg shadow-2xl w-full max-w-lg max-h-[70vh] flex flex-col overflow-hidden"
      >
        <header className="px-4 py-3 border-b border-neutral-200 dark:border-neutral-800 flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold">Friend activity</h2>
            <p className="text-[10px] text-neutral-500">
              {friends
                ? `${friends.length} friend${friends.length === 1 ? '' : 's'}${
                    loading ? ' · refreshing…' : ''
                  }`
                : loading
                  ? 'loading…'
                  : ''}
            </p>
          </div>
          <button
            onClick={close}
            className="text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200 text-lg leading-none"
            title="Close (esc)"
          >
            ×
          </button>
        </header>

        <div className="flex-1 overflow-y-auto">
          {error && (
            <p className="px-4 py-3 text-sm text-red-600 dark:text-red-400">
              {error}
            </p>
          )}

          {!error && friends && friends.length === 0 && (
            <p className="px-4 py-6 text-sm text-neutral-500 text-center">
              No friend activity right now.
            </p>
          )}

          {friends && friends.length > 0 && (
            <ul className="divide-y divide-neutral-200/60 dark:divide-neutral-800/60">
              {friends.map((f) => (
                <FriendRow
                  key={f.user.uri}
                  activity={f}
                  onPlay={async () => {
                    try {
                      await play({
                        contextUri: f.track.context?.uri,
                        offsetUri: f.track.uri,
                        uris: f.track.context?.uri ? undefined : [f.track.uri],
                      })
                      close()
                    } catch (e) {
                      console.error('play friend track failed:', e)
                    }
                  }}
                />
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}

function FriendRow({
  activity,
  onPlay,
}: {
  activity: FriendActivity
  onPlay: () => void
}) {
  const ago = formatAgo(Date.now() - activity.timestamp)
  return (
    <li className="px-4 py-3 hover:bg-neutral-100 dark:hover:bg-neutral-800/60">
      <div className="flex items-start gap-3">
        {activity.user.imageUrl ? (
          <img
            src={activity.user.imageUrl}
            alt=""
            className="w-9 h-9 rounded-full flex-shrink-0 object-cover"
          />
        ) : (
          <div className="w-9 h-9 rounded-full bg-neutral-300 dark:bg-neutral-700 flex-shrink-0" />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-sm font-medium truncate">
              {activity.user.name}
            </span>
            <span className="text-[10px] text-neutral-500 flex-shrink-0">
              {ago}
            </span>
          </div>
          <button
            onClick={onPlay}
            className="text-left w-full text-xs text-neutral-700 dark:text-neutral-300 hover:text-[var(--color-accent)] truncate block mt-0.5"
            title="Play this track"
          >
            {activity.track.name}
            <span className="text-neutral-500"> — {activity.track.artist.name}</span>
          </button>
          {activity.track.context && (
            <p className="text-[10px] text-neutral-500 truncate mt-0.5">
              from {activity.track.context.name}
            </p>
          )}
        </div>
      </div>
    </li>
  )
}

function formatAgo(deltaMs: number): string {
  if (deltaMs < 0) return 'now'
  const s = Math.floor(deltaMs / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  const d = Math.floor(h / 24)
  return `${d}d`
}
