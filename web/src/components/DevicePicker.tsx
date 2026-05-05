import { useEffect, useState } from 'react'
import { useUI } from '../store/ui'
import { getDevices, transferPlayback, type Device } from '../api/spotify'

export function DevicePicker({ onAfterTransfer }: { onAfterTransfer: () => void }) {
  const open = useUI((s) => s.devicePickerOpen)
  const close = useUI((s) => s.closeDevicePicker)
  const [devices, setDevices] = useState<Device[]>([])
  const [selectedIdx, setSelectedIdx] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!open) return
    setLoading(true)
    setError(null)
    getDevices()
      .then((ds) => {
        setDevices(ds)
        const activeIdx = ds.findIndex((d) => d.is_active)
        setSelectedIdx(activeIdx >= 0 ? activeIdx : 0)
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false))
  }, [open])

  useEffect(() => {
    if (!open) return

    async function confirm() {
      const dev = devices[selectedIdx]
      if (!dev || !dev.id || dev.is_active) {
        close()
        return
      }
      try {
        await transferPlayback(dev.id)
        onAfterTransfer()
        close()
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      }
    }

    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault()
        close()
      } else if (e.key === 'j' || e.key === 'ArrowDown') {
        e.preventDefault()
        setSelectedIdx((i) => Math.min(i + 1, Math.max(devices.length - 1, 0)))
      } else if (e.key === 'k' || e.key === 'ArrowUp') {
        e.preventDefault()
        setSelectedIdx((i) => Math.max(i - 1, 0))
      } else if (e.key === 'Enter') {
        e.preventDefault()
        void confirm()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, devices, selectedIdx, close, onAfterTransfer])

  if (!open) return null

  async function rowClick(idx: number) {
    setSelectedIdx(idx)
    const dev = devices[idx]
    if (!dev || !dev.id || dev.is_active) {
      close()
      return
    }
    try {
      await transferPlayback(dev.id)
      onAfterTransfer()
      close()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-start justify-center pt-24 z-50"
      onClick={close}
    >
      <div
        className="bg-neutral-900 rounded-lg p-4 w-96 max-w-[90vw] shadow-xl border border-neutral-800"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-semibold mb-3">Select playback device</h2>
        {error && <p className="text-red-400 text-sm mb-2">{error}</p>}
        {loading && <p className="text-neutral-400 text-sm">Loading…</p>}
        {!loading && devices.length === 0 && !error && (
          <p className="text-neutral-400 text-sm">
            No devices found. Open Spotify on your phone, desktop app, or a speaker first.
          </p>
        )}
        {!loading && devices.length > 0 && (
          <ul className="space-y-1">
            {devices.map((d, i) => (
              <li
                key={d.id ?? d.name}
                className={
                  'px-3 py-2 rounded cursor-pointer ' +
                  (i === selectedIdx ? 'bg-neutral-700' : 'hover:bg-neutral-800')
                }
                onMouseEnter={() => setSelectedIdx(i)}
                onClick={() => void rowClick(i)}
              >
                <div className="flex items-center justify-between">
                  <span>
                    {d.name}{' '}
                    <span className="text-neutral-500 text-xs">({d.type})</span>
                  </span>
                  {d.is_active && (
                    <span className="text-[var(--color-accent)] text-xs">active</span>
                  )}
                  {d.is_restricted && (
                    <span className="text-yellow-500 text-xs ml-2">restricted</span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
        <p className="text-neutral-500 text-xs mt-3">
          j/k or ↓/↑ to navigate · Enter to switch · Esc to close
        </p>
      </div>
    </div>
  )
}
