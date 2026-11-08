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
import FlangerDevice from './FlangerDevice.jsx'
import useFlangerStore from '../../stores/flangerStore.js'
import UniFlangeDevice from './UniFlangeDevice.jsx'
import useUniFlangeStore from '../../stores/uniFlangeStore.js'
import ReverbDevice from './ReverbDevice.jsx'
import useReverbStore from '../../stores/reverbStore.js'
import LimiterDevice from './LimiterDevice.jsx'
import useLimiterStore from '../../stores/limiterStore.js'
import EqDevice from './EqDevice.jsx'
import useEqStore from '../../stores/eqStore.js'
import { FetDevice, GlueDevice, OptoDevice, VariMuDevice } from './CompressorFamilyDevice.jsx'
import useGlueCompStore from '../../stores/glueCompStore.js'
import useOptoCompStore from '../../stores/optoCompStore.js'
import useFetCompStore from '../../stores/fetCompStore.js'
import useVariMuCompStore from '../../stores/variMuCompStore.js'
import GlossDevice from './GlossDevice.jsx'
import ApexDevice from './ApexDevice.jsx'
import OverdoneDevice from './OverdoneDevice.jsx'
import useOverdoneStore from '../../stores/overdoneStore.js'
import TransientProcDevice from './TransientProcDevice.jsx'
import useTransientProcStore from '../../stores/transientProcStore.js'
import ResonanceSuppressorDevice from './ResonanceSuppressorDevice.jsx'
import useResonanceSuppressorStore from '../../stores/resonanceSuppressorStore.js'
import useApexStore from '../../stores/apexStore.js'

export const DEVICE_BODIES = {
  // Width omitted: the frame fits the body's fixed-width sections (the
  // sidechain section folds, so the width follows it).
  compressor: { Body: CompressorDevice, useEditorStore: useCompressorStore },
  delay: { Body: DelayDevice, useEditorStore: useDelayStore },
  flanger: { Body: FlangerDevice, useEditorStore: useFlangerStore },
  uniflange: { Body: UniFlangeDevice, useEditorStore: useUniFlangeStore },
  reverb: { Body: ReverbDevice, useEditorStore: useReverbStore },
  limiter: { Body: LimiterDevice, useEditorStore: useLimiterStore },
  xletheq: { Body: EqDevice, useEditorStore: useEqStore },
  // The character compressors on CompressorCore share CompressorFamilyDevice.
  glue: { Body: GlueDevice, useEditorStore: useGlueCompStore },
  opto: { Body: OptoDevice, useEditorStore: useOptoCompStore },
  fet: { Body: FetDevice, useEditorStore: useFetCompStore },
  varimu: { Body: VariMuDevice, useEditorStore: useVariMuCompStore },
  // GLOSS is an APEX-class processor under its own pluginId: it shares the APEX
  // editor store (the target's `skin` says which editor owns it) and the APEX
  // preset adapter, which captures the curves as well as the scalar params.
  gloss: { Body: GlossDevice, useEditorStore: useApexStore, presetType: 'apex' },
  // APEX owns a private store per device (curves, band, curve undo); the global
  // useApexStore only marks the popped-out instance, as for GLOSS.
  apex: { Body: ApexDevice, useEditorStore: useApexStore },
  overdone: { Body: OverdoneDevice, useEditorStore: useOverdoneStore },
  transientproc: { Body: TransientProcDevice, useEditorStore: useTransientProcStore },
  resonancesuppressor: { Body: ResonanceSuppressorDevice, useEditorStore: useResonanceSuppressorStore },
}

export function deviceBodyFor(pluginId) {
  return DEVICE_BODIES[pluginId] ?? null
}
