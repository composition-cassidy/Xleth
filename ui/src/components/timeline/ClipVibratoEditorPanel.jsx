import { useCallback, useEffect, useRef, useState } from 'react'
import ClipPictureSection from './ClipPictureSection.jsx'
import { RotateCcw, Copy, ClipboardPaste, Check } from 'lucide-react'
import { IconButton, NumberBox, SegmentedControl, Select, Toggle, THIN_SPACE } from '../../ui-kit'
import ClipFxWindow, { FxRow, FxSpacer, FxGrid, FxField, FxGraph, FxStatus } from './ClipFxWindow.jsx'
import useClipVibratoEditorStore from '../../stores/clipVibratoEditorStore.js'
import BreakpointCurveEditor from '../common/BreakpointCurveEditor.jsx'
import {
  VIBRATO_SHAPE_CHIPS,
  VIBRATO_SYNC_DIVISIONS,
  VIBRATO_MIN_POINTS,
  VIBRATO_MAX_POINTS,
  VIBRATO_POINT_ADAPTER,
  defaultCustomShape,
  makeVibratoSampler,
  normalizeCustomShape,
} from './clipVibrato.js'

// ── Floating per-clip Vibrato graph editor ───────────────────────────────────
//
// Exposes the engine's already-complete Custom vibrato shape
// (ClipModulation::Vibrato::customShape) plus the scalars the clip dropdown
// already carried. The dropdown stays as the quick-scalar summary; this is the
// surface where the shape itself is authored.
//
// MOUNTING: this panel is `position: fixed` and MUST be mounted by
// ClipFxEditorHost at the windowing root — never inside a PanelFrame. A floating
// PanelFrame positions itself with `transform: translate3d(...)`, and a CSS
// transform establishes a containing block for `position: fixed` descendants,
// which would clip this editor to that frame's box. Same rule, same reason as
// EffectEditorHost.jsx documents for the stock effect editors.
//
// EDIT DISCIPLINE: point drags preview through the store (`previewShape`, purely
// local, zero IPC) and commit exactly once on release. Sliders draft locally and
// commit on pointer release; chips/dropdowns/checkboxes commit on change — the
// same shape of write the clip dropdown already performs. Every one of those
// routes through mergeClipModulationPatch + setClipModulation, so one gesture is
// one undo step.
//
// THEMING: CSS custom-property tokens only, no hardcoded hex. tokenValue() is
// never called at module scope. Flat, zero border-radius, hard shadow; accent is
// reserved for meaningful state (the selected shape, the active LED, the curve).

const GRAPH_W = 432
const GRAPH_H = 220
const GRAPH_PAD = { left: 26, right: 10, top: 10, bottom: 16 }

const X_LABELS = [{ t: 0, text: '0' }, { t: 0.5, text: '½' }, { t: 1, text: '1' }]
const Y_LABELS = [{ v: 1, text: '+1' }, { v: 0, text: '0' }, { v: -1, text: '-1' }]

// Session-scoped shape clipboard for the copy/paste chips. UI-only: it never
// touches the engine and is deliberately not persisted.
let shapeClipboard = null

const clampNum = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x)

export default function ClipVibratoEditorPanel() {
  const target = useClipVibratoEditorStore(s => s.target)
  const clip = useClipVibratoEditorStore(s => s.clip)
  const commitVideo = useClipVibratoEditorStore(s => s.commitVideo)
  const draftShape = useClipVibratoEditorStore(s => s.draftShape)
  const selectedIdx = useClipVibratoEditorStore(s => s.selectedIdx)
  const close = useClipVibratoEditorStore(s => s.close)
  const setSelectedIdx = useClipVibratoEditorStore(s => s.setSelectedIdx)
  const previewShape = useClipVibratoEditorStore(s => s.previewShape)
  const commitShape = useClipVibratoEditorStore(s => s.commitShape)
  const commitVibrato = useClipVibratoEditorStore(s => s.commitVibrato)

  const [panelPos, setPanelPos] = useState(() => ({
    x: Math.round((globalThis.window?.innerWidth ?? 1280) / 2 - GRAPH_W / 2),
    y: 80,
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
        x: clampNum(drag.startPanelX + e.clientX - drag.startMouseX, -260, (globalThis.window?.innerWidth ?? 1280) - 80),
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

  const vibrato = clip?.modulation?.vibrato ?? null

  // Points shown on the graph: the local drag draft when one is in flight,
  // otherwise the engine's breakpoints.
  const shape = vibrato?.shape ?? 'sine'
  const isCustom = shape === 'custom'
  const enginePoints = normalizeCustomShape(vibrato?.customShape)
  const points = draftShape ?? enginePoints

  const handleSelectShape = useCallback((nextShape) => {
    if (nextShape !== 'custom') { commitVibrato({ shape: nextShape }); return }
    // Switching to Custom with nothing authored yet seeds a sine-ish default in
    // the SAME commit, so the graph is never an empty flat line.
    const seedNeeded = normalizeCustomShape(vibrato?.customShape).length < VIBRATO_MIN_POINTS
    commitVibrato(seedNeeded
      ? { shape: 'custom', customShape: defaultCustomShape() }
      : { shape: 'custom' })
    setSelectedIdx(-1)
  }, [commitVibrato, setSelectedIdx, vibrato])

  const handleReset = useCallback(() => {
    setSelectedIdx(-1)
    commitVibrato({ customShape: defaultCustomShape() })
  }, [commitVibrato, setSelectedIdx])

  const handleCopy = useCallback(() => {
    shapeClipboard = enginePoints.map(p => ({ ...p }))
  }, [enginePoints])

  const handlePaste = useCallback(() => {
    if (!shapeClipboard || shapeClipboard.length < VIBRATO_MIN_POINTS) return
    setSelectedIdx(-1)
    commitVibrato({ customShape: shapeClipboard.map(p => ({ ...p })) })
  }, [commitVibrato, setSelectedIdx])

  if (!target) return null

  const rateMode = vibrato?.rateMode ?? 'freeHz'
  const isSync = rateMode === 'tempoSync'
  const rateHz = Number.isFinite(vibrato?.rateHz) ? vibrato.rateHz : 5
  const depthCents = Number.isFinite(vibrato?.depthCents) ? vibrato.depthCents : 0
  // The engine stores phaseOffset in CYCLES (0..1); the UI shows degrees.
  const phaseDeg = Math.round(clampNum(vibrato?.phaseOffset ?? 0, 0, 1) * 360)
  const enabled = Boolean(vibrato?.enabled)

  const shapeLabel = (VIBRATO_SHAPE_CHIPS.find(([v]) => v === shape) ?? ['', 'Sine'])[1]
  const statusRight = isCustom
    ? `${points.length} pts · 1 cycle · ${rateHz.toFixed(2)} Hz · ${Math.round(depthCents)} ¢`
    : `${shapeLabel} · 1 cycle · ${rateHz.toFixed(2)} Hz · ${Math.round(depthCents)} ¢`

  const syncDivision = vibrato?.syncDivision ?? 'eighth'
  const syncLabel = (VIBRATO_SYNC_DIVISIONS.find(([v]) => v === syncDivision) ?? ['', '1/8'])[1]
  const parseNumber = (text) => { const n = parseFloat(String(text).replace(',', '.')); return Number.isFinite(n) ? n : null }

  return (
    <ClipFxWindow
      title="Vibrato"
      subtitle={`Clip ${target.clipId} \u00b7 per clip \u00b7 ${shapeLabel}`}
      label="Vibrato editor"
      testId="clip-vibrato-editor"
      pos={panelPos}
      width={GRAPH_W + 16}
      onClose={close}
      onTitlePointerDown={handleHeaderPointerDown}
    >
      <FxRow label="Shape">
        <SegmentedControl
          size="sm"
          label="Vibrato shape"
          value={shape}
          onChange={handleSelectShape}
          options={VIBRATO_SHAPE_CHIPS.map(([value, label]) => ({ value, label, hint: `${label} vibrato shape` }))}
        />
        <FxSpacer />
        <IconButton size="sm" label="Copy shape" onClick={handleCopy} disabled={enginePoints.length < VIBRATO_MIN_POINTS} hint="Copy this shape">
          <Copy size={14} aria-hidden="true" />
        </IconButton>
        <IconButton size="sm" label="Paste shape" onClick={handlePaste} disabled={!shapeClipboard} hint="Paste the copied shape">
          <ClipboardPaste size={14} aria-hidden="true" />
        </IconButton>
        <IconButton size="sm" label="Reset shape" onClick={handleReset} hint="Reset the custom shape">
          <RotateCcw size={14} aria-hidden="true" />
        </IconButton>
      </FxRow>

      <FxGraph hint={isCustom ? 'One cycle \u00b7 repeats at the rate' : 'Built-in shape \u00b7 pick Custom to edit'}>
        <BreakpointCurveEditor
          className="clipfx-graph"
          points={points}
          adapter={VIBRATO_POINT_ADAPTER}
          sample={makeVibratoSampler(shape)}
          width={GRAPH_W}
          height={GRAPH_H}
          pad={GRAPH_PAD}
          editable={isCustom}
          selectedIdx={selectedIdx}
          minPoints={VIBRATO_MIN_POINTS}
          maxPoints={VIBRATO_MAX_POINTS}
          xLabels={X_LABELS}
          yLabels={Y_LABELS}
          ariaLabel="Vibrato shape, one cycle"
          onSelect={setSelectedIdx}
          onPreview={previewShape}
          onCommit={commitShape}
        />
      </FxGraph>

      <FxGrid>
        <NumberBox
          label="Depth"
          value={Math.round(depthCents)}
          min={0} max={1200} step={1}
          quantize={Math.round}
          format={(x) => `${Math.round(x)}${THIN_SPACE}\u00a2`}
          parse={parseNumber}
          width={212}
          onCommit={(x) => commitVibrato({ depthCents: x })}
          hint="Vibrato depth in cents"
        />

        <FxField note={isSync ? `Division ${syncLabel}` : undefined}>
          <SegmentedControl
            size="sm"
            label="Rate mode"
            value={isSync ? 'tempoSync' : 'freeHz'}
            onChange={(mode) => commitVibrato({ rateMode: mode })}
            options={[
              { value: 'freeHz', label: 'Free Hz', hint: 'Rate in hertz' },
              { value: 'tempoSync', label: 'Sync', hint: 'Rate locked to the tempo' },
            ]}
          />
        </FxField>

        <NumberBox
          label={isSync ? 'Rate (synced)' : 'Rate'}
          value={Number(rateHz.toFixed(2))}
          min={0.01} max={20} step={0.01}
          unit="Hz"
          formatOptions={{ decimals: 2 }}
          disabled={isSync}
          width={212}
          onCommit={(x) => commitVibrato({ rateHz: x })}
          hint="Vibrato rate"
        />

        <NumberBox
          label="Phase"
          value={phaseDeg}
          min={0} max={360} step={1}
          quantize={Math.round}
          format={(x) => `${Math.round(x)}\u00b0`}
          parse={parseNumber}
          width={212}
          onCommit={(x) => commitVibrato({ phaseOffset: clampNum(x / 360, 0, 1) })}
          hint="Where in the cycle the vibrato starts"
        />

        <FxField wide>
          <Select
            size="sm"
            ariaLabel="Sync division"
            value={syncDivision}
            options={VIBRATO_SYNC_DIVISIONS.map(([value, label]) => ({ value, label }))}
            disabled={!isSync}
            onChange={(value) => commitVibrato({ syncDivision: value })}
            hint="Sync division"
          />
          <Toggle
            size="sm"
            on={vibrato?.phaseResetOnClipStart !== false}
            onChange={(next) => commitVibrato({ phaseResetOnClipStart: next })}
            glyph={<Check size={12} aria-hidden="true" />}
            hint="Restart the cycle at the start of each clip"
          >Reset phase on clip start</Toggle>
        </FxField>
      </FxGrid>

      <ClipPictureSection kind="swirl" clip={clip} commitVideo={commitVideo} />

      <FxStatus enabled={enabled} right={statusRight} />
    </ClipFxWindow>
  )
}
