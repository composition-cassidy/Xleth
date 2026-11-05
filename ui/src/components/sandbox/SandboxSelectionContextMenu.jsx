import { useEffect, useRef } from 'react'
import useSandboxStore, { hasMeaningfulSelection } from '../../stores/sandboxStore.js'
import { EFFECT_REGISTRY } from '../../stores/sandboxEffectRegistry.js'
import { formatSamplesShort } from './sandboxFormat.js'

// ── Right-click on the waveform ─────────────────────────────────────────────
//
// Every edit in this panel lived behind the EFFECT ▾ menu bar — the top-left
// corner of the panel, as far as it is possible to get from the selection you
// just dragged. Right-clicking a selection is the gesture people actually try
// first in an audio editor, and it did nothing.
//
// This runs the SAME registry entries EFFECT ▾ does (sandboxEffectRegistry.js)
// through the same `entry.run`, so the two menus can never offer different
// behaviour for the same operation — this is a second door, never a second
// implementation. It shows only the handful of entries that act on a time
// selection, because that is what was right-clicked; everything else stays in
// the full menu.
const CONTEXT_ENTRY_IDS = [
  'cut', 'copy', 'paste', 'trim', 'silence', 'fadeIn', 'fadeOut', 'normalize', 'reverse',
]

export default function SandboxSelectionContextMenu({ at, onClose }) {
  const layers = useSandboxStore((s) => s.layers)
  const activeLayerId = useSandboxStore((s) => s.activeLayerId)
  const selection = useSandboxStore((s) => s.selection)
  const clipboard = useSandboxStore((s) => s.clipboard)
  const zoomToSelection = useSandboxStore((s) => s.zoomToSelection)
  const ref = useRef(null)

  const layer = layers.find((l) => l.id === activeLayerId) ?? null
  const sampleRate = layer?.renderedBuffer?.sampleRate
  const hasSelection = hasMeaningfulSelection(selection, sampleRate)

  useEffect(() => {
    const onDown = (e) => { if (!ref.current?.contains(e.target)) onClose() }
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  if (!layer) return null

  const entries = CONTEXT_ENTRY_IDS
    .map((id) => EFFECT_REGISTRY.find((e) => e.id === id))
    .filter(Boolean)

  const reasonFor = (entry) => {
    if (entry.alwaysDisabled) return entry.disabledReason
    if (entry.needsSelection && !hasSelection) return 'Select a range first'
    if (entry.needsClipboard && !clipboard) return 'Clipboard is empty'
    if (entry.maxInstances < Infinity && layer.ops.filter(entry.matchesStack).length >= entry.maxInstances) {
      return `${entry.whyNoMulti || 'one instance max'} — already in stack`
    }
    return null
  }

  const run = (entry) => {
    const store = useSandboxStore.getState()
    entry.run(store, {
      layerId: layer.id,
      selection: store.selection,
      cursorSample: store.selection?.startSample ?? 0,
      hasSelection,
    })
    onClose()
  }

  // Position is clamped so a right-click near the panel's right or bottom edge
  // does not open a menu half outside it.
  const style = {
    left: Math.min(at.x, window.innerWidth - 190),
    top: Math.min(at.y, window.innerHeight - 260),
  }

  return (
    <div className="sandbox-context-menu" style={style} ref={ref}>
      <div className="sandbox-context-menu-head">
        {hasSelection
          ? `Selection · ${formatSamplesShort(selection.endSample - selection.startSample, sampleRate)}`
          : 'No selection'}
      </div>
      {entries.map((entry) => {
        const reason = reasonFor(entry)
        return (
          <button
            key={entry.id}
            type="button"
            className={`sandbox-context-item${reason ? ' disabled' : ''}`}
            disabled={!!reason}
            title={reason || ''}
            onClick={() => run(entry)}
          >
            {entry.label}
          </button>
        )
      })}
      <div className="sandbox-context-sep" />
      <button
        type="button"
        className={`sandbox-context-item${hasSelection ? '' : ' disabled'}`}
        disabled={!hasSelection}
        onClick={() => { zoomToSelection(); onClose() }}
      >
        Zoom to Selection<span className="sandbox-context-key">Ctrl+E</span>
      </button>
    </div>
  )
}
