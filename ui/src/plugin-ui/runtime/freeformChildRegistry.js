// Registry for all node types that can live as direct children of a freeformLayer.
// Handles both decoration types (decorText/decorLine/decorShape/decal) and
// regular leaf controls (knob/toggle/button/meter/visualizer/label/spacer).
//
// Separated from registry.js to avoid the circular import that would arise
// if FreeformLayerNode imported registry.js (which imports FreeformLayerNode).

import KnobNode       from './components/KnobNode.jsx'
import ToggleNode     from './components/ToggleNode.jsx'
import ButtonNode     from './components/ButtonNode.jsx'
import MeterNode      from './components/MeterNode.jsx'
import VisualizerNode from './components/VisualizerNode.jsx'
import LabelNode      from './components/LabelNode.jsx'
import SpacerNode     from './components/SpacerNode.jsx'
import CompressorCurveNode from './components/CompressorCurveNode.jsx'
import CompressorSliderNode from './components/CompressorSliderNode.jsx'
import CompressorDryWetNode from './components/CompressorDryWetNode.jsx'
import CompressorLookaheadNode from './components/CompressorLookaheadNode.jsx'
import DecorTextNode  from './components/DecorTextNode.jsx'
import DecorLineNode  from './components/DecorLineNode.jsx'
import DecorShapeNode from './components/DecorShapeNode.jsx'
import DecalNode      from './components/DecalNode.jsx'

const FF_CHILD_COMPONENTS = {
  // Leaf controls that can be moved into freeform layers
  knob:       KnobNode,
  toggle:     ToggleNode,
  button:     ButtonNode,
  meter:      MeterNode,
  visualizer: VisualizerNode,
  label:      LabelNode,
  spacer:     SpacerNode,
  compressorCurve:     CompressorCurveNode,
  compressorSlider:    CompressorSliderNode,
  compressorDryWet:    CompressorDryWetNode,
  compressorLookahead: CompressorLookaheadNode,
  // Decoration types native to freeform layers
  decorText:  DecorTextNode,
  decorLine:  DecorLineNode,
  decorShape: DecorShapeNode,
  decal:      DecalNode,
}

export function resolveFreeformChildComponent(type) {
  return FF_CHILD_COMPONENTS[type] ?? null
}
