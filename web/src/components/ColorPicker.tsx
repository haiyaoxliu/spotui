import { useEffect, useState } from 'react'
import { useUI, DEFAULT_ACCENT, DEFAULT_EXTERNAL } from '../store/ui'

const HEX_RE = /^#[0-9a-fA-F]{6}$/

export function ColorPicker() {
  const open = useUI((s) => s.colorPickerOpen)
  const close = useUI((s) => s.closeColorPicker)
  const accent = useUI((s) => s.accentColor)
  const external = useUI((s) => s.externalColor)
  const setAccent = useUI((s) => s.setAccentColor)
  const setExternal = useUI((s) => s.setExternalColor)
  const reset = useUI((s) => s.resetColors)

  // Hex inputs are local because users mid-typing produce invalid strings;
  // commit to the store only when the value parses as a valid hex.
  const [accentHex, setAccentHex] = useState(accent)
  const [externalHex, setExternalHex] = useState(external)

  useEffect(() => setAccentHex(accent), [accent])
  useEffect(() => setExternalHex(external), [external])

  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' || e.key === 'c') {
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
      className="fixed inset-0 bg-black/60 flex items-start justify-center pt-24 z-50"
      onClick={close}
    >
      <div
        className="bg-neutral-900 rounded-lg p-5 w-96 max-w-[90vw] shadow-xl border border-neutral-800"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-baseline justify-between mb-4">
          <h2 className="text-base font-semibold">Customize colors</h2>
          <span className="text-neutral-500 text-xs">Esc or c to close</span>
        </div>

        <Row
          label="Selection accent"
          help="Focused row, active state, liked heart, playing indicator."
          value={accent}
          hexInput={accentHex}
          onPickerChange={setAccent}
          onHexChange={(v) => {
            setAccentHex(v)
            if (HEX_RE.test(v)) setAccent(v)
          }}
        />

        <Row
          label="External playlist"
          help="Read-only playlists you don't own (e.g. Discover Weekly)."
          value={external}
          hexInput={externalHex}
          onPickerChange={setExternal}
          onHexChange={(v) => {
            setExternalHex(v)
            if (HEX_RE.test(v)) setExternal(v)
          }}
        />

        <div className="flex items-center justify-between mt-5 pt-3 border-t border-neutral-800">
          <button
            onClick={reset}
            className="text-xs text-neutral-400 hover:text-neutral-200"
            title={`Reset to ${DEFAULT_ACCENT} / ${DEFAULT_EXTERNAL}`}
          >
            Reset to defaults
          </button>
          <button
            onClick={close}
            className="px-3 py-1 rounded bg-neutral-800 hover:bg-neutral-700 text-xs"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  )
}

function Row({
  label,
  help,
  value,
  hexInput,
  onPickerChange,
  onHexChange,
}: {
  label: string
  help: string
  value: string
  hexInput: string
  onPickerChange: (c: string) => void
  onHexChange: (c: string) => void
}) {
  return (
    <div className="mb-4 last:mb-0">
      <div className="flex items-center gap-3 mb-1">
        <span className="text-sm flex-1">{label}</span>
        <input
          type="color"
          value={value}
          onChange={(e) => onPickerChange(e.target.value)}
          className="w-8 h-8 rounded cursor-pointer bg-transparent border border-neutral-700"
        />
        <input
          type="text"
          value={hexInput}
          onChange={(e) => onHexChange(e.target.value)}
          maxLength={7}
          className={
            'w-24 px-2 py-1 rounded bg-neutral-800 border text-xs font-mono ' +
            (HEX_RE.test(hexInput) ? 'border-neutral-700' : 'border-red-700')
          }
          spellCheck={false}
        />
      </div>
      <p className="text-[11px] text-neutral-500">{help}</p>
    </div>
  )
}
