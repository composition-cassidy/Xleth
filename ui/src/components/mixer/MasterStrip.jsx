import { useCallback } from 'react'
import useMixerStore from '../../stores/mixerStore.js'
import VolumeFader from './VolumeFader.jsx'
import PeakMeter from './PeakMeter.jsx'
import EffectChainPanel from './EffectChainPanel.jsx'

export default function MasterStrip() {
  const masterVolume = useMixerStore(s => s.master.volume)
  const setMasterVolume = useMixerStore(s => s.setMasterVolume)

  const handleVolume = useCallback((gain) => setMasterVolume(gain), [setMasterVolume])

  return (
    <div className="mixer-strip mixer-strip--master">
      <div className="mixer-strip-label">MASTER</div>

      <EffectChainPanel master />

      <div className="mixer-strip-fader-area">
        <PeakMeter master />
        <VolumeFader value={masterVolume} onChange={handleVolume} />
      </div>
    </div>
  )
}
