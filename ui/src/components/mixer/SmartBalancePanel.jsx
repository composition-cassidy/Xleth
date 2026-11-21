import React from 'react'
import useSmartBalanceStore from '../../stores/smartBalanceStore.js'
import FloatingDevice from '../devices/FloatingDevice.jsx'

// The popped-out Smart Balance: the SAME device as the Devices tab (DeviceFrame +
// SmartBalanceDevice), in a floating window mounted by EffectEditorHost.
export default function SmartBalancePanel() {
  return <FloatingDevice useStore={useSmartBalanceStore} pluginId="smartbalance" testId="smartbalance-window" halfWidth={620} />
}
