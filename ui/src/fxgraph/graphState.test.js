import { describe, expect, it } from 'vitest'
import {
  GRAPH_STATE_SCHEMA_VERSION,
  createEmptyGraphState,
  loadGraphState,
  saveGraphState,
  validateGraphState,
} from './graphState.js'

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
