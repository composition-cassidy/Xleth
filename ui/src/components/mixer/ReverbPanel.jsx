import React from 'react'
import useReverbStore from '../../stores/reverbStore.js'
import FloatingDevice from '../devices/FloatingDevice.jsx'

// The popped-out Reverb: the SAME device as the Devices tab (DeviceFrame +
// ReverbDevice), in a floating window mounted by EffectEditorHost.
export default function ReverbPanel() {
  return <FloatingDevice useStore={useReverbStore} pluginId="reverb" testId="reverb-window" halfWidth={450} />
}
