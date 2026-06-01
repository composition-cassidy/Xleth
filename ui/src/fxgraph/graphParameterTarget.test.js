import { describe, expect, it } from 'vitest'
import {
  buildGraphParameterPortId,
  createGraphParameterTarget,
  doesTargetMatchExposedPort,
  getGraphParameterTargetKey,
  getGraphParameterTargetRuntimeKey,
  isGraphParameterTarget,
  normalizeGraphParameterTarget,
  resolveGraphParameterTarget,
} from './graphParameterTarget.js'

function makeEffectNode(id = 'fx-1', effectInstanceId = 'inst-1', pluginId = 'stock:eq') {
  return {
    id,
    type: 'effect',
    position: { x: 0, y: 0 },
    data: {
      effectInstanceId,
      pluginId,
      displayName: 'EQ',
      bypass: false,
      missing: false,
      crashed: false,
      sourceChainSlotIndex: null,
      exposedParameterPorts: [],
    },
  }
}

function makeDescriptor(overrides = {}) {
  return {
    parameterId: 'mix',
    parameterIndex: 2,
    name: 'Mix',
    unit: '%',
    parameterIdIsFallback: false,
    automatable: true,
    readOnly: false,
    ...overrides,
  }
}

function makeValidTarget(overrides = {}) {
  return {
    kind: 'graph-parameter',
    graphNodeId: 'fx-1',
    effectInstanceId: 'inst-1',
    parameterId: 'mix',
    parameterIndexFallback: 2,
    parameterIdIsFallback: false,
    nameSnapshot: 'Mix',
    labelSnapshot: '%',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// isGraphParameterTarget
// ---------------------------------------------------------------------------

describe('isGraphParameterTarget', () => {
  it('returns true for a valid target', () => {
    expect(isGraphParameterTarget(makeValidTarget())).toBe(true)
  })

  it('returns false for null, primitives, and arrays', () => {
    expect(isGraphParameterTarget(null)).toBe(false)
    expect(isGraphParameterTarget(undefined)).toBe(false)
    expect(isGraphParameterTarget('graph-parameter')).toBe(false)
    expect(isGraphParameterTarget([])).toBe(false)
  })

  it('returns false when kind is wrong or absent', () => {
    expect(isGraphParameterTarget({ kind: 'audio', graphNodeId: 'fx-1' })).toBe(false)
    expect(isGraphParameterTarget({ graphNodeId: 'fx-1' })).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// createGraphParameterTarget
// ---------------------------------------------------------------------------

describe('createGraphParameterTarget', () => {
  it('creates a valid target from node, effectInstanceId, and descriptor', () => {
    const node = makeEffectNode()
    const target = createGraphParameterTarget({
      graphNode: node,
      effectInstanceId: 'inst-1',
      descriptor: makeDescriptor(),
    })

    expect(target).toMatchObject({
      kind: 'graph-parameter',
      graphNodeId: 'fx-1',
      effectInstanceId: 'inst-1',
      parameterId: 'mix',
      parameterIndexFallback: 2,
      parameterIdIsFallback: false,
      nameSnapshot: 'Mix',
      labelSnapshot: '%',
    })
  })

  it('does not include trackId when not supplied', () => {
    const target = createGraphParameterTarget({
      graphNode: makeEffectNode(),
      effectInstanceId: 'inst-1',
      descriptor: makeDescriptor(),
    })

    expect(target).not.toHaveProperty('trackId')
  })

  it('includes trackId when supplied', () => {
    const target = createGraphParameterTarget({
      trackId: '7',
      graphNode: makeEffectNode(),
      effectInstanceId: 'inst-1',
      descriptor: makeDescriptor(),
    })

    expect(target.trackId).toBe('7')
  })

  it('sets parameterIndexFallback to null when parameterIndex is absent', () => {
    const target = createGraphParameterTarget({
      graphNode: makeEffectNode(),
      effectInstanceId: 'inst-1',
      descriptor: makeDescriptor({ parameterIndex: undefined }),
    })

    expect(target.parameterIndexFallback).toBeNull()
  })

  it('uses parameterId as nameSnapshot fallback when name is absent', () => {
    const target = createGraphParameterTarget({
      graphNode: makeEffectNode(),
      effectInstanceId: 'inst-1',
      descriptor: makeDescriptor({ name: '' }),
    })

    expect(target.nameSnapshot).toBe('mix')
  })

  it('returns null for missing or invalid arguments', () => {
    expect(createGraphParameterTarget({ graphNode: null, effectInstanceId: 'inst-1', descriptor: makeDescriptor() })).toBeNull()
    expect(createGraphParameterTarget({ graphNode: makeEffectNode(), effectInstanceId: '', descriptor: makeDescriptor() })).toBeNull()
    expect(createGraphParameterTarget({ graphNode: makeEffectNode(), effectInstanceId: 'inst-1', descriptor: null })).toBeNull()
    expect(createGraphParameterTarget({ graphNode: { id: '' }, effectInstanceId: 'inst-1', descriptor: makeDescriptor() })).toBeNull()
    expect(createGraphParameterTarget({ graphNode: makeEffectNode(), effectInstanceId: 'inst-1', descriptor: makeDescriptor({ parameterId: '' }) })).toBeNull()
  })

  it('does not include pluginId field when descriptor and node have no pluginId', () => {
    const node = { id: 'fx-1', type: 'effect', data: {} }
    const target = createGraphParameterTarget({
      graphNode: node,
      effectInstanceId: 'inst-1',
      descriptor: makeDescriptor({ pluginId: undefined }),
    })

    expect(target).not.toHaveProperty('pluginId')
  })

  it('reads pluginId from descriptor first, then node data', () => {
    const node = makeEffectNode('fx-1', 'inst-1', 'stock:eq')
    const fromDescriptor = createGraphParameterTarget({
      graphNode: node,
      effectInstanceId: 'inst-1',
      descriptor: makeDescriptor({ pluginId: 'stock:reverb' }),
    })
    const fromNode = createGraphParameterTarget({
      graphNode: node,
      effectInstanceId: 'inst-1',
      descriptor: makeDescriptor({ pluginId: undefined }),
    })

    expect(fromDescriptor.pluginId).toBe('stock:reverb')
    expect(fromNode.pluginId).toBe('stock:eq')
  })
})

// ---------------------------------------------------------------------------
// normalizeGraphParameterTarget
// ---------------------------------------------------------------------------

describe('normalizeGraphParameterTarget', () => {
  it('round-trips a valid target through normalization', () => {
    const target = makeValidTarget()
    const normalized = normalizeGraphParameterTarget(target)

    expect(normalized).toEqual(expect.objectContaining({
      kind: 'graph-parameter',
      graphNodeId: 'fx-1',
      effectInstanceId: 'inst-1',
      parameterId: 'mix',
      parameterIndexFallback: 2,
      parameterIdIsFallback: false,
      nameSnapshot: 'Mix',
      labelSnapshot: '%',
    }))
  })

  it('returns null for null, non-objects, and wrong kind', () => {
    expect(normalizeGraphParameterTarget(null)).toBeNull()
    expect(normalizeGraphParameterTarget('not-an-object')).toBeNull()
    expect(normalizeGraphParameterTarget({ kind: 'audio' })).toBeNull()
  })

  it('returns null when required fields are missing or empty', () => {
    expect(normalizeGraphParameterTarget({ kind: 'graph-parameter', graphNodeId: '' })).toBeNull()
    expect(normalizeGraphParameterTarget({ kind: 'graph-parameter', graphNodeId: 'fx-1', effectInstanceId: '' })).toBeNull()
    expect(normalizeGraphParameterTarget({ kind: 'graph-parameter', graphNodeId: 'fx-1', effectInstanceId: 'inst-1', parameterId: '' })).toBeNull()
  })

  it('returns null when parameterIdIsFallback is true but parameterIndexFallback is not a finite integer', () => {
    const badTarget = makeValidTarget({
      parameterIdIsFallback: true,
      parameterIndexFallback: null,
    })
    expect(normalizeGraphParameterTarget(badTarget)).toBeNull()
  })

  it('accepts parameterIdIsFallback true when parameterIndexFallback is a finite integer', () => {
    const target = makeValidTarget({
      parameterIdIsFallback: true,
      parameterIndexFallback: 5,
    })
    const normalized = normalizeGraphParameterTarget(target)

    expect(normalized).not.toBeNull()
    expect(normalized.parameterIdIsFallback).toBe(true)
    expect(normalized.parameterIndexFallback).toBe(5)
  })

  it('uses parameterId as nameSnapshot fallback when nameSnapshot is absent', () => {
    const raw = { ...makeValidTarget(), nameSnapshot: '' }
    const normalized = normalizeGraphParameterTarget(raw)

    expect(normalized.nameSnapshot).toBe('mix')
  })

  it('sets labelSnapshot to null when absent or empty', () => {
    const raw = { ...makeValidTarget(), labelSnapshot: '' }
    const normalized = normalizeGraphParameterTarget(raw)

    expect(normalized.labelSnapshot).toBeNull()
  })

  it('strips unknown extra fields (only known fields are preserved)', () => {
    const raw = { ...makeValidTarget(), engineNodeId: 99, someRandom: 'field' }
    const normalized = normalizeGraphParameterTarget(raw)

    expect(normalized).not.toHaveProperty('engineNodeId')
    expect(normalized).not.toHaveProperty('someRandom')
  })

  it('does not include optional identity fields when absent', () => {
    const raw = makeValidTarget()
    delete raw.pluginId
    delete raw.effectKind
    delete raw.pluginFormat
    const normalized = normalizeGraphParameterTarget(raw)

    expect(normalized).not.toHaveProperty('pluginId')
    expect(normalized).not.toHaveProperty('effectKind')
    expect(normalized).not.toHaveProperty('pluginFormat')
  })
})

// ---------------------------------------------------------------------------
// Target keys
// ---------------------------------------------------------------------------

describe('getGraphParameterTargetKey', () => {
  it('produces a stable persisted key without trackId', () => {
    const key = getGraphParameterTargetKey(makeValidTarget())
    expect(key).toBe('graph-param:fx-1:inst-1:mix')
  })

  it('returns null for non-targets', () => {
    expect(getGraphParameterTargetKey(null)).toBeNull()
    expect(getGraphParameterTargetKey({ kind: 'audio' })).toBeNull()
  })

  it('never includes engineNodeId in the key', () => {
    const key = getGraphParameterTargetKey({ ...makeValidTarget(), engineNodeId: 999 })
    expect(key).not.toContain('999')
  })

  it('keys differ for different graphNodeId, effectInstanceId, or parameterId', () => {
    const base = getGraphParameterTargetKey(makeValidTarget())
    expect(getGraphParameterTargetKey(makeValidTarget({ graphNodeId: 'fx-2' }))).not.toBe(base)
    expect(getGraphParameterTargetKey(makeValidTarget({ effectInstanceId: 'inst-2' }))).not.toBe(base)
    expect(getGraphParameterTargetKey(makeValidTarget({ parameterId: 'gain' }))).not.toBe(base)
  })
})

describe('getGraphParameterTargetRuntimeKey', () => {
  it('produces a key that includes trackId', () => {
    const key = getGraphParameterTargetRuntimeKey('7', makeValidTarget())
    expect(key).toBe('graph-param:7:fx-1:inst-1:mix')
  })

  it('accepts numeric trackId', () => {
    const key = getGraphParameterTargetRuntimeKey(7, makeValidTarget())
    expect(key).toBe('graph-param:7:fx-1:inst-1:mix')
  })

  it('returns null for non-targets', () => {
    expect(getGraphParameterTargetRuntimeKey('7', null)).toBeNull()
  })
})

describe('buildGraphParameterPortId', () => {
  it('builds a stable port DOM id', () => {
    expect(buildGraphParameterPortId('fx-1', 'mix')).toBe('gpp:fx-1:mix')
  })

  it('returns null for empty or invalid arguments', () => {
    expect(buildGraphParameterPortId('', 'mix')).toBeNull()
    expect(buildGraphParameterPortId('fx-1', '')).toBeNull()
    expect(buildGraphParameterPortId(null, 'mix')).toBeNull()
    expect(buildGraphParameterPortId('fx-1', null)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// doesTargetMatchExposedPort
// ---------------------------------------------------------------------------

describe('doesTargetMatchExposedPort', () => {
  it('returns true when parameterId matches', () => {
    const target = makeValidTarget()
    const port = { parameterId: 'mix', parameterIndexFallback: 2, nameSnapshot: 'Mix' }
    expect(doesTargetMatchExposedPort(target, port)).toBe(true)
  })

  it('returns false when parameterId does not match', () => {
    const target = makeValidTarget()
    const port = { parameterId: 'gain', parameterIndexFallback: 0, nameSnapshot: 'Gain' }
    expect(doesTargetMatchExposedPort(target, port)).toBe(false)
  })

  it('returns false for invalid target or port', () => {
    expect(doesTargetMatchExposedPort(null, { parameterId: 'mix' })).toBe(false)
    expect(doesTargetMatchExposedPort(makeValidTarget(), null)).toBe(false)
    expect(doesTargetMatchExposedPort({ kind: 'audio' }, { parameterId: 'mix' })).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// resolveGraphParameterTarget
// ---------------------------------------------------------------------------

describe('resolveGraphParameterTarget', () => {
  function makeGraphState(nodes, edges = []) {
    return { schemaVersion: 1, trackId: '7', nodes, edges, viewport: { x: 0, y: 0, zoom: 1 } }
  }

  it('returns ok when target resolves to a matching exposed port', () => {
    const node = {
      ...makeEffectNode(),
      data: {
        ...makeEffectNode().data,
        exposedParameterPorts: [
          { parameterId: 'mix', parameterIndexFallback: 2, nameSnapshot: 'Mix', labelSnapshot: null, parameterIdIsFallback: false, automatable: true, readOnly: false },
        ],
      },
    }
    const graphState = makeGraphState([node])
    const target = makeValidTarget()

    const result = resolveGraphParameterTarget(graphState, target)
    expect(result.status).toBe('ok')
    expect(result.node.id).toBe('fx-1')
    expect(result.exposedPort.parameterId).toBe('mix')
  })

  it('returns invalid_target for a non-target', () => {
    const result = resolveGraphParameterTarget(makeGraphState([]), null)
    expect(result.status).toBe('invalid_target')
  })

  it('returns missing_node when graphNodeId is not found', () => {
    const result = resolveGraphParameterTarget(makeGraphState([]), makeValidTarget())
    expect(result.status).toBe('missing_node')
    expect(result.graphNodeId).toBe('fx-1')
  })

  it('returns missing_effect_instance when effectInstanceId does not match', () => {
    const node = makeEffectNode('fx-1', 'inst-different')
    const result = resolveGraphParameterTarget(makeGraphState([node]), makeValidTarget())
    expect(result.status).toBe('missing_effect_instance')
    expect(result.expectedEffectInstanceId).toBe('inst-1')
    expect(result.foundEffectInstanceId).toBe('inst-different')
  })

  it('returns missing_exposed_port when parameterId is not in exposedParameterPorts', () => {
    const node = makeEffectNode()
    const result = resolveGraphParameterTarget(makeGraphState([node]), makeValidTarget())
    expect(result.status).toBe('missing_exposed_port')
    expect(result.parameterId).toBe('mix')
  })

  it('handles null graphState gracefully', () => {
    const result = resolveGraphParameterTarget(null, makeValidTarget())
    expect(result.status).toBe('missing_node')
  })
})
