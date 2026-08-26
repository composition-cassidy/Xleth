import { Plus, X, Play, Square } from 'lucide-react'
import { useState, useCallback } from 'react'
import useSandboxStore from '../../stores/sandboxStore.js'
import SandboxLayerWaveform from './SandboxLayerWaveform.jsx'

// OS-file drop (Explorer/Finder → panel): audio formats the engine can decode
// via FFmpeg. Mirrors ImportDropZone.jsx's ALLOWED_EXT, narrowed to audio —
// this panel has no track to put a video's picture on.
const DROPPABLE_AUDIO_EXT = /\.(wav|mp3|flac|aiff?|ogg|m4a|wma|opus)$/i

function offsetMs(layer) {
  return layer.bufferSampleRate ? (layer.offsetSamples / layer.bufferSampleRate) * 1000 : 0
}

// Compact gain/pan/offset row — mix params live OUTSIDE the op-stack, so
// editing these never re-renders the layer itself (setLayerMix). Commits
// on blur/Enter rather than per-keystroke, matching the drag-then-commit
// contract every other sandbox control uses.
function LayerMixRow({ layer, onSetMix }) {
  const [draft, setDraft] = useState(null) // { gainDb?, pan?, offsetMs? } while editing, else null

  const commit = useCallback((patch) => {
    onSetMix(layer.id, patch)
    setDraft(null)
  }, [layer.id, onSetMix])

  const gainDb = draft?.gainDb ?? layer.gainDb ?? 0
  const pan = draft?.pan ?? layer.pan ?? 0
  const offMs = draft?.offsetMs ?? offsetMs(layer)

  return (
    <div className="sandbox-layer-mix-row" onClick={(e) => e.stopPropagation()}>
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

function LayerRow({ layer, active, onSelect, onClose, onToggleMute, onToggleSolo, onSetMix }) {
  return (
    <div
      className={`sandbox-layer-row${active ? ' active' : ''}`}
      onClick={() => onSelect(layer.id)}
    >
      <div className="sandbox-layer-row-top">
        <span className="sandbox-layer-name" title={layer.name}>{layer.name}</span>
        <div className="sandbox-layer-btn-cluster">
          <button
            className={`sandbox-mini-btn sandbox-mini-btn--mute${layer.muted ? ' active' : ''}`}
            onClick={(e) => { e.stopPropagation(); onToggleMute(layer.id) }}
            title="Mute"
          >M</button>
          <button
            className={`sandbox-mini-btn sandbox-mini-btn--solo${layer.soloed ? ' active' : ''}`}
            onClick={(e) => { e.stopPropagation(); onToggleSolo(layer.id) }}
            title="Solo"
          >S</button>
          <button
            className="sandbox-mini-btn sandbox-layer-close"
            onClick={(e) => { e.stopPropagation(); onClose(layer.id) }}
            title="Close layer"
          ><X size={11} /></button>
        </div>
      </div>
      <SandboxLayerWaveform
        filePath={layer.sourceFilePath}
        startTime={layer.sourceStartTime}
        endTime={layer.sourceEndTime}
      />
      <div className="sandbox-layer-meta">{formatMeta(layer)}</div>
      <LayerMixRow layer={layer} onSetMix={onSetMix} />
      {layer.renderState === 'error' && (
        <div className="sandbox-layer-error" title={layer.error}>Render failed</div>
      )}
    </div>
  )
}

const COMPOSITE_RENDER_LABEL = {
  idle: 'RENDER COMPOSITE', rendering: 'Rendering…', ready: 'RE-RENDER', error: 'Render failed — retry',
}

function CompositeSection() {
  const layers = useSandboxStore((s) => s.layers)
  const composite = useSandboxStore((s) => s.composite)
  const compositePreviewState = useSandboxStore((s) => s.compositePreviewState)
  const bakedAssets = useSandboxStore((s) => s.bakedAssets)
  const renderComposite = useSandboxStore((s) => s.renderComposite)
  const toggleCompositePreview = useSandboxStore((s) => s.toggleCompositePreview)
  const addBakedAssetAsSource = useSandboxStore((s) => s.addBakedAssetAsSource)

  const hasLayers = layers.length > 0
  const buf = composite.renderedBuffer
  const isPlaying = compositePreviewState === 'playing'

  return (
    <div className="sandbox-composite-section">
      <div className="sandbox-panel-header">Composite</div>
      <div className="sandbox-composite-actions">
        <div className="sandbox-composite-render-row">
          <button
            className={`sandbox-mini-btn${isPlaying ? ' active' : ''}`}
            disabled={!hasLayers || compositePreviewState === 'rendering'}
            onClick={() => toggleCompositePreview()}
            title={isPlaying ? 'Stop preview (Space)' : 'Preview the composite (Space) — renders it first if needed'}
          >
            {isPlaying ? <Square size={11} /> : <Play size={11} />}
          </button>
          <button
            className="sandbox-action-btn"
            disabled={!hasLayers || composite.renderState === 'rendering'}
            onClick={() => renderComposite()}
            title="Mix every layer's current render by its gain/pan/offset/mute/solo"
          >
            {COMPOSITE_RENDER_LABEL[composite.renderState] ?? composite.renderState}
          </button>
        </div>
      </div>
      {buf && (
        <div className="sandbox-layer-meta">
          {buf.layersMixed} layer{buf.layersMixed === 1 ? '' : 's'} mixed · {buf.numSamples} smp @ {Math.round(buf.sampleRate)} Hz
        </div>
      )}
      {composite.error && <div className="sandbox-layer-error" title={composite.error}>{composite.error}</div>}
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

export default function SandboxSourcesPanel() {
  const layers = useSandboxStore((s) => s.layers)
  const activeLayerId = useSandboxStore((s) => s.activeLayerId)
  const setActiveLayer = useSandboxStore((s) => s.setActiveLayer)
  const closeLayer = useSandboxStore((s) => s.closeLayer)
  const toggleMute = useSandboxStore((s) => s.toggleMute)
  const toggleSolo = useSandboxStore((s) => s.toggleSolo)
  const setLayerMix = useSandboxStore((s) => s.setLayerMix)
  const addSourceFromRegion = useSandboxStore((s) => s.addSourceFromRegion)

  const [dragOver, setDragOver] = useState(false)

  const handleDragOver = useCallback((e) => {
    const types = Array.from(e.dataTransfer.types || [])
    if (!types.includes('application/xleth-sample') && !types.includes('Files')) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    setDragOver(true)
  }, [])

  const handleDragLeave = useCallback(() => setDragOver(false), [])

  // Raw audio file dropped from Explorer/Finder — no region, no sourceId, so
  // it goes straight to addSourceFromRegion with a synthetic "region" that
  // carries just the file path and its full duration. With no `id`, the
  // resulting layer's sourceRegionId is null — the existing cold-layer
  // SwapTargetPicker (SandboxStackPanel.jsx) already handles that case.
  const addSourceFromFile = useCallback(async (filePath, name) => {
    const duration = await window.xleth?.audio?.probeAudioDuration(filePath)
    if (!(duration > 0)) {
      console.warn('[SampleSandbox] Could not read duration, skipping drop:', filePath)
      return
    }
    addSourceFromRegion({ audioFilePath: filePath, name, startTime: 0, endTime: duration })
  }, [addSourceFromRegion])

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
        // Without this the layer opens with no sourceRegionId and SWAP IN has
        // nothing to target, even though the dragged sample IS a real region.
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
    <div className="sandbox-sources-panel">
      <div className="sandbox-panel-header">Sources &amp; Layers</div>
      <div className="sandbox-layer-list">
        {layers.map((layer) => (
          <LayerRow
            key={layer.id}
            layer={layer}
            active={layer.id === activeLayerId}
            onSelect={setActiveLayer}
            onClose={closeLayer}
            onToggleMute={toggleMute}
            onToggleSolo={toggleSolo}
            onSetMix={setLayerMix}
          />
        ))}
      </div>
      <div
        className={`sandbox-add-source-zone${dragOver ? ' drag-over' : ''}`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <Plus size={16} />
        <span>Drag a sample or audio file here</span>
      </div>
      <CompositeSection />
    </div>
  )
}
