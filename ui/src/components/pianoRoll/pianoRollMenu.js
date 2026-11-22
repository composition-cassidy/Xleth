// Piano Roll menus as plain data (rendered by timeline/TrackContextMenu, which does submenus).
// Every row runs a command from the roll's own command table, the one the keyboard uses, and
// prints that command's key combo, so the menu is the place to find out what the keys are.
import { formatCombo } from '../../windowing/managers/shortcutCatalog'
import { SCALE_MODES, ROOT_NOTES } from './scales.js'

// Commands that act on the selected notes. With nothing selected they would do nothing, so the
// menu greys them out instead of letting the click vanish.
const NEEDS_SELECTION = new Set([
  'cut', 'copy', 'delete', 'moveLeft', 'moveRight', 'rotateLeft', 'rotateRight',
  'stepUp', 'stepDown', 'octaveUp', 'octaveDown',
])

const SEP = { type: 'separator' }

/** The first combo bound to a command, spelled for display ("Ctrl + X"), or undefined. */
export function comboOf(keymap, command) {
  const combo = keymap?.[command]?.[0]
  return combo ? formatCombo(combo) : undefined
}

/** "Major / Ionian" -> "Major": the short mode name the Scale button prints. */
export function shortModeLabel(modeId) {
  const mode = SCALE_MODES.find((m) => m.id === modeId) || SCALE_MODES[0]
  return mode.label.split(' / ')[0]
}

export function buildPianoRollMenu({
  keymap, run, hasPattern, selectionCount,
  showGhosts, onShowGhostsChange, onZoomIn, onZoomOut, onOpenQuickNotation,
}) {
  const cmd = (label, command) => ({
    label,
    shortcut: comboOf(keymap, command),
    disabled: !hasPattern || (NEEDS_SELECTION.has(command) && !selectionCount),
    onClick: () => run(command),
  })
  return [
    {
      label: 'Edit',
      submenu: [
        cmd('Undo', 'undo'), cmd('Redo', 'redo'), SEP,
        cmd('Cut', 'cut'), cmd('Copy', 'copy'), cmd('Paste', 'paste'),
        cmd('Duplicate', 'duplicate'), cmd('Delete', 'delete'), SEP,
        cmd('Shift left', 'moveLeft'), cmd('Shift right', 'moveRight'),
        cmd('Rotate left', 'rotateLeft'), cmd('Rotate right', 'rotateRight'), SEP,
        cmd('Transpose up', 'stepUp'), cmd('Transpose down', 'stepDown'),
        cmd('Transpose octave up', 'octaveUp'), cmd('Transpose octave down', 'octaveDown'), SEP,
        cmd('Discard lengths', 'discardLengths'),
      ],
    },
    {
      label: 'Select',
      submenu: [
        cmd('All', 'selectAll'), cmd('None', 'deselect'), cmd('Invert', 'invertSelection'),
        cmd('Random', 'randomSelection'), cmd('Off grid', 'offGridSelection'), SEP,
        cmd('Time range around selection', 'timeAround'),
        cmd('Previous time range', 'timeBefore'), cmd('Next time range', 'timeAfter'),
      ],
    },
    {
      label: 'Space',
      submenu: [
        cmd('Insert space', 'insertSpace'),
        cmd('Slice and insert space', 'sliceInsertSpace'),
        cmd('Delete space', 'deleteSpace'),
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Ghost notes', checked: !!showGhosts, onClick: () => onShowGhostsChange?.(!showGhosts) },
        SEP,
        { label: 'Zoom in', onClick: onZoomIn },
        { label: 'Zoom out', onClick: onZoomOut },
      ],
    },
    SEP,
    { label: 'Quick notation…', disabled: !hasPattern, onClick: onOpenQuickNotation },
    cmd('Import MIDI…', 'importMidi'),
  ]
}

export function buildScaleMenu({ scale, onScaleChange }) {
  const modeLabel = shortModeLabel(scale.mode)
  return [
    { label: 'Snap to scale', checked: scale.enabled, onClick: () => onScaleChange?.({ ...scale, enabled: !scale.enabled }) },
    SEP,
    {
      label: `Root: ${ROOT_NOTES[scale.root] ?? 'C'}`,
      submenu: ROOT_NOTES.map((name, i) => ({
        label: name, checked: scale.root === i, onClick: () => onScaleChange?.({ ...scale, root: i }),
      })),
    },
    {
      label: `Mode: ${modeLabel}`,
      submenu: SCALE_MODES.map((m) => ({
        label: m.label, checked: scale.mode === m.id, onClick: () => onScaleChange?.({ ...scale, mode: m.id }),
      })),
    },
  ]
}
