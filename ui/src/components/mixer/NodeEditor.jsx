import { useCallback, useEffect, useMemo, useRef, useState, memo } from 'react'
import {
  ReactFlow,
  Background,
  useNodesState,
  useEdgesState,
  Handle,
  Position,
  MarkerType,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import useNodeGraphStore from '../../stores/nodeGraphStore.js'
import { tokenValue } from '../../theming/tokenValue.ts'
import TrackContextMenu from '../timeline/TrackContextMenu.jsx'
import ContextMenu from '../ContextMenu.jsx'

// ── Plugin display names ────────────────────────────────────────────────────

const PLUGIN_NAMES = {
  testgain: 'Test Gain', compressor: 'Compressor', limiter: 'Limiter',
  overdone: 'Overdone', transientproc: 'Transient Proc', xletheq: 'Xleth EQ',
  xlethfilter: 'Xleth Filter', distortion: 'Distortion', waveshaper: 'Waveshaper',
  uniflange: 'UniFlange', chorus: 'Chorus', flanger: 'Flanger', phaser: 'Phaser',
  phanjer: 'Phanjer', delay: 'Delay', reverb: 'Reverb', smartbalance: 'Smart Balance',
  resonancesuppressor: 'Resonance Suppressor',
}

const EFFECT_CATEGORIES = [
  { label: 'Dynamics', submenu: [
    { label: 'Compressor', id: 'compressor' }, { label: 'Limiter', id: 'limiter' },
    { label: 'Overdone', id: 'overdone' }, { label: 'Transient Proc', id: 'transientproc' },
    { label: 'Resonance Suppressor', id: 'resonancesuppressor' },
  ]},
  { label: 'EQ & Filter', submenu: [
    { label: 'Xleth EQ', id: 'xletheq' }, { label: 'Xleth Filter', id: 'xlethfilter' },
  ]},
  { label: 'Distortion', submenu: [
    { label: 'Distortion', id: 'distortion' }, { label: 'Waveshaper', id: 'waveshaper' },
  ]},
  { label: 'Modulation', submenu: [
    { label: 'UniFlange', id: 'uniflange' }, { label: 'Chorus', id: 'chorus' },
    { label: 'Flanger', id: 'flanger' }, { label: 'Phaser', id: 'phaser' },
    { label: 'Phanjer', id: 'phanjer' },
  ]},
  { label: 'Time', submenu: [
    { label: 'Delay', id: 'delay' }, { label: 'Reverb', id: 'reverb' },
  ]},
  { label: 'Utility', submenu: [
    { label: 'Smart Balance', id: 'smartbalance' },
  ]},
]

// ── Custom Nodes ────────────────────────────────────────────────────────────

const AudioInputNode = memo(({ data }) => (
  <div className="ne-node ne-node--io ne-node--input">
    <div className="ne-node-label">Audio In</div>
    <Handle type="source" position={Position.Right} className="ne-handle ne-handle--source" />
  </div>
))
AudioInputNode.displayName = 'AudioInputNode'

const AudioOutputNode = memo(({ data }) => (
  <div className="ne-node ne-node--io ne-node--output">
    <div className="ne-node-label">Audio Out</div>
    <Handle type="target" position={Position.Left} className="ne-handle ne-handle--target" />
  </div>
))
AudioOutputNode.displayName = 'AudioOutputNode'

const EffectNode = memo(({ data }) => {
  const displayName = PLUGIN_NAMES[data.pluginId] ?? data.pluginId
  return (
    <div className={`ne-node ne-node--effect${data.bypassed ? ' ne-node--bypassed' : ''}`}>
      <Handle type="target" position={Position.Left} className="ne-handle ne-handle--target" />
      <div className="ne-node-body">
        <div className="ne-node-name" title={displayName}>{displayName}</div>
        <button
          className={`ne-node-bypass${data.bypassed ? ' active' : ''}`}
          onClick={(e) => { e.stopPropagation(); data.onBypass?.() }}
          title={data.bypassed ? 'Enable' : 'Bypass'}
        >
          {data.bypassed ? 'OFF' : 'ON'}
        </button>
      </div>
      <Handle type="source" position={Position.Right} className="ne-handle ne-handle--source" />
    </div>
  )
})
EffectNode.displayName = 'EffectNode'

const nodeTypes = { audioInput: AudioInputNode, audioOutput: AudioOutputNode, effect: EffectNode }

// ── Main Component ──────────────────────────────────────────────────────────

export default function NodeEditor({ storeKey }) {
  const fetchTopology = useNodeGraphStore(s => s.fetchTopology)
  const graphData = useNodeGraphStore(s => s.graphs[storeKey])
  const addConnection = useNodeGraphStore(s => s.addConnection)
  const removeConnection = useNodeGraphStore(s => s.removeConnection)
  const setWireGain = useNodeGraphStore(s => s.setWireGain)
  const setWireMute = useNodeGraphStore(s => s.setWireMute)
  const setNodePosition = useNodeGraphStore(s => s.setNodePosition)
  const deleteNode = useNodeGraphStore(s => s.deleteNode)
  const addEffect = useNodeGraphStore(s => s.addEffect)
  const setBypass = useNodeGraphStore(s => s.setBypass)
  const toast = useNodeGraphStore(s => s.toast)

  const [nodes, setNodes, onNodesChange] = useNodesState([])
  const [edges, setEdges, onEdgesChange] = useEdgesState([])
  const [canvasMenu, setCanvasMenu] = useState(null)
  const [edgeMenu, setEdgeMenu] = useState(null)
  const [gainEditor, setGainEditor] = useState(null)
  const reactFlowRef = useRef(null)

  // Fetch on mount
  useEffect(() => { fetchTopology(storeKey) }, [storeKey, fetchTopology])

  // Convert topology → React Flow nodes/edges
  useEffect(() => {
    if (!graphData) return

    const topoNodes = graphData.nodes ?? []
    const topoConns = graphData.connections ?? []

    // Find I/O node IDs
    const inputNode = topoNodes.find(n => n.pluginId === '__input__')
    const outputNode = topoNodes.find(n => n.pluginId === '__output__')
    const effectNodes = topoNodes.filter(n => n.pluginId !== '__input__' && n.pluginId !== '__output__')

    const rfNodes = []

    if (inputNode) {
      rfNodes.push({
        id: String(inputNode.nodeId),
        type: 'audioInput',
        position: { x: inputNode.x || 50, y: inputNode.y || 200 },
        data: {},
        draggable: false,
      })
    }

    if (outputNode) {
      rfNodes.push({
        id: String(outputNode.nodeId),
        type: 'audioOutput',
        position: { x: outputNode.x || 600, y: outputNode.y || 200 },
        data: {},
        draggable: false,
      })
    }

    effectNodes.forEach((n, i) => {
      rfNodes.push({
        id: String(n.nodeId),
        type: 'effect',
        position: {
          x: n.x || 200 + i * 160,
          y: n.y || 150 + (i % 3) * 80,
        },
        data: {
          pluginId: n.pluginId,
          bypassed: n.bypassed,
          onBypass: () => setBypass(storeKey, n.nodeId, !n.bypassed),
        },
      })
    })

    const rfEdges = topoConns.map(c => ({
      id: `e-${c.source}-${c.dest}`,
      source: String(c.source),
      target: String(c.dest),
      data: { gain: c.gain, muted: c.muted, srcId: c.source, dstId: c.dest },
      style: c.muted
        ? { stroke: tokenValue('--theme-nodeeditor-port-default'), strokeWidth: 2, strokeDasharray: '6 4' }
        : { stroke: tokenValue('--theme-nodeeditor-connection-cv'), strokeWidth: 2 },
      markerEnd: { type: MarkerType.ArrowClosed, color: c.muted ? tokenValue('--theme-nodeeditor-port-default') : tokenValue('--theme-nodeeditor-connection-cv'), width: 12, height: 12 },
      interactionWidth: 20,
    }))

    setNodes(rfNodes)
    setEdges(rfEdges)
  }, [graphData, storeKey, setBypass, setNodes, setEdges])

  // Connect handler
  const onConnect = useCallback(async (params) => {
    await addConnection(storeKey, Number(params.source), Number(params.target))
  }, [storeKey, addConnection])

  // Node drag stop → persist position
  const onNodeDragStop = useCallback((e, node) => {
    setNodePosition(storeKey, Number(node.id), node.position.x, node.position.y)
  }, [storeKey, setNodePosition])

  // Right-click canvas → Add Effect menu
  const onPaneContextMenu = useCallback((e) => {
    e.preventDefault()
    setCanvasMenu({ x: e.clientX, y: e.clientY })
  }, [])

  // Right-click edge → Mute/Delete menu
  const onEdgeContextMenu = useCallback((e, edge) => {
    e.preventDefault()
    setEdgeMenu({
      x: e.clientX, y: e.clientY,
      srcId: edge.data.srcId, dstId: edge.data.dstId,
      muted: edge.data.muted,
    })
  }, [])

  // Click edge → gain slider
  const onEdgeClick = useCallback((e, edge) => {
    setGainEditor({
      x: e.clientX, y: e.clientY,
      srcId: edge.data.srcId, dstId: edge.data.dstId,
      gain: edge.data.gain ?? 1.0,
    })
  }, [])

  // Right-click node → Delete (effect nodes only)
  const onNodeContextMenu = useCallback((e, node) => {
    if (node.type !== 'effect') return
    e.preventDefault()
    setCanvasMenu(null)
    setEdgeMenu({
      x: e.clientX, y: e.clientY,
      nodeId: Number(node.id),
      isNode: true,
    })
  }, [])

  // Build "Add Effect" menu items
  const addMenuItems = useMemo(() => {
    return EFFECT_CATEGORIES.map(cat => ({
      label: cat.label,
      submenu: cat.submenu.map(fx => ({
        label: fx.label,
        onClick: () => addEffect(storeKey, fx.id),
      })),
    }))
  }, [storeKey, addEffect])

  // Edge context menu items
  const edgeMenuItems = useMemo(() => {
    if (!edgeMenu) return []
    if (edgeMenu.isNode) {
      return [{ label: 'Delete Effect', danger: true, onClick: () => deleteNode(storeKey, edgeMenu.nodeId) }]
    }
    return [
      {
        label: edgeMenu.muted ? 'Unmute Wire' : 'Mute Wire',
        onClick: () => setWireMute(storeKey, edgeMenu.srcId, edgeMenu.dstId, !edgeMenu.muted),
      },
      {
        label: 'Delete Wire', danger: true,
        onClick: () => removeConnection(storeKey, edgeMenu.srcId, edgeMenu.dstId),
      },
    ]
  }, [edgeMenu, storeKey, setWireMute, removeConnection, deleteNode])

  // Gain slider change
  const handleGainChange = useCallback((e) => {
    const val = Number(e.target.value) / 100
    setGainEditor(prev => prev ? { ...prev, gain: val } : null)
    if (gainEditor) {
      setWireGain(storeKey, gainEditor.srcId, gainEditor.dstId, val)
    }
  }, [gainEditor, storeKey, setWireGain])

  // Close gain editor on outside click
  useEffect(() => {
    if (!gainEditor) return
    const handler = (e) => {
      if (e.target.closest('.ne-gain-popup')) return
      setGainEditor(null)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [gainEditor])

  return (
    <div className="ne-container" ref={reactFlowRef}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeDragStop={onNodeDragStop}
        onPaneContextMenu={onPaneContextMenu}
        onEdgeContextMenu={onEdgeContextMenu}
        onEdgeClick={onEdgeClick}
        onNodeContextMenu={onNodeContextMenu}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.3 }}
        minZoom={0.3}
        maxZoom={2}
        snapToGrid
        snapGrid={[10, 10]}
        deleteKeyCode={null}
        proOptions={{ hideAttribution: true }}
        defaultEdgeOptions={{
          style: { stroke: tokenValue('--theme-nodeeditor-connection-cv'), strokeWidth: 2 },
          markerEnd: { type: MarkerType.ArrowClosed, color: tokenValue('--theme-nodeeditor-connection-cv'), width: 12, height: 12 },
        }}
      >
        <Background color={tokenValue('--theme-border-subtle')} gap={20} size={1} />
      </ReactFlow>

      {/* Toast */}
      {toast && (
        <div className={`ne-toast ne-toast--${toast.type}`}>
          {toast.msg}
        </div>
      )}

      {/* Canvas context menu (Add Effect) */}
      {canvasMenu && (
        <TrackContextMenu
          x={canvasMenu.x}
          y={canvasMenu.y}
          items={addMenuItems}
          onClose={() => setCanvasMenu(null)}
        />
      )}

      {/* Edge / Node context menu */}
      {edgeMenu && (
        <ContextMenu
          x={edgeMenu.x}
          y={edgeMenu.y}
          items={edgeMenuItems}
          onClose={() => setEdgeMenu(null)}
        />
      )}

      {/* Gain slider popup */}
      {gainEditor && (
        <div
          className="ne-gain-popup"
          style={{ left: gainEditor.x - 80, top: gainEditor.y - 50 }}
        >
          <div className="ne-gain-label">
            Gain: {Math.round(gainEditor.gain * 100)}%
          </div>
          <input
            type="range"
            min={0}
            max={200}
            value={Math.round(gainEditor.gain * 100)}
            onChange={handleGainChange}
            className="ne-gain-slider"
          />
        </div>
      )}
    </div>
  )
}
