import React from 'react'
import useFetCompStore from '../../stores/fetCompStore.js'
import FloatingDevice from '../devices/FloatingDevice.jsx'

// The popped-out FET comp: the SAME device as the Devices tab (DeviceFrame +
// CompressorFamilyDevice), in a floating window mounted by EffectEditorHost.
export default function FetCompPanel() {
  return <FloatingDevice useStore={useFetCompStore} pluginId="fet" testId="fet-window" halfWidth={280} />
}
