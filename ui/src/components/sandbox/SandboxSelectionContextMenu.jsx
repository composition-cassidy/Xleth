import useSandboxStore from '../../stores/sandboxStore.js'
import { Menu, MenuCustom, MenuItem, MenuSeparator } from '../../ui-kit'
import { formatSamplesShort } from './sandboxFormat.js'
import { effectEntry, sentenceCase, useSandboxEffects } from './useSandboxEffects.js'
import styles from './Sandbox.module.css'

// ── Right-click on the waveform ─────────────────────────────────────────────
//
// Every edit in this panel lived behind the Effect menu — the top-left corner
// of the panel, as far as it is possible to get from the selection you just
// dragged. Right-clicking a selection is the gesture people actually try first
// in an audio editor.
//
// This runs the SAME registry entries the action bar and the Effects menu do
// (sandboxEffectRegistry.js, through useSandboxEffects), so the three can never
// offer different behaviour for the same operation — this is another door,
// never another implementation. It shows only the entries that act on a time
// selection or the cursor, because that is what was right-clicked; everything
// else stays in the full menu. It is a kit Menu, so keyboard, outside-press and
// focus return are the kit's.
const CONTEXT_ENTRY_IDS = [
  'cut', 'copy', 'paste', 'trim', 'silence', 'fadeIn', 'fadeOut', 'gain', 'normalize', 'reverse',
]

export default function SandboxSelectionContextMenu({ at, onClose }) {
  const selection = useSandboxStore((s) => s.selection)
  const zoomToSelection = useSandboxStore((s) => s.zoomToSelection)
  const selectAll = useSandboxStore((s) => s.selectAll)
  const { layer, hasSelection, sampleRate, reasonFor, hintFor, run } = useSandboxEffects()

  if (!layer) return null

  const entries = CONTEXT_ENTRY_IDS.map(effectEntry).filter(Boolean)

  return (
    <Menu x={at.x} y={at.y} onClose={onClose} label="Selection">
      <MenuCustom>
        <div className={styles.menuCat}>
          {hasSelection
            ? `Selection, ${formatSamplesShort(selection.endSample - selection.startSample, sampleRate)}`
            : 'No selection: edits apply to the whole layer'}
        </div>
      </MenuCustom>
      {entries.map((entry) => (
        <MenuItem key={entry.id} disabled={!!reasonFor(entry)} onSelect={() => run(entry)}>
          <span title={hintFor(entry)}>{sentenceCase(entry.label)}</span>
        </MenuItem>
      ))}
      <MenuSeparator />
      <MenuItem onSelect={() => selectAll()}>
        <span className={styles.itemLine}>
          <span>Select all</span>
          <kbd className={styles.kbd}>Ctrl+A</kbd>
        </span>
      </MenuItem>
      <MenuItem disabled={!hasSelection} onSelect={() => zoomToSelection()}>
        <span className={styles.itemLine}>
          <span>Zoom to selection</span>
          <kbd className={styles.kbd}>Ctrl+E</kbd>
        </span>
      </MenuItem>
    </Menu>
  )
}
