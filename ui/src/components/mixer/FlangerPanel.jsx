import React from 'react'
import useFlangerStore from '../../stores/flangerStore.js'
import FloatingDevice from '../devices/FloatingDevice.jsx'

// The popped-out Flanger: the SAME device as the Devices tab (DeviceFrame +
// FlangerDevice), in a floating window mounted by EffectEditorHost.
export default function FlangerPanel() {
  return <FloatingDevice useStore={useFlangerStore} pluginId="flanger" testId="flanger-window" halfWidth={300} />
}
