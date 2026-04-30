// Narrow registry for freeform decoration leaf types.
// Separated from registry.js to avoid the circular import that would arise
// if FreeformLayerNode imported registry.js (which imports FreeformLayerNode).

import DecorTextNode  from './components/DecorTextNode.jsx'
import DecorLineNode  from './components/DecorLineNode.jsx'
import DecorShapeNode from './components/DecorShapeNode.jsx'
import DecalNode      from './components/DecalNode.jsx'

const DECOR_COMPONENTS = {
  decorText:  DecorTextNode,
  decorLine:  DecorLineNode,
  decorShape: DecorShapeNode,
  decal:      DecalNode,
}

export function resolveDecorComponent(type) {
  return DECOR_COMPONENTS[type] ?? null
}
