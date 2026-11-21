// Component registry — maps layout node type strings to React components.
// Only types listed here can be mounted. Any type absent from this map renders
// an UnknownNodePlaceholder instead of crashing.

import Panel       from './components/Panel.jsx'
import Group       from './components/Group.jsx'
import Row         from './components/Row.jsx'
import Column      from './components/Column.jsx'
import TabGroup    from './components/TabGroup.jsx'
import KnobNode    from './components/KnobNode.jsx'
import ToggleNode  from './components/ToggleNode.jsx'
import ButtonNode  from './components/ButtonNode.jsx'
import MeterNode   from './components/MeterNode.jsx'
import VisualizerNode from './components/VisualizerNode.jsx'
import LabelNode   from './components/LabelNode.jsx'
import SpacerNode  from './components/SpacerNode.jsx'
import CompressorCurveNode from './components/CompressorCurveNode.jsx'
import CompressorSliderNode from './components/CompressorSliderNode.jsx'
import CompressorHSliderNode from './components/CompressorHSliderNode.jsx'
import CompressorDryWetNode from './components/CompressorDryWetNode.jsx'
import CompressorLookaheadNode from './components/CompressorLookaheadNode.jsx'
// Freeform-A additions:
import FreeformLayerNode from './components/FreeformLayerNode.jsx'
import DecorTextNode     from './components/DecorTextNode.jsx'
import DecorLineNode     from './components/DecorLineNode.jsx'
import DecorShapeNode    from './components/DecorShapeNode.jsx'
import DecalNode         from './components/DecalNode.jsx'

export const COMPONENT_REGISTRY = {
  panel:         Panel,
  group:         Group,
  row:           Row,
  column:        Column,
  tabGroup:      TabGroup,
  knob:          KnobNode,
  toggle:        ToggleNode,
  button:        ButtonNode,
  meter:         MeterNode,
  visualizer:    VisualizerNode,
  label:         LabelNode,
  spacer:        SpacerNode,
  compressorCurve:     CompressorCurveNode,
  compressorSlider:    CompressorSliderNode,
  compressorHSlider:   CompressorHSliderNode,
  compressorDryWet:    CompressorDryWetNode,
  compressorLookahead: CompressorLookaheadNode,
  // Freeform-A:
  freeformLayer: FreeformLayerNode,
  decorText:     DecorTextNode,
  decorLine:     DecorLineNode,
  decorShape:    DecorShapeNode,
  decal:         DecalNode,
}

export function resolveComponent(type) {
  return COMPONENT_REGISTRY[type] ?? null
}
