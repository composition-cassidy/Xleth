import React from 'react';
import { normalizeLfoNodeData } from '../../../fxgraph/graphState.js';
import { tokenValue } from '../../../theming/tokenValue.ts';
import { useThemeEpoch } from '../../../theming/useThemeEpoch.js';
import { EnvelopeRangeControl } from './EnvelopeEditor';

// LFO Modulator UI — compact node-card body + expanded editor.
//
// This module remains renderer/UI-only. It edits the persisted breakpoint
// waveform + rate definition for the graph-owned LFO control source; it does
// not evaluate the LFO's running phase, drive parameters, touch effectChains,
// or create any engine/per-voice runtime. Runtime evaluation happens on the
// audio thread — see engine/src/model/LfoParameterModulation.h.
//
// The 8-control-point Catmull-Rom codec (crom/lfoSample/sampleLinear/
// backendToY/yToBackend) and the preset table below are a deliberate PORT of
// ui/src/components/sampler/LfoWaveformCanvas.jsx + LfoSection.jsx, not a
// shared import — this keeps the FX-Graph LFO feature decoupled from the
// Sampler's own (unrelated, per-voice) LFO implementation.

export interface LfoWaveformPoint {
  t: number;
  v: number;
}

export interface LfoNodeData {
  label: string;
  waveform: LfoWaveformPoint[];
  rateMode: 'free' | 'sync';
  rateMs: number;
  syncDivision: number;
  phaseOffset: number;
}

export type LfoNodePatch = Record<string, unknown>;

// Normalizes arbitrary node data into the closed LFO schema. Delegates to the
// pure graph model so the UI never invents a parallel normalization path.
export function readLfoNodeData(data: Record<string, unknown> | undefined): LfoNodeData {
  return normalizeLfoNodeData(data) as LfoNodeData;
}

// ---------------------------------------------------------------------------
// Ported codec (Sampler's LfoWaveformCanvas.jsx) — 8-point Catmull-Rom editor.
//
// External shape: backend stores `{t, v}[]` (one cycle, t in [0,1]).
// Internal shape: 8 control points evenly spaced at t = i/8 for i in 0..7,
// with periodic boundary (point 7 connects back to point 0).
// ---------------------------------------------------------------------------

const LFO_N = 8;
const COMMIT_SAMPLES = 32;

function sampleLinear(pts: LfoWaveformPoint[], t: number): number {
  if (pts.length === 0) return 0;
  if (t <= pts[0].t) return pts[0].v;
  if (t >= pts[pts.length - 1].t) return pts[pts.length - 1].v;
  for (let i = 1; i < pts.length; i++) {
    if (t <= pts[i].t) {
      const a = pts[i - 1];
      const b = pts[i];
      const span = b.t - a.t;
      const frac = span > 0 ? (t - a.t) / span : 0;
      return a.v + (b.v - a.v) * frac;
    }
  }
  return pts[pts.length - 1].v;
}

export function backendToY(waveform: unknown): number[] {
  const Y = new Array(LFO_N).fill(0);
  if (!Array.isArray(waveform) || waveform.length < 2) {
    for (let i = 0; i < LFO_N; i++) Y[i] = Math.sin((i / LFO_N) * Math.PI * 2);
    return Y;
  }
  const sorted = [...(waveform as LfoWaveformPoint[])].sort((a, b) => a.t - b.t);
  for (let i = 0; i < LFO_N; i++) {
    const t = i / LFO_N;
    Y[i] = sampleLinear(sorted, t);
  }
  return Y;
}

function crom(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

function lfoSample(Y: number[], t: number): number {
  const N = Y.length;
  const i = Math.floor(t);
  const f = t - i;
  return crom(Y[((i - 1) % N + N) % N], Y[i % N], Y[(i + 1) % N], Y[(i + 2) % N], f);
}

// Rebuilds a high-resolution `{t, v}[]` (COMMIT_SAMPLES + closing point) from the
// 8 Y control points via the Catmull-Rom spline, so the engine renders the same
// shape seen in the editor. This preserves the IPC payload shape — the engine's
// linear interpolation between breakpoints stays the source of truth at runtime.
export function yToBackend(Y: number[]): LfoWaveformPoint[] {
  const out: LfoWaveformPoint[] = [];
  for (let i = 0; i < COMMIT_SAMPLES; i++) {
    const t = i / COMMIT_SAMPLES;
    const sampleT = t * LFO_N;
    const v = lfoSample(Y, sampleT);
    out.push({ t: Number(t.toFixed(4)), v: Number(v.toFixed(4)) });
  }
  out.push({ t: 1, v: Number(Y[0].toFixed(4)) });
  return out;
}

// ---------------------------------------------------------------------------
// Ported preset table (Sampler's LfoSection.jsx). Sine/Triangle/Square are the
// primary required presets (per explicit user ask); rampUp/rampDown are kept in
// the detection table since they were already present in the source and cost
// nothing to carry over, but are not surfaced as buttons here.
// ---------------------------------------------------------------------------

const LFO_PRESETS_Y: Record<string, number[]> = {
  sine: [0, 0.707, 1, 0.707, 0, -0.707, -1, -0.707],
  triangle: [0, 0.5, 1, 0.5, 0, -0.5, -1, -0.5],
  square: [1, 1, 1, 1, -1, -1, -1, -1],
  rampUp: [-1, -0.75, -0.5, -0.25, 0, 0.25, 0.5, 0.75],
  rampDown: [1, 0.75, 0.5, 0.25, 0, -0.25, -0.5, -0.75],
};

const LFO_PRESET_BUTTON_IDS = ['sine', 'triangle', 'square'] as const;

const LFO_PRESET_LABELS: Record<string, string> = {
  sine: 'Sine',
  triangle: 'Triangle',
  square: 'Square',
  rampUp: 'Ramp Up',
  rampDown: 'Ramp Down',
};

function presetMatch(Y: number[], presetY: number[]): boolean {
  for (let i = 0; i < 8; i++) {
    if (Math.abs(Y[i] - presetY[i]) > 0.02) return false;
  }
  return true;
}

// Returns the matching preset id, or null (rendered as "Custom") when the
// current waveform doesn't match any preset within tolerance.
export function detectPreset(waveform: unknown): string | null {
  const Y = backendToY(waveform);
  for (const id of Object.keys(LFO_PRESETS_Y)) {
    if (presetMatch(Y, LFO_PRESETS_Y[id])) return id;
  }
  return null;
}

export function formatLfoParameterCount(count: number): string {
  const safeCount = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
  return `${safeCount} ${safeCount === 1 ? 'param' : 'params'}`;
}

// Slowest first. The value is the note DENOMINATOR — cycle period is
// (4 / syncDivision) beats — so entries below 1 are the multi-bar rates
// (0.5 = 2/1 = two whole notes, 0.25 = 4/1, 0.125 = 8/1). Must stay in sync with
// LFO_SYNC_DIVISIONS in ui/src/fxgraph/graphState.js, which is the closed set the
// normalizer accepts.
const LFO_SYNC_DIVISIONS = [0.125, 0.25, 0.5, 1, 2, 4, 8, 16, 32, 64] as const;
const LFO_SYNC_DIVISION_LABELS: Record<number, string> = {
  0.125: '8/1',
  0.25: '4/1',
  0.5: '2/1',
  1: '1/1',
  2: '1/2',
  4: '1/4',
  8: '1/8',
  16: '1/16',
  32: '1/32',
  64: '1/64',
};
const LFO_RATE_MS_MAX = 5000;

// phaseOffset is stored as a 0..1 cycle fraction; the UI speaks degrees.
const PHASE_DEGREES_KEY = 'phaseDegrees';

export function phaseOffsetToDegrees(phaseOffset: number): number {
  if (!Number.isFinite(phaseOffset)) return 0;
  return Math.round((((phaseOffset % 1) + 1) % 1) * 360);
}

export function degreesToPhaseOffset(degrees: number): number {
  if (!Number.isFinite(degrees)) return 0;
  return (((degrees % 360) + 360) % 360) / 360;
}

function describeLfoRate(data: LfoNodeData): string {
  if (data.rateMode === 'sync') {
    return `Sync ${LFO_SYNC_DIVISION_LABELS[data.syncDivision] ?? '1/4'}`;
  }
  return `Free ${Math.round(data.rateMs)} ms`;
}

// ---------------------------------------------------------------------------
// LfoShapeGraph — canvas-based 8-handle draggable curve. Adapted from the
// Sampler canvas's drawing logic (DPR-aware sizing, center zero-line, filled
// gradient area, draggable handle circles), but collapsed to the single
// onChange-on-release convention used by EnvelopeAhdsrGraph: local state
// previews the in-flight drag, and exactly one onChange call fires on
// pointerup (never per-tick — avoids an IPC persist + undo push per
// pointermove). The Sampler original's onLiveChange/onCommit split is not
// carried over.
// ---------------------------------------------------------------------------

const GRAPH_W = 196;
const GRAPH_H = 54;
const HANDLE_R = 4;
const HANDLE_HIT = 10;

function LfoShapeGraph({
  data,
  editable = false,
  onChange,
}: {
  data: LfoNodeData;
  editable?: boolean;
  onChange?: ((patch: LfoNodePatch) => void) | null;
}) {
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const dragRef = React.useRef<{ idx: number; pointerId: number } | null>(null);
  const themeEpoch = useThemeEpoch();
  // Local-only preview of the in-flight drag's 8 Y control points; never
  // written to the store. Commit happens exactly once, on pointerup.
  const [dragY, setDragY] = React.useState<number[] | null>(null);

  const baseY = React.useMemo(() => backendToY(data.waveform), [data.waveform]);
  const Y = dragY ?? baseY;
  const amp = (GRAPH_H / 2) - 6;

  const draw = React.useCallback(() => {
    const c = canvasRef.current;
    if (!c) return;
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    c.width = GRAPH_W * dpr;
    c.height = GRAPH_H * dpr;
    c.style.width = `${GRAPH_W}px`;
    c.style.height = `${GRAPH_H}px`;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, GRAPH_W, GRAPH_H);

    const accent = tokenValue('--theme-accent-active') || tokenValue('--theme-accent') || '#7c8cff';
    const border = tokenValue('--theme-border-subtle') || 'rgba(128,128,128,0.4)';
    const surfaceBg = tokenValue('--theme-bg-surface') || 'transparent';

    ctx.strokeStyle = border;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, GRAPH_H / 2 + 0.5);
    ctx.lineTo(GRAPH_W, GRAPH_H / 2 + 0.5);
    ctx.stroke();

    ctx.beginPath();
    for (let px = 0; px <= GRAPH_W; px++) {
      const t = (px / GRAPH_W) * LFO_N;
      const y = lfoSample(Y, t);
      const cy = GRAPH_H / 2 - y * amp;
      if (px === 0) ctx.moveTo(px, cy);
      else ctx.lineTo(px, cy);
    }
    ctx.lineTo(GRAPH_W, GRAPH_H / 2);
    ctx.lineTo(0, GRAPH_H / 2);
    ctx.closePath();
    const fr = parseInt(accent.slice(1, 3), 16) || 130;
    const fg = parseInt(accent.slice(3, 5), 16) || 140;
    const fb = parseInt(accent.slice(5, 7), 16) || 255;
    const grad = ctx.createLinearGradient(0, 0, 0, GRAPH_H);
    grad.addColorStop(0, `rgba(${fr},${fg},${fb},0.20)`);
    grad.addColorStop(1, `rgba(${fr},${fg},${fb},0.02)`);
    ctx.fillStyle = grad;
    ctx.fill();

    ctx.beginPath();
    ctx.strokeStyle = accent;
    ctx.lineWidth = 1.5;
    for (let px = 0; px <= GRAPH_W; px++) {
      const t = (px / GRAPH_W) * LFO_N;
      const y = lfoSample(Y, t);
      const cy = GRAPH_H / 2 - y * amp;
      if (px === 0) ctx.moveTo(px, cy);
      else ctx.lineTo(px, cy);
    }
    ctx.stroke();

    if (editable) {
      for (let i = 0; i < LFO_N; i++) {
        const px = (i / LFO_N) * GRAPH_W;
        const py = GRAPH_H / 2 - Y[i] * amp;
        ctx.beginPath();
        ctx.arc(px, py, HANDLE_R, 0, Math.PI * 2);
        ctx.fillStyle = surfaceBg;
        ctx.fill();
        ctx.strokeStyle = accent;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }
  }, [Y, amp, editable, themeEpoch]);

  React.useEffect(() => { draw(); }, [draw]);

  const handlePointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!editable || !onChange) return;
    // Stop propagation for any press inside the editable canvas — not just a
    // handle hit — so a click that misses every handle can't fall through to
    // the node card's own onPointerDown and start a node drag underneath it.
    // Mirrors EnvelopeAhdsrGraph's outer editable-guard.
    event.stopPropagation();
    const c = canvasRef.current;
    if (!c) return;
    const rect = c.getBoundingClientRect();
    const mx = (event.clientX - rect.left) * (GRAPH_W / rect.width);
    const my = (event.clientY - rect.top) * (GRAPH_H / rect.height);
    let hitIdx = -1;
    for (let i = 0; i < LFO_N; i++) {
      const px = (i / LFO_N) * GRAPH_W;
      const py = GRAPH_H / 2 - baseY[i] * amp;
      if (Math.hypot(mx - px, my - py) <= HANDLE_HIT) { hitIdx = i; break; }
    }
    if (hitIdx < 0) return;
    event.preventDefault();
    event.stopPropagation();
    c.setPointerCapture?.(event.pointerId);
    dragRef.current = { idx: hitIdx, pointerId: event.pointerId };
    setDragY([...baseY]);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    const rect = canvasRef.current?.getBoundingClientRect();
    const my = (event.clientY - (rect?.top ?? 0)) * (GRAPH_H / (rect?.height || GRAPH_H));
    const newY = Math.max(-1, Math.min(1, -(my - GRAPH_H / 2) / amp));
    setDragY((prev) => {
      const next = prev ? [...prev] : [...baseY];
      next[drag.idx] = Number(newY.toFixed(4));
      return next;
    });
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    dragRef.current = null;
    canvasRef.current?.releasePointerCapture?.(event.pointerId);
    if (dragY && onChange) onChange({ waveform: yToBackend(dragY) });
    setDragY(null);
  };

  const handlePointerCancel = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (dragRef.current?.pointerId === event.pointerId) {
      dragRef.current = null;
      setDragY(null);
    }
  };

  return (
    <canvas
      ref={canvasRef}
      className={[
        'xleth-graph-state-preview__lfo-shape',
        editable ? 'xleth-graph-state-preview__lfo-shape--editable' : '',
      ].filter(Boolean).join(' ')}
      role="img"
      aria-label={editable ? 'Editable LFO waveform graph' : 'LFO waveform graph'}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
    />
  );
}

function LfoPresetRow({
  data,
  onChange,
}: {
  data: LfoNodeData;
  onChange: (patch: LfoNodePatch) => void;
}) {
  const detected = React.useMemo(() => detectPreset(data.waveform), [data.waveform]);

  return (
    <div className="xleth-graph-state-preview__lfo-presets" role="group" aria-label="LFO waveform presets">
      {LFO_PRESET_BUTTON_IDS.map((id) => {
        const active = detected === id;
        return (
          <button
            key={id}
            type="button"
            className={[
              'xleth-graph-state-preview__lfo-preset',
              active ? 'xleth-graph-state-preview__lfo-preset--active' : '',
            ].filter(Boolean).join(' ')}
            aria-pressed={active}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              onChange({ waveform: yToBackend(LFO_PRESETS_Y[id]) });
            }}
          >
            {LFO_PRESET_LABELS[id]}
          </button>
        );
      })}
      {detected === null && (
        <span className="xleth-graph-state-preview__lfo-preset-custom">Custom</span>
      )}
    </div>
  );
}

function LfoRateControls({
  data,
  onChange,
}: {
  data: LfoNodeData;
  onChange: (patch: LfoNodePatch) => void;
}) {
  const isSync = data.rateMode === 'sync';
  return (
    <div className="xleth-graph-state-preview__lfo-rate">
      <div className="xleth-graph-state-preview__lfo-rate-toggle" role="group" aria-label="LFO rate mode">
        <button
          type="button"
          className={[
            'xleth-graph-state-preview__lfo-rate-toggle-button',
            !isSync ? 'xleth-graph-state-preview__lfo-rate-toggle-button--active' : '',
          ].filter(Boolean).join(' ')}
          aria-pressed={!isSync}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            onChange({ rateMode: 'free' });
          }}
        >
          Free
        </button>
        <button
          type="button"
          className={[
            'xleth-graph-state-preview__lfo-rate-toggle-button',
            isSync ? 'xleth-graph-state-preview__lfo-rate-toggle-button--active' : '',
          ].filter(Boolean).join(' ')}
          aria-pressed={isSync}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            onChange({ rateMode: 'sync' });
          }}
        >
          Sync
        </button>
      </div>
      {isSync ? (
        <label className="xleth-graph-state-preview__lfo-sync-select-field">
          <span className="xleth-graph-state-preview__envelope-field-label">Division</span>
          <select
            className="xleth-graph-state-preview__envelope-select xleth-graph-state-preview__lfo-sync-select"
            value={data.syncDivision}
            aria-label="LFO sync division"
            onPointerDown={(event) => event.stopPropagation()}
            onChange={(event) => onChange({ syncDivision: Number(event.currentTarget.value) })}
          >
            {LFO_SYNC_DIVISIONS.map((division) => (
              <option key={division} value={division}>{LFO_SYNC_DIVISION_LABELS[division]}</option>
            ))}
          </select>
        </label>
      ) : (
        <EnvelopeRangeControl
          label="Rate"
          fieldKey="rateMs"
          value={data.rateMs}
          min={1}
          step={1}
          rangeMin={1}
          rangeMax={LFO_RATE_MS_MAX}
          displayValue={`${Math.round(data.rateMs)} ms`}
          ariaLabel="LFO rate ms"
          onChange={onChange}
        />
      )}
      {/* Phase — where in the cycle the waveform sits. This LFO free-runs against
          absolute transport position rather than being note-triggered, so the
          offset shifts the whole waveform in time: at 90deg a sine starts at its
          peak instead of at zero-crossing. 360deg wraps to 0 in the normalizer. */}
      <EnvelopeRangeControl
        label="Phase"
        fieldKey={PHASE_DEGREES_KEY}
        value={phaseOffsetToDegrees(data.phaseOffset)}
        min={0}
        max={360}
        step={1}
        rangeMin={0}
        rangeMax={360}
        displayValue={`${phaseOffsetToDegrees(data.phaseOffset)}°`}
        ariaLabel="LFO phase degrees"
        onChange={(patch) => {
          const degrees = Number((patch as Record<string, unknown>)[PHASE_DEGREES_KEY]);
          if (!Number.isFinite(degrees)) return;
          onChange({ phaseOffset: degreesToPhaseOffset(degrees) });
        }}
      />
    </div>
  );
}

export function LfoNodeSummary({
  data,
  parameterCount = 0,
}: {
  data: LfoNodeData;
  parameterCount?: number;
}) {
  const preset = detectPreset(data.waveform);
  return (
    <span className="xleth-graph-state-preview__envelope-summary" aria-label="LFO compact summary">
      <span className="xleth-graph-state-preview__envelope-pill-row">
        <span className="xleth-graph-state-preview__envelope-pill">
          {preset ? (LFO_PRESET_LABELS[preset] ?? 'Custom') : 'Custom'}
        </span>
        <span className="xleth-graph-state-preview__envelope-pill">{formatLfoParameterCount(parameterCount)}</span>
      </span>
      <span className="xleth-graph-state-preview__envelope-ahdsr" aria-label="LFO rate summary">
        {describeLfoRate(data)}
      </span>
    </span>
  );
}

export function LfoEditor({
  nodeId,
  data,
  onChange,
}: {
  nodeId: string;
  data: LfoNodeData;
  onChange: (patch: LfoNodePatch) => void;
}) {
  return (
    <div
      className="xleth-graph-state-preview__envelope-editor xleth-graph-state-preview__lfo-editor"
      data-lfo-editor-node={nodeId}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <LfoShapeGraph data={data} editable onChange={onChange} />
      <LfoPresetRow data={data} onChange={onChange} />
      <LfoRateControls data={data} onChange={onChange} />
    </div>
  );
}

export function LfoNodeBody({
  nodeId,
  data,
  onChange,
  parameterCount = 0,
  defaultExpanded = false,
}: {
  nodeId: string;
  data: LfoNodeData;
  onChange?: ((patch: LfoNodePatch) => void) | null;
  parameterCount?: number;
  defaultExpanded?: boolean;
}) {
  const editable = typeof onChange === 'function';
  const [expanded, setExpanded] = React.useState(defaultExpanded && editable);

  return (
    <span className="xleth-graph-state-preview__envelope-body xleth-graph-state-preview__lfo-body">
      {!expanded && <LfoShapeGraph data={data} editable={false} />}
      <LfoNodeSummary data={data} parameterCount={parameterCount} />
      {editable && (
        // Reuses the shared card template's primary Edit button style (same
        // class the Envelope and effect nodes use) so "Edit" reads as one
        // consistent action across every node type.
        <button
          className="xleth-graph-state-preview__node-edit"
          type="button"
          aria-expanded={expanded}
          aria-label={`${expanded ? 'Collapse' : 'Edit'} ${data.label} LFO`}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            setExpanded((open) => !open);
          }}
        >
          {expanded ? 'Done' : 'Edit'}
        </button>
      )}
      {expanded && editable && (
        <LfoEditor nodeId={nodeId} data={data} onChange={onChange!} />
      )}
    </span>
  );
}
