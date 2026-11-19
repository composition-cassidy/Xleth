// The Roam / Sweep key lanes' right-click menu: set the interpolation of every
// selected key (Hold, Linear, Ease out, or Bezier from a preset shape) or delete them.
//
// Pure: builds the ContextMenu item array (components/ContextMenu.jsx) from the
// selection and two callbacks. Every track the selection touches gets ONE commit of
// its whole key list (one undo step per track), the same contract as a lane drag.

import {
  BEZIER_PRESETS, keysForRefs, removeKeysForRefs, sanitizeBez, setInterpForRefs,
} from '../../lensRoam/roamKeyModel.js'

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
 * @param {{trackId:number, channel:string, pos:number}[]} o.refs   the keys the menu acts on
 * @param {(trackId:number) => object[]} o.keysOf   a track's COMMITTED key list
 * @param {(trackId:number, keys:object[]) => unknown} o.commit   one engine call per track
 * @param {() => void} [o.afterDelete]   clear the selection once the keys are gone
 * @returns {{ items: object[], count: number }}  count = keys actually addressed
 */
export function roamKeyMenuItems({ refs, keysOf, commit, afterDelete }) {
  const trackIds = [...new Set((refs ?? []).map((r) => r.trackId))]
  const targets = trackIds.flatMap((t) => keysForRefs(keysOf(t) ?? [], refs, t))
  const count = targets.length
  const all = (pred) => count > 0 && targets.every(pred)
  const applyAll = (fn) => {
    for (const t of trackIds) {
      const keys = keysOf(t) ?? []
      const next = fn(keys, t)
      if (next !== keys) commit(t, next)
    }
  }

  const items = INTERP_ITEMS.map(({ interp, label }) => ({
    label,
    checked: all((k) => (k.interp ?? 'Linear') === interp),
    onClick: () => applyAll((keys, t) => setInterpForRefs(keys, refs, t, interp)),
  }))
  items.push({ type: 'separator' })
  for (const p of BEZIER_PRESETS) {
    items.push({
      label: `Bezier: ${p.label}`,
      checked: all((k) => k.interp === 'Bezier' && sameBez(k.bez, p.bez)),
      onClick: () => applyAll((keys, t) => setInterpForRefs(keys, refs, t, 'Bezier', p.bez)),
    })
  }
  items.push({ type: 'separator' })
  items.push({
    label: count === 1 ? 'Delete key' : `Delete ${count} keys`,
    danger: true,
    onClick: () => {
      applyAll((keys, t) => removeKeysForRefs(keys, refs, t))
      afterDelete?.()
    },
  })
  return { items, count }
}
