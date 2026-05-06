/**
 * Right-edge slide-in drawer that consolidates layout + theme toggles and
 * the log-out action. Replaces the old strip of buttons that lived in the
 * header. Device picker and help (`d` and `?`) stay outside since they're
 * primary actions, not preferences.
 */

import { useEffect } from 'react'

import { hasPkce, isCookieMode, login, logout } from '../auth/auth'
import { useUI } from '../store/ui'

export function ControlPane() {
  const open = useUI((s) => s.controlPaneOpen)
  const close = useUI((s) => s.closeControlPane)
  const theme = useUI((s) => s.theme)
  const toggleTheme = useUI((s) => s.toggleTheme)
  const searchPosition = useUI((s) => s.searchPosition)
  const setSearchPosition = useUI((s) => s.setSearchPosition)
  const detailLayout = useUI((s) => s.detailLayout)
  const setDetailLayout = useUI((s) => s.setDetailLayout)
  const transportPosition = useUI((s) => s.transportPosition)
  const setTransportPosition = useUI((s) => s.setTransportPosition)
  const openColorPicker = useUI((s) => s.openColorPicker)

  // Close on esc when open. Other keybinds (s to toggle) live in App.tsx
  // alongside the rest of the global shortcuts.
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

  return (
    <>
      {/* Backdrop — clicking it closes. Hidden when drawer is closed so
       *  it doesn't intercept pointer events on the rest of the UI. */}
      <div
        className={
          'fixed inset-0 bg-black/30 transition-opacity duration-200 z-40 ' +
          (open
            ? 'opacity-100 pointer-events-auto'
            : 'opacity-0 pointer-events-none')
        }
        onClick={close}
      />
      <aside
        aria-hidden={!open}
        className={
          'fixed top-0 right-0 h-full w-72 z-50 ' +
          'bg-neutral-50 dark:bg-neutral-900 border-l border-neutral-200 dark:border-neutral-800 ' +
          'shadow-2xl flex flex-col ' +
          'transition-transform duration-200 ' +
          (open ? 'translate-x-0' : 'translate-x-full')
        }
      >
        <div className="px-4 py-3 border-b border-neutral-200 dark:border-neutral-800 flex items-center justify-between">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-neutral-600 dark:text-neutral-400">
            Settings
          </h2>
          <button
            onClick={close}
            className="text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200 text-lg leading-none"
            title="Close (esc)"
          >
            ×
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-5 text-sm">
          <Section label="Layout">
            <Toggle
              label="Search position"
              value={searchPosition}
              options={['above', 'below']}
              onSelect={(v) => setSearchPosition(v as typeof searchPosition)}
            />
            <Toggle
              label="Row details"
              value={detailLayout}
              options={['below', 'right']}
              onSelect={(v) => setDetailLayout(v as typeof detailLayout)}
            />
            <Toggle
              label="Transport bar"
              value={transportPosition}
              options={['bottom', 'right']}
              onSelect={(v) =>
                setTransportPosition(v as typeof transportPosition)
              }
            />
          </Section>

          <Section label="Appearance">
            <Toggle
              label="Theme"
              value={theme}
              options={['light', 'dark']}
              onSelect={() => toggleTheme()}
            />
            <button
              onClick={() => {
                openColorPicker()
                close()
              }}
              className="w-full text-left px-3 py-2 rounded bg-neutral-200/60 hover:bg-neutral-200 dark:bg-neutral-800/60 dark:hover:bg-neutral-800"
            >
              Customize colors…
            </button>
          </Section>

          <Section label="Authentication">
            <AuthStatusRows />
          </Section>

          <Section label="Account">
            <button
              onClick={() => {
                logout()
                window.location.reload()
              }}
              className="w-full text-left px-3 py-2 rounded bg-red-50 text-red-700 hover:bg-red-100 dark:bg-red-950/40 dark:text-red-300 dark:hover:bg-red-950/60"
            >
              Log out
            </button>
          </Section>
        </div>
      </aside>
    </>
  )
}

/**
 * Shows which auth pools are active and offers a PKCE bootstrap button.
 *
 * Cookie-mint tokens (Spotify's Web Player client_id) are the primary
 * pool — they're what Pathfinder, connect-state, spclient, AND /v1 use,
 * so the SPA stays on a single identity per Spotify's rate-limit
 * accounting. Connecting a PKCE bearer (private dev-app client_id) adds
 * a separate pool that `api/client.ts` escalates to on a 429 from the
 * cookie pool — a quieter neighbor for the rare /v1 calls that come
 * under heavy load.
 */
function AuthStatusRows() {
  const cookie = isCookieMode()
  const pkce = hasPkce()
  const v1Source = cookie
    ? `cookie (Web Player)${pkce ? ' · PKCE on 429' : ''}`
    : pkce
      ? 'PKCE (dev app)'
      : 'none'
  return (
    <div className="space-y-2 text-xs">
      <Row label="Cookie session" value={cookie ? 'active' : 'off'} ok={cookie} />
      <Row label="PKCE bearer" value={pkce ? 'connected' : 'not connected'} ok={pkce} />
      <Row label="/v1 calls go via" value={v1Source} ok={pkce || cookie} />
      {!pkce && (
        <button
          onClick={() => {
            void login()
          }}
          className="w-full text-left mt-2 px-3 py-2 rounded bg-neutral-200/60 hover:bg-neutral-200 dark:bg-neutral-800/60 dark:hover:bg-neutral-800 text-neutral-700 dark:text-neutral-200"
          title="Run the OAuth flow to get a private-client /v1 bearer (separate rate-limit pool, used as 429 fallback)"
        >
          Connect Spotify dev app for /v1 fallback…
        </button>
      )}
    </div>
  )
}

function Row({ label, value, ok }: { label: string; value: string; ok: boolean }) {
  return (
    <div className="flex items-center justify-between gap-2 px-1">
      <span className="text-neutral-600 dark:text-neutral-400">{label}</span>
      <span
        className={
          ok
            ? 'text-green-700 dark:text-green-400'
            : 'text-neutral-500 dark:text-neutral-500'
        }
      >
        {value}
      </span>
    </div>
  )
}

function Section({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <section>
      <h3 className="text-[10px] font-semibold uppercase tracking-wider text-neutral-500 mb-2">
        {label}
      </h3>
      <div className="space-y-1">{children}</div>
    </section>
  )
}

function Toggle({
  label,
  value,
  options,
  onSelect,
}: {
  label: string
  value: string
  options: readonly string[]
  onSelect: (next: string) => void
}) {
  return (
    <div className="flex items-center justify-between gap-2 px-1 py-1">
      <span className="text-neutral-600 dark:text-neutral-400 text-xs">
        {label}
      </span>
      <div className="flex rounded overflow-hidden border border-neutral-300 dark:border-neutral-700">
        {options.map((opt) => {
          const active = opt === value
          return (
            <button
              key={opt}
              onClick={() => onSelect(opt)}
              className={
                'px-2 py-0.5 text-[11px] capitalize ' +
                (active
                  ? 'bg-[var(--color-accent)] text-[var(--color-text-on-accent)]'
                  : 'bg-neutral-100 hover:bg-neutral-200 dark:bg-neutral-800 dark:hover:bg-neutral-700 text-neutral-600 dark:text-neutral-300')
              }
              style={
                active
                  ? { color: 'var(--color-bg)', mixBlendMode: 'normal' }
                  : undefined
              }
            >
              {opt}
            </button>
          )
        })}
      </div>
    </div>
  )
}
