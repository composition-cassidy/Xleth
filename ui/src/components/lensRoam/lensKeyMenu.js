// The Advanced Lens editor lanes' right-click menu: set the interpolation of every
// selected own key (Hold, Linear, Ease out, or Bezier from a preset shape) or delete
// them. The twin of components/timeline/roamKeyMenu.js for a lane that edits through
// onOp: the whole menu action is ONE batch op (lensKeyModel.applyKeyOp), so it is one
// commit and one undo step, and a multi-note edit applies it to each note's own keys.

import { BEZIER_PRESETS, interpOp, sanitizeBez } from '../../lensRoam/lensKeyModel.js'

const INTERP_ITEMS = [
  { interp: 'Hold', label: 'Hold' },
  { interp: 'Linear', label: 'Linear' },
  { interp: 'EaseOut', label: 'Ease out' },
]

const sameBez = (a, b) => {
  const x = sanitizeBez(a)
  const y = sanitizeBez(b)
  return x.every((v, i) => Math.abs(v - y[i]) < 1e-9)
}

/**
 * @param {object} o
 * @param {object[]} o.targets   the key objects the menu acts on (as they are now)
 * @param {(op: object) => void} o.onOp
 * @param {(interp: string, bez: number[]|null) => void} [o.afterInterp]
 * @param {() => void} [o.afterDelete]
 * @returns {{ items: object[], count: number }}
 */
export function lensKeyMenuItems({ targets, onOp, afterInterp, afterDelete }) {
  const keys = targets ?? []
  const count = keys.length
  const all = (pred) => count > 0 && keys.every(pred)
  const setInterp = (interp, bez = null) => {
    onOp(interpOp(keys, interp, bez))
    afterInterp?.(interp, bez)
  }
  const items = INTERP_ITEMS.map(({ interp, label }) => ({
    label,
    checked: all((k) => (k.interp ?? 'Linear') === interp),
    onClick: () => setInterp(interp),
  }))
  items.push({ type: 'separator' })
  for (const p of BEZIER_PRESETS) {
    items.push({
      label: `Bezier: ${p.label}`,
      checked: all((k) => k.interp === 'Bezier' && sameBez(k.bez, p.bez)),
      onClick: () => setInterp('Bezier', p.bez),
    })
  }
  items.push({ type: 'separator' })
  items.push({
    label: count === 1 ? 'Delete key' : `Delete ${count} keys`,
    danger: true,
    onClick: () => {
      onOp({ type: 'batch', ops: keys.map((match) => ({ type: 'remove', match })) })
      afterDelete?.()
    },
  })
  return { items, count }
}
