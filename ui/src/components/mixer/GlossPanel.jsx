import React from 'react'
import useApexStore from '../../stores/apexStore.js'
import FloatingDevice from '../devices/FloatingDevice.jsx'

// The popped-out GLOSS: the SAME device as the Devices tab (DeviceFrame +
// GlossDevice), in a floating window mounted by EffectEditorHost. GLOSS shares
// the APEX store with ApexPanel; the target's `skin` selects which editor draws,
// so an APEX instance never paints here (and vice versa).
export default function GlossPanel() {
  const isGloss = useApexStore((s) => s.target?.skin === 'gloss')
  if (!isGloss) return null
  return <FloatingDevice useStore={useApexStore} pluginId="gloss" testId="gloss-window" halfWidth={140} />
}
