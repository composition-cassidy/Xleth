import React from 'react'
import { Knob } from '../../ui-kit'
import { useKnobAutomation } from '../mixer/automationKnobBinding.jsx'

// A kit Knob with the stock-effect automation behaviour the legacy
// PluginUIKitKnob had (Phase C): right-click "Create automation clip", the
// automated read-only state (the knob shows the clip's value at the playhead and
// refuses edits) and the base-value write after a manual commit.
//
// It adds nothing the engine did not already do for these knobs: the same hook,
// the same `paramId` + `{ trackId, nodeId }` opt-in. A knob with no `paramId` is
// an ordinary kit Knob.
//
//   paramId  the effect's stable APVTS parameter id
//   target   the device's { trackId, nodeId, storeKey }
//   skew     the engine's NormalisableRange skew (1 = linear); only the automation
//            maths needs it, the knob's own travel comes from `scale`
export default function AutomatableKnob({
  paramId, target, skew = 1, min, max, value, onChange, onCommit, disabled = false, ...rest
}) {
  const automation = useKnobAutomation(paramId, target, { min, max, skew })
  const automated = automation.automated
  return (
    <>
      <Knob
        {...rest}
        min={min}
        max={max}
        value={automated ? automation.automatedValue : value}
        disabled={disabled || automated}
        onChange={automated ? undefined : onChange}
        onCommit={automated
          ? undefined
          : (v) => { onCommit?.(v); automation.writeBaseValue?.(v) }}
        onContextMenu={automation.onContextMenu}
        data-automation-param={paramId || undefined}
        data-automated={automated ? 'true' : undefined}
      />
      {automation.menuNode}
    </>
  )
}
