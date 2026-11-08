import React from 'react'
import usePitchShifterStore from '../../stores/pitchShifterStore.js'
import FloatingDevice from '../devices/FloatingDevice.jsx'

// The popped-out Pitch Shifter: the SAME device as the Devices tab (DeviceFrame +
// PitchShifterDevice), in a floating window mounted by EffectEditorHost.
export default function PitchShifterPanel() {
  return <FloatingDevice useStore={usePitchShifterStore} pluginId="pitchshifter" testId="pitchshifter-window" halfWidth={220} />
}
