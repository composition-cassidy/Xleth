import React from 'react'
import useTransientProcStore from '../../stores/transientProcStore.js'
import FloatingDevice from '../devices/FloatingDevice.jsx'

// The popped-out Transient Processor: the SAME device as the Devices tab
// (DeviceFrame + TransientProcDevice), in a floating window mounted by
// EffectEditorHost.
export default function TransientProcPanel() {
  return <FloatingDevice useStore={useTransientProcStore} pluginId="transientproc" testId="transientproc-window" halfWidth={330} />
}
