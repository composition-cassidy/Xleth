import { Plus, X } from 'lucide-react'
import { useState, useCallback } from 'react'
import useSandboxStore, { hasMeaningfulSelection } from '../../stores/sandboxStore.js'
import SandboxLayerWaveform from './SandboxLayerWaveform.jsx'
import SandboxWaveformCanvas from './SandboxWaveformCanvas.jsx'
import SandboxSpcSelectionActionBar from './SandboxSpcSelectionActionBar.jsx'

// Layer cards filling the main workspace (mockup layout): a name bar on top,
// then a split row — a ~128px mix control strip on the LEFT, waveform area
// filling the rest on the RIGHT. Only the ACTIVE card's waveform area hosts
// the real interactive SandboxWaveformCanvas (selection/envelope/paint/SPC
// selection are singular store state, not per-layer — see the plan's "per-
// layer interactive canvas" conflict); every inactive card shows the
// existing lightweight SandboxLayerWaveform thumbnail. Clicking a card
// activates it, upgrading its waveform area to the real canvas.

const DROPPABLE_AUDIO_EXT = /\.(wav|mp3|flac|aiff?|ogg|m4a|wma|opus)$/i

const RENDER_STATE_LABEL = {
  idle: 'Idle', rendering: 'Rendering…', ready: 'Ready', error: 'Render failed',
}

function offsetMs(layer) {
  return layer.bufferSampleRate ? (layer.offsetSamples / layer.bufferSampleRate) * 1000 : 0
}

function formatMeta(layer) {
  const parts = []
  if (layer.bufferSampleRate) parts.push(`${Math.round(layer.bufferSampleRate)} Hz`)
  const dur = layer.sourceStartTime != null && layer.sourceEndTime != null
    ? layer.sourceEndTime - layer.sourceStartTime
    : (layer.renderedBuffer ? layer.renderedBuffer.numSamples / layer.renderedBuffer.sampleRate : null)
  if (dur != null) parts.push(`${dur.toFixed(2)}s`)
  parts.push(`${layer.ops.length} op${layer.ops.length === 1 ? '' : 's'}`)
  return parts.join(' · ')
}

// Compact gain/pan/offset control strip — mix params live OUTSIDE the
// op-stack, so editing these never re-renders the layer itself (setLayerMix).
// Commits on blur/Enter rather than per-keystroke, matching the drag-then-
// commit contract every other sandbox control uses.
function LayerMixStrip({ layer, onSetMix, onToggleMute, onToggleSolo }) {
  const [draft, setDraft] = useState(null) // { gainDb?, pan?, offsetMs? } while editing, else null

  const commit = useCallback((patch) => {
    onSetMix(layer.id, patch)
    setDraft(null)
  }, [layer.id, onSetMix])

  const gainDb = draft?.gainDb ?? layer.gainDb ?? 0
  const pan = draft?.pan ?? layer.pan ?? 0
  const offMs = draft?.offsetMs ?? offsetMs(layer)

  return (
    <div className="sandbox-layer-ctl" onClick={(e) => e.stopPropagation()}>
      <div className="sandbox-layer-ctl-msrow">
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
      </div>
      <label className="sandbox-mix-field" title="Gain (dB)">
        <span>dB</span>
        <input
          type="number" step="0.5" className="sandbox-mix-input"
          value={gainDb}
          onChange={(e) => setDraft((d) => ({ ...d, gainDb: Number(e.target.value) }))}
          onBlur={() => draft?.gainDb !== undefined && commit({ gainDb: draft.gainDb })}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        />
      </label>
      <label className="sandbox-mix-field" title="Pan (-1 = left, +1 = right)">
        <span>Pan</span>
        <input
          type="number" step="0.1" min="-1" max="1" className="sandbox-mix-input"
          value={pan}
          onChange={(e) => setDraft((d) => ({ ...d, pan: Number(e.target.value) }))}
          onBlur={() => draft?.pan !== undefined && commit({ pan: draft.pan })}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        />
      </label>
      <label className="sandbox-mix-field" title="Offset / delay in the composite (ms)">
        <span>ms</span>
        <input
          type="number" step="1" min="0" className="sandbox-mix-input"
          value={offMs}
          onChange={(e) => setDraft((d) => ({ ...d, offsetMs: Number(e.target.value) }))}
          onBlur={() => draft?.offsetMs !== undefined && commit({ offsetMs: draft.offsetMs })}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        />
      </label>
    </div>
  )
}

function LayerCard({
  layer, active, hasSpcSelection, onSelect, onClose, onToggleMute, onToggleSolo, onSetMix,
}) {
  const renderState = RENDER_STATE_LABEL[layer.renderState] ?? layer.renderState
  return (
    <div
      className={`sandbox-layer-card${active ? ' active' : ''}${layer.soloed ? ' soloed' : ''}`}
      onClick={() => onSelect(layer.id)}
    >
      <div className="sandbox-layer-card-head">
        <span className="sandbox-layer-card-name" title={layer.name}>{layer.name}</span>
        <span className="sandbox-layer-card-meta">{formatMeta(layer)}</span>
        <span className={`sandbox-render-chip sandbox-render-chip--${layer.renderState}`}>
          <span className="sandbox-render-chip-dot" />
          {renderState}
        </span>
        <button
          className="sandbox-layer-card-close"
          onClick={(e) => { e.stopPropagation(); onClose(layer.id) }}
          title="Close layer"
        ><X size={12} /></button>
      </div>
      <div className="sandbox-layer-card-body">
        <LayerMixStrip layer={layer} onSetMix={onSetMix} onToggleMute={onToggleMute} onToggleSolo={onToggleSolo} />
        <div className="sandbox-layer-card-wave">
          {active ? <SandboxWaveformCanvas /> : (
            <SandboxLayerWaveform
              filePath={layer.sourceFilePath}
              startTime={layer.sourceStartTime}
              endTime={layer.sourceEndTime}
            />
          )}
          {active && hasSpcSelection && <SandboxSpcSelectionActionBar />}
        </div>
      </div>
      {layer.renderState === 'error' && (
        <div className="sandbox-layer-error" title={layer.error}>Render failed</div>
      )}
    </div>
  )
}

export default function SandboxLayerWorkspace() {
  const layers = useSandboxStore((s) => s.layers)
  const activeLayerId = useSandboxStore((s) => s.activeLayerId)
  const setActiveLayer = useSandboxStore((s) => s.setActiveLayer)
  const closeLayer = useSandboxStore((s) => s.closeLayer)
  const toggleMute = useSandboxStore((s) => s.toggleMute)
  const toggleSolo = useSandboxStore((s) => s.toggleSolo)
  const setLayerMix = useSandboxStore((s) => s.setLayerMix)
  const addSourceFromRegion = useSandboxStore((s) => s.addSourceFromRegion)
  // Shared with the separation strip — a stem and a dropped file enter the
  // workspace through the same door. See sandboxStore.addSourceFromFile.
  const addSourceFromFile = useSandboxStore((s) => s.addSourceFromFile)
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

  return (
    <div className="sandbox-layer-workspace">
      {layers.map((layer) => (
        <LayerCard
          key={layer.id}
          layer={layer}
          active={layer.id === activeLayerId}
          hasSpcSelection={hasSpcSelection && layer.id === activeLayerId}
          onSelect={setActiveLayer}
          onClose={closeLayer}
          onToggleMute={toggleMute}
          onToggleSolo={toggleSolo}
          onSetMix={setLayerMix}
        />
      ))}
      <div
        className={`sandbox-drop-zone${dragOver ? ' over' : ''}${layers.length ? ' compact' : ''}`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <Plus size={layers.length ? 14 : 20} />
        <span>{layers.length ? 'Drag a sample or audio file here' : 'Drag a sample or audio file here to begin'}</span>
      </div>
    </div>
  )
}
