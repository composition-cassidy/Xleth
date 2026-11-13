import { useEffect, useMemo, useState } from 'react'
import {
  Button, NumberBox, SectionHeader, SegmentedControl, Select, THIN_SPACE, formatValue, parseValue, logScale,
} from '../../ui-kit'
import {
  OFFSET_RANGE_CELLS, SCALE_MAX, SCALE_MIN, cellGeometry, cellsToDisplay, displayToCells, roamIsIdentity,
} from '../../lensRoam/lensRoamModel.js'
import { useRoamValue, useTrackGeometry } from '../../lensRoam/useLensRoam.js'
import styles from '../inspector/Inspector.module.css'
import lens from './lensRoam.module.css'

// Roam: moves the CELL ITSELF (docs/XLETH_LENS_ROAM_SPEC.md). Offset is stored
// in cells (1.00 = one cell width / height), so a move stays proportional when
// the grid changes; Units only chooses how it is shown. The handles for the same
// values live on the viewer overlay (RoamOverlayCanvas), which previews through
// the same draft, so a drag here moves the outline there.

const UNIT_OPTIONS = [
  { value: 'Cells', label: 'Cells', hint: 'Show the offset in cells: 1.00 is one cell. This is how it is stored.' },
  { value: 'Pixels', label: 'Pixels', hint: 'Show the offset in project canvas pixels. Display only; it is stored in cells.' },
]
const BOUNDS_OPTIONS = [
  { value: 'Clip', label: 'Clip', hint: 'Cut the moved cell off at its own grid box.' },
  { value: 'Float', label: 'Float', hint: 'Draw the moved cell over its neighbours, ordered by Layer.' },
]
const LAYER_OPTIONS = [
  { value: 'GridOrder', label: 'Grid order', hint: "Keep the cell's place in the track stacking order." },
  { value: 'AboveNeighbours', label: 'Above neighbours', hint: 'Draw over the other grid cells, under any layer in front of the grid.' },
  { value: 'Top', label: 'Top', hint: 'Draw over everything.' },
]

const SCALE_SCALE = logScale(SCALE_MIN, SCALE_MAX)
const scaleFmt = {
  format: (v) => `${formatValue(v, 'dB', { unitless: true, decimals: 2 })}${THIN_SPACE}×`,
  parse: (t) => parseValue(String(t).replace(/[×x]/gi, ''), 'dB'),
}
const degFmt = {
  format: (v) => `${formatValue(v, 'dB', { unitless: true, decimals: 1 })}${THIN_SPACE}°`,
  parse: (t) => parseValue(String(t).replace(/°/g, ''), 'dB'),
}
const cellFmt = {
  format: (v) => `${formatValue(v, 'dB', { unitless: true, decimals: 2 })}${THIN_SPACE}cells`,
  parse: (t) => parseValue(String(t).replace(/cells?/gi, ''), 'dB'),
}
const pxFmt = {
  format: (v) => `${formatValue(Math.round(v), 'dB', { unitless: true, decimals: 0 })}${THIN_SPACE}px`,
  parse: (t) => parseValue(String(t).replace(/px/gi, ''), 'dB'),
}

// Units is a display choice: remembered for the session's next launch, never sent.
const UNITS_KEY = 'xleth.roam.units'
function readUnits() {
  try {
    const v = window.localStorage?.getItem(UNITS_KEY)
    return v === 'Pixels' ? 'Pixels' : 'Cells'
  } catch { return 'Cells' }
}
function writeUnits(v) {
  try { window.localStorage?.setItem(UNITS_KEY, v) } catch { /* storage can be blocked */ }
}

function Row({ label, children }) {
  return (
    <div className={styles.row}>
      <span className={styles.rowLabel}>{label}</span>
      <div className={styles.rowControl}>{children}</div>
    </div>
  )
}

export default function RoamPanel({ trackId, context }) {
  const { roam, ready, preview, commit, cancel, reset } = useRoamValue(trackId)
  const { layout, track } = useTrackGeometry(trackId)
  const geo = useMemo(() => cellGeometry(layout, track), [layout, track])
  const [units, setUnits] = useState(readUnits)
  useEffect(() => { writeUnits(units) }, [units])

  if (!ready) {
    return (
      <section className={styles.section} aria-label="Roam">
        <SectionHeader>Roam</SectionHeader>
        <p className={lens.note}>Loading roam…</p>
      </section>
    )
  }

  // Without a cell (the track is not on the grid) there is no pixel size to show.
  const pixelsOk = !!geo
  const shown = units === 'Pixels' && pixelsOk ? 'Pixels' : 'Cells'
  const pxX = geo?.cellPx.w ?? 1
  const pxY = geo?.cellPx.h ?? 1
  const offsetRange = (px) => (shown === 'Pixels' ? OFFSET_RANGE_CELLS * px : OFFSET_RANGE_CELLS)
  const fmt = shown === 'Pixels' ? pxFmt : cellFmt

  const set = (patch) => { commit(patch) }
  const identity = roamIsIdentity(roam)
  const floating = roam.bounds === 'Float'

  const offsetBox = (axis, px) => {
    const key = axis === 'X' ? 'offsetX' : 'offsetY'
    const range = offsetRange(px)
    return (
      <NumberBox
        key={`${key}-${shown}`}
        label={`Offset ${axis}`} hideLabel width={96} min={-range} max={range} bipolar centre={0} defaultValue={0}
        value={cellsToDisplay(roam[key], shown, px)} format={fmt.format} parse={fmt.parse}
        pxPerRange={400}
        onChange={(v) => preview({ [key]: displayToCells(v, shown, px) })}
        onCommit={(v) => set({ [key]: displayToCells(v, shown, px) })}
        onCancel={cancel}
        hint={`Move the cell ${axis === 'X' ? 'across' : 'down'} the picture. Positive is ${axis === 'X' ? 'right' : 'down'}. Stored in cells, so it keeps its proportion if the grid changes.`}
      />
    )
  }

  return (
    <section className={styles.section} aria-label="Roam" data-testid="xleth-roam-panel">
      <SectionHeader>Roam</SectionHeader>
      {context ? <p className={lens.context} title={context}>{context}</p> : null}
      <Row label="Units">
        <SegmentedControl
          size="sm" label="Roam units" value={shown}
          options={UNIT_OPTIONS.map((o) => (o.value === 'Pixels' && !pixelsOk ? { ...o, disabled: true } : o))}
          onChange={setUnits}
          hint="How the offset is shown. Display only: it is stored in cells."
        />
      </Row>
      <Row label="Offset X">{offsetBox('X', pxX)}</Row>
      <Row label="Offset Y">{offsetBox('Y', pxY)}</Row>
      <Row label="Scale">
        <NumberBox
          label="Scale" hideLabel width={96} scale={SCALE_SCALE} defaultValue={1}
          value={roam.scale} format={scaleFmt.format} parse={scaleFmt.parse}
          onChange={(scale) => preview({ scale })}
          onCommit={(scale) => set({ scale })}
          onCancel={cancel}
          hint="Resize the cell about its own centre. 1.00 is the grid box."
        />
      </Row>
      <Row label="Rotate">
        <NumberBox
          label="Rotate" hideLabel width={96} min={-360} max={360} bipolar centre={0} defaultValue={0} pxPerRange={1440}
          value={roam.rotationDeg} format={degFmt.format} parse={degFmt.parse}
          onChange={(rotationDeg) => preview({ rotationDeg })}
          onCommit={(rotationDeg) => set({ rotationDeg })}
          onCancel={cancel}
          hint="Turn the cell about its own centre. Positive is clockwise."
        />
      </Row>
      <Row label="Bounds">
        <SegmentedControl
          size="sm" label="Roam bounds" options={BOUNDS_OPTIONS} value={roam.bounds}
          onChange={(bounds) => set({ bounds })}
          hint="Clip cuts the moved cell at its grid box. Float lets it draw over its neighbours."
        />
      </Row>
      <Row label="Layer">
        <Select
          size="sm" ariaLabel="Roam layer" value={roam.layer} options={LAYER_OPTIONS} disabled={!floating}
          onChange={(layer) => set({ layer })}
          hint={floating ? 'Where the floating cell draws relative to the others.' : 'Layer applies when Bounds is Float.'}
        />
      </Row>
      <div className={lens.actions}>
        <Button
          size="sm" onClick={() => reset()} disabled={identity}
          hint="Return the cell to its grid box: no offset, scale 1.00, no rotation, Clip, Grid order."
        >
          Back to grid box
        </Button>
      </div>
    </section>
  )
}
