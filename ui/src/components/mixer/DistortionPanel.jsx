import React from 'react'
import useDistortionStore from '../../stores/distortionStore.js'
import FloatingDevice from '../devices/FloatingDevice.jsx'

// The popped-out Distortion: the SAME device as the Devices tab (DeviceFrame +
// DistortionDevice), in a floating window mounted by EffectEditorHost. The
// plugin-ui runtime renderer and its Designer entry point are gone with the layout.
export default function DistortionPanel() {
  return <FloatingDevice useStore={useDistortionStore} pluginId="distortion" testId="distortion-window" halfWidth={560} />
}
