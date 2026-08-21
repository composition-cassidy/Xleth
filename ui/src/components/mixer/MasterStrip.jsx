import { useCallback, useState } from 'react'
import useMixerStore from '../../stores/mixerStore.js'
import { FaderReadout } from './VolumeFader.jsx'
import Fader, { linearToPos, gainFromPos } from '../controls/Fader.jsx'
import PeakMeter from './PeakMeter.jsx'
import useEffectChainStore, { resolveFxMode } from '../../stores/effectChainStore.js'
import useFxChainDragStore from '../../stores/fxChainDragStore.js'

const EMPTY_CHAIN = []
const MASTER_FX_KEY = 'master'

function FxBadge({ chain = EMPTY_CHAIN, fxMode = 'chain' }) {
  const graphModeActive = fxMode === 'graph'
  const empty = chain.length === 0
  const label = graphModeActive ? 'FX Graph' : empty ? 'No FX' : `FX ${chain.length}`

  return (
    <div
      className={`mixer-strip-fx-badge${graphModeActive ? ' mixer-strip-fx-badge--graph' : ''}${empty && !graphModeActive ? ' mixer-strip-fx-badge--empty' : ''}`}
      title={label}
    >
      {graphModeActive && <span className="mixer-strip-fx-badge-dot" aria-hidden="true" />}
      <span className="mixer-strip-fx-badge-text">{label}</span>
    </div>
  )
}

export default function MasterStrip() {
  const masterVolume = useMixerStore(s => s.master.volume)
  const setMasterVolume = useMixerStore(s => s.setMasterVolume)
  const selectedChainKey = useMixerStore(s => s.selectedChainKey)
  const setSelectedChainKey = useMixerStore(s => s.setSelectedChainKey)
  const chain = useEffectChainStore(s => s.chains[MASTER_FX_KEY] ?? EMPTY_CHAIN)
  const fxMode = useEffectChainStore(s => resolveFxMode(s.fxModes, MASTER_FX_KEY))

  // Master has a chain like any other strip, so it gets the same FX Chain
  // Library menu and is a legal drag-drop target.
  const openFxChainMenu = useFxChainDragStore(s => s.openMenu)
  const dragActive = useFxChainDragStore(s => s.effects != null)
  const dragSourceKey = useFxChainDragStore(s => s.sourceKey)
  const dragHoverKey = useFxChainDragStore(s => s.hoverKey)
  const isDragSource = dragActive && dragSourceKey === MASTER_FX_KEY
  const isDropTarget = dragActive && !isDragSource
  const isDropHover = isDropTarget && dragHoverKey === MASTER_FX_KEY

  // Live drag frames stay local (never cross the bridge); the store — and
  // the IPC call inside setMasterVolume — is only touched once, on commit.
  const [liveVolume, setLiveVolume] = useState(null)
  const handleVolumeLive = useCallback((gain) => setLiveVolume(gain), [])
  const handleVolumeCommit = useCallback((gain) => {
    setLiveVolume(null)
    setMasterVolume(gain)
  }, [setMasterVolume])
  const displayVolume = liveVolume != null ? liveVolume : masterVolume
  const handleSelectMaster = useCallback(() => setSelectedChainKey(MASTER_FX_KEY), [setSelectedChainKey])
  const selected = selectedChainKey === MASTER_FX_KEY

  const handleContextMenu = useCallback((e) => {
    e.preventDefault()
    e.stopPropagation()
    openFxChainMenu(MASTER_FX_KEY, e.clientX, e.clientY)
  }, [openFxChainMenu])

  return (
    <div
      className={`mixer-strip mixer-strip--master ${selected ? 'mixer-strip--selected' : ''}${isDropTarget ? ' mixer-strip--fx-droptarget' : ''}${isDropHover ? ' mixer-strip--fx-drophover' : ''}${isDragSource ? ' mixer-strip--fx-dragsource' : ''}`}
      onClick={handleSelectMaster}
      onContextMenu={handleContextMenu}
      data-fx-key={MASTER_FX_KEY}
      aria-selected={selected}
    >
      <div className="mixer-strip-label">MASTER</div>

      <FxBadge chain={chain} fxMode={fxMode} />

      <div className="mixer-strip-bottom">
        <div className="mixer-meter-fader-col">
          <FaderReadout value={displayVolume} onChange={handleVolumeCommit} />
          <div className="mixer-strip-fader-area">
            <PeakMeter master />
            <Fader
              orientation="vertical"
              value={masterVolume}
              toNorm={linearToPos}
              fromNorm={gainFromPos}
              defaultValue={1.0}
              detents={[1.0]}
              fill
              thickness={22}
              onLiveChange={handleVolumeLive}
              onCommit={handleVolumeCommit}
            />
          </div>
        </div>
      </div>
    </div>
  )
}
