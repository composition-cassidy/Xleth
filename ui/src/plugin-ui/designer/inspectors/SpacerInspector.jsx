import React from 'react'
import { InspectorGroup } from './FieldControls.jsx'

export default function SpacerInspector() {
  return (
    <InspectorGroup title="Spacer">
      <div className="pluginui-designer-inspector-note">
        Spacer sizing is controlled by style fields.
      </div>
    </InspectorGroup>
  )
}
