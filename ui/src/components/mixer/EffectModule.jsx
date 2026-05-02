import { useState } from 'react'
import { GripVertical, Power } from 'lucide-react'
import useEffectChainStore from '../../stores/effectChainStore.js'
import useVstStore from '../../stores/vstStore.js'
import useEqStore from '../../stores/eqStore.js'
import useCompressorStore from '../../stores/compressorStore.js'
import useLimiterStore from '../../stores/limiterStore.js'
import useDistortionStore from '../../stores/distortionStore.js'
import useWaveshaperStore from '../../stores/waveshaperStore.js'
import useDelayStore from '../../stores/delayStore.js'
import useChorusStore from '../../stores/chorusStore.js'
import useFlangerStore from '../../stores/flangerStore.js'
import usePhaserStore from '../../stores/phaserStore.js'
import useOverdoneStore from '../../stores/overdoneStore.js'
import useReverbStore from '../../stores/reverbStore.js'
import useTransientProcStore from '../../stores/transientProcStore.js'
import useSmartBalanceStore from '../../stores/smartBalanceStore.js'
import useResonanceSuppressorStore from '../../stores/resonanceSuppressorStore.js'
import ContextMenu from '../ContextMenu.jsx'

// Registry: pluginId → opener(trackId, nodeId, storeKey)
// Add one entry per effect that has a dedicated editor panel.
const EFFECT_EDITORS = {
  xletheq: (trackId, nodeId, storeKey) => {
    useEqStore.getState().open(trackId, nodeId, storeKey)
  },
  compressor: (trackId, nodeId, storeKey) => {
    useCompressorStore.getState().open(trackId, nodeId, storeKey)
  },
  distortion: (trackId, nodeId, storeKey) => {
    useDistortionStore.getState().open(trackId, nodeId, storeKey)
  },
  waveshaper: (trackId, nodeId, storeKey) => {
    useWaveshaperStore.getState().open(trackId, nodeId, storeKey)
  },
  delay: (trackId, nodeId, storeKey) => {
    useDelayStore.getState().open(trackId, nodeId, storeKey)
  },
  chorus: (trackId, nodeId, storeKey) => {
    useChorusStore.getState().open(trackId, nodeId, storeKey)
  },
  flanger: (trackId, nodeId, storeKey) => {
    useFlangerStore.getState().open(trackId, nodeId, storeKey)
  },
  phaser: (trackId, nodeId, storeKey) => {
    usePhaserStore.getState().open(trackId, nodeId, storeKey)
  },
  overdone: (trackId, nodeId, storeKey) => {
    useOverdoneStore.getState().open(trackId, nodeId, storeKey)
  },
  reverb: (trackId, nodeId, storeKey) => {
    useReverbStore.getState().open(trackId, nodeId, storeKey)
  },
  limiter: (trackId, nodeId, storeKey) => {
    useLimiterStore.getState().open(trackId, nodeId, storeKey)
  },
  transientproc: (trackId, nodeId, storeKey) => {
    useTransientProcStore.getState().open(trackId, nodeId, storeKey)
  },
  smartbalance: (trackId, nodeId, storeKey) => {
    useSmartBalanceStore.getState().open(trackId, nodeId, storeKey)
  },
  resonancesuppressor: (trackId, nodeId, storeKey) => {
    useResonanceSuppressorStore.getState().open(trackId, nodeId, storeKey)
  },
}

const PLUGIN_NAMES = {
  testgain:     'Test Gain',
  compressor:   'Compressor',
  limiter:      'Limiter',
  overdone:     'Overdone',
  transientproc:'Transient Proc',
  xletheq:      'Xleth EQ',
  xlethfilter:  'Xleth Filter',
  distortion:   'Distortion',
  waveshaper:   'Waveshaper',
  uniflange:    'UniFlange',
  chorus:       'Chorus',
  flanger:      'Flanger',
  phaser:       'Phaser',
  phanjer:      'Phanjer',
  delay:        'Delay',
  reverb:               'Reverb',
  smartbalance:         'Smart Balance',
  resonancesuppressor:  'Resonance Suppressor',
}

export default function EffectModule({ effect, index, storeKey, onDragStart, onDragOver }) {
  const [deleteMenu, setDeleteMenu] = useState(null)
  const setBypass = useEffectChainStore(s => s.setBypass)
  const removeEffect = useEffectChainStore(s => s.removeEffect)
  const vstPlugins = useVstStore(s => s.plugins)

  const isPending   = effect.nodeId === -1
  const isVst       = !(effect.pluginId in PLUGIN_NAMES)
  const stockName   = PLUGIN_NAMES[effect.pluginId]
  const vstMeta     = isVst ? vstPlugins.find(p => p.id === effect.pluginId) : null
  const displayName = stockName ?? vstMeta?.name ?? effect.pluginId
  const vendor      = vstMeta?.vendor ?? null

  const handleBypassClick = (e) => {
    e.stopPropagation()
    if (isPending) return
    setBypass(storeKey, effect.nodeId, !effect.bypassed)
  }

  const handleContextMenu = (e) => {
    e.preventDefault()
    if (isPending) return
    setDeleteMenu({ x: e.clientX, y: e.clientY })
  }

  const handleNameClick = () => {
    if (isPending) return
    const opener = EFFECT_EDITORS[effect.pluginId]
    if (opener) {
      const trackId = storeKey === 'master' ? -1 : Number(storeKey)
      opener(trackId, effect.nodeId, storeKey)
    }
  }

  const handleVstEdit = (e) => {
    e.stopPropagation()
    if (isPending) return
    const trackId = storeKey === 'master' ? -1 : Number(storeKey)
    window.xleth?.audio?.openPluginEditor?.(trackId, effect.nodeId)
  }

  const handleGripMouseDown = (e) => {
    if (isPending) return
    e.preventDefault()
    onDragStart(effect.nodeId, index, e)
  }

  const handleMouseEnter = () => {
    onDragOver(index)
  }

  return (
    <div
      className={`effect-module${effect.bypassed ? ' effect-module--bypassed' : ''}${isPending ? ' effect-module--pending' : ''}`}
      onMouseEnter={handleMouseEnter}
      onContextMenu={handleContextMenu}
    >
      <div
        className="effect-module-grip"
        onMouseDown={handleGripMouseDown}
        title="Drag to reorder"
      >
        <GripVertical size={10} />
      </div>

      <div
        className="effect-module-name"
        title={displayName + (vendor ? ' — ' + vendor : '')}
        onClick={handleNameClick}
        style={EFFECT_EDITORS[effect.pluginId] ? { cursor: 'pointer' } : undefined}
      >
        <span className="effect-module-name-text">{displayName}</span>
        {vendor && <span className="effect-module-vendor">{vendor}</span>}
        {effect.crashed && <span className="effect-module-crashed">CRASHED</span>}
      </div>

      {isVst && !isPending && (
        <button
          className="effect-module-edit"
          onClick={handleVstEdit}
          title="Open plugin editor"
        >
          Edit
        </button>
      )}

      <button
        className={`effect-module-bypass${effect.bypassed ? ' bypassed' : ''}`}
        onClick={handleBypassClick}
        title={effect.bypassed ? 'Enable' : 'Bypass'}
      >
        <Power size={10} />
      </button>

      {deleteMenu && (
        <ContextMenu
          x={deleteMenu.x}
          y={deleteMenu.y}
          items={[{ label: 'Delete', danger: true, onClick: () => removeEffect(storeKey, effect.nodeId) }]}
          onClose={() => setDeleteMenu(null)}
        />
      )}
    </div>
  )
}
