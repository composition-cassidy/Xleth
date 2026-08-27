import { Play, Square } from 'lucide-react'
import { useEffect, useState } from 'react'
import useSandboxStore from '../../stores/sandboxStore.js'
import XlethSelect from '../common/XlethSelect.jsx'

// Bottom transport (mockup: SWAP IN ▾ · BAKE · PLAY). SWAP IN and BAKE act on
// the ACTIVE layer — swapInLayer/bakeLayer are inherently per-layer (a
// layer's own sourceRegionId), there is no composite-level swap. PLAY is the
// one composite-level control that already exists (toggleCompositePreview) —
// see the plan's "Transport BAKE / SWAP IN target" conflict for why these
// three don't all operate at the same "level".
//
// bakedAssets/addBakedAssetAsSource are carried forward unchanged from the
// old Composite section; bakeComposite itself has never had a UI trigger
// anywhere in this codebase (verified — no call site existed before this
// restructure either), so no new button was added for it here, keeping this
// restructure from quietly turning a previously-unreachable action into a
// new feature.
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

export default function SandboxTransport() {
  const layers = useSandboxStore((s) => s.layers)
  const activeLayerId = useSandboxStore((s) => s.activeLayerId)
  const bakeLayer = useSandboxStore((s) => s.bakeLayer)
  const swapInLayer = useSandboxStore((s) => s.swapInLayer)
  const bakedAssets = useSandboxStore((s) => s.bakedAssets)
  const addBakedAssetAsSource = useSandboxStore((s) => s.addBakedAssetAsSource)
  const compositePreviewState = useSandboxStore((s) => s.compositePreviewState)
  const toggleCompositePreview = useSandboxStore((s) => s.toggleCompositePreview)

  const layer = layers.find((l) => l.id === activeLayerId) ?? null

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

  const hasLayers = layers.length > 0
  const isPlaying = compositePreviewState === 'playing'
  const isQueued = compositePreviewState === 'rendering'
  const playClass = isPlaying ? ' playing' : isQueued ? ' queued' : ''
  const playTitle = isPlaying ? 'Stop preview (Space)' : 'Preview the composite (Space) — renders it first if needed'

  return (
    <div className="sandbox-transport">
      {needsSwapTarget ? (
        <SwapTargetPicker layerId={layer.id} swapInLayer={swapInLayer} />
      ) : (
        <button
          className={`sandbox-tbtn${layer?.swapInState === 'error' ? ' sandbox-tbtn--error' : ''}`}
          disabled={!canSwap}
          onClick={() => layer && swapInLayer(layer.id)}
          title={swapTitle}
        >
          {swapLabel}
        </button>
      )}
      <button
        className="sandbox-tbtn"
        disabled={!canBake}
        onClick={() => layer && bakeLayer(layer.id)}
        title="Commit the current render as this layer's clean baseline"
      >
        {bakeLabel}
      </button>
      <button
        className={`sandbox-tbtn sandbox-tbtn--primary${playClass}`}
        disabled={!hasLayers || compositePreviewState === 'rendering'}
        onClick={() => toggleCompositePreview()}
        title={playTitle}
      >
        {isPlaying ? <Square size={14} /> : <Play size={14} />}
      </button>
      {layer?.swapInState === 'swapped' && layer.lastSwap && (
        <span className="sandbox-swap-confirmation">
          Swapped into "{layer.swapTargetName ?? 'target'}" — {layer.lastSwap.samplers} sampler
          {layer.lastSwap.samplers === 1 ? '' : 's'}, {layer.lastSwap.clips} clip
          {layer.lastSwap.clips === 1 ? '' : 's'} updated. Undo restores the previous sample.
        </span>
      )}
      {layer?.swapInState === 'error' && layer.swapInError && (
        <span className="sandbox-swap-confirmation sandbox-swap-confirmation--error">{layer.swapInError}</span>
      )}
      {bakedAssets.length > 0 && (
        <div className="sandbox-baked-asset-list">
          {bakedAssets.map((a) => (
            <div key={a.sampleId} className="sandbox-baked-asset-row">
              <span className="sandbox-baked-asset-name" title={a.name}>{a.name}</span>
              <button
                className="sandbox-mini-btn"
                onClick={() => addBakedAssetAsSource(a.sampleId, a.name)}
                title="Add this baked asset back into the workspace as a new source"
              >+</button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
