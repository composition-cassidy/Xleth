import React from 'react'
import useWaveshaperStore from '../../stores/waveshaperStore.js'
import FloatingDevice from '../devices/FloatingDevice.jsx'

// The popped-out Waveshaper: the SAME device as the Devices tab (DeviceFrame +
// WaveshaperDevice), in a floating window mounted by EffectEditorHost.
export default function WaveshaperPanel() {
  return <FloatingDevice useStore={useWaveshaperStore} pluginId="waveshaper" testId="waveshaper-window" halfWidth={420} />
}
