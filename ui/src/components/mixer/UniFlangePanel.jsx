import React from 'react'
import useUniFlangeStore from '../../stores/uniFlangeStore.js'
import FloatingDevice from '../devices/FloatingDevice.jsx'

// The popped-out UniFlange: the SAME device as the Devices tab (DeviceFrame +
// UniFlangeDevice), in a floating window mounted by EffectEditorHost.
export default function UniFlangePanel() {
  return <FloatingDevice useStore={useUniFlangeStore} pluginId="uniflange" testId="uniflange-window" halfWidth={350} />
}
