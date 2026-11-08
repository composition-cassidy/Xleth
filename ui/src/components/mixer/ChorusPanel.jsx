import React from 'react'
import useChorusStore from '../../stores/chorusStore.js'
import FloatingDevice from '../devices/FloatingDevice.jsx'

// The popped-out Chorus: the SAME device as the Devices tab (DeviceFrame +
// ChorusDevice), in a floating window mounted by EffectEditorHost.
export default function ChorusPanel() {
  return <FloatingDevice useStore={useChorusStore} pluginId="chorus" testId="chorus-window" halfWidth={330} />
}
