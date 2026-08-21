import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import XlethSelect from '../../common/XlethSelect.jsx'
import ContextMenu from '../../ContextMenu.jsx'
import EffectPresetBar from '../../../fx-presets/EffectPresetBar.jsx'
import DragNumberField from './DragNumberField.jsx'
import BezierSegmentEditor from './BezierSegmentEditor.jsx'
import ZprKeyframeCanvas from './ZprKeyframeCanvas.jsx'
import ZprViewport from './ZprViewport.jsx'
import {
  exp2, log2, evaluateTrack, insertKeyframe, removeKeyframe, moveKeyframe,
  setKeyframeValue, setKeyframeCurve, resolveLengthMs, formatMs,
  MUSICAL_DIVISIONS, IDENTITY_CURVE, clamp01, rdpSimplifyNormalized,
} from './zprCurveMath.js'
import {
  canonicalToRect, rectToCanonical, sampleMotionPath, motionPathKeyPoints,
  opRestore, opCenter, opFlipHorizontal, opFlipVertical,
  opMatchOutputAspect, opMatchSourceAspect,
} from './zprRectMath.js'
import { resolveTrackSourceFrame, cellAspectFor } from './zprSourceFrame.js'
import { subscribe as subscribeTransport, getTransportState } from '../../../transportStore.js'
import { playheadClock } from '../../../services/PlayheadClock.js'
import { PPQ } from '../../../constants/timeline.js'

const DEFAULT_RECORD_TOLERANCE = 0.03  // fraction of each channel's own recorded range

// Zoom/Pan/Rot editor for the track-level card in VisualFXSection.
//
// P1 shipped the numeric inspector + keyframe timeline + bezier editor. P2 adds
// the spatial viewport on the left: Vegas Pan/Crop direct manipulation writing
// straight into the same four ParamTracks.
//
// ── Viewport semantics ───────────────────────────────────────────────────
// The rect is a CAMERA WINDOW OVER THE SOURCE — shrinking it zooms IN. One
// model, no toggle. The derived "2.18x" readout in the inspector is the other
// mental model and is live-synced (it evaluates the same localTracks the
// viewport drag is mutating). See zprRectMath.js for the shader-derived
// mapping and for why panX/panY stay UV offsets rather than becoming
// centerX/centerY.
//
// ── Scope decisions carried over from P1 ─────────────────────────────────
// 1. There is no W/H channel; ZprTracks documents their absence as deliberate.
//    The window is therefore a UV square and its on-screen shape is always the
//    cell's. Aspect lock governs whether edge handles are live, not whether the
//    aspect is preserved — corners preserve it by construction.
// 2. Opacity renders disabled; no channel exists and adding one touches the
//    evaluator.
//
// ── P2 decisions worth review ────────────────────────────────────────────
// 3. Rotation centre is a UI-side pivot kept per track for the session
//    (pivotByTrack below), not a persisted field. Rotation about an arbitrary
//    pivot is realized as rotate-about-centre plus a compensating pan, which
//    panX/panY already express — so the pin needs no new channel, no schema
//    bump and no evaluator change. Persisting it would mean a new
//    ZoomPanRotSettings field plus its project.json save/load entry.
// 4. The motion path is sampled with zprCurveMath.evaluateTrack, the exact
//    mirror of ParamTrack.cpp::evaluate. It has to redraw on every pointer
//    move and IPC during a drag is forbidden, so it cannot round-trip to the
//    engine per sample.
// 5. Flip Horizontal / Vertical mirror the FRAMING, not the pixels — a pixel
//    mirror is a signed scale and there is no channel for it. See
//    zprRectMath.js opFlipHorizontal.

const LENGTH_MODE_OPTIONS = [
  { value: 0, label: 'Fixed' },
  { value: 1, label: 'Musical' },
  { value: 2, label: 'Note' },
]

const MUSICAL_DIVISION_OPTIONS = MUSICAL_DIVISIONS.map((d, i) => ({ value: i, label: d.label }))

const ON_END_OPTIONS = [
  { value: 0, label: 'Hold' },
  { value: 1, label: 'Reset' },
  { value: 2, label: 'Loop' },
  { value: 3, label: 'Ping-pong' },
]

const RETRIGGER_OPTIONS = [
  { value: 0, label: 'Restart' },
  { value: 1, label: 'Ignore' },
  { value: 2, label: 'Crossfade' },
]

const CHANNELS_ALL = ['panX', 'panY', 'zoomLog2', 'rotationDeg']
const KEY_EPS = 1e-3
const VALUE_EPS = 1e-6

// Rotation pins survive a panel remount within the session; see decision 3.
const pivotByTrack = new Map()

function cloneTracks(tracks) {
  const out = {}
  for (const ch of CHANNELS_ALL) {
    const t = tracks?.[ch] || { constantValue: 0, keys: [] }
    out[ch] = {
      constantValue: t.constantValue ?? 0,
      keys: (t.keys || []).map(k => ({ t: k.t, v: k.v, c: k.c ? k.c.slice() : IDENTITY_CURVE.slice() })),
    }
  }
  return out
}

/**
 * True when any channel's last keyframe value differs from its first — the
 * seam Loop mode restarts across every window without smoothing (by design,
 * see AnimationManager.cpp: Loop wraps t with no interpolated blend at the
 * boundary). Channels with fewer than 2 keys (constant or unanimated) can't
 * pop, so they're skipped.
 */
function hasLoopDiscontinuity(tracks) {
  for (const ch of CHANNELS_ALL) {
    const keys = tracks?.[ch]?.keys || []
    if (keys.length < 2) continue
    if (Math.abs(keys[keys.length - 1].v - keys[0].v) > VALUE_EPS) return true
  }
  return false
}

function findKeyframeAtT(track, t) {
  const keys = track?.keys || []
  for (let i = 0; i < keys.length; i++) {
    if (Math.abs(keys[i].t - t) < KEY_EPS) return i
  }
  return -1
}

function clampKeyframeT(keys, index, t) {
  const eps = 1e-4
  const lo = index > 0 ? keys[index - 1].t + eps : 0
  const hi = index < keys.length - 1 ? keys[index + 1].t - eps : 1
  return Math.max(lo, Math.min(hi, t))
}

/** Write one channel at t: edit the keyframe already there, else insert one. */
function writeChannelAtT(track, t, value) {
  const existing = findKeyframeAtT(track, t)
  return existing >= 0
    ? setKeyframeValue(track, existing, value)
    : insertKeyframe(track, { t, v: value, c: IDENTITY_CURVE.slice() })
}

/**
 * Push a canonical 4-tuple into the tracks at `t`, touching ONLY the channels
 * whose value actually moved. A pure pan drag must not litter rotationDeg with
 * keyframes it never asked for.
 */
function writeCanonicalAtT(tracks, t, next) {
  const out = { ...tracks }
  for (const ch of CHANNELS_ALL) {
    const before = evaluateTrack(tracks[ch], t)
    if (Math.abs(next[ch] - before) < VALUE_EPS) continue
    out[ch] = writeChannelAtT(tracks[ch], t, next[ch])
  }
  return out
}

// variant:
//   'track' — the Visual FX card. Owns Length / On end / Retrigger and presets.
//   'slide' — the Slide Note Effect's ZPR. Same four ParamTracks, same editor,
//             but the curves describe an ADDITIVE DELTA over whatever the
//             track's own animation is doing (identity = 0.00, 0.00, 1.00x,
//             0.0°), and the window length + return policy are owned by the
//             slide config above the card, so those header rows are hidden.
//             slideLengthMs is that resolved window, or null for "Follow
//             Slide", where the length isn't known until a note fires.
export default function ZprTimelineCard({
  trackId, zpr, onApplyScalar, onApplyTracks, onPresetApplied,
  variant = 'track', slideLengthMs = null,
}) {
  const isSlide = variant === 'slide'
  const [bpm, setBpm] = useState(() => getTransportState()?.bpm ?? 120)
  const [playheadTick, setPlayheadTick] = useState(0)
  const [isPlaying, setIsPlaying] = useState(() => !!getTransportState()?.isPlaying)
  useEffect(() => subscribeTransport((s) => {
    if (Number.isFinite(s?.bpm)) setBpm(s.bpm)
    const beats = s?.rawPositionBeats ?? s?.positionBeats
    if (Number.isFinite(beats)) setPlayheadTick(Math.max(0, Math.round(beats * PPQ)))
    if (typeof s?.isPlaying === 'boolean') setIsPlaying(s.isPlaying)
  }), [])

  // ── real-time recording ─────────────────────────────────────────────────
  // Arm + play + drag the viewport = write keyframes at the live playhead.
  // Buffered entirely in a ref (zero IPC, zero re-render per sample) and
  // reduced/committed once on stop — see finalizeRecording below.
  const [armed, setArmed] = useState(false)
  const [recordTolerance, setRecordTolerance] = useState(DEFAULT_RECORD_TOLERANCE)
  const armedRef = useRef(false)
  useEffect(() => { armedRef.current = armed }, [armed])
  const isPlayingRef = useRef(false)
  useEffect(() => { isPlayingRef.current = isPlaying }, [isPlaying])
  const recordingRef = useRef({ samples: [] })

  const [localTracks, setLocalTracks] = useState(() => cloneTracks(zpr?.tracks))
  const draggingRef = useRef(false)
  useEffect(() => {
    if (draggingRef.current) return
    setLocalTracks(cloneTracks(zpr?.tracks))
  }, [zpr?.tracks])

  // Mirror of localTracks readable from a pointerup handler without waiting for
  // the closure to be recreated. Only the viewport commit path needs it.
  const localTracksRef = useRef(localTracks)
  useEffect(() => { localTracksRef.current = localTracks }, [localTracks])

  const [scrubT, setScrubT] = useState(0)
  const [selectedKey, setSelectedKey] = useState(null)
  const [selectedSegment, setSelectedSegment] = useState(null)
  const [positionExpanded, setPositionExpanded] = useState(false)

  // ── viewport state ──────────────────────────────────────────────────────
  const [aspectLocked, setAspectLocked] = useState(true)
  const [pivot, setPivotState] = useState(() => pivotByTrack.get(trackId) || null)
  const [cellAspect, setCellAspect] = useState(16 / 9)
  const [sourceAspect, setSourceAspect] = useState(null)
  const [frameUrl, setFrameUrl] = useState(null)
  const [menu, setMenu] = useState(null)

  const setPivot = useCallback((p) => {
    pivotByTrack.set(trackId, p)
    setPivotState(p)
  }, [trackId])

  useEffect(() => { setPivotState(pivotByTrack.get(trackId) || null) }, [trackId])

  const lengthMode = zpr?.lengthMode ?? 1
  const musicalDivision = zpr?.musicalDivision ?? 2
  const notePercentage = zpr?.notePercentage ?? 100
  const durationMs = zpr?.durationMs ?? 300
  const onEndMode = zpr?.onEndMode ?? 0
  const retriggerMode = zpr?.retriggerMode ?? 0
  const retriggerCrossfadeMs = zpr?.retriggerCrossfadeMs ?? 50

  // In slide mode the window is the slide's, not this config's — and under
  // "Follow Slide" its length is a property of the note that fires, unknown
  // here, so the ruler falls back to normalized percentages.
  const lengthMs = isSlide ? (slideLengthMs ?? 0) : resolveLengthMs(zpr, bpm, undefined)
  const showPercentRuler = isSlide && !Number.isFinite(slideLengthMs)
  const timeLabels = useMemo(() => (
    [0, 0.25, 0.5, 0.75, 1].map(frac => ({
      frac,
      label: showPercentRuler ? `${Math.round(frac * 100)}%` : formatMs(frac * lengthMs),
    }))
  ), [lengthMs, showPercentRuler])

  // ── cell aspect (the shape the viewport draws the unit square at) ────────
  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const layout = await window.xleth?.timeline?.getGridLayout?.()
        if (alive && layout) setCellAspect(cellAspectFor(layout, trackId))
      } catch { /* keep the 16:9 default */ }
    })()
    return () => { alive = false }
  }, [trackId])

  // ── backdrop frame, refreshed when the transport playhead moves ──────────
  // Never blocks: the viewport draws its checkerboard until this lands, and a
  // failure just leaves frameUrl null.
  useEffect(() => {
    let alive = true
    const id = setTimeout(async () => {
      const res = await resolveTrackSourceFrame(trackId, playheadTick, bpm)
      if (!alive) return
      setFrameUrl(res.dataUrl)
      if (res.sourceAspect) setSourceAspect(res.sourceAspect)
    }, 120)
    return () => { alive = false; clearTimeout(id) }
  }, [trackId, playheadTick, bpm])

  // ── keyframe track mutations ────────────────────────────────────────
  const applyLocalTracks = useCallback((next) => {
    setLocalTracks(next)
    const payload = {}
    for (const ch of CHANNELS_ALL) {
      payload[ch] = { constantValue: next[ch].constantValue, keys: next[ch].keys }
    }
    onApplyTracks?.(payload)
  }, [onApplyTracks])

  // Thins the buffered recording (RDP, per-channel-range-normalized tolerance)
  // and commits it as ONE applyLocalTracks call — one onApplyTracks ->
  // one setTrackZprTracks RPC -> one UndoManager command (SetTrackZprTracksCommand),
  // exactly like a manual keyframe-drag commit. Never fires per sample.
  const finalizeRecording = useCallback(() => {
    const samples = recordingRef.current.samples
    recordingRef.current = { samples: [] }
    if (samples.length < 2) return

    const t0 = samples[0].ms
    const span = samples[samples.length - 1].ms - t0
    if (span <= 0) return

    const nextTracks = {}
    for (const ch of CHANNELS_ALL) {
      const raw = samples.map(s => ({ t: clamp01((s.ms - t0) / span), v: s[ch] }))
      const thinned = rdpSimplifyNormalized(raw, recordTolerance)
      nextTracks[ch] = {
        constantValue: 0,
        keys: thinned.map(p => ({ t: p.t, v: p.v, c: IDENTITY_CURVE.slice() })),
      }
    }

    console.log(
      `[XformAnim] recording committed: ${samples.length} raw samples -> ` +
      `panX ${nextTracks.panX.keys.length}, panY ${nextTracks.panY.keys.length}, ` +
      `zoomLog2 ${nextTracks.zoomLog2.keys.length}, rotationDeg ${nextTracks.rotationDeg.keys.length} ` +
      `keyframes after RDP thinning (tolerance=${(recordTolerance * 100).toFixed(1)}% of range)`
    )

    applyLocalTracks(nextTracks)
  }, [recordTolerance, applyLocalTracks])

  const toggleArmed = useCallback(() => {
    setArmed(prev => {
      const next = !prev
      if (!next && recordingRef.current.samples.length > 0) finalizeRecording()
      return next
    })
  }, [finalizeRecording])

  // Transport stopping is the other "stop" trigger (armed recording that was
  // still running when playback stopped, not just an explicit disarm).
  useEffect(() => {
    if (!isPlaying && recordingRef.current.samples.length > 0) finalizeRecording()
  }, [isPlaying, finalizeRecording])

  const handleKeyframeAdd = useCallback((channel, t) => {
    const v = evaluateTrack(localTracks[channel], t)
    const next = {
      ...localTracks,
      [channel]: insertKeyframe(localTracks[channel], { t, v, c: IDENTITY_CURVE.slice() }),
    }
    applyLocalTracks(next)
  }, [localTracks, applyLocalTracks])

  const handleKeyframeMove = useCallback((channel, index, newT) => {
    draggingRef.current = true
    setLocalTracks(prev => {
      const clamped = clampKeyframeT(prev[channel].keys, index, newT)
      return { ...prev, [channel]: moveKeyframe(prev[channel], index, clamped) }
    })
  }, [])

  const handleKeyframeMoveCommit = useCallback((channel, index, newT) => {
    draggingRef.current = false
    const clamped = clampKeyframeT(localTracks[channel].keys, index, newT)
    const movedTrack = moveKeyframe(localTracks[channel], index, clamped)
    const next = { ...localTracks, [channel]: movedTrack }
    setSelectedKey({ channel, index })
    applyLocalTracks(next)
  }, [localTracks, applyLocalTracks])

  const handleKeyframeDelete = useCallback((channel, index) => {
    applyLocalTracks({ ...localTracks, [channel]: removeKeyframe(localTracks[channel], index) })
  }, [localTracks, applyLocalTracks])

  // ── bezier segment editing ──────────────────────────────────────────
  const segmentCurve = useMemo(() => {
    if (!selectedSegment) return null
    const key = localTracks[selectedSegment.channel]?.keys?.[selectedSegment.index]
    return key?.c || IDENTITY_CURVE.slice()
  }, [selectedSegment, localTracks])

  const handleSegmentLiveChange = useCallback((curve) => {
    if (!selectedSegment) return
    setLocalTracks(prev => ({
      ...prev,
      [selectedSegment.channel]: setKeyframeCurve(prev[selectedSegment.channel], selectedSegment.index, curve),
    }))
  }, [selectedSegment])

  const handleSegmentCommit = useCallback((curve) => {
    if (!selectedSegment) return
    const next = {
      ...localTracks,
      [selectedSegment.channel]: setKeyframeCurve(localTracks[selectedSegment.channel], selectedSegment.index, curve),
    }
    applyLocalTracks(next)
  }, [selectedSegment, localTracks, applyLocalTracks])

  // ── numeric inspector ────────────────────────────────────────────────
  // Editing at a t that already carries a keyframe (within KEY_EPS) edits
  // that keyframe; editing between keyframes inserts a new one at the
  // playhead, per the task spec.
  const fieldCommit = useCallback((channel, toInternal, displayValue) => {
    const track = localTracks[channel]
    applyLocalTracks({
      ...localTracks,
      [channel]: writeChannelAtT(track, scrubT, toInternal(displayValue)),
    })
  }, [localTracks, scrubT, applyLocalTracks])

  const fieldLiveChange = useCallback((channel, toInternal, displayValue) => {
    const internal = toInternal(displayValue)
    setLocalTracks(prev => ({
      ...prev,
      [channel]: writeChannelAtT(prev[channel], scrubT, internal),
    }))
  }, [scrubT])

  const panX = evaluateTrack(localTracks.panX, scrubT)
  const panY = evaluateTrack(localTracks.panY, scrubT)
  const zoomLog2 = evaluateTrack(localTracks.zoomLog2, scrubT)
  const rotationDeg = evaluateTrack(localTracks.rotationDeg, scrubT)
  const zoomLinear = exp2(zoomLog2)

  // ── viewport <-> tracks ──────────────────────────────────────────────
  // The rect is derived from the SAME localTracks the inspector reads, so the
  // two are bidirectionally synced with no second source of truth.
  const rect = useMemo(
    () => canonicalToRect({ panX, panY, zoomLog2, rotationDeg }),
    [panX, panY, zoomLog2, rotationDeg])

  const motionPath = useMemo(
    () => sampleMotionPath(localTracks, evaluateTrack), [localTracks])
  const motionKeys = useMemo(
    () => motionPathKeyPoints(localTracks, evaluateTrack), [localTracks])

  // Live: local state only, never IPC (the whole point of the split). Also
  // the recording tap: when armed + rolling, additionally buffer a sample at
  // the live (60fps-interpolated, zero-IPC) playhead position — recording
  // tracks the transport, not scrubT, but the on-screen rect/canvas still
  // follow the drag exactly as normal so the user can see what they're
  // drawing while it's captured.
  const handleRectLive = useCallback((nextRect) => {
    draggingRef.current = true
    const next = rectToCanonical(nextRect)
    setLocalTracks(prev => writeCanonicalAtT(prev, scrubT, next))
    if (armedRef.current && isPlayingRef.current) {
      recordingRef.current.samples.push({ ms: playheadClock.positionMs, ...next })
    }
  }, [scrubT])

  // Commit: exactly one setTrackZprTracks -> one UndoManager command.
  // Merges onto localTracksRef rather than inside a setState updater — the
  // updater can run twice (StrictMode) and the IPC must fire exactly once.
  //
  // While a recording gesture is in flight (armed + was rolling for this
  // drag), this is NOT the commit path — the scrubT-based write below has
  // nothing to do with what was just recorded at the live playhead, and
  // finalizeRecording() is the sole committer for recorded data (on stop).
  // Skipping here also means a mouse-up never fires a second, conflicting
  // IPC write/undo-step on top of the eventual recording commit.
  const handleRectCommit = useCallback((nextRect) => {
    draggingRef.current = false
    const next = rectToCanonical(nextRect)

    if (armedRef.current && isPlayingRef.current) {
      recordingRef.current.samples.push({ ms: playheadClock.positionMs, ...next })
      setLocalTracks(prev => writeCanonicalAtT(prev, scrubT, next))
      return
    }

    const merged = writeCanonicalAtT(localTracksRef.current, scrubT, next)
    localTracksRef.current = merged
    setLocalTracks(merged)

    console.log('[XformView] commit at t=' + scrubT.toFixed(3),
      `pan=(${next.panX.toFixed(3)}, ${next.panY.toFixed(3)})`,
      `zoom=${exp2(next.zoomLog2).toFixed(3)}x`,
      `rot=${next.rotationDeg.toFixed(2)}deg`)

    const payload = {}
    for (const ch of CHANNELS_ALL) {
      payload[ch] = { constantValue: merged[ch].constantValue, keys: merged[ch].keys }
    }
    onApplyTracks?.(payload)
  }, [scrubT, onApplyTracks])

  const applyRectOp = useCallback((label, fn) => {
    const nextRect = fn(rect)
    console.log(`[XformView] ${label}`)
    handleRectCommit(nextRect)
  }, [rect, handleRectCommit])

  const menuItems = useMemo(() => ([
    { label: 'Restore',            onClick: () => applyRectOp('Restore', opRestore) },
    { label: 'Center',             onClick: () => applyRectOp('Center', opCenter) },
    { type: 'separator' },
    { label: 'Flip Horizontal',    onClick: () => applyRectOp('Flip Horizontal', opFlipHorizontal) },
    { label: 'Flip Vertical',      onClick: () => applyRectOp('Flip Vertical', opFlipVertical) },
    { type: 'separator' },
    { label: 'Match Output Aspect', onClick: () => applyRectOp('Match Output Aspect', opMatchOutputAspect) },
    { label: 'Match Source Aspect', onClick: () => applyRectOp('Match Source Aspect',
        (r) => opMatchSourceAspect(r, cellAspect, sourceAspect)) },
  ]), [applyRectOp, cellAspect, sourceAspect])

  // ── header scalar config ────────────────────────────────────────────
  const applyScalar = useCallback((patch) => onApplyScalar?.(patch), [onApplyScalar])

  // target.zpr is read directly by the 'xform' preset adapter (captureState)
  // instead of a round-trip through the audio bridge — zoomPanRot already
  // lives client-side in this same prop, see effectPresetAdapters.js.
  const presetTarget = useMemo(() => ({
    trackId, zpr, nodeId: trackId, storeKey: 'xform',
  }), [trackId, zpr])

  return (
    <div className={`zpr-timeline-card${isSlide ? ' is-slide' : ''}`}>
      <div className="zpr-timeline-header">
        {isSlide && (
          <div className="zpr-timeline-header-row zpr-slide-note">
            Delta layer — 0.00, 0.00, 1.00x, 0.0° adds nothing. Pan and rotation
            add to the track&apos;s own animation; zoom multiplies it.
          </div>
        )}
        {!isSlide && (
        <div className="zpr-timeline-header-row">
          <label>Preset</label>
          <EffectPresetBar
            className="zpr-preset-bar"
            effectType="xform"
            target={presetTarget}
            onApplied={onPresetApplied}
          />

          <label>Length</label>
          <XlethSelect
            className="zpr-header-select"
            value={lengthMode}
            options={LENGTH_MODE_OPTIONS}
            onChange={(v) => applyScalar({ lengthMode: v })}
            ariaLabel="Length mode"
          />
          {lengthMode === 0 && (
            <DragNumberField
              value={durationMs}
              precision={0}
              step={2}
              min={20}
              max={20000}
              suffix=" ms"
              onLiveChange={() => {}}
              onCommit={(v) => applyScalar({ durationMs: v })}
            />
          )}
          {lengthMode === 1 && (
            <>
              <XlethSelect
                className="zpr-header-select"
                value={musicalDivision}
                options={MUSICAL_DIVISION_OPTIONS}
                onChange={(v) => applyScalar({ musicalDivision: v })}
                ariaLabel="Musical division"
              />
              <span className="zpr-length-resolved">
                {MUSICAL_DIVISIONS[musicalDivision]?.label ?? '1/8'} @ {Math.round(bpm)} BPM = {formatMs(lengthMs)}
              </span>
            </>
          )}
          {lengthMode === 2 && (
            <DragNumberField
              value={notePercentage}
              precision={0}
              step={0.5}
              min={1}
              max={400}
              suffix=" %"
              onLiveChange={() => {}}
              onCommit={(v) => applyScalar({ notePercentage: v })}
            />
          )}
        </div>
        )}

        {!isSlide && (
        <div className="zpr-timeline-header-row">
          <label>On end</label>
          <XlethSelect
            className="zpr-header-select"
            value={onEndMode}
            options={ON_END_OPTIONS}
            onChange={(v) => applyScalar({ onEndMode: v })}
            ariaLabel="On end behaviour"
          />
          {onEndMode === 2 && hasLoopDiscontinuity(localTracks) && (
            <span
              className="zpr-loop-warning"
              title="Last keyframe value differs from the first — Loop restarts at t=0 every window without smoothing the seam, so this will pop."
            >
              ⚠
            </span>
          )}

          <label>Retrigger</label>
          <XlethSelect
            className="zpr-header-select"
            value={retriggerMode}
            options={RETRIGGER_OPTIONS}
            onChange={(v) => applyScalar({ retriggerMode: v })}
            ariaLabel="Retrigger behaviour"
          />
          {retriggerMode === 2 && (
            <DragNumberField
              value={retriggerCrossfadeMs}
              precision={0}
              step={1}
              min={1}
              max={2000}
              suffix=" ms"
              onLiveChange={() => {}}
              onCommit={(v) => applyScalar({ retriggerCrossfadeMs: v })}
            />
          )}
        </div>
        )}
      </div>

      {/* viewport left · numeric inspector right */}
      <div className="zpr-editor-row">
        <div className="zpr-viewport-col">
          <ZprViewport
            rect={rect}
            onRectLive={handleRectLive}
            onRectCommit={handleRectCommit}
            onContextMenu={(x, y) => setMenu({ x, y })}
            cellAspect={cellAspect}
            frameUrl={frameUrl}
            aspectLocked={aspectLocked}
            pivot={pivot}
            onPivotChange={setPivot}
            motionPath={motionPath}
            motionKeys={motionKeys}
            scrubT={scrubT}
          />
          <div className="zpr-viewport-toolbar">
            <button
              type="button"
              className={`zpr-viewport-toggle${aspectLocked ? ' is-active' : ''}`}
              onClick={() => setAspectLocked(v => !v)}
              title={aspectLocked
                ? 'Aspect locked — corner drags only. Unlock to enable edge handles.'
                : 'Aspect unlocked — edge handles pin the opposite edge and scale uniformly.'}
            >
              {aspectLocked ? 'Aspect: locked' : 'Aspect: free'}
            </button>
            <button
              type="button"
              className="zpr-viewport-toggle"
              onClick={() => setPivot({ x: rect.cx, y: rect.cy })}
              title="Move the rotation centre back to the window centre"
            >
              Reset pin
            </button>
            <button
              type="button"
              className={`zpr-viewport-toggle zpr-record-toggle${armed ? ' is-recording' : ''}`}
              onClick={toggleArmed}
              title={
                armed
                  ? (isPlaying
                      ? 'Recording armed — drag the viewport to write keyframes at the live playhead'
                      : 'Recording armed — waiting for playback to start')
                  : 'Arm real-time keyframe recording (drag while playing to record)'
              }
            >
              {armed ? '● Rec Armed' : 'Arm Rec'}
            </button>
            {armed && (
              <DragNumberField
                value={recordTolerance * 100}
                precision={1}
                step={0.5}
                min={0.5}
                max={20}
                suffix="% tol"
                onLiveChange={() => {}}
                onCommit={(v) => setRecordTolerance(clamp01(v / 100))}
              />
            )}
            <span className="zpr-viewport-hint">
              {frameUrl ? 'right-click for framing options' : 'no source frame — placeholder'}
            </span>
          </div>
        </div>

        <div className="zpr-inspector-col">
          <div className="zpr-numeric-inspector">
            <DragNumberField
              label="Pan X"
              value={panX}
              step={0.004}
              precision={2}
              min={-4}
              max={4}
              onLiveChange={(v) => fieldLiveChange('panX', x => x, v)}
              onCommit={(v) => fieldCommit('panX', x => x, v)}
            />
            <DragNumberField
              label="Pan Y"
              value={panY}
              step={0.004}
              precision={2}
              min={-4}
              max={4}
              onLiveChange={(v) => fieldLiveChange('panY', x => x, v)}
              onCommit={(v) => fieldCommit('panY', x => x, v)}
            />
            <DragNumberField
              label="Zoom"
              value={zoomLinear}
              suffix="x"
              step={0.01}
              precision={2}
              min={0.01}
              max={64}
              onLiveChange={(v) => fieldLiveChange('zoomLog2', x => log2(Math.max(1e-4, x)), v)}
              onCommit={(v) => fieldCommit('zoomLog2', x => log2(Math.max(1e-4, x)), v)}
            />
            <DragNumberField
              label="Rotation"
              value={rotationDeg}
              suffix="°"
              step={0.5}
              precision={1}
              onLiveChange={(v) => fieldLiveChange('rotationDeg', x => x, v)}
              onCommit={(v) => fieldCommit('rotationDeg', x => x, v)}
            />
          </div>
          <div className="zpr-inspector-derived">
            <span>Window {(rect.w * 100).toFixed(1)}% of cell</span>
            <span>Centre {rect.cx.toFixed(3)}, {rect.cy.toFixed(3)}</span>
          </div>
        </div>
      </div>

      <ZprKeyframeCanvas
        tracks={localTracks}
        scrubT={scrubT}
        onScrub={setScrubT}
        selectedKey={selectedKey}
        onSelectKey={setSelectedKey}
        selectedSegment={selectedSegment}
        onSelectSegment={setSelectedSegment}
        onKeyframeAdd={handleKeyframeAdd}
        onKeyframeMove={handleKeyframeMove}
        onKeyframeMoveCommit={handleKeyframeMoveCommit}
        onKeyframeDelete={handleKeyframeDelete}
        positionExpanded={positionExpanded}
        onTogglePositionExpanded={() => setPositionExpanded(v => !v)}
        timeLabels={timeLabels}
      />

      {selectedSegment && segmentCurve && (
        <BezierSegmentEditor
          curve={segmentCurve}
          onChange={handleSegmentLiveChange}
          onCommit={handleSegmentCommit}
        />
      )}

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />
      )}
    </div>
  )
}
