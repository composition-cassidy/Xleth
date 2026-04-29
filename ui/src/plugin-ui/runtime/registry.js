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

export const COMPONENT_REGISTRY = {
  panel:      Panel,
  group:      Group,
  row:        Row,
  column:     Column,
  tabGroup:   TabGroup,
  knob:       KnobNode,
  toggle:     ToggleNode,
  button:     ButtonNode,
  meter:      MeterNode,
  visualizer: VisualizerNode,
  label:      LabelNode,
  spacer:     SpacerNode,
}

export function resolveComponent(type) {
  return COMPONENT_REGISTRY[type] ?? null
}
