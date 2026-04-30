const MAX_SLUG_SECTION_LENGTH = 24

export function slugifyIdPart(value) {
  const slug = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s_.]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')

  return slug.slice(0, MAX_SLUG_SECTION_LENGTH).replace(/-$/g, '')
}

export function seedForNodeTemplate(template) {
  const type = slugifyIdPart(template?.type) || 'node'
  const props = template?.props || {}

  switch (template?.type) {
    case 'knob':
      return joinSeed(type, props.param)
    case 'toggle':
      return joinSeed(type, props.param)
    case 'meter':
      return joinSeed(type, props.source?.slot)
    case 'visualizer':
      return joinSeed('viz', props.source)
    case 'label':
      return joinSeed(type, props.text)
    default:
      return type
  }
}

export function nextId(layout, seed) {
  return nextIdFromIds(collectIds(layout?.root), seed)
}

export function regenerateSubtreeIds(layout, subtree) {
  const usedIds = collectIds(layout?.root)

  function visit(node) {
    if (!node || typeof node !== 'object') return node

    const cleanNode = stripDesignerAnnotations(node)
    const nextNode = {
      ...cleanNode,
      id: nextIdFromIds(usedIds, seedForNodeTemplate(cleanNode)),
    }
    usedIds.add(nextNode.id)

    if (Array.isArray(cleanNode.children)) {
      nextNode.children = cleanNode.children.map(visit)
    }

    return nextNode
  }

  return visit(subtree)
}

function joinSeed(prefix, value) {
  const valueSlug = slugifyIdPart(value)
  return valueSlug ? `${prefix}-${valueSlug}` : prefix
}

function nextIdFromIds(existingIds, seed) {
  const base = slugifyIdPart(seed) || 'node'
  if (!existingIds.has(base)) return base

  let suffix = 2
  while (existingIds.has(`${base}-${suffix}`)) {
    suffix += 1
  }
  return `${base}-${suffix}`
}

function collectIds(node, out = new Set()) {
  if (!node || typeof node !== 'object') return out
  if (node.id) out.add(node.id)
  for (const child of node.children || []) {
    collectIds(child, out)
  }
  return out
}

function stripDesignerAnnotations(node) {
  const {
    _invalid,
    _vizUnavailable,
    _invalidIdx,
    ...cleanNode
  } = node
  return cleanNode
}
