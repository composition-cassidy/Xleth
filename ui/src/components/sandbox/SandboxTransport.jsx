import {
  Play, Square, Repeat, Crosshair, ZoomIn, ZoomOut, Maximize2, Scan, Check, Plus,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import useSandboxStore, { hasMeaningfulSelection } from '../../stores/sandboxStore.js'
import { Button, IconButton, Select } from '../../ui-kit'
import { DEFAULT_LABELS, loadCustomLabels } from '../../constants/labels.js'
import { formatTime } from './sandboxFormat.js'
import styles from './Sandbox.module.css'

// Bottom transport. Organised around what a transport is actually for: PLAY,
// what it will play, and how the view follows it. Zoom controls live here too
// — they are navigation, not editing, and the tool column is for tools that
// own the pointer.
//
// Swap in and Bake sit on the RIGHT, behind a divider: they act on the active
// layer and commit something outside this panel (a project sample, a baked
// asset), which makes them the two heaviest buttons in the room.
//
// bakedAssets/addBakedAssetAsSource are carried forward unchanged; bakeComposite
// itself still has no UI trigger anywhere in this codebase, so no new button
// was added for it here.
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
  // interleaves categories and defeats the select's group-header rendering.
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
    <Select
      className={styles.swapSelect}
      value={null}
      options={options}
      onChange={handlePick}
      disabled={regions == null || options.length === 0}
      placeholder={
        regions == null ? 'Loading samples…'
          : options.length === 0 ? 'No project samples yet'
          : 'Swap in: pick a sample to replace…'
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
  const baking = layer?.bakeState === 'baking'
  const baked = layer?.bakeState === 'baked'
  const bakeLabel = baking ? 'Baking…' : baked ? 'Baked' : 'Bake layer'

  const isSwapping = layer?.swapInState === 'swapping'
  const swapped = layer?.swapInState === 'swapped'
  const hasSwapTarget = layer?.sourceRegionId != null
  const canSwap = canBake && hasSwapTarget && !isSwapping
  const needsSwapTarget = canBake && !hasSwapTarget && !isSwapping
  const swapLabel =
    isSwapping ? 'Swapping…'
    : swapped ? 'Swapped'
    : layer?.swapTargetName ? `Swap in: replace ${layer.swapTargetName}`
    : 'Swap in'
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

  // The transport says WHAT Space will play, because the rule is not
  // guessable: a real selection plays as a bounded range, otherwise playback
  // runs from the cursor to the end.
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
    <div className={styles.transport} role="toolbar" aria-label="Sandbox transport">
      <IconButton
        label={isPlaying ? 'Stop' : 'Play'}
        pressed={isPlaying}
        disabled={!hasLayers || isQueued}
        onClick={() => toggleCompositePreview()}
        hint={isPlaying ? 'Stop' : 'Play'}
        hintMods={playTitle}
      >
        {isPlaying ? <Square /> : <Play />}
      </IconButton>
      <IconButton label="Loop" pressed={loopPlayback} onClick={() => toggleLoopPlayback()} hint="Loop" hintMods="Loop the played range (L)">
        <Repeat />
      </IconButton>
      <IconButton
        label="Follow playhead"
        pressed={followPlayhead}
        onClick={() => toggleFollowPlayhead()}
        hint="Follow playhead"
        hintMods="Scroll the view to follow the playhead"
      >
        <Crosshair />
      </IconButton>

      <span
        className={styles.range}
        data-selection={rangeIsSelection || undefined}
        title={rangeIsSelection ? 'Space plays the selection' : 'Space plays from the cursor to the end'}
      >
        {rangeIsSelection ? 'Selection' : 'Cursor'} {rangeText}
      </span>

      <div className={styles.divider} />

      <IconButton label="Zoom out" onClick={() => zoomBy(1.6)} hint="Zoom out" hintMods="Minus key"><ZoomOut /></IconButton>
      <IconButton label="Zoom in" onClick={() => zoomBy(1 / 1.6)} hint="Zoom in" hintMods="Plus key"><ZoomIn /></IconButton>
      <IconButton label="Zoom to selection" onClick={() => zoomToSelection()} hint="Zoom to selection" hintMods="Ctrl+E"><Scan /></IconButton>
      <IconButton label="Fit whole layer" onClick={() => zoomToFit()} hint="Fit whole layer" hintMods="Ctrl+F"><Maximize2 /></IconButton>

      <div className={styles.spacer} />

      {needsSwapTarget ? (
        <SwapTargetPicker layerId={layer.id} swapInLayer={swapInLayer} />
      ) : (
        <Button
          variant={layer?.swapInState === 'error' ? 'danger' : 'default'}
          glyph={swapped ? <Check /> : undefined}
          disabled={!canSwap}
          onClick={() => layer && swapInLayer(layer.id)}
          hint={swapLabel}
          hintMods={swapTitle}
        >
          {swapLabel}
        </Button>
      )}
      <Button
        glyph={baked ? <Check /> : undefined}
        disabled={!canBake}
        onClick={() => layer && bakeLayer(layer.id)}
        hint="Bake layer"
        hintMods="Commit the current render as this layer's clean baseline"
      >
        {bakeLabel}
      </Button>
      {layer?.swapInState === 'swapped' && layer.lastSwap && (
        <span className={styles.note}>
          Swapped into "{layer.swapTargetName ?? 'target'}" — {layer.lastSwap.samplers} sampler
          {layer.lastSwap.samplers === 1 ? '' : 's'}, {layer.lastSwap.clips} clip
          {layer.lastSwap.clips === 1 ? '' : 's'} updated. Undo restores the previous sample.
        </span>
      )}
      {layer?.swapInState === 'error' && layer.swapInError && (
        <span className={styles.note} data-tone="error">{layer.swapInError}</span>
      )}
      {bakedAssets.length > 0 && (
        <div className={styles.baked}>
          {bakedAssets.map((a) => (
            <div key={a.sampleId} className={styles.bakedRow}>
              <span className={styles.bakedName} title={a.name}>{a.name}</span>
              <IconButton
                size="sm"
                variant="ghost"
                label={`Add ${a.name} as a source`}
                hint="Add as source"
                hintMods="Add this baked asset back into the workspace as a new source"
                onClick={() => addBakedAssetAsSource(a.sampleId, a.name)}
              >
                <Plus />
              </IconButton>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
