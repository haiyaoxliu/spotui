import { useEffect } from 'react'
import { useUI } from '../store/ui'

interface Binding {
  keys: string
  action: string
}

const GLOBAL: Binding[] = [
  { keys: 'space', action: 'Play / pause' },
  { keys: 'j  /  →', action: 'Next track' },
  { keys: 'k  /  ←', action: 'Previous track' },
  { keys: 's', action: 'Toggle shuffle' },
  { keys: 'r', action: 'Cycle repeat' },
  { keys: ',  /  .', action: 'Seek -10s / +10s' },
  { keys: '-  /  =  /  +', action: 'Volume -5 / +5' },
  { keys: 'd', action: 'Open device picker' },
  { keys: '/', action: 'Focus search' },
  { keys: '?', action: 'Toggle this help' },
]

const ROW: Binding[] = [
  { keys: 'click', action: 'Focus row (does not play)' },
  { keys: 'double-click  /  Enter', action: 'Play focused row' },
  { keys: 'q', action: 'Queue focused track' },
  { keys: 'Q  (shift+q)', action: 'Play focused track stand-alone' },
  { keys: 'a', action: 'Add focused track to open playlist' },
  { keys: 'l', action: 'Like / unlike focused track (or playing)' },
]

const SEARCH: Binding[] = [
  { keys: 'Esc', action: 'Clear query, then unfocus' },
]

const DEVICE_PICKER: Binding[] = [
  { keys: 'j  /  ↓', action: 'Move down' },
  { keys: 'k  /  ↑', action: 'Move up' },
  { keys: 'Enter', action: 'Switch to highlighted device' },
  { keys: 'Esc', action: 'Close picker' },
]

export function HelpOverlay() {
  const open = useUI((s) => s.helpOpen)
  const close = useUI((s) => s.closeHelp)

  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' || e.key === '?') {
        e.preventDefault()
        close()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, close])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-start justify-center pt-16 z-50"
      onClick={close}
    >
      <div
        className="bg-neutral-900 rounded-lg p-6 w-[640px] max-w-[92vw] max-h-[80vh] overflow-auto shadow-xl border border-neutral-800"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-baseline justify-between mb-4">
          <h2 className="text-base font-semibold">Keybinds</h2>
          <span className="text-neutral-500 text-xs">Esc or ? to close</span>
        </div>
        <Section title="Global" bindings={GLOBAL} />
        <Section title="Focused row (in playlist or search results)" bindings={ROW} />
        <Section title="Search input" bindings={SEARCH} />
        <Section title="Device picker" bindings={DEVICE_PICKER} />
      </div>
    </div>
  )
}

function Section({ title, bindings }: { title: string; bindings: Binding[] }) {
  return (
    <div className="mb-4 last:mb-0">
      <h3 className="text-xs uppercase tracking-wider text-neutral-400 mb-2">{title}</h3>
      <ul className="space-y-1">
        {bindings.map((b) => (
          <li key={b.keys} className="flex items-baseline gap-4 text-sm">
            <span className="font-mono text-yellow-400 text-xs w-44 shrink-0">{b.keys}</span>
            <span className="text-neutral-200">{b.action}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
