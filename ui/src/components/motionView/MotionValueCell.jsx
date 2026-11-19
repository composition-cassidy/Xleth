import { useEffect, useMemo, useRef, useState } from 'react'
import { NumberBox, Select } from '../../ui-kit'
import { VALUE_HINT_MODS_NO_WHEEL } from '../../ui-kit/hint'
import { MOTION_BLUR_SHUTTERS, enumOptions, formatValue, numberBoxProps } from '../../motion/schema.js'
import { useMotionViewStore } from '../../motion/motionViewStore.js'
import { DelayPicker, TintField } from './TrailControls.jsx'
import styles from './MotionView.module.css'

// The value cell of a Motion view property row (docs/XLETH_MOTION_VIEW_DESIGN.md R4,
// R1, 5.3): the live value at the playhead (the caller re-renders it at the display
// rate), right-aligned, tabular numerals, true minus and thin space (schema.js).
//
//   scalar      kit NumberBox (wheel off: the wheel scrolls the tree). Drag = local
//               preview (the store draft, no IPC); pointerup / Enter = ONE plan:
//               an animated row upserts a key at the playhead, a static row edits
//               its base (R4, never a rest key). Ctrl+click resets to the identity.
//   enum, bool  kit Select (Fit, Flip, Bounds, Layer, Mode, Invert): edits the base.
//   motionBlur  kit Select of the PROJECT setting (R1): Off, 90, 180, 270, 360 degrees.
//   shape       kit Select of the mask kind (a static Rectangle / Ellipse / Path).
//   ticks       (a Trail's Delay) DelayPicker: the musical values + exact ticks.
//   color       (a Trail's Tint) TintField: swatch + hex.
// A cell that cannot act now (no clip under the playhead, a static Sweep row...) is
// disabled and says why in its hint.

export const VALUE_CELL_WIDTH = 92
const DASH = '—'

/** The options of the read-through motion blur row: the shutter angles, "Project · ..." */
export function motionBlurOptions(current) {
  const opts = [{ value: 0, label: 'Off' }, ...MOTION_BLUR_SHUTTERS.map((d) => ({ value: d, label: `${d}°` }))]
  const cur = current?.enabled ? Math.round(current.shutterAngleDeg) : 0
  if (!opts.some((o) => o.value === cur)) opts.push({ value: cur, label: `${cur}°` })
  return opts
}

/** The value a motion blur choice writes with timeline.setMotionBlur: { enabled, shutterAngle }. */
export function motionBlurPatch(choice, current) {
  const deg = Number(choice)
  if (!(deg > 0)) return { enabled: false, shutterAngle: current?.shutterAngleDeg ?? 180 }
  return { enabled: true, shutterAngle: deg }
}

export default function MotionValueCell({
  row, value, blocker = null, animated = false, onPlan, onMotionBlur, hint, width = VALUE_CELL_WIDTH,
}) {
  const p = row.prop
  const [pending, setPending] = useState(null)   // the committed value until the engine's answer lands
  const draftKey = useRef(null)

  // The engine's answer (new data -> a new `value`) replaces the pending one.
  useEffect(() => { setPending(null) }, [value])

  const nbProps = useMemo(() => (p.type === 'scalar' ? numberBoxProps(p) : null), [p])
  const disabled = !!blocker
  const cellHint = blocker ?? hint ?? `${p.label}`

  const clearDraft = () => {
    const s = useMotionViewStore.getState()
    if (draftKey.current && s.draft?.kind === 'value' && s.draft.rowKey === draftKey.current) s.clearDraft()
    draftKey.current = null
  }

  // A Trail's Delay and Tint (static settings, one setCloneSettings each).
  if ((p.type === 'scalar' && p.unit === 'ticks') || p.type === 'color') {
    if (value === null || value === undefined) {
      return (
        <span className={styles.value} style={{ width }}>
          <span className={styles.valueText} style={{ width }} data-hint={cellHint}>{DASH}</span>
        </span>
      )
    }
    const commit = (v) => { Promise.resolve(onPlan?.(row, v)).catch(() => {}) }
    return (
      <span className={styles.value} style={{ width }} data-static="true">
        {p.type === 'color' ? (
          <TintField value={value} onCommit={commit} disabled={disabled} width={width} hint={blocker ?? undefined} label={p.label} data-testid={`motion-value-${row.key}`} />
        ) : (
          <DelayPicker value={value} onCommit={commit} disabled={disabled} width={width} hint={blocker ?? undefined} label={p.label} data-testid={`motion-value-${row.key}`} />
        )}
      </span>
    )
  }

  if (p.type === 'scalar') {
    if (value === null || value === undefined || !Number.isFinite(value)) {
      return (
        <span className={styles.value} style={{ width }} data-static="true">
          <span className={styles.valueText} style={{ width }} data-hint={cellHint}>{DASH}</span>
        </span>
      )
    }
    const shown = pending ?? value
    return (
      <span className={styles.value} style={{ width }} data-static={!animated || undefined}>
        <NumberBox
          {...nbProps}
          label={`${p.label}`}
          hideLabel
          size="sm"
          width={width}
          wheel={false}
          value={shown}
          disabled={disabled}
          hint={cellHint}
          hintMods={disabled ? undefined : `${animated ? 'Keys the playhead · ' : ''}${VALUE_HINT_MODS_NO_WHEEL}`}
          data-testid={`motion-value-${row.key}`}
          onChange={(v) => {
            // The box follows the drag locally (one cell re-renders); nothing reaches the engine until commit.
            draftKey.current = row.key
            setPending(v)
            useMotionViewStore.getState().setDraft({ kind: 'value', rowKey: row.key, trackId: row.trackId, propId: p.id, value: v })
          }}
          onCommit={(v) => {
            clearDraft()
            if (!Number.isFinite(v) || v === value) { setPending(null); return }
            setPending(v)
            // Nothing changed (refused, or the same value): drop the pending value at once.
            Promise.resolve(onPlan?.(row, v)).then((res) => { if (!res?.changed) setPending(null) }, () => setPending(null))
          }}
          onCancel={() => { clearDraft(); setPending(null) }}
        />
      </span>
    )
  }

  if (p.type === 'motionBlur') {
    const v = value?.enabled ? Math.round(value.shutterAngleDeg) : 0
    return (
      <span className={styles.value} style={{ width }}>
        <Select
          size="sm"
          width={width}
          ariaLabel={p.label}
          value={v}
          options={motionBlurOptions(value)}
          onChange={(next) => onMotionBlur?.(motionBlurPatch(next, value))}
          hint={cellHint}
          hintMods="Not undoable: the same setting as Settings > Motion blur"
          data-testid={`motion-value-${row.key}`}
        />
      </span>
    )
  }

  const options = enumOptions(p)
  const current = p.type === 'shape' ? (value?.kind ?? null) : value
  if (current === null || current === undefined) {
    return (
      <span className={styles.value} style={{ width }}>
        <span className={styles.valueText} style={{ width }} data-hint={cellHint}>{DASH}</span>
      </span>
    )
  }
  return (
    <span className={styles.value} style={{ width }}>
      <Select
        size="sm"
        width={width}
        ariaLabel={p.label}
        value={pending ?? current}
        options={options}
        disabled={disabled}
        onChange={(next) => {
          if (next === current) return
          setPending(next)
          Promise.resolve(onPlan?.(row, next)).then((res) => { if (!res?.changed) setPending(null) }, () => setPending(null))
        }}
        hint={cellHint}
        data-testid={`motion-value-${row.key}`}
      />
    </span>
  )
}

/** The text a value cell shows (tests, canvas chips): the schema format, '—' when there is none. */
export function valueText(prop, value) {
  if (value === null || value === undefined) return DASH
  return formatValue(prop, value)
}
