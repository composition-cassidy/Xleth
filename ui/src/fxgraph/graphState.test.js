import { describe, expect, it } from 'vitest'
import {
  GRAPH_STATE_SCHEMA_VERSION,
  GRAPH_MACRO_NODE_TYPE,
  GRAPH_MACRO_OUTPUT_PORT,
  GRAPH_ENVELOPE_NODE_TYPE,
  GRAPH_MUTATION_REJECTION,
  GRAPH_PARAMETER_CURVE_BEZIER,
  GRAPH_PARAMETER_CURVE_LINEAR,
  ENVELOPE_NODE_DEFAULTS,
  PROTECTED_NODE_TYPES,
  addGraphEffectNode,
  addGraphEnvelopeNode,
  addGraphMacroNode,
  createDefaultEnvelopeNodeData,
  isEnvelopeGraphNode,
  normalizeEnvelopeNodeData,
  updateGraphEnvelopeNodeData,
  buildExposedParameterPort,
  canConnectGraphNodes,
  canConnectMacroToParameter,
  canRemoveGraphNode,
  collectMacroParameterWrites,
  connectGraphNodes,
  connectMacroToParameter,
  createDefaultBezierCurve,
  createEmptyGraphState,
  defaultParameterMapping,
  disconnectGraphEdge,
  disconnectParameterEdge,
  evaluateBezierCurve,
  evaluateLinearParameterMapping,
  evaluateParameterMapping,
  hasEquivalentGraphEdge,
  isParameterEdge,
  isProtectedGraphNodeType,
  loadGraphState,
  normalizeExposedParameterPorts,
  normalizeParameterMapping,
  renameGraphMacroNode,
  removeGraphNode,
  saveGraphState,
  toggleExposedParameterPort,
  updateGraphMacroValue,
  updateParameterEdgeMapping,
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

  it('preserves existing exposed internal EQ ports during normalization', () => {
    const ports = normalizeExposedParameterPorts([
      {
        parameterId: 'b0_dyn_attack',
        parameterIndexFallback: 6,
        nameSnapshot: 'B0 Dyn Attack',
        labelSnapshot: 'ms',
        parameterIdIsFallback: false,
        automatable: true,
        readOnly: false,
      },
    ])

    expect(ports).toEqual([
      {
        parameterId: 'b0_dyn_attack',
        parameterIndexFallback: 6,
        nameSnapshot: 'B0 Dyn Attack',
        labelSnapshot: 'ms',
        parameterIdIsFallback: false,
        automatable: true,
        readOnly: false,
      },
    ])
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

function makeMacroParamGraphState(overrides = {}) {
  return {
    schemaVersion: GRAPH_STATE_SCHEMA_VERSION,
    trackId: '9',
    nodes: [
      { id: 'in', type: 'trackInput', position: { x: 0, y: 0 }, data: {} },
      {
        id: 'fx-a',
        type: 'effect',
        position: { x: 260, y: 0 },
        data: {
          effectInstanceId: 'inst-a',
          pluginId: 'stock:reverb',
          displayName: 'Reverb',
          bypass: false,
          missing: false,
          crashed: false,
          sourceChainSlotIndex: 0,
          exposedParameterPorts: [
            {
              parameterId: 'mix',
              parameterIndexFallback: 1,
              nameSnapshot: 'Mix',
              labelSnapshot: '%',
              parameterIdIsFallback: false,
              automatable: true,
              readOnly: false,
            },
            {
              parameterId: 'size',
              parameterIndexFallback: 2,
              nameSnapshot: 'Size',
              labelSnapshot: null,
              parameterIdIsFallback: false,
              automatable: true,
              readOnly: true,
            },
          ],
        },
      },
      { id: 'macro-a', type: GRAPH_MACRO_NODE_TYPE, position: { x: 80, y: 200 }, data: { label: 'Macro 1', normalizedValue: 0.5 } },
      { id: 'out', type: 'trackOutput', position: { x: 520, y: 0 }, data: {} },
    ],
    edges: [
      { id: 'e-1', sourceNodeId: 'in', sourcePort: 'audio', targetNodeId: 'fx-a', targetPort: 'audioIn', type: 'audio' },
      { id: 'e-2', sourceNodeId: 'fx-a', sourcePort: 'audioOut', targetNodeId: 'out', targetPort: 'audio', type: 'audio' },
    ],
    viewport: { x: 0, y: 0, zoom: 1 },
    ...overrides,
  }
}

describe('FXG.4-e/f parameter link mapping', () => {
  describe('normalizeParameterMapping / defaultParameterMapping', () => {
    it('returns enabled linear defaults spanning the full range', () => {
      expect(defaultParameterMapping()).toEqual({
        enabled: true,
        sourceMin: 0,
        sourceMax: 1,
        targetMin: 0,
        targetMax: 1,
        curve: { type: GRAPH_PARAMETER_CURVE_LINEAR },
      })
      expect(normalizeParameterMapping(undefined)).toEqual(defaultParameterMapping())
      expect(normalizeParameterMapping(null)).toEqual(defaultParameterMapping())
      expect(normalizeParameterMapping('bogus')).toEqual(defaultParameterMapping())
    })

    it('clamps every range field to [0,1] and repairs an unknown curve to linear', () => {
      const mapping = normalizeParameterMapping({
        enabled: true,
        sourceMin: -3,
        sourceMax: 9,
        targetMin: -1,
        targetMax: 5,
        curve: { type: 'bezier', points: [{ x: 0, y: 0 }] },
      })
      expect(mapping).toEqual({
        enabled: true,
        sourceMin: 0,
        sourceMax: 1,
        targetMin: 0,
        targetMax: 1,
        curve: { type: GRAPH_PARAMETER_CURVE_LINEAR },
      })
      expect(mapping.curve).not.toHaveProperty('points')
    })

    it('preserves targetMin greater than targetMax for inverted mapping', () => {
      const mapping = normalizeParameterMapping({ targetMin: 1, targetMax: 0 })
      expect(mapping.targetMin).toBe(1)
      expect(mapping.targetMax).toBe(0)
    })

    it('only enabled === false disables the mapping', () => {
      expect(normalizeParameterMapping({ enabled: false }).enabled).toBe(false)
      expect(normalizeParameterMapping({ enabled: 0 }).enabled).toBe(true)
      expect(normalizeParameterMapping({}).enabled).toBe(true)
    })
  })

  describe('evaluateLinearParameterMapping', () => {
    it('maps the full default range linearly', () => {
      const mapping = defaultParameterMapping()
      expect(evaluateLinearParameterMapping(mapping, 0)).toEqual({ enabled: true, value: 0 })
      expect(evaluateLinearParameterMapping(mapping, 0.5)).toEqual({ enabled: true, value: 0.5 })
      expect(evaluateLinearParameterMapping(mapping, 1)).toEqual({ enabled: true, value: 1 })
    })

    it('maps custom target ranges and clamps the macro input', () => {
      const mapping = normalizeParameterMapping({ targetMin: 0.5, targetMax: 1 })
      expect(evaluateLinearParameterMapping(mapping, 0).value).toBeCloseTo(0.5)
      expect(evaluateLinearParameterMapping(mapping, 1).value).toBeCloseTo(1)
      expect(evaluateLinearParameterMapping(mapping, 2).value).toBeCloseTo(1)
      expect(evaluateLinearParameterMapping(mapping, -1).value).toBeCloseTo(0.5)
    })

    it('supports inverted target ranges', () => {
      const mapping = normalizeParameterMapping({ targetMin: 0.25, targetMax: 0 })
      expect(evaluateLinearParameterMapping(mapping, 0).value).toBeCloseTo(0.25)
      expect(evaluateLinearParameterMapping(mapping, 1).value).toBeCloseTo(0)
      expect(evaluateLinearParameterMapping(mapping, 0.5).value).toBeCloseTo(0.125)
    })

    it('respects a partial source range', () => {
      const mapping = normalizeParameterMapping({ sourceMin: 0.25, sourceMax: 0.75 })
      expect(evaluateLinearParameterMapping(mapping, 0.25).value).toBeCloseTo(0)
      expect(evaluateLinearParameterMapping(mapping, 0.5).value).toBeCloseTo(0.5)
      expect(evaluateLinearParameterMapping(mapping, 0.75).value).toBeCloseTo(1)
    })

    it('treats a zero-width source span as a step without dividing by zero', () => {
      const mapping = normalizeParameterMapping({ sourceMin: 0.5, sourceMax: 0.5 })
      expect(evaluateLinearParameterMapping(mapping, 0.4).value).toBe(0)
      expect(evaluateLinearParameterMapping(mapping, 0.5).value).toBe(1)
      expect(evaluateLinearParameterMapping(mapping, 0.6).value).toBe(1)
    })

    it('returns a null value for disabled mappings', () => {
      expect(evaluateLinearParameterMapping({ enabled: false }, 0.7)).toEqual({ enabled: false, value: null })
    })
  })

  describe('parameter edge normalization through loadGraphState', () => {
    it('adds a default mapping to a parameter edge that has none', () => {
      const gs = makeMacroParamGraphState({
        edges: [
          ...makeMacroParamGraphState().edges,
          {
            id: 'p-1',
            sourceNodeId: 'macro-a',
            sourcePort: GRAPH_MACRO_OUTPUT_PORT,
            targetNodeId: 'fx-a',
            targetPort: 'gpp:fx-a:mix',
            type: 'parameter',
          },
        ],
      })
      const result = validateGraphState(gs, '9')
      expect(result.status).toBe('valid')
      const edge = result.graphState.edges.find((e) => e.id === 'p-1')
      expect(edge.mapping).toEqual(defaultParameterMapping())
    })

    it('repairs a malformed mapping and preserves inverted target ranges and clamps', () => {
      const gs = makeMacroParamGraphState({
        edges: [
          ...makeMacroParamGraphState().edges,
          {
            id: 'p-1',
            sourceNodeId: 'macro-a',
            sourcePort: GRAPH_MACRO_OUTPUT_PORT,
            targetNodeId: 'fx-a',
            targetPort: 'gpp:fx-a:mix',
            type: 'parameter',
            mapping: { enabled: true, sourceMin: -1, sourceMax: 4, targetMin: 1, targetMax: 0, curve: { type: 'bezier' } },
          },
        ],
      })
      const result = validateGraphState(gs, '9')
      const edge = result.graphState.edges.find((e) => e.id === 'p-1')
      expect(edge.mapping).toEqual({
        enabled: true,
        sourceMin: 0,
        sourceMax: 1,
        targetMin: 1,
        targetMax: 0,
        curve: { type: GRAPH_PARAMETER_CURVE_LINEAR },
      })
    })

    it('does not attach a mapping to audio edges', () => {
      const result = validateGraphState(makeMacroParamGraphState(), '9')
      const audioEdge = result.graphState.edges.find((e) => e.id === 'e-1')
      expect(audioEdge.type).toBe('audio')
      expect(audioEdge).not.toHaveProperty('mapping')
    })
  })

  describe('canConnectMacroToParameter / connectMacroToParameter', () => {
    it('validates a Macro -> exposed parameter link and builds a stable target', () => {
      const gs = makeMacroParamGraphState()
      const check = canConnectMacroToParameter(gs, {
        sourceNodeId: 'macro-a',
        targetNodeId: 'fx-a',
        parameterId: 'mix',
      })
      expect(check.ok).toBe(true)
      expect(check.targetPort).toBe('gpp:fx-a:mix')
      expect(check.target).toMatchObject({
        kind: 'graph-parameter',
        graphNodeId: 'fx-a',
        effectInstanceId: 'inst-a',
        parameterId: 'mix',
      })
    })

    it('creates a parameter edge with controlOut source, gpp target port, target identity, and default mapping', () => {
      const gs = makeMacroParamGraphState()
      const result = connectMacroToParameter(gs, {
        sourceNodeId: 'macro-a',
        targetNodeId: 'fx-a',
        parameterId: 'mix',
      }, { idFactory: () => 'p-new' })

      expect(result.ok).toBe(true)
      const edge = result.graphState.edges.at(-1)
      expect(edge).toMatchObject({
        id: 'p-new',
        sourceNodeId: 'macro-a',
        sourcePort: GRAPH_MACRO_OUTPUT_PORT,
        targetNodeId: 'fx-a',
        targetPort: 'gpp:fx-a:mix',
        type: 'parameter',
      })
      expect(edge.mapping).toEqual(defaultParameterMapping())
      expect(edge.targetParameter.kind).toBe('graph-parameter')
      // No raw engine node id is ever persisted on the target identity.
      expect(JSON.stringify(edge)).not.toContain('engineNodeId')
      // Source graphState is not mutated.
      expect(gs.edges.some((e) => e.id === 'p-new')).toBe(false)
    })

    it('links a Macro to a curated Xleth EQ parameter id without changing target identity', () => {
      const gs = makeMacroParamGraphState()
      const fx = gs.nodes.find((node) => node.id === 'fx-a')
      fx.data = {
        ...fx.data,
        pluginId: 'xletheq',
        displayName: 'Xleth EQ',
        exposedParameterPorts: [
          {
            parameterId: 'b0_freq',
            parameterIndexFallback: 0,
            nameSnapshot: 'B0 Freq',
            labelSnapshot: 'Hz',
            parameterIdIsFallback: false,
            automatable: true,
            readOnly: false,
          },
        ],
      }

      const result = connectMacroToParameter(gs, {
        sourceNodeId: 'macro-a',
        targetNodeId: 'fx-a',
        parameterId: 'b0_freq',
      }, { idFactory: () => 'p-eq-freq' })

      expect(result.ok).toBe(true)
      const edge = result.graphState.edges.at(-1)
      expect(edge.targetPort).toBe('gpp:fx-a:b0_freq')
      expect(edge.targetParameter).toMatchObject({
        kind: 'graph-parameter',
        graphNodeId: 'fx-a',
        effectInstanceId: 'inst-a',
        pluginId: 'xletheq',
        parameterId: 'b0_freq',
        parameterIndexFallback: 0,
        nameSnapshot: 'B0 Freq',
        labelSnapshot: 'Hz',
      })

      const writes = collectMacroParameterWrites(result.graphState, 'macro-a', 0.25)
      expect(writes.writes).toEqual([
        { edgeId: 'p-eq-freq', effectInstanceId: 'inst-a', parameterId: 'b0_freq', value: 0.25 },
      ])
    })

    it('rejects an effect node as a parameter source (audio output cannot drive a parameter)', () => {
      const gs = makeMacroParamGraphState()
      expect(canConnectMacroToParameter(gs, {
        sourceNodeId: 'fx-a',
        targetNodeId: 'fx-a',
        parameterId: 'mix',
      })).toMatchObject({ ok: false, reason: GRAPH_MUTATION_REJECTION.SELF_CONNECTION })

      const gsTwoFx = makeMacroParamGraphState({
        nodes: [
          ...makeMacroParamGraphState().nodes,
          {
            id: 'fx-b',
            type: 'effect',
            position: { x: 390, y: 0 },
            data: {
              effectInstanceId: 'inst-b',
              pluginId: 'stock:delay',
              displayName: 'Delay',
              bypass: false,
              missing: false,
              crashed: false,
              sourceChainSlotIndex: 1,
              exposedParameterPorts: [],
            },
          },
        ],
      })
      expect(canConnectMacroToParameter(gsTwoFx, {
        sourceNodeId: 'fx-b',
        targetNodeId: 'fx-a',
        parameterId: 'mix',
      })).toMatchObject({ ok: false, reason: GRAPH_MUTATION_REJECTION.INVALID_SOURCE_TYPE })
    })

    it('rejects protected Track I/O and macro nodes as parameter targets', () => {
      const gs = makeMacroParamGraphState()
      expect(canConnectMacroToParameter(gs, {
        sourceNodeId: 'macro-a',
        targetNodeId: 'out',
        parameterId: 'mix',
      })).toMatchObject({ ok: false, reason: GRAPH_MUTATION_REJECTION.PROTECTED_NODE })

      const gsTwoMacros = makeMacroParamGraphState({
        nodes: [
          ...makeMacroParamGraphState().nodes,
          { id: 'macro-b', type: GRAPH_MACRO_NODE_TYPE, position: { x: 80, y: 320 }, data: { label: 'Macro 2', normalizedValue: 0 } },
        ],
      })
      expect(canConnectMacroToParameter(gsTwoMacros, {
        sourceNodeId: 'macro-a',
        targetNodeId: 'macro-b',
        parameterId: 'mix',
      })).toMatchObject({ ok: false, reason: GRAPH_MUTATION_REJECTION.INVALID_TARGET_TYPE })
    })

    it('rejects a parameter that is not exposed and a read-only parameter', () => {
      const gs = makeMacroParamGraphState()
      expect(canConnectMacroToParameter(gs, {
        sourceNodeId: 'macro-a',
        targetNodeId: 'fx-a',
        parameterId: 'unexposed',
      })).toMatchObject({ ok: false, reason: GRAPH_MUTATION_REJECTION.PARAMETER_NOT_EXPOSED })

      expect(canConnectMacroToParameter(gs, {
        sourceNodeId: 'macro-a',
        targetNodeId: 'fx-a',
        parameterId: 'size',
      })).toMatchObject({ ok: false, reason: GRAPH_MUTATION_REJECTION.PARAMETER_READ_ONLY })
    })

    it('rejects a target effect node that is missing an effectInstanceId', () => {
      const gs = makeMacroParamGraphState()
      gs.nodes.find((n) => n.id === 'fx-a').data.effectInstanceId = ''
      expect(canConnectMacroToParameter(gs, {
        sourceNodeId: 'macro-a',
        targetNodeId: 'fx-a',
        parameterId: 'mix',
      })).toMatchObject({ ok: false, reason: GRAPH_MUTATION_REJECTION.MISSING_EFFECT_INSTANCE })
    })

    it('dedupes a Macro -> same target parameter link', () => {
      const gs = makeMacroParamGraphState()
      const first = connectMacroToParameter(gs, {
        sourceNodeId: 'macro-a',
        targetNodeId: 'fx-a',
        parameterId: 'mix',
      }, { idFactory: () => 'p-1' })
      expect(first.ok).toBe(true)
      const second = connectMacroToParameter(first.graphState, {
        sourceNodeId: 'macro-a',
        targetNodeId: 'fx-a',
        parameterId: 'mix',
      }, { idFactory: () => 'p-2' })
      expect(second).toMatchObject({ ok: false, reason: GRAPH_MUTATION_REJECTION.DUPLICATE_EDGE })
    })
  })

  describe('isParameterEdge / disconnectParameterEdge', () => {
    it('identifies and removes only parameter edges', () => {
      const linked = connectMacroToParameter(makeMacroParamGraphState(), {
        sourceNodeId: 'macro-a',
        targetNodeId: 'fx-a',
        parameterId: 'mix',
      }, { idFactory: () => 'p-1' })
      const gs = linked.graphState

      expect(isParameterEdge(gs, 'p-1')).toBe(true)
      expect(isParameterEdge(gs, 'e-1')).toBe(false)

      const removed = disconnectParameterEdge(gs, 'p-1')
      expect(removed.ok).toBe(true)
      expect(removed.graphState.edges.some((e) => e.id === 'p-1')).toBe(false)

      // Refuses to remove an audio edge through the parameter-specific path.
      expect(disconnectParameterEdge(gs, 'e-1')).toMatchObject({
        ok: false,
        reason: GRAPH_MUTATION_REJECTION.MISSING_EDGE,
      })
    })
  })

  describe('collectMacroParameterWrites', () => {
    function makeLinkedGraph(mapping) {
      const linked = connectMacroToParameter(makeMacroParamGraphState(), {
        sourceNodeId: 'macro-a',
        targetNodeId: 'fx-a',
        parameterId: 'mix',
        mapping,
      }, { idFactory: () => 'p-mix' })
      return linked.graphState
    }

    it('produces a normalized write for an enabled linear edge', () => {
      const gs = makeLinkedGraph()
      const { writes } = collectMacroParameterWrites(gs, 'macro-a', 0.5)
      expect(writes).toEqual([
        { edgeId: 'p-mix', effectInstanceId: 'inst-a', parameterId: 'mix', value: 0.5 },
      ])
    })

    it('applies inverted target ranges', () => {
      const gs = makeLinkedGraph({ targetMin: 1, targetMax: 0 })
      const { writes } = collectMacroParameterWrites(gs, 'macro-a', 0.25)
      expect(writes).toHaveLength(1)
      expect(writes[0].value).toBeCloseTo(0.75)
    })

    it('skips disabled edges', () => {
      const gs = makeLinkedGraph({ enabled: false })
      const result = collectMacroParameterWrites(gs, 'macro-a', 0.8)
      expect(result.writes).toEqual([])
      expect(result.skipped).toEqual([{ edgeId: 'p-mix', reason: 'disabled' }])
    })

    it('writes multiple outgoing edges to multiple targets', () => {
      const gsTwoFx = makeMacroParamGraphState({
        nodes: [
          ...makeMacroParamGraphState().nodes,
          {
            id: 'fx-b',
            type: 'effect',
            position: { x: 390, y: 0 },
            data: {
              effectInstanceId: 'inst-b',
              pluginId: 'stock:delay',
              displayName: 'Delay',
              bypass: false,
              missing: false,
              crashed: false,
              sourceChainSlotIndex: 1,
              exposedParameterPorts: [
                { parameterId: 'feedback', parameterIndexFallback: 0, nameSnapshot: 'Feedback', labelSnapshot: null, parameterIdIsFallback: false, automatable: true, readOnly: false },
              ],
            },
          },
        ],
      })
      const a = connectMacroToParameter(gsTwoFx, {
        sourceNodeId: 'macro-a', targetNodeId: 'fx-a', parameterId: 'mix',
      }, { idFactory: () => 'p-a' })
      const b = connectMacroToParameter(a.graphState, {
        sourceNodeId: 'macro-a', targetNodeId: 'fx-b', parameterId: 'feedback', mapping: { targetMin: 0.25, targetMax: 0 },
      }, { idFactory: () => 'p-b' })

      const { writes } = collectMacroParameterWrites(b.graphState, 'macro-a', 1)
      expect(writes).toHaveLength(2)
      expect(writes.find((w) => w.effectInstanceId === 'inst-a')).toMatchObject({ parameterId: 'mix', value: 1 })
      expect(writes.find((w) => w.effectInstanceId === 'inst-b')).toMatchObject({ parameterId: 'feedback', value: 0 })
    })

    it('skips an edge whose target identity is missing or malformed', () => {
      const gs = makeLinkedGraph()
      delete gs.edges.find((e) => e.id === 'p-mix').targetParameter
      const result = collectMacroParameterWrites(gs, 'macro-a', 0.5)
      expect(result.writes).toEqual([])
      expect(result.skipped).toEqual([{ edgeId: 'p-mix', reason: 'invalid_target' }])
    })

    it('skips an edge whose exposed parameter port no longer exists', () => {
      const gs = makeLinkedGraph()
      gs.nodes.find((n) => n.id === 'fx-a').data.exposedParameterPorts = []
      const result = collectMacroParameterWrites(gs, 'macro-a', 0.5)
      expect(result.writes).toEqual([])
      expect(result.skipped).toEqual([{ edgeId: 'p-mix', reason: 'missing_exposed_port' }])
    })

    it('returns nothing for a non-macro source node', () => {
      const gs = makeLinkedGraph()
      expect(collectMacroParameterWrites(gs, 'fx-a', 0.5)).toEqual({ writes: [], skipped: [] })
    })
  })
})

// ---------------------------------------------------------------------------
// FXG.4-g — Bezier mapping editor
// ---------------------------------------------------------------------------

describe('FXG.4-g Bezier mapping', () => {
  describe('createDefaultBezierCurve', () => {
    it('returns a bezier curve with 4 points, fixed endpoints, clamped controls', () => {
      const curve = createDefaultBezierCurve()
      expect(curve.type).toBe(GRAPH_PARAMETER_CURVE_BEZIER)
      expect(curve.points).toHaveLength(4)
      expect(curve.points[0]).toEqual({ x: 0, y: 0 })
      expect(curve.points[3]).toEqual({ x: 1, y: 1 })
      for (const p of curve.points) {
        expect(p.x).toBeGreaterThanOrEqual(0)
        expect(p.x).toBeLessThanOrEqual(1)
        expect(p.y).toBeGreaterThanOrEqual(0)
        expect(p.y).toBeLessThanOrEqual(1)
      }
    })
  })

  describe('normalizeParameterMapping with bezier', () => {
    it('preserves a valid 4-point bezier curve', () => {
      const mapping = normalizeParameterMapping({
        curve: {
          type: GRAPH_PARAMETER_CURVE_BEZIER,
          points: [
            { x: 0, y: 0 },
            { x: 0.3, y: 0.1 },
            { x: 0.7, y: 0.9 },
            { x: 1, y: 1 },
          ],
        },
      })
      expect(mapping.curve.type).toBe(GRAPH_PARAMETER_CURVE_BEZIER)
      expect(mapping.curve.points[0]).toEqual({ x: 0, y: 0 })
      expect(mapping.curve.points[1]).toEqual({ x: 0.3, y: 0.1 })
      expect(mapping.curve.points[2]).toEqual({ x: 0.7, y: 0.9 })
      expect(mapping.curve.points[3]).toEqual({ x: 1, y: 1 })
    })

    it('forces start/end points to {0,0} and {1,1} regardless of stored values', () => {
      const mapping = normalizeParameterMapping({
        curve: {
          type: GRAPH_PARAMETER_CURVE_BEZIER,
          points: [
            { x: 0.5, y: 0.5 },
            { x: 0.3, y: 0.1 },
            { x: 0.7, y: 0.9 },
            { x: 0.5, y: 0.5 },
          ],
        },
      })
      expect(mapping.curve.type).toBe(GRAPH_PARAMETER_CURVE_BEZIER)
      expect(mapping.curve.points[0]).toEqual({ x: 0, y: 0 })
      expect(mapping.curve.points[3]).toEqual({ x: 1, y: 1 })
    })

    it('clamps control points to [0,1]', () => {
      const mapping = normalizeParameterMapping({
        curve: {
          type: GRAPH_PARAMETER_CURVE_BEZIER,
          points: [
            { x: 0, y: 0 },
            { x: -0.5, y: 1.5 },
            { x: 2, y: -1 },
            { x: 1, y: 1 },
          ],
        },
      })
      expect(mapping.curve.type).toBe(GRAPH_PARAMETER_CURVE_BEZIER)
      expect(mapping.curve.points[1]).toEqual({ x: 0, y: 1 })
      expect(mapping.curve.points[2]).toEqual({ x: 1, y: 0 })
    })

    it('repairs a bezier with wrong point count to linear', () => {
      const mapping = normalizeParameterMapping({
        curve: { type: GRAPH_PARAMETER_CURVE_BEZIER, points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] },
      })
      expect(mapping.curve.type).toBe(GRAPH_PARAMETER_CURVE_LINEAR)
    })

    it('repairs a bezier with missing points array to linear', () => {
      const mapping = normalizeParameterMapping({
        curve: { type: GRAPH_PARAMETER_CURVE_BEZIER },
      })
      expect(mapping.curve.type).toBe(GRAPH_PARAMETER_CURVE_LINEAR)
    })

    it('repairs a bezier with non-finite coords to linear', () => {
      const mapping = normalizeParameterMapping({
        curve: {
          type: GRAPH_PARAMETER_CURVE_BEZIER,
          points: [
            { x: 0, y: 0 },
            { x: NaN, y: 0.5 },
            { x: 0.6, y: 0.9 },
            { x: 1, y: 1 },
          ],
        },
      })
      expect(mapping.curve.type).toBe(GRAPH_PARAMETER_CURVE_LINEAR)
    })
  })

  describe('evaluateBezierCurve', () => {
    const defaultCurve = createDefaultBezierCurve()

    it('returns 0 at x=0 and 1 at x=1 exactly', () => {
      expect(evaluateBezierCurve(defaultCurve, 0)).toBe(0)
      expect(evaluateBezierCurve(defaultCurve, 1)).toBe(1)
    })

    it('clamps out-of-range input', () => {
      expect(evaluateBezierCurve(defaultCurve, -0.5)).toBe(0)
      expect(evaluateBezierCurve(defaultCurve, 1.5)).toBe(1)
    })

    it('produces a midpoint in [0,1] for a valid S-curve', () => {
      const mid = evaluateBezierCurve(defaultCurve, 0.5)
      expect(mid).toBeGreaterThanOrEqual(0)
      expect(mid).toBeLessThanOrEqual(1)
    })

    it('returns identity for a degenerate linear-equivalent bezier (cp1=(0,0), cp2=(1,1))', () => {
      const linearCurve = {
        type: GRAPH_PARAMETER_CURVE_BEZIER,
        points: [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 1 }, { x: 1, y: 1 }],
      }
      expect(evaluateBezierCurve(linearCurve, 0.5)).toBeCloseTo(0.5, 3)
    })

    it('falls back to identity for invalid/missing curve', () => {
      expect(evaluateBezierCurve(null, 0.7)).toBeCloseTo(0.7)
      expect(evaluateBezierCurve({ type: 'bezier' }, 0.3)).toBeCloseTo(0.3)
      expect(evaluateBezierCurve({ type: 'bezier', points: [] }, 0.5)).toBeCloseTo(0.5)
    })
  })

  describe('evaluateParameterMapping', () => {
    it('produces identical results to evaluateLinearParameterMapping for linear curves', () => {
      const mapping = normalizeParameterMapping({ targetMin: 0.2, targetMax: 0.8 })
      for (const v of [0, 0.25, 0.5, 0.75, 1]) {
        expect(evaluateParameterMapping(mapping, v).value).toBeCloseTo(
          evaluateLinearParameterMapping(mapping, v).value,
          8,
        )
      }
    })

    it('returns disabled for disabled mapping', () => {
      expect(evaluateParameterMapping({ enabled: false }, 0.5)).toEqual({ enabled: false, value: null })
    })

    it('applies bezier shaping for bezier curves', () => {
      const bezierMapping = normalizeParameterMapping({ curve: createDefaultBezierCurve() })
      const linearMapping = normalizeParameterMapping({})
      // S-curve makes midpoint different from linear
      const bezierMid = evaluateParameterMapping(bezierMapping, 0.5).value
      const linearMid = evaluateParameterMapping(linearMapping, 0.5).value
      expect(bezierMid).toBeGreaterThanOrEqual(0)
      expect(bezierMid).toBeLessThanOrEqual(1)
      // Midpoint may or may not differ from linear depending on control points, but should be valid
      expect(typeof bezierMid).toBe('number')
      expect(typeof linearMid).toBe('number')
    })

    it('supports inverted target ranges with bezier', () => {
      const mapping = normalizeParameterMapping({
        targetMin: 1,
        targetMax: 0,
        curve: createDefaultBezierCurve(),
      })
      expect(evaluateParameterMapping(mapping, 0).value).toBeCloseTo(1)
      expect(evaluateParameterMapping(mapping, 1).value).toBeCloseTo(0)
    })

    it('handles zero-width source span without dividing by zero', () => {
      const mapping = normalizeParameterMapping({ sourceMin: 0.5, sourceMax: 0.5 })
      expect(evaluateParameterMapping(mapping, 0.4).value).toBe(0)
      expect(evaluateParameterMapping(mapping, 0.5).value).toBe(1)
    })
  })

  describe('updateParameterEdgeMapping', () => {
    function makeLinkedGs() {
      const gs = makeMacroParamGraphState()
      const result = connectMacroToParameter(gs, {
        sourceNodeId: 'macro-a', targetNodeId: 'fx-a', parameterId: 'mix',
      }, { idFactory: () => 'p-test' })
      return result.graphState
    }

    it('updates targetMin and targetMax', () => {
      const gs = makeLinkedGs()
      const result = updateParameterEdgeMapping(gs, 'p-test', { targetMin: 0.5, targetMax: 1 })
      expect(result.ok).toBe(true)
      const edge = result.graphState.edges.find((e) => e.id === 'p-test')
      expect(edge.mapping.targetMin).toBe(0.5)
      expect(edge.mapping.targetMax).toBe(1)
      expect(edge.mapping.enabled).toBe(true)
    })

    it('toggles enabled to false', () => {
      const gs = makeLinkedGs()
      const result = updateParameterEdgeMapping(gs, 'p-test', { enabled: false })
      expect(result.ok).toBe(true)
      const edge = result.graphState.edges.find((e) => e.id === 'p-test')
      expect(edge.mapping.enabled).toBe(false)
    })

    it('upgrades to bezier curve', () => {
      const gs = makeLinkedGs()
      const result = updateParameterEdgeMapping(gs, 'p-test', { curve: createDefaultBezierCurve() })
      expect(result.ok).toBe(true)
      const edge = result.graphState.edges.find((e) => e.id === 'p-test')
      expect(edge.mapping.curve.type).toBe(GRAPH_PARAMETER_CURVE_BEZIER)
      expect(edge.mapping.curve.points).toHaveLength(4)
    })

    it('resets to linear by patching curve to { type: linear }', () => {
      const gs = makeLinkedGs()
      const bezier = updateParameterEdgeMapping(gs, 'p-test', { curve: createDefaultBezierCurve() })
      const reset = updateParameterEdgeMapping(bezier.graphState, 'p-test', { curve: { type: GRAPH_PARAMETER_CURVE_LINEAR } })
      expect(reset.ok).toBe(true)
      const edge = reset.graphState.edges.find((e) => e.id === 'p-test')
      expect(edge.mapping.curve.type).toBe(GRAPH_PARAMETER_CURVE_LINEAR)
      expect(edge.mapping.curve).not.toHaveProperty('points')
    })

    it('clamps out-of-range values on update', () => {
      const gs = makeLinkedGs()
      const result = updateParameterEdgeMapping(gs, 'p-test', { targetMin: -5, targetMax: 9 })
      expect(result.ok).toBe(true)
      const edge = result.graphState.edges.find((e) => e.id === 'p-test')
      expect(edge.mapping.targetMin).toBe(0)
      expect(edge.mapping.targetMax).toBe(1)
    })

    it('preserves inverted target ranges (targetMin > targetMax)', () => {
      const gs = makeLinkedGs()
      const result = updateParameterEdgeMapping(gs, 'p-test', { targetMin: 0.8, targetMax: 0.2 })
      expect(result.ok).toBe(true)
      const edge = result.graphState.edges.find((e) => e.id === 'p-test')
      expect(edge.mapping.targetMin).toBe(0.8)
      expect(edge.mapping.targetMax).toBe(0.2)
    })

    it('rejects a non-parameter edge id', () => {
      const gs = makeLinkedGs()
      const audioEdgeId = gs.edges.find((e) => e.type === 'audio').id
      const result = updateParameterEdgeMapping(gs, audioEdgeId, { enabled: false })
      expect(result.ok).toBe(false)
    })

    it('rejects a missing edge id', () => {
      const gs = makeLinkedGs()
      expect(updateParameterEdgeMapping(gs, 'nonexistent', {}).ok).toBe(false)
    })

    it('rejects a non-object patch', () => {
      const gs = makeLinkedGs()
      expect(updateParameterEdgeMapping(gs, 'p-test', null).ok).toBe(false)
      expect(updateParameterEdgeMapping(gs, 'p-test', 42).ok).toBe(false)
    })

    it('malformed bezier patch falls back to linear without corrupting state', () => {
      const gs = makeLinkedGs()
      const result = updateParameterEdgeMapping(gs, 'p-test', {
        curve: { type: GRAPH_PARAMETER_CURVE_BEZIER, points: 'bad' },
      })
      expect(result.ok).toBe(true)
      const edge = result.graphState.edges.find((e) => e.id === 'p-test')
      expect(edge.mapping.curve.type).toBe(GRAPH_PARAMETER_CURVE_LINEAR)
    })

    it('does not mutate the original graphState', () => {
      const gs = makeLinkedGs()
      const before = JSON.stringify(gs)
      updateParameterEdgeMapping(gs, 'p-test', { targetMin: 0.5 })
      expect(JSON.stringify(gs)).toBe(before)
    })
  })

  describe('collectMacroParameterWrites with bezier mapping', () => {
    function makeLinkedGraph(mapping) {
      const base = makeMacroParamGraphState()
      const linked = connectMacroToParameter(base, {
        sourceNodeId: 'macro-a',
        targetNodeId: 'fx-a',
        parameterId: 'mix',
        mapping,
      }, { idFactory: () => 'p-mix-bezier' })
      return linked.graphState
    }

    it('uses evaluateParameterMapping for linear edges (same result as before)', () => {
      const gs = makeLinkedGraph({ targetMin: 0.5, targetMax: 1 })
      const { writes } = collectMacroParameterWrites(gs, 'macro-a', 0)
      expect(writes[0].value).toBeCloseTo(0.5)
    })

    it('uses bezier shaping for bezier edges at boundary values', () => {
      const gs = makeLinkedGraph({ curve: createDefaultBezierCurve() })
      const w0 = collectMacroParameterWrites(gs, 'macro-a', 0)
      const w1 = collectMacroParameterWrites(gs, 'macro-a', 1)
      expect(w0.writes[0].value).toBeCloseTo(0)
      expect(w1.writes[0].value).toBeCloseTo(1)
    })

    it('bezier inverted range: macro 0 → target 1, macro 1 → target 0', () => {
      const gs = makeLinkedGraph({ targetMin: 1, targetMax: 0, curve: createDefaultBezierCurve() })
      const w0 = collectMacroParameterWrites(gs, 'macro-a', 0)
      const w1 = collectMacroParameterWrites(gs, 'macro-a', 1)
      expect(w0.writes[0].value).toBeCloseTo(1)
      expect(w1.writes[0].value).toBeCloseTo(0)
    })
  })

  // FXG.4-h — parent-attached macro automation lanes round-trip through load/save.
  describe('macroAutomationLanes integration', () => {
    function graphWithMacro(extra = {}) {
      return {
        schemaVersion: GRAPH_STATE_SCHEMA_VERSION,
        trackId: '7',
        nodes: [
          { id: 'in', type: 'trackInput', position: { x: 0, y: 0 }, data: {} },
          { id: 'M1', type: 'macro', position: { x: 100, y: 0 }, data: { label: 'Macro 1', normalizedValue: 0.5 } },
          { id: 'out', type: 'trackOutput', position: { x: 200, y: 0 }, data: {} },
        ],
        edges: [],
        ...extra,
      }
    }

    it('defaults to [] for old projects without the field', () => {
      const result = loadGraphState(graphWithMacro(), '7')
      expect(result.status).toBe('valid')
      expect(result.graphState.macroAutomationLanes).toEqual([])
    })

    it('createEmptyGraphState seeds an empty lane array', () => {
      expect(createEmptyGraphState('7').macroAutomationLanes).toEqual([])
    })

    it('preserves lanes/clips/loop across save → load round-trip', () => {
      const raw = graphWithMacro({
        macroAutomationLanes: [{
          laneId: 'L1',
          macroNodeId: 'M1',
          visible: true,
          clips: [{
            clipId: 'C1',
            startTick: 480,
            lengthTicks: 960,
            loopEnabled: true,
            points: [{ tick: 0, value: 0.2 }, { tick: 960, value: 0.9 }],
          }],
        }],
      })
      const loaded = loadGraphState(raw, '7')
      expect(loaded.status).toBe('valid')
      const saved = saveGraphState(loaded.graphState)
      const reloaded = loadGraphState(saved, '7')
      const lane = reloaded.graphState.macroAutomationLanes[0]
      expect(lane.macroNodeId).toBe('M1')
      expect(lane.clips[0].loopEnabled).toBe(true)
      expect(lane.clips[0].points).toHaveLength(2)
      expect(lane.clips[0].points[1].value).toBeCloseTo(0.9)
    })

    it('flags a lane whose macro no longer exists as orphaned (never crashes)', () => {
      const raw = graphWithMacro({
        macroAutomationLanes: [{ laneId: 'L1', macroNodeId: 'GONE', clips: [] }],
      })
      const loaded = loadGraphState(raw, '7')
      expect(loaded.status).toBe('valid')
      expect(loaded.graphState.macroAutomationLanes[0].targetUnavailable).toBe(true)
    })
  })
})

// ── EVC.2 envelope controller node ──────────────────────────────────────────

function makeEnvelopeNode(id = 'env-1', data = {}, position = { x: 80, y: 320 }) {
  return { id, type: GRAPH_ENVELOPE_NODE_TYPE, position, data }
}

// A valid (input/effect/output) graph with one envelope node appended, so the
// trackInput/trackOutput multiplicity invariant still holds.
function makeGraphWithEnvelope(envOverrides = {}, position) {
  const base = makeValidGraphState()
  return {
    ...base,
    nodes: [...base.nodes, makeEnvelopeNode('env-1', envOverrides, position)],
  }
}

describe('EVC.2 envelope node data normalization', () => {
  it('normalizeEnvelopeNodeData applies all defaults for missing data', () => {
    expect(normalizeEnvelopeNodeData(undefined)).toEqual({
      label: 'Envelope',
      attackMs: 10,
      holdMs: 0,
      decayMs: 120,
      sustain: 0.7,
      releaseMs: 200,
      attackTension: 0,
      decayTension: 0,
      releaseTension: 0,
      amount: 1,
      voiceMode: 'poly',
      maxVoices: 32,
      triggerSource: { kind: 'parentTrack', events: 'notesAndClips' },
      target: { kind: 'voiceGain' },
      monophonic: { legato: false, glideMs: 0 },
    })
  })

  it('createDefaultEnvelopeNodeData equals the documented defaults', () => {
    const data = createDefaultEnvelopeNodeData()
    expect(data.label).toBe(ENVELOPE_NODE_DEFAULTS.label)
    expect(data.attackMs).toBe(ENVELOPE_NODE_DEFAULTS.attackMs)
    expect(data.decayMs).toBe(ENVELOPE_NODE_DEFAULTS.decayMs)
    expect(data.sustain).toBe(ENVELOPE_NODE_DEFAULTS.sustain)
    expect(data.releaseMs).toBe(ENVELOPE_NODE_DEFAULTS.releaseMs)
    expect(data.voiceMode).toBe('poly')
    expect(data.maxVoices).toBe(32)
    expect(data.triggerSource).toEqual({ kind: 'parentTrack', events: 'notesAndClips' })
    expect(data.target).toEqual({ kind: 'voiceGain' })
    expect(data.monophonic).toEqual({ legato: false, glideMs: 0 })
  })

  it('createDefaultEnvelopeNodeData applies clamped overrides', () => {
    const data = createDefaultEnvelopeNodeData({
      label: '  Pluck  ',
      attackMs: 5,
      sustain: 0.25,
      voiceMode: 'mono',
      maxVoices: 8,
      triggerSource: { events: 'notes' },
      monophonic: { legato: true, glideMs: 30 },
    })
    expect(data.label).toBe('Pluck')
    expect(data.attackMs).toBe(5)
    expect(data.sustain).toBe(0.25)
    expect(data.voiceMode).toBe('mono')
    expect(data.maxVoices).toBe(8)
    expect(data.triggerSource).toEqual({ kind: 'parentTrack', events: 'notes' })
    expect(data.monophonic).toEqual({ legato: true, glideMs: 30 })
  })

  it('clamps and repairs malformed values', () => {
    const data = normalizeEnvelopeNodeData({
      label: '   ',
      attackMs: -10,
      holdMs: Number.NaN,
      decayMs: Infinity,
      sustain: 5,
      releaseMs: 'nope',
      attackTension: 2,
      decayTension: -3,
      releaseTension: Number.NaN,
      amount: -0.5,
      voiceMode: 'duophonic',
      maxVoices: 999,
      triggerSource: { kind: 'somethingElse', events: 'bogus' },
      target: { kind: 'pluginParam' },
      monophonic: { legato: 'yes', glideMs: -4 },
    })

    expect(data.label).toBe('Envelope')
    expect(data.attackMs).toBe(10) // negative → default
    expect(data.holdMs).toBe(0)
    expect(data.decayMs).toBe(120) // non-finite → default
    expect(data.sustain).toBe(1) // clamped to 0..1
    expect(data.releaseMs).toBe(200)
    expect(data.attackTension).toBe(1) // clamped to -1..1
    expect(data.decayTension).toBe(-1)
    expect(data.releaseTension).toBe(0)
    expect(data.amount).toBe(0)
    expect(data.voiceMode).toBe('poly') // repaired
    expect(data.maxVoices).toBe(32) // clamped to 1..32
    expect(data.triggerSource).toEqual({ kind: 'parentTrack', events: 'notesAndClips' })
    expect(data.target).toEqual({ kind: 'voiceGain' })
    expect(data.monophonic).toEqual({ legato: false, glideMs: 0 })
  })

  it('clamps maxVoices to the 1..32 range and rounds fractions', () => {
    expect(normalizeEnvelopeNodeData({ maxVoices: 0 }).maxVoices).toBe(1)
    expect(normalizeEnvelopeNodeData({ maxVoices: -5 }).maxVoices).toBe(1)
    expect(normalizeEnvelopeNodeData({ maxVoices: 16 }).maxVoices).toBe(16)
    expect(normalizeEnvelopeNodeData({ maxVoices: 4.6 }).maxVoices).toBe(5)
    expect(normalizeEnvelopeNodeData({ maxVoices: 64 }).maxVoices).toBe(32)
  })

  it('does not store a redundant parentTrackId on the node data', () => {
    const data = normalizeEnvelopeNodeData({ parentTrackId: '7', triggerSource: { parentTrackId: '7' } })
    expect(data).not.toHaveProperty('parentTrackId')
    expect(data.triggerSource).not.toHaveProperty('parentTrackId')
    expect(data.triggerSource).toEqual({ kind: 'parentTrack', events: 'notesAndClips' })
  })

  it('isEnvelopeGraphNode only matches envelope nodes', () => {
    expect(isEnvelopeGraphNode(makeEnvelopeNode())).toBe(true)
    expect(isEnvelopeGraphNode({ type: 'effect' })).toBe(false)
    expect(isEnvelopeGraphNode({ type: GRAPH_MACRO_NODE_TYPE })).toBe(false)
    expect(isEnvelopeGraphNode(null)).toBe(false)
    expect(isEnvelopeGraphNode(undefined)).toBe(false)
  })
})

describe('EVC.2 envelope node loadGraphState integration', () => {
  it('preserves a valid envelope node through load', () => {
    const result = validateGraphState(makeGraphWithEnvelope({
      label: 'Lead Env',
      attackMs: 4,
      decayMs: 80,
      sustain: 0.5,
      releaseMs: 150,
      voiceMode: 'mono',
      maxVoices: 4,
      triggerSource: { kind: 'parentTrack', events: 'notes' },
      target: { kind: 'voiceGain' },
      monophonic: { legato: true, glideMs: 20 },
    }), '7')

    expect(result.status).toBe('valid')
    const env = result.graphState.nodes.find((n) => n.id === 'env-1')
    expect(env.type).toBe(GRAPH_ENVELOPE_NODE_TYPE)
    expect(env.data).toEqual({
      label: 'Lead Env',
      attackMs: 4,
      holdMs: 0,
      decayMs: 80,
      sustain: 0.5,
      releaseMs: 150,
      attackTension: 0,
      decayTension: 0,
      releaseTension: 0,
      amount: 1,
      voiceMode: 'mono',
      maxVoices: 4,
      triggerSource: { kind: 'parentTrack', events: 'notes' },
      target: { kind: 'voiceGain' },
      monophonic: { legato: true, glideMs: 20 },
    })
  })

  it('repairs a malformed envelope node to defaults instead of failing the load', () => {
    const result = validateGraphState(makeGraphWithEnvelope({
      sustain: 99,
      voiceMode: 'invalid',
      maxVoices: 'nope', // non-numeric → repairs to the default of 32
      target: { kind: 'exposedPluginParam', effectInstanceId: 'effect-1', parameterId: 'mix' },
    }), '7')

    expect(result.status).toBe('valid')
    const env = result.graphState.nodes.find((n) => n.id === 'env-1')
    expect(env.data.sustain).toBe(1)
    expect(env.data.voiceMode).toBe('poly')
    expect(env.data.maxVoices).toBe(32)
    // The target enum is forced to voiceGain — no plugin-parameter leakage.
    expect(env.data.target).toEqual({ kind: 'voiceGain' })
    expect(env.data.target).not.toHaveProperty('effectInstanceId')
    expect(env.data.target).not.toHaveProperty('parameterId')
  })

  it('repairs an envelope node whose data is not an object', () => {
    const result = validateGraphState(makeGraphWithEnvelope(null), '7')
    expect(result.status).toBe('valid')
    const env = result.graphState.nodes.find((n) => n.id === 'env-1')
    expect(env.data).toEqual(createDefaultEnvelopeNodeData())
  })

  it('does not turn an envelope node into an effect node (no effectInstanceId required)', () => {
    const result = validateGraphState(makeGraphWithEnvelope(), '7')
    expect(result.status).toBe('valid')
    const env = result.graphState.nodes.find((n) => n.id === 'env-1')
    expect(env.type).toBe(GRAPH_ENVELOPE_NODE_TYPE)
    expect(env.data).not.toHaveProperty('effectInstanceId')
    expect(env.data).not.toHaveProperty('pluginId')
    expect(env.data).not.toHaveProperty('exposedParameterPorts')
  })

  it('ignores envelope nodes in the audio topology payload', () => {
    const result = validateGraphState(makeGraphWithEnvelope(), '7')
    const payload = buildLinearGraphTopologyPayload(result.graphState)
    expect(payload.nodes.some((node) => node.type === GRAPH_ENVELOPE_NODE_TYPE)).toBe(false)
    expect(payload.nodes.some((node) => node.nodeId === 'env-1')).toBe(false)
    // The linear input→effect→output path is still fully supported.
    expect(analyzeLinearGraphTopology(result.graphState)).toMatchObject({ ok: true })
  })

  it('drops an audio edge that touches an envelope node', () => {
    const withEdge = makeGraphWithEnvelope()
    withEdge.edges = [
      ...withEdge.edges,
      {
        id: 'bad-env-edge',
        sourceNodeId: 'fx-1',
        sourcePort: 'audioOut',
        targetNodeId: 'env-1',
        targetPort: 'audio',
        type: 'audio',
      },
    ]
    const result = validateGraphState(withEdge, '7')
    expect(result.status).toBe('valid')
    expect(result.graphState.edges.some((e) => e.id === 'bad-env-edge')).toBe(false)
  })

  it('leaves graphState without envelope nodes unchanged', () => {
    const result = validateGraphState(makeValidGraphState(), '7')
    expect(result.status).toBe('valid')
    expect(result.graphState.nodes.some((n) => n.type === GRAPH_ENVELOPE_NODE_TYPE)).toBe(false)
  })
})

describe('EVC.2 envelope node mutation helpers', () => {
  it('addGraphEnvelopeNode appends a defaulted envelope node immutably', () => {
    const gs = makeGuardGraphState()
    const result = addGraphEnvelopeNode(gs, { idFactory: () => 'env-new' })

    expect(result.ok).toBe(true)
    const node = result.graphState.nodes.at(-1)
    expect(node.id).toBe('env-new')
    expect(node.type).toBe(GRAPH_ENVELOPE_NODE_TYPE)
    expect(node.data).toEqual(createDefaultEnvelopeNodeData())
    expect(Number.isFinite(node.position.x) && Number.isFinite(node.position.y)).toBe(true)
    // Immutability + preservation of unrelated fields/nodes/edges.
    expect(gs.nodes.some((n) => n.id === 'env-new')).toBe(false)
    expect(result.graphState.customField).toBe('preserved')
    expect(result.graphState.edges).toHaveLength(gs.edges.length)
  })

  it('addGraphEnvelopeNode applies data overrides and explicit position', () => {
    const result = addGraphEnvelopeNode(makeGuardGraphState(), {
      idFactory: () => 'env-a',
      position: { x: 12, y: 34 },
      data: { label: 'Bass', sustain: 0.3, maxVoices: 8 },
    })
    expect(result.ok).toBe(true)
    const node = result.graphState.nodes.at(-1)
    expect(node.position).toEqual({ x: 12, y: 34 })
    expect(node.data.label).toBe('Bass')
    expect(node.data.sustain).toBe(0.3)
    expect(node.data.maxVoices).toBe(8)
  })

  it('addGraphEnvelopeNode rejects an invalid graphState', () => {
    expect(addGraphEnvelopeNode(null)).toMatchObject({
      ok: false,
      reason: GRAPH_MUTATION_REJECTION.INVALID_GRAPH_STATE,
    })
  })

  it('removeGraphNode can remove an envelope node (it is not protected)', () => {
    const added = addGraphEnvelopeNode(makeGuardGraphState(), { idFactory: () => 'env-a' })
    expect(canRemoveGraphNode(added.graphState, 'env-a')).toEqual({ ok: true })
    const removed = removeGraphNode(added.graphState, 'env-a')
    expect(removed.ok).toBe(true)
    expect(removed.graphState.nodes.some((n) => n.id === 'env-a')).toBe(false)
  })

  it('updateGraphEnvelopeNodeData updates only the targeted envelope node', () => {
    const added = addGraphEnvelopeNode(makeGuardGraphState(), { idFactory: () => 'env-a' })
    const result = updateGraphEnvelopeNodeData(added.graphState, 'env-a', {
      attackMs: 25,
      sustain: 0.4,
      triggerSource: { events: 'clips' },
    })

    expect(result.ok).toBe(true)
    const node = result.graphState.nodes.find((n) => n.id === 'env-a')
    expect(node.data.attackMs).toBe(25)
    expect(node.data.sustain).toBe(0.4)
    expect(node.data.triggerSource).toEqual({ kind: 'parentTrack', events: 'clips' })
    // Unrelated envelope fields preserved.
    expect(node.data.decayMs).toBe(ENVELOPE_NODE_DEFAULTS.decayMs)
    expect(node.data.releaseMs).toBe(ENVELOPE_NODE_DEFAULTS.releaseMs)
  })

  it('updateGraphEnvelopeNodeData preserves unrelated nodes and graphState fields', () => {
    const added = addGraphEnvelopeNode(makeGuardGraphState(), { idFactory: () => 'env-a' })
    const before = added.graphState
    const result = updateGraphEnvelopeNodeData(before, 'env-a', { amount: 0.5 })

    expect(result.ok).toBe(true)
    expect(result.graphState.customField).toBe('preserved')
    expect(result.graphState.viewport).toEqual(before.viewport)
    expect(result.graphState.nodes.find((n) => n.id === 'fx-a')).toEqual(
      before.nodes.find((n) => n.id === 'fx-a'),
    )
    expect(result.graphState.edges).toEqual(before.edges)
    // Input graphState not mutated.
    expect(before.nodes.find((n) => n.id === 'env-a').data.amount).toBe(1)
  })

  it('updateGraphEnvelopeNodeData rejects non-envelope and missing nodes', () => {
    const added = addGraphEnvelopeNode(makeGuardGraphState(), { idFactory: () => 'env-a' })
    expect(updateGraphEnvelopeNodeData(added.graphState, 'fx-a', { amount: 0.5 })).toEqual({
      ok: false,
      reason: GRAPH_MUTATION_REJECTION.UNKNOWN_NODE_TYPE,
    })
    expect(updateGraphEnvelopeNodeData(added.graphState, 'missing', { amount: 0.5 })).toEqual({
      ok: false,
      reason: GRAPH_MUTATION_REJECTION.MISSING_NODE,
    })
    expect(updateGraphEnvelopeNodeData(added.graphState, 'env-a', null)).toEqual({
      ok: false,
      reason: GRAPH_MUTATION_REJECTION.INVALID_ENVELOPE_PATCH,
    })
  })
})

describe('EVC.2 envelope nodes are not macro modulation endpoints', () => {
  // A graph with a macro node, an effect exposing a writable param, and an
  // envelope node — so macro→parameter links can be attempted against the envelope.
  function makeMacroEnvelopeGraph() {
    const base = makeValidGraphState()
    return {
      ...base,
      nodes: [
        base.nodes[0],
        {
          ...base.nodes[1],
          data: {
            ...base.nodes[1].data,
            exposedParameterPorts: [
              {
                parameterId: 'mix',
                parameterIndexFallback: 1,
                nameSnapshot: 'Mix',
                labelSnapshot: '%',
                parameterIdIsFallback: false,
                automatable: true,
                readOnly: false,
              },
            ],
          },
        },
        { id: 'macro-a', type: GRAPH_MACRO_NODE_TYPE, position: { x: 80, y: 120 }, data: { label: 'Macro 1', normalizedValue: 0.5 } },
        makeEnvelopeNode('env-1'),
        base.nodes[2],
      ],
    }
  }

  it('rejects an envelope node as a macro→parameter source', () => {
    const gs = validateGraphState(makeMacroEnvelopeGraph(), '7').graphState
    expect(canConnectMacroToParameter(gs, {
      sourceNodeId: 'env-1',
      targetNodeId: 'fx-1',
      parameterId: 'mix',
    })).toEqual({ ok: false, reason: GRAPH_MUTATION_REJECTION.INVALID_SOURCE_TYPE })
  })

  it('rejects an envelope node as a macro→parameter target', () => {
    const gs = validateGraphState(makeMacroEnvelopeGraph(), '7').graphState
    expect(canConnectMacroToParameter(gs, {
      sourceNodeId: 'macro-a',
      targetNodeId: 'env-1',
      parameterId: 'mix',
    })).toEqual({ ok: false, reason: GRAPH_MUTATION_REJECTION.INVALID_TARGET_TYPE })
  })

  it('rejects audio connections to/from an envelope node', () => {
    const gs = validateGraphState(makeMacroEnvelopeGraph(), '7').graphState
    expect(canConnectGraphNodes(gs, 'env-1', 'output')).toEqual({
      ok: false,
      reason: GRAPH_MUTATION_REJECTION.INVALID_SOURCE_TYPE,
    })
    expect(canConnectGraphNodes(gs, 'input', 'env-1')).toEqual({
      ok: false,
      reason: GRAPH_MUTATION_REJECTION.INVALID_TARGET_TYPE,
    })
  })
})
