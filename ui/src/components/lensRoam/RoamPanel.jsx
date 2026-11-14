import { useEffect, useMemo, useState } from 'react'
import {
  Button, NumberBox, SectionHeader, SegmentedControl, Select,
} from '../../ui-kit'
import {
  OFFSET_RANGE_CELLS, cellGeometry, cellsToDisplay, displayToCells, roamIsIdentity,
} from '../../lensRoam/lensRoamModel.js'
import { useRoamValue, useTrackGeometry, usePlayheadTick } from '../../lensRoam/useLensRoam.js'
import { SCALE_SCALE, cellFmt, degFmt, pxFmt, scaleFmt } from './roamFormats.js'
import RoamKeys from './RoamKeys.jsx'
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
  const roamState = useRoamValue(trackId)
  const { roam, ready, preview, commit, cancel, reset, keyed, autoKey, resolveAt } = roamState
  const { layout, track } = useTrackGeometry(trackId)
  const geo = useMemo(() => cellGeometry(layout, track), [layout, track])
  const [units, setUnits] = useState(readUnits)
  useEffect(() => { writeUnits(units) }, [units])
  // The playhead, at the display rate, only while some parameter is keyed.
  const tick = usePlayheadTick(roamState.keyed.size > 0)

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

  // A KEYED parameter follows its keys, so its box shows the cell's value at the
  // playhead (draft included) and only edits when Auto-key is on (the edit becomes a
  // key at the playhead). With Auto-key off it is read-only: the base would be ignored.
  const shownRoam = keyed.size > 0 ? resolveAt(tick) : roam
  const locked = (ch) => keyed.has(ch) && !autoKey
  const lockedHint = (ch) => (locked(ch)
    ? 'Keyed: this value follows its keys. Edit them in the lane, or turn on Auto-key to write a key at the playhead.'
    : keyed.has(ch) ? 'Keyed: with Auto-key on, a change writes a key at the playhead.' : null)

  const offsetBox = (axis, px) => {
    const key = axis === 'X' ? 'offsetX' : 'offsetY'
    const range = offsetRange(px)
    return (
      <NumberBox
        key={`${key}-${shown}`}
        label={`Offset ${axis}`} hideLabel width={96} min={-range} max={range} bipolar centre={0} defaultValue={0}
        value={cellsToDisplay(shownRoam[key], shown, px)} format={fmt.format} parse={fmt.parse}
        pxPerRange={400} disabled={locked(key)}
        onChange={(v) => preview({ [key]: displayToCells(v, shown, px) })}
        onCommit={(v) => set({ [key]: displayToCells(v, shown, px) })}
        onCancel={cancel}
        hint={lockedHint(key) ?? `Move the cell ${axis === 'X' ? 'across' : 'down'} the picture. Positive is ${axis === 'X' ? 'right' : 'down'}. Stored in cells, so it keeps its proportion if the grid changes.`}
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
          value={shownRoam.scale} format={scaleFmt.format} parse={scaleFmt.parse} disabled={locked('scale')}
          onChange={(scale) => preview({ scale })}
          onCommit={(scale) => set({ scale })}
          onCancel={cancel}
          hint={lockedHint('scale') ?? 'Resize the cell about its own centre. 1.00 is the grid box.'}
        />
      </Row>
      <Row label="Rotate">
        <NumberBox
          label="Rotate" hideLabel width={96} min={-360} max={360} bipolar centre={0} defaultValue={0} pxPerRange={1440}
          value={shownRoam.rotationDeg} format={degFmt.format} parse={degFmt.parse} disabled={locked('rotationDeg')}
          onChange={(rotationDeg) => preview({ rotationDeg })}
          onCommit={(rotationDeg) => set({ rotationDeg })}
          onCancel={cancel}
          hint={lockedHint('rotationDeg') ?? 'Turn the cell about its own centre. Positive is clockwise.'}
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
          hint="Return the cell's base to its grid box: no offset, scale 1.00, no rotation, Clip, Grid order. Keys are kept: Clear keys removes them."
        >
          Back to grid box
        </Button>
      </div>
      <SectionHeader>Roam keys</SectionHeader>
      <RoamKeys trackId={trackId} roam={roamState} placed={!!geo} />
    </section>
  )
}
