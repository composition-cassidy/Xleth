import React from 'react';
import { normalizeEnvelopeNodeData } from '../../../fxgraph/graphState.js';

// EVC-R3 - compact Envelope Modulator UI.
//
// This module remains renderer/UI-only. It edits the persisted AHDSR definition for
// the graph-owned Envelope control source; it does not evaluate triggers, drive
// parameters, touch effectChains, or create any engine/per-voice runtime.

export interface EnvelopeNodeData {
  label: string;
  attackMs: number;
  holdMs: number;
  decayMs: number;
  sustain: number;
  releaseMs: number;
  attackTension: number;
  decayTension: number;
  releaseTension: number;
  // EVC-R4 — no `amount`: the Envelope emits the raw 0..1 AHDSR shape and the per-connection
  // signed `depth` on each Envelope → Parameter edge is the only modulation scale.
  // EVC-R2-r3 — the trigger source (notes vs clips) is inferred from the parent track's
  // content at runtime, and the Envelope is always restart-only, so neither is stored
  // here. The only trigger-related field is the slide-note opt-in (default false).
  includeSlideNotes: boolean;
}

export type EnvelopeNodePatch = Record<string, unknown>;
export type EnvelopeGraphHandle = 'attack' | 'hold' | 'decay' | 'sustain' | 'release';

export interface PreviewPoint {
  x: number;
  y: number;
}

export interface EnvelopeGraphHandlePoint extends PreviewPoint {
  handle: EnvelopeGraphHandle;
  ariaLabel: string;
}

export interface EnvelopeGraphModel {
  points: PreviewPoint[];
  handles: EnvelopeGraphHandlePoint[];
  totalMs: number;
}

const PREVIEW_W = 196;
const PREVIEW_H = 54;
const SLIDER_MS_MAX = 5000;
const SUSTAIN_VISUAL_FRACTION = 0.28;
// Extra fraction of the timeline reserved past the release point so the release
// handle is never pinned to the right edge of the graph — without this, a drag
// could only ever shrink releaseMs (there was no room to drag further right).
const RELEASE_HEADROOM_FRACTION = 0.25;
// Minimum on-screen x gap enforced between adjacent handle affordances (hit-test
// only — never applied to the drawn curve). With holdMs: 0 the attack and hold
// handles land on the exact same point and the later-painted one wins every
// pointer event, making the other permanently unreachable.
const MIN_HANDLE_GAP_PX = 10;

// Normalizes arbitrary node data into the closed envelope schema. Delegates to the
// pure graph model so the UI never invents a parallel normalization path.
export function readEnvelopeNodeData(data: Record<string, unknown> | undefined): EnvelopeNodeData {
  return normalizeEnvelopeNodeData(data) as EnvelopeNodeData;
}

function clampUnit(v: number) {
  return Math.min(1, Math.max(0, v));
}

function finiteOr(value: number, fallback: number) {
  return Number.isFinite(value) ? value : fallback;
}

function readNonNegativeMs(value: number) {
  return Math.max(0, finiteOr(value, 0));
}

function round2(value: number) {
  return Math.round(value * 100) / 100;
}

function roundMs(value: number) {
  return Math.round(value * 10) / 10;
}

function formatMs(value: number): string {
  if (!Number.isFinite(value)) return '0 ms';
  const rounded = roundMs(value);
  return `${rounded} ms`;
}

function formatUnitPercent(value: number): string {
  return `${Math.round(clampUnit(value) * 100)}%`;
}

export function describeEnvelopeAhdsr(data: EnvelopeNodeData): string {
  return [
    `A ${formatMs(data.attackMs)}`,
    `H ${formatMs(data.holdMs)}`,
    `D ${formatMs(data.decayMs)}`,
    `S ${formatUnitPercent(data.sustain)}`,
    `R ${formatMs(data.releaseMs)}`,
  ].join(' | ');
}

export function formatEnvelopeParameterCount(count: number): string {
  const safeCount = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
  return `${safeCount} ${safeCount === 1 ? 'param' : 'params'}`;
}

// Builds an AHDSR-only graph model from existing fields. The sustain span is
// synthetic so the plateau stays visible; it is not a persisted duration and does
// not imply MSEG/freehand editing.
export function buildEnvelopeGraphModel(
  data: Pick<EnvelopeNodeData, 'attackMs' | 'holdMs' | 'decayMs' | 'sustain' | 'releaseMs'>,
  width: number,
  height: number,
): EnvelopeGraphModel {
  const attack = readNonNegativeMs(data.attackMs);
  const hold = readNonNegativeMs(data.holdMs);
  const decay = readNonNegativeMs(data.decayMs);
  const release = readNonNegativeMs(data.releaseMs);
  const sustain = clampUnit(finiteOr(data.sustain, 0));

  const active = attack + hold + decay + release;
  const sustainSpan = active > 0 ? active * SUSTAIN_VISUAL_FRACTION : 1;
  const contentTotal = attack + hold + decay + sustainSpan + release || 1;
  // The mapping basis (both for drawing and for the inverse drag mapping) is
  // padded past the release point so there is always draggable room to grow
  // releaseMs, not just shrink it.
  const total = contentTotal * (1 + RELEASE_HEADROOM_FRACTION);
  const safeWidth = Math.max(1, finiteOr(width, PREVIEW_W));
  const safeHeight = Math.max(1, finiteOr(height, PREVIEW_H));

  const toX = (t: number) => round2((t / total) * safeWidth);
  const toY = (level: number) => round2((1 - clampUnit(level)) * safeHeight);

  let t = 0;
  const start = { x: toX(t), y: toY(0) };
  t += attack;
  const attackPoint = { x: toX(t), y: toY(1) };
  t += hold;
  const holdPoint = { x: toX(t), y: toY(1) };
  t += decay;
  const decayPoint = { x: toX(t), y: toY(sustain) };
  t += sustainSpan;
  const sustainPoint = { x: toX(t), y: toY(sustain) };
  t += release;
  const releasePoint = { x: toX(t), y: toY(0) };

  const points = [start, attackPoint, holdPoint, decayPoint, sustainPoint, releasePoint];
  const handles = withMinimumHandleSeparation([
    { ...attackPoint, handle: 'attack' as const, ariaLabel: 'Attack handle' },
    { ...holdPoint, handle: 'hold' as const, ariaLabel: 'Hold handle' },
    { ...decayPoint, handle: 'decay' as const, ariaLabel: 'Decay handle' },
    { ...sustainPoint, handle: 'sustain' as const, ariaLabel: 'Sustain handle' },
    { ...releasePoint, handle: 'release' as const, ariaLabel: 'Release handle' },
  ]);
  return { points, handles, totalMs: total };
}

// Nudges handle hit-targets apart when the underlying values put two or more at
// the same x (e.g. attack/hold both at 0). This only changes where the circle
// affordance is drawn/hit-tested — the curve itself (`points`) is untouched, so
// it never distorts the model being edited.
function withMinimumHandleSeparation(
  handles: EnvelopeGraphHandlePoint[],
): EnvelopeGraphHandlePoint[] {
  const result = handles.map((handle) => ({ ...handle }));
  for (let i = 1; i < result.length; i++) {
    const minX = result[i - 1].x + MIN_HANDLE_GAP_PX;
    if (result[i].x < minX) result[i].x = round2(minX);
  }
  return result;
}

export function buildEnvelopePreviewPoints(
  data: Pick<EnvelopeNodeData, 'attackMs' | 'holdMs' | 'decayMs' | 'sustain' | 'releaseMs'>,
  width: number,
  height: number,
): PreviewPoint[] {
  return buildEnvelopeGraphModel(data, width, height).points;
}

export function envelopePreviewPolyline(points: PreviewPoint[]): string {
  return points.map((point) => `${point.x},${point.y}`).join(' ');
}

// `data` must be a snapshot frozen for the whole gesture (captured once at
// pointerdown), not the live value being edited. buildEnvelopeGraphModel derives
// totalMs from these same fields, so if `data` moves as the dragged field
// changes, the x/time axis rescales under the cursor mid-gesture and the
// mapping never converges. Passing a frozen snapshot makes the map a pure
// function of cursor position alone.
export function mapEnvelopeGraphDragToPatch(
  data: Pick<EnvelopeNodeData, 'attackMs' | 'holdMs' | 'decayMs' | 'sustain' | 'releaseMs'>,
  handle: EnvelopeGraphHandle,
  point: PreviewPoint,
  width: number,
  height: number,
): EnvelopeNodePatch {
  const model = buildEnvelopeGraphModel(data, width, height);
  const safeWidth = Math.max(1, finiteOr(width, PREVIEW_W));
  const safeHeight = Math.max(1, finiteOr(height, PREVIEW_H));
  const x = finiteOr(point.x, 0);
  const y = finiteOr(point.y, safeHeight);
  const timeAtX = Math.max(0, (x / safeWidth) * model.totalMs);

  const attack = readNonNegativeMs(data.attackMs);
  const hold = readNonNegativeMs(data.holdMs);
  const decay = readNonNegativeMs(data.decayMs);
  const release = readNonNegativeMs(data.releaseMs);
  const active = attack + hold + decay + release;
  const sustainSpan = active > 0 ? active * SUSTAIN_VISUAL_FRACTION : 1;

  if (handle === 'attack') return { attackMs: roundMs(timeAtX) };
  if (handle === 'hold') return { holdMs: roundMs(Math.max(0, timeAtX - attack)) };
  if (handle === 'decay') return { decayMs: roundMs(Math.max(0, timeAtX - attack - hold)) };
  if (handle === 'release') {
    return { releaseMs: roundMs(Math.max(0, timeAtX - attack - hold - decay - sustainSpan)) };
  }

  return { sustain: round2(clampUnit(1 - y / safeHeight)) };
}

function commitNumber(
  onChange: (patch: EnvelopeNodePatch) => void,
  key: string,
  raw: string,
) {
  const value = Number(raw);
  if (!Number.isFinite(value)) return;
  onChange({ [key]: value });
}

interface EnvelopeNumberFieldProps {
  label: string;
  fieldKey: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  ariaLabel: string;
  onChange: (patch: EnvelopeNodePatch) => void;
}

// Uncontrolled number input keyed by its committed value: the browser holds
// partial text (for example "" or "1.") and we commit only on blur/Enter.
export function EnvelopeNumberField({
  label,
  fieldKey,
  value,
  min,
  max,
  step,
  ariaLabel,
  onChange,
}: EnvelopeNumberFieldProps) {
  return (
    <label className="xleth-graph-state-preview__envelope-field">
      <span className="xleth-graph-state-preview__envelope-field-label">{label}</span>
      <input
        className="xleth-graph-state-preview__envelope-input"
        type="number"
        min={min}
        max={max}
        step={step}
        defaultValue={value}
        aria-label={ariaLabel}
        onPointerDown={(event) => event.stopPropagation()}
        onBlur={(event) => commitNumber(onChange, fieldKey, event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur();
        }}
      />
    </label>
  );
}

interface EnvelopeRangeControlProps extends EnvelopeNumberFieldProps {
  rangeMin: number;
  rangeMax: number;
  displayValue: string;
}

export function EnvelopeRangeControl({
  label,
  fieldKey,
  value,
  min,
  max,
  step = 1,
  ariaLabel,
  rangeMin,
  rangeMax,
  displayValue,
  onChange,
}: EnvelopeRangeControlProps) {
  const sliderValue = Math.min(rangeMax, Math.max(rangeMin, finiteOr(value, rangeMin)));
  // Uncontrolled (defaultValue): the browser renders the live thumb position as the
  // user drags, but we only read the value and commit once — on release (pointerup),
  // on blur, or after a keyboard step (keyup) — mirroring the macro-value slider's
  // commit-on-release pattern elsewhere in this file. This keeps every intermediate
  // tick out of the store entirely instead of pushing an update (and an undo
  // transaction, and an IPC persist) per pointermove.
  const commitSlider = (event: React.SyntheticEvent<HTMLInputElement>) => {
    commitNumber(onChange, fieldKey, event.currentTarget.value);
  };
  return (
    <label className="xleth-graph-state-preview__envelope-range">
      <span className="xleth-graph-state-preview__envelope-range-header">
        <span className="xleth-graph-state-preview__envelope-field-label">{label}</span>
        <span className="xleth-graph-state-preview__envelope-value">{displayValue}</span>
      </span>
      <span className="xleth-graph-state-preview__envelope-range-row">
        <input
          className="xleth-graph-state-preview__envelope-slider"
          type="range"
          min={rangeMin}
          max={rangeMax}
          step={step}
          defaultValue={sliderValue}
          aria-label={`${ariaLabel} slider`}
          onPointerDown={(event) => event.stopPropagation()}
          onPointerUp={commitSlider}
          onBlur={commitSlider}
          onKeyUp={commitSlider}
        />
        <input
          className="xleth-graph-state-preview__envelope-input xleth-graph-state-preview__envelope-input--compact"
          type="number"
          min={min}
          max={max}
          step={step}
          defaultValue={value}
          aria-label={ariaLabel}
          onPointerDown={(event) => event.stopPropagation()}
          onBlur={(event) => commitNumber(onChange, fieldKey, event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur();
          }}
        />
      </span>
    </label>
  );
}

export function EnvelopeAhdsrGraph({
  data,
  editable = false,
  onChange,
}: {
  data: EnvelopeNodeData;
  editable?: boolean;
  onChange?: ((patch: EnvelopeNodePatch) => void) | null;
}) {
  const svgRef = React.useRef<SVGSVGElement | null>(null);
  // The basis is a snapshot of the AHDSR fields frozen at pointerdown. Every
  // pointermove for this gesture maps against that same basis, so the mapping is
  // a pure function of cursor position — dragging attackMs can't feed back into
  // the totalMs the cursor position is measured against.
  type DragBasis = Pick<EnvelopeNodeData, 'attackMs' | 'holdMs' | 'decayMs' | 'sustain' | 'releaseMs'>;
  const dragRef = React.useRef<{ handle: EnvelopeGraphHandle; pointerId: number; basis: DragBasis } | null>(null);
  // Local-only preview of the in-flight drag; never written to the store. Commit
  // happens exactly once, on pointerup, so no IPC/undo transaction fires per move.
  const [dragPatch, setDragPatch] = React.useState<EnvelopeNodePatch | null>(null);

  const previewData = dragPatch ? { ...data, ...dragPatch } : data;
  const model = buildEnvelopeGraphModel(previewData, PREVIEW_W, PREVIEW_H);
  const polyline = envelopePreviewPolyline(model.points);

  const pointFromEvent = (event: React.PointerEvent<SVGElement>) => {
    const rect = svgRef.current?.getBoundingClientRect();
    return { x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) };
  };

  return (
    <svg
      ref={svgRef}
      className={[
        'xleth-graph-state-preview__envelope-preview',
        editable ? 'xleth-graph-state-preview__envelope-preview--editable' : '',
      ].filter(Boolean).join(' ')}
      width={PREVIEW_W}
      height={PREVIEW_H}
      viewBox={`0 0 ${PREVIEW_W} ${PREVIEW_H}`}
      role="img"
      aria-label={editable ? 'Editable AHDSR envelope graph' : 'Envelope AHDSR graph'}
      onPointerDown={(event) => {
        if (editable) event.stopPropagation();
      }}
      onPointerMove={(event) => {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        event.preventDefault();
        event.stopPropagation();
        const rect = svgRef.current?.getBoundingClientRect();
        setDragPatch(mapEnvelopeGraphDragToPatch(
          drag.basis,
          drag.handle,
          pointFromEvent(event),
          rect?.width || PREVIEW_W,
          rect?.height || PREVIEW_H,
        ));
      }}
      onPointerUp={(event) => {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        event.preventDefault();
        event.stopPropagation();
        dragRef.current = null;
        svgRef.current?.releasePointerCapture?.(event.pointerId);
        // Only commit if the pointer actually moved — a plain click must not
        // persist the whole graph over IPC and push an undo entry for nothing.
        if (dragPatch && onChange) onChange(dragPatch);
        setDragPatch(null);
      }}
      onPointerCancel={(event) => {
        if (dragRef.current?.pointerId === event.pointerId) {
          dragRef.current = null;
          setDragPatch(null);
        }
      }}
    >
      <line
        className="xleth-graph-state-preview__envelope-preview-baseline"
        x1={0}
        y1={PREVIEW_H}
        x2={PREVIEW_W}
        y2={PREVIEW_H}
      />
      <polyline
        className="xleth-graph-state-preview__envelope-preview-curve"
        points={polyline}
        fill="none"
      />
      {editable && model.handles.map((handle) => (
        <circle
          key={handle.handle}
          className={`xleth-graph-state-preview__envelope-handle xleth-graph-state-preview__envelope-handle--${handle.handle}`}
          cx={handle.x}
          cy={handle.y}
          r={4}
          tabIndex={0}
          role="slider"
          aria-label={handle.ariaLabel}
          onPointerDown={(event) => {
            if (!onChange) return;
            event.preventDefault();
            event.stopPropagation();
            dragRef.current = { handle: handle.handle, pointerId: event.pointerId, basis: data };
            svgRef.current?.setPointerCapture?.(event.pointerId);
          }}
        />
      ))}
    </svg>
  );
}

export function EnvelopeNodePreviewCurve({ data }: { data: EnvelopeNodeData }) {
  return <EnvelopeAhdsrGraph data={data} editable={false} />;
}

export function EnvelopeNodeSummary({
  data,
  parameterCount = 0,
}: {
  data: EnvelopeNodeData;
  parameterCount?: number;
}) {
  return (
    <span className="xleth-graph-state-preview__envelope-summary" aria-label="Envelope compact summary">
      <span className="xleth-graph-state-preview__envelope-pill-row">
        {/* EVC-R2-r3 — no Notes/Clips source pill (inferred from the track) and no
            Restart/Legato pill (always restart). The slide-note opt-in is surfaced
            only when enabled, since it is off by default. */}
        {data.includeSlideNotes && (
          <span className="xleth-graph-state-preview__envelope-pill">Slide</span>
        )}
        {/* EVC-R4 — no "Amt" pill: the retired node-level amount scale is gone (per-edge
            depth replaces it), so the summary shows only the connection count. */}
        <span className="xleth-graph-state-preview__envelope-pill">{formatEnvelopeParameterCount(parameterCount)}</span>
      </span>
      <span className="xleth-graph-state-preview__envelope-ahdsr" aria-label="AHDSR summary">
        {describeEnvelopeAhdsr(data)}
      </span>
    </span>
  );
}

// EVC-R2-r3 — the only trigger-related editing control. Trigger source (notes vs clips)
// is inferred from the parent track and the Envelope is always restart-only, so the old
// Trigger Source and Retrigger Mode selectors were removed entirely. This opt-in lets the
// user include slide notes (ignored by default). When the editor is read-only (no
// onChange), this control is never rendered (see EnvelopeEditor), so it is never editable.
export function IncludeSlideNotesControl({
  data,
  onChange,
}: {
  data: EnvelopeNodeData;
  onChange: (patch: EnvelopeNodePatch) => void;
}) {
  return (
    <label className="xleth-graph-state-preview__envelope-checkbox">
      <input
        className="xleth-graph-state-preview__envelope-checkbox-input"
        type="checkbox"
        checked={data.includeSlideNotes === true}
        aria-label="Include slide notes"
        onPointerDown={(event) => event.stopPropagation()}
        onChange={(event) => onChange({ includeSlideNotes: event.currentTarget.checked })}
      />
      <span className="xleth-graph-state-preview__envelope-field-label">Include slide notes</span>
    </label>
  );
}

export function EnvelopeAdvancedControls({
  data,
  onChange,
}: {
  data: EnvelopeNodeData;
  onChange: (patch: EnvelopeNodePatch) => void;
}) {
  return (
    <div className="xleth-graph-state-preview__envelope-advanced" aria-label="Envelope advanced controls">
      <EnvelopeRangeControl
        label="Atk Tension"
        fieldKey="attackTension"
        value={data.attackTension}
        min={-1}
        max={1}
        step={0.01}
        rangeMin={-1}
        rangeMax={1}
        displayValue={String(round2(data.attackTension))}
        ariaLabel="Attack tension"
        onChange={onChange}
      />
      <EnvelopeRangeControl
        label="Dec Tension"
        fieldKey="decayTension"
        value={data.decayTension}
        min={-1}
        max={1}
        step={0.01}
        rangeMin={-1}
        rangeMax={1}
        displayValue={String(round2(data.decayTension))}
        ariaLabel="Decay tension"
        onChange={onChange}
      />
      <EnvelopeRangeControl
        label="Rel Tension"
        fieldKey="releaseTension"
        value={data.releaseTension}
        min={-1}
        max={1}
        step={0.01}
        rangeMin={-1}
        rangeMax={1}
        displayValue={String(round2(data.releaseTension))}
        ariaLabel="Release tension"
        onChange={onChange}
      />
    </div>
  );
}

export function EnvelopeEditor({
  nodeId,
  data,
  onChange,
  defaultAdvancedOpen = false,
}: {
  nodeId: string;
  data: EnvelopeNodeData;
  onChange: (patch: EnvelopeNodePatch) => void;
  defaultAdvancedOpen?: boolean;
}) {
  const [advancedOpen, setAdvancedOpen] = React.useState(defaultAdvancedOpen);

  return (
    <div
      className="xleth-graph-state-preview__envelope-editor"
      data-envelope-editor-node={nodeId}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <EnvelopeAhdsrGraph data={data} editable onChange={onChange} />
      <div className="xleth-graph-state-preview__envelope-grid">
        <EnvelopeRangeControl
          label="Attack"
          fieldKey="attackMs"
          value={data.attackMs}
          min={0}
          step={1}
          rangeMin={0}
          rangeMax={SLIDER_MS_MAX}
          displayValue={formatMs(data.attackMs)}
          ariaLabel="Attack ms"
          onChange={onChange}
        />
        <EnvelopeRangeControl
          label="Hold"
          fieldKey="holdMs"
          value={data.holdMs}
          min={0}
          step={1}
          rangeMin={0}
          rangeMax={SLIDER_MS_MAX}
          displayValue={formatMs(data.holdMs)}
          ariaLabel="Hold ms"
          onChange={onChange}
        />
        <EnvelopeRangeControl
          label="Decay"
          fieldKey="decayMs"
          value={data.decayMs}
          min={0}
          step={1}
          rangeMin={0}
          rangeMax={SLIDER_MS_MAX}
          displayValue={formatMs(data.decayMs)}
          ariaLabel="Decay ms"
          onChange={onChange}
        />
        <EnvelopeRangeControl
          label="Release"
          fieldKey="releaseMs"
          value={data.releaseMs}
          min={0}
          step={1}
          rangeMin={0}
          rangeMax={SLIDER_MS_MAX}
          displayValue={formatMs(data.releaseMs)}
          ariaLabel="Release ms"
          onChange={onChange}
        />
        <EnvelopeRangeControl
          label="Sustain"
          fieldKey="sustain"
          value={data.sustain}
          min={0}
          max={1}
          step={0.01}
          rangeMin={0}
          rangeMax={1}
          displayValue={formatUnitPercent(data.sustain)}
          ariaLabel="Sustain level"
          onChange={onChange}
        />
        {/* EVC-R4 — the node-level "Amount" master scale was removed. It duplicated the
            per-connection output scale (now the signed `depth` on each Envelope → Parameter
            edge) and multiplied into it a second time, so two controls set "how much" with
            no indication of which one to use. Depth, edited per connection in the mapping
            editor, is now the only modulation scale. */}
      </div>
      <div className="xleth-graph-state-preview__envelope-grid xleth-graph-state-preview__envelope-grid--modes">
        <IncludeSlideNotesControl data={data} onChange={onChange} />
      </div>
      <button
        className="xleth-graph-state-preview__envelope-disclosure"
        type="button"
        aria-expanded={advancedOpen}
        aria-label="Toggle envelope advanced controls"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          setAdvancedOpen((open) => !open);
        }}
      >
        Advanced
      </button>
      {advancedOpen && <EnvelopeAdvancedControls data={data} onChange={onChange} />}
    </div>
  );
}

export function EnvelopeNodeBody({
  nodeId,
  data,
  onChange,
  parameterCount = 0,
  defaultExpanded = false,
}: {
  nodeId: string;
  data: EnvelopeNodeData;
  onChange?: ((patch: EnvelopeNodePatch) => void) | null;
  parameterCount?: number;
  defaultExpanded?: boolean;
}) {
  const editable = typeof onChange === 'function';
  const [expanded, setExpanded] = React.useState(defaultExpanded && editable);

  return (
    <span className="xleth-graph-state-preview__envelope-body">
      {!expanded && <EnvelopeAhdsrGraph data={data} editable={false} />}
      <EnvelopeNodeSummary data={data} parameterCount={parameterCount} />
      {editable && (
        <button
          className="xleth-graph-state-preview__envelope-edit-button"
          type="button"
          aria-expanded={expanded}
          aria-label={`${expanded ? 'Collapse' : 'Edit'} ${data.label} envelope`}
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
        <EnvelopeEditor nodeId={nodeId} data={data} onChange={onChange!} />
      )}
    </span>
  );
}
