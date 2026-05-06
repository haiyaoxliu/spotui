/**
 * Spotify Jam overlay — view / start / leave a group-listening session.
 *
 * State machine:
 *   - idle     (no jam):   "Start a Jam" button
 *   - active   (in jam):   share link, members list, leave button
 *   - error/loading state
 *
 * Cookie-only feature; the public Web API has no equivalent.
 *
 * Refreshes every 15s while open so member changes show up; not aggressive
 * enough to be a real-time view, but reasonable for a sidebar overlay.
 */

import { useEffect, useState } from 'react'

import {
  fetchCurrentJam,
  jamShareLink,
  leaveJam,
  startJam,
  type JamSession,
} from '../api/jam'
import { useUI } from '../store/ui'

const REFRESH_MS = 15_000

export function JamOverlay() {
  const open = useUI((s) => s.jamOpen)
  const close = useUI((s) => s.closeJam)

  const [session, setSession] = useState<JamSession | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

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
        const cur = await fetchCurrentJam()
        if (!cancelled) {
          setSession(cur)
          setError(null)
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
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

  const onStart = async () => {
    setBusy(true)
    setError(null)
    try {
      const fresh = await startJam()
      setSession(fresh)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const onLeave = async () => {
    if (!session) return
    setBusy(true)
    setError(null)
    try {
      await leaveJam(session.sessionId)
      setSession(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const onCopyLink = () => {
    if (!session) return
    const link = jamShareLink(session.joinSessionToken)
    navigator.clipboard?.writeText(link).catch(() => {})
  }

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-16 px-4"
      onClick={close}
    >
      <div className="absolute inset-0 bg-black/40" aria-hidden />
      <div
        onClick={(e) => e.stopPropagation()}
        className="relative bg-neutral-50 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-lg shadow-2xl w-full max-w-md max-h-[70vh] flex flex-col overflow-hidden"
      >
        <header className="px-4 py-3 border-b border-neutral-200 dark:border-neutral-800 flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold">Jam</h2>
            <p className="text-[10px] text-neutral-500">
              {session
                ? session.isSessionOwner
                  ? 'Hosting'
                  : 'Joined'
                : loading
                  ? 'checking…'
                  : 'Group listening'}
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

        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4 text-sm">
          {error && (
            <p className="text-red-600 dark:text-red-400">{error}</p>
          )}

          {!session && !loading && (
            <div className="space-y-3">
              <p className="text-neutral-600 dark:text-neutral-400">
                You're not in a Jam right now. Start one to listen with up to
                32 friends — anyone with the share link can join.
              </p>
              <button
                onClick={onStart}
                disabled={busy}
                className="w-full px-3 py-2 rounded bg-[var(--color-accent)] text-black font-medium disabled:opacity-50 hover:opacity-90"
              >
                {busy ? 'Starting…' : 'Start a Jam'}
              </button>
            </div>
          )}

          {session && (
            <>
              <section>
                <h3 className="text-[10px] font-semibold uppercase tracking-wider text-neutral-500 mb-2">
                  Invite link
                </h3>
                <div className="flex gap-2">
                  <input
                    readOnly
                    value={jamShareLink(session.joinSessionToken)}
                    onFocus={(e) => e.currentTarget.select()}
                    className="flex-1 px-2 py-1 text-xs rounded bg-neutral-100 dark:bg-neutral-800 border border-neutral-300 dark:border-neutral-700 font-mono"
                  />
                  <button
                    onClick={onCopyLink}
                    className="px-3 py-1 text-xs rounded bg-neutral-200 hover:bg-neutral-300 dark:bg-neutral-800 dark:hover:bg-neutral-700"
                    title="Copy"
                  >
                    Copy
                  </button>
                </div>
                <p className="text-[10px] text-neutral-500 mt-1">
                  {session.members.length} of {session.maxMemberCount} joined
                </p>
              </section>

              <section>
                <h3 className="text-[10px] font-semibold uppercase tracking-wider text-neutral-500 mb-2">
                  Members
                </h3>
                <ul className="space-y-2">
                  {session.members.map((m) => (
                    <li key={m.id} className="flex items-center gap-2">
                      {m.imageUrl ? (
                        <img
                          src={m.imageUrl}
                          alt=""
                          className="w-7 h-7 rounded-full object-cover flex-shrink-0"
                        />
                      ) : (
                        <div className="w-7 h-7 rounded-full bg-neutral-300 dark:bg-neutral-700 flex-shrink-0" />
                      )}
                      <span className="flex-1 truncate">
                        {m.displayName ?? m.username}
                        {m.isCurrentUser && (
                          <span className="ml-1 text-[10px] text-neutral-500">
                            (you)
                          </span>
                        )}
                      </span>
                      {m.id === session.sessionOwnerId && (
                        <span className="text-[10px] text-neutral-500">
                          host
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </section>

              <button
                onClick={onLeave}
                disabled={busy}
                className="w-full px-3 py-2 rounded bg-red-50 text-red-700 hover:bg-red-100 dark:bg-red-950/40 dark:text-red-300 dark:hover:bg-red-950/60 disabled:opacity-50"
              >
                {busy
                  ? 'Working…'
                  : session.isSessionOwner
                    ? 'End Jam'
                    : 'Leave Jam'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
