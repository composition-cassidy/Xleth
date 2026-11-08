import React from 'react'
import useGlueCompStore from '../../stores/glueCompStore.js'
import FloatingDevice from '../devices/FloatingDevice.jsx'

// The popped-out Glue comp: the SAME device as the Devices tab (DeviceFrame +
// CompressorFamilyDevice), in a floating window mounted by EffectEditorHost.
export default function GlueCompPanel() {
  return <FloatingDevice useStore={useGlueCompStore} pluginId="glue" testId="glue-window" halfWidth={360} />
}
