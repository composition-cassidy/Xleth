import { useCallback } from 'react'
import useMixerStore from '../../stores/mixerStore.js'
import VolumeFader, { FaderReadout } from './VolumeFader.jsx'
import PeakMeter from './PeakMeter.jsx'
import EffectChainPanel from './EffectChainPanel.jsx'

export default function MasterStrip() {
  const masterVolume = useMixerStore(s => s.master.volume)
  const setMasterVolume = useMixerStore(s => s.setMasterVolume)
  const selectedChainKey = useMixerStore(s => s.selectedChainKey)
  const setSelectedChainKey = useMixerStore(s => s.setSelectedChainKey)

  const handleVolume = useCallback((gain) => setMasterVolume(gain), [setMasterVolume])
  const handleSelectMaster = useCallback(() => setSelectedChainKey('master'), [setSelectedChainKey])
  const selected = selectedChainKey === 'master'

  return (
    <div
      className={`mixer-strip mixer-strip--master ${selected ? 'mixer-strip--selected' : ''}`}
      onClick={handleSelectMaster}
      aria-selected={selected}
    >
      <div className="mixer-strip-label">MASTER</div>

      <EffectChainPanel master mode="preview" />

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
