import React from 'react'
import useAmpStore from '../../stores/ampStore.js'
import FloatingDevice from '../devices/FloatingDevice.jsx'

// The popped-out Amp Stack: the SAME device as the Devices tab (DeviceFrame +
// AmpDevice), in a floating window mounted by EffectEditorHost. The two-skin
// panel is gone.
export default function AmpPanel() {
  return <FloatingDevice useStore={useAmpStore} pluginId="amp" testId="amp-window" halfWidth={620} />
}
