import { Select } from '../../ui-kit'
import { BEZIER_PRESETS, sanitizeBez } from '../../lensRoam/lensKeyModel.js'

// A Bezier key's shape, typed: pick a preset's handles. Handles dragged in a lane to
// something no preset matches read as Custom (shown, not selectable: picking a preset
// replaces them).

export const BEZIER_INTERP_OPTION = {
  value: 'Bezier',
  label: 'Bezier',
  hint: 'A curve shaped by two handles. Select the key, then drag its handles in the lane.',
}

/** The preset id these handles are, or 'custom'. */
export function bezierPresetId(bez) {
  const b = sanitizeBez(bez)
  const p = BEZIER_PRESETS.find((q) => sanitizeBez(q.bez).every((v, i) => Math.abs(v - b[i]) < 1e-6))
  return p ? p.id : 'custom'
}

/**
 * @param {object} props
 * @param {number[]} props.bez                       the key's handles
 * @param {(bez: number[]) => void} props.onChange   one commit
 */
export default function BezierShapeSelect({ bez, onChange }) {
  const id = bezierPresetId(bez)
  const options = BEZIER_PRESETS.map((p) => ({ value: p.id, label: p.label }))
  if (id === 'custom') options.push({ value: 'custom', label: 'Custom' })
  return (
    <Select
      size="sm" ariaLabel="Bezier shape" value={id} options={options}
      onChange={(v) => {
        const p = BEZIER_PRESETS.find((q) => q.id === v)
        if (p) onChange([...p.bez])
      }}
      hint="Start from a shape. The handles stay editable in the lane."
    />
  )
}
