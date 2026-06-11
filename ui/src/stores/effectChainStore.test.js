import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { connectMacroToParameter, connectEnvelopeToParameter, createDefaultBezierCurve, GRAPH_PARAMETER_CURVE_BEZIER } from '../fxgraph/graphState.js'

function makeEffect(nodeId, pluginId, position, bypassed = false) {
  return { nodeId, pluginId, position, bypassed }
}

function makeValidGraphState(trackId = '7') {
  return {
    schemaVersion: 1,
    trackId,
    nodes: [
      { id: 'input', type: 'trackInput' },
      {
        id: 'fx-1',
        type: 'effect',
        data: {
          effectInstanceId: 'effect-1',
          pluginId: 'stock:eq',
          displayName: 'EQ',
          bypass: false,
          missing: false,
          crashed: false,
          sourceChainSlotIndex: 0,
          exposedParameterPorts: [],
        },
      },
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
  }
}

function makePositionedGraphState(trackId = '7', overrides = {}) {
  const base = makeValidGraphState(trackId)
  return {
    ...base,
    nodes: [
      { ...base.nodes[0], data: {}, position: { x: 0, y: 0 } },
      { ...base.nodes[1], position: { x: 260, y: 0 } },
      { ...base.nodes[2], data: {}, position: { x: 520, y: 0 } },
    ],
    viewport: { x: 0, y: 0, zoom: 1 },
    ...overrides,
  }
}

function graphWithoutEdges(trackId = '7') {
  return { ...makePositionedGraphState(trackId), edges: [] }
}

function graphWithTwoEffects(trackId = '7') {
  return {
    schemaVersion: 1,
    trackId,
    nodes: [
      { id: 'input', type: 'trackInput', data: {}, position: { x: 0, y: 0 } },
      {
        id: 'fx-1',
        type: 'effect',
        position: { x: 200, y: 0 },
        data: {
          effectInstanceId: 'effect-1',
          pluginId: 'stock:eq',
          displayName: 'EQ',
          bypass: false,
          missing: false,
          crashed: false,
          sourceChainSlotIndex: 0,
        },
      },
      {
        id: 'fx-2',
        type: 'effect',
        position: { x: 400, y: 0 },
        data: {
          effectInstanceId: 'effect-2',
          pluginId: 'stock:delay',
          displayName: 'Delay',
          bypass: false,
          missing: false,
          crashed: false,
          sourceChainSlotIndex: 1,
        },
      },
      { id: 'output', type: 'trackOutput', data: {}, position: { x: 600, y: 0 } },
    ],
    edges: [
      {
        id: 'edge-1-2',
        sourceNodeId: 'fx-1',
        sourcePort: 'audioOut',
        targetNodeId: 'fx-2',
        targetPort: 'audioIn',
        type: 'audio',
      },
    ],
    viewport: { x: 0, y: 0, zoom: 1 },
  }
}

// FXG.4-e/f — a positioned graph with a Macro node plus an effect node that
// exposes a writable 'mix' parameter port, so Macro -> Parameter links can be made.
function makeMacroLinkGraphState(trackId = '7', { readOnly = false } = {}) {
  const base = makePositionedGraphState(trackId)
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
              automatable: !readOnly,
              readOnly,
            },
          ],
        },
      },
      { id: 'macro-a', type: 'macro', position: { x: 80, y: 228 }, data: { label: 'Macro 1', normalizedValue: 0.5 } },
      base.nodes[2],
    ],
    edges: base.edges,
  }
}

// Builds the graph above and pre-links Macro -> fx-1 'mix' with an optional mapping,
// returning a graphState ready to seed for drive-only tests.
function makeLinkedMacroGraphState(trackId = '7', mapping) {
  const linked = connectMacroToParameter(makeMacroLinkGraphState(trackId), {
    sourceNodeId: 'macro-a',
    targetNodeId: 'fx-1',
    parameterId: 'mix',
    mapping,
  }, { idFactory: () => 'p-mix' })
  return linked.graphState
}

// EVC-R2 — a positioned graph with an Envelope control node plus an effect node that
// exposes a writable 'mix' parameter port, so Envelope -> Parameter links can be made.
// The envelope is configured (attack/decay/release 0, sustain 1) so a held trigger
// resolves immediately to a normalized output of 1 for deterministic drive assertions.
function makeEnvelopeLinkGraphState(trackId = '7', { readOnly = false } = {}) {
  const base = makePositionedGraphState(trackId)
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
              automatable: !readOnly,
              readOnly,
            },
          ],
        },
      },
      {
        id: 'env-a',
        type: 'envelope',
        position: { x: 80, y: 228 },
        data: {
          label: 'Envelope',
          attackMs: 0, holdMs: 0, decayMs: 0, sustain: 1, releaseMs: 0,
          amount: 1, includeSlideNotes: false,
        },
      },
      base.nodes[2],
    ],
    edges: base.edges,
  }
}

function makeLinkedEnvelopeGraphState(trackId = '7', mapping) {
  const linked = connectEnvelopeToParameter(makeEnvelopeLinkGraphState(trackId), {
    sourceNodeId: 'env-a',
    targetNodeId: 'fx-1',
    parameterId: 'mix',
    mapping,
  }, { idFactory: () => 'pe-mix' })
  return linked.graphState
}

async function loadEffectChainStoreFixture() {
  return import('./effectChainStore.js')
}

describe('effectChainStore FX mode safety gate', () => {
  let audio
  let timeline
  let graphEngineNodeSeq = 200
  let projectLoadedHandler = null

  beforeEach(() => {
    vi.resetModules()
    projectLoadedHandler = null

    graphEngineNodeSeq = 200
    audio = {
      getEffectChain: vi.fn(async () => '[]'),
      getMasterEffectChain: vi.fn(async () => '[]'),
      addEffect: vi.fn(async () => true),
      addMasterEffect: vi.fn(async () => true),
      removeEffect: vi.fn(async () => true),
      removeMasterEffect: vi.fn(async () => true),
      moveEffect: vi.fn(async () => true),
      moveMasterEffect: vi.fn(async () => true),
      setEffectBypass: vi.fn(async () => true),
      setMasterEffectBypass: vi.fn(async () => true),
      // FXG.3-b graph-owned engine lifecycle
      addGraphEffectNode: vi.fn(async () => graphEngineNodeSeq++),
      removeGraphEffectNode: vi.fn(async () => true),
      getGraphEffectEngineNodeId: vi.fn(async () => null),
      // FXG.4-a graph-owned parameter descriptors (engine returns JSON strings)
      getGraphEffectParameters: vi.fn(async (trackId, effectInstanceId) => JSON.stringify({
        ok: true,
        trackId,
        effectInstanceId,
        effectKind: 'stock',
        pluginFormat: 'stock',
        pluginId: 'delay',
        parameters: [
          {
            parameterId: 'feedback', parameterIndex: 0, parameterIdIsFallback: false,
            name: 'Feedback', unit: '%', normalizedValue: 0.5, defaultNormalizedValue: 0.4,
            automatable: true, readOnly: false, discrete: false, boolean: false,
            numSteps: 0, displayValue: '50%',
          },
          {
            parameterId: 'mix', parameterIndex: 1, parameterIdIsFallback: false,
            name: 'Mix', unit: '%', normalizedValue: 0.25, defaultNormalizedValue: 1.0,
            automatable: true, readOnly: false, discrete: false, boolean: false,
            numSteps: 0, displayValue: '25%',
          },
        ],
      })),
      getGraphEffectParameterValue: vi.fn(async (trackId, effectInstanceId, parameterId) =>
        JSON.stringify({ ok: true, trackId, effectInstanceId, parameterId, parameterIndex: 0, normalizedValue: 0.5, displayValue: '50%' })),
      setGraphEffectParameterNormalized: vi.fn(async (trackId, effectInstanceId, parameterId, value) =>
        JSON.stringify({ ok: true, trackId, effectInstanceId, parameterId, parameterIndex: 0, normalizedValue: Math.min(1, Math.max(0, value)) })),
      hydrateGraphEffectNodes: vi.fn(async (_trackId, graphEffectNodes = []) => ({
        ok: true,
        mapping: Object.fromEntries(
          graphEffectNodes.map((node) => [node.effectInstanceId, graphEngineNodeSeq++]),
        ),
        skipped: [],
        failures: [],
      })),
      syncLinearGraphTopology: vi.fn(async () => ({
        ok: true,
        phase: 'FXG.3-d',
        mode: 'linear',
        reason: 'graph_routing_active',
        pathEffectCount: 1,
        appliedConnectionCount: 2,
      })),
      adoptGraphEffectNodes: vi.fn(async (_trackId, mapping = []) => ({
        ok: true,
        adopted: Object.fromEntries(mapping.map((m) => [m.effectInstanceId, m.engineNodeId])),
        skipped: [],
      })),
    }
    timeline = {
      setTrackGraphState: vi.fn(async () => true),
      setTrackFxMode: vi.fn(async () => true),
    }

    globalThis.window = {
      xleth: {
        audio,
        timeline,
        onGraphChanged: vi.fn(() => () => {}),
        onProjectLoaded: vi.fn((callback) => {
          projectLoadedHandler = callback
          return () => {}
        }),
      },
    }
  })

  afterEach(() => {
    delete globalThis.window
  })

  it('defaults fxMode and fxPanelView to chain and seeds them on fetch', async () => {
    const {
      default: useEffectChainStore,
      DEFAULT_FX_MODE,
      DEFAULT_FX_PANEL_VIEW,
      resolveFxMode,
      resolveFxPanelView,
    } = await loadEffectChainStoreFixture()

    expect(resolveFxMode(useEffectChainStore.getState().fxModes, '7')).toBe(DEFAULT_FX_MODE)
    expect(resolveFxPanelView(useEffectChainStore.getState().fxPanelViews, '7')).toBe(DEFAULT_FX_PANEL_VIEW)

    await useEffectChainStore.getState().fetchChain('7')

    const state = useEffectChainStore.getState()
    expect(state.fxModes['7']).toBe('chain')
    expect(state.fxPanelViews['7']).toBe('chain')
    expect(audio.getEffectChain).toHaveBeenCalledWith(7)
  })

  it('resolves only exact graph strings as graph fxMode', async () => {
    const { DEFAULT_FX_MODE, resolveFxMode } = await loadEffectChainStoreFixture()

    expect(resolveFxMode(undefined, '7')).toBe(DEFAULT_FX_MODE)
    expect(resolveFxMode({ '7': null }, '7')).toBe(DEFAULT_FX_MODE)
    expect(resolveFxMode({ '7': '' }, '7')).toBe(DEFAULT_FX_MODE)
    expect(resolveFxMode({ '7': 'invalid' }, '7')).toBe(DEFAULT_FX_MODE)
    expect(resolveFxMode({ '7': 'chain' }, '7')).toBe(DEFAULT_FX_MODE)
    expect(resolveFxMode({ '7': 'graph' }, '7')).toBe('graph')
    expect(resolveFxMode({ '7': 'Graph' }, '7')).toBe(DEFAULT_FX_MODE)
    expect(resolveFxMode({ '7': 'GRAPH' }, '7')).toBe(DEFAULT_FX_MODE)
  })

  it('hydrates fxModes from mixed timeline tracks and treats master as chain', async () => {
    const {
      default: useEffectChainStore,
      buildFxModesFromTracks,
      resolveFxMode,
    } = await loadEffectChainStoreFixture()
    const tracks = [
      { id: 7, fxMode: 'graph' },
      { id: 8, fxMode: 'chain' },
      { id: 9, fxMode: 'Graph' },
      { id: 10 },
    ]

    expect(buildFxModesFromTracks(tracks)).toEqual({
      '7': 'graph',
      '8': 'chain',
      '9': 'chain',
      '10': 'chain',
    })

    useEffectChainStore.setState({
      fxModes: { '7': 'chain', '8': 'graph', master: 'graph' },
      fxPanelViews: { '7': 'graphShell', master: 'graphShell' },
    })
    useEffectChainStore.getState().hydrateFxModesFromTracks(tracks)

    const state = useEffectChainStore.getState()
    expect(state.fxModes).toEqual({
      '7': 'graph',
      '8': 'chain',
      '9': 'chain',
      '10': 'chain',
    })
    expect(state.fxPanelViews).toEqual({})
    expect(resolveFxMode(state.fxModes, 'master')).toBe('chain')
  })

  it('hydrates chain-mode tracks without graphState as null graphState', async () => {
    const { default: useEffectChainStore } = await loadEffectChainStoreFixture()

    useEffectChainStore.getState().hydrateFxModesFromTracks([{ id: 7, fxMode: 'chain' }])

    const state = useEffectChainStore.getState()
    expect(state.fxModes['7']).toBe('chain')
    expect(state.graphStates['7']).toBeNull()
    expect(state.graphStateStatuses['7'].status).toBe('missing')
  })

  it('hydrates graph-mode tracks with valid graphState', async () => {
    const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
    const graphState = makeValidGraphState('7')

    useEffectChainStore.getState().hydrateFxModesFromTracks([
      { id: 7, fxMode: 'graph', graphState },
    ])

    const state = useEffectChainStore.getState()
    expect(state.fxModes['7']).toBe('graph')
    expect(state.graphStateStatuses['7'].status).toBe('valid')
    expect(state.graphStates['7']).toMatchObject({
      schemaVersion: 1,
      trackId: '7',
      viewport: { x: 0, y: 0, zoom: 1 },
    })
  })

  it('hydrates saved graphState node positions and viewport without touching chains', async () => {
    const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
    const baseChain = [makeEffect(11, 'compressor', 0)]
    const graphState = makePositionedGraphState('7', {
      viewport: { x: -44.5, y: 18.25, zoom: 2 },
    })

    useEffectChainStore.setState({
      chains: { '7': baseChain },
    })
    useEffectChainStore.getState().hydrateFxModesFromTracks([
      { id: 7, fxMode: 'graph', graphState },
    ])

    const state = useEffectChainStore.getState()
    expect(state.chains['7']).toBe(baseChain)
    expect(state.graphStates['7'].nodes.map((node) => [node.id, node.position])).toEqual([
      ['input', { x: 0, y: 0 }],
      ['fx-1', { x: 260, y: 0 }],
      ['output', { x: 520, y: 0 }],
    ])
    expect(state.graphStates['7'].viewport).toEqual({ x: -44.5, y: 18.25, zoom: 2 })
  })

  it('hydrates malformed graphState layout data with deterministic repairs', async () => {
    const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
    const graphState = {
      ...makeValidGraphState('7'),
      nodes: [
        { ...makeValidGraphState('7').nodes[0], position: null },
        { ...makeValidGraphState('7').nodes[1], position: { x: Number.NaN, y: 4 } },
        { ...makeValidGraphState('7').nodes[2], position: { x: 'bad', y: undefined } },
      ],
      viewport: { x: 'bad', y: 12, zoom: Number.POSITIVE_INFINITY },
    }

    useEffectChainStore.getState().hydrateFxModesFromTracks([
      { id: 7, fxMode: 'graph', graphState },
    ])

    const state = useEffectChainStore.getState()
    expect(state.graphStateStatuses['7'].status).toBe('valid')
    expect(state.graphStates['7'].nodes.map((node) => node.position)).toEqual([
      { x: 0, y: 0 },
      { x: 260, y: 0 },
      { x: 520, y: 0 },
    ])
    expect(state.graphStates['7'].viewport).toEqual({ x: 0, y: 12, zoom: 1 })
  })

  it('marks graph-mode tracks with missing graphState as missing without throwing', async () => {
    const { default: useEffectChainStore } = await loadEffectChainStoreFixture()

    expect(() => {
      useEffectChainStore.getState().hydrateFxModesFromTracks([{ id: 7, fxMode: 'graph' }])
    }).not.toThrow()

    const state = useEffectChainStore.getState()
    expect(state.fxModes['7']).toBe('graph')
    expect(state.graphStates['7']).toBeNull()
    expect(state.graphStateStatuses['7'].status).toBe('missing')
    expect(state.graphStateStatuses['7'].warnings[0].code).toBe('missingGraphState')
  })

  it('marks invalid graphState as invalid without throwing', async () => {
    const { default: useEffectChainStore } = await loadEffectChainStoreFixture()

    expect(() => {
      useEffectChainStore.getState().hydrateFxModesFromTracks([
        { id: 7, fxMode: 'graph', graphState: { schemaVersion: 1, trackId: '7', nodes: [], edges: 'nope' } },
      ])
    }).not.toThrow()

    const state = useEffectChainStore.getState()
    expect(state.graphStates['7']).toBeNull()
    expect(state.graphStateStatuses['7']).toMatchObject({
      status: 'invalid',
      reason: 'invalid_edges',
    })
  })

  it('preserves dormant graphState for chain-mode tracks', async () => {
    const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
    const graphState = makeValidGraphState('7')

    useEffectChainStore.getState().hydrateFxModesFromTracks([
      { id: 7, fxMode: 'chain', graphState },
    ])

    const state = useEffectChainStore.getState()
    expect(state.fxModes['7']).toBe('chain')
    expect(state.graphStateStatuses['7'].status).toBe('valid')
    expect(state.graphStates['7']?.nodes).toHaveLength(3)
  })

  it('ignores master graphState during hydration', async () => {
    const {
      default: useEffectChainStore,
      buildGraphStateHydrationFromTracks,
    } = await loadEffectChainStoreFixture()

    expect(buildGraphStateHydrationFromTracks([
      { id: 'master', fxMode: 'graph', graphState: makeValidGraphState('master') },
    ], { logWarnings: false })).toEqual({
      graphStates: {},
      graphStateStatuses: {},
    })

    useEffectChainStore.setState({
      fxModes: { master: 'graph' },
      fxPanelViews: { master: 'graphShell' },
      graphStates: { master: makeValidGraphState('master') },
    })
    useEffectChainStore.getState().hydrateFxModesFromTracks([
      { id: 'master', fxMode: 'graph', graphState: makeValidGraphState('master') },
    ])

    const state = useEffectChainStore.getState()
    expect(state.graphStates.master).toBeUndefined()
    expect(state.graphStateStatuses.master).toBeUndefined()
  })

  it('keeps add, remove, move, and bypass mutations working in chain mode', async () => {
    const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
    const baseChain = [
      makeEffect(11, 'compressor', 0),
      makeEffect(12, 'delay', 1),
    ]
    const chainAfterAdd = [
      makeEffect(11, 'compressor', 0),
      makeEffect(12, 'delay', 1),
      makeEffect(13, 'reverb', 2),
    ]
    const chainAfterRemove = [
      makeEffect(12, 'delay', 0),
      makeEffect(13, 'reverb', 1),
    ]
    const chainAfterMove = [
      makeEffect(13, 'reverb', 0),
      makeEffect(12, 'delay', 1),
    ]
    const chainAfterBypass = [
      makeEffect(13, 'reverb', 0, true),
      makeEffect(12, 'delay', 1),
    ]

    audio.getEffectChain
      .mockResolvedValueOnce(JSON.stringify(chainAfterAdd))
      .mockResolvedValueOnce(JSON.stringify(chainAfterRemove))
      .mockResolvedValueOnce(JSON.stringify(chainAfterMove))
      .mockResolvedValueOnce(JSON.stringify(chainAfterBypass))

    useEffectChainStore.setState({
      chains: { '7': baseChain },
      fxModes: { '7': 'chain' },
      fxPanelViews: { '7': 'chain' },
    })

    await useEffectChainStore.getState().addEffect('7', 'reverb')
    expect(audio.addEffect).toHaveBeenCalledWith(7, 'reverb', 2)
    expect(useEffectChainStore.getState().chains['7']).toEqual(chainAfterAdd)

    await useEffectChainStore.getState().removeEffect('7', 11)
    expect(audio.removeEffect).toHaveBeenCalledWith(7, 11)
    expect(useEffectChainStore.getState().chains['7']).toEqual(chainAfterRemove)

    await useEffectChainStore.getState().moveEffect('7', 12, 1)
    expect(audio.moveEffect).toHaveBeenCalledWith(7, 12, 1)
    expect(useEffectChainStore.getState().chains['7']).toEqual(chainAfterMove)

    await useEffectChainStore.getState().setBypass('7', 13, true)
    expect(audio.setEffectBypass).toHaveBeenCalledWith(7, 13, true)
    expect(useEffectChainStore.getState().chains['7']).toEqual(chainAfterBypass)
    expect(audio.syncLinearGraphTopology).not.toHaveBeenCalled()
  })

  it('keeps chain mode editable even if a legacy chain payload has topology metadata', async () => {
    const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
    const legacyTopologyChain = [
      { ...makeEffect(11, 'compressor', 0), outputs: [12] },
      { ...makeEffect(12, 'delay', 1), inputs: [11] },
    ]
    const chainAfterAdd = [
      ...legacyTopologyChain,
      makeEffect(13, 'reverb', 2),
    ]
    audio.getEffectChain.mockResolvedValueOnce(JSON.stringify(chainAfterAdd))

    useEffectChainStore.setState({
      chains: { '7': legacyTopologyChain },
      fxModes: { '7': 'chain' },
    })

    await expect(useEffectChainStore.getState().addEffect('7', 'reverb')).resolves.toBe(true)

    expect(audio.addEffect).toHaveBeenCalledWith(7, 'reverb', 2)
    expect(useEffectChainStore.getState().chains['7']).toEqual(chainAfterAdd)
    expect(audio.syncLinearGraphTopology).not.toHaveBeenCalled()
  })

  it('blocks chain mutations when fxMode is graph', async () => {
    const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
    const baseChain = [
      makeEffect(11, 'compressor', 0),
      makeEffect(12, 'delay', 1),
    ]

    useEffectChainStore.setState({
      chains: { '7': baseChain },
      fxModes: { '7': 'graph' },
      fxPanelViews: { '7': 'graphShell' },
    })

    await expect(useEffectChainStore.getState().addEffect('7', 'reverb')).resolves.toBe(false)
    await expect(useEffectChainStore.getState().removeEffect('7', 11)).resolves.toBe(false)
    await expect(useEffectChainStore.getState().moveEffect('7', 12, 0)).resolves.toBe(false)
    await expect(useEffectChainStore.getState().setBypass('7', 12, true)).resolves.toBe(false)

    expect(audio.addEffect).not.toHaveBeenCalled()
    expect(audio.removeEffect).not.toHaveBeenCalled()
    expect(audio.moveEffect).not.toHaveBeenCalled()
    expect(audio.setEffectBypass).not.toHaveBeenCalled()
    expect(audio.syncLinearGraphTopology).not.toHaveBeenCalled()
    expect(useEffectChainStore.getState().chains['7']).toEqual(baseChain)
  })

  it('converts chain mode to graphState and graph fxMode atomically in renderer state', async () => {
    const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
    const baseChain = [
      makeEffect(11, 'compressor', 0),
      makeEffect(12, 'delay', 1, true),
    ]
    useEffectChainStore.setState({
      chains: { '7': baseChain },
      fxModes: { '7': 'chain' },
      graphStates: { '7': null },
    })

    const result = await useEffectChainStore.getState().convertChainToGraphMode(7, {
      warn: vi.fn(),
    })

    const state = useEffectChainStore.getState()
    expect(result.ok).toBe(true)
    expect(state.fxModes['7']).toBe('graph')
    expect(state.graphStateStatuses['7'].status).toBe('valid')
    expect(state.graphStates['7']).toMatchObject({
      schemaVersion: 1,
      trackId: '7',
      viewport: { x: 0, y: 0, zoom: 1 },
    })
    expect(state.graphStates['7'].nodes.filter((node) => node.type === 'effect')).toHaveLength(2)
    expect(state.chains['7']).toEqual(baseChain)
    expect(timeline.setTrackGraphState).toHaveBeenCalledWith(7, state.graphStates['7'])
    expect(timeline.setTrackFxMode).toHaveBeenCalledWith(7, 'graph')
    expect(timeline.setTrackGraphState.mock.invocationCallOrder[0])
      .toBeLessThan(timeline.setTrackFxMode.mock.invocationCallOrder[0])

    // FXG.3-d ownership transfer: conversion adopts the existing chain
    // processors as graph-owned (by chain-slot engine nodeId, preserving state)
    // and hands routing ownership to the engine so the old chain route dies.
    expect(audio.adoptGraphEffectNodes).toHaveBeenCalledWith(7, expect.arrayContaining([
      expect.objectContaining({ engineNodeId: 11 }),
      expect.objectContaining({ engineNodeId: 12 }),
    ]))
    expect(audio.syncLinearGraphTopology).toHaveBeenCalledWith(7, expect.objectContaining({
      trackId: '7',
    }))
    expect(result.runtimeSync).toMatchObject({ ok: true, reason: 'graph_routing_active' })
    // The adopted engine node ids land in the session-only cache.
    expect(Object.values(state.graphEngineNodeIds['7'] ?? {})).toEqual(
      expect.arrayContaining([11, 12]),
    )
  })

  it('updates only one graphState node position and persists through the graphState path', async () => {
    const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
    const baseChain = [makeEffect(11, 'compressor', 0)]
    const graphState = {
      ...makeValidGraphState('7'),
      nodes: [
        { ...makeValidGraphState('7').nodes[0], position: { x: 0, y: 0 } },
        { ...makeValidGraphState('7').nodes[1], position: { x: 260, y: 0 } },
        { ...makeValidGraphState('7').nodes[2], position: { x: 520, y: 0 } },
      ],
      viewport: { x: 0, y: 0, zoom: 1 },
    }

    useEffectChainStore.setState({
      chains: { '7': baseChain },
      fxModes: { '7': 'graph' },
      graphStates: { '7': graphState },
      graphStateStatuses: { '7': { status: 'valid', graphState, warnings: [] } },
    })

    await expect(
      useEffectChainStore.getState().setGraphStateNodePosition(7, 'fx-1', { x: 333.25, y: 44.5 }),
    ).resolves.toBe(true)

    const state = useEffectChainStore.getState()
    const nextGraphState = state.graphStates['7']
    expect(nextGraphState.nodes.find((node) => node.id === 'fx-1')?.position)
      .toEqual({ x: 333.25, y: 44.5 })
    expect(nextGraphState.nodes.find((node) => node.id === 'input')?.position)
      .toEqual({ x: 0, y: 0 })
    expect(nextGraphState.nodes.find((node) => node.id === 'output')?.position)
      .toEqual({ x: 520, y: 0 })
    expect(nextGraphState.edges).toEqual(graphState.edges)
    expect(nextGraphState.viewport).toEqual(graphState.viewport)
    expect(nextGraphState.trackId).toBe('7')
    expect(state.chains['7']).toBe(baseChain)
    expect(timeline.setTrackGraphState).toHaveBeenCalledWith(7, nextGraphState)
    expect(timeline.setTrackFxMode).not.toHaveBeenCalled()
    expect(audio.moveEffect).not.toHaveBeenCalled()
    expect(audio.syncLinearGraphTopology).not.toHaveBeenCalled()
  })

  it('repairs missing sibling positions during node layout writes without mutating chains', async () => {
    const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
    const baseChain = [makeEffect(11, 'compressor', 0)]
    const graphState = {
      ...makeValidGraphState('7'),
      layoutMetadata: { preserved: true },
      viewport: { x: 3, y: 4, zoom: 1 },
    }

    useEffectChainStore.setState({
      chains: { '7': baseChain },
      fxModes: { '7': 'graph' },
      graphStates: { '7': graphState },
      graphStateStatuses: { '7': { status: 'valid', graphState, warnings: [] } },
    })

    await expect(
      useEffectChainStore.getState().setGraphStateNodePosition(7, 'fx-1', { x: 333, y: 44 }),
    ).resolves.toBe(true)

    const state = useEffectChainStore.getState()
    const nextGraphState = state.graphStates['7']
    expect(nextGraphState.layoutMetadata).toEqual({ preserved: true })
    expect(nextGraphState.nodes.map((node) => [node.id, node.position])).toEqual([
      ['input', { x: 0, y: 0 }],
      ['fx-1', { x: 333, y: 44 }],
      ['output', { x: 520, y: 0 }],
    ])
    expect(nextGraphState.edges).toEqual(graphState.edges)
    expect(nextGraphState.viewport).toEqual(graphState.viewport)
    expect(state.chains['7']).toBe(baseChain)
    expect(timeline.setTrackGraphState).toHaveBeenCalledWith(7, nextGraphState)
    expect(audio.moveEffect).not.toHaveBeenCalled()
    expect(audio.syncLinearGraphTopology).not.toHaveBeenCalled()
  })

  it('blocks graphState node position updates while Mixer Chain owns the track', async () => {
    const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
    const graphState = makeValidGraphState('7')

    useEffectChainStore.setState({
      fxModes: { '7': 'chain' },
      graphStates: { '7': graphState },
      graphStateStatuses: { '7': { status: 'valid', graphState, warnings: [] } },
    })

    await expect(
      useEffectChainStore.getState().setGraphStateNodePosition(7, 'fx-1', { x: 100, y: 20 }),
    ).resolves.toBe(false)

    expect(useEffectChainStore.getState().graphStates['7']).toBe(graphState)
    expect(timeline.setTrackGraphState).not.toHaveBeenCalled()
    expect(audio.syncLinearGraphTopology).not.toHaveBeenCalled()
  })

  it('updates graphState viewport without mutating nodes, edges, or chains', async () => {
    const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
    const baseChain = [makeEffect(11, 'compressor', 0)]
    const graphState = {
      ...makeValidGraphState('7'),
      nodes: [
        { ...makeValidGraphState('7').nodes[0], position: { x: 0, y: 0 } },
        { ...makeValidGraphState('7').nodes[1], position: { x: 260, y: 0 } },
        { ...makeValidGraphState('7').nodes[2], position: { x: 520, y: 0 } },
      ],
      viewport: { x: 0, y: 0, zoom: 1 },
    }

    useEffectChainStore.setState({
      chains: { '7': baseChain },
      fxModes: { '7': 'graph' },
      graphStates: { '7': graphState },
      graphStateStatuses: { '7': { status: 'valid', graphState, warnings: [] } },
    })

    await expect(
      useEffectChainStore.getState().setGraphStateViewport(7, { x: -120.5, y: 80.25 }),
    ).resolves.toBe(true)

    const state = useEffectChainStore.getState()
    const nextGraphState = state.graphStates['7']
    expect(nextGraphState.viewport).toEqual({ x: -120.5, y: 80.25, zoom: 1 })
    expect(nextGraphState.nodes.map((node) => ({ id: node.id, position: node.position })))
      .toEqual(graphState.nodes.map((node) => ({ id: node.id, position: node.position })))
    expect(nextGraphState.edges).toEqual(graphState.edges)
    expect(state.chains['7']).toBe(baseChain)
    expect(timeline.setTrackGraphState).toHaveBeenCalledWith(7, nextGraphState)
    expect(timeline.setTrackFxMode).not.toHaveBeenCalled()
    expect(audio.moveEffect).not.toHaveBeenCalled()
    expect(audio.syncLinearGraphTopology).not.toHaveBeenCalled()
  })

  it('repairs invalid stored viewport during viewport writes without mutating chains', async () => {
    const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
    const baseChain = [makeEffect(11, 'compressor', 0)]
    const graphState = {
      ...makePositionedGraphState('7'),
      layoutMetadata: { preserved: true },
      viewport: { x: 'bad', y: null, zoom: Number.POSITIVE_INFINITY },
    }

    useEffectChainStore.setState({
      chains: { '7': baseChain },
      fxModes: { '7': 'graph' },
      graphStates: { '7': graphState },
      graphStateStatuses: { '7': { status: 'valid', graphState, warnings: [] } },
    })

    await expect(
      useEffectChainStore.getState().setGraphStateViewport(7, { x: -25.5, y: 40.25 }),
    ).resolves.toBe(true)

    const state = useEffectChainStore.getState()
    const nextGraphState = state.graphStates['7']
    expect(nextGraphState.layoutMetadata).toEqual({ preserved: true })
    expect(nextGraphState.viewport).toEqual({ x: -25.5, y: 40.25, zoom: 1 })
    expect(nextGraphState.nodes).toEqual(makePositionedGraphState('7').nodes)
    expect(nextGraphState.edges).toEqual(graphState.edges)
    expect(state.chains['7']).toBe(baseChain)
    expect(timeline.setTrackGraphState).toHaveBeenCalledWith(7, nextGraphState)
    expect(audio.moveEffect).not.toHaveBeenCalled()
    expect(audio.syncLinearGraphTopology).not.toHaveBeenCalled()
  })

  it('blocks graphState viewport updates while Mixer Chain owns the track', async () => {
    const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
    const graphState = {
      ...makeValidGraphState('7'),
      viewport: { x: 0, y: 0, zoom: 1 },
    }

    useEffectChainStore.setState({
      chains: { '7': [makeEffect(11, 'compressor', 0)] },
      fxModes: { '7': 'chain' },
      graphStates: { '7': graphState },
      graphStateStatuses: { '7': { status: 'valid', graphState, warnings: [] } },
    })

    await expect(
      useEffectChainStore.getState().setGraphStateViewport(7, { x: 25, y: 40 }),
    ).resolves.toBe(false)

    expect(useEffectChainStore.getState().graphStates['7']).toBe(graphState)
    expect(timeline.setTrackGraphState).not.toHaveBeenCalled()
  })

  it('rejects master, missing, and already graph-mode conversion without persistence', async () => {
    const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
    useEffectChainStore.setState({
      chains: { '7': [makeEffect(11, 'compressor', 0)] },
      fxModes: { '7': 'graph' },
    })

    await expect(useEffectChainStore.getState().convertChainToGraphMode('master')).resolves.toMatchObject({
      ok: false,
      reason: 'master_track',
    })
    await expect(useEffectChainStore.getState().convertChainToGraphMode(null)).resolves.toMatchObject({
      ok: false,
      reason: 'no_track',
    })
    await expect(useEffectChainStore.getState().convertChainToGraphMode(7)).resolves.toMatchObject({
      ok: false,
      reason: 'already_graph',
    })

    expect(timeline.setTrackGraphState).not.toHaveBeenCalled()
    expect(timeline.setTrackFxMode).not.toHaveBeenCalled()
  })

  it('validation failure leaves fxMode and graphState unchanged', async () => {
    const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
    const existingGraphState = makeValidGraphState('7')
    const warn = vi.fn()
    useEffectChainStore.setState({
      chains: { '7': [makeEffect(11, 'compressor', 0)] },
      fxModes: { '7': 'chain' },
      graphStates: { '7': existingGraphState },
      graphStateStatuses: { '7': { status: 'valid', graphState: existingGraphState, warnings: [] } },
    })

    const result = await useEffectChainStore.getState().convertChainToGraphMode(7, {
      validateGraphState: () => ({
        status: 'invalid',
        graphState: null,
        reason: 'test_invalid_graph_state',
        warnings: [],
      }),
      warn,
    })

    const state = useEffectChainStore.getState()
    expect(result).toMatchObject({ ok: false, reason: 'test_invalid_graph_state' })
    expect(state.fxModes['7']).toBe('chain')
    expect(state.graphStates['7']).toBe(existingGraphState)
    expect(state.graphStateStatuses['7'].status).toBe('valid')
    expect(timeline.setTrackGraphState).not.toHaveBeenCalled()
    expect(timeline.setTrackFxMode).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[FXG]'), expect.objectContaining({
      trackId: '7',
      reason: 'test_invalid_graph_state',
    }))
  })

  it('rolls back persisted graphState if fxMode persistence fails', async () => {
    const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
    const existingGraphState = makeValidGraphState('7')
    timeline.setTrackFxMode.mockResolvedValueOnce(false)
    useEffectChainStore.setState({
      chains: { '7': [makeEffect(11, 'compressor', 0)] },
      fxModes: { '7': 'chain' },
      graphStates: { '7': existingGraphState },
      graphStateStatuses: { '7': { status: 'valid', graphState: existingGraphState, warnings: [] } },
    })

    const result = await useEffectChainStore.getState().convertChainToGraphMode(7, {
      warn: vi.fn(),
    })

    const state = useEffectChainStore.getState()
    expect(result).toMatchObject({ ok: false, reason: 'persistence_failed' })
    expect(state.fxModes['7']).toBe('chain')
    expect(state.graphStates['7']).toBe(existingGraphState)
    expect(state.graphStateStatuses['7'].status).toBe('valid')
    expect(timeline.setTrackGraphState).toHaveBeenCalledTimes(2)
    expect(timeline.setTrackGraphState).toHaveBeenNthCalledWith(2, 7, existingGraphState)
  })

  it('does not commit a partial renderer state when graphState persistence fails', async () => {
    const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
    timeline.setTrackGraphState.mockResolvedValueOnce(false)
    useEffectChainStore.setState({
      chains: { '7': [makeEffect(11, 'compressor', 0)] },
      fxModes: { '7': 'chain' },
      graphStates: { '7': null },
    })

    const result = await useEffectChainStore.getState().convertChainToGraphMode(7, {
      warn: vi.fn(),
    })

    const state = useEffectChainStore.getState()
    expect(result).toMatchObject({ ok: false, reason: 'persistence_failed' })
    expect(state.fxModes['7']).toBe('chain')
    expect(state.graphStates['7']).toBeNull()
    expect(state.graphStateStatuses['7']).toBeUndefined()
    expect(timeline.setTrackFxMode).not.toHaveBeenCalled()
  })

  it('resets renderer-only mode and panel view state on project load', async () => {
    const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
    const refreshedChain = [makeEffect(11, 'compressor', 0)]

    audio.getEffectChain.mockResolvedValueOnce(JSON.stringify(refreshedChain))

    useEffectChainStore.setState({
      chains: { '7': [makeEffect(11, 'compressor', 0)] },
      fxModes: { '7': 'graph' },
      fxPanelViews: { '7': 'graphShell' },
    })

    expect(projectLoadedHandler).toBeTypeOf('function')

    projectLoadedHandler()
    await Promise.resolve()

    const state = useEffectChainStore.getState()
    expect(state.fxModes['7']).toBe('chain')
    expect(state.fxPanelViews['7']).toBe('chain')
    expect(state.chains['7']).toEqual(refreshedChain)
    expect(audio.getEffectChain).toHaveBeenCalledWith(7)
  })

  it('hydrates graph-owned tracks after project load without activating graph editing', async () => {
    const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
    const refreshedChain = [makeEffect(11, 'compressor', 0)]

    window.xleth.timeline = {
      getTracks: vi.fn(async () => [{ id: 7, fxMode: 'graph' }]),
    }
    audio.getEffectChain.mockResolvedValueOnce(JSON.stringify(refreshedChain))

    useEffectChainStore.setState({
      chains: { '7': [makeEffect(11, 'compressor', 0)] },
      fxModes: { '7': 'chain' },
      fxPanelViews: { '7': 'graphShell' },
    })

    projectLoadedHandler()
    await Promise.resolve()
    await Promise.resolve()

    const state = useEffectChainStore.getState()
    expect(state.fxModes['7']).toBe('graph')
    expect(state.fxPanelViews).toEqual({})
    expect(state.graphStateStatuses['7'].status).toBe('missing')
    expect(window.xleth.timeline.getTracks).toHaveBeenCalled()
    expect(window.xleth.onGraphChanged).toHaveBeenCalled()
  })

  it('hydrates graph layout from timeline tracks after project load', async () => {
    const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
    const refreshedChain = [makeEffect(11, 'compressor', 0)]
    const graphState = makePositionedGraphState('7', {
      viewport: { x: -12, y: 24, zoom: 1.5 },
    })

    window.xleth.timeline = {
      getTracks: vi.fn(async () => [{ id: 7, fxMode: 'graph', graphState }]),
    }
    audio.getEffectChain.mockResolvedValueOnce(JSON.stringify(refreshedChain))

    useEffectChainStore.setState({
      chains: { '7': [makeEffect(11, 'compressor', 0)] },
      fxModes: { '7': 'chain' },
      graphStates: { '7': null },
      graphStateStatuses: {},
    })

    projectLoadedHandler()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    const state = useEffectChainStore.getState()
    expect(state.fxModes['7']).toBe('graph')
    expect(state.chains['7']).toEqual(refreshedChain)
    expect(state.graphStateStatuses['7'].status).toBe('valid')
    expect(state.graphStates['7'].nodes.map((node) => node.position)).toEqual([
      { x: 0, y: 0 },
      { x: 260, y: 0 },
      { x: 520, y: 0 },
    ])
    expect(state.graphStates['7'].viewport).toEqual({ x: -12, y: 24, zoom: 1.5 })
    expect(audio.hydrateGraphEffectNodes).toHaveBeenCalledWith(7, [
      {
        effectInstanceId: 'effect-1',
        pluginId: 'stock:eq',
        graphNodeId: 'fx-1',
        displayName: 'EQ',
      },
    ])
    expect(audio.syncLinearGraphTopology).toHaveBeenCalledWith(7, expect.objectContaining({
      phase: 'FXG.3-c-b',
      trackId: '7',
    }))
    expect(state.graphEngineNodeIds['7']['effect-1']).toEqual(expect.any(Number))
    expect(state.graphRuntimeStatuses['7']).toMatchObject({ ok: true, reason: 'graph_routing_active' })
  })

  it('builds a minimal graph effect hydration payload and skips non-runtime nodes', async () => {
    const { buildGraphEffectNodeHydrationPayload } = await loadEffectChainStoreFixture()
    const graphState = {
      ...makePositionedGraphState('7'),
      nodes: [
        { id: 'input', type: 'trackInput', data: {} },
        {
          id: 'real',
          type: 'effect',
          data: {
            effectInstanceId: 'inst-real',
            pluginId: 'reverb',
            displayName: 'Reverb',
          },
        },
        {
          id: 'placeholder',
          type: 'effect',
          data: {
            effectInstanceId: 'inst-placeholder',
            pluginId: 'placeholder',
            displayName: 'Effect Node',
          },
        },
        {
          id: 'no-instance',
          type: 'effect',
          data: { pluginId: 'delay', displayName: 'Delay' },
        },
        {
          id: 'missing',
          type: 'effect',
          data: {
            effectInstanceId: 'inst-missing',
            pluginId: 'third-party-missing',
            displayName: 'Missing Plugin',
            missing: true,
          },
        },
        { id: 'output', type: 'trackOutput', data: {} },
      ],
    }

    expect(buildGraphEffectNodeHydrationPayload(graphState)).toEqual([
      {
        effectInstanceId: 'inst-real',
        pluginId: 'reverb',
        graphNodeId: 'real',
        displayName: 'Reverb',
      },
    ])
  })

  it('hydrates only graph-mode graphState effects and rebuilds the session engine cache', async () => {
    const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
    const graphState = makePositionedGraphState('7')
    const chainModeGraphState = makePositionedGraphState('8')
    const baseChain = [makeEffect(11, 'compressor', 0)]
    audio.hydrateGraphEffectNodes.mockResolvedValueOnce({
      ok: true,
      mapping: { 'effect-1': 777 },
      skipped: [],
      failures: [],
    })

    useEffectChainStore.setState({
      chains: { '7': baseChain, '8': [makeEffect(12, 'delay', 0)] },
      fxModes: { '7': 'graph', '8': 'chain', master: 'graph' },
      graphStates: {
        '7': graphState,
        '8': chainModeGraphState,
        master: makePositionedGraphState('master'),
      },
      graphStateStatuses: {
        '7': { status: 'valid', graphState },
        '8': { status: 'valid', graphState: chainModeGraphState },
      },
    })

    const result = await useEffectChainStore.getState().hydrateGraphEffectInstancesForLoadedProject()

    expect(result.ok).toBe(true)
    expect(audio.hydrateGraphEffectNodes).toHaveBeenCalledTimes(1)
    expect(audio.hydrateGraphEffectNodes).toHaveBeenCalledWith(7, [
      {
        effectInstanceId: 'effect-1',
        pluginId: 'stock:eq',
        graphNodeId: 'fx-1',
        displayName: 'EQ',
      },
    ])
    expect(audio.syncLinearGraphTopology).toHaveBeenCalledTimes(1)
    expect(audio.syncLinearGraphTopology).toHaveBeenCalledWith(7, expect.objectContaining({
      nodes: expect.arrayContaining([
        expect.objectContaining({ nodeId: 'fx-1', effectInstanceId: 'effect-1' }),
      ]),
    }))
    expect(useEffectChainStore.getState().graphEngineNodeIds['7']).toEqual({ 'effect-1': 777 })
    expect(useEffectChainStore.getState().graphRuntimeStatuses['7']).toMatchObject({ ok: true })
    expect(useEffectChainStore.getState().chains['7']).toBe(baseChain)
  })

  it('keeps graphState intact when graph-owned hydration reports failures', async () => {
    const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
    const warn = vi.fn()
    const graphState = makePositionedGraphState('7')
    audio.hydrateGraphEffectNodes.mockResolvedValueOnce({
      ok: false,
      reason: 'partial_failure',
      mapping: {},
      skipped: [],
      failures: [{ effectInstanceId: 'effect-1', pluginId: 'stock:eq', reason: 'instantiation_failed' }],
    })

    useEffectChainStore.setState({
      fxModes: { '7': 'graph' },
      graphStates: { '7': graphState },
      graphStateStatuses: { '7': { status: 'valid', graphState } },
      graphEngineNodeIds: {},
    })

    const result = await useEffectChainStore.getState().hydrateGraphEffectInstancesForLoadedProject({ warn })

    expect(result.ok).toBe(false)
    expect(useEffectChainStore.getState().graphStates['7']).toBe(graphState)
    expect(useEffectChainStore.getState().graphEngineNodeIds).toEqual({})
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('hydration incomplete'), expect.objectContaining({
      trackId: '7',
      reason: 'partial_failure',
    }))
  })

  // --- FXG.2C-e graphState mutation actions ---

  function seedGraphMode(useEffectChainStore, graphState, { baseChain = [makeEffect(11, 'compressor', 0)] } = {}) {
    const key = String(graphState.trackId ?? '7')
    useEffectChainStore.setState({
      chains: { [key]: baseChain },
      fxModes: { [key]: 'graph' },
      graphStates: { [key]: graphState },
      graphStateStatuses: { [key]: { status: 'valid', graphState, warnings: [] } },
      graphHistories: {},
    })
    return baseChain
  }

  it('adds an effect node to a graph-owned track and persists without touching chains', async () => {
    const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
    let idCounter = 0
    const idFactory = () => `gen-${idCounter++}`
    const baseChain = seedGraphMode(useEffectChainStore, makePositionedGraphState('7'))

    const result = await useEffectChainStore.getState().addGraphEffectNodeForTrack('7', {}, { idFactory })

    expect(result.ok).toBe(true)
    const next = useEffectChainStore.getState().graphStates['7']
    const effects = next.nodes.filter((node) => node.type === 'effect')
    expect(effects).toHaveLength(2)
    const added = effects.find((node) => node.id !== 'fx-1')
    expect(added).toMatchObject({
      type: 'effect',
      data: {
        pluginId: 'placeholder',
        displayName: 'Effect Node',
        bypass: false,
        missing: false,
        crashed: false,
        sourceChainSlotIndex: null,
      },
    })
    expect(Number.isFinite(added.position.x) && Number.isFinite(added.position.y)).toBe(true)
    // Existing node positions and viewport are preserved.
    expect(next.nodes.find((node) => node.id === 'input').position).toEqual({ x: 0, y: 0 })
    expect(next.nodes.find((node) => node.id === 'fx-1').position).toEqual({ x: 260, y: 0 })
    expect(next.nodes.find((node) => node.id === 'output').position).toEqual({ x: 520, y: 0 })
    expect(next.viewport).toEqual({ x: 0, y: 0, zoom: 1 })
    // effectChains untouched.
    expect(useEffectChainStore.getState().chains['7']).toBe(baseChain)
    expect(timeline.setTrackGraphState).toHaveBeenCalledWith(7, next)
    expect(timeline.setTrackFxMode).not.toHaveBeenCalled()
    expect(audio.addEffect).not.toHaveBeenCalled()
    expect(audio.syncLinearGraphTopology).toHaveBeenCalledWith(7, expect.objectContaining({
      phase: 'FXG.3-c-b',
      nodes: expect.arrayContaining([
        expect.objectContaining({ nodeId: 'fx-1', effectInstanceId: 'effect-1' }),
      ]),
    }))
    expect(result.runtimeSync).toMatchObject({ ok: true, reason: 'graph_routing_active' })
  })

  it('honors an explicit effect node draft and position when adding', async () => {
    const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
    seedGraphMode(useEffectChainStore, graphWithoutEdges('7'))

    const result = await useEffectChainStore.getState().addGraphEffectNodeForTrack('7', {
      effectInstanceId: 'inst-99',
      pluginId: 'stock:reverb',
      displayName: 'Reverb',
      position: { x: 333, y: 222 },
    })

    expect(result.ok).toBe(true)
    const added = useEffectChainStore.getState().graphStates['7'].nodes
      .find((node) => node.data?.effectInstanceId === 'inst-99')
    expect(added).toMatchObject({
      type: 'effect',
      position: { x: 333, y: 222 },
      data: { pluginId: 'stock:reverb', displayName: 'Reverb', sourceChainSlotIndex: null },
    })
    expect(audio.syncLinearGraphTopology).toHaveBeenCalled()
  })

  it('blocks adding an effect node while Mixer Chain owns the track', async () => {
    const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
    const graphState = makePositionedGraphState('7')
    useEffectChainStore.setState({
      chains: { '7': [makeEffect(11, 'compressor', 0)] },
      fxModes: { '7': 'chain' },
      graphStates: { '7': graphState },
      graphStateStatuses: { '7': { status: 'valid', graphState, warnings: [] } },
    })

    await expect(
      useEffectChainStore.getState().addGraphEffectNodeForTrack('7', {}),
    ).resolves.toMatchObject({ ok: false, reason: 'not_graph_mode' })

    expect(useEffectChainStore.getState().graphStates['7']).toBe(graphState)
    expect(timeline.setTrackGraphState).not.toHaveBeenCalled()
  })

  it('blocks graph mutations on the master track', async () => {
    const { default: useEffectChainStore } = await loadEffectChainStoreFixture()

    await expect(
      useEffectChainStore.getState().addGraphEffectNodeForTrack('master', {}),
    ).resolves.toMatchObject({ ok: false, reason: 'master_track' })
    await expect(
      useEffectChainStore.getState().removeGraphNodeForTrack(null, 'fx-1'),
    ).resolves.toMatchObject({ ok: false, reason: 'no_track' })

    expect(timeline.setTrackGraphState).not.toHaveBeenCalled()
    expect(audio.syncLinearGraphTopology).not.toHaveBeenCalled()
  })

  it('reports missing_graph_state when a graph-owned track has no graphState', async () => {
    const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
    useEffectChainStore.setState({
      fxModes: { '7': 'graph' },
      graphStates: { '7': null },
    })

    await expect(
      useEffectChainStore.getState().addGraphEffectNodeForTrack('7', {}),
    ).resolves.toMatchObject({ ok: false, reason: 'missing_graph_state' })

    expect(timeline.setTrackGraphState).not.toHaveBeenCalled()
    expect(audio.syncLinearGraphTopology).not.toHaveBeenCalled()
  })

  it('adds a macro node to a graph-owned track and persists without touching chains or engine APIs', async () => {
    const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
    let idCounter = 0
    const idFactory = () => `macro-gen-${idCounter++}`
    const baseChain = seedGraphMode(useEffectChainStore, makePositionedGraphState('7'))

    const result = await useEffectChainStore.getState().addGraphMacroNodeForTrack('7', {
      label: '  Macro Drive  ',
      normalizedValue: 0.4,
    }, { idFactory })

    expect(result.ok).toBe(true)
    const state = useEffectChainStore.getState()
    const next = state.graphStates['7']
    const macro = next.nodes.find((node) => node.id === 'macro-gen-0')
    expect(macro).toMatchObject({
      type: 'macro',
      data: { label: 'Macro Drive', normalizedValue: 0.4 },
    })
    expect(Number.isFinite(macro.position.x) && Number.isFinite(macro.position.y)).toBe(true)
    expect(state.chains['7']).toBe(baseChain)
    expect(timeline.setTrackGraphState).toHaveBeenCalledWith(7, next)
    expect(audio.syncLinearGraphTopology).not.toHaveBeenCalled()
    expect(audio.addGraphEffectNode).not.toHaveBeenCalled()
    expect(audio.setGraphEffectParameterNormalized).not.toHaveBeenCalled()
    expect(state.graphHistories['7'].undoStack[0]).toMatchObject({ label: 'add_graph_macro_node' })
  })

  it('blocks adding a macro node while Mixer Chain owns the track', async () => {
    const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
    const graphState = makePositionedGraphState('7')
    useEffectChainStore.setState({
      fxModes: { '7': 'chain' },
      graphStates: { '7': graphState },
      graphStateStatuses: { '7': { status: 'valid', graphState, warnings: [] } },
    })

    await expect(
      useEffectChainStore.getState().addGraphMacroNodeForTrack('7', {}),
    ).resolves.toMatchObject({ ok: false, reason: 'not_graph_mode' })

    expect(useEffectChainStore.getState().graphStates['7']).toBe(graphState)
    expect(timeline.setTrackGraphState).not.toHaveBeenCalled()
    expect(audio.syncLinearGraphTopology).not.toHaveBeenCalled()
  })

  it('updates and renames macro nodes with undo/redo without runtime sync', async () => {
    const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
    const graphState = makePositionedGraphState('7', {
      nodes: [
        ...makePositionedGraphState('7').nodes,
        { id: 'macro-a', type: 'macro', position: { x: 80, y: 228 }, data: { label: 'Macro 1', normalizedValue: 0.1 } },
      ],
    })
    const baseChain = seedGraphMode(useEffectChainStore, graphState)

    const valueResult = await useEffectChainStore.getState().updateGraphMacroValueForTrack('7', 'macro-a', 1.5)
    const renameResult = await useEffectChainStore.getState().renameGraphMacroNodeForTrack('7', 'macro-a', '  Energy  ')
    let state = useEffectChainStore.getState()
    let macro = state.graphStates['7'].nodes.find((node) => node.id === 'macro-a')
    expect(valueResult.ok).toBe(true)
    expect(renameResult.ok).toBe(true)
    expect(macro.data).toMatchObject({ label: 'Energy', normalizedValue: 1 })
    expect(state.graphHistories['7'].undoStack.map((entry) => entry.label)).toEqual([
      'update_graph_macro_value',
      'rename_graph_macro_node',
    ])
    expect(audio.syncLinearGraphTopology).not.toHaveBeenCalled()
    expect(audio.setGraphEffectParameterNormalized).not.toHaveBeenCalled()

    const undoRename = await useEffectChainStore.getState().undoGraphEditForTrack('7')
    expect(undoRename.ok).toBe(true)
    state = useEffectChainStore.getState()
    macro = state.graphStates['7'].nodes.find((node) => node.id === 'macro-a')
    expect(macro.data).toMatchObject({ label: 'Macro 1', normalizedValue: 1 })

    const undoValue = await useEffectChainStore.getState().undoGraphEditForTrack('7')
    expect(undoValue.ok).toBe(true)
    state = useEffectChainStore.getState()
    macro = state.graphStates['7'].nodes.find((node) => node.id === 'macro-a')
    expect(macro.data).toMatchObject({ label: 'Macro 1', normalizedValue: 0.1 })

    const redoValue = await useEffectChainStore.getState().redoGraphEditForTrack('7')
    expect(redoValue.ok).toBe(true)
    expect(useEffectChainStore.getState().graphHistories['7'].redoStack).toHaveLength(1)

    await useEffectChainStore.getState().renameGraphMacroNodeForTrack('7', 'macro-a', 'Fresh')
    state = useEffectChainStore.getState()
    expect(state.graphHistories['7'].redoStack).toHaveLength(0)
    expect(state.chains['7']).toBe(baseChain)
    expect(audio.syncLinearGraphTopology).not.toHaveBeenCalled()
  })

  it('links a Macro controlOut to an exposed parameter port, persists, and drives immediately', async () => {
    const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
    const baseChain = seedGraphMode(useEffectChainStore, makeMacroLinkGraphState('7'))

    const result = await useEffectChainStore.getState().connectMacroToParameterForTrack('7', {
      sourceNodeId: 'macro-a',
      targetNodeId: 'fx-1',
      parameterId: 'mix',
    }, { idFactory: () => 'p-mix' })

    expect(result.ok).toBe(true)
    const state = useEffectChainStore.getState()
    const next = state.graphStates['7']
    const edge = next.edges.find((e) => e.id === 'p-mix')
    expect(edge).toMatchObject({
      sourceNodeId: 'macro-a',
      sourcePort: 'controlOut',
      targetNodeId: 'fx-1',
      targetPort: 'gpp:fx-1:mix',
      type: 'parameter',
    })
    expect(edge.targetParameter.kind).toBe('graph-parameter')
    expect(edge.mapping).toMatchObject({ enabled: true, sourceMin: 0, sourceMax: 1, targetMin: 0, targetMax: 1 })
    // Parameter edges never persist a raw engine node id.
    expect(JSON.stringify(next.edges)).not.toContain('engineNodeId')
    // Persisted, undoable, no audio sync, chains untouched.
    expect(timeline.setTrackGraphState).toHaveBeenCalledWith(7, next)
    expect(audio.syncLinearGraphTopology).not.toHaveBeenCalled()
    expect(state.chains['7']).toBe(baseChain)
    expect(state.graphHistories['7'].undoStack.at(-1)).toMatchObject({ label: 'connect_macro_to_parameter' })
    // Drove the parameter from the macro's current value (0.5 → 0.5 default mapping).
    expect(audio.setGraphEffectParameterNormalized).toHaveBeenCalledWith(7, 'effect-1', 'mix', 0.5)
  })

  it('rejects invalid Macro -> Parameter links without corrupting graphState', async () => {
    const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
    const graphState = makeMacroLinkGraphState('7', { readOnly: true })
    const baseChain = seedGraphMode(useEffectChainStore, graphState)

    const readOnly = await useEffectChainStore.getState().connectMacroToParameterForTrack('7', {
      sourceNodeId: 'macro-a',
      targetNodeId: 'fx-1',
      parameterId: 'mix',
    })
    expect(readOnly).toMatchObject({ ok: false, reason: 'parameter_read_only' })

    const notExposed = await useEffectChainStore.getState().connectMacroToParameterForTrack('7', {
      sourceNodeId: 'macro-a',
      targetNodeId: 'fx-1',
      parameterId: 'gain',
    })
    expect(notExposed).toMatchObject({ ok: false, reason: 'parameter_not_exposed' })

    const state = useEffectChainStore.getState()
    expect(state.graphStates['7']).toBe(graphState)
    expect(state.graphStates['7'].edges.every((e) => e.type === 'audio')).toBe(true)
    expect(audio.setGraphEffectParameterNormalized).not.toHaveBeenCalled()
    expect(timeline.setTrackGraphState).not.toHaveBeenCalled()
    expect(state.chains['7']).toBe(baseChain)
  })

  it('drives connected parameters when the Macro value changes through FXG.4-a APIs', async () => {
    const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
    const baseChain = seedGraphMode(useEffectChainStore, makeLinkedMacroGraphState('7'))

    const result = await useEffectChainStore.getState().updateGraphMacroValueForTrack('7', 'macro-a', 0.8)

    expect(result.ok).toBe(true)
    expect(audio.setGraphEffectParameterNormalized).toHaveBeenCalledWith(7, 'effect-1', 'mix', 0.8)
    // Control-rate drive only: no audio topology sync, chains untouched.
    expect(audio.syncLinearGraphTopology).not.toHaveBeenCalled()
    expect(useEffectChainStore.getState().chains['7']).toBe(baseChain)
    expect(useEffectChainStore.getState().graphStates['7'].nodes.find((n) => n.id === 'macro-a').data.normalizedValue).toBe(0.8)
  })

  it('drives an inverted mapping', async () => {
    const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
    seedGraphMode(useEffectChainStore, makeLinkedMacroGraphState('7', { targetMin: 1, targetMax: 0 }))

    await useEffectChainStore.getState().updateGraphMacroValueForTrack('7', 'macro-a', 0.25)

    const calls = audio.setGraphEffectParameterNormalized.mock.calls.filter((c) => c[2] === 'mix')
    expect(calls.at(-1)[0]).toBe(7)
    expect(calls.at(-1)[1]).toBe('effect-1')
    expect(calls.at(-1)[3]).toBeCloseTo(0.75)
  })

  it('drives multiple outgoing parameter edges to multiple targets', async () => {
    const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
    const twoFx = graphWithTwoEffects('7')
    const withPorts = {
      ...twoFx,
      nodes: [
        twoFx.nodes[0],
        { ...twoFx.nodes[1], data: { ...twoFx.nodes[1].data, exposedParameterPorts: [
          { parameterId: 'gain', parameterIndexFallback: 0, nameSnapshot: 'Gain', labelSnapshot: null, parameterIdIsFallback: false, automatable: true, readOnly: false },
        ] } },
        { ...twoFx.nodes[2], data: { ...twoFx.nodes[2].data, exposedParameterPorts: [
          { parameterId: 'mix', parameterIndexFallback: 1, nameSnapshot: 'Mix', labelSnapshot: null, parameterIdIsFallback: false, automatable: true, readOnly: false },
        ] } },
        twoFx.nodes[3],
        { id: 'macro-a', type: 'macro', position: { x: 80, y: 240 }, data: { label: 'Macro 1', normalizedValue: 0 } },
      ],
      edges: [
        ...twoFx.edges,
        { id: 'edge-in-1', sourceNodeId: 'input', sourcePort: 'audio', targetNodeId: 'fx-1', targetPort: 'audioIn', type: 'audio' },
        { id: 'edge-2-out', sourceNodeId: 'fx-2', sourcePort: 'audioOut', targetNodeId: 'output', targetPort: 'audio', type: 'audio' },
      ],
    }
    const linkA = connectMacroToParameter(withPorts, {
      sourceNodeId: 'macro-a', targetNodeId: 'fx-1', parameterId: 'gain',
    }, { idFactory: () => 'p-gain' })
    const linkB = connectMacroToParameter(linkA.graphState, {
      sourceNodeId: 'macro-a', targetNodeId: 'fx-2', parameterId: 'mix', mapping: { targetMin: 0.25, targetMax: 0 },
    }, { idFactory: () => 'p-mix' })
    seedGraphMode(useEffectChainStore, linkB.graphState)

    await useEffectChainStore.getState().updateGraphMacroValueForTrack('7', 'macro-a', 1)

    const calls = audio.setGraphEffectParameterNormalized.mock.calls
    expect(calls).toContainEqual([7, 'effect-1', 'gain', 1])
    const mixCall = calls.find((c) => c[1] === 'effect-2' && c[2] === 'mix')
    expect(mixCall[3]).toBeCloseTo(0)
  })

  it('does not write disabled mappings and a failed write does not corrupt graphState', async () => {
    const { default: useEffectChainStore } = await loadEffectChainStoreFixture()

    // Disabled mapping: no write at all.
    seedGraphMode(useEffectChainStore, makeLinkedMacroGraphState('7', { enabled: false }))
    await useEffectChainStore.getState().updateGraphMacroValueForTrack('7', 'macro-a', 0.6)
    expect(audio.setGraphEffectParameterNormalized).not.toHaveBeenCalled()

    // Failing engine write: macro value still commits, graphState intact.
    audio.setGraphEffectParameterNormalized.mockImplementationOnce(async () =>
      JSON.stringify({ ok: false, reason: 'processor_unavailable' }))
    seedGraphMode(useEffectChainStore, makeLinkedMacroGraphState('7'))
    const result = await useEffectChainStore.getState().updateGraphMacroValueForTrack('7', 'macro-a', 0.9)
    expect(result.ok).toBe(true)
    const macro = useEffectChainStore.getState().graphStates['7'].nodes.find((n) => n.id === 'macro-a')
    expect(macro.data.normalizedValue).toBe(0.9)
  })

  // ── EVC-R2 Envelope runtime parameter drive ───────────────────────────────
  const heldNote = (trackKey = '7') => ({ [trackKey]: [{ kind: 'note', startTick: 0, endTick: 10000 }] })

  it('drives setGraphEffectParameterNormalized for a connected Envelope parameter edge', async () => {
    const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
    seedGraphMode(useEffectChainStore, makeLinkedEnvelopeGraphState('7'))

    const result = await useEffectChainStore.getState().applyEnvelopeModulationAtTick(500, {
      trackEvents: heldNote('7'),
      msPerTick: 1,
    })

    expect(result.ok).toBe(true)
    // attack/decay/release 0, sustain 1, amount 1 -> held note resolves to 1 -> default mapping 1.
    expect(audio.setGraphEffectParameterNormalized).toHaveBeenCalledWith(7, 'effect-1', 'mix', 1)
  })

  it('does not mutate graphState, effectChains, or sync audio topology during drive', async () => {
    const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
    const graphState = makeLinkedEnvelopeGraphState('7')
    const baseChain = seedGraphMode(useEffectChainStore, graphState)

    await useEffectChainStore.getState().applyEnvelopeModulationAtTick(500, {
      trackEvents: heldNote('7'),
      msPerTick: 1,
    })

    const state = useEffectChainStore.getState()
    expect(state.graphStates['7']).toBe(graphState)
    expect(state.chains['7']).toBe(baseChain)
    expect(audio.syncLinearGraphTopology).not.toHaveBeenCalled()
  })

  it('skips a disabled Envelope mapping', async () => {
    const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
    seedGraphMode(useEffectChainStore, makeLinkedEnvelopeGraphState('7', { enabled: false }))

    await useEffectChainStore.getState().applyEnvelopeModulationAtTick(500, {
      trackEvents: heldNote('7'),
      msPerTick: 1,
    })

    expect(audio.setGraphEffectParameterNormalized).not.toHaveBeenCalled()
  })

  it('skips an unresolved Envelope target safely (no throw, no write)', async () => {
    const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
    const linked = makeLinkedEnvelopeGraphState('7')
    // Drop the exposed port so the persisted target no longer resolves.
    const broken = {
      ...linked,
      nodes: linked.nodes.map((n) =>
        n.id === 'fx-1' ? { ...n, data: { ...n.data, exposedParameterPorts: [] } } : n),
    }
    seedGraphMode(useEffectChainStore, broken)

    const result = await useEffectChainStore.getState().applyEnvelopeModulationAtTick(500, {
      trackEvents: heldNote('7'),
      msPerTick: 1,
    })

    expect(result.ok).toBe(true)
    expect(audio.setGraphEffectParameterNormalized).not.toHaveBeenCalled()
  })

  it('one failed Envelope write does not abort the others', async () => {
    const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
    // Two effects each exposing a writable port, both driven by one envelope.
    const twoFx = graphWithTwoEffects('7')
    const withEnv = {
      ...twoFx,
      nodes: [
        twoFx.nodes[0],
        { ...twoFx.nodes[1], data: { ...twoFx.nodes[1].data, exposedParameterPorts: [
          { parameterId: 'gain', parameterIndexFallback: 0, nameSnapshot: 'Gain', labelSnapshot: null, parameterIdIsFallback: false, automatable: true, readOnly: false },
        ] } },
        { ...twoFx.nodes[2], data: { ...twoFx.nodes[2].data, exposedParameterPorts: [
          { parameterId: 'mix', parameterIndexFallback: 1, nameSnapshot: 'Mix', labelSnapshot: null, parameterIdIsFallback: false, automatable: true, readOnly: false },
        ] } },
        twoFx.nodes[3],
        {
          id: 'env-a', type: 'envelope', position: { x: 80, y: 240 },
          data: { label: 'Envelope', attackMs: 0, holdMs: 0, decayMs: 0, sustain: 1, releaseMs: 0, amount: 1, includeSlideNotes: false },
        },
      ],
      edges: [
        ...twoFx.edges,
        { id: 'edge-in-1', sourceNodeId: 'input', sourcePort: 'audio', targetNodeId: 'fx-1', targetPort: 'audioIn', type: 'audio' },
        { id: 'edge-2-out', sourceNodeId: 'fx-2', sourcePort: 'audioOut', targetNodeId: 'output', targetPort: 'audio', type: 'audio' },
      ],
    }
    const linkA = connectEnvelopeToParameter(withEnv, { sourceNodeId: 'env-a', targetNodeId: 'fx-1', parameterId: 'gain' }, { idFactory: () => 'pe-gain' })
    const linkB = connectEnvelopeToParameter(linkA.graphState, { sourceNodeId: 'env-a', targetNodeId: 'fx-2', parameterId: 'mix' }, { idFactory: () => 'pe-mix' })
    seedGraphMode(useEffectChainStore, linkB.graphState)

    audio.setGraphEffectParameterNormalized.mockImplementationOnce(async () => { throw new Error('engine boom') })

    const result = await useEffectChainStore.getState().applyEnvelopeModulationAtTick(500, {
      trackEvents: heldNote('7'),
      msPerTick: 1,
      warn: () => {},
    })

    expect(result.ok).toBe(true)
    const calls = audio.setGraphEffectParameterNormalized.mock.calls
    // Both targets were attempted despite the first throwing.
    expect(calls.some((c) => c[1] === 'effect-1' && c[2] === 'gain')).toBe(true)
    expect(calls.some((c) => c[1] === 'effect-2' && c[2] === 'mix')).toBe(true)
  })

  it('does not drive a chain-mode track', async () => {
    const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
    const graphState = makeLinkedEnvelopeGraphState('7')
    useEffectChainStore.setState({
      fxModes: { '7': 'chain' },
      graphStates: { '7': graphState },
      graphHistories: {},
    })

    await useEffectChainStore.getState().applyEnvelopeModulationAtTick(500, {
      trackEvents: heldNote('7'),
      msPerTick: 1,
    })

    expect(audio.setGraphEffectParameterNormalized).not.toHaveBeenCalled()
  })

  it('suppresses redundant Envelope writes at a steady value', async () => {
    const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
    seedGraphMode(useEffectChainStore, makeLinkedEnvelopeGraphState('7'))

    await useEffectChainStore.getState().applyEnvelopeModulationAtTick(500, { trackEvents: heldNote('7'), msPerTick: 1 })
    await useEffectChainStore.getState().applyEnvelopeModulationAtTick(600, { trackEvents: heldNote('7'), msPerTick: 1 })

    // Same sustain value at both ticks -> only one engine write.
    const mixCalls = audio.setGraphEffectParameterNormalized.mock.calls.filter((c) => c[2] === 'mix')
    expect(mixCalls).toHaveLength(1)
  })

  it('resets the runtime cache so a stop flush can drive parameters to 0', async () => {
    const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
    seedGraphMode(useEffectChainStore, makeLinkedEnvelopeGraphState('7'))

    // Held note drives the parameter to 1.
    await useEffectChainStore.getState().applyEnvelopeModulationAtTick(500, { trackEvents: heldNote('7'), msPerTick: 1 })
    expect(audio.setGraphEffectParameterNormalized).toHaveBeenLastCalledWith(7, 'effect-1', 'mix', 1)

    // Reset + a no-gate flush pass (what the playback controller does on stop) -> writes 0.
    // EVC-R2-r1: the runtime cache is now a non-reactive module-level holder, so reset behavior
    // is asserted through the resulting engine write (0) rather than store state.
    useEffectChainStore.getState().resetEnvelopeModulationRuntime()
    await useEffectChainStore.getState().applyEnvelopeModulationAtTick(500, { trackEvents: {}, msPerTick: 1 })
    expect(audio.setGraphEffectParameterNormalized).toHaveBeenLastCalledWith(7, 'effect-1', 'mix', 0)
  })

  it('removing a parameter edge is one undo step and does not sync audio topology', async () => {
    const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
    seedGraphMode(useEffectChainStore, makeLinkedMacroGraphState('7'))

    const result = await useEffectChainStore.getState().disconnectGraphEdgeForTrack('7', 'p-mix')
    expect(result.ok).toBe(true)
    const state = useEffectChainStore.getState()
    expect(state.graphStates['7'].edges.some((e) => e.id === 'p-mix')).toBe(false)
    expect(state.graphHistories['7'].undoStack.at(-1)).toMatchObject({ label: 'disconnect_graph_edge' })
    expect(audio.syncLinearGraphTopology).not.toHaveBeenCalled()
  })

  it('does not write any engine parameters for audio-only graph edits', async () => {
    const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
    seedGraphMode(useEffectChainStore, graphWithoutEdges('7'))

    await useEffectChainStore.getState().connectGraphNodesForTrack('7', {
      sourceNodeId: 'input',
      targetNodeId: 'fx-1',
    })

    expect(audio.setGraphEffectParameterNormalized).not.toHaveBeenCalled()
  })

  it('removes a macro node without graph effect engine removal or runtime sync', async () => {
    const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
    const graphState = makePositionedGraphState('7', {
      nodes: [
        ...makePositionedGraphState('7').nodes,
        { id: 'macro-a', type: 'macro', position: { x: 80, y: 228 }, data: { label: 'Macro 1', normalizedValue: 0.1 } },
      ],
      edges: [
        ...makePositionedGraphState('7').edges,
        {
          id: 'macro-param',
          sourceNodeId: 'macro-a',
          sourcePort: 'controlOut',
          targetNodeId: 'fx-1',
          targetPort: 'param:mix',
          type: 'parameter',
        },
      ],
    })
    const baseChain = seedGraphMode(useEffectChainStore, graphState)

    const result = await useEffectChainStore.getState().removeGraphNodeForTrack('7', 'macro-a')

    expect(result.ok).toBe(true)
    const state = useEffectChainStore.getState()
    expect(state.graphStates['7'].nodes.find((node) => node.id === 'macro-a')).toBeUndefined()
    expect(state.graphStates['7'].edges.find((edge) => edge.id === 'macro-param')).toBeUndefined()
    expect(state.chains['7']).toBe(baseChain)
    expect(audio.removeGraphEffectNode).not.toHaveBeenCalled()
    expect(audio.syncLinearGraphTopology).not.toHaveBeenCalled()
  })

  it('removes an effect node and its incident edges without touching chains', async () => {
    const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
    const baseChain = seedGraphMode(useEffectChainStore, makePositionedGraphState('7'))

    const result = await useEffectChainStore.getState().removeGraphNodeForTrack('7', 'fx-1')

    expect(result.ok).toBe(true)
    const next = useEffectChainStore.getState().graphStates['7']
    expect(next.nodes.map((node) => node.id)).toEqual(['input', 'output'])
    expect(next.edges).toEqual([])
    expect(next.viewport).toEqual({ x: 0, y: 0, zoom: 1 })
    expect(useEffectChainStore.getState().chains['7']).toBe(baseChain)
    expect(timeline.setTrackGraphState).toHaveBeenCalledWith(7, next)
    expect(audio.syncLinearGraphTopology).toHaveBeenCalledWith(7, expect.objectContaining({
      phase: 'FXG.3-c-b',
      nodes: expect.arrayContaining([
        expect.objectContaining({ nodeId: 'input', type: 'trackInput' }),
        expect.objectContaining({ nodeId: 'output', type: 'trackOutput' }),
      ]),
      edges: [],
    }))
    expect(result.runtimeSync).toMatchObject({ ok: true, reason: 'graph_routing_active' })
  })

  it('blocks removing protected trackInput and trackOutput nodes', async () => {
    const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
    const graphState = makePositionedGraphState('7')
    seedGraphMode(useEffectChainStore, graphState)

    await expect(
      useEffectChainStore.getState().removeGraphNodeForTrack('7', 'input'),
    ).resolves.toMatchObject({ ok: false, reason: 'protected_node' })
    await expect(
      useEffectChainStore.getState().removeGraphNodeForTrack('7', 'output'),
    ).resolves.toMatchObject({ ok: false, reason: 'protected_node' })

    expect(useEffectChainStore.getState().graphStates['7']).toBe(graphState)
    expect(timeline.setTrackGraphState).not.toHaveBeenCalled()
    expect(audio.syncLinearGraphTopology).not.toHaveBeenCalled()
  })

  it('connects two nodes with a new audio edge and persists', async () => {
    const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
    let idCounter = 0
    const idFactory = () => `edge-gen-${idCounter++}`
    const baseChain = seedGraphMode(useEffectChainStore, graphWithoutEdges('7'))

    const result = await useEffectChainStore.getState().connectGraphNodesForTrack('7', {
      sourceNodeId: 'input',
      targetNodeId: 'fx-1',
    }, { idFactory })

    expect(result.ok).toBe(true)
    const next = useEffectChainStore.getState().graphStates['7']
    expect(next.edges).toHaveLength(1)
    expect(next.edges[0]).toMatchObject({
      sourceNodeId: 'input',
      sourcePort: 'audio',
      targetNodeId: 'fx-1',
      targetPort: 'audioIn',
      type: 'audio',
    })
    expect(useEffectChainStore.getState().chains['7']).toBe(baseChain)
    expect(timeline.setTrackGraphState).toHaveBeenCalledWith(7, next)
    expect(audio.syncLinearGraphTopology).toHaveBeenCalledWith(7, expect.objectContaining({
      phase: 'FXG.3-c-b',
      edges: expect.arrayContaining([
        expect.objectContaining({
          sourceNodeId: 'input',
          targetNodeId: 'fx-1',
          type: 'audio',
        }),
      ]),
    }))
    expect(result.runtimeSync).toMatchObject({ ok: true, reason: 'graph_routing_active' })
  })

  it('rejects self, duplicate, cycle, and invalid-endpoint connections', async () => {
    const { default: useEffectChainStore } = await loadEffectChainStoreFixture()

    seedGraphMode(useEffectChainStore, makePositionedGraphState('7'))
    // makePositionedGraphState already has input -> fx-1 -> output.
    await expect(
      useEffectChainStore.getState().connectGraphNodesForTrack('7', { sourceNodeId: 'fx-1', targetNodeId: 'fx-1' }),
    ).resolves.toMatchObject({ ok: false, reason: 'self_connection' })
    await expect(
      useEffectChainStore.getState().connectGraphNodesForTrack('7', { sourceNodeId: 'input', targetNodeId: 'fx-1' }),
    ).resolves.toMatchObject({ ok: false, reason: 'duplicate_edge' })
    await expect(
      useEffectChainStore.getState().connectGraphNodesForTrack('7', { sourceNodeId: 'output', targetNodeId: 'fx-1' }),
    ).resolves.toMatchObject({ ok: false, reason: 'invalid_source_type' })
    await expect(
      useEffectChainStore.getState().connectGraphNodesForTrack('7', { sourceNodeId: 'fx-1', targetNodeId: 'input' }),
    ).resolves.toMatchObject({ ok: false, reason: 'invalid_target_type' })

    seedGraphMode(useEffectChainStore, graphWithTwoEffects('7'))
    await expect(
      useEffectChainStore.getState().connectGraphNodesForTrack('7', { sourceNodeId: 'fx-2', targetNodeId: 'fx-1' }),
    ).resolves.toMatchObject({ ok: false, reason: 'cycle_detected' })

    expect(timeline.setTrackGraphState).not.toHaveBeenCalled()
    expect(audio.syncLinearGraphTopology).not.toHaveBeenCalled()
  })

  it('disconnects an existing edge and rejects a missing edge', async () => {
    const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
    const baseChain = seedGraphMode(useEffectChainStore, makePositionedGraphState('7'))

    const result = await useEffectChainStore.getState().disconnectGraphEdgeForTrack('7', 'edge-1')
    expect(result.ok).toBe(true)
    const next = useEffectChainStore.getState().graphStates['7']
    expect(next.edges.map((edge) => edge.id)).toEqual(['edge-2'])
    expect(useEffectChainStore.getState().chains['7']).toBe(baseChain)
    expect(timeline.setTrackGraphState).toHaveBeenCalledWith(7, next)
    expect(audio.syncLinearGraphTopology).toHaveBeenCalledTimes(1)
    expect(audio.syncLinearGraphTopology).toHaveBeenCalledWith(7, expect.objectContaining({
      phase: 'FXG.3-c-b',
      edges: expect.arrayContaining([
        expect.objectContaining({ edgeId: 'edge-2', sourceNodeId: 'fx-1', targetNodeId: 'output' }),
      ]),
    }))
    expect(result.runtimeSync).toMatchObject({ ok: true, reason: 'graph_routing_active' })

    timeline.setTrackGraphState.mockClear()
    audio.syncLinearGraphTopology.mockClear()
    await expect(
      useEffectChainStore.getState().disconnectGraphEdgeForTrack('7', 'does-not-exist'),
    ).resolves.toMatchObject({ ok: false, reason: 'missing_edge' })
    expect(timeline.setTrackGraphState).not.toHaveBeenCalled()
    expect(audio.syncLinearGraphTopology).not.toHaveBeenCalled()
  })

  it('keeps dormant graphState untouched for chain-mode disconnect attempts', async () => {
    const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
    const graphState = makePositionedGraphState('7')
    useEffectChainStore.setState({
      fxModes: { '7': 'chain' },
      graphStates: { '7': graphState },
      graphStateStatuses: { '7': { status: 'valid', graphState, warnings: [] } },
    })

    await expect(
      useEffectChainStore.getState().disconnectGraphEdgeForTrack('7', 'edge-1'),
    ).resolves.toMatchObject({ ok: false, reason: 'not_graph_mode' })
    await expect(
      useEffectChainStore.getState().connectGraphNodesForTrack('7', { sourceNodeId: 'input', targetNodeId: 'output' }),
    ).resolves.toMatchObject({ ok: false, reason: 'not_graph_mode' })

    expect(useEffectChainStore.getState().graphStates['7']).toBe(graphState)
    expect(timeline.setTrackGraphState).not.toHaveBeenCalled()
    expect(audio.syncLinearGraphTopology).not.toHaveBeenCalled()
  })

  it('surfaces invalid_graph_state when validation rejects a mutation result', async () => {
    const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
    const graphState = makePositionedGraphState('7')
    const before = seedGraphMode(useEffectChainStore, graphState)
    const warn = vi.fn()

    const result = await useEffectChainStore.getState().addGraphEffectNodeForTrack('7', {}, {
      validateGraphState: () => ({ status: 'invalid', graphState: null, reason: 'forced', warnings: [] }),
      warn,
    })

    expect(result).toMatchObject({ ok: false, reason: 'invalid_graph_state' })
    // Renderer state is not committed on validation failure.
    expect(useEffectChainStore.getState().graphStates['7']).toBe(graphState)
    expect(useEffectChainStore.getState().chains['7']).toBe(before)
    expect(timeline.setTrackGraphState).not.toHaveBeenCalled()
    expect(audio.syncLinearGraphTopology).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[FXG]'), expect.objectContaining({ trackId: '7' }))
  })

  it('toggles exposed graph parameter ports as graphState edits without touching chains or runtime routing', async () => {
    const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
    const baseChain = seedGraphMode(useEffectChainStore, makePositionedGraphState('7'))

    const expose = await useEffectChainStore.getState().toggleGraphNodeParameterPortForTrack('7', 'fx-1', {
      parameterId: 'feedback',
      parameterIndex: 3,
      name: 'Feedback',
      unit: '%',
      automatable: true,
      readOnly: false,
      normalizedValue: 0.7,
    })

    expect(expose.ok).toBe(true)
    expect(expose.exposed).toBe(true)
    let state = useEffectChainStore.getState()
    const exposedPorts = state.graphStates['7'].nodes.find((node) => node.id === 'fx-1').data.exposedParameterPorts
    expect(exposedPorts).toEqual([
      {
        parameterId: 'feedback',
        parameterIndexFallback: 3,
        nameSnapshot: 'Feedback',
        labelSnapshot: '%',
        parameterIdIsFallback: false,
        automatable: true,
        readOnly: false,
      },
    ])
    expect(state.chains['7']).toBe(baseChain)
    expect(timeline.setTrackGraphState).toHaveBeenCalledWith(7, state.graphStates['7'])
    expect(audio.syncLinearGraphTopology).not.toHaveBeenCalled()
    expect(audio.addEffect).not.toHaveBeenCalled()
    expect(state.graphHistories['7'].undoStack).toHaveLength(1)
    expect(state.graphHistories['7'].undoStack[0]).toMatchObject({ label: 'expose_parameter_port' })

    timeline.setTrackGraphState.mockClear()
    const unexpose = await useEffectChainStore.getState().toggleGraphNodeParameterPortForTrack('7', 'fx-1', {
      parameterId: 'feedback',
      parameterIndex: 3,
      name: 'Feedback',
    })
    state = useEffectChainStore.getState()
    expect(unexpose.ok).toBe(true)
    expect(unexpose.exposed).toBe(false)
    expect(state.graphStates['7'].nodes.find((node) => node.id === 'fx-1').data.exposedParameterPorts)
      .toEqual([])
    expect(timeline.setTrackGraphState).toHaveBeenCalledWith(7, state.graphStates['7'])
    expect(audio.syncLinearGraphTopology).not.toHaveBeenCalled()
    expect(state.chains['7']).toBe(baseChain)
  })

  it('undoes and redoes exposed parameter ports without runtime sync', async () => {
    const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
    const baseChain = seedGraphMode(useEffectChainStore, makePositionedGraphState('7'))

    await useEffectChainStore.getState().toggleGraphNodeParameterPortForTrack('7', 'fx-1', {
      parameterId: 'mix',
      parameterIndex: 1,
      name: 'Mix',
      automatable: true,
      readOnly: false,
    })
    audio.syncLinearGraphTopology.mockClear()

    const undo = await useEffectChainStore.getState().undoGraphEditForTrack('7')
    expect(undo.ok).toBe(true)
    let state = useEffectChainStore.getState()
    expect(state.graphStates['7'].nodes.find((node) => node.id === 'fx-1').data.exposedParameterPorts)
      .toEqual([])
    expect(state.graphHistories['7'].redoStack).toHaveLength(1)
    expect(audio.syncLinearGraphTopology).not.toHaveBeenCalled()

    const redo = await useEffectChainStore.getState().redoGraphEditForTrack('7')
    expect(redo.ok).toBe(true)
    state = useEffectChainStore.getState()
    expect(state.graphStates['7'].nodes.find((node) => node.id === 'fx-1').data.exposedParameterPorts[0])
      .toMatchObject({ parameterId: 'mix', nameSnapshot: 'Mix' })
    expect(state.graphHistories['7'].redoStack).toHaveLength(0)
    expect(audio.syncLinearGraphTopology).not.toHaveBeenCalled()
    expect(state.chains['7']).toBe(baseChain)
  })

  it('rejects exposed parameter port edits outside graph ownership', async () => {
    const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
    const graphState = makePositionedGraphState('7')
    useEffectChainStore.setState({
      fxModes: { '7': 'chain' },
      graphStates: { '7': graphState },
      graphStateStatuses: { '7': { status: 'valid', graphState, warnings: [] } },
    })

    await expect(
      useEffectChainStore.getState().toggleGraphNodeParameterPortForTrack('7', 'fx-1', {
        parameterId: 'mix',
        parameterIndex: 1,
      }),
    ).resolves.toMatchObject({ ok: false, reason: 'not_graph_mode' })

    expect(useEffectChainStore.getState().graphStates['7']).toBe(graphState)
    expect(timeline.setTrackGraphState).not.toHaveBeenCalled()
    expect(audio.syncLinearGraphTopology).not.toHaveBeenCalled()
  })

  // --- FXG.3-b graph-owned engine instance lifecycle ---

  it('instantiates a graph-owned engine processor for a real pluginId and records the session nodeId', async () => {
    const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
    audio.addGraphEffectNode.mockResolvedValueOnce(321)
    seedGraphMode(useEffectChainStore, graphWithoutEdges('7'))

    const result = await useEffectChainStore.getState().addGraphEffectNodeForTrack('7', {
      effectInstanceId: 'inst-real',
      pluginId: 'reverb',
      displayName: 'Reverb',
    })

    expect(result.ok).toBe(true)
    expect(result).toMatchObject({ effectInstanceId: 'inst-real', engineNodeId: 321 })
    expect(audio.addGraphEffectNode).toHaveBeenCalledWith(7, 'inst-real', 'reverb')
    // Session-only engineNodeId cache is updated; chains untouched.
    expect(useEffectChainStore.getState().graphEngineNodeIds['7']['inst-real']).toBe(321)
    expect(audio.addEffect).not.toHaveBeenCalled()
    expect(timeline.setTrackGraphState).toHaveBeenCalled()
  })

  // FXG.3-e — the FX Graph picker calls addGraphEffectNodeForTrack with just a
  // { pluginId, displayName } selection (no caller-supplied effectInstanceId).
  it('creates a graph-owned stock node from a picker selection and never touches chains', async () => {
    const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
    audio.addGraphEffectNode.mockResolvedValueOnce(777)
    let idCounter = 0
    const idFactory = () => `picked-${idCounter++}`
    const baseChain = seedGraphMode(useEffectChainStore, graphWithoutEdges('7'))

    const result = await useEffectChainStore.getState().addGraphEffectNodeForTrack(
      '7',
      { pluginId: 'reverb', displayName: 'Reverb' },
      { idFactory },
    )

    expect(result.ok).toBe(true)
    // The store generated a stable effectInstanceId for the picked effect.
    const effectInstanceId = result.effectInstanceId
    expect(typeof effectInstanceId).toBe('string')
    expect(effectInstanceId.length).toBeGreaterThan(0)
    expect(result.engineNodeId).toBe(777)

    const node = useEffectChainStore.getState().graphStates['7'].nodes
      .find((candidate) => candidate.data?.effectInstanceId === effectInstanceId)
    expect(node).toBeDefined()
    expect(node.data).toMatchObject({ pluginId: 'reverb', displayName: 'Reverb', missing: false })

    // Graph-owned engine instantiation + session mapping; chains untouched.
    expect(audio.addGraphEffectNode).toHaveBeenCalledWith(7, effectInstanceId, 'reverb')
    expect(useEffectChainStore.getState().graphEngineNodeIds['7'][effectInstanceId]).toBe(777)
    expect(useEffectChainStore.getState().chains['7']).toBe(baseChain)
    expect(audio.addEffect).not.toHaveBeenCalled()
  })

  it('does not instantiate an engine processor for a placeholder/data-only node', async () => {
    const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
    seedGraphMode(useEffectChainStore, graphWithoutEdges('7'))

    const result = await useEffectChainStore.getState().addGraphEffectNodeForTrack('7', {})

    expect(result.ok).toBe(true)
    expect(result.engineNodeId).toBeNull()
    expect(audio.addGraphEffectNode).not.toHaveBeenCalled()
    expect(audio.addEffect).not.toHaveBeenCalled()
    expect(useEffectChainStore.getState().graphEngineNodeIds['7']).toBeUndefined()
  })

  it('fails fast without committing graphState when engine instantiation fails', async () => {
    const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
    audio.addGraphEffectNode.mockResolvedValueOnce(-1)
    const graphState = graphWithoutEdges('7')
    seedGraphMode(useEffectChainStore, graphState)

    const result = await useEffectChainStore.getState().addGraphEffectNodeForTrack('7', {
      effectInstanceId: 'inst-fail',
      pluginId: 'reverb',
      displayName: 'Reverb',
    })

    expect(result).toMatchObject({ ok: false, reason: 'engine_instantiation_failed' })
    expect(useEffectChainStore.getState().graphStates['7']).toBe(graphState)
    expect(timeline.setTrackGraphState).not.toHaveBeenCalled()
    expect(useEffectChainStore.getState().graphEngineNodeIds['7']).toBeUndefined()
  })

  it('rolls back the engine processor if graphState validation rejects the add', async () => {
    const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
    audio.addGraphEffectNode.mockResolvedValueOnce(900)
    seedGraphMode(useEffectChainStore, graphWithoutEdges('7'))

    const result = await useEffectChainStore.getState().addGraphEffectNodeForTrack('7', {
      effectInstanceId: 'inst-rollback',
      pluginId: 'reverb',
      displayName: 'Reverb',
    }, {
      validateGraphState: () => ({ status: 'invalid', graphState: null, reason: 'forced', warnings: [] }),
      warn: vi.fn(),
    })

    expect(result).toMatchObject({ ok: false, reason: 'invalid_graph_state' })
    expect(audio.addGraphEffectNode).toHaveBeenCalledWith(7, 'inst-rollback', 'reverb')
    expect(audio.removeGraphEffectNode).toHaveBeenCalledWith(7, 'inst-rollback')
    expect(useEffectChainStore.getState().graphEngineNodeIds['7']).toBeUndefined()
  })

  it('removes the graph-owned engine processor for an engine-backed node and clears the cache', async () => {
    const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
    seedGraphMode(useEffectChainStore, makePositionedGraphState('7'))
    useEffectChainStore.setState({ graphEngineNodeIds: { '7': { 'effect-1': 210 } } })

    const result = await useEffectChainStore.getState().removeGraphNodeForTrack('7', 'fx-1')

    expect(result.ok).toBe(true)
    expect(audio.removeGraphEffectNode).toHaveBeenCalledWith(7, 'effect-1')
    expect(useEffectChainStore.getState().graphEngineNodeIds['7']['effect-1']).toBeUndefined()
    expect(audio.removeEffect).not.toHaveBeenCalled()
    expect(timeline.setTrackGraphState).toHaveBeenCalled()
  })

  it('does not call engine removal for a node with no session engine processor', async () => {
    const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
    seedGraphMode(useEffectChainStore, makePositionedGraphState('7'))

    const result = await useEffectChainStore.getState().removeGraphNodeForTrack('7', 'fx-1')

    expect(result.ok).toBe(true)
    expect(audio.removeGraphEffectNode).not.toHaveBeenCalled()
    expect(audio.removeEffect).not.toHaveBeenCalled()
  })

  it('fails fast and keeps graphState intact when engine removal fails', async () => {
    const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
    audio.removeGraphEffectNode.mockResolvedValueOnce(false)
    const graphState = makePositionedGraphState('7')
    seedGraphMode(useEffectChainStore, graphState)
    useEffectChainStore.setState({ graphEngineNodeIds: { '7': { 'effect-1': 210 } } })

    const result = await useEffectChainStore.getState().removeGraphNodeForTrack('7', 'fx-1')

    expect(result).toMatchObject({ ok: false, reason: 'engine_removal_failed' })
    expect(useEffectChainStore.getState().graphStates['7']).toBe(graphState)
    expect(useEffectChainStore.getState().graphEngineNodeIds['7']['effect-1']).toBe(210)
    expect(timeline.setTrackGraphState).not.toHaveBeenCalled()
  })

  it('syncs linear routing after connect and disconnect without graph-owned lifecycle calls', async () => {
    const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
    seedGraphMode(useEffectChainStore, graphWithoutEdges('7'))

    const connectResult = await useEffectChainStore.getState().connectGraphNodesForTrack('7', {
      sourceNodeId: 'input',
      targetNodeId: 'fx-1',
    })
    expect(connectResult.ok).toBe(true)

    const edgeId = useEffectChainStore.getState().graphStates['7'].edges[0].id
    const disconnectResult = await useEffectChainStore.getState().disconnectGraphEdgeForTrack('7', edgeId)
    expect(disconnectResult.ok).toBe(true)

    // Edge edits rebuild supported FXG.3-c-b routing, but they do not create
    // or destroy graph-owned processors.
    expect(audio.syncLinearGraphTopology).toHaveBeenCalledTimes(2)
    expect(connectResult.runtimeSync).toMatchObject({ ok: true, reason: 'graph_routing_active' })
    expect(disconnectResult.runtimeSync).toMatchObject({ ok: true, reason: 'graph_routing_active' })
    expect(audio.addConnection).toBeUndefined()
    expect(audio.hydrateGraphEffectNodes).not.toHaveBeenCalled()
    expect(audio.addGraphEffectNode).not.toHaveBeenCalled()
    expect(audio.removeGraphEffectNode).not.toHaveBeenCalled()
  })

  it('surfaces a fail-closed sync status without rolling back graphState or mutating chains', async () => {
    const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
    const baseChain = seedGraphMode(useEffectChainStore, makePositionedGraphState('7'))
    // FXG.3-d: when the engine cannot resolve an active effect it fail-closes to
    // silence (never stale chain). The renderer must surface that status while
    // keeping the renderer-side edit and effectChains intact.
    audio.syncLinearGraphTopology.mockResolvedValueOnce({
      ok: false,
      phase: 'FXG.3-d',
      mode: 'none',
      reason: 'missing_effect_mapping',
      fallback: 'silence',
      fallbackApplied: true,
    })

    const result = await useEffectChainStore.getState().connectGraphNodesForTrack('7', {
      sourceNodeId: 'input',
      targetNodeId: 'output',
    }, { idFactory: () => 'parallel-edge' })

    expect(result.ok).toBe(true)
    expect(result.runtimeSync).toMatchObject({
      ok: false,
      reason: 'missing_effect_mapping',
      fallback: 'silence',
      fallbackApplied: true,
    })

    const state = useEffectChainStore.getState()
    expect(state.graphStates['7'].edges.map((edge) => edge.id)).toEqual([
      'edge-1',
      'edge-2',
      'parallel-edge',
    ])
    expect(state.graphRuntimeStatuses['7']).toMatchObject({
      ok: false,
      reason: 'missing_effect_mapping',
      fallbackApplied: true,
    })
    expect(state.chains['7']).toBe(baseChain)
  })

  // --- FXG.3-h graph-owned session history ---

  it('undoes and redoes a final graph node move without syncing runtime or touching chains', async () => {
    const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
    const baseChain = seedGraphMode(useEffectChainStore, makePositionedGraphState('7'))

    await expect(
      useEffectChainStore.getState().setGraphStateNodePosition(7, 'fx-1', { x: 333, y: 44 }),
    ).resolves.toBe(true)

    let state = useEffectChainStore.getState()
    expect(state.graphStates['7'].nodes.find((node) => node.id === 'fx-1')?.position)
      .toEqual({ x: 333, y: 44 })
    expect(state.graphHistories['7'].undoStack).toHaveLength(1)
    expect(state.graphHistories['7'].undoStack[0]).toMatchObject({ label: 'move_graph_node' })
    expect(useEffectChainStore.getState().canUndoGraphEdit(7)).toBe(true)

    timeline.setTrackGraphState.mockClear()
    audio.syncLinearGraphTopology.mockClear()
    const undo = await useEffectChainStore.getState().undoGraphEditForTrack(7)
    expect(undo.ok).toBe(true)
    state = useEffectChainStore.getState()
    expect(state.graphStates['7'].nodes.find((node) => node.id === 'fx-1')?.position)
      .toEqual({ x: 260, y: 0 })
    expect(state.graphHistories['7'].undoStack).toHaveLength(0)
    expect(state.graphHistories['7'].redoStack).toHaveLength(1)
    expect(audio.syncLinearGraphTopology).not.toHaveBeenCalled()
    expect(state.chains['7']).toBe(baseChain)

    const redo = await useEffectChainStore.getState().redoGraphEditForTrack(7)
    expect(redo.ok).toBe(true)
    state = useEffectChainStore.getState()
    expect(state.graphStates['7'].nodes.find((node) => node.id === 'fx-1')?.position)
      .toEqual({ x: 333, y: 44 })
    expect(state.graphHistories['7'].undoStack).toHaveLength(1)
    expect(state.graphHistories['7'].redoStack).toHaveLength(0)
    expect(audio.syncLinearGraphTopology).not.toHaveBeenCalled()
    expect(state.chains['7']).toBe(baseChain)
  })

  it('undoes and redoes graph add lifecycle while restoring effectInstance mappings', async () => {
    const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
    const baseChain = seedGraphMode(useEffectChainStore, graphWithoutEdges('7'))
    audio.addGraphEffectNode.mockResolvedValueOnce(321)

    const add = await useEffectChainStore.getState().addGraphEffectNodeForTrack('7', {
      effectInstanceId: 'inst-add',
      pluginId: 'stock:reverb',
      displayName: 'Reverb',
    }, { idFactory: () => 'fx-add' })
    expect(add.ok).toBe(true)
    expect(useEffectChainStore.getState().graphEngineNodeIds['7']['inst-add']).toBe(321)

    audio.syncLinearGraphTopology.mockClear()
    const undo = await useEffectChainStore.getState().undoGraphEditForTrack('7')
    expect(undo.ok).toBe(true)
    let state = useEffectChainStore.getState()
    expect(state.graphStates['7'].nodes.some((node) => node.data?.effectInstanceId === 'inst-add')).toBe(false)
    expect(state.graphEngineNodeIds['7']['inst-add']).toBeUndefined()
    expect(audio.removeGraphEffectNode).toHaveBeenCalledWith(7, 'inst-add')
    expect(audio.syncLinearGraphTopology).toHaveBeenCalledTimes(1)

    audio.addGraphEffectNode.mockResolvedValueOnce(654)
    audio.syncLinearGraphTopology.mockClear()
    const redo = await useEffectChainStore.getState().redoGraphEditForTrack('7')
    expect(redo.ok).toBe(true)
    state = useEffectChainStore.getState()
    expect(state.graphStates['7'].nodes.some((node) => node.data?.effectInstanceId === 'inst-add')).toBe(true)
    expect(state.graphEngineNodeIds['7']['inst-add']).toBe(654)
    expect(audio.addGraphEffectNode).toHaveBeenLastCalledWith(7, 'inst-add', 'stock:reverb')
    expect(audio.syncLinearGraphTopology).toHaveBeenCalledTimes(1)
    expect(state.chains['7']).toBe(baseChain)
  })

  it('undoes and redoes graph remove lifecycle while restoring edges and mappings', async () => {
    const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
    const baseChain = seedGraphMode(useEffectChainStore, makePositionedGraphState('7'))
    useEffectChainStore.setState({ graphEngineNodeIds: { '7': { 'effect-1': 210 } } })

    const remove = await useEffectChainStore.getState().removeGraphNodeForTrack('7', 'fx-1')
    expect(remove.ok).toBe(true)
    expect(useEffectChainStore.getState().graphStates['7'].edges).toEqual([])
    expect(useEffectChainStore.getState().graphEngineNodeIds['7']['effect-1']).toBeUndefined()
    expect(audio.removeGraphEffectNode).toHaveBeenCalledWith(7, 'effect-1')

    audio.addGraphEffectNode.mockResolvedValueOnce(777)
    audio.syncLinearGraphTopology.mockClear()
    const undo = await useEffectChainStore.getState().undoGraphEditForTrack('7')
    expect(undo.ok).toBe(true)
    let state = useEffectChainStore.getState()
    expect(state.graphStates['7'].nodes.map((node) => node.id)).toEqual(['input', 'fx-1', 'output'])
    expect(state.graphStates['7'].edges.map((edge) => edge.id)).toEqual(['edge-1', 'edge-2'])
    expect(state.graphEngineNodeIds['7']['effect-1']).toBe(777)
    expect(audio.addGraphEffectNode).toHaveBeenLastCalledWith(7, 'effect-1', 'stock:eq')
    expect(audio.syncLinearGraphTopology).toHaveBeenCalledTimes(1)

    audio.syncLinearGraphTopology.mockClear()
    const redo = await useEffectChainStore.getState().redoGraphEditForTrack('7')
    expect(redo.ok).toBe(true)
    state = useEffectChainStore.getState()
    expect(state.graphStates['7'].nodes.map((node) => node.id)).toEqual(['input', 'output'])
    expect(state.graphStates['7'].edges).toEqual([])
    expect(state.graphEngineNodeIds['7']['effect-1']).toBeUndefined()
    expect(audio.removeGraphEffectNode).toHaveBeenLastCalledWith(7, 'effect-1')
    expect(audio.syncLinearGraphTopology).toHaveBeenCalledTimes(1)
    expect(state.chains['7']).toBe(baseChain)
  })

  it('undoes and redoes connect and disconnect edits with topology resync', async () => {
    const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
    seedGraphMode(useEffectChainStore, graphWithoutEdges('7'))

    const connect = await useEffectChainStore.getState().connectGraphNodesForTrack('7', {
      sourceNodeId: 'input',
      targetNodeId: 'fx-1',
    }, { idFactory: () => 'edge-history' })
    expect(connect.ok).toBe(true)

    audio.syncLinearGraphTopology.mockClear()
    const undoConnect = await useEffectChainStore.getState().undoGraphEditForTrack('7')
    expect(undoConnect.ok).toBe(true)
    expect(useEffectChainStore.getState().graphStates['7'].edges).toEqual([])
    expect(audio.syncLinearGraphTopology).toHaveBeenCalledTimes(1)

    audio.syncLinearGraphTopology.mockClear()
    const redoConnect = await useEffectChainStore.getState().redoGraphEditForTrack('7')
    expect(redoConnect.ok).toBe(true)
    expect(useEffectChainStore.getState().graphStates['7'].edges.map((edge) => edge.id))
      .toEqual(['edge-history'])
    expect(audio.syncLinearGraphTopology).toHaveBeenCalledTimes(1)

    seedGraphMode(useEffectChainStore, makePositionedGraphState('7'))
    const disconnect = await useEffectChainStore.getState().disconnectGraphEdgeForTrack('7', 'edge-1')
    expect(disconnect.ok).toBe(true)

    audio.syncLinearGraphTopology.mockClear()
    const undoDisconnect = await useEffectChainStore.getState().undoGraphEditForTrack('7')
    expect(undoDisconnect.ok).toBe(true)
    expect(useEffectChainStore.getState().graphStates['7'].edges.map((edge) => edge.id))
      .toEqual(['edge-1', 'edge-2'])
    expect(audio.syncLinearGraphTopology).toHaveBeenCalledTimes(1)

    audio.syncLinearGraphTopology.mockClear()
    const redoDisconnect = await useEffectChainStore.getState().redoGraphEditForTrack('7')
    expect(redoDisconnect.ok).toBe(true)
    expect(useEffectChainStore.getState().graphStates['7'].edges.map((edge) => edge.id))
      .toEqual(['edge-2'])
    expect(audio.syncLinearGraphTopology).toHaveBeenCalledTimes(1)
  })

  it('clears redo after a new graph edit and keeps histories track scoped', async () => {
    const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
    const graph7 = makePositionedGraphState('7')
    const graph8 = makePositionedGraphState('8')
    useEffectChainStore.setState({
      chains: {
        '7': [makeEffect(11, 'compressor', 0)],
        '8': [makeEffect(12, 'delay', 0)],
      },
      fxModes: { '7': 'graph', '8': 'graph' },
      graphStates: { '7': graph7, '8': graph8 },
      graphStateStatuses: {
        '7': { status: 'valid', graphState: graph7, warnings: [] },
        '8': { status: 'valid', graphState: graph8, warnings: [] },
      },
      graphHistories: {},
    })

    await useEffectChainStore.getState().setGraphStateNodePosition(7, 'fx-1', { x: 300, y: 10 })
    await useEffectChainStore.getState().undoGraphEditForTrack(7)
    expect(useEffectChainStore.getState().graphHistories['7'].redoStack).toHaveLength(1)

    await useEffectChainStore.getState().setGraphStateNodePosition(7, 'fx-1', { x: 340, y: 20 })
    expect(useEffectChainStore.getState().graphHistories['7'].redoStack).toHaveLength(0)

    await useEffectChainStore.getState().setGraphStateNodePosition(8, 'fx-1', { x: 420, y: 30 })
    const state = useEffectChainStore.getState()
    expect(state.graphHistories['7'].undoStack).toHaveLength(1)
    expect(state.graphHistories['8'].undoStack).toHaveLength(1)
    expect(state.graphStates['7'].nodes.find((node) => node.id === 'fx-1')?.position)
      .toEqual({ x: 340, y: 20 })
    expect(state.graphStates['8'].nodes.find((node) => node.id === 'fx-1')?.position)
      .toEqual({ x: 420, y: 30 })
  })

  it('rejects graph history in chain mode without mutating graphState, history, or chains', async () => {
    const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
    const graphState = makePositionedGraphState('7')
    const chain = [makeEffect(11, 'compressor', 0)]
    const graphHistories = {
      '7': {
        undoStack: [{ label: 'move_graph_node', beforeGraphState: graphState, afterGraphState: graphState }],
        redoStack: [],
      },
    }
    useEffectChainStore.setState({
      chains: { '7': chain },
      fxModes: { '7': 'chain' },
      graphStates: { '7': graphState },
      graphStateStatuses: { '7': { status: 'valid', graphState, warnings: [] } },
      graphHistories,
    })

    await expect(useEffectChainStore.getState().undoGraphEditForTrack('7'))
      .resolves.toMatchObject({ ok: false, reason: 'not_graph_mode' })
    await expect(useEffectChainStore.getState().redoGraphEditForTrack('7'))
      .resolves.toMatchObject({ ok: false, reason: 'not_graph_mode' })
    expect(useEffectChainStore.getState().canUndoGraphEdit('7')).toBe(false)
    expect(useEffectChainStore.getState().graphStates['7']).toBe(graphState)
    expect(useEffectChainStore.getState().graphHistories).toBe(graphHistories)
    expect(useEffectChainStore.getState().chains['7']).toBe(chain)
    expect(timeline.setTrackGraphState).not.toHaveBeenCalled()
    expect(audio.syncLinearGraphTopology).not.toHaveBeenCalled()
  })

  it('keeps graphState, mappings, and stacks sane when redo creation fails', async () => {
    const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
    seedGraphMode(useEffectChainStore, graphWithoutEdges('7'))
    audio.addGraphEffectNode.mockResolvedValueOnce(321)

    const add = await useEffectChainStore.getState().addGraphEffectNodeForTrack('7', {
      effectInstanceId: 'redo-fail',
      pluginId: 'stock:reverb',
      displayName: 'Reverb',
    }, { idFactory: () => 'fx-redo-fail' })
    expect(add.ok).toBe(true)

    await expect(useEffectChainStore.getState().undoGraphEditForTrack('7'))
      .resolves.toMatchObject({ ok: true })
    const beforeRedo = useEffectChainStore.getState().graphStates['7']
    expect(beforeRedo.nodes.some((node) => node.data?.effectInstanceId === 'redo-fail')).toBe(false)
    expect(useEffectChainStore.getState().graphHistories['7'].redoStack).toHaveLength(1)

    audio.addGraphEffectNode.mockResolvedValueOnce(-1)
    const redo = await useEffectChainStore.getState().redoGraphEditForTrack('7')
    expect(redo).toMatchObject({ ok: false, reason: 'engine_instantiation_failed' })

    const state = useEffectChainStore.getState()
    expect(state.graphStates['7']).toBe(beforeRedo)
    expect(state.graphEngineNodeIds['7']['redo-fail']).toBeUndefined()
    expect(state.graphHistories['7'].undoStack).toHaveLength(0)
    expect(state.graphHistories['7'].redoStack).toHaveLength(1)
  })

  it('clears the session engine node cache on project load', async () => {
    const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
    useEffectChainStore.setState({
      chains: { '7': [makeEffect(11, 'compressor', 0)] },
      graphEngineNodeIds: { '7': { 'effect-1': 210 } },
      graphRuntimeStatuses: { '7': { ok: true, reason: 'graph_routing_active' } },
      graphHistories: { '7': { undoStack: [{ label: 'move_graph_node' }], redoStack: [] } },
    })

    projectLoadedHandler()
    await Promise.resolve()
    await Promise.resolve()

    expect(useEffectChainStore.getState().graphEngineNodeIds).toEqual({})
    expect(useEffectChainStore.getState().graphRuntimeStatuses).toEqual({})
    expect(useEffectChainStore.getState().graphHistories).toEqual({})
  })

  // --- FXG.4-a graph-owned effect parameter descriptors ---

  it('fetches graph effect parameters in graph mode without touching effectChains', async () => {
    const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
    const baseChain = seedGraphMode(useEffectChainStore, graphWithTwoEffects('7'))

    const result = await useEffectChainStore.getState().fetchGraphEffectParameters('7', 'effect-1')

    expect(result.ok).toBe(true)
    expect(result.parameters).toHaveLength(2)
    expect(result.parameters[0]).toMatchObject({ parameterId: 'feedback', normalizedValue: 0.5 })
    // Addressed by the stable effectInstanceId — never a graphState node id.
    expect(audio.getGraphEffectParameters).toHaveBeenCalledWith(7, 'effect-1')
    // effectChains and graphState are left untouched by a parameter read.
    expect(useEffectChainStore.getState().chains['7']).toBe(baseChain)
    expect(audio.addEffect).not.toHaveBeenCalled()
    expect(audio.removeEffect).not.toHaveBeenCalled()
  })

  it('rejects graph parameter mutation while the track is in chain mode', async () => {
    const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
    // Track '7' defaults to chain mode (no seedGraphMode).
    const result = await useEffectChainStore.getState()
      .setGraphEffectParameterNormalized('7', 'effect-1', 'feedback', 0.5)

    expect(result).toEqual({ ok: false, reason: 'not_graph_mode' })
    expect(audio.setGraphEffectParameterNormalized).not.toHaveBeenCalled()
  })

  it('sets a normalized value by effectInstanceId and clamps out-of-range input', async () => {
    const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
    const baseChain = seedGraphMode(useEffectChainStore, graphWithTwoEffects('7'))

    const result = await useEffectChainStore.getState()
      .setGraphEffectParameterNormalized('7', 'effect-2', 'mix', 2.0)

    expect(result.ok).toBe(true)
    expect(result.normalizedValue).toBe(1)
    // Clamped to [0,1] and addressed by effectInstanceId 'effect-2' (NOT the
    // graphState node id 'fx-2', NOT an engine node id number).
    expect(audio.setGraphEffectParameterNormalized).toHaveBeenCalledWith(7, 'effect-2', 'mix', 1)
    const [, instanceArg] = audio.setGraphEffectParameterNormalized.mock.calls[0]
    expect(instanceArg).toBe('effect-2')
    expect(typeof instanceArg).toBe('string')
    // No chain mutation from a graph parameter write.
    expect(useEffectChainStore.getState().chains['7']).toBe(baseChain)
    expect(audio.addEffect).not.toHaveBeenCalled()
  })

  it('rejects graph parameter reads on the master track and with no instance id', async () => {
    const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
    seedGraphMode(useEffectChainStore, graphWithTwoEffects('7'))

    const master = await useEffectChainStore.getState().fetchGraphEffectParameters('master', 'effect-1')
    expect(master).toEqual({ ok: false, reason: 'master_track' })

    const noInstance = await useEffectChainStore.getState().fetchGraphEffectParameters('7', '')
    expect(noInstance).toEqual({ ok: false, reason: 'missing_effect_instance_id' })
    expect(audio.getGraphEffectParameters).not.toHaveBeenCalled()
  })

  it('surfaces an unavailable plugin parameter list safely', async () => {
    const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
    seedGraphMode(useEffectChainStore, graphWithTwoEffects('7'))
    audio.getGraphEffectParameters.mockResolvedValueOnce(
      JSON.stringify({ ok: false, reason: 'plugin_missing', unavailable: true }),
    )

    const result = await useEffectChainStore.getState().fetchGraphEffectParameters('7', 'effect-1')
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('plugin_missing')
  })

  it('fails safely when the engine returns a malformed parameter payload', async () => {
    const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
    seedGraphMode(useEffectChainStore, graphWithTwoEffects('7'))
    audio.getGraphEffectParameters.mockResolvedValueOnce('not json {{{')

    const result = await useEffectChainStore.getState().fetchGraphEffectParameters('7', 'effect-1')
    expect(result).toEqual({ ok: false, reason: 'invalid_engine_response' })
  })

  it('reports engine_unavailable when the bridge API is missing', async () => {
    const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
    seedGraphMode(useEffectChainStore, graphWithTwoEffects('7'))
    delete window.xleth.audio.getGraphEffectParameters

    const result = await useEffectChainStore.getState().fetchGraphEffectParameters('7', 'effect-1')
    expect(result).toEqual({ ok: false, reason: 'engine_unavailable' })
  })

  // ── EVC.2 graph-owned envelope controller node actions ────────────────────
  describe('graph envelope node actions', () => {
    it('rejects adding an envelope node while Mixer Chain owns the track', async () => {
      const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
      const graphState = makePositionedGraphState('7')
      useEffectChainStore.setState({
        fxModes: { '7': 'chain' },
        graphStates: { '7': graphState },
        graphStateStatuses: { '7': { status: 'valid', graphState, warnings: [] } },
      })

      await expect(
        useEffectChainStore.getState().addGraphEnvelopeNodeForTrack('7'),
      ).resolves.toMatchObject({ ok: false, reason: 'not_graph_mode' })

      expect(useEffectChainStore.getState().graphStates['7']).toBe(graphState)
      expect(timeline.setTrackGraphState).not.toHaveBeenCalled()
      expect(audio.syncLinearGraphTopology).not.toHaveBeenCalled()
    })

    it('rejects adding an envelope node to the master track', async () => {
      const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
      await expect(
        useEffectChainStore.getState().addGraphEnvelopeNodeForTrack('master'),
      ).resolves.toMatchObject({ ok: false, reason: 'master_track' })
      expect(timeline.setTrackGraphState).not.toHaveBeenCalled()
    })

    it('adds an envelope node in graph mode, persists, records undo, and touches no engine APIs', async () => {
      const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
      const baseChain = seedGraphMode(useEffectChainStore, makePositionedGraphState('7'))

      const result = await useEffectChainStore.getState()
        .addGraphEnvelopeNodeForTrack('7', { idFactory: () => 'env-gen-0' })

      expect(result.ok).toBe(true)
      const state = useEffectChainStore.getState()
      const next = state.graphStates['7']
      const env = next.nodes.find((node) => node.id === 'env-gen-0')
      expect(env).toMatchObject({
        type: 'envelope',
        data: {
          label: 'Envelope',
          includeSlideNotes: false,
        },
      })
      // EVC-R2-r3 — the removed selector/mode and the retired per-voice shape never persist.
      expect(env.data).not.toHaveProperty('triggerSource')
      expect(env.data).not.toHaveProperty('retriggerMode')
      expect(env.data).not.toHaveProperty('voiceMode')
      expect(env.data).not.toHaveProperty('target')
      expect(Number.isFinite(env.position.x) && Number.isFinite(env.position.y)).toBe(true)
      // Persisted via setTrackGraphState; no audio sync; chains/effect APIs untouched.
      expect(timeline.setTrackGraphState).toHaveBeenCalledWith(7, next)
      expect(state.chains['7']).toBe(baseChain)
      expect(audio.syncLinearGraphTopology).not.toHaveBeenCalled()
      expect(audio.addGraphEffectNode).not.toHaveBeenCalled()
      expect(audio.hydrateGraphEffectNodes).not.toHaveBeenCalled()
      expect(audio.setGraphEffectParameterNormalized).not.toHaveBeenCalled()
      expect(state.graphHistories['7'].undoStack.at(-1)).toMatchObject({ label: 'add_graph_envelope_node' })
    })

    it('applies data overrides when adding an envelope node', async () => {
      const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
      seedGraphMode(useEffectChainStore, makePositionedGraphState('7'))

      const result = await useEffectChainStore.getState().addGraphEnvelopeNodeForTrack('7', {
        idFactory: () => 'env-a',
        data: { label: 'Pluck', attackMs: 2, sustain: 0.2, includeSlideNotes: true },
      })

      expect(result.ok).toBe(true)
      const env = useEffectChainStore.getState().graphStates['7'].nodes.find((n) => n.id === 'env-a')
      expect(env.data).toMatchObject({ label: 'Pluck', attackMs: 2, sustain: 0.2, includeSlideNotes: true })
    })

    it('rejects updating an envelope node while Mixer Chain owns the track', async () => {
      const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
      const graphState = makePositionedGraphState('7', {
        nodes: [
          ...makePositionedGraphState('7').nodes,
          { id: 'env-a', type: 'envelope', position: { x: 80, y: 420 }, data: {} },
        ],
      })
      useEffectChainStore.setState({
        fxModes: { '7': 'chain' },
        graphStates: { '7': graphState },
        graphStateStatuses: { '7': { status: 'valid', graphState, warnings: [] } },
      })

      await expect(
        useEffectChainStore.getState().updateGraphEnvelopeNodeDataForTrack('7', 'env-a', { sustain: 0.5 }),
      ).resolves.toMatchObject({ ok: false, reason: 'not_graph_mode' })
      expect(timeline.setTrackGraphState).not.toHaveBeenCalled()
    })

    it('updates envelope data in graph mode, persists, records undo, and supports undo/redo', async () => {
      const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
      const graphState = makePositionedGraphState('7', {
        nodes: [
          ...makePositionedGraphState('7').nodes,
          { id: 'env-a', type: 'envelope', position: { x: 80, y: 420 }, data: { sustain: 0.7 } },
        ],
      })
      const baseChain = seedGraphMode(useEffectChainStore, graphState)

      const result = await useEffectChainStore.getState()
        .updateGraphEnvelopeNodeDataForTrack('7', 'env-a', { attackMs: 33, sustain: 0.42, includeSlideNotes: true })

      expect(result.ok).toBe(true)
      let state = useEffectChainStore.getState()
      let env = state.graphStates['7'].nodes.find((n) => n.id === 'env-a')
      expect(env.data).toMatchObject({ attackMs: 33, sustain: 0.42, includeSlideNotes: true })
      expect(timeline.setTrackGraphState).toHaveBeenCalledWith(7, state.graphStates['7'])
      expect(audio.syncLinearGraphTopology).not.toHaveBeenCalled()
      expect(audio.setGraphEffectParameterNormalized).not.toHaveBeenCalled()
      expect(state.chains['7']).toBe(baseChain)
      expect(state.graphHistories['7'].undoStack.at(-1)).toMatchObject({ label: 'update_graph_envelope_node' })

      const undo = await useEffectChainStore.getState().undoGraphEditForTrack('7')
      expect(undo.ok).toBe(true)
      state = useEffectChainStore.getState()
      env = state.graphStates['7'].nodes.find((n) => n.id === 'env-a')
      expect(env.data.sustain).toBe(0.7)
      expect(env.data.includeSlideNotes).toBe(false)

      const redo = await useEffectChainStore.getState().redoGraphEditForTrack('7')
      expect(redo.ok).toBe(true)
      env = useEffectChainStore.getState().graphStates['7'].nodes.find((n) => n.id === 'env-a')
      expect(env.data.includeSlideNotes).toBe(true)
      // Undo/redo of a control node never resyncs the audio topology.
      expect(audio.syncLinearGraphTopology).not.toHaveBeenCalled()
    })

    it('rejects updating a non-envelope node', async () => {
      const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
      seedGraphMode(useEffectChainStore, makePositionedGraphState('7'))

      await expect(
        useEffectChainStore.getState().updateGraphEnvelopeNodeDataForTrack('7', 'fx-1', { sustain: 0.5 }),
      ).resolves.toMatchObject({ ok: false, reason: 'unknown_node_type' })
      expect(timeline.setTrackGraphState).not.toHaveBeenCalled()
    })

    it('never mutates effectChains for either envelope action', async () => {
      const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
      const baseChain = seedGraphMode(useEffectChainStore, makePositionedGraphState('7'))

      await useEffectChainStore.getState().addGraphEnvelopeNodeForTrack('7', { idFactory: () => 'env-a' })
      await useEffectChainStore.getState().updateGraphEnvelopeNodeDataForTrack('7', 'env-a', { amount: 0.25 })

      const state = useEffectChainStore.getState()
      expect(state.chains['7']).toBe(baseChain)
      expect(audio.addEffect).not.toHaveBeenCalled()
      expect(audio.removeEffect).not.toHaveBeenCalled()
      expect(audio.moveEffect).not.toHaveBeenCalled()
    })
  })

  // ── EVC-R1 envelope → parameter links ─────────────────────────────────────
  describe('connectEnvelopeToParameterForTrack', () => {
    // A macro-link graph (effect with exposed 'mix') plus an envelope node.
    function makeEnvelopeLinkGraphState(trackId = '7') {
      const base = makeMacroLinkGraphState(trackId)
      return {
        ...base,
        nodes: [...base.nodes, { id: 'env-a', type: 'envelope', position: { x: 80, y: 360 }, data: {} }],
      }
    }

    it('rejects linking while Mixer Chain owns the track', async () => {
      const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
      const graphState = makeEnvelopeLinkGraphState('7')
      useEffectChainStore.setState({
        fxModes: { '7': 'chain' },
        graphStates: { '7': graphState },
        graphStateStatuses: { '7': { status: 'valid', graphState, warnings: [] } },
      })

      await expect(
        useEffectChainStore.getState().connectEnvelopeToParameterForTrack('7', {
          sourceNodeId: 'env-a', targetNodeId: 'fx-1', parameterId: 'mix',
        }),
      ).resolves.toMatchObject({ ok: false, reason: 'not_graph_mode' })
      expect(timeline.setTrackGraphState).not.toHaveBeenCalled()
    })

    it('rejects linking on the master track', async () => {
      const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
      await expect(
        useEffectChainStore.getState().connectEnvelopeToParameterForTrack('master', {
          sourceNodeId: 'env-a', targetNodeId: 'fx-1', parameterId: 'mix',
        }),
      ).resolves.toMatchObject({ ok: false })
      expect(timeline.setTrackGraphState).not.toHaveBeenCalled()
    })

    it('links an Envelope controlOut to a parameter, persists, records undo, and never drives the parameter', async () => {
      const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
      const baseChain = seedGraphMode(useEffectChainStore, makeEnvelopeLinkGraphState('7'))

      const result = await useEffectChainStore.getState().connectEnvelopeToParameterForTrack('7', {
        sourceNodeId: 'env-a',
        targetNodeId: 'fx-1',
        parameterId: 'mix',
      }, { idFactory: () => 'p-env-mix' })

      expect(result.ok).toBe(true)
      const state = useEffectChainStore.getState()
      const next = state.graphStates['7']
      const edge = next.edges.find((e) => e.id === 'p-env-mix')
      expect(edge).toMatchObject({
        sourceNodeId: 'env-a',
        sourcePort: 'controlOut',
        targetNodeId: 'fx-1',
        targetPort: 'gpp:fx-1:mix',
        type: 'parameter',
      })
      expect(edge.targetParameter.kind).toBe('graph-parameter')
      expect(edge.mapping).toMatchObject({ enabled: true, sourceMin: 0, sourceMax: 1, targetMin: 0, targetMax: 1 })
      expect(JSON.stringify(next.edges)).not.toContain('engineNodeId')
      // Persisted, undoable, no audio sync, chains untouched.
      expect(timeline.setTrackGraphState).toHaveBeenCalledWith(7, next)
      expect(audio.syncLinearGraphTopology).not.toHaveBeenCalled()
      expect(state.chains['7']).toBe(baseChain)
      expect(state.graphHistories['7'].undoStack.at(-1)).toMatchObject({ label: 'connect_envelope_to_parameter' })
      // EVC-R1 is runtime-inert: the Envelope never writes the parameter (that is EVC-R2).
      expect(audio.setGraphEffectParameterNormalized).not.toHaveBeenCalled()
    })

    it('never mutates effectChains when linking', async () => {
      const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
      const baseChain = seedGraphMode(useEffectChainStore, makeEnvelopeLinkGraphState('7'))

      await useEffectChainStore.getState().connectEnvelopeToParameterForTrack('7', {
        sourceNodeId: 'env-a', targetNodeId: 'fx-1', parameterId: 'mix',
      }, { idFactory: () => 'p-env-mix' })

      const state = useEffectChainStore.getState()
      expect(state.chains['7']).toBe(baseChain)
      expect(audio.addEffect).not.toHaveBeenCalled()
      expect(audio.removeEffect).not.toHaveBeenCalled()
      expect(audio.moveEffect).not.toHaveBeenCalled()
    })
  })

  // ── FXG.4-h parent-attached macro automation lanes ────────────────────────
  describe('macro automation lanes', () => {
    const idFactory = () => 'fixed-clip-id'

    it('creates a lane + clip bound to the parent track and macro, persists, records undo, no audio sync', async () => {
      const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
      seedGraphMode(useEffectChainStore, makeMacroLinkGraphState('7'))

      const result = await useEffectChainStore.getState()
        .createMacroAutomationClipForTrack('7', 'macro-a', { startTick: 0, lengthTicks: 960 }, { idFactory })

      expect(result.ok).toBe(true)
      const state = useEffectChainStore.getState()
      const lane = state.graphStates['7'].macroAutomationLanes[0]
      expect(lane.macroNodeId).toBe('macro-a')
      expect(lane.clips[0].startTick).toBe(0)
      expect(timeline.setTrackGraphState).toHaveBeenCalledWith(7, state.graphStates['7'])
      expect(audio.syncLinearGraphTopology).not.toHaveBeenCalled()
      expect(state.graphHistories['7'].undoStack.at(-1)).toMatchObject({ label: 'create_macro_automation_clip' })
    })

    it('supports multiple macro lanes under one parent track', async () => {
      const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
      const gs = makeMacroLinkGraphState('7')
      gs.nodes.push({ id: 'macro-b', type: 'macro', position: { x: 80, y: 320 }, data: { label: 'Macro 2', normalizedValue: 0.2 } })
      seedGraphMode(useEffectChainStore, gs)

      await useEffectChainStore.getState().showMacroAutomationLaneForTrack('7', 'macro-a')
      await useEffectChainStore.getState().showMacroAutomationLaneForTrack('7', 'macro-b')

      const lanes = useEffectChainStore.getState().graphStates['7'].macroAutomationLanes
      expect(lanes.map((l) => l.macroNodeId).sort()).toEqual(['macro-a', 'macro-b'])
    })

    it('rejects same-lane overlapping clips', async () => {
      const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
      seedGraphMode(useEffectChainStore, makeMacroLinkGraphState('7'))
      await useEffectChainStore.getState()
        .createMacroAutomationClipForTrack('7', 'macro-a', { startTick: 0, lengthTicks: 960 })
      const overlap = await useEffectChainStore.getState()
        .createMacroAutomationClipForTrack('7', 'macro-a', { startTick: 480, lengthTicks: 960 })
      expect(overlap).toMatchObject({ ok: false, reason: 'clip_overlap' })
    })

    it('hide keeps clips; gated to graph mode', async () => {
      const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
      seedGraphMode(useEffectChainStore, makeMacroLinkGraphState('7'))
      const created = await useEffectChainStore.getState()
        .createMacroAutomationClipForTrack('7', 'macro-a', { startTick: 0, lengthTicks: 960 })
      await useEffectChainStore.getState().hideMacroAutomationLaneForTrack('7', 'macro-a')
      const lane = useEffectChainStore.getState().graphStates['7'].macroAutomationLanes[0]
      expect(lane.visible).toBe(false)
      expect(lane.clips.some((c) => c.clipId === created.clipId)).toBe(true)

      useEffectChainStore.setState({ fxModes: { '7': 'chain' } })
      const blocked = await useEffectChainStore.getState()
        .createMacroAutomationClipForTrack('7', 'macro-a', { startTick: 2000, lengthTicks: 480 })
      expect(blocked).toMatchObject({ ok: false, reason: 'not_graph_mode' })
    })

    it('copy/paste is lane-compatible only', async () => {
      const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
      const gs = makeMacroLinkGraphState('7')
      gs.nodes.push({ id: 'macro-b', type: 'macro', position: { x: 80, y: 320 }, data: { label: 'Macro 2', normalizedValue: 0 } })
      seedGraphMode(useEffectChainStore, gs)

      const created = await useEffectChainStore.getState()
        .createMacroAutomationClipForTrack('7', 'macro-a', { startTick: 0, lengthTicks: 480 })
      const payload = useEffectChainStore.getState().buildMacroAutomationClipCopyPayload('7', created.clipId)
      expect(payload.sourceMacroNodeId).toBe('macro-a')

      const wrongLane = await useEffectChainStore.getState()
        .pasteMacroAutomationClipForTrack('7', 'macro-b', payload, { startTick: 0 })
      expect(wrongLane).toMatchObject({ ok: false, reason: 'incompatible_lane' })

      const sameLane = await useEffectChainStore.getState()
        .pasteMacroAutomationClipForTrack('7', 'macro-a', payload, { startTick: 1000 })
      expect(sameLane.ok).toBe(true)
      expect(useEffectChainStore.getState().graphStates['7'].macroAutomationLanes
        .find((l) => l.macroNodeId === 'macro-a').clips).toHaveLength(2)
    })

    it('removing a macro node orphans its lane safely (no crash, evaluation skips)', async () => {
      const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
      seedGraphMode(useEffectChainStore, makeMacroLinkGraphState('7'))
      await useEffectChainStore.getState()
        .createMacroAutomationClipForTrack('7', 'macro-a', { startTick: 0, lengthTicks: 960 })

      const removed = await useEffectChainStore.getState().removeGraphNodeForTrack('7', 'macro-a')
      expect(removed.ok).toBe(true)
      const lane = useEffectChainStore.getState().graphStates['7'].macroAutomationLanes[0]
      expect(lane.targetUnavailable).toBe(true)

      // Playback evaluation must not drive a missing macro.
      audio.setGraphEffectParameterNormalized.mockClear()
      const applied = await useEffectChainStore.getState().applyMacroAutomationAtTick(480)
      expect(applied.ok).toBe(true)
      expect(applied.driven).toHaveLength(0)
    })

    it('applyMacroAutomationAtTick drives the macro parameter edge, not the plugin directly', async () => {
      const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
      seedGraphMode(useEffectChainStore, makeLinkedMacroGraphState('7'))
      // Build a ramp clip 0→1 over local ticks 0..960 covering global ticks 0..960.
      const created = await useEffectChainStore.getState()
        .createMacroAutomationClipForTrack('7', 'macro-a', { startTick: 0, lengthTicks: 960 })
      await useEffectChainStore.getState()
        .moveMacroAutomationPointForTrack('7', created.clipId, 0, { value: 0 })
      await useEffectChainStore.getState()
        .moveMacroAutomationPointForTrack('7', created.clipId, 1, { value: 1 })

      audio.setGraphEffectParameterNormalized.mockClear()
      const result = await useEffectChainStore.getState().applyMacroAutomationAtTick(480)
      expect(result.driven).toHaveLength(1)
      expect(result.driven[0]).toMatchObject({ trackId: '7', macroNodeId: 'macro-a' })
      // The drive goes through setGraphEffectParameterNormalized for the linked 'mix' param.
      expect(audio.setGraphEffectParameterNormalized).toHaveBeenCalledWith(7, 'effect-1', 'mix', expect.any(Number))
    })

    it('applyMacroAutomationAtTick suppresses redundant drives via the last-value cache', async () => {
      const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
      seedGraphMode(useEffectChainStore, makeLinkedMacroGraphState('7'))
      // Flat clip → same value at every tick.
      await useEffectChainStore.getState()
        .createMacroAutomationClipForTrack('7', 'macro-a', { startTick: 0, lengthTicks: 960, value: 0.5 })

      audio.setGraphEffectParameterNormalized.mockClear()
      await useEffectChainStore.getState().applyMacroAutomationAtTick(100)
      const firstCalls = audio.setGraphEffectParameterNormalized.mock.calls.length
      expect(firstCalls).toBeGreaterThan(0)
      await useEffectChainStore.getState().applyMacroAutomationAtTick(200) // same flat value
      expect(audio.setGraphEffectParameterNormalized.mock.calls.length).toBe(firstCalls)

      useEffectChainStore.getState().resetMacroAutomationRuntime()
      await useEffectChainStore.getState().applyMacroAutomationAtTick(300)
      expect(audio.setGraphEffectParameterNormalized.mock.calls.length).toBeGreaterThan(firstCalls)
    })
  })
})

// ---------------------------------------------------------------------------
// FXG.4-g updateGraphParameterEdgeMappingForTrack
// ---------------------------------------------------------------------------

describe('effectChainStore updateGraphParameterEdgeMappingForTrack', () => {
  let audio
  let timeline

  beforeEach(() => {
    vi.resetModules()
    audio = {
      getEffectChain: vi.fn(async () => '[]'),
      getMasterEffectChain: vi.fn(async () => '[]'),
      addEffect: vi.fn(async () => true),
      addMasterEffect: vi.fn(async () => true),
      removeEffect: vi.fn(async () => true),
      removeMasterEffect: vi.fn(async () => true),
      moveEffect: vi.fn(async () => true),
      moveMasterEffect: vi.fn(async () => true),
      setEffectBypass: vi.fn(async () => true),
      setMasterEffectBypass: vi.fn(async () => true),
      instantiateGraphEffect: vi.fn(async () => JSON.stringify({ ok: true, engineNodeId: 99 })),
      removeGraphEffect: vi.fn(async () => JSON.stringify({ ok: true })),
      syncLinearGraphTopology: vi.fn(async () => ({ ok: true })),
      syncGraphTopology: vi.fn(async () => ({ ok: true })),
      setGraphEffectParameterNormalized: vi.fn(async () => ({ ok: true })),
      getGraphEffectParameters: vi.fn(async () => '{"ok":false,"reason":"not_used"}'),
    }
    timeline = {
      setTrackGraphState: vi.fn(async () => true),
    }
    globalThis.window = { xleth: { audio, timeline } }
  })

  afterEach(() => {
    delete globalThis.window
  })

  function seedGraphMode(store, gs) {
    store.setState({
      fxModes: { [gs.trackId]: 'graph' },
      graphStates: { [gs.trackId]: gs },
      graphHistories: {},
    })
  }

  it('updates targetMin/targetMax and records an undo entry', async () => {
    const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
    seedGraphMode(useEffectChainStore, makeLinkedMacroGraphState())

    const result = await useEffectChainStore.getState().updateGraphParameterEdgeMappingForTrack(
      '7', 'p-mix', { targetMin: 0.5, targetMax: 1 },
    )
    expect(result.ok).toBe(true)

    const gs = useEffectChainStore.getState().graphStates['7']
    const edge = gs.edges.find((e) => e.id === 'p-mix')
    expect(edge.mapping.targetMin).toBe(0.5)
    expect(edge.mapping.targetMax).toBe(1)

    const history = useEffectChainStore.getState().graphHistories['7']
    expect(history.undoStack.at(-1)).toMatchObject({ label: 'update_parameter_edge_mapping' })
  })

  it('upgrades a linear edge to bezier and re-drives the parameter', async () => {
    const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
    seedGraphMode(useEffectChainStore, makeLinkedMacroGraphState())

    await useEffectChainStore.getState().updateGraphParameterEdgeMappingForTrack(
      '7', 'p-mix', { curve: createDefaultBezierCurve() },
    )

    const gs = useEffectChainStore.getState().graphStates['7']
    const edge = gs.edges.find((e) => e.id === 'p-mix')
    expect(edge.mapping.curve.type).toBe(GRAPH_PARAMETER_CURVE_BEZIER)
    // The drive should have written through setGraphEffectParameterNormalized
    expect(audio.setGraphEffectParameterNormalized).toHaveBeenCalled()
  })

  it('resets to linear when curve patch is { type: linear }', async () => {
    const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
    seedGraphMode(useEffectChainStore, makeLinkedMacroGraphState(
      '7',
      { curve: createDefaultBezierCurve() },
    ))

    await useEffectChainStore.getState().updateGraphParameterEdgeMappingForTrack(
      '7', 'p-mix', { curve: { type: 'linear' } },
    )

    const gs = useEffectChainStore.getState().graphStates['7']
    const edge = gs.edges.find((e) => e.id === 'p-mix')
    expect(edge.mapping.curve.type).toBe('linear')
  })

  it('fails gracefully for a non-parameter edge', async () => {
    const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
    seedGraphMode(useEffectChainStore, makeLinkedMacroGraphState())

    const audioEdgeId = useEffectChainStore.getState().graphStates['7'].edges
      .find((e) => e.type === 'audio').id
    const result = await useEffectChainStore.getState().updateGraphParameterEdgeMappingForTrack(
      '7', audioEdgeId, { enabled: false },
    )
    expect(result.ok).toBe(false)
  })

  it('does not mutate effectChains', async () => {
    const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
    seedGraphMode(useEffectChainStore, makeLinkedMacroGraphState())
    const chainsBefore = useEffectChainStore.getState().chains

    await useEffectChainStore.getState().updateGraphParameterEdgeMappingForTrack(
      '7', 'p-mix', { targetMin: 0.3 },
    )

    expect(useEffectChainStore.getState().chains).toBe(chainsBefore)
  })

  // --- FXG-SC.6B FX Graph Sidechain Input store actions ---

  // input -> compressor -> output, graph track '7'. No Sidechain Input node yet.
  function makeSidechainStoreGraphState(trackId = '7') {
    return {
      schemaVersion: 1,
      trackId,
      nodes: [
        { id: 'input', type: 'trackInput', position: { x: 0, y: 0 }, data: {} },
        {
          id: 'fx-comp',
          type: 'effect',
          position: { x: 260, y: 0 },
          data: {
            effectInstanceId: 'comp-inst',
            pluginId: 'compressor',
            displayName: 'Compressor',
            bypass: false,
            missing: false,
            crashed: false,
            sourceChainSlotIndex: 0,
            sidechain: { supported: true, channels: 2, enabled: false },
            exposedParameterPorts: [],
          },
        },
        { id: 'output', type: 'trackOutput', position: { x: 520, y: 0 }, data: {} },
      ],
      edges: [
        { id: 'e-in', sourceNodeId: 'input', sourcePort: 'audio', targetNodeId: 'fx-comp', targetPort: 'audioIn', type: 'audio' },
        { id: 'e-out', sourceNodeId: 'fx-comp', sourcePort: 'audioOut', targetNodeId: 'output', targetPort: 'audio', type: 'audio' },
      ],
      viewport: { x: 0, y: 0, zoom: 1 },
    }
  }

  // Seeds a graph that already has a Sidechain Input node (id 'sc', source track 3).
  function withSidechainInput(graphState) {
    return {
      ...graphState,
      nodes: [
        ...graphState.nodes,
        { id: 'sc', type: 'sidechainInput', position: { x: 0, y: 120 }, data: { label: 'Sidechain Input', sourceTrackId: 3 } },
      ],
    }
  }

  it('adds a Sidechain Input node only in graph mode and persists without a route or topology sync', async () => {
    const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
    const baseChain = seedGraphMode(useEffectChainStore, makeSidechainStoreGraphState('7'))

    const result = await useEffectChainStore.getState().addSidechainInputNodeForTrack('7', {
      idFactory: () => 'sc-new', sourceTrackId: 3,
    })

    expect(result.ok).toBe(true)
    const next = useEffectChainStore.getState().graphStates['7']
    const node = next.nodes.find((n) => n.id === 'sc-new')
    expect(node).toMatchObject({ type: 'sidechainInput', data: { label: 'Sidechain Input', sourceTrackId: 3 } })
    const persisted = timeline.setTrackGraphState.mock.calls.at(-1)[1]
    expect(persisted.nodes.find((n) => n.id === 'fx-comp').data.sidechain).toBeUndefined()
    expect(next.nodes.find((n) => n.id === 'fx-comp').data.sidechain).toEqual({ supported: true, channels: 2, enabled: false })
    // No audio topology sync, no native route, no sc_external write, chains untouched.
    expect(audio.syncLinearGraphTopology).not.toHaveBeenCalled()
    expect(audio.setGraphEffectParameterNormalized).not.toHaveBeenCalled()
    expect(useEffectChainStore.getState().chains['7']).toBe(baseChain)
  })

  it('rejects a duplicate Sidechain Input node', async () => {
    const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
    seedGraphMode(useEffectChainStore, withSidechainInput(makeSidechainStoreGraphState('7')))

    const result = await useEffectChainStore.getState().addSidechainInputNodeForTrack('7')
    expect(result).toMatchObject({ ok: false, reason: 'sidechain_input_exists', existingNodeId: 'sc' })
  })

  it('rejects adding a Sidechain Input node on master/chain-mode/missing graphState', async () => {
    const { default: useEffectChainStore } = await loadEffectChainStoreFixture()

    await expect(useEffectChainStore.getState().addSidechainInputNodeForTrack('master'))
      .resolves.toMatchObject({ ok: false, reason: 'master_track' })

    useEffectChainStore.setState({ fxModes: { '7': 'chain' }, graphStates: { '7': makeSidechainStoreGraphState('7') } })
    await expect(useEffectChainStore.getState().addSidechainInputNodeForTrack('7'))
      .resolves.toMatchObject({ ok: false, reason: 'not_graph_mode' })

    useEffectChainStore.setState({ fxModes: { '8': 'graph' }, graphStates: { '8': null } })
    await expect(useEffectChainStore.getState().addSidechainInputNodeForTrack('8'))
      .resolves.toMatchObject({ ok: false, reason: 'missing_graph_state' })
  })

  it('sets the Sidechain Input source and allows clearing it', async () => {
    const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
    seedGraphMode(useEffectChainStore, withSidechainInput(makeSidechainStoreGraphState('7')))

    const set = await useEffectChainStore.getState().setSidechainInputSourceForTrack('7', 'sc', 9, {
      eligibleSourceTrackIds: [3, 9],
    })
    expect(set.ok).toBe(true)
    expect(useEffectChainStore.getState().graphStates['7'].nodes.find((n) => n.id === 'sc').data.sourceTrackId).toBe(9)

    const cleared = await useEffectChainStore.getState().setSidechainInputSourceForTrack('7', 'sc', null)
    expect(cleared.ok).toBe(true)
    expect(useEffectChainStore.getState().graphStates['7'].nodes.find((n) => n.id === 'sc').data.sourceTrackId).toBeNull()
  })

  it('rejects a self source and an ineligible source', async () => {
    const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
    seedGraphMode(useEffectChainStore, withSidechainInput(makeSidechainStoreGraphState('7')))

    await expect(useEffectChainStore.getState().setSidechainInputSourceForTrack('7', 'sc', 7))
      .resolves.toMatchObject({ ok: false, reason: 'invalid_sidechain_source' })

    await expect(useEffectChainStore.getState().setSidechainInputSourceForTrack('7', 'sc', 5, {
      eligibleSourceTrackIds: [3],
    })).resolves.toMatchObject({ ok: false, reason: 'invalid_sidechain_source' })
  })

  it('connects a sidechain edge to the compressor without native route/topology calls', async () => {
    const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
    seedGraphMode(useEffectChainStore, withSidechainInput(makeSidechainStoreGraphState('7')))

    const result = await useEffectChainStore.getState().connectSidechainForTrack('7', 'sc', 'fx-comp', {
      idFactory: () => 'sce-1',
    })
    expect(result.ok).toBe(true)
    const edge = useEffectChainStore.getState().graphStates['7'].edges.find((e) => e.id === 'sce-1')
    expect(edge).toMatchObject({ type: 'sidechain', sourcePort: 'sidechainOut', targetPort: 'sidechainIn' })
    expect(audio.syncLinearGraphTopology).not.toHaveBeenCalled()
    expect(audio.setGraphEffectParameterNormalized).not.toHaveBeenCalled()
  })

  it('rejects connecting a sidechain edge to an unsupported target', async () => {
    const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
    const graphState = withSidechainInput(makeSidechainStoreGraphState('7'))
    graphState.nodes.find((n) => n.id === 'fx-comp').data.sidechain = { supported: false, channels: 0, enabled: false }
    seedGraphMode(useEffectChainStore, graphState)

    await expect(useEffectChainStore.getState().connectSidechainForTrack('7', 'sc', 'fx-comp'))
      .resolves.toMatchObject({ ok: false, reason: 'unsupported_sidechain_target' })
  })

  it('disconnects a sidechain edge and rejects non-sidechain edge ids', async () => {
    const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
    seedGraphMode(useEffectChainStore, withSidechainInput(makeSidechainStoreGraphState('7')))
    await useEffectChainStore.getState().connectSidechainForTrack('7', 'sc', 'fx-comp', { idFactory: () => 'sce-1' })

    await expect(useEffectChainStore.getState().disconnectSidechainEdgeForTrack('7', 'e-in'))
      .resolves.toMatchObject({ ok: false, reason: 'missing_edge' })

    const removed = await useEffectChainStore.getState().disconnectSidechainEdgeForTrack('7', 'sce-1')
    expect(removed.ok).toBe(true)
    expect(useEffectChainStore.getState().graphStates['7'].edges.some((e) => e.id === 'sce-1')).toBe(false)
  })

  it('restores the Sidechain Input node via graph undo/redo', async () => {
    const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
    seedGraphMode(useEffectChainStore, makeSidechainStoreGraphState('7'))

    await useEffectChainStore.getState().addSidechainInputNodeForTrack('7', { idFactory: () => 'sc-new' })
    expect(useEffectChainStore.getState().graphStates['7'].nodes.some((n) => n.id === 'sc-new')).toBe(true)

    await useEffectChainStore.getState().undoGraphEditForTrack('7')
    expect(useEffectChainStore.getState().graphStates['7'].nodes.some((n) => n.id === 'sc-new')).toBe(false)

    await useEffectChainStore.getState().redoGraphEditForTrack('7')
    expect(useEffectChainStore.getState().graphStates['7'].nodes.some((n) => n.id === 'sc-new')).toBe(true)
  })
})

// --- FXG-SC.6C FX Graph Sidechain Input → Timeline SidechainRoute reconciliation ---
describe('effectChainStore graph sidechain route reconciliation (6C)', () => {
  let audio
  let timeline

  beforeEach(() => {
    vi.resetModules()
    audio = {
      getEffectChain: vi.fn(async () => '[]'),
      getMasterEffectChain: vi.fn(async () => '[]'),
      setGraphEffectParameterNormalized: vi.fn(async () => JSON.stringify({ ok: true })),
      syncLinearGraphTopology: vi.fn(async () => ({ ok: true })),
      syncGraphTopology: vi.fn(async () => ({ ok: true })),
      hydrateGraphEffectNodes: vi.fn(async (_trackId, nodes = []) => ({
        ok: true,
        mapping: Object.fromEntries(nodes.map((n, i) => [n.effectInstanceId, 500 + i])),
        skipped: [],
        failures: [],
      })),
      removeGraphEffectNode: vi.fn(async () => true),
    }
    timeline = {
      setTrackGraphState: vi.fn(async () => true),
      getRouting: vi.fn(async () => []),
      addSidechainRoute: vi.fn(async () => ({ ok: true, routeId: 'r-new' })),
      removeSidechainRoute: vi.fn(async () => ({ ok: true })),
    }
    globalThis.window = { xleth: { audio, timeline } }
  })

  afterEach(() => {
    delete globalThis.window
  })

  // input -> compressor -> output on graph track '7', plus a Sidechain Input node
  // 'sc' (source track 3) optionally connected to the compressor by a sidechain edge.
  function makeReconcileGraphState(trackId = '7', {
    source = 3,
    withEdge = true,
    pluginId = 'compressor',
    effectInstanceId = 'comp-inst',
    sidechain = { supported: true, channels: 2, enabled: false },
  } = {}) {
    const nodes = [
      { id: 'input', type: 'trackInput', position: { x: 0, y: 0 }, data: {} },
      {
        id: 'fx-comp',
        type: 'effect',
        position: { x: 260, y: 0 },
        data: {
          effectInstanceId, pluginId, displayName: 'Compressor',
          bypass: false, missing: false, crashed: false, sourceChainSlotIndex: 0, sidechain, exposedParameterPorts: [],
        },
      },
      { id: 'output', type: 'trackOutput', position: { x: 520, y: 0 }, data: {} },
      { id: 'sc', type: 'sidechainInput', position: { x: 0, y: 120 }, data: { label: 'Sidechain Input', sourceTrackId: source } },
    ]
    const edges = [
      { id: 'e-in', sourceNodeId: 'input', sourcePort: 'audio', targetNodeId: 'fx-comp', targetPort: 'audioIn', type: 'audio' },
      { id: 'e-out', sourceNodeId: 'fx-comp', sourcePort: 'audioOut', targetNodeId: 'output', targetPort: 'audio', type: 'audio' },
    ]
    if (withEdge) {
      edges.push({ id: 'sce', sourceNodeId: 'sc', sourcePort: 'sidechainOut', targetNodeId: 'fx-comp', targetPort: 'sidechainIn', type: 'sidechain' })
    }
    return { schemaVersion: 1, trackId, nodes, edges, viewport: { x: 0, y: 0, zoom: 1 } }
  }

  // Build a timeline.getRouting()-shaped snapshot from a flat list of routes.
  function routingSnapshot(routes = []) {
    const bySource = new Map()
    for (const r of routes) {
      const list = bySource.get(r.sourceTrackId) ?? []
      list.push({
        routeId: r.routeId,
        sourceTrackId: r.sourceTrackId,
        targetTrackId: r.targetTrackId,
        targetEffectInstanceId: r.targetEffectInstanceId,
        gain: r.gain ?? 1,
        preFader: false,
        enabled: r.enabled !== false,
        status: 'ok',
      })
      bySource.set(r.sourceTrackId, list)
    }
    return [...bySource.entries()].map(([trackId, sidechainRoutes]) => ({
      trackId, outputRoute: { targetTrackId: -1 }, sidechainRoutes,
    }))
  }

  function seedGraph(store, gs) {
    store.setState({ fxModes: { [gs.trackId]: 'graph' }, graphStates: { [gs.trackId]: gs }, graphHistories: {} })
  }

  const validSource = () => true

  it('derives a route from the Sidechain Input source + sidechain edge and enables sc_external', async () => {
    const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
    seedGraph(useEffectChainStore, makeReconcileGraphState('7'))

    const res = await useEffectChainStore.getState().reconcileGraphSidechainRoutesForTrack('7', {
      isSourceTrackValid: validSource,
    })

    expect(res.ok).toBe(true)
    // sc_external enabled on the graph-owned compressor by stable effectInstanceId
    expect(audio.setGraphEffectParameterNormalized).toHaveBeenCalledWith(7, 'comp-inst', 'sc_external', 1)
    // route added: source from the Sidechain Input node, target the owning graph track + instance
    expect(timeline.addSidechainRoute).toHaveBeenCalledWith(3, {
      targetTrackId: 7,
      targetEffectInstanceId: 'comp-inst',
      gain: 1.0,
      preFader: false,
      enabled: true,
    })
    expect(res.status.targets['comp-inst']).toMatchObject({ status: 'ok' })
  })

  it('does not add a route when the Sidechain Input has no source', async () => {
    const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
    seedGraph(useEffectChainStore, makeReconcileGraphState('7', { source: null }))

    await useEffectChainStore.getState().reconcileGraphSidechainRoutesForTrack('7', { isSourceTrackValid: validSource })

    expect(timeline.addSidechainRoute).not.toHaveBeenCalled()
    expect(audio.setGraphEffectParameterNormalized).not.toHaveBeenCalledWith(7, 'comp-inst', 'sc_external', 1)
  })

  it('does not add a route for an unsupported target', async () => {
    const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
    seedGraph(useEffectChainStore, makeReconcileGraphState('7', {
      pluginId: 'unsupported.vst',
      sidechain: { supported: false, channels: 0, enabled: false },
    }))

    await useEffectChainStore.getState().reconcileGraphSidechainRoutesForTrack('7', { isSourceTrackValid: validSource })

    expect(timeline.addSidechainRoute).not.toHaveBeenCalled()
  })

  it('adds a route for a capability-supported VST target without sc_external writes', async () => {
    const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
    seedGraph(useEffectChainStore, makeReconcileGraphState('7', {
      pluginId: 'fabfilter.pro-c-2',
      effectInstanceId: 'vst-inst',
      sidechain: { supported: true, channels: 2, enabled: false },
    }))

    const res = await useEffectChainStore.getState().reconcileGraphSidechainRoutesForTrack('7', {
      isSourceTrackValid: validSource,
    })

    expect(res.ok).toBe(true)
    expect(audio.setGraphEffectParameterNormalized).not.toHaveBeenCalledWith(7, 'vst-inst', 'sc_external', 1)
    expect(timeline.addSidechainRoute).toHaveBeenCalledWith(3, {
      targetTrackId: 7,
      targetEffectInstanceId: 'vst-inst',
      gain: 1.0,
      preFader: false,
      enabled: true,
    })
  })

  it('does not add a route when the source track does not exist (stale source)', async () => {
    const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
    seedGraph(useEffectChainStore, makeReconcileGraphState('7'))

    const res = await useEffectChainStore.getState().reconcileGraphSidechainRoutesForTrack('7', {
      isSourceTrackValid: () => false,
    })

    expect(timeline.addSidechainRoute).not.toHaveBeenCalled()
    expect(res.status.sourceMissing).toBe(true)
    expect(res.status.targets['comp-inst']).toMatchObject({ status: 'source_missing' })
  })

  it('does not recreate a route that already exists (dedup)', async () => {
    const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
    seedGraph(useEffectChainStore, makeReconcileGraphState('7'))
    timeline.getRouting.mockResolvedValue(routingSnapshot([
      { routeId: 'r1', sourceTrackId: 3, targetTrackId: 7, targetEffectInstanceId: 'comp-inst' },
    ]))

    await useEffectChainStore.getState().reconcileGraphSidechainRoutesForTrack('7', { isSourceTrackValid: validSource })

    expect(timeline.addSidechainRoute).not.toHaveBeenCalled()
    expect(timeline.removeSidechainRoute).not.toHaveBeenCalled()
  })

  it('removes the route and disables sc_external when the sidechain edge is gone', async () => {
    const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
    seedGraph(useEffectChainStore, makeReconcileGraphState('7', { withEdge: false }))
    timeline.getRouting.mockResolvedValue(routingSnapshot([
      { routeId: 'r1', sourceTrackId: 3, targetTrackId: 7, targetEffectInstanceId: 'comp-inst' },
    ]))

    await useEffectChainStore.getState().reconcileGraphSidechainRoutesForTrack('7', { isSourceTrackValid: validSource })

    expect(timeline.removeSidechainRoute).toHaveBeenCalledWith(3, 'r1')
    expect(audio.setGraphEffectParameterNormalized).toHaveBeenCalledWith(7, 'comp-inst', 'sc_external', 0)
  })

  it('removes the route when the source is cleared', async () => {
    const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
    seedGraph(useEffectChainStore, makeReconcileGraphState('7', { source: null }))
    timeline.getRouting.mockResolvedValue(routingSnapshot([
      { routeId: 'r1', sourceTrackId: 3, targetTrackId: 7, targetEffectInstanceId: 'comp-inst' },
    ]))

    await useEffectChainStore.getState().reconcileGraphSidechainRoutesForTrack('7', { isSourceTrackValid: validSource })

    expect(timeline.removeSidechainRoute).toHaveBeenCalledWith(3, 'r1')
  })

  it('does not remove unrelated sidechain routes targeting other tracks', async () => {
    const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
    seedGraph(useEffectChainStore, makeReconcileGraphState('7'))
    // A route targeting a DIFFERENT track (9) must be left untouched.
    timeline.getRouting.mockResolvedValue(routingSnapshot([
      { routeId: 'r-other', sourceTrackId: 3, targetTrackId: 9, targetEffectInstanceId: 'other-inst' },
    ]))

    await useEffectChainStore.getState().reconcileGraphSidechainRoutesForTrack('7', { isSourceTrackValid: validSource })

    expect(timeline.removeSidechainRoute).not.toHaveBeenCalled()
    // and the desired route IS created
    expect(timeline.addSidechainRoute).toHaveBeenCalledWith(3, expect.objectContaining({ targetTrackId: 7 }))
  })

  it('re-keys when the source changes (remove old route, add new one)', async () => {
    const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
    seedGraph(useEffectChainStore, makeReconcileGraphState('7', { source: 4 }))
    timeline.getRouting.mockResolvedValue(routingSnapshot([
      { routeId: 'r1', sourceTrackId: 3, targetTrackId: 7, targetEffectInstanceId: 'comp-inst' },
    ]))

    await useEffectChainStore.getState().reconcileGraphSidechainRoutesForTrack('7', { isSourceTrackValid: validSource })

    expect(timeline.removeSidechainRoute).toHaveBeenCalledWith(3, 'r1')
    expect(timeline.addSidechainRoute).toHaveBeenCalledWith(4, expect.objectContaining({ targetEffectInstanceId: 'comp-inst' }))
  })

  it('surfaces a sc_external failure and does NOT add the route', async () => {
    const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
    seedGraph(useEffectChainStore, makeReconcileGraphState('7'))
    audio.setGraphEffectParameterNormalized.mockResolvedValue(JSON.stringify({ ok: false, reason: 'engine_error' }))

    const res = await useEffectChainStore.getState().reconcileGraphSidechainRoutesForTrack('7', { isSourceTrackValid: validSource })

    expect(res.ok).toBe(false)
    expect(timeline.addSidechainRoute).not.toHaveBeenCalled()
    expect(res.status.targets['comp-inst']).toMatchObject({ status: 'external_failed' })
  })

  it('surfaces a route add failure separately from sc_external', async () => {
    const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
    seedGraph(useEffectChainStore, makeReconcileGraphState('7'))
    timeline.addSidechainRoute.mockResolvedValue({ ok: false, reason: 'unknown_effect_instance' })

    const res = await useEffectChainStore.getState().reconcileGraphSidechainRoutesForTrack('7', { isSourceTrackValid: validSource })

    expect(res.ok).toBe(false)
    expect(audio.setGraphEffectParameterNormalized).toHaveBeenCalledWith(7, 'comp-inst', 'sc_external', 1)
    expect(res.status.targets['comp-inst']).toMatchObject({ status: 'route_failed' })
  })

  it('connectSidechainForTrack reconciles a route through to the timeline', async () => {
    const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
    // graph WITHOUT the edge yet; connecting it should add the route.
    seedGraph(useEffectChainStore, makeReconcileGraphState('7', { withEdge: false }))

    await useEffectChainStore.getState().connectSidechainForTrack('7', 'sc', 'fx-comp', {
      idFactory: () => 'sce-1',
      isSourceTrackValid: validSource,
    })

    expect(timeline.addSidechainRoute).toHaveBeenCalledWith(3, expect.objectContaining({ targetTrackId: 7, targetEffectInstanceId: 'comp-inst' }))
    expect(audio.setGraphEffectParameterNormalized).toHaveBeenCalledWith(7, 'comp-inst', 'sc_external', 1)
  })

  it('disconnectSidechainEdgeForTrack tears the route down through the timeline', async () => {
    const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
    seedGraph(useEffectChainStore, makeReconcileGraphState('7'))
    timeline.getRouting.mockResolvedValue(routingSnapshot([
      { routeId: 'r1', sourceTrackId: 3, targetTrackId: 7, targetEffectInstanceId: 'comp-inst' },
    ]))

    await useEffectChainStore.getState().disconnectSidechainEdgeForTrack('7', 'sce', { isSourceTrackValid: validSource })

    expect(timeline.removeSidechainRoute).toHaveBeenCalledWith(3, 'r1')
  })

  it('removing the graph compressor node tears down its orphaned route', async () => {
    const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
    const gs = makeReconcileGraphState('7')
    seedGraph(useEffectChainStore, gs)
    // Mark the compressor engine-backed so removeGraphNodeForTrack destroys it.
    useEffectChainStore.setState({ graphEngineNodeIds: { '7': { 'comp-inst': 500 } } })
    timeline.getRouting.mockResolvedValue(routingSnapshot([
      { routeId: 'r1', sourceTrackId: 3, targetTrackId: 7, targetEffectInstanceId: 'comp-inst' },
    ]))

    await useEffectChainStore.getState().removeGraphNodeForTrack('7', 'fx-comp', { isSourceTrackValid: validSource })

    expect(timeline.removeSidechainRoute).toHaveBeenCalledWith(3, 'r1')
  })

  it('does nothing (no throw) when the timeline routing API is unavailable', async () => {
    const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
    seedGraph(useEffectChainStore, makeReconcileGraphState('7'))
    delete timeline.getRouting

    const res = await useEffectChainStore.getState().reconcileGraphSidechainRoutesForTrack('7', { isSourceTrackValid: validSource })

    expect(res.ok).toBe(false)
    expect(res.reason).toBe('routing_unavailable')
    expect(timeline.addSidechainRoute).not.toHaveBeenCalled()
  })

  it('rejects reconciliation for master / chain-mode / missing graphState', async () => {
    const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
    await expect(useEffectChainStore.getState().reconcileGraphSidechainRoutesForTrack('master'))
      .resolves.toMatchObject({ ok: false, reason: 'master_track' })

    useEffectChainStore.setState({ fxModes: { '7': 'chain' }, graphStates: { '7': makeReconcileGraphState('7') } })
    await expect(useEffectChainStore.getState().reconcileGraphSidechainRoutesForTrack('7'))
      .resolves.toMatchObject({ ok: false, reason: 'not_graph_mode' })
  })

  it('hydration reconciles the persisted sidechain intent after graph effects exist', async () => {
    const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
    useEffectChainStore.setState({
      fxModes: { '7': 'graph' },
      graphStates: { '7': makeReconcileGraphState('7') },
      graphHistories: {},
    })

    await useEffectChainStore.getState().hydrateGraphEffectInstancesForLoadedProject({ isSourceTrackValid: validSource })

    expect(timeline.addSidechainRoute).toHaveBeenCalledWith(3, expect.objectContaining({ targetTrackId: 7, targetEffectInstanceId: 'comp-inst' }))
    expect(audio.setGraphEffectParameterNormalized).toHaveBeenCalledWith(7, 'comp-inst', 'sc_external', 1)
  })

  it('undo of a sidechain connect tears the route back down', async () => {
    const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
    seedGraph(useEffectChainStore, makeReconcileGraphState('7', { withEdge: false }))

    // Connect (records undo) — adds route.
    await useEffectChainStore.getState().connectSidechainForTrack('7', 'sc', 'fx-comp', {
      idFactory: () => 'sce-1', isSourceTrackValid: validSource,
    })
    // After connect the route exists; getRouting should now report it for the undo reconcile.
    timeline.getRouting.mockResolvedValue(routingSnapshot([
      { routeId: 'r-new', sourceTrackId: 3, targetTrackId: 7, targetEffectInstanceId: 'comp-inst' },
    ]))
    timeline.removeSidechainRoute.mockClear()

    await useEffectChainStore.getState().undoGraphEditForTrack('7', { isSourceTrackValid: validSource })

    expect(timeline.removeSidechainRoute).toHaveBeenCalledWith(3, 'r-new')
  })
})
