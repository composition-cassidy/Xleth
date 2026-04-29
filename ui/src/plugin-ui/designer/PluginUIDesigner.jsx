import React, { useEffect } from 'react'
import './styles/designer.css'
import { usePluginUIDesignerStore } from './usePluginUIDesignerStore.js'
import LayoutTreePanel from './LayoutTreePanel.jsx'

// Right-side docked Designer column.
// Phases A–C only:
//   - Loads shipped/user layout into workingLayout (Phase B).
//   - Renders a Layout Tree with selection support (Phase C).
//   - Inspector/Palette/Validation panels are placeholders.
//   - All toolbar buttons are present but disabled — wiring lands in Phase D+.
//
// The runtime preview is NOT mounted by this component. CompressorPanel mounts
// one StockPluginRuntimeRenderer; when the Designer is open, that single mount
// receives layoutOverride={workingLayout} from this store. This avoids two
// renderers competing over the same engine target.
//
// The selection outline overlay is rendered inside the runtime preview pane by
// the parent panel; this component owns the store but not the preview DOM.

export default function PluginUIDesigner({ pluginId = 'compressor', onClose }) {
  const loadInitial   = usePluginUIDesignerStore(s => s.loadInitial)
  const isLoading     = usePluginUIDesignerStore(s => s.isLoading)
  const loadError     = usePluginUIDesignerStore(s => s.loadError)
  const selectedNodeId = usePluginUIDesignerStore(s => s.selectedNodeId)

  useEffect(() => {
    loadInitial(pluginId)
  }, [loadInitial, pluginId])

  return (
    <div className="pluginui-designer-root" role="complementary" aria-label="Plugin UI Designer">
      <Toolbar onClose={onClose} />

      {isLoading && (
        <div className="pluginui-designer-loading">Loading layout…</div>
      )}

      {loadError && !isLoading && (
        <div className="pluginui-designer-error" title={loadError}>
          {loadError}
        </div>
      )}

      <Section title="Layout Tree" grow>
        <LayoutTreePanel />
      </Section>

      <Section title="Inspector">
        <div className="pluginui-designer-inspector-stub">
          {selectedNodeId
            ? `Selected: ${selectedNodeId}  (inspector coming in Phase D)`
            : '(no selection)'}
        </div>
      </Section>

      <Section title="Palette">
        <div className="pluginui-designer-palette-stub">
          (palette coming in Phase E)
        </div>
      </Section>

      <Section title="Validation">
        <ValidationStub />
      </Section>
    </div>
  )
}

function Toolbar({ onClose }) {
  return (
    <div className="pluginui-designer-toolbar" role="toolbar" aria-label="Designer toolbar">
      <button className="pluginui-designer-button pluginui-designer-button--primary" disabled title="Phase H">Save</button>
      <button className="pluginui-designer-button" disabled title="Phase H">Reset</button>
      <button className="pluginui-designer-button" disabled title="Phase H">Import</button>
      <button className="pluginui-designer-button" disabled title="Phase H">Export</button>
      <button className="pluginui-designer-button" disabled title="Phase I">Undo</button>
      <button className="pluginui-designer-button" disabled title="Phase I">Redo</button>
      {onClose && (
        <button
          className="pluginui-designer-button"
          onClick={onClose}
          title="Close Designer"
          style={{ marginLeft: 'auto' }}
        >
          Close
        </button>
      )}
    </div>
  )
}

function Section({ title, grow, children }) {
  const cls = grow
    ? 'pluginui-designer-section pluginui-designer-section--grow'
    : 'pluginui-designer-section'
  return (
    <div className={cls}>
      <div className="pluginui-designer-section-header">{title}</div>
      <div className="pluginui-designer-section-body">{children}</div>
    </div>
  )
}

function ValidationStub() {
  const errors = usePluginUIDesignerStore(s => s.validationResult?.errors ?? [])
  if (errors.length === 0) {
    return <div className="pluginui-designer-validation-stub">No issues.</div>
  }
  return (
    <div className="pluginui-designer-validation-stub">
      {errors.length} validation note(s); full panel in Phase G.
    </div>
  )
}
