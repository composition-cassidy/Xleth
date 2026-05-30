import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
    useEffectChainStore.setState({
      chains: { '7': baseChain },
      fxModes: { '7': 'graph' },
      graphStates: { '7': graphState },
      graphStateStatuses: { '7': { status: 'valid', graphState, warnings: [] } },
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

  it('clears the session engine node cache on project load', async () => {
    const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
    useEffectChainStore.setState({
      chains: { '7': [makeEffect(11, 'compressor', 0)] },
      graphEngineNodeIds: { '7': { 'effect-1': 210 } },
      graphRuntimeStatuses: { '7': { ok: true, reason: 'graph_routing_active' } },
    })

    projectLoadedHandler()
    await Promise.resolve()
    await Promise.resolve()

    expect(useEffectChainStore.getState().graphEngineNodeIds).toEqual({})
    expect(useEffectChainStore.getState().graphRuntimeStatuses).toEqual({})
  })
})
