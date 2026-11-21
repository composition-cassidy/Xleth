import React from 'react'
import { useKnobAutomation } from '../mixer/automationKnobBinding.jsx'

// Right-click "Create automation clip" for ANY device control that is not a
// knob: a dropdown, a segmented control, a toggle, a number box. Wraps the
// control without adding a layout box (`display: contents`), so the device's
// spacing is untouched; the contextmenu event bubbles to the wrapper.
//
//   paramId  the effect's stable APVTS parameter id
//   target   the device's { trackId, nodeId, storeKey }
//
// Missing either one and the wrapper is inert. Menu only: a stepped control has
// no travel to animate, so the automated read-only state stays the knob's.
export default function AutomationTarget({ paramId, target, children }) {
  const automation = useKnobAutomation(paramId, target)
  return (
    <span
      style={{ display: 'contents' }}
      data-automation-param={paramId || undefined}
      onContextMenu={automation.onContextMenu}
    >
      {children}
      {automation.menuNode}
    </span>
  )
}
