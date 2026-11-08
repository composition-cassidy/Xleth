import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ClipPictureSection from './ClipPictureSection.jsx'
import { X, RotateCcw } from 'lucide-react'
import useClipScratchEditorStore from '../../stores/clipScratchEditorStore.js'
import BreakpointCurveEditor from '../common/BreakpointCurveEditor.jsx'
import { getTransportState, subscribe } from '../../transportStore.js'
import { ticksToBeats } from '../../constants/timeline.js'
import {
  SCRATCH_BABY_DEFAULT_COUNT,
  SCRATCH_BABY_DEFAULT_LENGTH_BEATS,
  SCRATCH_BABY_LENGTHS,
  SCRATCH_DEFAULTS,
  SCRATCH_EDGE_MODES,
  SCRATCH_GAIN_COMP_MAX_DB,
  SCRATCH_GAIN_COMP_MIN_DB,
  SCRATCH_MAX_POINTS,
  SCRATCH_MIN_POINTS,
  SCRATCH_POINT_ADAPTER,
  SCRATCH_PRESET_CHIPS,
  SCRATCH_RATE_MAX,
  SCRATCH_RATE_MIN,
  SCRATCH_TENSION_EPS,
  SCRATCH_TIME_MODES,
  SCRATCH_TIME_MODE_LABELS,
  clampScratchCount,
  inferBabyScratchSettings,
  makeScratchSampler,
  normalizeScratchLengthBeats,
  scratchPresetKeyForScratch,
  scratchPresetPatch,
  scratchSegmentCanBend,
  scratchTensionFromPointer,
  scratchTensionHandle,
  scratchTimeDomain,
  scratchXLabels,
} from './clipScratch.js'

// ── Floating per-clip Scratch rate-graph editor ──────────────────────────────
//
// Replaces the dropdown's preset-only model with direct curve editing. The
// dropdown stays as the quick summary (preset name or Custom, smoothing, edge
// mode); the curve itself is authored here.
//
// MOUNTING: this panel is `position: fixed` and MUST be mounted by
// ClipFxEditorHost at the windowing root — never inside a PanelFrame. A floating
// PanelFrame positions itself with `transform: translate3d(...)`, and a CSS
// transform establishes a containing block for `position: fixed` descendants,
// which would clip this editor to that frame's box. Same rule, same reason as
// ClipVibratoEditorPanel.jsx and EffectEditorHost.jsx document.
//
// AXES. X is clip time in the ACTIVE time mode. Switching the mode does not
// rescale the stored numbers — it reinterprets them, exactly as the engine does
// (ClipModulationEvaluator.cpp scratchPointTimeSeconds), so the axis relabels
// and the same points land where the engine would actually put them. Y is the
// rate multiplier over -2x..+2x; negative rate is reverse playback, which is
// how the Reverse and Baby Scratch presets work.
//
// TENSION. The engine's evaluateScratch() plays every segment as a straight
// line and never reads ScratchPoint::curve, so a bend that only existed as a
// drawn spline would be a preview the audio thread does not honour. Instead a
// tension drag is BAKED into real breakpoints on release (clipScratch.js
// bakeScratchCurve) — the bend is made of the linear pieces the engine already
// plays, so the graph and the audio agree by construction.
//
// EDIT DISCIPLINE: point and tension drags preview through the store
// (previewCurve, purely local, zero IPC) and commit exactly once on release.
// Sliders draft locally and commit on pointer release; chips, dropdowns and the
// preset stampers commit on change. Every one of those routes through
// mergeClipModulationPatch + setClipModulation, so one gesture is one undo step.
//
// THEMING: CSS custom-property tokens only, no hardcoded hex. tokenValue() is
// never called at module scope. Flat, zero border-radius, hard shadow; accent is
// reserved for meaningful state (the active preset, the active time mode, a
// bent segment's handle, the LED, the curve).

const GRAPH_W = 504
const GRAPH_H = 260
const GRAPH_PAD = { left: 30, right: 10, top: 10, bottom: 18 }

const GRID_Y = [SCRATCH_RATE_MIN, SCRATCH_RATE_MAX]
const STRONG_GRID_Y = [1, -1]
const Y_LABELS = [
  { v: 2, text: '+2x' },
  { v: 1, text: '+1x' },
  { v: 0, text: '0x' },
  { v: -1, text: '-1x' },
  { v: -2, text: '-2x' },
]
const NOTES = [{ v: -1.6, text: 'REV', side: 'right' }]

const clampNum = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x)

// A range input that drafts locally while dragging and commits once on release,
// so a slider sweep is one engine write and one undo step — matching how the
// clip dropdown's ClipSliderRow and the Vibrato editor's ScalarSlider behave.
function ScalarSlider({ label, value, min, max, step, format, disabled, onCommit }) {
  const [draft, setDraft] = useState(null)
  const shown = draft ?? value

  const commit = useCallback(() => {
    setDraft((d) => {
      if (d != null && d !== value) onCommit(d)
      return null
    })
  }, [onCommit, value])

  return (
    <div className="clipfx-param">
      <label className="clipfx-param-label">{label}</label>
      <input
        type="range"
        className="clipfx-range"
        min={min}
        max={max}
        step={step}
        value={shown}
        disabled={disabled}
        onChange={(e) => setDraft(Number(e.target.value))}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={commit}
      />
      <span className="clipfx-param-value">{format(shown)}</span>
    </div>
  )
}

export default function ClipScratchEditorPanel() {
  const target = useClipScratchEditorStore(s => s.target)
  const clip = useClipScratchEditorStore(s => s.clip)
  const commitVideo = useClipScratchEditorStore(s => s.commitVideo)
  const draftCurve = useClipScratchEditorStore(s => s.draftCurve)
  const selectedIdx = useClipScratchEditorStore(s => s.selectedIdx)
  const close = useClipScratchEditorStore(s => s.close)
  const setSelectedIdx = useClipScratchEditorStore(s => s.setSelectedIdx)
  const previewCurve = useClipScratchEditorStore(s => s.previewCurve)
  const commitCurve = useClipScratchEditorStore(s => s.commitCurve)
  const commitScratch = useClipScratchEditorStore(s => s.commitScratch)
  const authorCurve = useClipScratchEditorStore(s => s.authorCurve)

  const [panelPos, setPanelPos] = useState(() => ({
    x: Math.round((globalThis.window?.innerWidth ?? 1280) / 2 - GRAPH_W / 2),
    y: 120,
  }))
  const panelDragRef = useRef(null)

  const handleHeaderPointerDown = useCallback((e) => {
    if (e.target.closest('button')) return
    e.preventDefault()
    panelDragRef.current = {
      startMouseX: e.clientX, startMouseY: e.clientY,
      startPanelX: panelPos.x, startPanelY: panelPos.y,
    }
  }, [panelPos])

  useEffect(() => {
    const onMove = (e) => {
      const drag = panelDragRef.current
      if (!drag) return
      setPanelPos({
        x: clampNum(drag.startPanelX + e.clientX - drag.startMouseX, -300, (globalThis.window?.innerWidth ?? 1280) - 80),
        y: clampNum(drag.startPanelY + e.clientY - drag.startMouseY, 0, (globalThis.window?.innerHeight ?? 800) - 60),
      })
    }
    const onUp = () => { panelDragRef.current = null }
    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerup', onUp)
    return () => {
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerup', onUp)
    }
  }, [])

  // Tempo for the Beats/Seconds axes. transportStore is already polling for the
  // whole app, so this costs no extra IPC — and its cached value seeds the first
  // render before the next 250 ms tick lands.
  const [bpm, setBpm] = useState(() => getTransportState()?.bpm ?? 140)
  useEffect(() => subscribe((s) => {
    if (Number.isFinite(s?.bpm) && s.bpm > 0) setBpm(s.bpm)
  }), [])

  const scratch = clip?.modulation?.scratch ?? null

  // Baby-generator settings are UI state, seeded from whatever the stored curve
  // turns out to be so reopening the editor on a baby curve shows its real
  // count/length rather than the defaults.
  const [babyCount, setBabyCount] = useState(SCRATCH_BABY_DEFAULT_COUNT)
  const [babyLength, setBabyLength] = useState(SCRATCH_BABY_DEFAULT_LENGTH_BEATS)
  const seededForRef = useRef(null)
  useEffect(() => {
    if (!target) { seededForRef.current = null; return }
    if (seededForRef.current === target.clipId) return
    if (!scratch) return
    seededForRef.current = target.clipId
    const inferred = inferBabyScratchSettings(scratch)
    if (inferred) {
      setBabyCount(inferred.count)
      setBabyLength(inferred.lengthBeats)
    }
  }, [target, scratch])

  const timeMode = scratch?.timeMode ?? SCRATCH_DEFAULTS.timeMode
  const edgeMode = scratch?.edgeMode ?? SCRATCH_DEFAULTS.edgeMode
  const smoothingMs = Number.isFinite(scratch?.smoothingMs) ? scratch.smoothingMs : SCRATCH_DEFAULTS.smoothingMs
  const gainDb = Number.isFinite(scratch?.gainCompensationDb) ? scratch.gainCompensationDb : 0
  const enabled = Boolean(scratch?.enabled)

  const presetKey = scratchPresetKeyForScratch(scratch ?? {})
  const isCustom = presetKey === 'custom'

  const clipBeats = ticksToBeats(Number(clip?.durationTicks) || 0)
  const clipSeconds = bpm > 0 ? clipBeats / (bpm / 60) : 0

  // AUTHOR points — the local draft while a gesture is in flight, otherwise the
  // engine curve unbaked. `authorCurve` is a stable store action that reads live
  // state, so `draftCurve` and `scratch` are the deps that actually say when the
  // answer changed.
  const points = useMemo(() => authorCurve(), [authorCurve, draftCurve, scratch])

  const { tMin, tMax } = scratchTimeDomain(timeMode, { clipSeconds, clipBeats }, points)
  const sampler = useMemo(() => makeScratchSampler(points), [points])
  const xLabels = useMemo(() => scratchXLabels(timeMode, tMax), [timeMode, tMax])

  // One diamond per bendable segment. A segment whose endpoints share a rate has
  // nothing to ease between, so it gets no handle at all rather than a control
  // that moves without changing what you hear.
  const segments = useMemo(() => {
    const out = []
    for (let i = 0; i + 1 < points.length; i += 1) {
      if (!scratchSegmentCanBend(points[i], points[i + 1])) continue
      const tension = points[i].tension ?? 0
      const { t, v } = scratchTensionHandle(points[i], points[i + 1], tension)
      out.push({ idx: i, t, v, active: Math.abs(tension) >= SCRATCH_TENSION_EPS })
    }
    return out
  }, [points])

  // A tension drag rewrites ONE point's tension. `latest` is the gesture's own
  // authority: the preview round-trips through the store and a React render, so
  // reading `points` back on release could commit the pre-drag curve.
  const tensionDragRef = useRef(null)
  const pointsRef = useRef(points)
  pointsRef.current = points

  const handleTensionPreview = useCallback((handleIdx, { px, py, geo }) => {
    const seg = segments[handleIdx]
    if (!seg) return
    const base = tensionDragRef.current?.latest ?? pointsRef.current
    const a = base[seg.idx]
    const b = base[seg.idx + 1]
    if (!a || !b) return
    const tension = scratchTensionFromPointer(a, b, geo, px, py)
    const next = base.slice()
    next[seg.idx] = { ...a, tension }
    tensionDragRef.current = { latest: next }
    previewCurve(next)
  }, [segments, previewCurve])

  const handleTensionCommit = useCallback(() => {
    const drag = tensionDragRef.current
    tensionDragRef.current = null
    if (drag?.latest) commitCurve(drag.latest)
  }, [commitCurve])

  const handleTensionReset = useCallback((handleIdx) => {
    const seg = segments[handleIdx]
    if (!seg) return
    const base = pointsRef.current
    const a = base[seg.idx]
    if (!a || Math.abs(a.tension ?? 0) < SCRATCH_TENSION_EPS) return
    const next = base.slice()
    next[seg.idx] = { ...a, tension: 0 }
    commitCurve(next)
  }, [segments, commitCurve])

  // Preset chips are STAMPERS: they write the preset's points and select the
  // time mode they were authored in, in one commit. Any manual edit afterwards
  // stops matching a preset, which is exactly what flips the indicator to
  // Custom — no separate dirty flag to keep in sync.
  const stampPreset = useCallback((key) => {
    setSelectedIdx(-1)
    commitScratch(scratchPresetPatch(key, {
      scratchCount: babyCount,
      lengthBeats: babyLength,
    }))
  }, [commitScratch, setSelectedIdx, babyCount, babyLength])

  if (!target) return null

  const modeLabel = SCRATCH_TIME_MODE_LABELS[timeMode] ?? timeMode
  const edgeLabel = (SCRATCH_EDGE_MODES.find(([v]) => v === edgeMode) ?? ['', edgeMode])[1]
  const statusRight =
    `${points.length} pts · ${modeLabel} · Edge: ${edgeLabel}${isCustom ? ' · Custom' : ''}`

  return (
    <div
      className="clipfx-window"
      style={{ left: panelPos.x, top: panelPos.y, width: GRAPH_W + 16 }}
      data-testid="clip-scratch-editor"
      tabIndex={0}
    >
      <div className="clipfx-titlebar" onPointerDown={handleHeaderPointerDown}>
        <span className="clipfx-swatch" />
        <span className="clipfx-title">Scratch</span>
        <span className="clipfx-subtitle">
          Clip {target.clipId} · Per-Clip · Rate Graph
        </span>
        <span className="clipfx-spacer" />
        <button type="button" className="clipfx-close" onClick={close} title="Close">
          <X size={12} />
        </button>
      </div>

      <div className="clipfx-row">
        <span className="clipfx-row-label">Stamp</span>
        {SCRATCH_PRESET_CHIPS.map(([value, label]) => (
          <button
            key={value}
            type="button"
            className={`clipfx-chip${presetKey === value ? ' is-on' : ''}`}
            onClick={() => stampPreset(value)}
            title={`Stamp the ${label} curve`}
          >
            {label}
          </button>
        ))}
        {isCustom && (
          <span className="clipfx-chip is-on clipfx-chip-static" data-testid="scratch-custom-indicator">
            Custom
          </span>
        )}
        <span className="clipfx-spacer" />
        <button
          type="button" className="clipfx-icon-btn"
          onClick={() => stampPreset('normal')} title="Reset to Normal"
        >
          <RotateCcw size={11} />
        </button>
      </div>

      <div className="clipfx-row">
        <span className="clipfx-row-label">Baby Gen</span>
        <label className="clipfx-inline-label" htmlFor="clipfx-baby-count">Count</label>
        <select
          id="clipfx-baby-count"
          className="clipfx-select"
          value={babyCount}
          onChange={(e) => setBabyCount(clampScratchCount(e.target.value))}
        >
          {[1, 2, 3, 4, 5, 6, 7, 8].map(n => <option key={n} value={n}>{n}</option>)}
        </select>
        <label className="clipfx-inline-label" htmlFor="clipfx-baby-len">Len</label>
        <select
          id="clipfx-baby-len"
          className="clipfx-select"
          value={babyLength}
          onChange={(e) => setBabyLength(normalizeScratchLengthBeats(e.target.value))}
        >
          {SCRATCH_BABY_LENGTHS.map(([length, label]) => (
            <option key={length} value={length}>{label}</option>
          ))}
        </select>
        <button
          type="button" className="clipfx-chip"
          onClick={() => stampPreset('babyScratch')}
          title="Generate a baby-scratch curve from the count and length"
        >
          Generate →
        </button>
        <span className="clipfx-spacer" />
        <span className="clipfx-row-hint">Generators stamp points — then edit freely</span>
      </div>

      <div className="clipfx-graph-wrap">
        <BreakpointCurveEditor
          className="clipfx-graph"
          points={points}
          adapter={SCRATCH_POINT_ADAPTER}
          sample={sampler}
          width={GRAPH_W}
          height={GRAPH_H}
          pad={GRAPH_PAD}
          tMin={tMin}
          tMax={tMax}
          vMin={SCRATCH_RATE_MIN}
          vMax={SCRATCH_RATE_MAX}
          editable
          selectedIdx={selectedIdx}
          minPoints={SCRATCH_MIN_POINTS}
          maxPoints={SCRATCH_MAX_POINTS}
          gridXDivisions={8}
          gridYValues={GRID_Y}
          strongGridYValues={STRONG_GRID_Y}
          zeroLine={0}
          xLabels={xLabels}
          yLabels={Y_LABELS}
          notes={NOTES}
          handles={segments}
          ariaLabel="Scratch rate curve over clip time"
          onSelect={setSelectedIdx}
          onPreview={previewCurve}
          onCommit={commitCurve}
          onHandlePreview={handleTensionPreview}
          onHandleCommit={handleTensionCommit}
          onHandleReset={handleTensionReset}
        />
        <span className="clipfx-graph-hint">Drag ◇ on a segment for tension</span>
      </div>

      <div className="clipfx-param-grid">
        <div className="clipfx-param">
          <label className="clipfx-param-label">Time Mode</label>
          <div className="clipfx-seg" role="group" aria-label="Time mode">
            {SCRATCH_TIME_MODES.map(([value, label]) => (
              <button
                key={value}
                type="button"
                className={`clipfx-seg-btn${timeMode === value ? ' is-on' : ''}`}
                onClick={() => commitScratch({ timeMode: value })}
              >{label}</button>
            ))}
          </div>
          <span className="clipfx-param-value">
            {`0 – ${xLabels[xLabels.length - 1]?.text ?? ''}`}
          </span>
        </div>

        <ScalarSlider
          label="Smoothing"
          value={Number(smoothingMs.toFixed(1))}
          min={0} max={50} step={0.1}
          format={(x) => `${Number(x).toFixed(1)} ms`}
          onCommit={(x) => commitScratch({ smoothingMs: x })}
        />

        <div className="clipfx-param">
          <label className="clipfx-param-label" htmlFor="clipfx-edge-mode">Edge Mode</label>
          <select
            id="clipfx-edge-mode"
            className="clipfx-select"
            value={edgeMode}
            onChange={(e) => commitScratch({ edgeMode: e.target.value })}
          >
            {SCRATCH_EDGE_MODES.map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
          <span className="clipfx-param-value">
            {presetKey === 'custom' ? 'Curve: Custom' : `Curve: ${presetKey}`}
          </span>
        </div>

        <ScalarSlider
          label="Gain Comp"
          value={Number(gainDb.toFixed(1))}
          min={SCRATCH_GAIN_COMP_MIN_DB} max={SCRATCH_GAIN_COMP_MAX_DB} step={0.5}
          format={(x) => `${Number(x) > 0 ? '+' : ''}${Number(x).toFixed(1)} dB`}
          onCommit={(x) => commitScratch({ gainCompensationDb: x })}
        />
      </div>

      <ClipPictureSection kind="wave" clip={clip} commitVideo={commitVideo} />

      <div className="clipfx-status">
        <span className={`clipfx-led${enabled ? ' is-on' : ''}`} />
        <span>{enabled ? 'Active' : 'Off'}</span>
        <span className="clipfx-status-right">{statusRight}</span>
      </div>
    </div>
  )
}
