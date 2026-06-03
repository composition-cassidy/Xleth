import React from 'react';
import { normalizeEnvelopeNodeData } from '../../../fxgraph/graphState.js';

// EVC.3 / EVC-R1 — Envelope Controller node UI (renderer-only, inert).
//
// This module renders the visible/editable Envelope Controller node body inside
// the FX Graph (`GraphStatePreview.tsx`). EVC-R1 reworked it from the retired
// per-voice voiceGain editor into a triggered parameter-modulation source editor:
// the per-voice fields (voice mode, max voices, legato/glide, the read-only
// "Voice Gain" target) are gone, a retrigger-mode control was added, and the node
// advertises a `controlOut` output that links to exposed effect parameters. It is
// purely a renderer-side definition editor:
//   - It NEVER reads transport state, creates runtime voices, or writes plugin
//     parameters (runtime ADSR drive arrives in EVC-R2).
//   - The ADSR preview curve is illustrative only (closed-form A/H/D/S/R segments);
//     it is NOT audio-accurate and does NOT model tension yet (see the comment on
//     buildEnvelopePreviewPoints).
//   - All edits flow out through a single `onChange(patch)` callback that the panel
//     routes to the store action `updateGraphEnvelopeNodeDataForTrack`, which
//     clamps/repairs every field. No clamping is duplicated here — the editor lets
//     the user type freely and commits raw numbers on blur/change.
// ---------------------------------------------------------------------------

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

// Normalizes arbitrary node data into the closed envelope schema. Delegates to the
// EVC.2 pure model so the UI never invents a parallel normalization.
export function readEnvelopeNodeData(data: Record<string, unknown> | undefined): EnvelopeNodeData {
  return normalizeEnvelopeNodeData(data) as EnvelopeNodeData;
}

function clampUnit(v: number) {
  return Math.min(1, Math.max(0, v));
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

export function describeEnvelopeTrigger(data: EnvelopeNodeData): string {
  return TRIGGER_LABELS[data.triggerSource.events] ?? 'Notes + Clips';
}

export function describeEnvelopeRetrigger(data: EnvelopeNodeData): string {
  return RETRIGGER_LABELS[data.retriggerMode] ?? 'Restart';
}

function formatMs(value: number): string {
  if (!Number.isFinite(value)) return '0 ms';
  const rounded = Math.round(value * 10) / 10;
  return `${rounded} ms`;
}

function formatUnitPercent(value: number): string {
  return `${Math.round(clampUnit(value) * 100)}%`;
}

// Compact AHDSR one-liner used in the node summary.
export function describeEnvelopeAhdsr(data: EnvelopeNodeData): string {
  return [
    `A ${formatMs(data.attackMs)}`,
    `H ${formatMs(data.holdMs)}`,
    `D ${formatMs(data.decayMs)}`,
    `S ${formatUnitPercent(data.sustain)}`,
    `R ${formatMs(data.releaseMs)}`,
  ].join(' · ');
}

export interface PreviewPoint {
  x: number;
  y: number;
}

// Builds illustrative A/H/D/S/R preview points from node data only.
//
// The curve is NOT audio-accurate: segments are drawn as straight lines and
// per-segment tension is intentionally ignored in this first preview (tension is a
// persisted definition value with no runtime support yet — drawing a tensioned
// curve here would misrepresent that). A synthetic sustain-hold span is inserted so
// the sustain plateau is always visible even though sustain has no intrinsic
// duration. Levels: 1 = top (y=0), 0 = bottom (y=height).
export function buildEnvelopePreviewPoints(
  data: Pick<EnvelopeNodeData, 'attackMs' | 'holdMs' | 'decayMs' | 'sustain' | 'releaseMs'>,
  width: number,
  height: number,
): PreviewPoint[] {
  const attack = Math.max(0, Number.isFinite(data.attackMs) ? data.attackMs : 0);
  const hold = Math.max(0, Number.isFinite(data.holdMs) ? data.holdMs : 0);
  const decay = Math.max(0, Number.isFinite(data.decayMs) ? data.decayMs : 0);
  const release = Math.max(0, Number.isFinite(data.releaseMs) ? data.releaseMs : 0);
  const sustain = clampUnit(Number.isFinite(data.sustain) ? data.sustain : 0);

  const active = attack + hold + decay + release;
  // Sustain plateau width is a fixed fraction of the active time so the curve
  // shape stays readable; falls back to a unit span when everything is zero.
  const sustainSpan = active > 0 ? active * 0.28 : 1;
  const total = attack + hold + decay + sustainSpan + release || 1;

  const round = (v: number) => Math.round(v * 100) / 100;
  const toX = (t: number) => round((t / total) * width);
  const toY = (level: number) => round((1 - clampUnit(level)) * height);

  let t = 0;
  const points: PreviewPoint[] = [{ x: toX(0), y: toY(0) }];
  t += attack;
  points.push({ x: toX(t), y: toY(1) }); // attack rise to peak
  t += hold;
  points.push({ x: toX(t), y: toY(1) }); // hold plateau
  t += decay;
  points.push({ x: toX(t), y: toY(sustain) }); // decay to sustain
  t += sustainSpan;
  points.push({ x: toX(t), y: toY(sustain) }); // sustain plateau
  t += release;
  points.push({ x: toX(t), y: toY(0) }); // release fall to 0
  return points;
}

export function envelopePreviewPolyline(points: PreviewPoint[]): string {
  return points.map((point) => `${point.x},${point.y}`).join(' ');
}

const PREVIEW_W = 196;
const PREVIEW_H = 46;

export function EnvelopeNodePreviewCurve({ data }: { data: EnvelopeNodeData }) {
  const points = buildEnvelopePreviewPoints(data, PREVIEW_W, PREVIEW_H);
  const polyline = envelopePreviewPolyline(points);
  return (
    <svg
      className="xleth-graph-state-preview__envelope-preview"
      width={PREVIEW_W}
      height={PREVIEW_H}
      viewBox={`0 0 ${PREVIEW_W} ${PREVIEW_H}`}
      role="img"
      aria-label="Envelope preview curve"
      // The preview is a static illustration; it must not capture pointer drags.
      style={{ pointerEvents: 'none' }}
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
    </svg>
  );
}

// Read summary block shown on every envelope node (read-only and editable alike).
export function EnvelopeNodeSummary({ data }: { data: EnvelopeNodeData }) {
  return (
    <span className="xleth-graph-state-preview__envelope-summary" aria-label="Envelope summary">
      <span className="xleth-graph-state-preview__envelope-summary-row">
        <span className="xleth-graph-state-preview__envelope-summary-label">AHDSR</span>
        <span className="xleth-graph-state-preview__envelope-summary-value">
          {describeEnvelopeAhdsr(data)}
        </span>
      </span>
      <span className="xleth-graph-state-preview__envelope-summary-row">
        <span className="xleth-graph-state-preview__envelope-summary-label">Trigger</span>
        <span className="xleth-graph-state-preview__envelope-summary-value">
          {describeEnvelopeTrigger(data)}
        </span>
      </span>
      <span className="xleth-graph-state-preview__envelope-summary-row">
        <span className="xleth-graph-state-preview__envelope-summary-label">Retrigger</span>
        <span className="xleth-graph-state-preview__envelope-summary-value">
          {describeEnvelopeRetrigger(data)}
        </span>
      </span>
      <span className="xleth-graph-state-preview__envelope-summary-row">
        <span className="xleth-graph-state-preview__envelope-summary-label">Amount</span>
        <span className="xleth-graph-state-preview__envelope-summary-value">
          {formatUnitPercent(data.amount)}
        </span>
      </span>
      <span className="xleth-graph-state-preview__envelope-summary-row">
        <span className="xleth-graph-state-preview__envelope-summary-label">Output</span>
        <span className="xleth-graph-state-preview__envelope-summary-value">
          Control Out → parameter
        </span>
      </span>
    </span>
  );
}

function commitNumber(
  onChange: (patch: EnvelopeNodePatch) => void,
  key: string,
  raw: string,
) {
  const value = Number(raw);
  // Empty / partial text ("", "1.", "-") parses to NaN; skip the commit so the
  // user's in-progress input is never destroyed. Real clamping happens in the
  // store's normalizeEnvelopeNodeData.
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

// Uncontrolled number input keyed by its committed value: the browser holds the
// in-progress text (so typing "1." or clearing the field is non-hostile) and we
// only read + commit on blur/Enter. Keying by the committed value remounts the
// input when an external change (e.g. undo/redo) updates the node data.
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

export function EnvelopeEditor({
  nodeId,
  data,
  onChange,
}: {
  nodeId: string;
  data: EnvelopeNodeData;
  onChange: (patch: EnvelopeNodePatch) => void;
}) {
  // Key inputs by committed value so undo/redo refreshes them; see EnvelopeNumberField.
  return (
    <div
      className="xleth-graph-state-preview__envelope-editor"
      data-envelope-editor-node={nodeId}
      // Keep node-drag pointer handling from hijacking field interactions.
      onPointerDown={(event) => event.stopPropagation()}
    >
      <label className="xleth-graph-state-preview__envelope-field xleth-graph-state-preview__envelope-field--wide">
        <span className="xleth-graph-state-preview__envelope-field-label">Label</span>
        <input
          key={`label-${data.label}`}
          className="xleth-graph-state-preview__envelope-input"
          type="text"
          defaultValue={data.label}
          aria-label="Envelope label"
          onPointerDown={(event) => event.stopPropagation()}
          onBlur={(event) => onChange({ label: event.currentTarget.value })}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur();
          }}
        />
      </label>

      <div className="xleth-graph-state-preview__envelope-grid">
        <EnvelopeNumberField
          key={`attackMs-${data.attackMs}`}
          label="Attack"
          fieldKey="attackMs"
          value={data.attackMs}
          min={0}
          step={1}
          ariaLabel="Attack ms"
          onChange={onChange}
        />
        <EnvelopeNumberField
          key={`holdMs-${data.holdMs}`}
          label="Hold"
          fieldKey="holdMs"
          value={data.holdMs}
          min={0}
          step={1}
          ariaLabel="Hold ms"
          onChange={onChange}
        />
        <EnvelopeNumberField
          key={`decayMs-${data.decayMs}`}
          label="Decay"
          fieldKey="decayMs"
          value={data.decayMs}
          min={0}
          step={1}
          ariaLabel="Decay ms"
          onChange={onChange}
        />
        <EnvelopeNumberField
          key={`releaseMs-${data.releaseMs}`}
          label="Release"
          fieldKey="releaseMs"
          value={data.releaseMs}
          min={0}
          step={1}
          ariaLabel="Release ms"
          onChange={onChange}
        />
        <EnvelopeNumberField
          key={`sustain-${data.sustain}`}
          label="Sustain"
          fieldKey="sustain"
          value={data.sustain}
          min={0}
          max={1}
          step={0.01}
          ariaLabel="Sustain level"
          onChange={onChange}
        />
        <EnvelopeNumberField
          key={`amount-${data.amount}`}
          label="Amount"
          fieldKey="amount"
          value={data.amount}
          min={0}
          max={1}
          step={0.01}
          ariaLabel="Amount"
          onChange={onChange}
        />
        <EnvelopeNumberField
          key={`attackTension-${data.attackTension}`}
          label="Atk Tens"
          fieldKey="attackTension"
          value={data.attackTension}
          min={-1}
          max={1}
          step={0.01}
          ariaLabel="Attack tension"
          onChange={onChange}
        />
        <EnvelopeNumberField
          key={`decayTension-${data.decayTension}`}
          label="Dec Tens"
          fieldKey="decayTension"
          value={data.decayTension}
          min={-1}
          max={1}
          step={0.01}
          ariaLabel="Decay tension"
          onChange={onChange}
        />
        <EnvelopeNumberField
          key={`releaseTension-${data.releaseTension}`}
          label="Rel Tens"
          fieldKey="releaseTension"
          value={data.releaseTension}
          min={-1}
          max={1}
          step={0.01}
          ariaLabel="Release tension"
          onChange={onChange}
        />
      </div>

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
    </div>
  );
}

// The full envelope node body: subtitle, summary, preview curve, and (when an
// onChange callback is supplied i.e. graph mode) the compact editor. Read-only
// previews (no callback) expose no editing affordances.
export function EnvelopeNodeBody({
  nodeId,
  data,
  onChange,
}: {
  nodeId: string;
  data: EnvelopeNodeData;
  onChange?: ((patch: EnvelopeNodePatch) => void) | null;
}) {
  const editable = typeof onChange === 'function';
  return (
    <span className="xleth-graph-state-preview__envelope-body">
      <EnvelopeNodeSummary data={data} />
      <EnvelopeNodePreviewCurve data={data} />
      {editable && <EnvelopeEditor nodeId={nodeId} data={data} onChange={onChange!} />}
    </span>
  );
}
