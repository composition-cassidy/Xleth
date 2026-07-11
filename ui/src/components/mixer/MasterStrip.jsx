import { useCallback } from 'react'
import useMixerStore from '../../stores/mixerStore.js'
import VolumeFader, { FaderReadout } from './VolumeFader.jsx'
import PeakMeter from './PeakMeter.jsx'
import useEffectChainStore, { resolveFxMode } from '../../stores/effectChainStore.js'

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

  const handleVolume = useCallback((gain) => setMasterVolume(gain), [setMasterVolume])
  const handleSelectMaster = useCallback(() => setSelectedChainKey(MASTER_FX_KEY), [setSelectedChainKey])
  const selected = selectedChainKey === MASTER_FX_KEY

  return (
    <div
      className={`mixer-strip mixer-strip--master ${selected ? 'mixer-strip--selected' : ''}`}
      onClick={handleSelectMaster}
      aria-selected={selected}
    >
      <div className="mixer-strip-label">MASTER</div>

      <FxBadge chain={chain} fxMode={fxMode} />

      <div className="mixer-strip-bottom">
        <div className="mixer-meter-fader-col">
          <FaderReadout value={masterVolume} onChange={handleVolume} />
          <div className="mixer-strip-fader-area">
            <PeakMeter master />
            <VolumeFader value={masterVolume} onChange={handleVolume} />
          </div>
        </div>
      </div>
    </div>
  )
}
