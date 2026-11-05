import {
  Play, Square, Repeat, Crosshair, ZoomIn, ZoomOut, Maximize2, Scan,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import useSandboxStore, { hasMeaningfulSelection } from '../../stores/sandboxStore.js'
import XlethSelect from '../common/XlethSelect.jsx'
import { DEFAULT_LABELS, loadCustomLabels } from '../../constants/labels.js'
import { formatTime } from './sandboxFormat.js'

// Bottom transport. Reorganised (Phase 2/4) around what a transport is
// actually for: PLAY, what it will play, and how the view follows it. Zoom
// controls live here too — they are navigation, not editing, and the tool
// column is for tools that own the pointer.
//
// SWAP IN and BAKE moved to the RIGHT, behind a divider: they act on the
// active layer and commit something outside this panel (a project sample, a
// baked asset), which makes them the two heaviest buttons in the room. They
// used to sit first, where Play belongs.
//
// bakedAssets/addBakedAssetAsSource are carried forward unchanged; bakeComposite
// itself still has no UI trigger anywhere in this codebase (verified — no call
// site existed before this restructure either), so no new button was added for
// it here.
function SwapTargetPicker({ layerId, swapInLayer }) {
  const [regions, setRegions] = useState(null) // null = still loading

  useEffect(() => {
    let cancelled = false
    window.xleth?.timeline?.getRegions?.()
      .then((list) => { if (!cancelled) setRegions(Array.isArray(list) ? list : []) })
      .catch(() => { if (!cancelled) setRegions([]) })
    return () => { cancelled = true }
  }, [])

  // Group order mirrors the SAMPLES tab's own list (SampleSelectorTab):
  // DEFAULT_LABELS first, in their fixed order, then any custom labels —
  // rather than the region list's raw (creation-order) sequence, which
  // interleaves categories and defeats XlethSelect's group-header rendering.
  const labelOrder = useMemo(() => [...DEFAULT_LABELS, ...loadCustomLabels()], [])

  const options = useMemo(() => {
    const sorted = [...(regions ?? [])].sort((a, b) => {
      const ia = labelOrder.indexOf(a.label)
      const ib = labelOrder.indexOf(b.label)
      return (ia === -1 ? labelOrder.length : ia) - (ib === -1 ? labelOrder.length : ib)
    })
    return sorted.map((r) => ({
      value: r.id,
      label: r.name || `Region ${r.id}`,
      group: r.label || 'Custom',
    }))
  }, [regions, labelOrder])

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
  const playback = useSandboxStore((s) => s.playback)
  const toggleCompositePreview = useSandboxStore((s) => s.toggleCompositePreview)
  const loopPlayback = useSandboxStore((s) => s.loopPlayback)
  const toggleLoopPlayback = useSandboxStore((s) => s.toggleLoopPlayback)
  const followPlayhead = useSandboxStore((s) => s.followPlayhead)
  const toggleFollowPlayhead = useSandboxStore((s) => s.toggleFollowPlayhead)
  const selection = useSandboxStore((s) => s.selection)
  const zoomBy = useSandboxStore((s) => s.zoomBy)
  const zoomToFit = useSandboxStore((s) => s.zoomToFit)
  const zoomToSelection = useSandboxStore((s) => s.zoomToSelection)

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
  const isPlaying = playback.state === 'playing'
  const isQueued = playback.state === 'rendering'
  const playClass = isPlaying ? ' playing' : isQueued ? ' queued' : ''

  // The transport says WHAT Space will play, because the rule is not
  // guessable: a real selection plays as a bounded range, otherwise playback
  // runs from the cursor to the end. Before this readout the same keypress
  // did two visibly different things with no explanation.
  const sampleRate = layer?.renderedBuffer?.sampleRate
  const rangeIsSelection = hasMeaningfulSelection(selection, sampleRate)
  const playFrom = (selection?.startSample ?? 0)
  const playTo = rangeIsSelection ? selection.endSample : (layer?.renderedBuffer?.numSamples ?? 0)
  const rangeText = sampleRate
    ? `${formatTime(playFrom / sampleRate)} → ${formatTime(playTo / sampleRate)}`
    : '—'
  const playTitle = isPlaying
    ? 'Stop (Space)'
    : rangeIsSelection
      ? 'Play the selection (Space) — renders the composite first if needed'
      : 'Play from the cursor (Space) — renders the composite first if needed'

  return (
    <div className="sandbox-transport">
      <button
        className={`sandbox-tbtn sandbox-tbtn--primary${playClass}`}
        disabled={!hasLayers || isQueued}
        onClick={() => toggleCompositePreview()}
        title={playTitle}
      >
        {isPlaying ? <Square size={14} /> : <Play size={14} />}
      </button>
      <button
        className={`sandbox-tbtn sandbox-tbtn--icon${loopPlayback ? ' active' : ''}`}
        onClick={() => toggleLoopPlayback()}
        title="Loop the played range (L)"
      ><Repeat size={13} /></button>
      <button
        className={`sandbox-tbtn sandbox-tbtn--icon${followPlayhead ? ' active' : ''}`}
        onClick={() => toggleFollowPlayhead()}
        title="Scroll the view to follow the playhead"
      ><Crosshair size={13} /></button>

      <span className={`sandbox-transport-range${rangeIsSelection ? ' selection' : ''}`} title={
        rangeIsSelection ? 'Space plays the selection' : 'Space plays from the cursor to the end'
      }>
        {rangeIsSelection ? 'SEL' : 'CUR'} {rangeText}
      </span>

      <div className="sandbox-transport-divider" />

      <button className="sandbox-tbtn sandbox-tbtn--icon" onClick={() => zoomBy(1.6)} title="Zoom out (−)">
        <ZoomOut size={13} />
      </button>
      <button className="sandbox-tbtn sandbox-tbtn--icon" onClick={() => zoomBy(1 / 1.6)} title="Zoom in (+)">
        <ZoomIn size={13} />
      </button>
      <button
        className="sandbox-tbtn sandbox-tbtn--icon"
        onClick={() => zoomToSelection()}
        title="Zoom to selection (Ctrl+E)"
      ><Scan size={13} /></button>
      <button className="sandbox-tbtn sandbox-tbtn--icon" onClick={() => zoomToFit()} title="Fit whole layer (Ctrl+F)">
        <Maximize2 size={13} />
      </button>

      <div className="sandbox-transport-spacer" />

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
