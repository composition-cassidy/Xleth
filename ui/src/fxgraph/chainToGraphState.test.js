import { describe, expect, it } from 'vitest'
import { validateGraphState } from './graphState.js'
import { createGraphStateFromChain } from './chainToGraphState.js'

const UUIDS = [
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000002',
  '00000000-0000-4000-8000-000000000003',
  '00000000-0000-4000-8000-000000000004',
  '00000000-0000-4000-8000-000000000005',
  '00000000-0000-4000-8000-000000000006',
  '00000000-0000-4000-8000-000000000007',
  '00000000-0000-4000-8000-000000000008',
  '00000000-0000-4000-8000-000000000009',
  '00000000-0000-4000-8000-00000000000a',
  '00000000-0000-4000-8000-00000000000b',
  '00000000-0000-4000-8000-00000000000c',
  '00000000-0000-4000-8000-00000000000d',
  '00000000-0000-4000-8000-00000000000e',
  '00000000-0000-4000-8000-00000000000f',
  '00000000-0000-4000-8000-000000000010',
]

function makeIdFactory() {
  let index = 0
  return () => UUIDS[index++]
}

function validateConverted(graphState, trackId = '7') {
  const result = validateGraphState(graphState, trackId)
  expect(result.status).toBe('valid')
  return result.graphState
}

describe('createGraphStateFromChain', () => {
  it('converts an empty chain to Track Input directly connected to Track Output', () => {
    const graphState = createGraphStateFromChain({
      trackId: 7,
      effects: [],
      idFactory: makeIdFactory(),
    })
    const validGraphState = validateConverted(graphState)

    expect(validGraphState.nodes.map((node) => node.type)).toEqual(['trackInput', 'trackOutput'])
    expect(validGraphState.edges).toEqual([
      {
        id: UUIDS[2],
        sourceNodeId: UUIDS[0],
        sourcePort: 'audio',
        targetNodeId: UUIDS[1],
        targetPort: 'audio',
        type: 'audio',
      },
    ])
    expect(validGraphState.viewport).toEqual({ x: 0, y: 0, zoom: 1 })
  })

  it('converts one chain effect to a three-node valid graphState in order', () => {
    const graphState = createGraphStateFromChain({
      trackId: '7',
      effects: [{ nodeId: 11, pluginId: 'compressor', position: 0 }],
      idFactory: makeIdFactory(),
    })
    const validGraphState = validateConverted(graphState)

    expect(validGraphState.nodes).toHaveLength(3)
    expect(validGraphState.edges).toHaveLength(2)
    expect(validGraphState.nodes.map((node) => node.type)).toEqual(['trackInput', 'effect', 'trackOutput'])
    expect(validGraphState.nodes[1].data).toMatchObject({
      pluginId: 'compressor',
      displayName: 'Compressor',
      sourceChainSlotIndex: 0,
    })
    expect(validGraphState.edges.map((edge) => [edge.sourceNodeId, edge.targetNodeId])).toEqual([
      [validGraphState.nodes[0].id, validGraphState.nodes[1].id],
      [validGraphState.nodes[1].id, validGraphState.nodes[2].id],
    ])
  })

  it('converts three chain effects to linear nodes and preserves source slot indexes', () => {
    const graphState = createGraphStateFromChain({
      trackId: 7,
      effects: [
        { nodeId: 11, pluginId: 'xletheq', position: 0 },
        { nodeId: 12, pluginId: 'delay', position: 1 },
        { nodeId: 13, pluginId: 'reverb', position: 2 },
      ],
      idFactory: makeIdFactory(),
    })
    const validGraphState = validateConverted(graphState)
    const effectNodes = validGraphState.nodes.filter((node) => node.type === 'effect')

    expect(validGraphState.nodes).toHaveLength(5)
    expect(validGraphState.edges).toHaveLength(4)
    expect(effectNodes.map((node) => node.data.sourceChainSlotIndex)).toEqual([0, 1, 2])
    expect(effectNodes.map((node) => node.data.pluginId)).toEqual(['xletheq', 'delay', 'reverb'])
  })

  it('maps bypassed, missing, and crashed chain status flags', () => {
    const graphState = createGraphStateFromChain({
      trackId: 7,
      effects: [
        { pluginId: 'delay', bypassed: true },
        { pluginId: 'missing.vst3', missing: true },
        { pluginId: 'crashed.vst3', crashed: true },
      ],
      idFactory: makeIdFactory(),
    })
    const effectData = validateConverted(graphState).nodes
      .filter((node) => node.type === 'effect')
      .map((node) => node.data)

    expect(effectData[0]).toMatchObject({ bypass: true, missing: false, crashed: false })
    expect(effectData[1]).toMatchObject({ bypass: false, missing: true, crashed: false })
    expect(effectData[2]).toMatchObject({ bypass: false, missing: false, crashed: true })
  })

  it('creates non-overlapping horizontal positions with input left and output right', () => {
    const graphState = createGraphStateFromChain({
      trackId: 7,
      effects: [
        { pluginId: 'compressor' },
        { pluginId: 'delay' },
      ],
      idFactory: makeIdFactory(),
    })
    const positions = validateConverted(graphState).nodes.map((node) => node.position)

    expect(positions.map((position) => position.y)).toEqual([0, 0, 0, 0])
    expect(positions.map((position) => position.x)).toEqual([0, 260, 520, 780])
  })

  it('generates unique UUID-style node, edge, and effect instance IDs', () => {
    const graphState = createGraphStateFromChain({
      trackId: 7,
      effects: [
        { pluginId: 'compressor' },
        { pluginId: 'delay' },
      ],
      idFactory: makeIdFactory(),
    })
    const ids = [
      ...graphState.nodes.map((node) => node.id),
      ...graphState.edges.map((edge) => edge.id),
      ...graphState.nodes
        .filter((node) => node.type === 'effect')
        .map((node) => node.data.effectInstanceId),
    ]

    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.every((id) => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))).toBe(true)
  })

  it('does not mutate the input chain array or effect objects', () => {
    const effects = [
      { nodeId: 11, pluginId: 'compressor', position: 0, bypassed: true },
      { nodeId: 12, pluginId: 'delay', position: 1 },
    ]
    const before = JSON.stringify(effects)

    createGraphStateFromChain({
      trackId: 7,
      effects,
      idFactory: makeIdFactory(),
    })

    expect(JSON.stringify(effects)).toBe(before)
  })
})
