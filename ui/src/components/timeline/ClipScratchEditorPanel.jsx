import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ClipPictureSection from './ClipPictureSection.jsx'
import { RotateCcw } from 'lucide-react'
import { Button, IconButton, NumberBox, SegmentedControl, Select } from '../../ui-kit'
import ClipFxWindow, { FxRow, FxSpacer, FxGrid, FxField, FxGraph, FxStatus, FxStaticChip } from './ClipFxWindow.jsx'
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
const NOTES = [{ v: -1.6, text: 'Reverse', side: 'right' }]

const clampNum = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x)

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
    <ClipFxWindow
      title="Scratch"
      subtitle={`Clip ${target.clipId} \u00b7 per clip \u00b7 rate graph`}
      label="Scratch editor"
      testId="clip-scratch-editor"
      pos={panelPos}
      width={GRAPH_W + 16}
      onClose={close}
      onTitlePointerDown={handleHeaderPointerDown}
    >
      <FxRow label="Stamp">
        <SegmentedControl
          size="sm"
          label="Scratch preset"
          value={presetKey}
          onChange={stampPreset}
          options={SCRATCH_PRESET_CHIPS.map(([value, label]) => ({ value, label, hint: `Stamp the ${label} curve` }))}
        />
        {isCustom && (
          <FxStaticChip testId="scratch-custom-indicator">Custom</FxStaticChip>
        )}
        <FxSpacer />
        <IconButton size="sm" label="Reset to Normal" onClick={() => stampPreset('normal')} hint="Reset to the Normal curve">
          <RotateCcw size={14} aria-hidden="true" />
        </IconButton>
      </FxRow>

      <FxRow label="Baby gen" hint="Generators stamp points, then edit freely">
        <Select
          size="sm"
          ariaLabel="Baby scratch count"
          value={babyCount}
          options={[1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({ value: n, label: `${n}` }))}
          onChange={(v) => setBabyCount(clampScratchCount(v))}
          hint="How many scratches"
        />
        <Select
          size="sm"
          ariaLabel="Baby scratch length"
          value={babyLength}
          options={SCRATCH_BABY_LENGTHS.map(([length, label]) => ({ value: length, label }))}
          onChange={(v) => setBabyLength(normalizeScratchLengthBeats(v))}
          hint="How long each scratch is"
        />
        <Button size="sm" onClick={() => stampPreset('babyScratch')} hint="Generate a baby-scratch curve from the count and length">
          Generate
        </Button>
      </FxRow>

      <FxGraph hint={'Drag \u25c7 on a segment for tension'}>
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
      </FxGraph>

      <FxGrid>
        <FxField note={`0 \u2013 ${xLabels[xLabels.length - 1]?.text ?? ''}`}>
          <SegmentedControl
            size="sm"
            label="Time mode"
            value={timeMode}
            onChange={(value) => commitScratch({ timeMode: value })}
            options={SCRATCH_TIME_MODES.map(([value, label]) => ({ value, label }))}
          />
        </FxField>

        <NumberBox
          label="Smoothing"
          value={Number(smoothingMs.toFixed(1))}
          min={0} max={50} step={0.1}
          unit="ms"
          width={248}
          onCommit={(x) => commitScratch({ smoothingMs: x })}
          hint="Smooths the rate between points"
        />

        <FxField note={presetKey === 'custom' ? 'Curve: Custom' : `Curve: ${presetKey}`}>
          <Select
            size="sm"
            ariaLabel="Edge mode"
            value={edgeMode}
            options={SCRATCH_EDGE_MODES.map(([value, label]) => ({ value, label }))}
            onChange={(value) => commitScratch({ edgeMode: value })}
            hint="What happens when the curve runs past the source"
          />
        </FxField>

        <NumberBox
          label="Gain comp"
          value={Number(gainDb.toFixed(1))}
          min={SCRATCH_GAIN_COMP_MIN_DB} max={SCRATCH_GAIN_COMP_MAX_DB} step={0.5}
          unit="dB"
          formatOptions={{ signed: true }}
          width={248}
          onCommit={(x) => commitScratch({ gainCompensationDb: x })}
          hint="Level compensation for the scratch"
        />
      </FxGrid>

      <ClipPictureSection kind="wave" clip={clip} commitVideo={commitVideo} />

      <FxStatus enabled={enabled} right={statusRight} />
    </ClipFxWindow>
  )
}
