import { Copy, Play, Plus, Square, X } from 'lucide-react'
import { useState, useCallback } from 'react'
import useSandboxStore from '../../stores/sandboxStore.js'
import SandboxWaveformCanvas from './SandboxWaveformCanvas.jsx'
import SandboxSpcSelectionActionBar from './SandboxSpcSelectionActionBar.jsx'
import DragNumberField from '../grid/zprTimeline/DragNumberField.jsx'
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
// The mix controls moved into the row as drag-scrub fields. Reusing the ZPR
// inspector's DragNumberField rather than writing a second one: it already
// implements the drag-to-scrub / click-to-type / Shift-fine contract, its
// styles live in the global app.css, and a panel-local copy would be a second
// thing to keep in step. It is not moved into components/common here —
// relocating it would touch ZPR's own imports for no benefit to this change.

const DROPPABLE_AUDIO_EXT = /\.(wav|mp3|flac|aiff?|ogg|m4a|wma|opus)$/i

const RENDER_STATE_LABEL = {
  idle: 'Idle', rendering: 'Rendering…', ready: 'Ready', error: 'Render failed',
}

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
  // Mix edits preview locally during the drag and commit once on release —
  // setLayerMix is a bridge round-trip plus a composite re-render schedule, so
  // a call per pointer frame would queue a render per frame.
  const [live, setLive] = useState(null) // { gainDb?, pan?, offsetMs? } while dragging

  const gainDb = live?.gainDb ?? layer.gainDb ?? 0
  const pan = live?.pan ?? layer.pan ?? 0
  const offMs = live?.offsetMs ?? offsetMs(layer)
  const commit = (patch) => { setLive(null); onSetMix(layer.id, patch) }

  const ready = layer.renderState === 'ready'

  return (
    <div
      className={`sandbox-layer-row${active ? ' active' : ''}${layer.soloed ? ' soloed' : ''}${layer.muted ? ' muted' : ''}`}
      onClick={() => onSelect(layer.id)}
      title={layer.renderState === 'error' ? (layer.error || 'Render failed') : layer.name}
    >
      <button
        className={`sandbox-row-btn sandbox-row-btn--play${playing ? ' active' : ''}`}
        disabled={!ready}
        onClick={(e) => { e.stopPropagation(); onAudition(layer.id) }}
        title="Audition this layer alone (Shift+Space) — plays its own render, no composite mix"
      >{playing ? <Square size={10} /> : <Play size={10} />}</button>

      <span className={`sandbox-render-chip-dot sandbox-render-chip--${layer.renderState}`}
        title={RENDER_STATE_LABEL[layer.renderState] ?? layer.renderState} />

      <span className="sandbox-layer-row-name">{layer.name}</span>
      <span className="sandbox-layer-row-meta">
        {layerDuration(layer)} · {layer.ops.length} op{layer.ops.length === 1 ? '' : 's'}
      </span>

      <div className="sandbox-layer-row-mix" onClick={(e) => e.stopPropagation()}>
        <button
          className={`sandbox-mini-btn sandbox-mini-btn--mute${layer.muted ? ' active' : ''}`}
          onClick={() => onToggleMute(layer.id)}
          title="Mute"
        >M</button>
        <button
          className={`sandbox-mini-btn sandbox-mini-btn--solo${layer.soloed ? ' active' : ''}`}
          onClick={() => onToggleSolo(layer.id)}
          title="Solo"
        >S</button>
        <DragNumberField
          className="sandbox-drag-field" label="dB" value={gainDb} precision={1} step={0.25}
          min={-60} max={12}
          onLiveChange={(v) => setLive((d) => ({ ...d, gainDb: v }))}
          onCommit={(v) => commit({ gainDb: v })}
        />
        <DragNumberField
          className="sandbox-drag-field" label="Pan" value={pan} precision={2} step={0.01}
          min={-1} max={1}
          onLiveChange={(v) => setLive((d) => ({ ...d, pan: v }))}
          onCommit={(v) => commit({ pan: v })}
        />
        <DragNumberField
          className="sandbox-drag-field" label="ms" value={offMs} precision={0} step={1}
          min={0} max={60000}
          onLiveChange={(v) => setLive((d) => ({ ...d, offsetMs: v }))}
          onCommit={(v) => commit({ offsetMs: v })}
        />
      </div>

      <button
        className="sandbox-row-btn"
        onClick={(e) => { e.stopPropagation(); onDuplicate(layer.id) }}
        title={`Duplicate this layer with its ${layer.ops.length} op${layer.ops.length === 1 ? '' : 's'} and mix settings (Ctrl+D)`}
      ><Copy size={11} /></button>
      <button
        className="sandbox-row-btn sandbox-row-btn--close"
        onClick={(e) => { e.stopPropagation(); onClose(layer.id) }}
        title="Close layer"
      ><X size={11} /></button>
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
      className="sandbox-layer-workspace"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {layers.length > 0 && (
        <div className="sandbox-layer-rail">
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
          <div className="sandbox-layer-rail-hint">
            <Plus size={11} /> Drop a sample or audio file anywhere here to add a layer
          </div>
        </div>
      )}

      {/* The editor. One canvas, filling everything the rail leaves — which is
          the whole point of the restructure. */}
      <div className="sandbox-editor-pane">
        {activeLayer ? (
          <>
            <SandboxWaveformCanvas />
            {hasSpcSelection && <SandboxSpcSelectionActionBar />}
          </>
        ) : (
          <div className={`sandbox-drop-zone${dragOver ? ' over' : ''}`}>
            <Plus size={20} />
            <span>Drag a sample or audio file here to begin</span>
            <span className="sandbox-drop-zone-hint">
              …or right-click a marked region in the timeline and choose “Open in Sample Sandbox”
            </span>
          </div>
        )}
        {dragOver && activeLayer && <div className="sandbox-drop-overlay">Drop to add a layer</div>}
      </div>
    </div>
  )
}
