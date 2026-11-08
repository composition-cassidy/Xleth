import { Copy, Play, Plus, Square, X } from 'lucide-react'
import { useState, useCallback } from 'react'
import useSandboxStore from '../../stores/sandboxStore.js'
import SandboxWaveformCanvas from './SandboxWaveformCanvas.jsx'
import SandboxSpcSelectionActionBar from './SandboxSpcSelectionActionBar.jsx'
import { IconButton, MINUS, NumberBox, Toggle } from '../../ui-kit'
import SandboxRenderChip from './SandboxRenderChip.jsx'
import styles from './Sandbox.module.css'
import { formatSamplesShort } from './sandboxFormat.js'

// ── Layer rail + one editor (Phase 4 restructure) ───────────────────────────
//
// This was N stacked full-size cards, only one of which was ever interactive:
// the active card hosted the real canvas at a 340px minimum, every other card
// showed a 220×32 thumbnail floating in a card-width slot, and reaching the
// layer you wanted to edit meant scrolling past that dead space. With three
// layers open the thing you were actually working on was rarely on screen
// whole.
//
// Now: a compact rail of one-line rows (the whole list visible at once), and
// ONE editor pane that fills everything left over. That is also what the
// singular-state design was already assuming — selection, view, envelope and
// paint modes have always been global-to-the-active-layer, never per-card, so
// the second, third and fourth canvases were never editors in the first place.
//
// The mix controls live in the row as kit NumberBoxes: drag to scrub, type a value, Shift for fine. Each previews
// locally during a drag and commits once on release.

const DROPPABLE_AUDIO_EXT = /\.(wav|mp3|flac|aiff?|ogg|m4a|wma|opus)$/i

const RENDER_STATE_LABEL = {
  idle: 'Idle', rendering: 'Rendering…', ready: 'Ready', error: 'Render failed',
}

const pan2 = (v) => v.toFixed(2).replace('-', MINUS)

function offsetMs(layer) {
  return layer.bufferSampleRate ? (layer.offsetSamples / layer.bufferSampleRate) * 1000 : 0
}

function layerDuration(layer) {
  if (layer.renderedBuffer?.numSamples && layer.renderedBuffer.sampleRate) {
    return formatSamplesShort(layer.renderedBuffer.numSamples, layer.renderedBuffer.sampleRate)
  }
  if (layer.sourceStartTime != null && layer.sourceEndTime != null) {
    return `${(layer.sourceEndTime - layer.sourceStartTime).toFixed(2)}s`
  }
  return '—'
}

// One line per layer. Everything that was spread across a card head and a
// 128px control strip, in a row you can scan a stack of.
function LayerRow({
  layer, active, playing, onSelect, onClose, onDuplicate, onToggleMute, onToggleSolo,
  onSetMix, onAudition,
}) {
  const ready = layer.renderState === 'ready'
  const opsLabel = `${layer.ops.length} op${layer.ops.length === 1 ? '' : 's'}`

  return (
    <div
      className={styles.layerRow}
      data-layer-row
      data-active={active || undefined}
      data-muted={layer.muted || undefined}
      onClick={() => onSelect(layer.id)}
      title={layer.renderState === 'error' ? (layer.error || 'Render failed') : layer.name}
    >
      <IconButton
        size="sm"
        label="Audition this layer alone"
        pressed={playing}
        disabled={!ready}
        hint="Audition this layer alone"
        hintMods="Shift+Space plays its own render, no composite mix"
        onClick={(e) => { e.stopPropagation(); onAudition(layer.id) }}
      >
        {playing ? <Square /> : <Play />}
      </IconButton>

      <SandboxRenderChip state={layer.renderState} title={RENDER_STATE_LABEL[layer.renderState] ?? layer.renderState}>
        {ready ? null : (RENDER_STATE_LABEL[layer.renderState] ?? layer.renderState)}
      </SandboxRenderChip>

      <span className={styles.layerName}>{layer.name}</span>
      <span className={styles.layerMeta}>{layerDuration(layer)} · {opsLabel}</span>

      <div className={styles.layerMix} onClick={(e) => e.stopPropagation()}>
        <Toggle size="sm" on={!!layer.muted} aria-label="Mute" hint="Mute" onChange={() => onToggleMute(layer.id)}>M</Toggle>
        <Toggle size="sm" on={!!layer.soloed} aria-label="Solo" hint="Solo" onChange={() => onToggleSolo(layer.id)}>S</Toggle>
        <NumberBox
          label="Layer gain" hideLabel width={72} min={-60} max={12} step={0.25} unit="dB" defaultValue={0}
          value={layer.gainDb ?? 0}
          onCommit={(v) => onSetMix(layer.id, { gainDb: v })}
        />
        <NumberBox
          label="Layer pan" caption="Pan" width={72} min={-1} max={1} step={0.01} bipolar centre={0} defaultValue={0}
          format={pan2}
          value={layer.pan ?? 0}
          onCommit={(v) => onSetMix(layer.id, { pan: v })}
        />
        <NumberBox
          label="Layer offset" hideLabel width={72} min={0} max={60000} step={1} unit="ms" defaultValue={0}
          quantize={Math.round}
          value={offsetMs(layer)}
          onCommit={(v) => onSetMix(layer.id, { offsetMs: v })}
        />
      </div>

      <IconButton
        size="sm" variant="ghost" label="Duplicate this layer"
        hint="Duplicate this layer"
        hintMods={`Duplicate with its ${opsLabel} and mix settings (Ctrl+D)`}
        onClick={(e) => { e.stopPropagation(); onDuplicate(layer.id) }}
      >
        <Copy />
      </IconButton>
      <IconButton
        size="sm" variant="ghost" label="Close layer" hint="Close layer"
        onClick={(e) => { e.stopPropagation(); onClose(layer.id) }}
      >
        <X />
      </IconButton>
    </div>
  )
}

export default function SandboxLayerWorkspace() {
  const layers = useSandboxStore((s) => s.layers)
  const activeLayerId = useSandboxStore((s) => s.activeLayerId)
  const setActiveLayer = useSandboxStore((s) => s.setActiveLayer)
  const closeLayer = useSandboxStore((s) => s.closeLayer)
  const duplicateLayer = useSandboxStore((s) => s.duplicateLayer)
  const toggleMute = useSandboxStore((s) => s.toggleMute)
  const toggleSolo = useSandboxStore((s) => s.toggleSolo)
  const setLayerMix = useSandboxStore((s) => s.setLayerMix)
  const addSourceFromRegion = useSandboxStore((s) => s.addSourceFromRegion)
  // Shared with the separation strip — a stem and a dropped file enter the
  // workspace through the same door. See sandboxStore.addSourceFromFile.
  const addSourceFromFile = useSandboxStore((s) => s.addSourceFromFile)
  const toggleLayerPreview = useSandboxStore((s) => s.toggleLayerPreview)
  const playback = useSandboxStore((s) => s.playback)
  const viewMode = useSandboxStore((s) => s.viewMode)
  const spcSelection = useSandboxStore((s) => s.spcSelection)

  const [dragOver, setDragOver] = useState(false)

  const activeLayer = layers.find((l) => l.id === activeLayerId) ?? null
  const hasSpcSelection = !!activeLayer && activeLayer.renderState === 'ready'
    && viewMode === 'spc' && !!spcSelection?.shapes?.length

  const handleDragOver = useCallback((e) => {
    const types = Array.from(e.dataTransfer.types || [])
    if (!types.includes('application/xleth-sample') && !types.includes('Files')) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    setDragOver(true)
  }, [])

  const handleDragLeave = useCallback(() => setDragOver(false), [])

  const handleDrop = useCallback((e) => {
    e.preventDefault()
    setDragOver(false)

    const raw = e.dataTransfer.getData('application/xleth-sample')
    if (raw) {
      try {
        const dropped = JSON.parse(raw)
        // Drag payloads (SampleRow/SampleThumbnail) key the region id as
        // `regionId`; addSourceFromRegion expects `id` (the shape the
        // context-menu "Open in Sample Sandbox" entry point already passes).
        const region = { ...dropped, id: dropped.regionId ?? dropped.id }
        addSourceFromRegion(region)
      } catch (err) {
        console.warn('[SampleSandbox] Bad drop payload:', err?.message || err)
      }
      return
    }

    const files = Array.from(e.dataTransfer.files || [])
    if (files.length === 0) return
    // Electron 41+ removed File.path; use webUtils via the preload bridge
    // (same fallback chain as ImportDropZone.jsx).
    const getPath = (f) => window.xleth?.getDroppedFilePath?.(f) || f.path || f.name
    const audioFiles = files.filter((f) => DROPPABLE_AUDIO_EXT.test(f.name))
    if (audioFiles.length === 0) {
      console.log('[SampleSandbox] Drop ignored — no supported audio files')
      return
    }
    for (const f of audioFiles) {
      const path = getPath(f)
      if (path) addSourceFromFile(path, f.name.replace(/\.[^.]+$/, ''))
    }
  }, [addSourceFromRegion, addSourceFromFile])

  const auditioning = (id) => playback.state === 'playing'
    && playback.kind === 'layer' && playback.layerId === id

  return (
    <div
      className={styles.workspace}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {layers.length > 0 && (
        <div className={styles.rail}>
          {layers.map((layer) => (
            <LayerRow
              key={layer.id}
              layer={layer}
              active={layer.id === activeLayerId}
              playing={auditioning(layer.id)}
              onSelect={setActiveLayer}
              onClose={closeLayer}
              onDuplicate={duplicateLayer}
              onToggleMute={toggleMute}
              onToggleSolo={toggleSolo}
              onSetMix={setLayerMix}
              onAudition={toggleLayerPreview}
            />
          ))}
          <div className={styles.railHint}>
            <Plus size={12} aria-hidden="true" /> Drop a sample or audio file anywhere here to add a layer
          </div>
        </div>
      )}

      {/* The editor. One canvas, filling everything the rail leaves — which is
          the whole point of the restructure. */}
      <div className={styles.editorPane}>
        {activeLayer ? (
          <>
            <SandboxWaveformCanvas />
            {hasSpcSelection && <SandboxSpcSelectionActionBar />}
          </>
        ) : (
          <div className={styles.dropZone} data-over={dragOver || undefined}>
            <Plus size={20} aria-hidden="true" />
            <span>Drag a sample or audio file here to begin</span>
            <span className={styles.dropHint}>
              …or right-click a marked region in the timeline and choose “Open in Sample Sandbox”
            </span>
          </div>
        )}
        {dragOver && activeLayer && <div className={styles.dropOverlay}>Drop to add a layer</div>}
      </div>
    </div>
  )
}
