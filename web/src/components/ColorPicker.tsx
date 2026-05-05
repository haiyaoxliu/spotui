import { useEffect, useState } from 'react'
import {
  useUI,
  DEFAULT_ACCENT_DARK,
  DEFAULT_ACCENT_LIGHT,
  DEFAULT_EXTERNAL_DARK,
  DEFAULT_EXTERNAL_LIGHT,
  type Theme,
} from '../store/ui'

const HEX_RE = /^#[0-9a-fA-F]{6}$/

export function ColorPicker() {
  const open = useUI((s) => s.colorPickerOpen)
  const close = useUI((s) => s.closeColorPicker)
  const theme = useUI((s) => s.theme)
  const setTheme = useUI((s) => s.setTheme)
  const accentDark = useUI((s) => s.accentColorDark)
  const accentLight = useUI((s) => s.accentColorLight)
  const externalDark = useUI((s) => s.externalColorDark)
  const externalLight = useUI((s) => s.externalColorLight)
  const setAccent = useUI((s) => s.setAccentColor)
  const setExternal = useUI((s) => s.setExternalColor)
  const reset = useUI((s) => s.resetColors)

  // Editing operates on the profile selected in the modal — defaults to the
  // currently active theme but can be flipped without leaving the picker, so
  // users can tune both palettes back-to-back. Switching the editing tab also
  // applies that theme live so the preview matches what they're tweaking.
  const [editing, setEditing] = useState<Theme>(theme)
  useEffect(() => {
    if (open) setEditing(theme)
  }, [open, theme])

  const accent = editing === 'dark' ? accentDark : accentLight
  const external = editing === 'dark' ? externalDark : externalLight
  const defaultAccent = editing === 'dark' ? DEFAULT_ACCENT_DARK : DEFAULT_ACCENT_LIGHT
  const defaultExternal =
    editing === 'dark' ? DEFAULT_EXTERNAL_DARK : DEFAULT_EXTERNAL_LIGHT

  // Hex inputs are local because users mid-typing produce invalid strings;
  // commit to the store only when the value parses as a valid hex.
  const [accentHex, setAccentHex] = useState(accent)
  const [externalHex, setExternalHex] = useState(external)

  useEffect(() => setAccentHex(accent), [accent])
  useEffect(() => setExternalHex(external), [external])

  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === 'Escape' || e.key === 'c') {
        e.preventDefault()
        close()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, close])

  if (!open) return null

  function selectEditing(next: Theme) {
    setEditing(next)
    if (theme !== next) setTheme(next)
  }

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-start justify-center pt-24 z-50"
      onClick={close}
    >
      <div
        className="bg-white dark:bg-neutral-900 rounded-lg p-5 w-96 max-w-[90vw] shadow-xl border border-neutral-200 dark:border-neutral-800"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-baseline justify-between mb-4">
          <h2 className="text-base font-semibold">Customize colors</h2>
          <span className="text-neutral-500 text-xs">Esc or c to close</span>
        </div>

        <div className="flex items-center gap-2 mb-4 text-xs">
          <span className="text-neutral-500">Profile</span>
          <div className="flex rounded overflow-hidden border border-neutral-200 dark:border-neutral-800">
            <button
              onClick={() => selectEditing('dark')}
              className={
                'px-3 py-1 ' +
                (editing === 'dark'
                  ? 'bg-neutral-300 text-neutral-900 dark:bg-neutral-700 dark:text-neutral-100'
                  : 'bg-white hover:bg-neutral-200 text-neutral-600 dark:bg-neutral-900 dark:hover:bg-neutral-800 dark:text-neutral-400')
              }
            >
              Dark
            </button>
            <button
              onClick={() => selectEditing('light')}
              className={
                'px-3 py-1 ' +
                (editing === 'light'
                  ? 'bg-neutral-300 text-neutral-900 dark:bg-neutral-700 dark:text-neutral-100'
                  : 'bg-white hover:bg-neutral-200 text-neutral-600 dark:bg-neutral-900 dark:hover:bg-neutral-800 dark:text-neutral-400')
              }
            >
              Light
            </button>
          </div>
        </div>

        <Row
          label="Selection accent"
          help="Focused row, active state, liked heart, playing indicator."
          value={accent}
          hexInput={accentHex}
          onPickerChange={(c) => setAccent(editing, c)}
          onHexChange={(v) => {
            setAccentHex(v)
            if (HEX_RE.test(v)) setAccent(editing, v)
          }}
        />

        <Row
          label="External playlist"
          help="Read-only playlists you don't own (e.g. Discover Weekly)."
          value={external}
          hexInput={externalHex}
          onPickerChange={(c) => setExternal(editing, c)}
          onHexChange={(v) => {
            setExternalHex(v)
            if (HEX_RE.test(v)) setExternal(editing, v)
          }}
        />

        <div className="flex items-center justify-between mt-5 pt-3 border-t border-neutral-200 dark:border-neutral-800">
          <button
            onClick={() => reset(editing)}
            className="text-xs text-neutral-600 hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-200"
            title={`Reset ${editing} profile to ${defaultAccent} / ${defaultExternal}`}
          >
            Reset {editing} to defaults
          </button>
          <button
            onClick={close}
            className="px-3 py-1 rounded bg-neutral-200 hover:bg-neutral-300 dark:bg-neutral-800 dark:hover:bg-neutral-700 text-xs"
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
          className="w-8 h-8 rounded cursor-pointer bg-transparent border border-neutral-300 dark:border-neutral-700"
        />
        <input
          type="text"
          value={hexInput}
          onChange={(e) => onHexChange(e.target.value)}
          maxLength={7}
          className={
            'w-24 px-2 py-1 rounded bg-neutral-100 dark:bg-neutral-800 border text-xs font-mono ' +
            (HEX_RE.test(hexInput) ? 'border-neutral-300 dark:border-neutral-700' : 'border-red-500 dark:border-red-700')
          }
          spellCheck={false}
        />
      </div>
      <p className="text-[11px] text-neutral-500">{help}</p>
    </div>
  )
}
