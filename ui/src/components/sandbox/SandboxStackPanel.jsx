import { GripVertical, Trash2 } from 'lucide-react'
import useSandboxStore from '../../stores/sandboxStore.js'

function OpRow({ op, layerId, onToggleBypass, onRemove }) {
  return (
    <div className={`sandbox-op-row${op.enabled ? '' : ' bypassed'}`}>
      <GripVertical size={12} className="sandbox-op-grip" />
      <span className="sandbox-op-type">{op.type}</span>
      <button
        className={`sandbox-op-bypass${op.enabled ? '' : ' active'}`}
        onClick={() => onToggleBypass(layerId, op.id, op.enabled)}
        title={op.enabled ? 'Bypass' : 'Enable'}
      >
        {op.enabled ? 'ON' : 'OFF'}
      </button>
      <button
        className="sandbox-op-remove"
        onClick={() => onRemove(layerId, op.id)}
        title="Remove operation"
      >
        <Trash2 size={11} />
      </button>
    </div>
  )
}

export default function SandboxStackPanel() {
  const layers = useSandboxStore((s) => s.layers)
  const activeLayerId = useSandboxStore((s) => s.activeLayerId)
  const setOpBypassed = useSandboxStore((s) => s.setOpBypassed)
  const removeOp = useSandboxStore((s) => s.removeOp)
  const bakeLayer = useSandboxStore((s) => s.bakeLayer)
  const swapInLayer = useSandboxStore((s) => s.swapInLayer)
  const layer = layers.find((l) => l.id === activeLayerId) ?? null

  const handleToggleBypass = (layerId, opId, enabled) => setOpBypassed(layerId, opId, enabled)

  const canBake = !!layer && layer.renderState === 'ready'
  const bakeLabel = layer?.bakeState === 'baking' ? 'Baking…' : layer?.bakeState === 'baked' ? 'Baked ✓' : 'BAKE'

  return (
    <div className="sandbox-stack-panel">
      <div className="sandbox-panel-header">Op Stack</div>
      <div className="sandbox-op-list">
        {!layer && <div className="sandbox-empty-hint">No layer selected.</div>}
        {layer && layer.ops.length === 0 && (
          <div className="sandbox-empty-hint">No operations yet.</div>
        )}
        {layer?.ops.map((op) => (
          <OpRow
            key={op.id}
            op={op}
            layerId={layer.id}
            onToggleBypass={handleToggleBypass}
            onRemove={removeOp}
          />
        ))}
      </div>
      <div className="sandbox-stack-actions">
        <button
          className="sandbox-action-btn sandbox-action-btn--bake"
          disabled={!canBake}
          onClick={() => layer && bakeLayer(layer.id)}
          title="Commit the current render as this layer's clean baseline"
        >
          {bakeLabel}
        </button>
        <button
          className="sandbox-action-btn sandbox-action-btn--swap"
          disabled={!layer}
          onClick={() => layer && swapInLayer(layer.id)}
          title="Swap the baked result back into the project (requires SB-6)"
        >
          SWAP IN
        </button>
      </div>
    </div>
  )
}
