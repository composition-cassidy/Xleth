import React from 'react'
import useFeddaStore from '../../stores/feddaStore.js'
import FloatingDevice from '../devices/FloatingDevice.jsx'

// The popped-out Fedda: the SAME device as the Devices tab (DeviceFrame +
// FeddaDevice), in a floating window mounted by EffectEditorHost.
export default function FeddaPanel() {
  return <FloatingDevice useStore={useFeddaStore} pluginId="fedda" testId="fedda-window" halfWidth={440} />
}
