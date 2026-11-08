import { useCallback, useEffect, useRef, useState } from 'react'
import ClipPictureSection from './ClipPictureSection.jsx'
import { X, RotateCcw, Copy, ClipboardPaste } from 'lucide-react'
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

// A range input that drafts locally while dragging and commits once on release,
// so a slider sweep is one engine write and one undo step — matching how the
// clip dropdown's ClipSliderRow behaves.
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

  return (
    <div
      className="clipfx-window"
      style={{ left: panelPos.x, top: panelPos.y, width: GRAPH_W + 16 }}
      data-testid="clip-vibrato-editor"
      tabIndex={0}
    >
      <div className="clipfx-titlebar" onPointerDown={handleHeaderPointerDown}>
        <span className="clipfx-swatch" />
        <span className="clipfx-title">Vibrato</span>
        <span className="clipfx-subtitle">
          Clip {target.clipId} · Per-Clip · {shapeLabel}
        </span>
        <span className="clipfx-spacer" />
        <button type="button" className="clipfx-close" onClick={close} title="Close">
          <X size={12} />
        </button>
      </div>

      <div className="clipfx-row">
        <span className="clipfx-row-label">Shape</span>
        {VIBRATO_SHAPE_CHIPS.map(([value, label]) => (
          <button
            key={value}
            type="button"
            className={`clipfx-chip${shape === value ? ' is-on' : ''}`}
            onClick={() => handleSelectShape(value)}
            title={`${label} vibrato shape`}
          >
            {label}
          </button>
        ))}
        <span className="clipfx-spacer" />
        <button
          type="button" className="clipfx-icon-btn" onClick={handleCopy}
          disabled={enginePoints.length < VIBRATO_MIN_POINTS} title="Copy shape"
        >
          <Copy size={11} />
        </button>
        <button
          type="button" className="clipfx-icon-btn" onClick={handlePaste}
          disabled={!shapeClipboard} title="Paste shape"
        >
          <ClipboardPaste size={11} />
        </button>
        <button type="button" className="clipfx-icon-btn" onClick={handleReset} title="Reset shape">
          <RotateCcw size={11} />
        </button>
      </div>

      <div className="clipfx-graph-wrap">
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
        <span className="clipfx-graph-hint">
          {isCustom ? 'One cycle · repeats at rate' : 'Built-in shape — pick Custom to edit'}
        </span>
      </div>

      <div className="clipfx-param-grid">
        <ScalarSlider
          label="Depth"
          value={Math.round(depthCents)}
          min={0} max={1200} step={1}
          format={(x) => `${x} ¢`}
          onCommit={(x) => commitVibrato({ depthCents: x })}
        />

        <div className="clipfx-param">
          <label className="clipfx-param-label">Rate Mode</label>
          <div className="clipfx-seg" role="group" aria-label="Rate mode">
            <button
              type="button"
              className={`clipfx-seg-btn${!isSync ? ' is-on' : ''}`}
              onClick={() => commitVibrato({ rateMode: 'freeHz' })}
            >Free Hz</button>
            <button
              type="button"
              className={`clipfx-seg-btn${isSync ? ' is-on' : ''}`}
              onClick={() => commitVibrato({ rateMode: 'tempoSync' })}
            >Sync</button>
          </div>
          <span className="clipfx-param-value">
            {isSync
              ? (VIBRATO_SYNC_DIVISIONS.find(([v]) => v === (vibrato?.syncDivision ?? 'eighth')) ?? ['', '1/8'])[1]
              : `${rateHz.toFixed(2)} Hz`}
          </span>
        </div>

        <ScalarSlider
          label={isSync ? 'Rate (synced)' : 'Rate'}
          value={Number(rateHz.toFixed(2))}
          min={0.01} max={20} step={0.01}
          disabled={isSync}
          format={(x) => `${Number(x).toFixed(2)} Hz`}
          onCommit={(x) => commitVibrato({ rateHz: x })}
        />

        <ScalarSlider
          label="Phase"
          value={phaseDeg}
          min={0} max={360} step={1}
          format={(x) => `${x}°`}
          onCommit={(x) => commitVibrato({ phaseOffset: clampNum(x / 360, 0, 1) })}
        />

        <div className="clipfx-param clipfx-param-wide">
          <label className="clipfx-param-label" htmlFor="clipfx-sync-div">Sync Division</label>
          <select
            id="clipfx-sync-div"
            className="clipfx-select"
            value={vibrato?.syncDivision ?? 'eighth'}
            disabled={!isSync}
            onChange={(e) => commitVibrato({ syncDivision: e.target.value })}
          >
            {VIBRATO_SYNC_DIVISIONS.map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
          <label className="clipfx-check">
            <input
              type="checkbox"
              checked={vibrato?.phaseResetOnClipStart !== false}
              onChange={(e) => commitVibrato({ phaseResetOnClipStart: e.target.checked })}
            />
            <span>Reset phase on clip start</span>
          </label>
        </div>
      </div>

      <ClipPictureSection kind="swirl" clip={clip} commitVideo={commitVideo} />

      <div className="clipfx-status">
        <span className={`clipfx-led${enabled ? ' is-on' : ''}`} />
        <span>{enabled ? 'Active' : 'Off'}</span>
        <span className="clipfx-status-right">{statusRight}</span>
      </div>
    </div>
  )
}
