import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, NumberBox, SegmentedControl, logScale } from '../../ui-kit'
import { playheadClock } from '../../services/PlayheadClock.js'
import {
  DEFAULT_ZONES, applyKeyOp, keysOfChannel, normalizeZones, resolveClipLens, resolveNoteLens,
} from '../../lensRoam/lensKeyModel.js'
import { noteTimeAtPlayhead } from '../../lensRoam/lensNoteTarget.js'
import { noteValueLabel, ticksFmt } from '../../lensRoam/lensFormats.js'
import {
  clearNoteSelection, useClipKeys, useHitPresets, useSelectedNotes, useSourceCurve, useSweepKeys,
} from '../../lensRoam/useLensKeys.js'
import { applySweepLayer, sweepLayerAt } from '../../lensRoam/roamKeyModel.js'
import { requestMotionReveal } from '../timeline/motionReveal.js'
import styles from '../inspector/Inspector.module.css'
import lens from './lensRoam.module.css'
import LensHitControls from './LensHitControls.jsx'
import LensKeyInspector from './LensKeyInspector.jsx'
import LensKeyLanes from './LensKeyLanes.jsx'
import LensLayerStack from './LensLayerStack.jsx'

// The Advanced half of the Lens panel (docs/XLETH_LENS_ROAM_SPEC.md, P9). It only
// REVEALS more: everything the Simple panel shows stays where it is.
//
//   Pattern Track source, notes selected    Follow / Nudge / Own, Revert to Follow,
//                                           the layer stack, the lanes over the note
//   Pattern Track source, none selected     the hit curve over a reference note
//   Clip Track event                        the same lanes in event ticks, no zones

const MODE_OPTIONS = [
  { value: 'Follow', label: 'Follow', hint: 'This note plays the hit curve, exactly as the source defines it.' },
  { value: 'Nudge', label: 'Nudge', hint: 'The hit curve, plus this note\'s own keys on top.' },
  { value: 'Own', label: 'Own', hint: 'Only this note\'s own keys. Hit-curve edits never reach it.' },
]

const REFERENCE_SCALE = logScale(60, 15360)

function Row({ label, children }) {
  return (
    <div className={styles.row}>
      <span className={styles.rowLabel}>{label}</span>
      <div className={styles.rowControl}>{children}</div>
    </div>
  )
}

/** The engine's playhead (information: frame-rate, never through React state). */
function usePlayhead() {
  const subscribe = useCallback((cb) => playheadClock.onFrame(() => cb()), [])
  const ticks = useCallback(() => playheadClock.positionBeats * 960, [])
  return { subscribe, ticks }
}

/**
 * The Sweep row of the layer stack (P11): the track's timeline-absolute Lens layer.
 * `status` is what an empty row says; `stackRow` is the row itself; `reveal` shows the
 * track's Sweep rows in Motion view, where the keys are edited (the Edit view has no
 * Sweep lane any more, docs/XLETH_MOTION_VIEW_DESIGN.md R17).
 */
function useSweepLayer(trackId) {
  const { keys } = useSweepKeys(trackId)
  const count = keys?.length ?? 0
  return {
    keys: keys ?? [],
    stackRow: { id: 'sweep', label: 'Sweep', layer: true, status: count === 0 ? 'none' : null },
    canReveal: trackId != null,
    reveal: () => { if (trackId != null) requestMotionReveal(trackId, ['sweep']) },
    count,
  }
}

/** Opens the Sweep rows in Motion view, under the layer stack that reports its row. */
function SweepLaneButton({ sweep }) {
  return (
    <div className={lens.actions}>
      <Button
        size="sm" onClick={sweep.reveal} disabled={!sweep.canReveal}
        data-testid="lens-sweep-show-in-motion"
        hint="Show this track's Sweep rows in Motion view (`). A Sweep is a move that runs across several notes: zoom multiplies each note's framing, centre and rotation add to it."
      >
        Edit Sweep in Motion view
      </Button>
    </div>
  )
}

/** A function that always calls the latest closure, with one stable identity. */
function useLatest(fn) {
  const ref = useRef(fn)
  ref.current = fn
  return useCallback((...args) => ref.current(...args), [])
}

// ── Pattern Track source ─────────────────────────────────────────────────────

/** Simple hit controls always; the Advanced editor when `advanced`. One data hook, shared. */
export function SourceLensExtras({ target, lens: base, advanced }) {
  const source = useSourceCurve(target.trackId, target.regionId)
  const presets = useHitPresets()
  return (
    <>
      <LensHitControls source={source} presets={presets} />
      {advanced && <SourceAdvanced target={target} base={base} source={source} />}
    </>
  )
}

function SourceAdvanced({ target, base, source }) {
  const notes = useSelectedNotes(target.trackId, target.regionId, true)
  const { curve } = source
  const [selected, setSelected] = useState(null)
  const [referenceTicks, setReferenceTicks] = useState(960)
  const playhead = usePlayhead()
  const hasNotes = notes.count > 0
  const sweep = useSweepLayer(target.trackId)
  const primaryId = notes.primary ? `${notes.primary.patternId}:${notes.primary.noteId}` : null

  // A different note (or none) starts with no key selected.
  useEffect(() => { setSelected(null) }, [primaryId, hasNotes])

  const zonesRaw = curve?.zones ?? null
  const mode = notes.primary?.mode ?? 'Follow'

  // ── note mode ──
  const noteLen = notes.placements[0]
    ? notes.placements[0].end - notes.placements[0].start
    : notes.primary?.lengthTicks ?? 0
  const noteZones = mode === 'Own' ? { ...DEFAULT_ZONES } : normalizeZones(zonesRaw)
  const hitKeys = curve?.keys ?? []

  const placementsNow = useLatest(() => notes.placements)
  const at = useLatest(() => noteTimeAtPlayhead(placementsNow(), playhead.ticks()))
  const getPlayhead = useCallback(() => {
    const r = at()
    return r ? { t: r.t, inside: r.inside } : null
  }, [at])

  const compute = useLatest(() => {
    if (!notes.primary || !curve) return { values: {}, note: null }
    const r = at()
    const t = r?.t ?? 0
    const res = resolveNoteLens({
      base, hitKeys, zones: zonesRaw, mode, noteKeys: notes.primary.keys, noteLen: r?.len ?? noteLen, t,
    })
    // Sweep is timeline-absolute: read it at the note's own tick (the playhead inside
    // the note, else the edge the readout is showing).
    const place = notes.placements[0]
    const sweepTick = r && !r.inside && place ? place.start + r.t : playhead.ticks()
    const sweepLayer = sweepLayerAt(sweep.keys, sweepTick)
    const resolved = applySweepLayer(res.resolved, sweepLayer)
    let note = null
    if (!r) note = 'This note is not on the timeline yet, so there is no playhead position in it.'
    else if (r.inside) note = `Playhead ${Math.round(t)} ticks into the note.`
    else note = `Playhead is ${r.edge === 'start' ? 'before' : 'after'} this note: showing its ${r.edge === 'start' ? 'first' : 'last'} frame.`
    if (notes.count > 1) note += ` Showing the first of ${notes.count} selected notes.`
    return { values: { base: res.base, hit: res.hit, note: res.note, sweep: sweepLayer, resolved }, note }
  })

  const rows = [
    { id: 'base', label: 'Base', layer: false },
    {
      id: 'hit', label: 'Hit curve', layer: true,
      status: mode === 'Own' ? 'not applied' : hitKeys.length === 0 ? 'none' : null,
    },
    {
      id: 'note', label: 'This note', layer: true,
      status: mode === 'Follow' ? 'Follow: none' : notes.primary?.keys.length ? null : 'no keys',
    },
    sweep.stackRow,
    { id: 'resolved', label: 'Resolved', layer: false },
  ]

  // ── hit-curve mode ──
  const hitOp = (op) => {
    const next = applyKeyOp(hitKeys, op)
    if (next) source.write(next)
  }

  if (!curve) return <p className={lens.note}>Loading hit curve…</p>

  if (hasNotes) {
    const count = notes.count
    const inherited = mode === 'Own' ? [] : hitKeys
    return (
      <div className={lens.advanced} data-testid="lens-advanced" data-advanced-kind="note">
        <div className={lens.subhead}>
          <span>{count === 1 ? 'Selected note' : `${count} selected notes`}</span>
          <Button size="sm" onClick={clearNoteSelection} hint="Deselect the notes and edit the hit curve every note plays.">
            Edit hit curve
          </Button>
        </div>
        <Row label="Plays">
          <SegmentedControl
            size="sm" label="Note Lens state" options={MODE_OPTIONS} value={notes.mode}
            onChange={(m) => notes.setMode(m)}
            hint="How this note uses the hit curve. Adding a key to a Follow note makes it Nudge."
          />
        </Row>
        {notes.mode === 'Mixed' && (
          <p className={lens.note} data-testid="lens-mode-mixed">The selected notes are in different states. Pick one to set them all.</p>
        )}
        <div className={lens.actions}>
          <Button
            size="sm" disabled={notes.mode === 'Follow'} onClick={() => notes.revert()}
            hint="Drop this note's own keys and play the hit curve again. Undo brings them back."
          >
            Revert to Follow
          </Button>
        </div>

        <LensLayerStack
          rows={rows} compute={compute} subscribePlayhead={playhead.subscribe}
          label="Lens layers: base, hit curve, this note, sweep, and the resolved value at the playhead"
        />
        <SweepLaneButton sweep={sweep} />

        <LensKeyLanes
          kind="note" zones={noteZones} lengthTicks={noteLen}
          ownKeys={notes.primary.keys} inheritedKeys={inherited}
          selected={selected} onSelect={setSelected} onOp={(op) => notes.applyOp(op)}
          getPlayhead={getPlayhead} subscribePlayhead={playhead.subscribe}
          label={`Lens keys of the ${count === 1 ? 'selected note' : 'first of the selected notes'}`}
        />
        <p className={lens.note} data-testid="lens-lane-note">
          {mode === 'Follow' && 'Follow: hollow keys are the hit curve. Add a key to nudge this note.'}
          {mode === 'Nudge' && 'Nudge: hollow keys are the hit curve, filled keys are this note\'s own, on top.'}
          {mode === 'Own' && 'Own: the hit curve does not reach this note.'}
          {count > 1 && ` Edits apply to all ${count} notes.`}
        </p>

        <LensKeyInspector
          keyObj={selected} kind="note" zones={noteZones} lengthTicks={noteLen}
          onOp={(op) => notes.applyOp(op)} onSelect={setSelected}
        />
      </div>
    )
  }

  const zones = normalizeZones(zonesRaw)
  return (
    <div className={lens.advanced} data-testid="lens-advanced" data-advanced-kind="hit">
      <div className={lens.subhead}><span>Hit curve</span></div>
      <SweepLaneButton sweep={sweep} />
      <Row label="Preview note">
        <NumberBox
          label="Preview note length" hideLabel width={104}
          scale={REFERENCE_SCALE} defaultValue={960}
          value={referenceTicks}
          format={(v) => `${ticksFmt.format(v)}${noteValueLabel(v) ? ` · ${noteValueLabel(v)}` : ''}`}
          parse={ticksFmt.parse}
          onCommit={(v) => setReferenceTicks(Math.round(v))}
          hint="The length of the note the lanes show. A short note squeezes or cuts the curve; select a note to see it for real."
        />
      </Row>
      <Row label="Head">
        <NumberBox
          label="Head length" hideLabel width={88} min={0} max={960} defaultValue={120} value={zones.headTicks}
          format={ticksFmt.format} parse={ticksFmt.parse}
          onCommit={(headTicks) => source.write(hitKeys, { headTicks: Math.round(headTicks) })}
          hint="How long the Head band is: ticks after the note starts. Default 120 (1/32)."
        />
      </Row>
      <Row label="Tail">
        <NumberBox
          label="Tail length" hideLabel width={88} min={0} max={960} defaultValue={240} value={zones.tailTicks}
          format={ticksFmt.format} parse={ticksFmt.parse}
          onCommit={(tailTicks) => source.write(hitKeys, { tailTicks: Math.round(tailTicks) })}
          hint="How long the Tail band is: ticks before the note ends. Default 240 (1/16)."
        />
      </Row>
      <LensKeyLanes
        kind="note" zones={zones} lengthTicks={referenceTicks}
        ownKeys={hitKeys} inheritedKeys={[]}
        selected={selected} onSelect={setSelected} onOp={hitOp}
        label="Hit curve keys over a reference note"
      />
      <p className={lens.note} data-testid="lens-lane-note">
        Every Follow and Nudge note of this source plays this curve. Select notes in the piano roll or the Reel lane to nudge them.
      </p>
      <LensKeyInspector
        keyObj={selected} kind="note" zones={zones} lengthTicks={referenceTicks}
        onOp={hitOp} onSelect={setSelected}
      />
    </div>
  )
}

// ── Clip Track event ─────────────────────────────────────────────────────────

/**
 * @param {object} props
 * @param {number} props.clipId
 * @param {object} props.lens          the event's static lens (what an unkeyed channel holds)
 * @param {{startTick:number, lengthTicks:number}} props.clipTiming
 */
export function ClipLensAdvanced({ clipId, trackId = null, lens: base, clipTiming }) {
  const { keys, ready, write } = useClipKeys(clipId)
  const sweep = useSweepLayer(trackId)
  const [selected, setSelected] = useState(null)
  const playhead = usePlayhead()
  useEffect(() => { setSelected(null) }, [clipId])

  const len = Math.max(1, clipTiming?.lengthTicks ?? 1)
  const start = clipTiming?.startTick ?? 0
  const rel = useLatest(() => {
    const t = playhead.ticks() - start
    return { t: Math.min(Math.max(t, 0), len), inside: t >= 0 && t < len, before: t < 0 }
  })
  const getPlayhead = useCallback(() => {
    const r = rel()
    return { t: r.t, inside: r.inside }
  }, [rel])

  const compute = useLatest(() => {
    const r = rel()
    const res = resolveClipLens({ base, keys: keys ?? [], t: r.t })
    // Sweep: timeline-absolute, so the event's own tick (start + t) reads it.
    const sweepLayer = sweepLayerAt(sweep.keys, start + r.t)
    const resolvedWithSweep = applySweepLayer(res.resolved, sweepLayer)
    const keyed = {}
    for (const ch of ['zoom', 'centerX', 'centerY', 'rotationDeg']) {
      keyed[ch] = keysOfChannel(keys ?? [], ch).length ? res.resolved[ch] : null
    }
    return {
      values: { base: res.base, event: keyed, sweep: sweepLayer, resolved: resolvedWithSweep },
      note: r.inside ? `Playhead ${Math.round(r.t)} ticks into the event.`
        : `Playhead is ${r.before ? 'before' : 'after'} this event: showing its ${r.before ? 'first' : 'last'} frame.`,
    }
  })

  if (!ready) return <p className={lens.note}>Loading keys…</p>

  const onOp = (op) => {
    const next = applyKeyOp(keys, op)
    if (next) write(next)
  }
  const rows = [
    { id: 'base', label: 'Base', layer: false },
    { id: 'event', label: 'This event', layer: false, status: keys.length ? null : 'no keys' },
    sweep.stackRow,
    { id: 'resolved', label: 'Resolved', layer: false },
  ]

  return (
    <div className={lens.advanced} data-testid="lens-advanced" data-advanced-kind="event">
      <div className={lens.subhead}><span>Keyframes</span></div>
      <LensLayerStack
        rows={rows} compute={compute} subscribePlayhead={playhead.subscribe}
        label="Lens layers: base, this event's keys, sweep, and the resolved value at the playhead"
      />
      <LensKeyLanes
        kind="event" lengthTicks={len} base={base}
        ownKeys={keys} selected={selected} onSelect={setSelected} onOp={onOp}
        getPlayhead={getPlayhead} subscribePlayhead={playhead.subscribe}
        label="Lens keys of this event, in ticks from its start"
      />
      <p className={lens.note} data-testid="lens-lane-note">
        A keyed channel follows its keys; an unkeyed one holds the static value above. Keys move with the event.
      </p>
      <LensKeyInspector keyObj={selected} kind="event" lengthTicks={len} onOp={onOp} onSelect={setSelected} />
    </div>
  )
}

