import React from 'react'
import useEqStore from '../../stores/eqStore.js'
import FloatingDevice from '../devices/FloatingDevice.jsx'

// The popped-out Parametric EQ: the SAME device as the Devices tab (DeviceFrame +
// EqDevice), in a floating window mounted by EffectEditorHost. The device owns
// a private band store; this default store only tracks which EQ is open.
export default function EqPanel() {
  return <FloatingDevice useStore={useEqStore} pluginId="xletheq" testId="eq-window" halfWidth={500} />
}
