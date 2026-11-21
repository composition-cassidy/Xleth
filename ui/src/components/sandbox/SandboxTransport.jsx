import { useEffect, useMemo, useRef, useState } from 'react'
import useSandboxStore, { hasMeaningfulSelection } from '../../stores/sandboxStore.js'
import { Button, IconButton, NumberBox, Select, ToolbarSeparator } from '../../ui-kit'
import { DEFAULT_LABELS, loadCustomLabels } from '../../constants/labels.js'
import { formatClock, formatTime, parseTime } from './sandboxFormat.js'
import { getSandboxPreviewPosition } from './sandboxPreviewPlayer.js'
import styles from './Sandbox.module.css'
import { iconComponent } from '../../ui-kit/icons'

const IcCheckFill = iconComponent('check', 'fill')
const IcCrosshair = iconComponent('crosshair')
const IcPlay = iconComponent('play')
const IcPlus = iconComponent('plus')
const IcRepeat = iconComponent('repeat')
const IcStopFill = iconComponent('stop', 'fill')

// ── Transport ───────────────────────────────────────────────────────────────
//
// Under the display, left to right in the order a pass through the panel goes:
// LISTEN (play, loop, follow, and the position), WHERE (the selection as three
// numbers you can drag or type), and SEND (swap the result into the project,
// or bake it). Zoom moved up beside the view switch — it changes the display,
// not the playback.
//
// The selection used to be read-only text in two places (here and in the
// status bar). It is three NumberBoxes now, so an edit can be placed by typing
// "0.250" as well as by dragging on the waveform.
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

// The position, as a clock. Stopped, it is the cursor (where Play starts and
// Paste lands). Playing, it follows the playhead — read from the AudioContext
// clock in a rAF loop and written straight to the node, never through the
// store: a store write per frame would re-render the whole panel (the waveform
// playhead loop makes the same choice for the same reason).
function PositionClock({ cursorSample, sampleRate, playing, offsetSamples }) {
  const valueRef = useRef(null)
  const stopped = sampleRate ? formatClock(cursorSample / sampleRate) : formatClock(null)

  useEffect(() => {
    const node = valueRef.current
    if (!playing || !sampleRate || !node) return undefined
    let raf = 0
    const tick = () => {
      raf = requestAnimationFrame(tick)
      const pos = getSandboxPreviewPosition()
      if (pos != null) node.textContent = formatClock(Math.max(0, pos - offsetSamples) / sampleRate)
    }
    raf = requestAnimationFrame(tick)
    // Hand the node back to React's own text when the loop ends.
    return () => { cancelAnimationFrame(raf); node.textContent = stopped }
  }, [playing, sampleRate, offsetSamples, stopped])

  return (
    <div
      className={styles.clock}
      data-playing={playing || undefined}
      data-hint={playing ? 'Playhead position' : 'Cursor position'}
      data-hint-mods="Minutes, seconds and milliseconds. Home and End move the cursor to the ends of the layer"
    >
      <span className={styles.clockLabel}>{playing ? 'Playing' : 'Cursor'}</span>
      <span className={styles.clockValue} ref={valueRef}>{stopped}</span>
    </div>
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
  const setSelection = useSandboxStore((s) => s.setSelection)

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

  // What Space will play is not guessable, so the Play hint says it: a real
  // selection plays as a bounded range, otherwise playback runs from the
  // cursor to the end.
  const sampleRate = layer?.renderedBuffer?.sampleRate
  const numSamples = layer?.renderedBuffer?.numSamples ?? 0
  const ready = canBake && !!sampleRate && numSamples > 0
  const rangeIsSelection = hasMeaningfulSelection(selection, sampleRate)
  const playHint = isPlaying
    ? 'Stop (Space)'
    : rangeIsSelection
      ? 'Play the selection in the mix (Space). Shift+Space plays the active layer alone'
      : 'Play the mix from the cursor (Space). Shift+Space plays the active layer alone'

  // ── The selection, as numbers ───────────────────────────────────────────
  // Seconds in the active layer's own timeline. A bare cursor is a zero-width
  // selection (start == end), so the three boxes always have something to
  // show, and dragging End away from Start is how a cursor becomes a range.
  const total = ready ? numSamples / sampleRate : 0
  const startSample = Math.max(0, Math.min(numSamples, selection?.startSample ?? 0))
  const endSample = Math.max(startSample, Math.min(numSamples, selection?.endSample ?? startSample))
  const toSample = (sec) => Math.max(0, Math.min(numSamples, Math.round(sec * sampleRate)))
  const setStart = (sec) => {
    const s = Math.min(toSample(sec), endSample)
    setSelection({ startSample: s, endSample })
  }
  const setEnd = (sec) => {
    const e = Math.max(toSample(sec), startSample)
    setSelection({ startSample, endSample: e })
  }
  const setLength = (sec) => {
    setSelection({ startSample, endSample: Math.max(startSample, toSample(startSample / sampleRate + sec)) })
  }
  const timeBox = {
    width: 116, min: 0, max: Math.max(total, 0.001), step: 0.001, disabled: !ready,
    format: (v) => `${formatTime(v)} s`, parse: parseTime, defaultValue: 0,
  }

  // The playhead clock needs the layer's offset for a mix play, exactly as the
  // waveform playhead does: a mix position is in the mix's timeline.
  const clockPlaying = isPlaying && (playback.kind === 'composite' || playback.layerId === layer?.id)
  const clockOffset = playback.kind === 'composite' ? (layer?.offsetSamples ?? 0) : 0

  return (
    <div className={styles.transport} role="toolbar" aria-label="Transport">
      <div className={styles.transportGroup}>
        <IconButton
          label={isPlaying ? 'Stop' : 'Play'}
          pressed={isPlaying}
          disabled={!hasLayers || isQueued}
          onClick={() => toggleCompositePreview()}
          hint={isPlaying ? 'Stop' : 'Play'}
          hintMods={playHint}
        >
          {isPlaying ? <IcStopFill /> : <IcPlay />}
        </IconButton>
        <IconButton label="Loop" pressed={loopPlayback} onClick={() => toggleLoopPlayback()} hint="Loop" hintMods="Repeat the played range (L)">
          <IcRepeat />
        </IconButton>
        <IconButton
          label="Follow playhead"
          pressed={followPlayhead}
          onClick={() => toggleFollowPlayhead()}
          hint="Follow playhead"
          hintMods="Scroll a zoomed-in view to keep the playhead on screen"
        >
          <IcCrosshair />
        </IconButton>
        <PositionClock
          cursorSample={startSample}
          sampleRate={ready ? sampleRate : null}
          playing={clockPlaying}
          offsetSamples={clockOffset}
        />
      </div>

      <ToolbarSeparator />

      <div className={styles.transportGroup} role="group" aria-label="Selection">
        <NumberBox
          {...timeBox} label="Selection start" caption="Start" value={startSample / (sampleRate || 1)}
          hint="Selection start" onChange={setStart}
        />
        <NumberBox
          {...timeBox} label="Selection end" caption="End" value={endSample / (sampleRate || 1)}
          hint="Selection end" onChange={setEnd}
        />
        <NumberBox
          {...timeBox} label="Selection length" caption="Length" value={(endSample - startSample) / (sampleRate || 1)}
          hint="Selection length" onChange={setLength}
        />
      </div>

      <div className={styles.spacer} />

      <div className={styles.transportGroup}>
        {needsSwapTarget ? (
          <SwapTargetPicker layerId={layer.id} swapInLayer={swapInLayer} />
        ) : (
          <Button
            variant={layer?.swapInState === 'error' ? 'danger' : 'primary'}
            glyph={swapped ? <IcCheckFill /> : undefined}
            disabled={!canSwap}
            onClick={() => layer && swapInLayer(layer.id)}
            hint={swapLabel}
            hintMods={swapTitle}
          >
            {swapLabel}
          </Button>
        )}
        <Button
          glyph={baked ? <IcCheckFill /> : undefined}
          disabled={!canBake}
          onClick={() => layer && bakeLayer(layer.id)}
          hint="Bake layer"
          hintMods="Commit the current render as this layer's clean baseline"
        >
          {bakeLabel}
        </Button>
      </div>

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
                <IcPlus />
              </IconButton>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
