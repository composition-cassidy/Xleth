import { Plus, X } from 'lucide-react'
import { useState, useCallback } from 'react'
import useSandboxStore from '../../stores/sandboxStore.js'
import SandboxLayerWaveform from './SandboxLayerWaveform.jsx'

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

function LayerRow({ layer, active, onSelect, onClose, onToggleMute, onToggleSolo }) {
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
      {layer.renderState === 'error' && (
        <div className="sandbox-layer-error" title={layer.error}>Render failed</div>
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
  const addSourceFromRegion = useSandboxStore((s) => s.addSourceFromRegion)

  const [dragOver, setDragOver] = useState(false)

  const handleDragOver = useCallback((e) => {
    if (!Array.from(e.dataTransfer.types || []).includes('application/xleth-sample')) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    setDragOver(true)
  }, [])

  const handleDragLeave = useCallback(() => setDragOver(false), [])

  const handleDrop = useCallback((e) => {
    e.preventDefault()
    setDragOver(false)
    const raw = e.dataTransfer.getData('application/xleth-sample')
    if (!raw) return
    try {
      const region = JSON.parse(raw)
      addSourceFromRegion(region)
    } catch (err) {
      console.warn('[SampleSandbox] Bad drop payload:', err?.message || err)
    }
  }, [addSourceFromRegion])

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
        <span>Drag a sample here</span>
      </div>
    </div>
  )
}
