import React from 'react'
import useLimiterStore from '../../stores/limiterStore.js'
import FloatingDevice from '../devices/FloatingDevice.jsx'

// The popped-out Limiter: the SAME device as the Devices tab (DeviceFrame +
// LimiterDevice), in a floating window mounted by EffectEditorHost.
export default function LimiterPanel() {
  return <FloatingDevice useStore={useLimiterStore} pluginId="limiter" testId="limiter-window" halfWidth={400} />
}
