// The Motion view key menu (docs/XLETH_MOTION_VIEW_DESIGN.md 5.4, R5): what a
// right-click on the key area (key rows or the graph) offers for the key selection.
// Pure: builds plain items; MotionView renders them with the kit Menu.
//
//   Hold / Linear / Ease out, then the Bezier presets (the interp of the segment
//   LEAVING each key; checked when every selected key has it), Copy, Paste, Delete,
//   and "Nudge this note" on a hollow (hit-curve) key.

import { BEZIER_PRESETS, sanitizeBez } from '../../lensRoam/lensKeyModel.js'
import { dedupeByTarget } from '../../motion/motionGestureModel.js'

export const INTERP_ITEMS = Object.freeze([
  { interp: 'Hold', label: 'Hold' },
  { interp: 'Linear', label: 'Linear' },
  { interp: 'EaseOut', label: 'Ease out' },
])

const sameBez = (a, b) => {
  const x = sanitizeBez(a)
  const y = sanitizeBez(b)
  return x.every((v, i) => Math.abs(v - y[i]) < 1e-9)
}

/**
 * @param {object} o
 * @param {object[]} o.instances  the selected key instances
 * @param {object|null} o.hitKey  the key under the pointer (null on empty space)
 * @param {boolean} o.canPaste    the clipboard holds keys
 * @param {{ interp(interp, bez?), copy(), paste(), remove(), nudgeNote(inst) }} o.on
 * @returns {Array<{ id, label, checked?, disabled?, danger?, onSelect } | { separator: true }>}
 */
export function keyMenuItems({ instances = [], hitKey = null, canPaste = false, on }) {
  const targets = [...dedupeByTarget(instances).values()]
  const n = targets.length
  const all = (pred) => n > 0 && targets.every(pred)
  const items = INTERP_ITEMS.map(({ interp, label }) => ({
    id: `interp:${interp}`,
    label,
    checked: all((k) => (k.interp ?? 'Linear') === interp),
    disabled: n === 0,
    onSelect: () => on.interp(interp),
  }))
  items.push({ separator: true })
  for (const p of BEZIER_PRESETS) {
    items.push({
      id: `bezier:${p.id}`,
      label: `Bezier: ${p.label}`,
      checked: all((k) => k.interp === 'Bezier' && sameBez(k.bez, p.bez)),
      disabled: n === 0,
      onSelect: () => on.interp('Bezier', p.bez),
    })
  }
  items.push({ separator: true })
  items.push({ id: 'copy', label: n > 1 ? `Copy ${n} keys` : 'Copy key', disabled: n === 0, onSelect: () => on.copy() })
  items.push({ id: 'paste', label: 'Paste keys at the playhead', disabled: !canPaste, onSelect: () => on.paste() })
  items.push({ id: 'delete', label: n > 1 ? `Delete ${n} keys` : 'Delete key', danger: true, disabled: n === 0, onSelect: () => on.remove() })
  if (hitKey?.hollow && hitKey.ref?.kind === 'hit') {
    items.push({ separator: true })
    items.push({ id: 'nudgeNote', label: 'Nudge this note', onSelect: () => on.nudgeNote(hitKey) })
  }
  return items
}

export default keyMenuItems
