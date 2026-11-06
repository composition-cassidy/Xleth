// pluginId -> the device body that runs inside DeviceFrame.
//
// Phase 4a migrates the Compressor only. Every other effect still shows the
// shared title bar (activator, fold, name, more, pop-out) and a body that opens
// its existing editor window; Phase 4b moves them here one by one.
//
// Entry shape:
//   Body          — React component ({ target, registerApplied, deviceKey, presentation })
//   width         — device width in px, or omitted to fit the body (height is always --device-h)
//   presetType    — preset effectType (defaults to the pluginId)
//   useEditorStore — the editor store whose `target` marks the device as popped out

import CompressorDevice from './CompressorDevice.jsx'
import useCompressorStore from '../../stores/compressorStore.js'

export const DEVICE_BODIES = {
  // Width omitted: the frame fits the body's fixed-width sections (the
  // sidechain section folds, so the width follows it).
  compressor: { Body: CompressorDevice, useEditorStore: useCompressorStore },
}

export function deviceBodyFor(pluginId) {
  return DEVICE_BODIES[pluginId] ?? null
}
