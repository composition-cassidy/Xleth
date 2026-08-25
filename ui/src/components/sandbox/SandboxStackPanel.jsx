import { GripVertical, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import useSandboxStore, {
  RIPPLE_MODE, FADE_SHAPE, findEnvelopeOp, clampGainEnvelopeFollower, GAIN_ENVELOPE_MODE,
  GAIN_ENVELOPE_ATTACK_MS_MIN, GAIN_ENVELOPE_ATTACK_MS_MAX,
  GAIN_ENVELOPE_RELEASE_MS_MIN, GAIN_ENVELOPE_RELEASE_MS_MAX,
} from '../../stores/sandboxStore.js'
import XlethSelect from '../common/XlethSelect.jsx'
import { FADE_SHAPES } from './sandboxToolConstants.js'

const RIPPLE_MODE_NAME = Object.fromEntries(Object.entries(RIPPLE_MODE).map(([k, v]) => [v, k]))
const FADE_SHAPE_NAME = Object.fromEntries(Object.entries(FADE_SHAPE).map(([k, v]) => [v, k]))

// A short human-readable summary of an op's params — shown on every module
// row (selected or not), so the collapsed rail is still scannable.
function describeParams(op) {
  const p = op.params || {}
  switch (op.type) {
    case 'trim':
      return `${p.startSample}–${p.endSample}`
    case 'cut':
      return `${p.startSample}–${p.endSample} (${RIPPLE_MODE_NAME[p.mode] ?? p.mode})`
    case 'paste':
      return p.clipboardId >= 0
        ? `@ ${p.atSample}, ${p.clipboardLengthSamples} smp, ${p.insert ? 'insert' : 'overwrite'}`
        : `@ ${p.atSample}, silence × ${p.clipboardLengthSamples} smp, ${p.insert ? 'insert' : 'overwrite'}`
    case 'splice':
      return `@ ${p.atSample} (${RIPPLE_MODE_NAME[p.mode] ?? p.mode}${p.mode === RIPPLE_MODE.gap ? `, gap ${p.gapSamples}` : ''})`
    case 'reverse':
      return `${p.startSample}–${p.endSample}`
    case 'fade':
      return `${p.fadeIn ? 'in' : 'out'}, ${p.lengthSamples} smp (${FADE_SHAPE_NAME[p.shape] ?? p.shape})`
    case 'gain':
      return p.normalize ? `normalize → ${p.targetPeakDb} dBFS` : `${p.gainDb} dB`
    case 'gainEnvelope': {
      // Breakpoint count plus the range it spans — enough to tell two curves
      // apart in the stack without trying to render a shape in a text row.
      const pts = p.points || []
      const modeLabel = p.mode === 1 ? 'Rel' : 'Abs'
      if (pts.length === 0) return `flat (0 dB, ${modeLabel})`
      const dbs = pts.map((q) => q.db)
      return `${pts.length} pt, ${Math.min(...dbs).toFixed(1)}…${Math.max(...dbs).toFixed(1)} dB (${modeLabel})`
    }
    case 'crossfade':
      return `@ ${p.atSample}, ${p.lengthSamples} smp (${FADE_SHAPE_NAME[p.shape] ?? p.shape})`
    case 'pitch':
      return `${p.cents >= 0 ? '+' : ''}${p.cents}¢${p.formantPreserve ? ', formant lock' : ''}`
    case 'formantShift':
      return `${p.cents >= 0 ? '+' : ''}${p.cents}¢`
    case 'declip':
      return `${p.startSample}–${p.endSample}, thresh ${p.threshold}, max run ${p.maxRunSamples} smp`
    case 'denoise':
      return p.noiseEndSample > p.noiseStartSample
        ? `profile ${p.noiseStartSample}–${p.noiseEndSample}, -${p.reductionDb} dB, ×${p.sensitivity}`
        : 'no profile learned yet'
    default:
      return ''
  }
}

// Inline param editors shown beneath the SELECTED module only. Covers every
// op param this restructuring's spec calls out by name: envelope mode +
// attack/release, pitch, formant, declip threshold, denoise profile, and
// fade curves (FADE + CROSSFADE's shared shape enum). Every other op type
// (trim/cut/paste/splice/reverse/gain) has no persistent knob — it was
// authored by drawing/re-drawing the tool that created it, same as before
// this restructuring, so selecting one just highlights the row.
function InlineOpParamEditor({ op, layerId, setOpParams, hasSelection, onLearnNoiseProfile, setGainEnvelopeFollower }) {
  const p = op.params || {}

  if (op.type === 'pitch') {
    return (
      <div className="sandbox-op-params-row">
        <label>
          Cents
          <input
            type="number" step="10" className="sandbox-toolbar-number"
            defaultValue={p.cents} key={`cents-${op.id}-${p.cents}`}
            onBlur={(e) => setOpParams(layerId, op.id, { ...p, cents: Number(e.target.value) })}
          />
        </label>
        <label className="sandbox-op-checkbox">
          <input
            type="checkbox" checked={!!p.formantPreserve}
            onChange={(e) => setOpParams(layerId, op.id, { ...p, formantPreserve: e.target.checked })}
          />
          Formant Lock
        </label>
      </div>
    )
  }
  if (op.type === 'formantShift') {
    return (
      <div className="sandbox-op-params-row">
        <label>
          Cents
          <input
            type="number" step="10" className="sandbox-toolbar-number"
            defaultValue={p.cents} key={`cents-${op.id}-${p.cents}`}
            onBlur={(e) => setOpParams(layerId, op.id, { ...p, cents: Number(e.target.value) })}
          />
        </label>
      </div>
    )
  }
  if (op.type === 'declip') {
    return (
      <div className="sandbox-op-params-row">
        <label>
          Threshold
          <input
            type="number" step="0.01" min="0.5" max="1" className="sandbox-toolbar-number"
            defaultValue={p.threshold} key={`thresh-${op.id}-${p.threshold}`}
            onBlur={(e) => setOpParams(layerId, op.id, { ...p, threshold: Number(e.target.value) })}
          />
        </label>
        <label>
          Max run (smp)
          <input
            type="number" step="1" min="1" className="sandbox-toolbar-number"
            defaultValue={p.maxRunSamples} key={`run-${op.id}-${p.maxRunSamples}`}
            onBlur={(e) => setOpParams(layerId, op.id, { ...p, maxRunSamples: Number(e.target.value) })}
          />
        </label>
      </div>
    )
  }
  if (op.type === 'denoise') {
    return (
      <div className="sandbox-op-params-row">
        <label>
          Reduction (dB)
          <input
            type="number" step="1" min="0" max="60" className="sandbox-toolbar-number"
            defaultValue={p.reductionDb} key={`red-${op.id}-${p.reductionDb}`}
            onBlur={(e) => setOpParams(layerId, op.id, { ...p, reductionDb: Number(e.target.value) })}
          />
        </label>
        <label>
          Sensitivity
          <input
            type="number" step="0.1" min="0" max="5" className="sandbox-toolbar-number"
            defaultValue={p.sensitivity} key={`sens-${op.id}-${p.sensitivity}`}
            onBlur={(e) => setOpParams(layerId, op.id, { ...p, sensitivity: Number(e.target.value) })}
          />
        </label>
        {/* DENOISE's "select region → Learn Noise Profile" gesture: commits
            whatever is currently selected as THIS op's noise region via the
            same generic setOpParams every other param edit in this file goes
            through, so it is undoable for free. */}
        <button
          className="sandbox-op-learn-noise"
          disabled={!hasSelection}
          onClick={() => onLearnNoiseProfile(layerId, op.id)}
          title={hasSelection
            ? 'Learn a noise profile from the current selection'
            : 'Select a noise-only region first'}
        >
          Learn Noise Profile
        </button>
      </div>
    )
  }
  if (op.type === 'gainEnvelope') {
    const follower = clampGainEnvelopeFollower(p)
    const isRelative = follower.mode === GAIN_ENVELOPE_MODE.relative
    return (
      <div className="sandbox-op-params-row">
        <label>
          Mode
          <select
            className="sandbox-toolbar-select"
            value={isRelative ? 'relative' : 'absolute'}
            onChange={(e) => setGainEnvelopeFollower(layerId, {
              ...follower, mode: e.target.value === 'relative' ? GAIN_ENVELOPE_MODE.relative : GAIN_ENVELOPE_MODE.absolute,
            })}
            title="Mode 1: the drawn curve IS the gain. Mode 2: the drawn curve modulates the material's own detected dynamics."
          >
            <option value="absolute">1 · Absolute</option>
            <option value="relative">2 · Relative</option>
          </select>
        </label>
        <label title={isRelative ? undefined : 'Only used in Relative mode'}>
          Attack (ms)
          <input
            type="number" step="0.5" className="sandbox-toolbar-number"
            min={GAIN_ENVELOPE_ATTACK_MS_MIN} max={GAIN_ENVELOPE_ATTACK_MS_MAX}
            value={follower.followerAttackMs} disabled={!isRelative}
            onChange={(e) => setGainEnvelopeFollower(layerId, { ...follower, followerAttackMs: Number(e.target.value) })}
          />
        </label>
        <label title={isRelative ? undefined : 'Only used in Relative mode'}>
          Release (ms)
          <input
            type="number" step="5" className="sandbox-toolbar-number"
            min={GAIN_ENVELOPE_RELEASE_MS_MIN} max={GAIN_ENVELOPE_RELEASE_MS_MAX}
            value={follower.followerReleaseMs} disabled={!isRelative}
            onChange={(e) => setGainEnvelopeFollower(layerId, { ...follower, followerReleaseMs: Number(e.target.value) })}
          />
        </label>
        <span className="sandbox-op-params-readout">
          {(p.points || []).length} breakpoint{(p.points || []).length === 1 ? '' : 's'} — drawn on the waveform (Envelope tool)
        </span>
      </div>
    )
  }
  if (op.type === 'fade' || op.type === 'crossfade') {
    return (
      <div className="sandbox-op-params-row">
        <label>
          Curve
          <select
            className="sandbox-toolbar-select"
            value={FADE_SHAPE_NAME[p.shape] ?? 'equalPower'}
            onChange={(e) => setOpParams(layerId, op.id, { ...p, shape: FADE_SHAPE[e.target.value] })}
          >
            {FADE_SHAPES.map(({ value, label }) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
      </div>
    )
  }
  return null
}

const HAS_INLINE_PARAMS = new Set(['pitch', 'formantShift', 'declip', 'denoise', 'gainEnvelope', 'fade', 'crossfade'])

function OpModule({
  op, index, layerId, selected, onSelect, onToggleBypass, onRemove, setOpParams, hasSelection,
  onLearnNoiseProfile, setGainEnvelopeFollower,
}) {
  return (
    <div className={`sandbox-op-module${op.enabled ? '' : ' bypassed'}${selected ? ' selected' : ''}`}>
      <div className="sandbox-op-row" onClick={() => onSelect(op.id)}>
        <GripVertical size={12} className="sandbox-op-grip" />
        <span className="sandbox-op-index">{String(index + 1).padStart(2, '0')}</span>
        <div className="sandbox-op-label">
          <span className="sandbox-op-type">{op.type}</span>
          <span className="sandbox-op-params">{describeParams(op)}</span>
        </div>
        <button
          className={`sandbox-op-bypass${op.enabled ? '' : ' active'}`}
          onClick={(e) => { e.stopPropagation(); onToggleBypass(layerId, op.id, op.enabled) }}
          title={op.enabled ? 'Bypass' : 'Enable'}
        >
          {op.enabled ? 'ON' : 'OFF'}
        </button>
        <button
          className="sandbox-op-remove"
          onClick={(e) => { e.stopPropagation(); onRemove(layerId, op.id) }}
          title="Remove operation"
        >
          <Trash2 size={11} />
        </button>
      </div>
      {selected && HAS_INLINE_PARAMS.has(op.type) && (
        <InlineOpParamEditor
          op={op} layerId={layerId} setOpParams={setOpParams}
          hasSelection={hasSelection} onLearnNoiseProfile={onLearnNoiseProfile}
          setGainEnvelopeFollower={setGainEnvelopeFollower}
        />
      )}
    </div>
  )
}

// Shown instead of the SWAP IN button when a layer has no bound target — a
// layer opened over a composite bake, or (before it was fixed) a drag-in
// whose region id never made it through. Lists every project sample region;
// picking one both performs the swap AND binds the session to it (swapInLayer
// records sourceRegionId/swapTargetName on success), so a later plain SWAP IN
// click on this layer goes back to the same target.
function SwapTargetPicker({ layerId, swapInLayer }) {
  const [regions, setRegions] = useState(null) // null = still loading

  useEffect(() => {
    let cancelled = false
    window.xleth?.timeline?.getRegions?.()
      .then((list) => { if (!cancelled) setRegions(Array.isArray(list) ? list : []) })
      .catch(() => { if (!cancelled) setRegions([]) })
    return () => { cancelled = true }
  }, [])

  const options = (regions ?? []).map((r) => ({
    value: r.id,
    label: r.name || `Region ${r.id}`,
    group: r.label || undefined,
  }))

  const handlePick = (regionId) => {
    const region = (regions ?? []).find((r) => r.id === regionId)
    if (!region) return
    swapInLayer(layerId, { regionId: region.id, name: region.name })
  }

  return (
    <XlethSelect
      className="sandbox-swap-target-select"
      value={null}
      options={options}
      onChange={handlePick}
      disabled={regions == null || options.length === 0}
      placeholder={
        regions == null ? 'Loading samples…'
          : options.length === 0 ? 'No project samples yet'
          : 'SWAP IN — pick a sample to replace…'
      }
      ariaLabel="Pick a sample to swap this render into"
    />
  )
}

export default function SandboxStackPanel() {
  const layers = useSandboxStore((s) => s.layers)
  const activeLayerId = useSandboxStore((s) => s.activeLayerId)
  const selection = useSandboxStore((s) => s.selection)
  const setOpBypassed = useSandboxStore((s) => s.setOpBypassed)
  const removeOp = useSandboxStore((s) => s.removeOp)
  const setOpParams = useSandboxStore((s) => s.setOpParams)
  const bakeLayer = useSandboxStore((s) => s.bakeLayer)
  const swapInLayer = useSandboxStore((s) => s.swapInLayer)
  const learnNoiseProfile = useSandboxStore((s) => s.learnNoiseProfile)
  const setGainEnvelope = useSandboxStore((s) => s.setGainEnvelope)
  const setGainEnvelopeFollower = useSandboxStore((s) => s.setGainEnvelopeFollower)
  const spliceAtCursor = useSandboxStore((s) => s.spliceAtCursor)
  const reverseSelection = useSandboxStore((s) => s.reverseSelection)
  const crossfadeAtCursor = useSandboxStore((s) => s.crossfadeAtCursor)
  const insertSilence = useSandboxStore((s) => s.insertSilence)
  const declipSelection = useSandboxStore((s) => s.declipSelection)
  const addDenoise = useSandboxStore((s) => s.addDenoise)
  const setPitch = useSandboxStore((s) => s.setPitch)
  const setFormantShift = useSandboxStore((s) => s.setFormantShift)

  const [selectedOpId, setSelectedOpId] = useState(null)

  const layer = layers.find((l) => l.id === activeLayerId) ?? null
  const hasSelection = !!selection && selection.endSample > selection.startSample
  const cursorSample = selection?.startSample ?? 0

  // Selecting a different layer (or one whose ops changed under it) should
  // not leave a stale expanded panel pointing at an op that may no longer
  // exist on the new layer.
  useEffect(() => { setSelectedOpId(null) }, [activeLayerId])

  const handleToggleBypass = (layerId, opId, enabled) => setOpBypassed(layerId, opId, enabled)
  const handleSelectOp = (opId) => setSelectedOpId((cur) => (cur === opId ? null : opId))

  const canBake = !!layer && layer.renderState === 'ready'
  const bakeLabel = layer?.bakeState === 'baking' ? 'Baking…' : layer?.bakeState === 'baked' ? 'Baked ✓' : 'BAKE'

  const isSwapping = layer?.swapInState === 'swapping'
  const hasSwapTarget = layer?.sourceRegionId != null
  const canSwap = canBake && hasSwapTarget && !isSwapping
  const needsSwapTarget = canBake && !hasSwapTarget && !isSwapping
  const swapLabel =
    layer?.swapInState === 'swapping' ? 'Swapping…'
    : layer?.swapInState === 'swapped' ? 'Swapped ✓'
    : layer?.swapTargetName ? `SWAP IN — replace ${layer.swapTargetName}`
    : 'SWAP IN'
  const swapTitle =
    layer?.swapInState === 'error' ? layer.swapInError
    : !hasSwapTarget ? 'Pick a sample to replace — this layer has no bound target yet'
    : !canBake ? 'Render the layer first'
    : layer?.lastSwap
      ? `Replaced "${layer.swapTargetName ?? 'the region'}" — ${layer.lastSwap.samplers} placed instance(s), `
        + `${layer.lastSwap.clips} clip(s) updated. Undo restores the old one.`
      : `Replace "${layer.swapTargetName}"'s sample with the render — every placed instance follows`

  // "+ ADD OP" — categorized menu (Edit / Dynamics / Restoration / Pitch).
  // Splice/Reverse/Crossfade/Insert Silence always append a new stack entry
  // (same as the old toolbar buttons). The restoration/pitch/dynamics types
  // are add-or-update (findOrAddOp / setGainEnvelope) — once one already
  // exists on the layer, re-adding it would silently reset its params back
  // to defaults, so those entries disable themselves and point at the
  // existing module instead.
  const opTypesPresent = new Set(layer?.ops.map((o) => o.type) ?? [])
  const singleton = (type, label) => ({
    value: type,
    label: opTypesPresent.has(type) ? `${label} (already added)` : label,
    disabled: opTypesPresent.has(type),
  })
  const addOpOptions = [
    { value: 'splice', label: 'Splice', group: 'Edit' },
    { value: 'reverse', label: 'Reverse', group: 'Edit' },
    { value: 'crossfade', label: 'Crossfade', group: 'Edit' },
    { value: 'insertSilence', label: 'Insert Silence', group: 'Edit', disabled: !hasSelection },
    { ...singleton('gainEnvelope', 'Gain Envelope'), group: 'Dynamics' },
    { ...singleton('declip', 'Declip'), group: 'Restoration' },
    { ...singleton('denoise', 'Denoise'), group: 'Restoration' },
    { ...singleton('pitch', 'Pitch Shift'), group: 'Pitch' },
    { ...singleton('formantShift', 'Formant Shift'), group: 'Pitch' },
  ]

  const handleAddOp = (value) => {
    if (!layer) return
    switch (value) {
      case 'splice': spliceAtCursor(layer.id, cursorSample, 'ripple', 0); break
      case 'reverse': reverseSelection(layer.id); break
      case 'crossfade': crossfadeAtCursor(layer.id, cursorSample, 256, 'hann'); break
      case 'insertSilence':
        if (hasSelection) insertSilence(layer.id, selection.startSample, selection.endSample - selection.startSample, true)
        break
      case 'gainEnvelope': setGainEnvelope(layer.id, []); break
      case 'declip': declipSelection(layer.id, 0.98, 64); break
      case 'denoise': addDenoise(layer.id); break
      case 'pitch': setPitch(layer.id, 0, false); break
      case 'formantShift': setFormantShift(layer.id, 0); break
      default: break
    }
  }

  return (
    <div className="sandbox-stack-panel">
      <div className="sandbox-panel-header sandbox-stack-header">
        <span>Op Stack</span>
        {layer && <span className="sandbox-op-count-chip">{layer.ops.length} OP{layer.ops.length === 1 ? '' : 'S'}</span>}
      </div>
      <div className="sandbox-op-list">
        {!layer && <div className="sandbox-empty-hint">No layer selected.</div>}
        {layer && layer.ops.length === 0 && (
          <div className="sandbox-empty-hint">No operations yet.</div>
        )}
        {layer?.ops.map((op, index) => (
          <OpModule
            key={op.id}
            op={op}
            index={index}
            layerId={layer.id}
            selected={op.id === selectedOpId}
            onSelect={handleSelectOp}
            onToggleBypass={handleToggleBypass}
            onRemove={removeOp}
            setOpParams={setOpParams}
            hasSelection={hasSelection}
            onLearnNoiseProfile={learnNoiseProfile}
            setGainEnvelopeFollower={setGainEnvelopeFollower}
          />
        ))}
      </div>
      <div className="sandbox-add-op-row">
        <XlethSelect
          className="sandbox-add-op-select"
          value={null}
          options={layer ? addOpOptions : []}
          onChange={handleAddOp}
          disabled={!layer}
          placeholder="+ ADD OP"
          ariaLabel="Add an operation to the stack"
        />
        <span className="sandbox-add-op-hint">Edit · Dynamics · Restoration · Pitch</span>
      </div>
      <div className="sandbox-stack-actions">
        <button
          className="sandbox-action-btn sandbox-action-btn--bake"
          disabled={!canBake}
          onClick={() => layer && bakeLayer(layer.id)}
          title="Commit the current render as this layer's clean baseline"
        >
          {bakeLabel}
        </button>
        {needsSwapTarget ? (
          <SwapTargetPicker layerId={layer.id} swapInLayer={swapInLayer} />
        ) : (
          <button
            className={`sandbox-action-btn sandbox-action-btn--swap${
              layer?.swapInState === 'error' ? ' sandbox-action-btn--error' : ''}`}
            disabled={!canSwap}
            onClick={() => layer && swapInLayer(layer.id)}
            title={swapTitle}
          >
            {swapLabel}
          </button>
        )}
      </div>
      {layer?.swapInState === 'swapped' && layer.lastSwap && (
        <div className="sandbox-swap-confirmation">
          Swapped into "{layer.swapTargetName ?? 'target'}" — {layer.lastSwap.samplers} sampler
          {layer.lastSwap.samplers === 1 ? '' : 's'}, {layer.lastSwap.clips} clip
          {layer.lastSwap.clips === 1 ? '' : 's'} updated. Undo restores the previous sample.
        </div>
      )}
      {layer?.swapInState === 'error' && layer.swapInError && (
        <div className="sandbox-swap-confirmation sandbox-swap-confirmation--error">
          {layer.swapInError}
        </div>
      )}
    </div>
  )
}
