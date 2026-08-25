import { GripVertical, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import useSandboxStore, { RIPPLE_MODE, FADE_SHAPE } from '../../stores/sandboxStore.js'
import XlethSelect from '../common/XlethSelect.jsx'

const RIPPLE_MODE_NAME = Object.fromEntries(Object.entries(RIPPLE_MODE).map(([k, v]) => [v, k]))
const FADE_SHAPE_NAME = Object.fromEntries(Object.entries(FADE_SHAPE).map(([k, v]) => [v, k]))

// A short human-readable summary of an op's params — "stack shows the new op
// with its params" without needing a full param-editor panel per op type.
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

// Inline param editors for the restoration/pitch trio (plus PITCH itself,
// which had none before it had real DSP). Every other op type is edited by
// re-drawing the tool that created it (a Trim re-selection, a new Gain drag,
// etc.) — these four are the ones where "adjustable" means a persistent knob
// on the op itself, since there is no equivalent re-draw gesture for "how
// many cents" or "which threshold". Committed on blur/change via the same
// generic setOpParams every other param edit in this file goes through, so
// each edit is its own undo step, same contract as the toolbar's number
// inputs.
function RestorationParamEditor({ op, layerId, setOpParams, hasSelection, onLearnNoiseProfile }) {
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
            same generic setOpParams, so it is undoable for free. */}
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
  return null
}

const RESTORATION_OP_TYPES = new Set(['pitch', 'formantShift', 'declip', 'denoise'])

function OpRow({ op, layerId, onToggleBypass, onRemove, setOpParams, hasSelection, onLearnNoiseProfile }) {
  return (
    <div className={`sandbox-op-row-group${op.enabled ? '' : ' bypassed'}`}>
      <div className="sandbox-op-row">
        <GripVertical size={12} className="sandbox-op-grip" />
        <div className="sandbox-op-label">
          <span className="sandbox-op-type">{op.type}</span>
          <span className="sandbox-op-params">{describeParams(op)}</span>
        </div>
        <button
          className={`sandbox-op-bypass${op.enabled ? '' : ' active'}`}
          onClick={() => onToggleBypass(layerId, op.id, op.enabled)}
          title={op.enabled ? 'Bypass' : 'Enable'}
        >
          {op.enabled ? 'ON' : 'OFF'}
        </button>
        <button
          className="sandbox-op-remove"
          onClick={() => onRemove(layerId, op.id)}
          title="Remove operation"
        >
          <Trash2 size={11} />
        </button>
      </div>
      {RESTORATION_OP_TYPES.has(op.type) && (
        <RestorationParamEditor
          op={op} layerId={layerId} setOpParams={setOpParams}
          hasSelection={hasSelection} onLearnNoiseProfile={onLearnNoiseProfile}
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
  const layer = layers.find((l) => l.id === activeLayerId) ?? null
  const hasSelection = !!selection && selection.endSample > selection.startSample

  const handleToggleBypass = (layerId, opId, enabled) => setOpBypassed(layerId, opId, enabled)

  const canBake = !!layer && layer.renderState === 'ready'
  const bakeLabel = layer?.bakeState === 'baking' ? 'Baking…' : layer?.bakeState === 'baked' ? 'Baked ✓' : 'BAKE'

  // SWAP IN needs a finished render AND a project region to put it back into.
  // A layer opened from a composite bake — or, before the drag-in id bug was
  // fixed, one dropped in from the Sample Selector — has no bound region: the
  // button becomes a target picker instead of just refusing (see
  // SwapTargetPicker below).
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

  return (
    <div className="sandbox-stack-panel">
      <div className="sandbox-panel-header">Op Stack</div>
      <div className="sandbox-op-list">
        {!layer && <div className="sandbox-empty-hint">No layer selected.</div>}
        {layer && layer.ops.length === 0 && (
          <div className="sandbox-empty-hint">No operations yet.</div>
        )}
        {layer?.ops.map((op) => (
          <OpRow
            key={op.id}
            op={op}
            layerId={layer.id}
            onToggleBypass={handleToggleBypass}
            onRemove={removeOp}
            setOpParams={setOpParams}
            hasSelection={hasSelection}
            onLearnNoiseProfile={learnNoiseProfile}
          />
        ))}
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
