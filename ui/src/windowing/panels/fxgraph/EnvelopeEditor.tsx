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
  amount: number;
  triggerSource: { kind: string; events: 'notes' | 'clips' | 'notesAndClips' };
  retriggerMode: 'restart' | 'legato';
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

const TRIGGER_LABELS: Record<EnvelopeNodeData['triggerSource']['events'], string> = {
  notes: 'Notes',
  clips: 'Clips',
  notesAndClips: 'Notes + Clips',
};

const RETRIGGER_LABELS: Record<EnvelopeNodeData['retriggerMode'], string> = {
  restart: 'Restart',
  legato: 'Legato',
};

const PREVIEW_W = 196;
const PREVIEW_H = 54;
const SLIDER_MS_MAX = 5000;
const SUSTAIN_VISUAL_FRACTION = 0.28;

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

export function describeEnvelopeTrigger(data: EnvelopeNodeData): string {
  return TRIGGER_LABELS[data.triggerSource.events] ?? 'Notes + Clips';
}

export function describeEnvelopeRetrigger(data: EnvelopeNodeData): string {
  return RETRIGGER_LABELS[data.retriggerMode] ?? 'Restart';
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
  const total = attack + hold + decay + sustainSpan + release || 1;
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
  return {
    points,
    handles: [
      { ...attackPoint, handle: 'attack', ariaLabel: 'Attack handle' },
      { ...holdPoint, handle: 'hold', ariaLabel: 'Hold handle' },
      { ...decayPoint, handle: 'decay', ariaLabel: 'Decay handle' },
      { ...sustainPoint, handle: 'sustain', ariaLabel: 'Sustain handle' },
      { ...releasePoint, handle: 'release', ariaLabel: 'Release handle' },
    ],
    totalMs: total,
  };
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
          value={sliderValue}
          aria-label={`${ariaLabel} slider`}
          onPointerDown={(event) => event.stopPropagation()}
          onChange={(event) => {
            const next = Number(event.currentTarget.value);
            if (Number.isFinite(next)) onChange({ [fieldKey]: next });
          }}
        />
        <input
          key={`${fieldKey}-${value}`}
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
  const dragRef = React.useRef<{ handle: EnvelopeGraphHandle; pointerId: number } | null>(null);
  const model = buildEnvelopeGraphModel(data, PREVIEW_W, PREVIEW_H);
  const polyline = envelopePreviewPolyline(model.points);

  const applyDrag = React.useCallback((handle: EnvelopeGraphHandle, event: React.PointerEvent<SVGElement>) => {
    if (!svgRef.current || !onChange) return;
    const rect = svgRef.current.getBoundingClientRect();
    const point = {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    };
    onChange(mapEnvelopeGraphDragToPatch(data, handle, point, rect.width || PREVIEW_W, rect.height || PREVIEW_H));
  }, [data, onChange]);

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
        applyDrag(drag.handle, event);
      }}
      onPointerUp={(event) => {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        event.preventDefault();
        event.stopPropagation();
        dragRef.current = null;
        svgRef.current?.releasePointerCapture?.(event.pointerId);
      }}
      onPointerCancel={(event) => {
        if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null;
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
            event.preventDefault();
            event.stopPropagation();
            dragRef.current = { handle: handle.handle, pointerId: event.pointerId };
            svgRef.current?.setPointerCapture?.(event.pointerId);
            applyDrag(handle.handle, event);
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
        <span className="xleth-graph-state-preview__envelope-pill">{describeEnvelopeTrigger(data)}</span>
        <span className="xleth-graph-state-preview__envelope-pill">{describeEnvelopeRetrigger(data)}</span>
        <span className="xleth-graph-state-preview__envelope-pill">Amt {formatUnitPercent(data.amount)}</span>
        <span className="xleth-graph-state-preview__envelope-pill">{formatEnvelopeParameterCount(parameterCount)}</span>
      </span>
      <span className="xleth-graph-state-preview__envelope-ahdsr" aria-label="AHDSR summary">
        {describeEnvelopeAhdsr(data)}
      </span>
    </span>
  );
}

export function TriggerSourceControl({
  data,
  onChange,
}: {
  data: EnvelopeNodeData;
  onChange: (patch: EnvelopeNodePatch) => void;
}) {
  return (
    <label className="xleth-graph-state-preview__envelope-field">
      <span className="xleth-graph-state-preview__envelope-field-label">Trigger Source</span>
      <select
        className="xleth-graph-state-preview__envelope-select"
        value={data.triggerSource.events}
        aria-label="Trigger source"
        onPointerDown={(event) => event.stopPropagation()}
        onChange={(event) => onChange({ triggerSource: { events: event.target.value } })}
      >
        <option value="notes">Notes</option>
        <option value="clips">Clips</option>
        <option value="notesAndClips">Notes + Clips</option>
      </select>
    </label>
  );
}

export function RetriggerModeControl({
  data,
  onChange,
}: {
  data: EnvelopeNodeData;
  onChange: (patch: EnvelopeNodePatch) => void;
}) {
  return (
    <label className="xleth-graph-state-preview__envelope-field">
      <span className="xleth-graph-state-preview__envelope-field-label">Retrigger Mode</span>
      <select
        className="xleth-graph-state-preview__envelope-select"
        value={data.retriggerMode}
        aria-label="Retrigger mode"
        onPointerDown={(event) => event.stopPropagation()}
        onChange={(event) => onChange({ retriggerMode: event.target.value })}
      >
        <option value="restart">Restart</option>
        <option value="legato">Legato</option>
      </select>
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
        <EnvelopeRangeControl
          label="Amount"
          fieldKey="amount"
          value={data.amount}
          min={0}
          max={1}
          step={0.01}
          rangeMin={0}
          rangeMax={1}
          displayValue={formatUnitPercent(data.amount)}
          ariaLabel="Amount"
          onChange={onChange}
        />
      </div>
      <div className="xleth-graph-state-preview__envelope-grid xleth-graph-state-preview__envelope-grid--modes">
        <TriggerSourceControl data={data} onChange={onChange} />
        <RetriggerModeControl data={data} onChange={onChange} />
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
      <EnvelopeAhdsrGraph data={data} editable={editable && expanded} onChange={onChange} />
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
