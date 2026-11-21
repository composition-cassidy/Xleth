import React from 'react';
import { createDefaultEnvelopeNodeData, normalizeEnvelopeNodeData } from '../../../fxgraph/graphState.js';
import { Button, MINUS, NumberBox, Toggle, formatValue, skewScale } from '../../../ui-kit';
import ModulatorSheet, { type SheetAnchor } from './ModulatorSheet';
import modStyles from './ModulatorEditors.module.css';
import { iconComponent } from '../../../ui-kit/icons';

const IcCheckFill = iconComponent('check', 'fill');

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
// The node is 236px wide with 8px either side of its display.
const NODE_GRAPH_W = 220;
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
  return formatValue(Number.isFinite(value) ? value : 0, 'ms');
}

function formatUnitPercent(value: number): string {
  return formatValue(Math.round(clampUnit(value) * 100), '%');
}

export function describeEnvelopeAhdsr(data: EnvelopeNodeData): string {
  return [
    `A ${formatMs(data.attackMs)}`,
    `H ${formatMs(data.holdMs)}`,
    `D ${formatMs(data.decayMs)}`,
    `S ${formatUnitPercent(data.sustain)}`,
    `R ${formatMs(data.releaseMs)}`,
  ].join(' · ');
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

// ---------------------------------------------------------------------------
// Controls. Every number is a kit NumberBox: drag, type or arrow, a local preview while it
// moves and ONE onChange patch when it is released (the same patch the old slider and field
// sent, so the store sees one write and one undo entry per gesture).
// ---------------------------------------------------------------------------

// Times run 0 to 10 s on a skewed law, so the short end (a few ms) is as easy to set as a
// second. A typed value outside the range is clamped by the control.
const ENVELOPE_MS_MAX = 10000;
const ENVELOPE_MS_SCALE = skewScale(0, ENVELOPE_MS_MAX, 0.4);
const ENVELOPE_DEFAULTS = createDefaultEnvelopeNodeData() as EnvelopeNodeData;

const tensionFormat = (value: number) => `${value < 0 ? MINUS : ''}${Math.abs(value).toFixed(2)}`;
const tensionParse = (text: string) => {
  const n = Number(text.replace(MINUS, '-').replace(',', '.').trim());
  return Number.isFinite(n) ? n : null;
};

export function EnvelopeTimeBox({
  label,
  fieldKey,
  value,
  onChange,
}: {
  label: string;
  fieldKey: 'attackMs' | 'holdMs' | 'decayMs' | 'releaseMs';
  value: number;
  onChange: (patch: EnvelopeNodePatch) => void;
}) {
  return (
    <NumberBox
      label={label}
      width={96}
      value={Math.min(ENVELOPE_MS_MAX, readNonNegativeMs(value))}
      defaultValue={ENVELOPE_DEFAULTS[fieldKey]}
      min={0}
      max={ENVELOPE_MS_MAX}
      scale={ENVELOPE_MS_SCALE}
      step={1}
      unit="ms"
      onCommit={(next) => onChange({ [fieldKey]: next })}
    />
  );
}

export function EnvelopeTensionBox({
  label,
  fieldKey,
  value,
  onChange,
}: {
  label: string;
  fieldKey: 'attackTension' | 'decayTension' | 'releaseTension';
  value: number;
  onChange: (patch: EnvelopeNodePatch) => void;
}) {
  return (
    <NumberBox
      label={label}
      width={96}
      value={round2(finiteOr(value, 0))}
      defaultValue={ENVELOPE_DEFAULTS[fieldKey]}
      min={-1}
      max={1}
      bipolar
      step={0.01}
      format={tensionFormat}
      parse={tensionParse}
      onCommit={(next) => onChange({ [fieldKey]: round2(next) })}
    />
  );
}

export function EnvelopeAhdsrGraph({
  data,
  editable = false,
  onChange,
  width = PREVIEW_W,
  height = PREVIEW_H,
}: {
  data: EnvelopeNodeData;
  editable?: boolean;
  onChange?: ((patch: EnvelopeNodePatch) => void) | null;
  width?: number;
  height?: number;
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
  const model = buildEnvelopeGraphModel(previewData, width, height);
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
        modStyles.graph,
      ].filter(Boolean).join(' ')}
      data-editable={editable ? 'true' : undefined}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
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
          rect?.width || width,
          rect?.height || height,
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
        className={`xleth-graph-state-preview__envelope-preview-baseline ${modStyles.baseline}`}
        x1={0}
        y1={height}
        x2={width}
        y2={height}
      />
      <polyline
        className={`xleth-graph-state-preview__envelope-preview-curve ${modStyles.curve}`}
        points={polyline}
        fill="none"
      />
      {editable && model.handles.map((handle) => (
        <React.Fragment key={handle.handle}>
          <circle
            className={`xleth-graph-state-preview__envelope-handle xleth-graph-state-preview__envelope-handle--${handle.handle} ${modStyles.handleHit}`}
            cx={handle.x}
            cy={handle.y}
            r={11}
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
          <circle className={modStyles.handleMark} cx={handle.x} cy={handle.y} r={4} aria-hidden="true" />
        </React.Fragment>
      ))}
    </svg>
  );
}

export function EnvelopeNodePreviewCurve({ data }: { data: EnvelopeNodeData }) {
  return <EnvelopeAhdsrGraph data={data} editable={false} />;
}

export function EnvelopeNodeSummary({
  data,
}: {
  data: EnvelopeNodeData;
  parameterCount?: number;
}) {
  return (
    <span className={`xleth-graph-state-preview__envelope-summary ${modStyles.summary} ${modStyles.summaryTall}`} aria-label="Envelope compact summary">
      <span className="xleth-graph-state-preview__envelope-ahdsr" aria-label="AHDSR summary">
        {describeEnvelopeAhdsr(data)}
      </span>
    </span>
  );
}

// EVC-R2-r3 — the only trigger-related editing control. Trigger source (notes vs clips)
// is inferred from the parent track and the Envelope is always restart-only. This opt-in lets
// the user include slide notes (ignored by default).
export function IncludeSlideNotesControl({
  data,
  onChange,
}: {
  data: EnvelopeNodeData;
  onChange: (patch: EnvelopeNodePatch) => void;
}) {
  return (
    <Toggle
      size="sm"
      on={data.includeSlideNotes === true}
      glyph={<IcCheckFill aria-hidden="true" />}
      onChange={(next) => onChange({ includeSlideNotes: next })}
    >
      Include slide notes
    </Toggle>
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
    <div className={modStyles.grid} aria-label="Envelope curve controls">
      <EnvelopeTensionBox label="Attack" fieldKey="attackTension" value={data.attackTension} onChange={onChange} />
      <EnvelopeTensionBox label="Decay" fieldKey="decayTension" value={data.decayTension} onChange={onChange} />
      <EnvelopeTensionBox label="Release" fieldKey="releaseTension" value={data.releaseTension} onChange={onChange} />
    </div>
  );
}

const EDITOR_GRAPH_W = 304;
const EDITOR_GRAPH_H = 96;

export function EnvelopeEditor({
  nodeId,
  data,
  onChange,
}: {
  nodeId: string;
  data: EnvelopeNodeData;
  onChange: (patch: EnvelopeNodePatch) => void;
}) {
  return (
    <div
      className={`xleth-graph-state-preview__envelope-editor ${modStyles.editor}`}
      data-envelope-editor-node={nodeId}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <span className={`${modStyles.display} ${modStyles.displayEditor}`}>
        <EnvelopeAhdsrGraph data={data} editable onChange={onChange} width={EDITOR_GRAPH_W} height={EDITOR_GRAPH_H} />
      </span>
      <section className={modStyles.section} aria-label="Envelope times">
        <div className={modStyles.sectionTitle}>Times</div>
        <div className={modStyles.grid}>
          <EnvelopeTimeBox label="Attack" fieldKey="attackMs" value={data.attackMs} onChange={onChange} />
          <EnvelopeTimeBox label="Hold" fieldKey="holdMs" value={data.holdMs} onChange={onChange} />
          <EnvelopeTimeBox label="Decay" fieldKey="decayMs" value={data.decayMs} onChange={onChange} />
          <EnvelopeTimeBox label="Release" fieldKey="releaseMs" value={data.releaseMs} onChange={onChange} />
          <NumberBox
            label="Sustain"
            width={96}
            value={Math.round(clampUnit(finiteOr(data.sustain, 0)) * 100)}
            defaultValue={Math.round(ENVELOPE_DEFAULTS.sustain * 100)}
            min={0}
            max={100}
            step={1}
            unit="%"
            onCommit={(next) => onChange({ sustain: round2(next / 100) })}
          />
        </div>
        {/* EVC-R4 — the node-level "Amount" master scale was removed. Depth, edited per
            connection in the mapping editor, is the only modulation scale. */}
      </section>
      <section className={modStyles.section} aria-label="Envelope curve">
        <div className={modStyles.sectionTitle}>Curve</div>
        <EnvelopeAdvancedControls data={data} onChange={onChange} />
      </section>
      <section className={modStyles.section} aria-label="Envelope trigger">
        <div className={modStyles.sectionTitle}>Trigger</div>
        <div className={modStyles.row}>
          <IncludeSlideNotesControl data={data} onChange={onChange} />
        </div>
      </section>
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
  const [open, setOpen] = React.useState(defaultExpanded && editable);
  const [anchor, setAnchor] = React.useState<SheetAnchor | null>(null);
  const close = React.useCallback(() => setOpen(false), []);

  return (
    <span className={`xleth-graph-state-preview__envelope-body ${modStyles.body}`}>
      <span className={modStyles.display}>
        <EnvelopeAhdsrGraph data={data} editable={false} width={NODE_GRAPH_W} height={PREVIEW_H} />
      </span>
      <EnvelopeNodeSummary data={data} parameterCount={parameterCount} />
      {editable && (
        <span className={modStyles.footer}>
          {/* EVC-R2-r3: no Notes/Clips source (inferred from the track), no Restart/Legato
              (always restart). EVC-R4: no amount (the per-connection depth is the only
              scale), so the count of connections is all there is to say. */}
          <Button
            size="sm"
            className="xleth-graph-state-preview__node-edit"
            aria-expanded={open}
            aria-label={`${open ? 'Close' : 'Edit'} ${data.label} envelope`}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              if (open) { setOpen(false); return; }
              const rect = event.currentTarget.closest('[data-node-id]')?.getBoundingClientRect()
                ?? event.currentTarget.getBoundingClientRect();
              setAnchor({ left: rect.left, right: rect.right, top: rect.top });
              setOpen(true);
            }}
          >
            Edit
          </Button>
          <span className={modStyles.count}>
            {data.includeSlideNotes ? 'Slide notes · ' : ''}{formatEnvelopeParameterCount(parameterCount)}
          </span>
        </span>
      )}
      {open && editable && (
        <ModulatorSheet
          title={`Envelope: ${data.label}`}
          glyph="nodeEnvelope"
          anchor={anchor}
          onClose={close}
          testId="fx-envelope-sheet"
        >
          <EnvelopeEditor nodeId={nodeId} data={data} onChange={onChange!} />
        </ModulatorSheet>
      )}
    </span>
  );
}
