import React from 'react'
import usePhanjerStore from '../../stores/phanjerStore.js'
import FloatingDevice from '../devices/FloatingDevice.jsx'

// The popped-out Phanjer: the SAME device as the Devices tab (DeviceFrame +
// PhanjerDevice), in a floating window mounted by EffectEditorHost.
export default function PhanjerPanel() {
  return <FloatingDevice useStore={usePhanjerStore} pluginId="phanjer" testId="phanjer-window" halfWidth={580} />
}
