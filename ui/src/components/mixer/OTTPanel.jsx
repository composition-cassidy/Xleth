import React from 'react'
import useOverdoneStore from '../../stores/overdoneStore.js'
import FloatingDevice from '../devices/FloatingDevice.jsx'

// The popped-out Overdone: the SAME device as the Devices tab (DeviceFrame +
// OverdoneDevice), in a floating window mounted by EffectEditorHost.
export default function OTTPanel() {
  return <FloatingDevice useStore={useOverdoneStore} pluginId="overdone" testId="overdone-window" halfWidth={440} />
}
