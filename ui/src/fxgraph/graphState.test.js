import { describe, expect, it } from 'vitest'
import {
  GRAPH_STATE_SCHEMA_VERSION,
  GRAPH_MACRO_NODE_TYPE,
  GRAPH_MACRO_OUTPUT_PORT,
  GRAPH_MUTATION_REJECTION,
  PROTECTED_NODE_TYPES,
  addGraphEffectNode,
  addGraphMacroNode,
  buildExposedParameterPort,
  canConnectGraphNodes,
  canRemoveGraphNode,
  connectGraphNodes,
  createEmptyGraphState,
  disconnectGraphEdge,
  hasEquivalentGraphEdge,
  isProtectedGraphNodeType,
  loadGraphState,
  normalizeExposedParameterPorts,
  renameGraphMacroNode,
  removeGraphNode,
  saveGraphState,
  toggleExposedParameterPort,
  updateGraphMacroValue,
  validateGraphState,
  validateGraphStateForEditing,
} from './graphState.js'
import {
  analyzeLinearGraphTopology,
  buildLinearGraphTopologyPayload,
} from './linearGraphTopology.js'

function makeEffectNode(id = 'fx-1') {
  return {
    id,
    type: 'effect',
    data: {
      effectInstanceId: 'effect-1',
      pluginId: 'stock:eq',
      displayName: 'EQ',
      bypass: false,
      missing: false,
      crashed: false,
      sourceChainSlotIndex: 0,
    },
  }
}

function makeValidGraphState(overrides = {}) {
  return {
    schemaVersion: GRAPH_STATE_SCHEMA_VERSION,
    trackId: '7',
    nodes: [
      { id: 'input', type: 'trackInput' },
      makeEffectNode(),
      { id: 'output', type: 'trackOutput' },
    ],
    edges: [
      {
        id: 'edge-1',
        sourceNodeId: 'input',
        sourcePort: 'audio',
        targetNodeId: 'fx-1',
        targetPort: 'audioIn',
        type: 'audio',
      },
      {
        id: 'edge-2',
        sourceNodeId: 'fx-1',
        sourcePort: 'audioOut',
        targetNodeId: 'output',
        targetPort: 'audio',
        type: 'audio',
      },
    ],
    ...overrides,
  }
}

describe('graphState schema validation', () => {
  it('returns missing for absent graphState', () => {
    expect(validateGraphState(undefined, '7')).toEqual({
      status: 'missing',
      graphState: null,
      warnings: [],
    })
  })

  it('returns missing for null graphState', () => {
    expect(validateGraphState(null, '7')).toEqual({
      status: 'missing',
      graphState: null,
      warnings: [],
    })
  })

  it('marks non-object graphState invalid', () => {
    expect(validateGraphState('nope', '7')).toMatchObject({
      status: 'invalid',
      graphState: null,
      reason: 'non_object_graph_state',
    })
  })

  it('marks missing schemaVersion invalid', () => {
    expect(validateGraphState({ trackId: '7', nodes: [], edges: [] }, '7')).toMatchObject({
      status: 'invalid',
      reason: 'missing_schema_version',
    })
  })

  it('accepts schemaVersion 1 for an empty graphState', () => {
    const result = validateGraphState(createEmptyGraphState('7'), '7')

    expect(result).toMatchObject({
      status: 'valid',
      graphState: {
        schemaVersion: 1,
        trackId: '7',
        nodes: [],
        edges: [],
        viewport: { x: 0, y: 0, zoom: 1 },
      },
      warnings: [],
    })
  })

  it('preserves future schemaVersion as unsupported future raw JSON', () => {
    const raw = { schemaVersion: 2, trackId: '7', nodes: 'future', edges: 'future' }
    const result = validateGraphState(raw, '7')

    expect(result).toMatchObject({
      status: 'future',
      graphState: null,
      raw,
      reason: 'future_schema_version',
    })
  })

  it('marks trackId mismatch invalid', () => {
    expect(validateGraphState(createEmptyGraphState('8'), '7')).toMatchObject({
      status: 'invalid',
      reason: 'track_id_mismatch',
    })
  })

  it('preserves unknown node types as unknown nodes', () => {
    const result = validateGraphState(makeValidGraphState({
      nodes: [
        { id: 'input', type: 'trackInput' },
        { id: 'mystery', type: 'sidechainMagic', data: { gain: 0.5 } },
        { id: 'output', type: 'trackOutput' },
      ],
      edges: [],
    }), '7')

    expect(result.status).toBe('valid')
    expect(result.graphState.nodes[1]).toEqual({
      id: 'mystery',
      type: 'unknown',
      data: {
        _preservedType: 'sidechainMagic',
        _preservedData: { gain: 0.5 },
      },
      position: { x: 260, y: 0 },
    })
    expect(result.warnings[0].code).toBe('unknownNodeType')
  })

  it('preserves unknown edge types as unknown edges', () => {
    const result = validateGraphState(makeValidGraphState({
      edges: [
        {
          id: 'edge-unknown',
          sourceNodeId: 'input',
          sourcePort: 'audio',
          targetNodeId: 'output',
          targetPort: 'audio',
          type: 'cv',
        },
      ],
    }), '7')

    expect(result.status).toBe('valid')
    expect(result.graphState.edges[0]).toMatchObject({
      id: 'edge-unknown',
      type: 'unknown',
      _preservedType: 'cv',
    })
    expect(result.warnings[0].code).toBe('unknownEdgeType')
  })

  it('marks invalid edge references invalid', () => {
    expect(validateGraphState(makeValidGraphState({
      edges: [
        {
          id: 'dangling',
          sourceNodeId: 'input',
          sourcePort: 'audio',
          targetNodeId: 'missing',
          targetPort: 'audio',
          type: 'audio',
        },
      ],
    }), '7')).toMatchObject({
      status: 'invalid',
      reason: 'invalid_edge_reference',
    })
  })

  it('marks duplicate node IDs invalid', () => {
    expect(validateGraphState(makeValidGraphState({
      nodes: [
        { id: 'input', type: 'trackInput' },
        { id: 'input', type: 'trackOutput' },
      ],
      edges: [],
    }), '7')).toMatchObject({
      status: 'invalid',
      reason: 'duplicate_node_id',
    })
  })

  it('accepts a valid trackInput/effect/trackOutput audio graph', () => {
    const result = validateGraphState(makeValidGraphState(), '7')

    expect(result.status).toBe('valid')
    expect(result.graphState.nodes).toHaveLength(3)
    expect(result.graphState.edges).toHaveLength(2)
  })

  it('preserves valid node positions during normalization', () => {
    const result = validateGraphState(makeValidGraphState({
      nodes: [
        { id: 'input', type: 'trackInput', position: { x: 12.5, y: 4 } },
        { ...makeEffectNode(), position: { x: 314.25, y: 99.5 } },
        { id: 'output', type: 'trackOutput', position: { x: 640, y: 8 } },
      ],
    }), '7')

    expect(result.status).toBe('valid')
    expect(result.graphState.nodes.map((node) => [node.id, node.position])).toEqual([
      ['input', { x: 12.5, y: 4 }],
      ['fx-1', { x: 314.25, y: 99.5 }],
      ['output', { x: 640, y: 8 }],
    ])
  })

  it('assigns deterministic positions when node positions are missing', () => {
    const result = validateGraphState(makeValidGraphState(), '7')

    expect(result.status).toBe('valid')
    expect(result.graphState.nodes.map((node) => [node.id, node.position])).toEqual([
      ['input', { x: 0, y: 0 }],
      ['fx-1', { x: 260, y: 0 }],
      ['output', { x: 520, y: 0 }],
    ])
    expect(result.warnings).toEqual([])
  })

  it('repairs invalid node positions without regenerating node or edge IDs', () => {
    const raw = makeValidGraphState({
      nodes: [
        { id: 'input', type: 'trackInput', position: null },
        { ...makeEffectNode(), position: { x: Number.NaN, y: 42 } },
        { id: 'output', type: 'trackOutput', position: { x: 'bad', y: undefined } },
      ],
    })
    const result = validateGraphState(raw, '7')

    expect(result.status).toBe('valid')
    expect(result.graphState.nodes.map((node) => node.id)).toEqual(['input', 'fx-1', 'output'])
    expect(result.graphState.edges.map((edge) => edge.id)).toEqual(['edge-1', 'edge-2'])
    expect(result.graphState.nodes.map((node) => node.position)).toEqual([
      { x: 0, y: 0 },
      { x: 260, y: 0 },
      { x: 520, y: 0 },
    ])
    expect(result.warnings.map((warning) => warning.code)).toEqual([
      'invalidNodePosition',
      'invalidNodePosition',
      'invalidNodePosition',
    ])
  })

  it('preserves extra graphState and node data fields while normalizing layout', () => {
    const result = validateGraphState(makeValidGraphState({
      layoutMetadata: { source: 'test' },
      nodes: [
        { id: 'input', type: 'trackInput', data: { protected: true } },
        {
          ...makeEffectNode(),
          data: {
            ...makeEffectNode().data,
            lane: 'upper',
          },
        },
        { id: 'output', type: 'trackOutput', data: { protected: true } },
      ],
    }), '7')

    expect(result.status).toBe('valid')
    expect(result.graphState.layoutMetadata).toEqual({ source: 'test' })
    expect(result.graphState.nodes[0].data).toEqual({ protected: true })
    expect(result.graphState.nodes[1].data.lane).toBe('upper')
    expect(result.graphState.nodes[2].data).toEqual({ protected: true })
  })

  it('normalizes macro nodes with repaired labels and clamped values', () => {
    const result = validateGraphState(makeValidGraphState({
      nodes: [
        { id: 'input', type: 'trackInput' },
        { id: 'macro-a', type: GRAPH_MACRO_NODE_TYPE, data: { label: '  Macro Wow  ', normalizedValue: 1.5, lane: 'top' } },
        { id: 'macro-b', type: GRAPH_MACRO_NODE_TYPE, data: { label: '   ', normalizedValue: -0.2 } },
        { id: 'output', type: 'trackOutput' },
      ],
      edges: [],
    }), '7')

    expect(result.status).toBe('valid')
    expect(result.graphState.nodes[1]).toMatchObject({
      id: 'macro-a',
      type: GRAPH_MACRO_NODE_TYPE,
      data: { label: 'Macro Wow', normalizedValue: 1, lane: 'top' },
    })
    expect(result.graphState.nodes[2]).toMatchObject({
      id: 'macro-b',
      type: GRAPH_MACRO_NODE_TYPE,
      data: { label: 'Macro', normalizedValue: 0 },
    })
    expect(saveGraphState(result.graphState).nodes[1].data.normalizedValue).toBe(1)
  })

  it('drops malformed saved audio edges involving macro nodes', () => {
    const result = validateGraphState(makeValidGraphState({
      nodes: [
        { id: 'input', type: 'trackInput' },
        { id: 'macro-a', type: GRAPH_MACRO_NODE_TYPE, data: { label: 'Macro 1', normalizedValue: 0.5 } },
        { id: 'output', type: 'trackOutput' },
      ],
      edges: [
        {
          id: 'bad-audio',
          sourceNodeId: 'macro-a',
          sourcePort: GRAPH_MACRO_OUTPUT_PORT,
          targetNodeId: 'output',
          targetPort: 'audio',
          type: 'audio',
        },
      ],
    }), '7')

    expect(result.status).toBe('valid')
    expect(result.graphState.edges).toEqual([])
    expect(result.warnings.map((warning) => warning.code)).toContain('invalidMacroAudioEdge')
  })

  it('defaults missing exposedParameterPorts to an empty array on effect nodes', () => {
    const result = validateGraphState(makeValidGraphState(), '7')

    expect(result.status).toBe('valid')
    expect(result.graphState.nodes.find((node) => node.id === 'fx-1').data.exposedParameterPorts)
      .toEqual([])
  })

  it('normalizes exposedParameterPorts and preserves only small target snapshots', () => {
    const result = validateGraphState(makeValidGraphState({
      nodes: [
        { id: 'input', type: 'trackInput' },
        {
          ...makeEffectNode(),
          data: {
            ...makeEffectNode().data,
            exposedParameterPorts: [
              {
                parameterId: 'mix',
                parameterIndex: 2,
                nameSnapshot: 'Mix',
                labelSnapshot: '%',
                parameterIdIsFallback: false,
                automatable: true,
                readOnly: false,
                normalizedValue: 0.5,
              },
            ],
          },
        },
        { id: 'output', type: 'trackOutput' },
      ],
    }), '7')

    expect(result.status).toBe('valid')
    expect(result.graphState.nodes[1].data.exposedParameterPorts).toEqual([
      {
        parameterId: 'mix',
        parameterIndexFallback: 2,
        nameSnapshot: 'Mix',
        labelSnapshot: '%',
        parameterIdIsFallback: false,
        automatable: true,
        readOnly: false,
      },
    ])
  })

  it('drops malformed and duplicate exposedParameterPorts safely', () => {
    const result = validateGraphState(makeValidGraphState({
      nodes: [
        { id: 'input', type: 'trackInput' },
        {
          ...makeEffectNode(),
          data: {
            ...makeEffectNode().data,
            exposedParameterPorts: [
              null,
              { parameterId: '', nameSnapshot: 'Missing id' },
              { parameterId: 'gain', parameterIndex: 'bad', nameSnapshot: '' },
              { parameterId: 'gain', parameterIndex: 4, nameSnapshot: 'Gain duplicate' },
            ],
          },
        },
        { id: 'output', type: 'trackOutput' },
      ],
    }), '7')

    expect(result.status).toBe('valid')
    expect(result.graphState.nodes[1].data.exposedParameterPorts).toEqual([
      {
        parameterId: 'gain',
        parameterIndexFallback: null,
        nameSnapshot: 'gain',
        labelSnapshot: null,
        parameterIdIsFallback: false,
        automatable: null,
        readOnly: null,
      },
    ])
    expect(result.warnings.map((warning) => warning.code)).toEqual([
      'invalidExposedParameterPort',
      'invalidExposedParameterPort',
      'duplicateExposedParameterPort',
    ])
  })

  it('preserves a valid viewport during normalization', () => {
    const result = validateGraphState(makeValidGraphState({
      viewport: { x: -44.5, y: 22.25, zoom: 2.5 },
    }), '7')

    expect(result.status).toBe('valid')
    expect(result.graphState.viewport).toEqual({ x: -44.5, y: 22.25, zoom: 2.5 })
  })

  it('defaults viewport when absent', () => {
    const result = validateGraphState(makeValidGraphState(), '7')

    expect(result.graphState.viewport).toEqual({ x: 0, y: 0, zoom: 1 })
  })

  it('defaults and clamps invalid viewport safely', () => {
    const invalidZoom = validateGraphState(makeValidGraphState({
      viewport: { x: 'bad', y: 12, zoom: -2 },
    }), '7')
    const clampedZoom = validateGraphState(makeValidGraphState({
      viewport: { x: 4, y: 8, zoom: 99 },
    }), '7')

    expect(invalidZoom.graphState.viewport).toEqual({ x: 0, y: 12, zoom: 1 })
    expect(clampedZoom.graphState.viewport).toEqual({ x: 4, y: 8, zoom: 4 })
  })

  it('repairs partial viewport data with deterministic defaults', () => {
    const result = validateGraphState(makeValidGraphState({
      viewport: { x: -12 },
    }), '7')

    expect(result.status).toBe('valid')
    expect(result.graphState.viewport).toEqual({ x: -12, y: 0, zoom: 1 })
  })

  it('marks audio cycles invalid', () => {
    expect(validateGraphState(makeValidGraphState({
      edges: [
        {
          id: 'edge-1',
          sourceNodeId: 'input',
          sourcePort: 'audio',
          targetNodeId: 'fx-1',
          targetPort: 'audioIn',
          type: 'audio',
        },
        {
          id: 'edge-2',
          sourceNodeId: 'fx-1',
          sourcePort: 'audioOut',
          targetNodeId: 'input',
          targetPort: 'audio',
          type: 'audio',
        },
      ],
    }), '7')).toMatchObject({
      status: 'invalid',
      reason: 'cycle_detected',
    })
  })

  it('logs structured warnings with an FXG prefix when requested', () => {
    const messages = []
    const result = loadGraphState(undefined, '7', {
      fxMode: 'graph',
      logger: (...args) => messages.push(args),
    })

    expect(result.status).toBe('missing')
    expect(messages[0][0]).toContain('[FXG] track 7')
    expect(messages[0][1].code).toBe('missingGraphState')
  })

  it('saveGraphState returns a JSON clone', () => {
    const graphState = {
      ...createEmptyGraphState('7'),
      viewport: { x: -12, y: 34, zoom: 1.5 },
    }
    const saved = saveGraphState(graphState)

    expect(saved).toEqual(graphState)
    expect(saved).not.toBe(graphState)
  })
})

describe('FXG.3-c-b linear graph topology payload', () => {
  it('marks Track Input to Track Output as supported', () => {
    const graphState = makeValidGraphState({
      nodes: [
        { id: 'input', type: 'trackInput' },
        { id: 'output', type: 'trackOutput' },
      ],
      edges: [
        {
          id: 'edge-direct',
          sourceNodeId: 'input',
          sourcePort: 'audio',
          targetNodeId: 'output',
          targetPort: 'audio',
          type: 'audio',
        },
      ],
    })

    expect(analyzeLinearGraphTopology(graphState)).toMatchObject({
      ok: true,
      reason: 'linear_supported',
      pathNodeIds: ['input', 'output'],
      effectNodeIds: [],
    })
  })

  it('marks Track Input to Effect to Track Output as supported', () => {
    expect(analyzeLinearGraphTopology(makeValidGraphState())).toMatchObject({
      ok: true,
      reason: 'linear_supported',
      pathNodeIds: ['input', 'fx-1', 'output'],
      effectNodeIds: ['fx-1'],
      pathEffectInstanceIds: ['effect-1'],
    })
  })

  it('marks Track Input to Effect A to Effect B to Track Output as supported', () => {
    const fxB = makeEffectNode('fx-2')
    fxB.data = {
      ...fxB.data,
      effectInstanceId: 'effect-2',
      pluginId: 'stock:delay',
      displayName: 'Delay',
    }

    const graphState = makeValidGraphState({
      nodes: [
        { id: 'input', type: 'trackInput' },
        makeEffectNode('fx-1'),
        fxB,
        { id: 'output', type: 'trackOutput' },
      ],
      edges: [
        {
          id: 'edge-1',
          sourceNodeId: 'input',
          sourcePort: 'audio',
          targetNodeId: 'fx-1',
          targetPort: 'audioIn',
          type: 'audio',
        },
        {
          id: 'edge-2',
          sourceNodeId: 'fx-1',
          sourcePort: 'audioOut',
          targetNodeId: 'fx-2',
          targetPort: 'audioIn',
          type: 'audio',
        },
        {
          id: 'edge-3',
          sourceNodeId: 'fx-2',
          sourcePort: 'audioOut',
          targetNodeId: 'output',
          targetPort: 'audio',
          type: 'audio',
        },
      ],
    })

    expect(analyzeLinearGraphTopology(graphState)).toMatchObject({
      ok: true,
      reason: 'linear_supported',
      pathNodeIds: ['input', 'fx-1', 'fx-2', 'output'],
      effectNodeIds: ['fx-1', 'fx-2'],
      pathEffectInstanceIds: ['effect-1', 'effect-2'],
    })
  })

  it('marks active fan-out as nonlinear_deferred', () => {
    const graphState = makeValidGraphState({
      edges: [
        ...makeValidGraphState().edges,
        {
          id: 'edge-parallel',
          sourceNodeId: 'input',
          sourcePort: 'audio',
          targetNodeId: 'output',
          targetPort: 'audio',
          type: 'audio',
        },
      ],
    })

    expect(analyzeLinearGraphTopology(graphState)).toMatchObject({
      ok: false,
      reason: 'nonlinear_deferred',
    })
  })

  it('marks active fan-in as nonlinear_deferred', () => {
    const fxB = makeEffectNode('fx-2')
    fxB.data = {
      ...fxB.data,
      effectInstanceId: 'effect-2',
      pluginId: 'stock:delay',
    }

    const graphState = makeValidGraphState({
      nodes: [
        { id: 'input', type: 'trackInput' },
        makeEffectNode('fx-1'),
        fxB,
        { id: 'output', type: 'trackOutput' },
      ],
      edges: [
        {
          id: 'edge-1',
          sourceNodeId: 'input',
          sourcePort: 'audio',
          targetNodeId: 'fx-1',
          targetPort: 'audioIn',
          type: 'audio',
        },
        {
          id: 'edge-2',
          sourceNodeId: 'fx-1',
          sourcePort: 'audioOut',
          targetNodeId: 'output',
          targetPort: 'audio',
          type: 'audio',
        },
        {
          id: 'edge-3',
          sourceNodeId: 'fx-2',
          sourcePort: 'audioOut',
          targetNodeId: 'output',
          targetPort: 'audio',
          type: 'audio',
        },
      ],
    })

    expect(analyzeLinearGraphTopology(graphState)).toMatchObject({
      ok: false,
      reason: 'nonlinear_deferred',
    })
  })

  it('ignores disconnected effect nodes when the active path is linear', () => {
    const disconnected = makeEffectNode('fx-disconnected')
    disconnected.data = {
      ...disconnected.data,
      effectInstanceId: 'effect-disconnected',
      pluginId: 'stock:chorus',
    }

    const graphState = makeValidGraphState({
      nodes: [
        ...makeValidGraphState().nodes,
        disconnected,
      ],
    })

    const payload = buildLinearGraphTopologyPayload(graphState)
    expect(payload.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ nodeId: 'fx-disconnected', effectInstanceId: 'effect-disconnected' }),
    ]))
    expect(analyzeLinearGraphTopology(graphState)).toMatchObject({
      ok: true,
      reason: 'linear_supported',
      effectNodeIds: ['fx-1'],
    })
  })

  it('rejects missing Track Input or Track Output', () => {
    expect(analyzeLinearGraphTopology(makeValidGraphState({
      nodes: [
        makeEffectNode('fx-1'),
        { id: 'output', type: 'trackOutput' },
      ],
      edges: [],
    }))).toMatchObject({
      ok: false,
      reason: 'invalid_track_io_multiplicity',
    })

    expect(analyzeLinearGraphTopology(makeValidGraphState({
      nodes: [
        { id: 'input', type: 'trackInput' },
        makeEffectNode('fx-1'),
      ],
      edges: [],
    }))).toMatchObject({
      ok: false,
      reason: 'invalid_track_io_multiplicity',
    })
  })
})

// ---------------------------------------------------------------------------
// FXG.2C-d — graph mutation architecture guards
// ---------------------------------------------------------------------------

function makeGuardGraphState(overrides = {}) {
  return {
    schemaVersion: GRAPH_STATE_SCHEMA_VERSION,
    trackId: '5',
    nodes: [
      { id: 'in', type: 'trackInput', position: { x: 0, y: 0 }, data: {} },
      {
        id: 'fx-a',
        type: 'effect',
        position: { x: 260, y: 0 },
        data: {
          effectInstanceId: 'inst-a',
          pluginId: 'stock:eq',
          displayName: 'EQ',
          bypass: false,
          missing: false,
          crashed: false,
          sourceChainSlotIndex: 0,
        },
      },
      { id: 'out', type: 'trackOutput', position: { x: 520, y: 0 }, data: {} },
    ],
    edges: [
      {
        id: 'e-1',
        sourceNodeId: 'in',
        sourcePort: 'audio',
        targetNodeId: 'fx-a',
        targetPort: 'audioIn',
        type: 'audio',
      },
      {
        id: 'e-2',
        sourceNodeId: 'fx-a',
        sourcePort: 'audioOut',
        targetNodeId: 'out',
        targetPort: 'audio',
        type: 'audio',
      },
    ],
    viewport: { x: -10, y: 5, zoom: 1.5 },
    customField: 'preserved',
    ...overrides,
  }
}

function makeNodeDraft(overrides = {}) {
  return {
    effectInstanceId: 'new-inst',
    pluginId: 'stock:reverb',
    displayName: 'Reverb',
    bypass: false,
    missing: false,
    crashed: false,
    ...overrides,
  }
}

describe('graph mutation architecture guards', () => {
  describe('PROTECTED_NODE_TYPES', () => {
    it('is a frozen array containing trackInput and trackOutput', () => {
      expect(Array.isArray(PROTECTED_NODE_TYPES)).toBe(true)
      expect(Object.isFrozen(PROTECTED_NODE_TYPES)).toBe(true)
      expect(PROTECTED_NODE_TYPES).toEqual(['trackInput', 'trackOutput'])
    })
  })

  describe('isProtectedGraphNodeType', () => {
    it('returns true for trackInput', () => {
      expect(isProtectedGraphNodeType('trackInput')).toBe(true)
    })

    it('returns true for trackOutput', () => {
      expect(isProtectedGraphNodeType('trackOutput')).toBe(true)
    })

    it('returns false for effect', () => {
      expect(isProtectedGraphNodeType('effect')).toBe(false)
    })

    it('returns false for macro', () => {
      expect(isProtectedGraphNodeType(GRAPH_MACRO_NODE_TYPE)).toBe(false)
    })

    it('returns false for unknown', () => {
      expect(isProtectedGraphNodeType('unknown')).toBe(false)
    })

    it('returns false for arbitrary strings', () => {
      expect(isProtectedGraphNodeType('sidechain')).toBe(false)
      expect(isProtectedGraphNodeType('')).toBe(false)
    })
  })

  describe('validateGraphStateForEditing', () => {
    it('rejects null', () => {
      expect(validateGraphStateForEditing(null)).toEqual({
        ok: false,
        reason: GRAPH_MUTATION_REJECTION.INVALID_GRAPH_STATE,
      })
    })

    it('rejects non-object', () => {
      expect(validateGraphStateForEditing('nope')).toEqual({
        ok: false,
        reason: GRAPH_MUTATION_REJECTION.INVALID_GRAPH_STATE,
      })
    })

    it('rejects when nodes is not an array', () => {
      expect(validateGraphStateForEditing({ nodes: null, edges: [] })).toEqual({
        ok: false,
        reason: GRAPH_MUTATION_REJECTION.INVALID_GRAPH_STATE,
      })
    })

    it('rejects when edges is not an array', () => {
      expect(validateGraphStateForEditing({ nodes: [], edges: null })).toEqual({
        ok: false,
        reason: GRAPH_MUTATION_REJECTION.INVALID_GRAPH_STATE,
      })
    })

    it('accepts a valid graphState', () => {
      expect(validateGraphStateForEditing(makeGuardGraphState())).toEqual({ ok: true })
    })
  })

  describe('hasEquivalentGraphEdge', () => {
    it('returns false when no edges match', () => {
      expect(hasEquivalentGraphEdge(makeGuardGraphState(), 'in', 'out')).toBe(false)
    })

    it('returns true when an equivalent edge exists', () => {
      expect(hasEquivalentGraphEdge(makeGuardGraphState(), 'in', 'fx-a', 'audio')).toBe(true)
    })

    it('returns false when source differs', () => {
      expect(hasEquivalentGraphEdge(makeGuardGraphState(), 'out', 'fx-a', 'audio')).toBe(false)
    })

    it('returns false when target differs', () => {
      expect(hasEquivalentGraphEdge(makeGuardGraphState(), 'in', 'out', 'audio')).toBe(false)
    })

    it('returns false when edge type differs', () => {
      expect(hasEquivalentGraphEdge(makeGuardGraphState(), 'in', 'fx-a', 'cv')).toBe(false)
    })

    it('returns false for null graphState', () => {
      expect(hasEquivalentGraphEdge(null, 'in', 'fx-a')).toBe(false)
    })
  })

  describe('canRemoveGraphNode', () => {
    it('rejects when graphState is null', () => {
      expect(canRemoveGraphNode(null, 'fx-a')).toEqual({
        ok: false,
        reason: GRAPH_MUTATION_REJECTION.INVALID_GRAPH_STATE,
      })
    })

    it('rejects when node does not exist', () => {
      expect(canRemoveGraphNode(makeGuardGraphState(), 'missing-id')).toEqual({
        ok: false,
        reason: GRAPH_MUTATION_REJECTION.MISSING_NODE,
      })
    })

    it('rejects protected trackInput', () => {
      expect(canRemoveGraphNode(makeGuardGraphState(), 'in')).toEqual({
        ok: false,
        reason: GRAPH_MUTATION_REJECTION.PROTECTED_NODE,
      })
    })

    it('rejects protected trackOutput', () => {
      expect(canRemoveGraphNode(makeGuardGraphState(), 'out')).toEqual({
        ok: false,
        reason: GRAPH_MUTATION_REJECTION.PROTECTED_NODE,
      })
    })

    it('accepts removing an effect node', () => {
      expect(canRemoveGraphNode(makeGuardGraphState(), 'fx-a')).toEqual({ ok: true })
    })

    it('accepts removing a macro node', () => {
      const gs = makeGuardGraphState({
        nodes: [
          ...makeGuardGraphState().nodes,
          { id: 'macro-a', type: GRAPH_MACRO_NODE_TYPE, position: { x: 80, y: 120 }, data: { label: 'Macro 1', normalizedValue: 0 } },
        ],
      })
      expect(canRemoveGraphNode(gs, 'macro-a')).toEqual({ ok: true })
    })
  })

  describe('canConnectGraphNodes', () => {
    it('rejects when graphState is null', () => {
      expect(canConnectGraphNodes(null, 'in', 'out')).toMatchObject({
        ok: false,
        reason: GRAPH_MUTATION_REJECTION.INVALID_GRAPH_STATE,
      })
    })

    it('rejects missing source node', () => {
      expect(canConnectGraphNodes(makeGuardGraphState(), 'missing', 'out')).toEqual({
        ok: false,
        reason: GRAPH_MUTATION_REJECTION.MISSING_SOURCE_NODE,
      })
    })

    it('rejects missing target node', () => {
      expect(canConnectGraphNodes(makeGuardGraphState(), 'in', 'missing')).toEqual({
        ok: false,
        reason: GRAPH_MUTATION_REJECTION.MISSING_TARGET_NODE,
      })
    })

    it('rejects self-connection', () => {
      expect(canConnectGraphNodes(makeGuardGraphState(), 'fx-a', 'fx-a')).toEqual({
        ok: false,
        reason: GRAPH_MUTATION_REJECTION.SELF_CONNECTION,
      })
    })

    it('rejects trackOutput as source', () => {
      expect(canConnectGraphNodes(makeGuardGraphState(), 'out', 'fx-a')).toEqual({
        ok: false,
        reason: GRAPH_MUTATION_REJECTION.INVALID_SOURCE_TYPE,
      })
    })

    it('rejects trackInput as target', () => {
      expect(canConnectGraphNodes(makeGuardGraphState(), 'fx-a', 'in')).toEqual({
        ok: false,
        reason: GRAPH_MUTATION_REJECTION.INVALID_TARGET_TYPE,
      })
    })

    it('rejects unknown source node type', () => {
      const gs = makeGuardGraphState({
        nodes: [
          { id: 'in', type: 'trackInput', position: { x: 0, y: 0 }, data: {} },
          { id: 'mystery', type: 'unknown', position: { x: 260, y: 0 }, data: { _preservedType: 'sidechain', _preservedData: {} } },
          { id: 'out', type: 'trackOutput', position: { x: 520, y: 0 }, data: {} },
        ],
        edges: [],
      })
      expect(canConnectGraphNodes(gs, 'mystery', 'out')).toEqual({
        ok: false,
        reason: GRAPH_MUTATION_REJECTION.UNKNOWN_NODE_TYPE,
      })
    })

    it('rejects unknown target node type', () => {
      const gs = makeGuardGraphState({
        nodes: [
          { id: 'in', type: 'trackInput', position: { x: 0, y: 0 }, data: {} },
          { id: 'mystery', type: 'unknown', position: { x: 260, y: 0 }, data: { _preservedType: 'sidechain', _preservedData: {} } },
          { id: 'out', type: 'trackOutput', position: { x: 520, y: 0 }, data: {} },
        ],
        edges: [],
      })
      expect(canConnectGraphNodes(gs, 'in', 'mystery')).toEqual({
        ok: false,
        reason: GRAPH_MUTATION_REJECTION.UNKNOWN_NODE_TYPE,
      })
    })

    it('rejects macro endpoints for audio connections', () => {
      const gs = makeGuardGraphState({
        nodes: [
          ...makeGuardGraphState().nodes,
          { id: 'macro-a', type: GRAPH_MACRO_NODE_TYPE, position: { x: 80, y: 120 }, data: { label: 'Macro 1', normalizedValue: 0.25 } },
        ],
        edges: [],
      })

      expect(canConnectGraphNodes(gs, 'macro-a', 'out')).toEqual({
        ok: false,
        reason: GRAPH_MUTATION_REJECTION.INVALID_SOURCE_TYPE,
      })
      expect(canConnectGraphNodes(gs, 'in', 'macro-a')).toEqual({
        ok: false,
        reason: GRAPH_MUTATION_REJECTION.INVALID_TARGET_TYPE,
      })
      expect(connectGraphNodes(gs, { sourceNodeId: 'macro-a', targetNodeId: 'out' })).toEqual({
        ok: false,
        reason: GRAPH_MUTATION_REJECTION.INVALID_SOURCE_TYPE,
      })
    })

    it('rejects duplicate equivalent edge', () => {
      expect(canConnectGraphNodes(makeGuardGraphState(), 'in', 'fx-a')).toEqual({
        ok: false,
        reason: GRAPH_MUTATION_REJECTION.DUPLICATE_EDGE,
      })
    })

    it('rejects a connection that would create a cycle', () => {
      const fxBNode = {
        id: 'fx-b',
        type: 'effect',
        position: { x: 390, y: 0 },
        data: {
          effectInstanceId: 'inst-b',
          pluginId: 'stock:comp',
          displayName: 'Comp',
          bypass: false,
          missing: false,
          crashed: false,
          sourceChainSlotIndex: null,
        },
      }
      const gs = makeGuardGraphState({
        nodes: [
          { id: 'in', type: 'trackInput', position: { x: 0, y: 0 }, data: {} },
          makeGuardGraphState().nodes[1],  // fx-a
          fxBNode,
          { id: 'out', type: 'trackOutput', position: { x: 650, y: 0 }, data: {} },
        ],
        edges: [
          {
            id: 'e-fwd',
            sourceNodeId: 'fx-a',
            sourcePort: 'audioOut',
            targetNodeId: 'fx-b',
            targetPort: 'audioIn',
            type: 'audio',
          },
        ],
      })
      // fx-b → fx-a would form a cycle (fx-a → fx-b already exists)
      expect(canConnectGraphNodes(gs, 'fx-b', 'fx-a')).toEqual({
        ok: false,
        reason: GRAPH_MUTATION_REJECTION.CYCLE_DETECTED,
      })
    })

    it('accepts a valid linear connection from trackInput to effect', () => {
      const gs = makeGuardGraphState({ edges: [] })
      expect(canConnectGraphNodes(gs, 'in', 'fx-a')).toEqual({ ok: true })
    })

    it('accepts a valid linear connection from effect to trackOutput', () => {
      const gs = makeGuardGraphState({ edges: [] })
      expect(canConnectGraphNodes(gs, 'fx-a', 'out')).toEqual({ ok: true })
    })
  })

  describe('addGraphEffectNode', () => {
    it('rejects null graphState', () => {
      expect(addGraphEffectNode(null, makeNodeDraft())).toMatchObject({
        ok: false,
        reason: GRAPH_MUTATION_REJECTION.INVALID_GRAPH_STATE,
      })
    })

    it('rejects invalid nodeDraft (missing effectInstanceId)', () => {
      expect(addGraphEffectNode(makeGuardGraphState(), { ...makeNodeDraft(), effectInstanceId: '' })).toEqual({
        ok: false,
        reason: GRAPH_MUTATION_REJECTION.INVALID_NODE_DRAFT,
      })
    })

    it('rejects invalid nodeDraft (missing pluginId)', () => {
      expect(addGraphEffectNode(makeGuardGraphState(), { ...makeNodeDraft(), pluginId: '' })).toEqual({
        ok: false,
        reason: GRAPH_MUTATION_REJECTION.INVALID_NODE_DRAFT,
      })
    })

    it('rejects non-object nodeDraft', () => {
      expect(addGraphEffectNode(makeGuardGraphState(), null)).toEqual({
        ok: false,
        reason: GRAPH_MUTATION_REJECTION.INVALID_NODE_DRAFT,
      })
    })

    it('adds a node with the correct type and data shape', () => {
      const result = addGraphEffectNode(makeGuardGraphState(), makeNodeDraft())

      expect(result.ok).toBe(true)
      const newNode = result.graphState.nodes.at(-1)
      expect(newNode.type).toBe('effect')
      expect(newNode.data.effectInstanceId).toBe('new-inst')
      expect(newNode.data.pluginId).toBe('stock:reverb')
      expect(newNode.data.displayName).toBe('Reverb')
      expect(newNode.data.bypass).toBe(false)
      expect(newNode.data.missing).toBe(false)
      expect(newNode.data.crashed).toBe(false)
      expect(newNode.data.sourceChainSlotIndex).toBeNull()
    })

    it('auto-positions the new node before trackOutput', () => {
      const result = addGraphEffectNode(makeGuardGraphState(), makeNodeDraft())

      expect(result.ok).toBe(true)
      const newNode = result.graphState.nodes.at(-1)
      // trackOutput is at index 2 (0-based), so insertIndex=2, x = 2*260 = 520
      expect(newNode.position).toEqual({ x: 520, y: 0 })
    })

    it('uses provided position when valid', () => {
      const result = addGraphEffectNode(
        makeGuardGraphState(),
        { ...makeNodeDraft(), position: { x: 100, y: 50 } },
      )

      expect(result.ok).toBe(true)
      expect(result.graphState.nodes.at(-1).position).toEqual({ x: 100, y: 50 })
    })

    it('preserves viewport, existing nodes, and extra graphState fields', () => {
      const gs = makeGuardGraphState()
      const result = addGraphEffectNode(gs, makeNodeDraft())

      expect(result.ok).toBe(true)
      expect(result.graphState.viewport).toEqual(gs.viewport)
      expect(result.graphState.customField).toBe('preserved')
      expect(result.graphState.nodes).toHaveLength(gs.nodes.length + 1)
      expect(result.graphState.edges).toHaveLength(gs.edges.length)
    })

    it('does not mutate the input graphState', () => {
      const gs = makeGuardGraphState()
      const originalNodeCount = gs.nodes.length
      addGraphEffectNode(gs, makeNodeDraft())

      expect(gs.nodes).toHaveLength(originalNodeCount)
    })

    it('uses provided idFactory for the node id', () => {
      let counter = 0
      const idFactory = () => `fixed-id-${counter++}`
      const result = addGraphEffectNode(makeGuardGraphState(), makeNodeDraft(), { idFactory })

      expect(result.ok).toBe(true)
      expect(result.graphState.nodes.at(-1).id).toBe('fixed-id-0')
    })
  })

  describe('macro node helpers', () => {
    it('adds a normalized macro node without mutating the input graphState', () => {
      const gs = makeGuardGraphState()
      const result = addGraphMacroNode(gs, {
        label: '  Brightness  ',
        normalizedValue: 2,
        position: { x: 123, y: 456 },
      }, { idFactory: () => 'macro-new' })

      expect(result.ok).toBe(true)
      expect(result.graphState.nodes.at(-1)).toEqual({
        id: 'macro-new',
        type: GRAPH_MACRO_NODE_TYPE,
        position: { x: 123, y: 456 },
        data: { label: 'Brightness', normalizedValue: 1 },
      })
      expect(gs.nodes.find((node) => node.id === 'macro-new')).toBeUndefined()
    })

    it('defaults macro label, value, and position deterministically', () => {
      const result = addGraphMacroNode(makeGuardGraphState(), {}, { idFactory: () => 'macro-default' })

      expect(result.ok).toBe(true)
      expect(result.graphState.nodes.at(-1)).toMatchObject({
        id: 'macro-default',
        type: GRAPH_MACRO_NODE_TYPE,
        position: { x: 520, y: 0 },
        data: { label: 'Macro 1', normalizedValue: 0 },
      })
    })

    it('updates macro values with clamping and rejects non-macro nodes', () => {
      const added = addGraphMacroNode(makeGuardGraphState(), {}, { idFactory: () => 'macro-a' })
      const updated = updateGraphMacroValue(added.graphState, 'macro-a', 1.25)

      expect(updated.ok).toBe(true)
      expect(updated.graphState.nodes.find((node) => node.id === 'macro-a').data.normalizedValue).toBe(1)
      expect(updateGraphMacroValue(added.graphState, 'fx-a', 0.5)).toEqual({
        ok: false,
        reason: GRAPH_MUTATION_REJECTION.UNKNOWN_NODE_TYPE,
      })
      expect(updateGraphMacroValue(added.graphState, 'macro-a', Number.NaN)).toEqual({
        ok: false,
        reason: GRAPH_MUTATION_REJECTION.INVALID_MACRO_VALUE,
      })
    })

    it('renames macro nodes and removes them with incident edges', () => {
      const added = addGraphMacroNode(makeGuardGraphState(), {}, { idFactory: () => 'macro-a' })
      const renamed = renameGraphMacroNode(added.graphState, 'macro-a', '  Energy  ')
      const removed = removeGraphNode({
        ...renamed.graphState,
        edges: [
          {
            id: 'param-edge',
            sourceNodeId: 'macro-a',
            sourcePort: GRAPH_MACRO_OUTPUT_PORT,
            targetNodeId: 'fx-a',
            targetPort: 'param:mix',
            type: 'parameter',
          },
        ],
      }, 'macro-a')

      expect(renamed.ok).toBe(true)
      expect(renamed.graphState.nodes.find((node) => node.id === 'macro-a').data.label).toBe('Energy')
      expect(removed.ok).toBe(true)
      expect(removed.graphState.nodes.find((node) => node.id === 'macro-a')).toBeUndefined()
      expect(removed.graphState.edges).toEqual([])
    })
  })

  describe('removeGraphNode', () => {
    it('rejects removing trackInput', () => {
      expect(removeGraphNode(makeGuardGraphState(), 'in')).toEqual({
        ok: false,
        reason: GRAPH_MUTATION_REJECTION.PROTECTED_NODE,
      })
    })

    it('rejects removing trackOutput', () => {
      expect(removeGraphNode(makeGuardGraphState(), 'out')).toEqual({
        ok: false,
        reason: GRAPH_MUTATION_REJECTION.PROTECTED_NODE,
      })
    })

    it('rejects removing a missing node', () => {
      expect(removeGraphNode(makeGuardGraphState(), 'no-such-node')).toEqual({
        ok: false,
        reason: GRAPH_MUTATION_REJECTION.MISSING_NODE,
      })
    })

    it('removes an effect node and its incident edges', () => {
      const result = removeGraphNode(makeGuardGraphState(), 'fx-a')

      expect(result.ok).toBe(true)
      expect(result.graphState.nodes.find((n) => n.id === 'fx-a')).toBeUndefined()
      expect(result.graphState.edges.every(
        (e) => e.sourceNodeId !== 'fx-a' && e.targetNodeId !== 'fx-a',
      )).toBe(true)
    })

    it('preserves other nodes, viewport, and extra fields', () => {
      const gs = makeGuardGraphState()
      const result = removeGraphNode(gs, 'fx-a')

      expect(result.ok).toBe(true)
      expect(result.graphState.nodes.find((n) => n.id === 'in')).toBeDefined()
      expect(result.graphState.nodes.find((n) => n.id === 'out')).toBeDefined()
      expect(result.graphState.viewport).toEqual(gs.viewport)
      expect(result.graphState.customField).toBe('preserved')
    })

    it('does not mutate the input graphState', () => {
      const gs = makeGuardGraphState()
      const originalNodeCount = gs.nodes.length
      removeGraphNode(gs, 'fx-a')

      expect(gs.nodes).toHaveLength(originalNodeCount)
    })
  })

  describe('toggleExposedParameterPort', () => {
    it('builds a compact exposed parameter port from a live descriptor', () => {
      expect(buildExposedParameterPort({
        parameterId: 'feedback',
        parameterIndex: 7,
        name: 'Feedback',
        unit: '%',
        parameterIdIsFallback: true,
        automatable: true,
        readOnly: false,
        normalizedValue: 0.4,
      })).toEqual({
        parameterId: 'feedback',
        parameterIndexFallback: 7,
        nameSnapshot: 'Feedback',
        labelSnapshot: '%',
        parameterIdIsFallback: true,
        automatable: true,
        readOnly: false,
      })
    })

    it('toggles a writable parameter as an exposed input port without mutating the graphState', () => {
      const gs = makeGuardGraphState()
      const result = toggleExposedParameterPort(gs, 'fx-a', {
        parameterId: 'mix',
        parameterIndex: 1,
        name: 'Mix',
        automatable: true,
        readOnly: false,
      })

      expect(result.ok).toBe(true)
      expect(result.exposed).toBe(true)
      expect(result.graphState).not.toBe(gs)
      expect(gs.nodes[1].data.exposedParameterPorts).toBeUndefined()
      expect(result.graphState.nodes[1].data.exposedParameterPorts).toEqual([
        {
          parameterId: 'mix',
          parameterIndexFallback: 1,
          nameSnapshot: 'Mix',
          labelSnapshot: null,
          parameterIdIsFallback: false,
          automatable: true,
          readOnly: false,
        },
      ])
    })

    it('toggles an already exposed parameter off', () => {
      const exposed = toggleExposedParameterPort(makeGuardGraphState(), 'fx-a', {
        parameterId: 'mix',
        parameterIndex: 1,
        name: 'Mix',
      })
      const hidden = toggleExposedParameterPort(exposed.graphState, 'fx-a', {
        parameterId: 'mix',
        parameterIndex: 1,
        name: 'Mix',
      })

      expect(hidden.ok).toBe(true)
      expect(hidden.exposed).toBe(false)
      expect(hidden.graphState.nodes[1].data.exposedParameterPorts).toEqual([])
    })

    it('rejects protected I/O nodes and malformed descriptors', () => {
      expect(toggleExposedParameterPort(makeGuardGraphState(), 'in', {
        parameterId: 'mix',
        parameterIndex: 1,
      })).toEqual({ ok: false, reason: GRAPH_MUTATION_REJECTION.PROTECTED_NODE })
      expect(toggleExposedParameterPort(makeGuardGraphState(), 'fx-a', {
        parameterId: '',
        parameterIndex: 1,
      })).toEqual({ ok: false, reason: GRAPH_MUTATION_REJECTION.INVALID_PARAMETER_PORT })
    })
  })

  describe('connectGraphNodes', () => {
    it('rejects a non-object connectionDraft', () => {
      expect(connectGraphNodes(makeGuardGraphState(), null)).toEqual({
        ok: false,
        reason: GRAPH_MUTATION_REJECTION.INVALID_CONNECTION_DRAFT,
      })
    })

    it('delegates topology rejections to canConnectGraphNodes', () => {
      expect(connectGraphNodes(makeGuardGraphState(), { sourceNodeId: 'fx-a', targetNodeId: 'fx-a' })).toEqual({
        ok: false,
        reason: GRAPH_MUTATION_REJECTION.SELF_CONNECTION,
      })
    })

    it('infers ports for trackInput → effect using existing convention', () => {
      const gs = makeGuardGraphState({ edges: [] })
      const result = connectGraphNodes(gs, { sourceNodeId: 'in', targetNodeId: 'fx-a' })

      expect(result.ok).toBe(true)
      const newEdge = result.graphState.edges.at(-1)
      expect(newEdge.sourcePort).toBe('audio')
      expect(newEdge.targetPort).toBe('audioIn')
      expect(newEdge.type).toBe('audio')
    })

    it('infers ports for effect → trackOutput using existing convention', () => {
      const gs = makeGuardGraphState({ edges: [] })
      const result = connectGraphNodes(gs, { sourceNodeId: 'fx-a', targetNodeId: 'out' })

      expect(result.ok).toBe(true)
      const newEdge = result.graphState.edges.at(-1)
      expect(newEdge.sourcePort).toBe('audioOut')
      expect(newEdge.targetPort).toBe('audio')
    })

    it('preserves viewport, nodes, and extra graphState fields', () => {
      const gs = makeGuardGraphState({ edges: [] })
      const result = connectGraphNodes(gs, { sourceNodeId: 'in', targetNodeId: 'fx-a' })

      expect(result.ok).toBe(true)
      expect(result.graphState.nodes).toHaveLength(gs.nodes.length)
      expect(result.graphState.viewport).toEqual(gs.viewport)
      expect(result.graphState.customField).toBe('preserved')
    })

    it('does not mutate the input graphState', () => {
      const gs = makeGuardGraphState({ edges: [] })
      const originalEdgeCount = gs.edges.length
      connectGraphNodes(gs, { sourceNodeId: 'in', targetNodeId: 'fx-a' })

      expect(gs.edges).toHaveLength(originalEdgeCount)
    })

    it('uses provided idFactory for the edge id', () => {
      const gs = makeGuardGraphState({ edges: [] })
      const idFactory = () => 'my-edge-id'
      const result = connectGraphNodes(gs, { sourceNodeId: 'in', targetNodeId: 'fx-a' }, { idFactory })

      expect(result.ok).toBe(true)
      expect(result.graphState.edges.at(-1).id).toBe('my-edge-id')
    })
  })

  describe('disconnectGraphEdge', () => {
    it('rejects null graphState', () => {
      expect(disconnectGraphEdge(null, 'e-1')).toMatchObject({
        ok: false,
        reason: GRAPH_MUTATION_REJECTION.INVALID_GRAPH_STATE,
      })
    })

    it('rejects empty edgeId', () => {
      expect(disconnectGraphEdge(makeGuardGraphState(), '')).toEqual({
        ok: false,
        reason: GRAPH_MUTATION_REJECTION.MISSING_EDGE,
      })
    })

    it('rejects a non-existent edgeId', () => {
      expect(disconnectGraphEdge(makeGuardGraphState(), 'no-such-edge')).toEqual({
        ok: false,
        reason: GRAPH_MUTATION_REJECTION.MISSING_EDGE,
      })
    })

    it('removes the correct edge by id', () => {
      const result = disconnectGraphEdge(makeGuardGraphState(), 'e-1')

      expect(result.ok).toBe(true)
      expect(result.graphState.edges.find((e) => e.id === 'e-1')).toBeUndefined()
      expect(result.graphState.edges.find((e) => e.id === 'e-2')).toBeDefined()
    })

    it('preserves nodes, other edges, viewport, and extra fields', () => {
      const gs = makeGuardGraphState()
      const result = disconnectGraphEdge(gs, 'e-1')

      expect(result.ok).toBe(true)
      expect(result.graphState.nodes).toHaveLength(gs.nodes.length)
      expect(result.graphState.edges).toHaveLength(gs.edges.length - 1)
      expect(result.graphState.viewport).toEqual(gs.viewport)
      expect(result.graphState.customField).toBe('preserved')
    })

    it('does not mutate the input graphState', () => {
      const gs = makeGuardGraphState()
      const originalEdgeCount = gs.edges.length
      disconnectGraphEdge(gs, 'e-1')

      expect(gs.edges).toHaveLength(originalEdgeCount)
    })
  })
})

// ---------------------------------------------------------------------------
// FXG.4-c — Parameter Target Binding Contract
// ---------------------------------------------------------------------------

describe('FXG.4-c exposed parameter port normalization', () => {
  it('upgrades old FXG.4-b parameterIndex field to parameterIndexFallback silently', () => {
    const ports = normalizeExposedParameterPorts([
      { parameterId: 'mix', parameterIndex: 3, nameSnapshot: 'Mix' },
    ])

    expect(ports).toHaveLength(1)
    expect(ports[0].parameterIndexFallback).toBe(3)
    expect(ports[0]).not.toHaveProperty('parameterIndex')
  })

  it('prefers parameterIndexFallback over parameterIndex when both are present', () => {
    const ports = normalizeExposedParameterPorts([
      { parameterId: 'gain', parameterIndexFallback: 5, parameterIndex: 2, nameSnapshot: 'Gain' },
    ])

    expect(ports[0].parameterIndexFallback).toBe(5)
  })

  it('sets parameterIndexFallback to null when index is absent or invalid', () => {
    const ports = normalizeExposedParameterPorts([
      { parameterId: 'freq', nameSnapshot: 'Freq' },
      { parameterId: 'q', parameterIndex: 'bad', nameSnapshot: 'Q' },
    ])

    expect(ports[0].parameterIndexFallback).toBeNull()
    expect(ports[1].parameterIndexFallback).toBeNull()
  })

  it('deduplicates by parameterId, keeping only the first occurrence', () => {
    const ports = normalizeExposedParameterPorts([
      { parameterId: 'mix', parameterIndexFallback: 1, nameSnapshot: 'Mix' },
      { parameterId: 'mix', parameterIndexFallback: 99, nameSnapshot: 'Mix duplicate' },
    ])

    expect(ports).toHaveLength(1)
    expect(ports[0].parameterIndexFallback).toBe(1)
  })
})

describe('FXG.4-c edge schema', () => {
  it('old audio edges normalize without a kind field collision', () => {
    const result = validateGraphState(makeValidGraphState(), '7')

    expect(result.status).toBe('valid')
    const edge = result.graphState.edges[0]
    expect(edge.type).toBe('audio')
  })

  it('unknown edge types are preserved as unknown without disrupting audio edges', () => {
    const result = validateGraphState(makeValidGraphState({
      edges: [
        {
          id: 'edge-unknown',
          sourceNodeId: 'input',
          sourcePort: 'audio',
          targetNodeId: 'output',
          targetPort: 'audio',
          type: 'cv',
        },
      ],
    }), '7')

    expect(result.status).toBe('valid')
    expect(result.graphState.edges[0].type).toBe('unknown')
    expect(result.graphState.edges[0]._preservedType).toBe('cv')
  })

  it('parameter edges normalize safely as type parameter without becoming unknown', () => {
    const result = validateGraphState(makeValidGraphState({
      nodes: [
        { id: 'input', type: 'trackInput' },
        { id: 'output', type: 'trackOutput' },
      ],
      edges: [
        {
          id: 'p-edge-1',
          sourceNodeId: 'input',
          sourcePort: 'audio',
          targetNodeId: 'output',
          targetPort: 'audio',
          type: 'parameter',
        },
      ],
    }), '7')

    expect(result.status).toBe('valid')
    const edge = result.graphState.edges[0]
    expect(edge.type).toBe('parameter')
    expect(edge).not.toHaveProperty('_preservedType')
  })

  it('parameter edges with targetParameter are preserved through normalization', () => {
    const targetParam = {
      kind: 'graph-parameter',
      graphNodeId: 'output',
      effectInstanceId: 'inst-1',
      parameterId: 'mix',
      parameterIndexFallback: null,
      parameterIdIsFallback: false,
      nameSnapshot: 'Mix',
      labelSnapshot: null,
    }
    const result = validateGraphState(makeValidGraphState({
      nodes: [
        { id: 'input', type: 'trackInput' },
        { id: 'output', type: 'trackOutput' },
      ],
      edges: [
        {
          id: 'p-edge-1',
          sourceNodeId: 'input',
          sourcePort: 'audio',
          targetNodeId: 'output',
          targetPort: 'audio',
          type: 'parameter',
          targetParameter: targetParam,
        },
      ],
    }), '7')

    expect(result.status).toBe('valid')
    expect(result.graphState.edges[0].targetParameter).toEqual(targetParam)
  })

  it('audio routing topology ignores parameter edges', () => {
    const fxB = makeEffectNode('fx-2')
    fxB.data = { ...fxB.data, effectInstanceId: 'effect-2', pluginId: 'stock:delay', displayName: 'Delay' }
    const graphState = makeValidGraphState({
      nodes: [
        { id: 'input', type: 'trackInput' },
        makeEffectNode('fx-1'),
        fxB,
        { id: 'output', type: 'trackOutput' },
      ],
      edges: [
        {
          id: 'e-1', sourceNodeId: 'input', sourcePort: 'audio',
          targetNodeId: 'fx-1', targetPort: 'audioIn', type: 'audio',
        },
        {
          id: 'e-2', sourceNodeId: 'fx-1', sourcePort: 'audioOut',
          targetNodeId: 'output', targetPort: 'audio', type: 'audio',
        },
        {
          id: 'p-edge', sourceNodeId: 'fx-2', sourcePort: 'audio',
          targetNodeId: 'fx-1', targetPort: 'audioIn', type: 'parameter',
        },
      ],
    })

    const { analyzeLinearGraphTopology } = require('./linearGraphTopology.js')
    const analysis = analyzeLinearGraphTopology(graphState)

    expect(analysis.ok).toBe(true)
    expect(analysis.effectNodeIds).toEqual(['fx-1'])
  })

  it('audio routing topology excludes macro control nodes', () => {
    const graphState = makeValidGraphState({
      nodes: [
        { id: 'input', type: 'trackInput' },
        { id: 'macro-a', type: GRAPH_MACRO_NODE_TYPE, data: { label: 'Macro 1', normalizedValue: 0.5 } },
        makeEffectNode('fx-1'),
        { id: 'output', type: 'trackOutput' },
      ],
    })

    const payload = buildLinearGraphTopologyPayload(graphState)
    expect(payload.nodes.map((node) => node.nodeId)).toEqual(['input', 'fx-1', 'output'])
    expect(payload.nodes.find((node) => node.nodeId === 'macro-a')).toBeUndefined()
    expect(analyzeLinearGraphTopology(graphState)).toMatchObject({
      ok: true,
      effectNodeIds: ['fx-1'],
    })
  })

  it('connectGraphNodes rejects non-audio edge type from the user connect path', () => {
    const gs = makeGuardGraphState({ edges: [] })
    const result = connectGraphNodes(gs, {
      sourceNodeId: 'in',
      targetNodeId: 'fx-a',
      edgeType: 'parameter',
    })

    expect(result.ok).toBe(false)
    expect(result.reason).toBe(GRAPH_MUTATION_REJECTION.INVALID_CONNECTION_DRAFT)
  })

  it('connectGraphNodes defaults to audio and creates only audio edges', () => {
    const gs = makeGuardGraphState({ edges: [] })
    const result = connectGraphNodes(gs, { sourceNodeId: 'in', targetNodeId: 'fx-a' })

    expect(result.ok).toBe(true)
    expect(result.graphState.edges.at(-1).type).toBe('audio')
  })

  it('hasAudioCycle ignores parameter edges so parameter edges do not create false cycle detection', () => {
    const result = validateGraphState(makeValidGraphState({
      edges: [
        ...makeValidGraphState().edges,
        {
          id: 'p-back',
          sourceNodeId: 'fx-1',
          sourcePort: 'audioOut',
          targetNodeId: 'input',
          targetPort: 'audio',
          type: 'parameter',
        },
      ],
    }), '7')

    expect(result.status).toBe('valid')
  })
})
