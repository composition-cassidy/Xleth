import React from 'react'
import useResonanceSuppressorStore from '../../stores/resonanceSuppressorStore.js'
import FloatingDevice from '../devices/FloatingDevice.jsx'

// The popped-out Resonance Suppressor: the SAME device as the Devices tab
// (DeviceFrame + ResonanceSuppressorDevice), in a floating window mounted by
// EffectEditorHost.
export default function ResonanceSuppressorPanel() {
  return <FloatingDevice useStore={useResonanceSuppressorStore} pluginId="resonancesuppressor" testId="resonancesuppressor-window" halfWidth={660} />
}
