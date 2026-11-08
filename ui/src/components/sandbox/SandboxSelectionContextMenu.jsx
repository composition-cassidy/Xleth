import useSandboxStore, { hasMeaningfulSelection } from '../../stores/sandboxStore.js'
import { EFFECT_REGISTRY } from '../../stores/sandboxEffectRegistry.js'
import { Menu, MenuCustom, MenuItem, MenuSeparator } from '../../ui-kit'
import { formatSamplesShort } from './sandboxFormat.js'
import styles from './Sandbox.module.css'

// ── Right-click on the waveform ─────────────────────────────────────────────
//
// Every edit in this panel lived behind the Effect menu — the top-left corner
// of the panel, as far as it is possible to get from the selection you just
// dragged. Right-clicking a selection is the gesture people actually try first
// in an audio editor.
//
// This runs the SAME registry entries the Effect menu does
// (sandboxEffectRegistry.js) through the same `entry.run`, so the two menus can
// never offer different behaviour for the same operation — this is a second
// door, never a second implementation. It shows only the handful of entries
// that act on a time selection, because that is what was right-clicked;
// everything else stays in the full menu. It is a kit Menu, so keyboard,
// outside-press and focus return are the kit's.
const CONTEXT_ENTRY_IDS = [
  'cut', 'copy', 'paste', 'trim', 'silence', 'fadeIn', 'fadeOut', 'normalize', 'reverse',
]

/** "Fade In" -> "Fade in": the registry's labels are title case, the UI is sentence case. */
const sentence = (s) => (s ? s.charAt(0) + s.slice(1).toLowerCase() : s)

export default function SandboxSelectionContextMenu({ at, onClose }) {
  const layers = useSandboxStore((s) => s.layers)
  const activeLayerId = useSandboxStore((s) => s.activeLayerId)
  const selection = useSandboxStore((s) => s.selection)
  const clipboard = useSandboxStore((s) => s.clipboard)
  const zoomToSelection = useSandboxStore((s) => s.zoomToSelection)

  const layer = layers.find((l) => l.id === activeLayerId) ?? null
  const sampleRate = layer?.renderedBuffer?.sampleRate
  const hasSelection = hasMeaningfulSelection(selection, sampleRate)

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
  }

  return (
    <Menu x={at.x} y={at.y} onClose={onClose} label="Selection">
      <MenuCustom>
        <div className={styles.menuCat}>
          {hasSelection
            ? `Selection · ${formatSamplesShort(selection.endSample - selection.startSample, sampleRate)}`
            : 'No selection'}
        </div>
      </MenuCustom>
      {entries.map((entry) => {
        const reason = reasonFor(entry)
        return (
          <MenuItem key={entry.id} disabled={!!reason} onSelect={() => run(entry)}>
            <span title={reason || ''}>{sentence(entry.label)}</span>
          </MenuItem>
        )
      })}
      <MenuSeparator />
      <MenuItem disabled={!hasSelection} onSelect={() => zoomToSelection()}>
        <span className={styles.itemLine}>
          <span>Zoom to selection</span>
          <kbd className={styles.kbd}>Ctrl+E</kbd>
        </span>
      </MenuItem>
    </Menu>
  )
}
