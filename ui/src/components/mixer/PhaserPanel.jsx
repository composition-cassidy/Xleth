import React from 'react'
import usePhaserStore from '../../stores/phaserStore.js'
import FloatingDevice from '../devices/FloatingDevice.jsx'

// The popped-out Phaser: the SAME device as the Devices tab (DeviceFrame +
// PhaserDevice), in a floating window mounted by EffectEditorHost.
export default function PhaserPanel() {
  return <FloatingDevice useStore={usePhaserStore} pluginId="phaser" testId="phaser-window" halfWidth={450} />
}
