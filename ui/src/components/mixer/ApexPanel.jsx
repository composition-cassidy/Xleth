import React from 'react'
import useApexStore from '../../stores/apexStore.js'
import FloatingDevice from '../devices/FloatingDevice.jsx'

// The popped-out APEX: the SAME device as the Devices tab (DeviceFrame +
// ApexDevice), in a floating window mounted by EffectEditorHost. APEX shares the
// global store's target with GLOSS; the target's `skin` selects which editor
// draws, so a GLOSS instance never paints here (and vice versa).
export default function ApexPanel() {
  const isApex = useApexStore((s) => s.target != null && s.target.skin !== 'gloss')
  if (!isApex) return null
  return <FloatingDevice useStore={useApexStore} pluginId="apex" testId="apex-window" halfWidth={640} />
}
