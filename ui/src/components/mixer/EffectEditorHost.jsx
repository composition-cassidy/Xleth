// Global stock-effect editor host.
//
// Stock effect editor panels (Parametric EQ, Compressor, …) are
// `position: fixed`, viewport-anchored floating windows. They must be mounted
// at the app/windowing root — NOT inside the Mixer panel — so they are never a
// DOM descendant of a floating PanelFrame.
//
// A floating PanelFrame positions itself with `transform: translate3d(...)`
// (see PanelFrame.tsx). A CSS transform establishes a containing block for
// `position: fixed` descendants and clips them to the frame's overflow box.
// When these editors used to render inside MixerPanel, opening one from a
// FLOATING Mixer trapped it inside the Mixer's transformed frame; when the
// Mixer was DOCKED (no transform) the same editor roamed freely. Hosting the
// editors here, outside every PanelFrame subtree, makes them behave identically
// no matter where (or whether) the Mixer is mounted.
//
// Ownership model:
//   - The Mixer Chain (EffectModule) and FX Graph node Edit only *request* an
//     editor by calling the relevant store's `open(trackId, engineNodeId,
//     storeKey)`. They never own the editor's DOM placement or lifecycle.
//   - This host owns mounting. Each panel subscribes to its own store and
//     renders nothing until that store has a `target`, so an always-mounted
//     host costs nothing while idle.
//   - Effect identity (trackId, engineNodeId/nodeId, storeKey) lives entirely
//     in the editor stores and is untouched by this move.

import React from 'react'
import EqPanel from './EqPanel.jsx'
import CompressorPanel from './CompressorPanel.jsx'
import LimiterPanel from './LimiterPanel.jsx'
import DistortionPanel from './DistortionPanel.jsx'
import WaveshaperPanel from './WaveshaperPanel.jsx'
import DelayPanel from './DelayPanel.jsx'
import ChorusPanel from './ChorusPanel.jsx'
import FlangerPanel from './FlangerPanel.jsx'
import PhaserPanel from './PhaserPanel.jsx'
import OTTPanel from './OTTPanel.jsx'
import ReverbPanel from './ReverbPanel.jsx'
import TransientProcPanel from './TransientProcPanel.jsx'
import SmartBalancePanel from './SmartBalancePanel.jsx'
import ResonanceSuppressorPanel from './ResonanceSuppressorPanel.jsx'

export default function EffectEditorHost() {
  return (
    <div className="effect-editor-host" data-testid="effect-editor-host">
      <EqPanel />
      <CompressorPanel />
      <LimiterPanel />
      <DistortionPanel />
      <WaveshaperPanel />
      <DelayPanel />
      <ChorusPanel />
      <FlangerPanel />
      <PhaserPanel />
      <OTTPanel />
      <ReverbPanel />
      <TransientProcPanel />
      <SmartBalancePanel />
      <ResonanceSuppressorPanel />
    </div>
  )
}
