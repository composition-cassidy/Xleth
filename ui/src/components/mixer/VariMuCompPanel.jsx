import React from 'react'
import useVariMuCompStore from '../../stores/variMuCompStore.js'
import FloatingDevice from '../devices/FloatingDevice.jsx'

// The popped-out Vari-mu comp: the SAME device as the Devices tab (DeviceFrame +
// CompressorFamilyDevice), in a floating window mounted by EffectEditorHost.
export default function VariMuCompPanel() {
  return <FloatingDevice useStore={useVariMuCompStore} pluginId="varimu" testId="varimu-window" halfWidth={300} />
}
