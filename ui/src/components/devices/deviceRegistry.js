// pluginId -> the device body that runs inside DeviceFrame.
//
// Phase 4a migrates the Compressor only. Every other effect still shows the
// shared title bar (activator, fold, name, more, pop-out) and a body that opens
// its existing editor window; Phase 4b moves them here one by one.
//
// Entry shape:
//   Body          — React component ({ target, registerApplied, deviceKey, presentation })
//   width         — device width in px (height is always --device-h)
//   presetType    — preset effectType (defaults to the pluginId)
//   useEditorStore — the editor store whose `target` marks the device as popped out

export const DEVICE_BODIES = {}

export function deviceBodyFor(pluginId) {
  return DEVICE_BODIES[pluginId] ?? null
}
