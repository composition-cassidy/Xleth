import React from 'react'
import useFilterStore from '../../stores/filterStore.js'
import FloatingDevice from '../devices/FloatingDevice.jsx'

// The popped-out Xleth Filter: the SAME device as the Devices tab (DeviceFrame +
// FilterDevice), in a floating window mounted by EffectEditorHost.
export default function FilterPanel() {
  return <FloatingDevice useStore={useFilterStore} pluginId="xlethfilter" testId="filter-window" halfWidth={700} />
}
