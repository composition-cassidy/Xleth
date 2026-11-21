import React from 'react'
import useSzkrezhStore from '../../stores/szkrezhStore.js'
import FloatingDevice from '../devices/FloatingDevice.jsx'

// The popped-out Szkrezh: the SAME device as the Devices tab (DeviceFrame +
// SzkrezhDevice), in a floating window mounted by EffectEditorHost.
export default function SzkrezhPanel() {
  return <FloatingDevice useStore={useSzkrezhStore} pluginId="szkrezh" testId="szkrezh-window" halfWidth={480} />
}
