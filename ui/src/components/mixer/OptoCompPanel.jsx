import React from 'react'
import useOptoCompStore from '../../stores/optoCompStore.js'
import FloatingDevice from '../devices/FloatingDevice.jsx'

// The popped-out Opto comp: the SAME device as the Devices tab (DeviceFrame +
// CompressorFamilyDevice), in a floating window mounted by EffectEditorHost.
export default function OptoCompPanel() {
  return <FloatingDevice useStore={useOptoCompStore} pluginId="opto" testId="opto-window" halfWidth={200} />
}
