import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Button, NumberBox, SegmentedControl, Select, requestHintRefresh,
} from '../../ui-kit'
import {
  CROP_MAX, OFFSET_RANGE_CELLS, cellGeometry, cellsToDisplay, displayToCells, roamIsIdentity,
} from '../../lensRoam/lensRoamModel.js'
import { playheadTick, useRoamValue, useTrackGeometry, usePlayheadTick } from '../../lensRoam/useLensRoam.js'
import { runMotionPlan } from '../../motion/motionPlan.js'
import { MAX_PARENT_DEPTH, indexTracks, lookupTrack } from '../../motion/parentModel.js'
import { propertyFor } from '../../motion/schema.js'
import ParentPicker, { PARENT_PICKER_HINT, PARENT_PICKER_MODS } from '../motionView/ParentPicker.jsx'
import { linkScalePlan } from '../../motion/providers/roamProvider.js'
import { SCALE_SCALE, cellFmt, cropFmt, degFmt, pxFmt, scaleFmt } from './roamFormats.js'
import RoamKeys, { RoamAutoKeyToggle } from './RoamKeys.jsx'
import { Field, Fields, TrackSection, trackStyles as t } from '../inspector/TrackSection.jsx'

// Roam: moves the CELL ITSELF (docs/XLETH_LENS_ROAM_SPEC.md). Offset is stored
// in cells (1.00 = one cell width / height), so a move stays proportional when
// the grid changes; Units only chooses how it is shown. The handles for the same
// values live on the viewer overlay (RoamOverlayCanvas), which previews through
// the same draft, so a drag here moves the outline there.
//
// Parent (docs/XLETH_MOTION_VIEW_DESIGN.md R6, R8, 5.6): the picker at the top of
// the section makes this cell follow another track's Roam. Alt held while choosing
// keeps the cell where it is on screen (the engine adjusts its UNKEYED Roam base at
// the playhead); the line under the picker then says what happened, naming any
// keyed channel that could not be kept.
//
// variant 'trail' (a Trail clone, docs/XLETH_CLONE_SPEC.md): its ADDED Roam, an
// offset on top of the delayed source position. Only Offset X and Y apply (the
// engine ignores the rest), so only they are shown; there is no Parent (a Trail
// cannot have one), no Bounds / Layer, and no pixel units (it has no cell).

const nameOf = (track, id) => track?.name || `Track ${id}`
const TRAIL_CHANNELS = ['offsetX', 'offsetY']

/** 'Offset X, Y and Scale': schema labels, offsets sharing their first word. */
function channelList(channels) {
  const order = ['offsetX', 'offsetY', 'scale', 'scaleY', 'rotationDeg', 'cropLeft', 'cropRight', 'cropTop', 'cropBottom']
  const labels = order.filter((c) => channels.includes(c)).map((c) => propertyFor('roam', c)?.label ?? c)
  const merged = []
  for (const l of labels) {
    const prev = merged[merged.length - 1]
    const [head, ...rest] = l.split(' ')
    if (prev && rest.length && prev.head === head) prev.tails.push(rest.join(' '))
    else merged.push({ head, tails: rest.length ? [rest.join(' ')] : [], label: l })
  }
  const parts = merged.map((m) => (m.tails.length > 1 ? `${m.head} ${m.tails.join(', ')}` : m.label))
  const plural = labels.length > 1
  const text = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0] ?? ''
  return { text, plural }
}

/**
 * The line shown (and put in the hint bar) after a Parent choice (R6), or null.
 *   res  setTrackParent's post-state (null when the call failed)
 */
function parentChangeNote(res, { keepOnScreen, parentName, chosen }) {
  if (!res) return 'The parent could not be set: the engine refused the change.'
  switch (res.rejected) {
    case 'self': return 'A track cannot follow itself.'
    case 'cycle': return `Not attached: ${parentName} already follows this track, so that would be a loop.`
    case 'too_deep': return `Not attached: the chain would be deeper than ${MAX_PARENT_DEPTH} parents.`
    case 'unknown_track': return 'Not attached: that track no longer exists.'
    default: break
  }
  if (!res.changed) return null
  const lead = chosen < 0 ? 'Detached.' : `Now follows ${parentName}.`
  if (!keepOnScreen) return `${lead} Its Roam values are kept, so it may jump; hold Alt while choosing to keep it in place.`
  if (res.keepOnScreenSkipped) return `${lead} It has no cell at the playhead, so there was no place on screen to keep.`
  const lost = Array.isArray(res.uncompensated) ? res.uncompensated : []
  if (lost.length) {
    const { text, plural } = channelList(lost)
    return `${lead} ${text} ${plural ? 'are' : 'is'} keyed: ${plural ? 'they keep their' : 'it keeps its'} keys and may jump.`
  }
  return `${lead} It keeps its place on screen.`
}

const LINK_OPTIONS = [
  { value: 'Linked', label: 'Linked', hint: 'One Scale resizes the cell evenly.' },
  { value: 'Free', label: 'Free', hint: 'Scale X and Scale Y stretch the cell independently.' },
]
const CROP_EDGES = [
  { key: 'cropLeft', label: 'Crop left', side: 'left' },
  { key: 'cropRight', label: 'Crop right', side: 'right' },
  { key: 'cropTop', label: 'Crop top', side: 'top' },
  { key: 'cropBottom', label: 'Crop bottom', side: 'bottom' },
]
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

export default function RoamPanel({ trackId, context, variant = 'cell', sourceName = null }) {
  const roamState = useRoamValue(trackId)
  const { roam, ready, preview, commit, cancel, reset, keyed, autoKey, resolveAt } = roamState
  const keyCount = roamState.committedKeys?.length ?? 0
  const { layout, track, tracks } = useTrackGeometry(trackId)
  const geo = useMemo(() => cellGeometry(layout, track), [layout, track])
  const [units, setUnits] = useState(readUnits)
  useEffect(() => { writeUnits(units) }, [units])
  // The playhead, at the display rate, only while some parameter is keyed.
  const tick = usePlayheadTick(roamState.keyed.size > 0)

  // Parent: the picker and what the last choice did (R6). The note belongs to one track.
  const tracksById = useMemo(() => indexTracks(tracks), [tracks])
  const [parentNote, setParentNote] = useState(null)
  useEffect(() => { setParentNote(null) }, [trackId])
  const parentId = ready ? roamState.parentTrackId : undefined
  const adopt = roamState.adopt
  const chooseParent = useCallback(async (pid, { keepOnScreen } = {}) => {
    const write = { kind: 'parent', trackId, parentTrackId: pid }
    // Keep on screen at the playhead: the engine solves the unkeyed base there.
    if (keepOnScreen) write.opts = { keepOnScreen: true, tick: Math.max(0, Math.round(playheadTick())) }
    const run = await runMotionPlan([write], pid < 0 ? 'Detach from parent' : 'Set parent')
    const res = run.results[0] ?? null
    adopt(res)
    const msg = parentChangeNote(res, { keepOnScreen: !!keepOnScreen, parentName: nameOf(lookupTrack(tracksById, pid), pid), chosen: pid })
    setParentNote(msg)
    if (msg) requestHintRefresh({ hint: msg, mods: PARENT_PICKER_MODS })
  }, [trackId, tracksById, adopt])

  if (!ready) {
    return (
      <TrackSection id="roam" title="Roam">
        <p className={t.note}>Loading roam…</p>
      </TrackSection>
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
  const linked = roam.scaleLinked !== false
  // Link / unlink Scale X and Y as one undo step (the plan also copies the Scale keys to Scale Y).
  const setLinked = async (next) => {
    const data = { roamByTrack: new Map([[trackId, { roam, keys: roamState.committedKeys ?? [] }]]) }
    const run = await runMotionPlan(linkScalePlan(trackId, data, Math.max(0, Math.round(playheadTick())), next), next ? 'Link scale' : 'Unlink scale')
    for (const res of run.results) adopt(res)
  }
  const identity = roamIsIdentity(roam)
  const floating = roam.bounds === 'Float'
  const parentTrack = parentId >= 0 ? lookupTrack(tracksById, parentId) : null
  const placeSummary = identity ? 'At its grid box' : 'Moved off its grid box'
  const summary = parentTrack ? `Follows ${nameOf(parentTrack, parentId)} · ${placeSummary.toLowerCase()}` : placeSummary

  // A KEYED parameter follows its keys, so its box shows the cell's value at the
  // playhead (draft included) and only edits when Auto-key is on (the edit becomes a
  // key at the playhead). With Auto-key off it is read-only: the base would be ignored.
  const shownRoam = keyed.size > 0 ? resolveAt(tick) : roam
  const locked = (ch) => keyed.has(ch) && !autoKey
  const lockedHint = (ch) => (locked(ch)
    ? 'Keyed: this value follows its keys. Edit them in Motion view, or turn on Auto-key to write a key at the playhead.'
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
        hint={lockedHint(key) ?? (variant === 'trail'
          ? `Push the Trail ${axis === 'X' ? 'sideways' : 'up or down'} from where ${sourceName ?? 'its source'} was. Positive is ${axis === 'X' ? 'right' : 'down'}. In cells of the source's cell.`
          : `Move the cell ${axis === 'X' ? 'across' : 'down'} the picture. Positive is ${axis === 'X' ? 'right' : 'down'}. Stored in cells, so it keeps its proportion if the grid changes.`)}
      />
    )
  }

  if (variant === 'trail') {
    const zero = !(roam.offsetX || roam.offsetY)
    return (
      <>
        <TrackSection
          id="trailRoam" title="Roam · added" testId="xleth-roam-panel"
          summary={zero ? 'No added offset' : 'Offset from the source'}
          hint={context ?? `An offset added on top of where ${sourceName ?? 'the source'} was. Only Offset X and Y apply`}
        >
          <Fields>
            <Field label="Roam X (added)" stretch>{offsetBox('X', pxX)}</Field>
            <Field label="Roam Y (added)" stretch>{offsetBox('Y', pxY)}</Field>
          </Fields>
          <div className={t.actions}>
            <Button
              size="sm" onClick={() => set({ offsetX: 0, offsetY: 0 })} disabled={zero}
              hint="Set the added offset back to zero: the Trail sits exactly on the source's delayed path. Keys are kept."
            >
              Reset offset
            </Button>
          </div>
        </TrackSection>
        <TrackSection
          id="trailRoamKeys" title="Roam keys"
          summary={keyCount === 0 ? 'No keys' : `${keyCount} key${keyCount === 1 ? '' : 's'}`}
          hint="Keyframes that move the added offset over time"
          actions={<RoamAutoKeyToggle autoKey={autoKey} />}
        >
          <RoamKeys trackId={trackId} roam={roamState} placed channels={TRAIL_CHANNELS} />
        </TrackSection>
      </>
    )
  }

  return (
    <>
      <TrackSection
        id="roam" title="Roam" testId="xleth-roam-panel"
        summary={summary}
        hint={context ?? 'Move this cell on the picture'}
        actions={(
          <SegmentedControl
            size="sm" label="Roam units" value={shown}
            options={UNIT_OPTIONS.map((o) => (o.value === 'Pixels' && !pixelsOk ? { ...o, disabled: true } : o))}
            onChange={setUnits}
            hint="How the offset is shown. Display only: it is stored in cells."
          />
        )}
      >
        <div className={t.actions}>
          <ParentPicker
            trackId={trackId} tracks={tracks} tracksById={tracksById} parentTrackId={parentId}
            onChoose={chooseParent} data-testid="roam-parent-picker"
            hint={parentNote ? `${parentNote} ${PARENT_PICKER_HINT}` : undefined}
          />
        </div>
        {parentNote ? <p className={t.note} role="status" data-testid="roam-parent-note">{parentNote}</p> : null}
        <Fields>
          <Field label="Offset X" stretch>{offsetBox('X', pxX)}</Field>
          <Field label="Offset Y" stretch>{offsetBox('Y', pxY)}</Field>
          <Field label={linked ? 'Scale' : 'Scale X'} stretch>
            <NumberBox
              label={linked ? 'Scale' : 'Scale X'} hideLabel width={96} scale={SCALE_SCALE} defaultValue={1}
              value={shownRoam.scale} format={scaleFmt.format} parse={scaleFmt.parse} disabled={locked('scale')}
              onChange={(scale) => preview({ scale })}
              onCommit={(scale) => set({ scale })}
              onCancel={cancel}
              hint={lockedHint('scale') ?? (linked
                ? 'Resize the cell about its own centre. 1.00 is the grid box.'
                : 'Stretch the cell across, about its own centre. 1.00 is the grid box width.')}
            />
          </Field>
          {linked ? null : (
            <Field label="Scale Y" stretch>
              <NumberBox
                label="Scale Y" hideLabel width={96} scale={SCALE_SCALE} defaultValue={1}
                value={shownRoam.scaleY} format={scaleFmt.format} parse={scaleFmt.parse} disabled={locked('scaleY')}
                onChange={(scaleY) => preview({ scaleY })}
                onCommit={(scaleY) => set({ scaleY })}
                onCancel={cancel}
                hint={lockedHint('scaleY') ?? 'Stretch the cell up and down, about its own centre. 1.00 is the grid box height.'}
              />
            </Field>
          )}
          <Field label="Link scale">
            <SegmentedControl
              size="sm" label="Link scale" value={linked ? 'Linked' : 'Free'}
              options={LINK_OPTIONS}
              onChange={(v) => setLinked(v === 'Linked')}
              hint="Linked: one Scale resizes the cell evenly. Free: Scale X and Scale Y stretch it on their own, which squishes the picture. Use Crop to change the shape without squishing."
            />
          </Field>
          <Field label="Rotate" stretch>
            <NumberBox
              label="Rotate" hideLabel width={96} min={-360} max={360} bipolar centre={0} defaultValue={0} pxPerRange={1440}
              value={shownRoam.rotationDeg} format={degFmt.format} parse={degFmt.parse} disabled={locked('rotationDeg')}
              onChange={(rotationDeg) => preview({ rotationDeg })}
              onCommit={(rotationDeg) => set({ rotationDeg })}
              onCancel={cancel}
              hint={lockedHint('rotationDeg') ?? 'Turn the cell about its own centre. Positive is clockwise.'}
            />
          </Field>
          {CROP_EDGES.map(({ key, label, side }) => (
            <Field key={key} label={label} stretch>
              <NumberBox
                label={label} hideLabel width={96} min={0} max={CROP_MAX} defaultValue={0} pxPerRange={400}
                value={shownRoam[key]} format={cropFmt.format} parse={cropFmt.parse} disabled={locked(key)}
                onChange={(v) => preview({ [key]: v })}
                onCommit={(v) => set({ [key]: v })}
                onCancel={cancel}
                hint={lockedHint(key) ?? `Trim the ${side} edge of the cell. The picture keeps its shape, the trimmed part just stops showing, so you can change the aspect ratio without squishing.`}
              />
            </Field>
          ))}
          <Field label="Bounds">
            <SegmentedControl
              size="sm" label="Roam bounds" options={BOUNDS_OPTIONS} value={roam.bounds}
              onChange={(bounds) => set({ bounds })}
              hint="Clip cuts the moved cell at its grid box. Float lets it draw over its neighbours."
            />
          </Field>
          <Field label="Layer" stretch>
            <Select
              size="sm" ariaLabel="Roam layer" value={roam.layer} options={LAYER_OPTIONS} disabled={!floating}
              onChange={(layer) => set({ layer })}
              hint={floating ? 'Where the floating cell draws relative to the others.' : 'Layer applies when Bounds is Float.'}
            />
          </Field>
        </Fields>
        <div className={t.actions}>
          <Button
            size="sm" onClick={() => reset()} disabled={identity}
            hint="Return the cell's base to its grid box: no offset, scale 1.00, no crop, no rotation, Clip, Grid order. Keys are kept: Clear keys removes them."
          >
            Back to grid box
          </Button>
        </div>
      </TrackSection>
      <TrackSection
        id="roamKeys" title="Roam keys"
        summary={keyCount === 0 ? 'No keys' : `${keyCount} key${keyCount === 1 ? '' : 's'}`}
        hint="Keyframes that move the cell over time"
        actions={<RoamAutoKeyToggle autoKey={autoKey} />}
      >
        <RoamKeys trackId={trackId} roam={roamState} placed={!!geo} />
      </TrackSection>
    </>
  )
}
