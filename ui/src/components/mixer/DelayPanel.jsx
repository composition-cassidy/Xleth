import React from 'react'
import useDelayStore from '../../stores/delayStore.js'
import FloatingDevice from '../devices/FloatingDevice.jsx'

// The popped-out Delay: the SAME device as the Devices tab (DeviceFrame +
// DelayDevice), in a floating window mounted by EffectEditorHost.
//
// The tempo-sync adapter lives in devices/delaySync.js; it is re-exported here
// because the Delay tests and callers have always imported it from this module.
export {
  indexToNoteFeel, noteFeelToIndex, availableFeels,
  TIME_MODE_FREE, encodeTimeMode, decodeTimeMode,
} from '../devices/delaySync.js'

export default function DelayPanel() {
  return <FloatingDevice useStore={useDelayStore} pluginId="delay" testId="delay-window" halfWidth={400} />
}
