// pluginId -> the device body that runs inside DeviceFrame.
//
// Phase 4a migrated the Compressor; Phase 4b moves the rest here one by one.
// An effect not listed still shows the shared title bar (activator, fold, name,
// more, pop-out) and a body that opens its existing editor window.
//
// Entry shape:
//   Body          — React component ({ target, registerApplied, deviceKey, presentation })
//   width         — device width in px, or omitted to fit the body (height is always --device-h)
//   presetType    — preset effectType (defaults to the pluginId)
//   useEditorStore — the editor store whose `target` marks the device as popped out

import CompressorDevice from './CompressorDevice.jsx'
import useCompressorStore from '../../stores/compressorStore.js'
import DelayDevice from './DelayDevice.jsx'
import useDelayStore from '../../stores/delayStore.js'

export const DEVICE_BODIES = {
  // Width omitted: the frame fits the body's fixed-width sections (the
  // sidechain section folds, so the width follows it).
  compressor: { Body: CompressorDevice, useEditorStore: useCompressorStore },
  delay: { Body: DelayDevice, useEditorStore: useDelayStore },
}

export function deviceBodyFor(pluginId) {
  return DEVICE_BODIES[pluginId] ?? null
}
