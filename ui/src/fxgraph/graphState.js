import {
  buildGraphParameterPortId,
  createGraphParameterTargetFromExposedPort,
  normalizeGraphParameterTarget,
  resolveGraphParameterTarget,
} from './graphParameterTarget.js'
// FXG.4-h — parent-attached macro automation lanes are normalized on load so
// persistence round-trips and old projects (no field) load as []. This import is
// call-time only (used inside validateVersionOneGraphState); macroAutomation.js in
// turn only reuses FXG.4-g curve functions at call time, so the cycle is safe.
import { normalizeMacroAutomationLanes } from './macroAutomation.js'

export const GRAPH_STATE_SCHEMA_VERSION = 1

const DEFAULT_VIEWPORT = Object.freeze({ x: 0, y: 0, zoom: 1 })
const FALLBACK_NODE_SPACING_X = 260
const FALLBACK_NODE_Y = 0
export const MIN_VIEWPORT_ZOOM = 0.1
export const MAX_VIEWPORT_ZOOM = 4

export const GRAPH_MACRO_NODE_TYPE = 'macro'
export const GRAPH_MACRO_OUTPUT_PORT = 'controlOut'

// EVC.2 / EVC-R1 — Envelope Controller node. A graph-owned control-source node, a
// sibling to the Macro node (NOT an effect node). EVC-R1 reworked it from the
// retired per-voice voiceGain target into a triggered parameter-modulation source:
// it carries an inert AHDSR definition (persisted/normalized renderer-side only)
// and a `controlOut` port that links to exposed effect parameters through the same
// parameter-edge/GraphParameterTarget path Macro uses. Runtime ADSR drive is
// deferred to EVC-R2. See docs/dev/fxgraph-envelope-controller-architecture-audit.md.
export const GRAPH_ENVELOPE_NODE_TYPE = 'envelope'
// EVC-R1 — the Envelope's single control output port. Same port name as Macro's
// controlOut (both are control sources for parameter edges).
export const GRAPH_ENVELOPE_OUTPUT_PORT = 'controlOut'

// FXG.4-e/f — base mapping curve type.
export const GRAPH_PARAMETER_CURVE_LINEAR = 'linear'

// FXG.4-g — per-link Bezier mapping. The curve holds 4 points:
//   points[0] = {x:0, y:0}  fixed start (always forced on normalization)
//   points[1] = {x, y}      first control point (editable, clamped to [0,1])
//   points[2] = {x, y}      second control point (editable, clamped to [0,1])
//   points[3] = {x:1, y:1}  fixed end (always forced on normalization)
// A malformed bezier (wrong point count, non-finite coords) repairs to linear.
export const GRAPH_PARAMETER_CURVE_BEZIER = 'bezier'

const NODE_TYPES = new Set([
  'trackInput',
  'trackOutput',
  'effect',
  GRAPH_MACRO_NODE_TYPE,
  GRAPH_ENVELOPE_NODE_TYPE,
])
const EDGE_TYPES = new Set(['audio', 'parameter'])

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function cloneJson(value) {
  if (value == null) return value
  return JSON.parse(JSON.stringify(value))
}

function normalizeTrackId(trackId) {
  return trackId == null ? '' : String(trackId)
}

function makeWarning(code, trackId, message, details = {}) {
  return {
    code,
    trackId: normalizeTrackId(trackId),
    message: `[FXG] track ${normalizeTrackId(trackId)}: ${message}`,
    ...details,
  }
}

function emitWarnings(warnings, options = {}) {
  if (!options.logger || options.logWarnings === false) return
  for (const warning of warnings) {
    options.logger(warning.message, warning)
  }
}

function finish(result, options) {
  emitWarnings(result.warnings ?? [], options)
  return result
}

function invalid(reason, warnings = []) {
  return { status: 'invalid', graphState: null, reason, warnings }
}

function defaultViewportWithWarnings(raw, trackId, warnings) {
  if (raw == null) return { ...DEFAULT_VIEWPORT }
  if (!isPlainObject(raw)) {
    warnings.push(makeWarning('invalidViewport', trackId, 'invalid graphState viewport; using defaults'))
    return { ...DEFAULT_VIEWPORT }
  }

  const x = Number.isFinite(raw.x) ? raw.x : DEFAULT_VIEWPORT.x
  const y = Number.isFinite(raw.y) ? raw.y : DEFAULT_VIEWPORT.y
  let zoom = Number.isFinite(raw.zoom) ? raw.zoom : DEFAULT_VIEWPORT.zoom

  if (!Number.isFinite(raw.x) || !Number.isFinite(raw.y) || !Number.isFinite(raw.zoom)) {
    warnings.push(makeWarning('invalidViewport', trackId, 'invalid graphState viewport fields; using safe defaults'))
  }

  if (zoom <= 0) {
    warnings.push(makeWarning('invalidViewportZoom', trackId, 'invalid graphState viewport zoom; using 1'))
    zoom = DEFAULT_VIEWPORT.zoom
  }

  return {
    x,
    y,
    zoom: Math.min(MAX_VIEWPORT_ZOOM, Math.max(MIN_VIEWPORT_ZOOM, zoom)),
  }
}

function fallbackNodePosition(index) {
  return {
    x: index * FALLBACK_NODE_SPACING_X,
    y: FALLBACK_NODE_Y,
  }
}

function nodePositionWithWarnings(raw, fallbackPosition, trackId, warnings, nodeId, hasPosition) {
  if (!hasPosition) return fallbackPosition
  if (!isPlainObject(raw)) {
    warnings.push(makeWarning('invalidNodePosition', trackId, 'invalid graphState node position; using defaults', { nodeId }))
    return fallbackPosition
  }

  const hasValidX = Number.isFinite(raw.x)
  const hasValidY = Number.isFinite(raw.y)
  if (!hasValidX || !hasValidY) {
    warnings.push(makeWarning('invalidNodePosition', trackId, 'invalid graphState node position fields; using safe defaults', { nodeId }))
    return fallbackPosition
  }

  return {
    x: raw.x,
    y: raw.y,
  }
}

function withNodePosition(node, position) {
  return { ...node, position }
}

function clampMacroNormalizedValue(value) {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

// ---------------------------------------------------------------------------
// FXG.4-e/f — parameter link mapping
//
// Each Macro -> Parameter edge owns its own mapping object so one macro can drive
// many parameters with different ranges/polarity. Every numeric field clamps to
// [0,1]. targetMin > targetMax is intentionally preserved to allow an inverted
// mapping. The mapping is the only place runtime drive reads from; the macro stays
// a clean 0..1 source.
// ---------------------------------------------------------------------------

function clampUnitValue(value, fallback) {
  if (!Number.isFinite(value)) return fallback
  return Math.min(1, Math.max(0, value))
}

function normalizeBezierPoints(rawPoints) {
  if (!Array.isArray(rawPoints) || rawPoints.length !== 4) return null
  const pts = []
  for (const raw of rawPoints) {
    if (!isPlainObject(raw)) return null
    if (!Number.isFinite(raw.x) || !Number.isFinite(raw.y)) return null
    pts.push({
      x: Math.min(1, Math.max(0, raw.x)),
      y: Math.min(1, Math.max(0, raw.y)),
    })
  }
  // Force fixed endpoints regardless of what was stored.
  pts[0] = { x: 0, y: 0 }
  pts[3] = { x: 1, y: 1 }
  return pts
}

export function normalizeParameterMapping(rawMapping) {
  const raw = isPlainObject(rawMapping) ? rawMapping : {}
  const rawCurve = isPlainObject(raw.curve) ? raw.curve : {}

  let curve
  if (rawCurve.type === GRAPH_PARAMETER_CURVE_BEZIER) {
    const points = normalizeBezierPoints(rawCurve.points)
    curve = points
      ? { type: GRAPH_PARAMETER_CURVE_BEZIER, points }
      : { type: GRAPH_PARAMETER_CURVE_LINEAR }
  } else {
    curve = { type: GRAPH_PARAMETER_CURVE_LINEAR }
  }

  return {
    enabled: raw.enabled !== false,
    sourceMin: clampUnitValue(raw.sourceMin, 0),
    sourceMax: clampUnitValue(raw.sourceMax, 1),
    targetMin: clampUnitValue(raw.targetMin, 0),
    targetMax: clampUnitValue(raw.targetMax, 1),
    curve,
  }
}

// FXG.4-g — returns the default bezier curve: a gentle S-shape with both
// control points on the x-axis endpoints, creating an ease-in/ease-out feel.
export function createDefaultBezierCurve() {
  return {
    type: GRAPH_PARAMETER_CURVE_BEZIER,
    points: [
      { x: 0, y: 0 },
      { x: 0.4, y: 0 },
      { x: 0.6, y: 1 },
      { x: 1, y: 1 },
    ],
  }
}

// FXG.4-g — evaluates a cubic Bezier curve at a given source value xTarget in [0,1].
// Finds t such that bezierX(t) ≈ xTarget via binary subdivision, then returns bezierY(t).
// Falls back to identity (shapedT = xTarget) when the curve is invalid.
export function evaluateBezierCurve(curve, xTarget) {
  const x = clampUnitValue(xTarget, 0)
  if (x === 0) return 0
  if (x === 1) return 1

  if (!isPlainObject(curve) || !Array.isArray(curve.points) || curve.points.length !== 4) return x

  const p1 = curve.points[1]
  const p2 = curve.points[2]
  const cp1x = Number.isFinite(p1?.x) ? p1.x : 0.4
  const cp1y = Number.isFinite(p1?.y) ? p1.y : 0
  const cp2x = Number.isFinite(p2?.x) ? p2.x : 0.6
  const cp2y = Number.isFinite(p2?.y) ? p2.y : 1

  // Cubic bezier with P0=(0,0), P3=(1,1):
  //   B_x(t) = 3*(1-t)^2*t*cp1x + 3*(1-t)*t^2*cp2x + t^3
  //   B_y(t) = 3*(1-t)^2*t*cp1y + 3*(1-t)*t^2*cp2y + t^3
  const bx = (t) => {
    const s = 1 - t
    return 3 * s * s * t * cp1x + 3 * s * t * t * cp2x + t * t * t
  }
  const by = (t) => {
    const s = 1 - t
    return 3 * s * s * t * cp1y + 3 * s * t * t * cp2y + t * t * t
  }

  // Binary subdivision: find t_curve such that bx(t_curve) ≈ x (32 iterations → ~3e-10 precision).
  let lo = 0
  let hi = 1
  for (let i = 0; i < 32; i++) {
    const mid = (lo + hi) * 0.5
    if (bx(mid) < x) lo = mid
    else hi = mid
    if (hi - lo < 1e-9) break
  }

  return Math.min(1, Math.max(0, by((lo + hi) * 0.5)))
}

export function defaultParameterMapping() {
  return normalizeParameterMapping(undefined)
}

// Evaluates a (linear) parameter mapping against a macro value in [0,1].
// Returns { enabled, value }. value is null when the mapping is disabled.
//   t = clamp((macroValue - sourceMin) / (sourceMax - sourceMin), 0, 1)
//   value = clamp(targetMin + t * (targetMax - targetMin), 0, 1)
// A degenerate source span (sourceMin >= sourceMax) does not divide-by-zero: it
// steps to targetMin below the threshold and targetMax at/above it.
export function evaluateLinearParameterMapping(rawMapping, macroValue) {
  const mapping = normalizeParameterMapping(rawMapping)
  if (!mapping.enabled) return { enabled: false, value: null }

  const value = clampUnitValue(macroValue, 0)
  const span = mapping.sourceMax - mapping.sourceMin
  let t
  if (span <= 0) {
    t = value < mapping.sourceMin ? 0 : 1
  } else {
    t = Math.min(1, Math.max(0, (value - mapping.sourceMin) / span))
  }

  const mapped = mapping.targetMin + t * (mapping.targetMax - mapping.targetMin)
  return { enabled: true, value: Math.min(1, Math.max(0, mapped)) }
}

// FXG.4-g — evaluates any parameter mapping (linear or bezier) against a macro value.
// For linear curves, produces identical results to evaluateLinearParameterMapping.
// For bezier curves, applies Bezier shaping after source-range normalization and
// before target-range interpolation. Inverted target ranges (targetMin > targetMax)
// are preserved correctly. Disabled mappings return { enabled: false, value: null }.
export function evaluateParameterMapping(rawMapping, macroValue) {
  const mapping = normalizeParameterMapping(rawMapping)
  if (!mapping.enabled) return { enabled: false, value: null }

  const value = clampUnitValue(macroValue, 0)
  const span = mapping.sourceMax - mapping.sourceMin
  let t
  if (span <= 0) {
    t = value < mapping.sourceMin ? 0 : 1
  } else {
    t = Math.min(1, Math.max(0, (value - mapping.sourceMin) / span))
  }

  const shapedT = mapping.curve.type === GRAPH_PARAMETER_CURVE_BEZIER
    ? evaluateBezierCurve(mapping.curve, t)
    : t

  const mapped = mapping.targetMin + shapedT * (mapping.targetMax - mapping.targetMin)
  return { enabled: true, value: Math.min(1, Math.max(0, mapped)) }
}

function normalizeMacroLabel(value, fallback = 'Macro') {
  const label = typeof value === 'string' ? value.trim() : ''
  return label.length > 0 ? label : fallback
}

function defaultMacroLabel(graphState) {
  const macroCount = Array.isArray(graphState?.nodes)
    ? graphState.nodes.filter((node) => node?.type === GRAPH_MACRO_NODE_TYPE).length
    : 0
  return `Macro ${macroCount + 1}`
}

function validateMacroNodeData(node, _graphState, trackId, warnings) {
  const fallbackLabel = 'Macro'
  const rawData = isPlainObject(node.data) ? node.data : {}
  const label = normalizeMacroLabel(rawData.label ?? rawData.name, fallbackLabel)
  const normalizedValue = clampMacroNormalizedValue(rawData.normalizedValue)

  if (!isPlainObject(node.data)) {
    warnings.push(makeWarning('invalidMacroNodeData', trackId, 'invalid macro node data; using defaults', { nodeId: node.id }))
  } else if (label !== rawData.label || normalizedValue !== rawData.normalizedValue) {
    warnings.push(makeWarning('repairedMacroNodeData', trackId, 'macro node data repaired', { nodeId: node.id }))
  }

  return {
    ...cloneJson(rawData),
    label,
    normalizedValue,
  }
}

// ---------------------------------------------------------------------------
// EVC.2 / EVC-R2-r3 — Envelope Controller node data model (renderer-only)
//
// An envelope node owns an AHDSR controller definition. It is NOT an effect node:
// it has no effectInstanceId, owns no plugin metadata, hydrates no graph-owned
// processor, and never participates in audio topology sync. Parent ownership is
// graphState.trackId — the parent track id is never stored redundantly on the node
// (same single-source-of-truth rule as FXG.4-h macro automation lanes). The node is
// a triggered parameter-modulation source whose links live on parameter edges
// (GraphParameterTarget), not on the node.
//
// EVC-R2-r3 simplified the trigger model: the Envelope no longer stores a trigger
// source selector or a retrigger mode. The trigger source (notes vs clips) is
// inferred at runtime from the parent track's content type, and the Envelope always
// restarts on a new trigger. The only added field is `includeSlideNotes` (default
// false): slide notes are ignored unless the user opts in. The data shape normalizes
// to a stable, closed schema; malformed or missing fields repair to defaults.
// ---------------------------------------------------------------------------

export const ENVELOPE_NODE_DEFAULTS = Object.freeze({
  label: 'Envelope',
  attackMs: 10,
  holdMs: 0,
  decayMs: 120,
  sustain: 0.7,
  releaseMs: 200,
  attackTension: 0,
  decayTension: 0,
  releaseTension: 0,
  amount: 1,
  includeSlideNotes: false,
})

// ms fields must be finite numbers >= 0; anything else repairs to the default.
function clampEnvelopeMs(value, fallback) {
  return Number.isFinite(value) && value >= 0 ? value : fallback
}

// sustain/amount clamp to 0..1.
function clampEnvelopeUnit(value, fallback) {
  if (!Number.isFinite(value)) return fallback
  return Math.min(1, Math.max(0, value))
}

// tension fields clamp to -1..1.
function clampEnvelopeTension(value, fallback) {
  if (!Number.isFinite(value)) return fallback
  return Math.min(1, Math.max(-1, value))
}

// includeSlideNotes repairs to false unless the saved value is exactly boolean true.
// (Old saved triggerSource/retriggerMode fields, and the retired per-voice fields, are
// not normalized here at all — the closed schema below simply does not copy them.)
function normalizeEnvelopeIncludeSlideNotes(value) {
  return value === true
}

function normalizeEnvelopeLabel(value) {
  const label = typeof value === 'string' ? value.trim() : ''
  return label.length > 0 ? label : ENVELOPE_NODE_DEFAULTS.label
}

// Normalizes raw envelope node data into the stable closed schema. Missing or
// malformed input repairs to defaults; provided values are clamped/repaired.
//
// EVC-R2-r3 — the returned object is a closed shape: only the fields below survive.
// Anything else on the input is dropped, which covers every legacy/retired field:
//   - triggerSource / triggerEvents — replaced by runtime track-content inference
//   - retriggerMode — the Envelope is always restart-only now
//   - the retired per-voice fields voiceMode / maxVoices / monophonic
//   - the retired `target: { kind: "voiceGain" }`
//   - a redundant parentTrackId (parent ownership stays graphState.trackId)
// The only trigger-related field that persists is `includeSlideNotes` (default false).
export function normalizeEnvelopeNodeData(rawData) {
  const raw = isPlainObject(rawData) ? rawData : {}

  return {
    label: normalizeEnvelopeLabel(raw.label),

    attackMs: clampEnvelopeMs(raw.attackMs, ENVELOPE_NODE_DEFAULTS.attackMs),
    holdMs: clampEnvelopeMs(raw.holdMs, ENVELOPE_NODE_DEFAULTS.holdMs),
    decayMs: clampEnvelopeMs(raw.decayMs, ENVELOPE_NODE_DEFAULTS.decayMs),
    sustain: clampEnvelopeUnit(raw.sustain, ENVELOPE_NODE_DEFAULTS.sustain),
    releaseMs: clampEnvelopeMs(raw.releaseMs, ENVELOPE_NODE_DEFAULTS.releaseMs),

    attackTension: clampEnvelopeTension(raw.attackTension, ENVELOPE_NODE_DEFAULTS.attackTension),
    decayTension: clampEnvelopeTension(raw.decayTension, ENVELOPE_NODE_DEFAULTS.decayTension),
    releaseTension: clampEnvelopeTension(raw.releaseTension, ENVELOPE_NODE_DEFAULTS.releaseTension),

    amount: clampEnvelopeUnit(raw.amount, ENVELOPE_NODE_DEFAULTS.amount),

    // EVC-R2-r3 — slide notes are ignored at runtime unless this opt-in is true.
    includeSlideNotes: normalizeEnvelopeIncludeSlideNotes(raw.includeSlideNotes),
  }
}

// Builds a fully-defaulted envelope node data object, applying optional overrides
// through the same normalization (so overrides are clamped/repaired too).
export function createDefaultEnvelopeNodeData(overrides = {}) {
  return normalizeEnvelopeNodeData(isPlainObject(overrides) ? overrides : {})
}

// True only for graph-owned envelope nodes.
export function isEnvelopeGraphNode(node) {
  return isPlainObject(node) && node.type === GRAPH_ENVELOPE_NODE_TYPE
}

// Shallow-merges an update patch into current envelope data, then re-normalizes.
// EVC-R2-r3 — the envelope schema is now flat (no nested triggerSource), so a plain
// shallow spread is sufficient; normalization drops any stale/legacy keys in the patch.
function mergeEnvelopeNodeData(currentData, patch) {
  return { ...currentData, ...patch }
}

function validateEnvelopeNodeData(node, trackId, warnings) {
  const normalized = normalizeEnvelopeNodeData(node.data)
  if (!isPlainObject(node.data)) {
    warnings.push(makeWarning('invalidEnvelopeNodeData', trackId, 'invalid envelope node data; using defaults', { nodeId: node.id }))
  } else if (JSON.stringify(normalized) !== JSON.stringify(node.data)) {
    warnings.push(makeWarning('repairedEnvelopeNodeData', trackId, 'envelope node data repaired', { nodeId: node.id }))
  }
  return normalized
}

function validateEffectNodeData(node, trackId, warnings) {
  if (!isPlainObject(node.data)) {
    return { ok: false, reason: 'invalid_effect_node_data' }
  }

  const data = node.data
  const sourceChainSlotIndexValid =
    data.sourceChainSlotIndex === null || Number.isInteger(data.sourceChainSlotIndex)

  if (
    typeof data.effectInstanceId !== 'string' ||
    typeof data.pluginId !== 'string' ||
    typeof data.displayName !== 'string' ||
    typeof data.bypass !== 'boolean' ||
    typeof data.missing !== 'boolean' ||
    typeof data.crashed !== 'boolean' ||
    !sourceChainSlotIndexValid
  ) {
    warnings.push(makeWarning('invalidEffectNodeData', trackId, 'invalid effect node data', { nodeId: node.id }))
    return { ok: false, reason: 'invalid_effect_node_data' }
  }

  return {
    ok: true,
    data: {
      ...cloneJson(data),
      effectInstanceId: data.effectInstanceId,
      pluginId: data.pluginId,
      displayName: data.displayName,
      bypass: data.bypass,
      missing: data.missing,
      crashed: data.crashed,
      sourceChainSlotIndex: data.sourceChainSlotIndex,
      exposedParameterPorts: normalizeExposedParameterPorts(
        data.exposedParameterPorts,
        trackId,
        warnings,
        node.id,
      ),
    },
  }
}

function normalizeNullableBoolean(value) {
  return typeof value === 'boolean' ? value : null
}

function normalizeExposedParameterPort(raw, trackId, warnings, nodeId) {
  if (!isPlainObject(raw)) {
    warnings.push(makeWarning('invalidExposedParameterPort', trackId, 'invalid exposed parameter port dropped', { nodeId }))
    return null
  }

  const parameterId = typeof raw.parameterId === 'string' ? raw.parameterId.trim() : ''
  if (!parameterId) {
    warnings.push(makeWarning('invalidExposedParameterPort', trackId, 'exposed parameter port missing parameterId', { nodeId }))
    return null
  }

  // Read parameterIndexFallback first (FXG.4-c field name), fall back to parameterIndex
  // (FXG.4-b field name) so old saved graphs upgrade silently.
  const rawIndex = raw.parameterIndexFallback ?? raw.parameterIndex
  const parameterIndexFallback = Number.isInteger(rawIndex) && rawIndex >= 0 ? rawIndex : null
  const nameSnapshot = typeof raw.nameSnapshot === 'string' && raw.nameSnapshot.trim().length > 0
    ? raw.nameSnapshot.trim()
    : parameterId
  const labelSnapshot = typeof raw.labelSnapshot === 'string' && raw.labelSnapshot.trim().length > 0
    ? raw.labelSnapshot.trim()
    : null

  return {
    parameterId,
    parameterIndexFallback,
    nameSnapshot,
    labelSnapshot,
    parameterIdIsFallback: raw.parameterIdIsFallback === true,
    automatable: normalizeNullableBoolean(raw.automatable),
    readOnly: normalizeNullableBoolean(raw.readOnly),
  }
}

export function normalizeExposedParameterPorts(rawPorts, trackId = '', warnings = [], nodeId = '') {
  if (rawPorts == null) return []
  if (!Array.isArray(rawPorts)) {
    warnings.push(makeWarning('invalidExposedParameterPorts', trackId, 'exposedParameterPorts must be an array', { nodeId }))
    return []
  }

  const seen = new Set()
  const ports = []
  for (const rawPort of rawPorts) {
    const port = normalizeExposedParameterPort(rawPort, trackId, warnings, nodeId)
    if (!port) continue
    if (seen.has(port.parameterId)) {
      warnings.push(makeWarning('duplicateExposedParameterPort', trackId, 'duplicate exposed parameter port dropped', {
        nodeId,
        parameterId: port.parameterId,
      }))
      continue
    }
    seen.add(port.parameterId)
    ports.push(port)
  }
  return ports
}

export function buildExposedParameterPort(parameterDescriptor) {
  if (!isPlainObject(parameterDescriptor)) return null
  const parameterId = typeof parameterDescriptor.parameterId === 'string'
    ? parameterDescriptor.parameterId.trim()
    : ''
  if (!parameterId) return null

  const name =
    typeof parameterDescriptor.name === 'string' && parameterDescriptor.name.trim().length > 0
      ? parameterDescriptor.name.trim()
      : parameterId
  const label =
    typeof parameterDescriptor.unit === 'string' && parameterDescriptor.unit.trim().length > 0
      ? parameterDescriptor.unit.trim()
      : null

  return {
    parameterId,
    parameterIndexFallback:
      Number.isInteger(parameterDescriptor.parameterIndex) && parameterDescriptor.parameterIndex >= 0
        ? parameterDescriptor.parameterIndex
        : null,
    nameSnapshot: name,
    labelSnapshot: label,
    parameterIdIsFallback: parameterDescriptor.parameterIdIsFallback === true,
    automatable: normalizeNullableBoolean(parameterDescriptor.automatable),
    readOnly: normalizeNullableBoolean(parameterDescriptor.readOnly),
  }
}

export function toggleExposedParameterPort(graphState, nodeId, parameterDescriptor) {
  const editCheck = validateGraphStateForEditing(graphState)
  if (!editCheck.ok) return editCheck
  if (typeof nodeId !== 'string' || nodeId.length === 0) {
    return { ok: false, reason: GRAPH_MUTATION_REJECTION.MISSING_NODE }
  }

  const node = graphState.nodes.find((candidate) => candidate.id === nodeId)
  if (!node) return { ok: false, reason: GRAPH_MUTATION_REJECTION.MISSING_NODE }
  if (isProtectedGraphNodeType(node.type)) return { ok: false, reason: GRAPH_MUTATION_REJECTION.PROTECTED_NODE }
  if (node.type !== 'effect') return { ok: false, reason: GRAPH_MUTATION_REJECTION.UNKNOWN_NODE_TYPE }

  const port = buildExposedParameterPort(parameterDescriptor)
  if (!port) return { ok: false, reason: GRAPH_MUTATION_REJECTION.INVALID_PARAMETER_PORT }

  const currentPorts = normalizeExposedParameterPorts(node.data?.exposedParameterPorts)
  const alreadyExposed = currentPorts.some((candidate) => candidate.parameterId === port.parameterId)
  const nextPorts = alreadyExposed
    ? currentPorts.filter((candidate) => candidate.parameterId !== port.parameterId)
    : [...currentPorts, port]

  return {
    ok: true,
    exposed: !alreadyExposed,
    parameterPort: port,
    graphState: {
      ...graphState,
      nodes: graphState.nodes.map((candidate) => (
        candidate.id === nodeId
          ? {
              ...candidate,
              data: {
                ...(candidate.data ?? {}),
                exposedParameterPorts: nextPorts,
              },
            }
          : candidate
      )),
    },
  }
}

function normalizeNode(node, trackId, warnings, fallbackPosition, rawGraphState) {
  if (!isPlainObject(node)) return { ok: false, reason: 'invalid_node' }
  if (typeof node.id !== 'string' || node.id.length === 0) {
    return { ok: false, reason: 'invalid_node_id' }
  }
  if (typeof node.type !== 'string' || node.type.length === 0) {
    return { ok: false, reason: 'invalid_node_type' }
  }

  const position = nodePositionWithWarnings(
    node.position,
    fallbackPosition,
    trackId,
    warnings,
    node.id,
    Object.prototype.hasOwnProperty.call(node, 'position'),
  )

  if (!NODE_TYPES.has(node.type)) {
    warnings.push(makeWarning('unknownNodeType', trackId, 'unknown graphState node type preserved as unknown', {
      nodeId: node.id,
      preservedType: node.type,
    }))
    return {
      ok: true,
      node: withNodePosition({
        id: node.id,
        type: 'unknown',
        data: {
          _preservedType: node.type,
          _preservedData: isPlainObject(node.data) ? cloneJson(node.data) : {},
        },
      }, position),
    }
  }

  if (node.type === 'effect') {
    const effectData = validateEffectNodeData(node, trackId, warnings)
    if (!effectData.ok) return effectData
    return {
      ok: true,
      node: withNodePosition({
        id: node.id,
        type: 'effect',
        data: effectData.data,
      }, position),
    }
  }

  if (node.type === GRAPH_MACRO_NODE_TYPE) {
    return {
      ok: true,
      node: withNodePosition({
        id: node.id,
        type: GRAPH_MACRO_NODE_TYPE,
        data: validateMacroNodeData(node, rawGraphState, trackId, warnings),
      }, position),
    }
  }

  if (node.type === GRAPH_ENVELOPE_NODE_TYPE) {
    return {
      ok: true,
      node: withNodePosition({
        id: node.id,
        type: GRAPH_ENVELOPE_NODE_TYPE,
        data: validateEnvelopeNodeData(node, trackId, warnings),
      }, position),
    }
  }

  return {
    ok: true,
    node: withNodePosition({
      id: node.id,
      type: node.type,
      data: isPlainObject(node.data) ? cloneJson(node.data) : {},
    }, position),
  }
}

function normalizeEdge(edge, nodeIds, nodeById, trackId, warnings) {
  if (!isPlainObject(edge)) return { ok: false, reason: 'invalid_edge' }
  if (typeof edge.id !== 'string' || edge.id.length === 0) {
    return { ok: false, reason: 'invalid_edge_id' }
  }
  if (
    typeof edge.sourceNodeId !== 'string' ||
    typeof edge.sourcePort !== 'string' ||
    typeof edge.targetNodeId !== 'string' ||
    typeof edge.targetPort !== 'string'
  ) {
    return { ok: false, reason: 'invalid_edge_endpoint' }
  }
  if (!nodeIds.has(edge.sourceNodeId) || !nodeIds.has(edge.targetNodeId)) {
    warnings.push(makeWarning('invalidEdgeReference', trackId, 'graphState edge references a missing node', {
      edgeId: edge.id,
      sourceNodeId: edge.sourceNodeId,
      targetNodeId: edge.targetNodeId,
    }))
    return { ok: false, reason: 'invalid_edge_reference' }
  }
  if (typeof edge.type !== 'string' || edge.type.length === 0) {
    return { ok: false, reason: 'invalid_edge_type' }
  }

  if (!EDGE_TYPES.has(edge.type)) {
    warnings.push(makeWarning('unknownEdgeType', trackId, 'unknown graphState edge type preserved as unknown', {
      edgeId: edge.id,
      preservedType: edge.type,
    }))
    return {
      ok: true,
      edge: {
        id: edge.id,
        sourceNodeId: edge.sourceNodeId,
        sourcePort: edge.sourcePort,
        targetNodeId: edge.targetNodeId,
        targetPort: edge.targetPort,
        type: 'unknown',
        _preservedType: edge.type,
      },
    }
  }

  const sourceNodeType = nodeById.get(edge.sourceNodeId)?.type
  const targetNodeType = nodeById.get(edge.targetNodeId)?.type
  if (
    edge.type === 'audio' &&
    (sourceNodeType === GRAPH_MACRO_NODE_TYPE || targetNodeType === GRAPH_MACRO_NODE_TYPE)
  ) {
    warnings.push(makeWarning('invalidMacroAudioEdge', trackId, 'audio edge involving macro node dropped', {
      edgeId: edge.id,
      sourceNodeId: edge.sourceNodeId,
      targetNodeId: edge.targetNodeId,
    }))
    return { ok: false, reason: 'invalid_macro_audio_edge', drop: true }
  }

  // EVC.2 — envelope nodes are control/voice-controller nodes; they never carry
  // audio. Drop any audio edge touching an envelope node, mirroring macro nodes.
  if (
    edge.type === 'audio' &&
    (sourceNodeType === GRAPH_ENVELOPE_NODE_TYPE || targetNodeType === GRAPH_ENVELOPE_NODE_TYPE)
  ) {
    warnings.push(makeWarning('invalidEnvelopeAudioEdge', trackId, 'audio edge involving envelope node dropped', {
      edgeId: edge.id,
      sourceNodeId: edge.sourceNodeId,
      targetNodeId: edge.targetNodeId,
    }))
    return { ok: false, reason: 'invalid_envelope_audio_edge', drop: true }
  }

  const normalizedEdge = {
    id: edge.id,
    sourceNodeId: edge.sourceNodeId,
    sourcePort: edge.sourcePort,
    targetNodeId: edge.targetNodeId,
    targetPort: edge.targetPort,
    type: edge.type,
  }

  // Parameter edges carry an optional targetParameter identity.
  // Stored as-is without deep validation here — graphParameterTarget.js
  // owns normalization of the target shape when it is read back.
  if (edge.type === 'parameter') {
    if (isPlainObject(edge.targetParameter)) {
      normalizedEdge.targetParameter = cloneJson(edge.targetParameter)
    }
    // FXG.4-e/f — every parameter edge carries a clamped/repaired mapping object so
    // runtime drive always has well-formed defaults. Malformed mappings repair to
    // the default linear mapping rather than dropping the edge.
    normalizedEdge.mapping = normalizeParameterMapping(edge.mapping)
  }

  return { ok: true, edge: normalizedEdge }
}

function hasAudioCycle(nodes, edges) {
  const outgoing = new Map(nodes.map((node) => [node.id, []]))
  for (const edge of edges) {
    if (edge.type !== 'audio') continue
    outgoing.get(edge.sourceNodeId)?.push(edge.targetNodeId)
  }

  const visiting = new Set()
  const visited = new Set()

  function visit(nodeId) {
    if (visiting.has(nodeId)) return true
    if (visited.has(nodeId)) return false

    visiting.add(nodeId)
    for (const nextNodeId of outgoing.get(nodeId) ?? []) {
      if (visit(nextNodeId)) return true
    }
    visiting.delete(nodeId)
    visited.add(nodeId)
    return false
  }

  return nodes.some((node) => visit(node.id))
}

function validateVersionOneGraphState(raw, expectedTrackId, options) {
  const trackId = normalizeTrackId(expectedTrackId)
  const warnings = []

  if (typeof raw.trackId !== 'string') {
    warnings.push(makeWarning('invalidTrackId', trackId, 'graphState trackId is missing or invalid'))
    return invalid('invalid_track_id', warnings)
  }
  if (raw.trackId !== trackId) {
    warnings.push(makeWarning('trackIdMismatch', trackId, 'graphState belongs to a different track', {
      graphStateTrackId: raw.trackId,
    }))
    return invalid('track_id_mismatch', warnings)
  }
  if (!Array.isArray(raw.nodes)) {
    warnings.push(makeWarning('invalidNodes', trackId, 'graphState nodes must be an array'))
    return invalid('invalid_nodes', warnings)
  }
  if (!Array.isArray(raw.edges)) {
    warnings.push(makeWarning('invalidEdges', trackId, 'graphState edges must be an array'))
    return invalid('invalid_edges', warnings)
  }

  const nodes = []
  const nodeIds = new Set()
  let trackInputCount = 0
  let trackOutputCount = 0

  for (let index = 0; index < raw.nodes.length; index += 1) {
    const normalized = normalizeNode(raw.nodes[index], trackId, warnings, fallbackNodePosition(index), raw)
    if (!normalized.ok) return invalid(normalized.reason, warnings)
    if (nodeIds.has(normalized.node.id)) {
      warnings.push(makeWarning('duplicateNodeId', trackId, 'duplicate graphState node id', { nodeId: normalized.node.id }))
      return invalid('duplicate_node_id', warnings)
    }
    nodeIds.add(normalized.node.id)
    if (normalized.node.type === 'trackInput') trackInputCount += 1
    if (normalized.node.type === 'trackOutput') trackOutputCount += 1
    nodes.push(normalized.node)
  }

  if (nodes.length > 0 && (trackInputCount !== 1 || trackOutputCount !== 1)) {
    warnings.push(makeWarning('invalidTrackIoMultiplicity', trackId, 'graphState must have exactly one trackInput and one trackOutput when nodes exist', {
      trackInputCount,
      trackOutputCount,
    }))
    return invalid('invalid_track_io_multiplicity', warnings)
  }

  const edges = []
  const edgeIds = new Set()
  const nodeById = new Map(nodes.map((node) => [node.id, node]))
  for (const edge of raw.edges) {
    const normalized = normalizeEdge(edge, nodeIds, nodeById, trackId, warnings)
    if (!normalized.ok && normalized.drop) continue
    if (!normalized.ok) return invalid(normalized.reason, warnings)
    if (edgeIds.has(normalized.edge.id)) {
      warnings.push(makeWarning('duplicateEdgeId', trackId, 'duplicate graphState edge id', { edgeId: normalized.edge.id }))
      return invalid('duplicate_edge_id', warnings)
    }
    edgeIds.add(normalized.edge.id)
    edges.push(normalized.edge)
  }

  if (hasAudioCycle(nodes, edges)) {
    warnings.push(makeWarning('cycleDetected', trackId, 'graphState contains an audio cycle'))
    return invalid('cycle_detected', warnings)
  }

  // FXG.4-h — normalize parent-attached macro automation lanes. Lanes bind to a
  // macroNodeId that must exist as a macro node in this graph; lanes for a missing
  // macro are preserved but flagged targetUnavailable (orphaned), never deleted.
  const macroNodeIds = new Set(
    nodes.filter((node) => node.type === GRAPH_MACRO_NODE_TYPE).map((node) => node.id),
  )
  const macroAutomationLanes = normalizeMacroAutomationLanes(raw.macroAutomationLanes, macroNodeIds)

  const graphState = {
    ...cloneJson(raw),
    schemaVersion: GRAPH_STATE_SCHEMA_VERSION,
    trackId,
    nodes,
    edges,
    viewport: defaultViewportWithWarnings(raw.viewport, trackId, warnings),
    macroAutomationLanes,
  }

  return { status: 'valid', graphState, warnings }
}

export function createEmptyGraphState(trackId) {
  return {
    schemaVersion: GRAPH_STATE_SCHEMA_VERSION,
    trackId: normalizeTrackId(trackId),
    nodes: [],
    edges: [],
    viewport: { ...DEFAULT_VIEWPORT },
    macroAutomationLanes: [],
  }
}

export function migrateGraphState(raw, fromVersion) {
  if (fromVersion === GRAPH_STATE_SCHEMA_VERSION) return cloneJson(raw)
  return cloneJson(raw)
}

export function validateGraphState(raw, expectedTrackId) {
  return loadGraphState(raw, expectedTrackId, { logWarnings: false })
}

export function loadGraphState(raw, expectedTrackId, options = {}) {
  const trackId = normalizeTrackId(expectedTrackId)

  if (raw == null) {
    const warnings = []
    if (options.fxMode === 'graph') {
      warnings.push(makeWarning('missingGraphState', trackId, 'graph track has missing graphState'))
    }
    return finish({ status: 'missing', graphState: null, warnings }, options)
  }

  if (!isPlainObject(raw)) {
    const warnings = [
      makeWarning('invalidGraphState', trackId, 'graphState must be an object'),
    ]
    return finish(invalid('non_object_graph_state', warnings), options)
  }

  if (!Object.prototype.hasOwnProperty.call(raw, 'schemaVersion')) {
    const warnings = [
      makeWarning('missingSchemaVersion', trackId, 'graphState schemaVersion is missing'),
    ]
    return finish(invalid('missing_schema_version', warnings), options)
  }

  if (!Number.isInteger(raw.schemaVersion)) {
    const warnings = [
      makeWarning('invalidSchemaVersion', trackId, 'graphState schemaVersion is invalid'),
    ]
    return finish(invalid('invalid_schema_version', warnings), options)
  }

  if (raw.schemaVersion < GRAPH_STATE_SCHEMA_VERSION) {
    const warnings = [
      makeWarning('oldSchemaVersion', trackId, 'graphState schemaVersion is unsupported', {
        schemaVersion: raw.schemaVersion,
      }),
    ]
    return finish(invalid('old_schema_version', warnings), options)
  }

  if (raw.schemaVersion > GRAPH_STATE_SCHEMA_VERSION) {
    const warnings = [
      makeWarning('futureSchemaVersion', trackId, 'future graphState schemaVersion preserved as unsupported', {
        schemaVersion: raw.schemaVersion,
      }),
    ]
    return finish({
      status: 'future',
      graphState: null,
      raw: cloneJson(raw),
      reason: 'future_schema_version',
      warnings,
    }, options)
  }

  return finish(validateVersionOneGraphState(raw, trackId, options), options)
}

export function saveGraphState(graphState) {
  if (graphState == null) return null
  return cloneJson(graphState)
}

// ---------------------------------------------------------------------------
// FXG.2C-d — Graph mutation architecture guards
//
// These helpers are topology guards for renderer-side graphState only.
// They do NOT enforce fxMode ownership. FXG.2C-e store actions must check
// fxMode === 'graph' before calling any mutation helper.
//
// Effect nodes added via mutation helpers exist in renderer-side graphState
// only. No audio engine execution or bridge API involvement until FXG.3.
// ---------------------------------------------------------------------------

function generateMutationId(idFactory) {
  if (typeof idFactory === 'function') {
    const id = idFactory()
    if (typeof id === 'string' && id.length > 0) return id
  }
  return globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

// Mirrors chainToGraphState.js port convention (lines 189-191) exactly.
function inferSourcePort(nodeType) {
  if (nodeType === 'trackInput') return 'audio'
  if (nodeType === 'effect') return 'audioOut'
  if (nodeType === GRAPH_MACRO_NODE_TYPE) return GRAPH_MACRO_OUTPUT_PORT
  return 'audio'
}

function inferTargetPort(nodeType) {
  if (nodeType === 'trackOutput') return 'audio'
  if (nodeType === 'effect') return 'audioIn'
  return 'audio'
}

export const PROTECTED_NODE_TYPES = Object.freeze(['trackInput', 'trackOutput'])
const PROTECTED_NODE_TYPES_SET = new Set(PROTECTED_NODE_TYPES)

export const GRAPH_MUTATION_REJECTION = Object.freeze({
  PROTECTED_NODE: 'protected_node',
  MISSING_NODE: 'missing_node',
  MISSING_EDGE: 'missing_edge',
  MISSING_SOURCE_NODE: 'missing_source_node',
  MISSING_TARGET_NODE: 'missing_target_node',
  SELF_CONNECTION: 'self_connection',
  DUPLICATE_EDGE: 'duplicate_edge',
  CYCLE_DETECTED: 'cycle_detected',
  INVALID_SOURCE_TYPE: 'invalid_source_type',
  INVALID_TARGET_TYPE: 'invalid_target_type',
  UNKNOWN_NODE_TYPE: 'unknown_node_type',
  INVALID_GRAPH_STATE: 'invalid_graph_state',
  INVALID_NODE_DRAFT: 'invalid_node_draft',
  INVALID_CONNECTION_DRAFT: 'invalid_connection_draft',
  INVALID_PARAMETER_PORT: 'invalid_parameter_port',
  INVALID_MACRO_VALUE: 'invalid_macro_value',
  // EVC.2 — envelope node data patch validation
  INVALID_ENVELOPE_PATCH: 'invalid_envelope_patch',
  // FXG.4-e/f — Macro -> Parameter link validation
  INVALID_PARAMETER_TARGET: 'invalid_parameter_target',
  MISSING_EFFECT_INSTANCE: 'missing_effect_instance',
  PARAMETER_NOT_EXPOSED: 'parameter_not_exposed',
  PARAMETER_READ_ONLY: 'parameter_read_only',
  // FXG.4-g — mapping editor mutation validation
  INVALID_PARAMETER_EDGE: 'invalid_parameter_edge',
})

export function isProtectedGraphNodeType(type) {
  return PROTECTED_NODE_TYPES_SET.has(type)
}

export function validateGraphStateForEditing(graphState) {
  if (
    graphState == null ||
    !isPlainObject(graphState) ||
    !Array.isArray(graphState.nodes) ||
    !Array.isArray(graphState.edges)
  ) {
    return { ok: false, reason: GRAPH_MUTATION_REJECTION.INVALID_GRAPH_STATE }
  }
  return { ok: true }
}

export function hasEquivalentGraphEdge(graphState, sourceNodeId, targetNodeId, edgeType = 'audio') {
  if (!Array.isArray(graphState?.edges)) return false
  return graphState.edges.some(
    (edge) =>
      edge.sourceNodeId === sourceNodeId &&
      edge.targetNodeId === targetNodeId &&
      edge.type === edgeType,
  )
}

export function canRemoveGraphNode(graphState, nodeId) {
  const editCheck = validateGraphStateForEditing(graphState)
  if (!editCheck.ok) return editCheck

  const node = graphState.nodes.find((n) => n.id === nodeId)
  if (!node) return { ok: false, reason: GRAPH_MUTATION_REJECTION.MISSING_NODE }
  if (isProtectedGraphNodeType(node.type)) return { ok: false, reason: GRAPH_MUTATION_REJECTION.PROTECTED_NODE }

  return { ok: true }
}

export function canConnectGraphNodes(graphState, sourceNodeId, targetNodeId, options = {}) {
  const editCheck = validateGraphStateForEditing(graphState)
  if (!editCheck.ok) return editCheck

  const edgeType = options.edgeType ?? 'audio'
  const sourceNode = graphState.nodes.find((n) => n.id === sourceNodeId)
  const targetNode = graphState.nodes.find((n) => n.id === targetNodeId)

  if (!sourceNode) return { ok: false, reason: GRAPH_MUTATION_REJECTION.MISSING_SOURCE_NODE }
  if (!targetNode) return { ok: false, reason: GRAPH_MUTATION_REJECTION.MISSING_TARGET_NODE }
  if (sourceNodeId === targetNodeId) return { ok: false, reason: GRAPH_MUTATION_REJECTION.SELF_CONNECTION }
  if (sourceNode.type === 'trackOutput') return { ok: false, reason: GRAPH_MUTATION_REJECTION.INVALID_SOURCE_TYPE }
  if (targetNode.type === 'trackInput') return { ok: false, reason: GRAPH_MUTATION_REJECTION.INVALID_TARGET_TYPE }
  if (sourceNode.type === 'unknown') return { ok: false, reason: GRAPH_MUTATION_REJECTION.UNKNOWN_NODE_TYPE }
  if (targetNode.type === 'unknown') return { ok: false, reason: GRAPH_MUTATION_REJECTION.UNKNOWN_NODE_TYPE }
  if (edgeType === 'audio' && sourceNode.type === GRAPH_MACRO_NODE_TYPE) {
    return { ok: false, reason: GRAPH_MUTATION_REJECTION.INVALID_SOURCE_TYPE }
  }
  if (edgeType === 'audio' && targetNode.type === GRAPH_MACRO_NODE_TYPE) {
    return { ok: false, reason: GRAPH_MUTATION_REJECTION.INVALID_TARGET_TYPE }
  }
  // EVC.2 — envelope nodes carry no audio, same as macro nodes.
  if (edgeType === 'audio' && sourceNode.type === GRAPH_ENVELOPE_NODE_TYPE) {
    return { ok: false, reason: GRAPH_MUTATION_REJECTION.INVALID_SOURCE_TYPE }
  }
  if (edgeType === 'audio' && targetNode.type === GRAPH_ENVELOPE_NODE_TYPE) {
    return { ok: false, reason: GRAPH_MUTATION_REJECTION.INVALID_TARGET_TYPE }
  }

  if (hasEquivalentGraphEdge(graphState, sourceNodeId, targetNodeId, edgeType)) {
    return { ok: false, reason: GRAPH_MUTATION_REJECTION.DUPLICATE_EDGE }
  }

  const hypotheticalEdge = {
    id: '__hypothetical__',
    sourceNodeId,
    sourcePort: inferSourcePort(sourceNode.type),
    targetNodeId,
    targetPort: inferTargetPort(targetNode.type),
    type: edgeType,
  }
  if (hasAudioCycle(graphState.nodes, [...graphState.edges, hypotheticalEdge])) {
    return { ok: false, reason: GRAPH_MUTATION_REJECTION.CYCLE_DETECTED }
  }

  return { ok: true }
}

export function addGraphEffectNode(graphState, nodeDraft, options = {}) {
  const editCheck = validateGraphStateForEditing(graphState)
  if (!editCheck.ok) return editCheck

  if (
    !isPlainObject(nodeDraft) ||
    typeof nodeDraft.effectInstanceId !== 'string' ||
    nodeDraft.effectInstanceId.length === 0 ||
    typeof nodeDraft.pluginId !== 'string' ||
    nodeDraft.pluginId.length === 0 ||
    typeof nodeDraft.displayName !== 'string'
  ) {
    return { ok: false, reason: GRAPH_MUTATION_REJECTION.INVALID_NODE_DRAFT }
  }

  let position = nodeDraft.position
  if (
    !isPlainObject(position) ||
    !Number.isFinite(position.x) ||
    !Number.isFinite(position.y)
  ) {
    const outputIndex = graphState.nodes.findIndex((n) => n.type === 'trackOutput')
    const insertIndex = outputIndex >= 0 ? outputIndex : graphState.nodes.length
    position = { x: insertIndex * FALLBACK_NODE_SPACING_X, y: FALLBACK_NODE_Y }
  }

  const newNode = {
    id: generateMutationId(options.idFactory),
    type: 'effect',
    position: { x: position.x, y: position.y },
    data: {
      effectInstanceId: nodeDraft.effectInstanceId,
      pluginId: nodeDraft.pluginId,
      displayName: nodeDraft.displayName,
      bypass: nodeDraft.bypass === true,
      missing: nodeDraft.missing === true,
      crashed: nodeDraft.crashed === true,
      sourceChainSlotIndex: null,
    },
  }

  return {
    ok: true,
    graphState: {
      ...graphState,
      nodes: [...graphState.nodes, newNode],
    },
  }
}

export function addGraphMacroNode(graphState, nodeDraft = {}, options = {}) {
  const editCheck = validateGraphStateForEditing(graphState)
  if (!editCheck.ok) return editCheck

  const draft = isPlainObject(nodeDraft) ? nodeDraft : {}
  let position = draft.position
  if (
    !isPlainObject(position) ||
    !Number.isFinite(position.x) ||
    !Number.isFinite(position.y)
  ) {
    const outputIndex = graphState.nodes.findIndex((n) => n.type === 'trackOutput')
    const insertIndex = outputIndex >= 0 ? outputIndex : graphState.nodes.length
    position = { x: insertIndex * FALLBACK_NODE_SPACING_X, y: FALLBACK_NODE_Y }
  }

  const newNode = {
    id: generateMutationId(options.idFactory),
    type: GRAPH_MACRO_NODE_TYPE,
    position: { x: position.x, y: position.y },
    data: {
      label: normalizeMacroLabel(draft.label ?? draft.name, defaultMacroLabel(graphState)),
      normalizedValue: clampMacroNormalizedValue(draft.normalizedValue),
    },
  }

  return {
    ok: true,
    graphState: {
      ...graphState,
      nodes: [...graphState.nodes, newNode],
    },
  }
}

export function updateGraphMacroValue(graphState, nodeId, value) {
  const editCheck = validateGraphStateForEditing(graphState)
  if (!editCheck.ok) return editCheck
  if (typeof nodeId !== 'string' || nodeId.length === 0) {
    return { ok: false, reason: GRAPH_MUTATION_REJECTION.MISSING_NODE }
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return { ok: false, reason: GRAPH_MUTATION_REJECTION.INVALID_MACRO_VALUE }
  }

  const node = graphState.nodes.find((candidate) => candidate.id === nodeId)
  if (!node) return { ok: false, reason: GRAPH_MUTATION_REJECTION.MISSING_NODE }
  if (node.type !== GRAPH_MACRO_NODE_TYPE) return { ok: false, reason: GRAPH_MUTATION_REJECTION.UNKNOWN_NODE_TYPE }

  const normalizedValue = clampMacroNormalizedValue(value)
  return {
    ok: true,
    graphState: {
      ...graphState,
      nodes: graphState.nodes.map((candidate) => (
        candidate.id === nodeId
          ? {
              ...candidate,
              data: {
                ...(candidate.data ?? {}),
                label: normalizeMacroLabel(candidate.data?.label, defaultMacroLabel(graphState)),
                normalizedValue,
              },
            }
          : candidate
      )),
    },
  }
}

// EVC.2 — adds an inert envelope control node to graphState. The node is created
// with a stable generated id (idFactory pattern) and a finite position, defaulting
// to the trackOutput column when none is supplied. It creates NO edges and is not
// protected (removable by removeGraphNode). options: { idFactory?, position?, data? }
// where data is an optional partial override of the envelope data (clamped/repaired).
export function addGraphEnvelopeNode(graphState, options = {}) {
  const editCheck = validateGraphStateForEditing(graphState)
  if (!editCheck.ok) return editCheck

  const opts = isPlainObject(options) ? options : {}
  const data = createDefaultEnvelopeNodeData(opts.data)

  let position = opts.position
  if (
    !isPlainObject(position) ||
    !Number.isFinite(position.x) ||
    !Number.isFinite(position.y)
  ) {
    const outputIndex = graphState.nodes.findIndex((n) => n.type === 'trackOutput')
    const insertIndex = outputIndex >= 0 ? outputIndex : graphState.nodes.length
    position = { x: insertIndex * FALLBACK_NODE_SPACING_X, y: FALLBACK_NODE_Y }
  }

  const newNode = {
    id: generateMutationId(opts.idFactory),
    type: GRAPH_ENVELOPE_NODE_TYPE,
    position: { x: position.x, y: position.y },
    data,
  }

  return {
    ok: true,
    graphState: {
      ...graphState,
      nodes: [...graphState.nodes, newNode],
    },
  }
}

// EVC.2 — updates an envelope node's data with a partial patch (immutably). Only
// envelope nodes are eligible: a missing node returns MISSING_NODE and a non-
// envelope node returns UNKNOWN_NODE_TYPE. The patch is merged over the current
// (normalized) data and re-normalized, so unrelated envelope fields and all other
// graphState fields/nodes are preserved.
export function updateGraphEnvelopeNodeData(graphState, nodeId, patch) {
  const editCheck = validateGraphStateForEditing(graphState)
  if (!editCheck.ok) return editCheck
  if (typeof nodeId !== 'string' || nodeId.length === 0) {
    return { ok: false, reason: GRAPH_MUTATION_REJECTION.MISSING_NODE }
  }
  if (!isPlainObject(patch)) {
    return { ok: false, reason: GRAPH_MUTATION_REJECTION.INVALID_ENVELOPE_PATCH }
  }

  const node = graphState.nodes.find((candidate) => candidate.id === nodeId)
  if (!node) return { ok: false, reason: GRAPH_MUTATION_REJECTION.MISSING_NODE }
  if (node.type !== GRAPH_ENVELOPE_NODE_TYPE) {
    return { ok: false, reason: GRAPH_MUTATION_REJECTION.UNKNOWN_NODE_TYPE }
  }

  const currentData = normalizeEnvelopeNodeData(node.data)
  const nextData = normalizeEnvelopeNodeData(mergeEnvelopeNodeData(currentData, patch))

  return {
    ok: true,
    graphState: {
      ...graphState,
      nodes: graphState.nodes.map((candidate) => (
        candidate.id === nodeId
          ? { ...candidate, data: nextData }
          : candidate
      )),
    },
  }
}

export function renameGraphMacroNode(graphState, nodeId, label) {
  const editCheck = validateGraphStateForEditing(graphState)
  if (!editCheck.ok) return editCheck
  if (typeof nodeId !== 'string' || nodeId.length === 0) {
    return { ok: false, reason: GRAPH_MUTATION_REJECTION.MISSING_NODE }
  }

  const node = graphState.nodes.find((candidate) => candidate.id === nodeId)
  if (!node) return { ok: false, reason: GRAPH_MUTATION_REJECTION.MISSING_NODE }
  if (node.type !== GRAPH_MACRO_NODE_TYPE) return { ok: false, reason: GRAPH_MUTATION_REJECTION.UNKNOWN_NODE_TYPE }

  const nextLabel = normalizeMacroLabel(label, defaultMacroLabel(graphState))
  return {
    ok: true,
    graphState: {
      ...graphState,
      nodes: graphState.nodes.map((candidate) => (
        candidate.id === nodeId
          ? {
              ...candidate,
              data: {
                ...(candidate.data ?? {}),
                label: nextLabel,
                normalizedValue: clampMacroNormalizedValue(candidate.data?.normalizedValue),
              },
            }
          : candidate
      )),
    },
  }
}

export function removeGraphNode(graphState, nodeId) {
  const canRemove = canRemoveGraphNode(graphState, nodeId)
  if (!canRemove.ok) return canRemove

  return {
    ok: true,
    graphState: {
      ...graphState,
      nodes: graphState.nodes.filter((n) => n.id !== nodeId),
      edges: graphState.edges.filter(
        (e) => e.sourceNodeId !== nodeId && e.targetNodeId !== nodeId,
      ),
    },
  }
}

export function connectGraphNodes(graphState, connectionDraft, options = {}) {
  if (!isPlainObject(connectionDraft)) {
    return { ok: false, reason: GRAPH_MUTATION_REJECTION.INVALID_CONNECTION_DRAFT }
  }

  const { sourceNodeId, targetNodeId } = connectionDraft
  // Parameter edges are data-model only until modulation runtime exists.
  // User-facing graph connections are always audio; reject any attempt to
  // create a parameter edge through the normal connect path.
  const edgeType = connectionDraft.edgeType ?? 'audio'
  if (edgeType !== 'audio') {
    return { ok: false, reason: GRAPH_MUTATION_REJECTION.INVALID_CONNECTION_DRAFT }
  }

  const canConnect = canConnectGraphNodes(graphState, sourceNodeId, targetNodeId, { edgeType })
  if (!canConnect.ok) return canConnect

  const sourceNode = graphState.nodes.find((n) => n.id === sourceNodeId)
  const targetNode = graphState.nodes.find((n) => n.id === targetNodeId)

  const sourcePort = connectionDraft.sourcePort ?? inferSourcePort(sourceNode.type)
  const targetPort = connectionDraft.targetPort ?? inferTargetPort(targetNode.type)

  const newEdge = {
    id: generateMutationId(options.idFactory),
    sourceNodeId,
    sourcePort,
    targetNodeId,
    targetPort,
    type: edgeType,
  }

  return {
    ok: true,
    graphState: {
      ...graphState,
      edges: [...graphState.edges, newEdge],
    },
  }
}

export function disconnectGraphEdge(graphState, edgeId) {
  const editCheck = validateGraphStateForEditing(graphState)
  if (!editCheck.ok) return editCheck

  if (typeof edgeId !== 'string' || edgeId.length === 0) {
    return { ok: false, reason: GRAPH_MUTATION_REJECTION.MISSING_EDGE }
  }

  const edgeExists = graphState.edges.some((e) => e.id === edgeId)
  if (!edgeExists) return { ok: false, reason: GRAPH_MUTATION_REJECTION.MISSING_EDGE }

  return {
    ok: true,
    graphState: {
      ...graphState,
      edges: graphState.edges.filter((e) => e.id !== edgeId),
    },
  }
}

// ---------------------------------------------------------------------------
// FXG.4-e/f — Macro -> Parameter links
//
// A parameter edge connects a Macro `controlOut` port to an exposed parameter
// input port on an effect node. It is NOT an audio edge: audio topology and cycle
// detection ignore it (they filter `edge.type === 'audio'`), and the engine audio
// graph never receives it. The edge persists the FXG.4-c GraphParameterTarget plus
// a per-link mapping object. The macro normalizedValue stays the clean source.
// ---------------------------------------------------------------------------

function readEffectInstanceId(node) {
  const value = node?.data?.effectInstanceId
  return typeof value === 'string' && value.length > 0 ? value : ''
}

export function canConnectMacroToParameter(graphState, connectionDraft) {
  const editCheck = validateGraphStateForEditing(graphState)
  if (!editCheck.ok) return editCheck

  if (!isPlainObject(connectionDraft)) {
    return { ok: false, reason: GRAPH_MUTATION_REJECTION.INVALID_CONNECTION_DRAFT }
  }

  const { sourceNodeId, targetNodeId } = connectionDraft
  const parameterId = typeof connectionDraft.parameterId === 'string'
    ? connectionDraft.parameterId.trim()
    : ''

  const sourceNode = graphState.nodes.find((n) => n.id === sourceNodeId)
  const targetNode = graphState.nodes.find((n) => n.id === targetNodeId)

  if (!sourceNode) return { ok: false, reason: GRAPH_MUTATION_REJECTION.MISSING_SOURCE_NODE }
  if (!targetNode) return { ok: false, reason: GRAPH_MUTATION_REJECTION.MISSING_TARGET_NODE }
  if (sourceNodeId === targetNodeId) return { ok: false, reason: GRAPH_MUTATION_REJECTION.SELF_CONNECTION }

  // Source must be a macro control node. Effect nodes cannot source parameter edges.
  if (sourceNode.type !== GRAPH_MACRO_NODE_TYPE) {
    return { ok: false, reason: GRAPH_MUTATION_REJECTION.INVALID_SOURCE_TYPE }
  }
  // Target must be an effect node. Protected Track I/O and macro nodes are invalid targets.
  if (isProtectedGraphNodeType(targetNode.type)) {
    return { ok: false, reason: GRAPH_MUTATION_REJECTION.PROTECTED_NODE }
  }
  if (targetNode.type !== 'effect') {
    return { ok: false, reason: GRAPH_MUTATION_REJECTION.INVALID_TARGET_TYPE }
  }

  if (!parameterId) {
    return { ok: false, reason: GRAPH_MUTATION_REJECTION.INVALID_PARAMETER_TARGET }
  }

  const effectInstanceId = readEffectInstanceId(targetNode)
  if (!effectInstanceId) {
    return { ok: false, reason: GRAPH_MUTATION_REJECTION.MISSING_EFFECT_INSTANCE }
  }

  const exposedPorts = normalizeExposedParameterPorts(targetNode.data?.exposedParameterPorts)
  const exposedPort = exposedPorts.find((port) => port.parameterId === parameterId)
  if (!exposedPort) {
    return { ok: false, reason: GRAPH_MUTATION_REJECTION.PARAMETER_NOT_EXPOSED }
  }
  // Read-only / non-automatable parameters cannot be driven.
  if (exposedPort.readOnly === true || exposedPort.automatable === false) {
    return { ok: false, reason: GRAPH_MUTATION_REJECTION.PARAMETER_READ_ONLY }
  }

  const target = createGraphParameterTargetFromExposedPort({
    graphNode: targetNode,
    effectInstanceId,
    exposedPort,
  })
  if (!target) {
    return { ok: false, reason: GRAPH_MUTATION_REJECTION.INVALID_PARAMETER_TARGET }
  }

  const targetPort = buildGraphParameterPortId(targetNodeId, parameterId)
  if (!targetPort) {
    return { ok: false, reason: GRAPH_MUTATION_REJECTION.INVALID_PARAMETER_TARGET }
  }

  // Dedupe: one Macro may only drive a given parameter on a given node once.
  const duplicate = graphState.edges.some(
    (edge) =>
      edge.type === 'parameter' &&
      edge.sourceNodeId === sourceNodeId &&
      edge.targetNodeId === targetNodeId &&
      edge.targetPort === targetPort,
  )
  if (duplicate) {
    return { ok: false, reason: GRAPH_MUTATION_REJECTION.DUPLICATE_EDGE }
  }

  return { ok: true, target, targetPort, exposedPort }
}

export function connectMacroToParameter(graphState, connectionDraft, options = {}) {
  const check = canConnectMacroToParameter(graphState, connectionDraft)
  if (!check.ok) return check

  const newEdge = {
    id: generateMutationId(options.idFactory),
    sourceNodeId: connectionDraft.sourceNodeId,
    sourcePort: GRAPH_MACRO_OUTPUT_PORT,
    targetNodeId: connectionDraft.targetNodeId,
    targetPort: check.targetPort,
    type: 'parameter',
    targetParameter: check.target,
    mapping: normalizeParameterMapping(connectionDraft.mapping),
  }

  return {
    ok: true,
    edge: newEdge,
    graphState: {
      ...graphState,
      edges: [...graphState.edges, newEdge],
    },
  }
}

export function isParameterEdge(graphState, edgeId) {
  if (!Array.isArray(graphState?.edges)) return false
  return graphState.edges.some((edge) => edge.id === edgeId && edge.type === 'parameter')
}

// Removes a parameter edge specifically. Returns MISSING_EDGE when the id does not
// resolve to a parameter edge (so callers do not accidentally drop an audio edge).
export function disconnectParameterEdge(graphState, edgeId) {
  const editCheck = validateGraphStateForEditing(graphState)
  if (!editCheck.ok) return editCheck

  if (typeof edgeId !== 'string' || edgeId.length === 0) {
    return { ok: false, reason: GRAPH_MUTATION_REJECTION.MISSING_EDGE }
  }
  if (!isParameterEdge(graphState, edgeId)) {
    return { ok: false, reason: GRAPH_MUTATION_REJECTION.MISSING_EDGE }
  }

  return {
    ok: true,
    graphState: {
      ...graphState,
      edges: graphState.edges.filter((edge) => edge.id !== edgeId),
    },
  }
}

// Pure runtime-drive resolver. Given a macro node id and a macro value, returns the
// set of normalized parameter writes its enabled outgoing parameter edges produce.
// Edges that are disabled, malformed, unresolved, or read-only are reported under
// `skipped` instead of throwing. The store turns each write into a FXG.4-a
// setGraphEffectParameterNormalized call.
export function collectMacroParameterWrites(graphState, macroNodeId, macroValue) {
  const writes = []
  const skipped = []

  if (
    !isPlainObject(graphState) ||
    !Array.isArray(graphState.nodes) ||
    !Array.isArray(graphState.edges)
  ) {
    return { writes, skipped }
  }

  const macroNode = graphState.nodes.find((node) => node.id === macroNodeId)
  if (!macroNode || macroNode.type !== GRAPH_MACRO_NODE_TYPE) {
    return { writes, skipped }
  }

  const value = Number.isFinite(macroValue)
    ? macroValue
    : clampMacroNormalizedValue(macroNode.data?.normalizedValue)

  for (const edge of graphState.edges) {
    if (edge.type !== 'parameter') continue
    if (edge.sourceNodeId !== macroNodeId) continue

    const evaluation = evaluateParameterMapping(edge.mapping, value)
    if (!evaluation.enabled) {
      skipped.push({ edgeId: edge.id, reason: 'disabled' })
      continue
    }

    const target = normalizeGraphParameterTarget(edge.targetParameter)
    if (!target) {
      skipped.push({ edgeId: edge.id, reason: 'invalid_target' })
      continue
    }

    const resolution = resolveGraphParameterTarget(graphState, target)
    if (resolution.status !== 'ok') {
      skipped.push({ edgeId: edge.id, reason: resolution.status })
      continue
    }
    if (resolution.exposedPort?.readOnly === true || resolution.exposedPort?.automatable === false) {
      skipped.push({ edgeId: edge.id, reason: 'read_only' })
      continue
    }

    writes.push({
      edgeId: edge.id,
      effectInstanceId: target.effectInstanceId,
      parameterId: target.parameterId,
      value: evaluation.value,
    })
  }

  return { writes, skipped }
}

// ---------------------------------------------------------------------------
// EVC-R1 — Envelope -> Parameter links
//
// An Envelope node is a control source like Macro: its `controlOut` port links to
// an exposed parameter input port on an effect node through a `parameter` edge. The
// edge shape is identical to a Macro -> Parameter edge (GraphParameterTarget + a
// per-link mapping); only the source node type differs. These helpers deliberately
// mirror canConnectMacroToParameter / connectMacroToParameter / collectMacroParameterWrites
// rather than generalizing them, so the established Macro path is never disturbed.
// Disconnect reuses disconnectParameterEdge (source-agnostic). Runtime drive is
// deferred to EVC-R2 — collectEnvelopeParameterWrites exists for that phase + tests
// but is never called from a renderer drive path in EVC-R1.
// ---------------------------------------------------------------------------

export function canConnectEnvelopeToParameter(graphState, connectionDraft) {
  const editCheck = validateGraphStateForEditing(graphState)
  if (!editCheck.ok) return editCheck

  if (!isPlainObject(connectionDraft)) {
    return { ok: false, reason: GRAPH_MUTATION_REJECTION.INVALID_CONNECTION_DRAFT }
  }

  const { sourceNodeId, targetNodeId } = connectionDraft
  const parameterId = typeof connectionDraft.parameterId === 'string'
    ? connectionDraft.parameterId.trim()
    : ''

  const sourceNode = graphState.nodes.find((n) => n.id === sourceNodeId)
  const targetNode = graphState.nodes.find((n) => n.id === targetNodeId)

  if (!sourceNode) return { ok: false, reason: GRAPH_MUTATION_REJECTION.MISSING_SOURCE_NODE }
  if (!targetNode) return { ok: false, reason: GRAPH_MUTATION_REJECTION.MISSING_TARGET_NODE }
  if (sourceNodeId === targetNodeId) return { ok: false, reason: GRAPH_MUTATION_REJECTION.SELF_CONNECTION }

  // Source must be an envelope control node. Effect/macro nodes cannot source an
  // envelope parameter edge.
  if (sourceNode.type !== GRAPH_ENVELOPE_NODE_TYPE) {
    return { ok: false, reason: GRAPH_MUTATION_REJECTION.INVALID_SOURCE_TYPE }
  }
  // Target must be an effect node. Protected Track I/O, macro, and envelope nodes
  // are invalid targets (only effects expose writable parameters).
  if (isProtectedGraphNodeType(targetNode.type)) {
    return { ok: false, reason: GRAPH_MUTATION_REJECTION.PROTECTED_NODE }
  }
  if (targetNode.type !== 'effect') {
    return { ok: false, reason: GRAPH_MUTATION_REJECTION.INVALID_TARGET_TYPE }
  }

  if (!parameterId) {
    return { ok: false, reason: GRAPH_MUTATION_REJECTION.INVALID_PARAMETER_TARGET }
  }

  const effectInstanceId = readEffectInstanceId(targetNode)
  if (!effectInstanceId) {
    return { ok: false, reason: GRAPH_MUTATION_REJECTION.MISSING_EFFECT_INSTANCE }
  }

  const exposedPorts = normalizeExposedParameterPorts(targetNode.data?.exposedParameterPorts)
  const exposedPort = exposedPorts.find((port) => port.parameterId === parameterId)
  if (!exposedPort) {
    return { ok: false, reason: GRAPH_MUTATION_REJECTION.PARAMETER_NOT_EXPOSED }
  }
  // Read-only / non-automatable parameters cannot be driven.
  if (exposedPort.readOnly === true || exposedPort.automatable === false) {
    return { ok: false, reason: GRAPH_MUTATION_REJECTION.PARAMETER_READ_ONLY }
  }

  const target = createGraphParameterTargetFromExposedPort({
    graphNode: targetNode,
    effectInstanceId,
    exposedPort,
  })
  if (!target) {
    return { ok: false, reason: GRAPH_MUTATION_REJECTION.INVALID_PARAMETER_TARGET }
  }

  const targetPort = buildGraphParameterPortId(targetNodeId, parameterId)
  if (!targetPort) {
    return { ok: false, reason: GRAPH_MUTATION_REJECTION.INVALID_PARAMETER_TARGET }
  }

  // Dedupe: one Envelope may only drive a given parameter on a given node once.
  const duplicate = graphState.edges.some(
    (edge) =>
      edge.type === 'parameter' &&
      edge.sourceNodeId === sourceNodeId &&
      edge.targetNodeId === targetNodeId &&
      edge.targetPort === targetPort,
  )
  if (duplicate) {
    return { ok: false, reason: GRAPH_MUTATION_REJECTION.DUPLICATE_EDGE }
  }

  return { ok: true, target, targetPort, exposedPort }
}

export function connectEnvelopeToParameter(graphState, connectionDraft, options = {}) {
  const check = canConnectEnvelopeToParameter(graphState, connectionDraft)
  if (!check.ok) return check

  const newEdge = {
    id: generateMutationId(options.idFactory),
    sourceNodeId: connectionDraft.sourceNodeId,
    sourcePort: GRAPH_ENVELOPE_OUTPUT_PORT,
    targetNodeId: connectionDraft.targetNodeId,
    targetPort: check.targetPort,
    type: 'parameter',
    targetParameter: check.target,
    mapping: normalizeParameterMapping(connectionDraft.mapping),
  }

  return {
    ok: true,
    edge: newEdge,
    graphState: {
      ...graphState,
      edges: [...graphState.edges, newEdge],
    },
  }
}

// Pure resolver for EVC-R2 runtime drive (and tests). Given an envelope node id and
// a normalized envelope output value (0..1), returns the parameter writes its enabled
// outgoing parameter edges produce, mapped through each edge's mapping. Mirrors
// collectMacroParameterWrites; reports disabled/invalid/unresolved/read-only edges
// under `skipped` instead of throwing. EVC-R1 never calls this from a drive path.
export function collectEnvelopeParameterWrites(graphState, envelopeNodeId, envelopeValue) {
  const writes = []
  const skipped = []

  if (
    !isPlainObject(graphState) ||
    !Array.isArray(graphState.nodes) ||
    !Array.isArray(graphState.edges)
  ) {
    return { writes, skipped }
  }

  const envelopeNode = graphState.nodes.find((node) => node.id === envelopeNodeId)
  if (!envelopeNode || envelopeNode.type !== GRAPH_ENVELOPE_NODE_TYPE) {
    return { writes, skipped }
  }

  const value = clampEnvelopeUnit(envelopeValue, 0)

  for (const edge of graphState.edges) {
    if (edge.type !== 'parameter') continue
    if (edge.sourceNodeId !== envelopeNodeId) continue

    const evaluation = evaluateParameterMapping(edge.mapping, value)
    if (!evaluation.enabled) {
      skipped.push({ edgeId: edge.id, reason: 'disabled' })
      continue
    }

    const target = normalizeGraphParameterTarget(edge.targetParameter)
    if (!target) {
      skipped.push({ edgeId: edge.id, reason: 'invalid_target' })
      continue
    }

    const resolution = resolveGraphParameterTarget(graphState, target)
    if (resolution.status !== 'ok') {
      skipped.push({ edgeId: edge.id, reason: resolution.status })
      continue
    }
    if (resolution.exposedPort?.readOnly === true || resolution.exposedPort?.automatable === false) {
      skipped.push({ edgeId: edge.id, reason: 'read_only' })
      continue
    }

    writes.push({
      edgeId: edge.id,
      effectInstanceId: target.effectInstanceId,
      parameterId: target.parameterId,
      value: evaluation.value,
    })
  }

  return { writes, skipped }
}

// FXG.4-g — update a parameter edge's mapping in place.
// Merges mappingPatch into the edge's current mapping and renormalizes. The patch
// may include any subset of { enabled, sourceMin, sourceMax, targetMin, targetMax, curve }.
// Setting curve to { type: 'linear' } resets the curve to linear; setting curve to
// { type: 'bezier', points: [...] } switches to bezier. Malformed bezier patches fall
// back to linear rather than dropping the edge. Returns { ok, graphState } or
// { ok: false, reason }.
export function updateParameterEdgeMapping(graphState, edgeId, mappingPatch) {
  const editCheck = validateGraphStateForEditing(graphState)
  if (!editCheck.ok) return editCheck

  if (typeof edgeId !== 'string' || edgeId.length === 0) {
    return { ok: false, reason: GRAPH_MUTATION_REJECTION.MISSING_EDGE }
  }
  if (!isPlainObject(mappingPatch)) {
    return { ok: false, reason: GRAPH_MUTATION_REJECTION.INVALID_PARAMETER_EDGE }
  }

  const edge = graphState.edges.find((e) => e.id === edgeId)
  if (!edge) return { ok: false, reason: GRAPH_MUTATION_REJECTION.MISSING_EDGE }
  if (edge.type !== 'parameter') return { ok: false, reason: GRAPH_MUTATION_REJECTION.INVALID_PARAMETER_EDGE }

  const currentMapping = isPlainObject(edge.mapping) ? edge.mapping : {}
  const mergedMapping = { ...currentMapping, ...mappingPatch }
  const normalizedMapping = normalizeParameterMapping(mergedMapping)

  return {
    ok: true,
    graphState: {
      ...graphState,
      edges: graphState.edges.map((e) =>
        e.id === edgeId ? { ...e, mapping: normalizedMapping } : e,
      ),
    },
  }
}
