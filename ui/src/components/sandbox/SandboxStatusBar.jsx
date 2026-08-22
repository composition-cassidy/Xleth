import useSandboxStore from '../../stores/sandboxStore.js'

const TIERS = ['Fast', 'Balanced', 'Best']

const RENDER_STATE_LABEL = {
  idle: 'Idle',
  rendering: 'Rendering…',
  ready: 'Ready',
  error: 'Error',
}

export default function SandboxStatusBar() {
  const layers = useSandboxStore((s) => s.layers)
  const activeLayerId = useSandboxStore((s) => s.activeLayerId)
  const layer = layers.find((l) => l.id === activeLayerId) ?? null

  const renderState = layer ? RENDER_STATE_LABEL[layer.renderState] ?? layer.renderState : '—'
  const bufferRate = layer?.renderedBuffer?.sampleRate
    ? `${Math.round(layer.renderedBuffer.sampleRate)} Hz`
    : '—'
  const undoDepth = layer ? layer.undoDepth : 0

  return (
    <div className="sandbox-status-bar">
      <div className="sandbox-tier-strip" title="Separation tiers — coming in a future prompt">
        {TIERS.map((tier) => (
          <button key={tier} className="sandbox-tier-btn" disabled>{tier}</button>
        ))}
      </div>
      <div className="sandbox-session-status">
        <span className={`sandbox-status-item${layer?.renderState === 'error' ? ' error' : ''}`}>
          Render: {renderState}
        </span>
        <span className="sandbox-status-item">Buffer: {bufferRate}</span>
        <span className="sandbox-status-item">Undo depth: {undoDepth}</span>
      </div>
    </div>
  )
}
