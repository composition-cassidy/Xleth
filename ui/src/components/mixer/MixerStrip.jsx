import { useCallback } from 'react'
import useMixerStore from '../../stores/mixerStore.js'
import Knob from '../sampler/Knob.jsx'
import VolumeFader from './VolumeFader.jsx'
import PeakMeter from './PeakMeter.jsx'
import EffectChainPanel from './EffectChainPanel.jsx'

function formatPan(v) {
  if (Math.abs(v) < 0.05) return 'C'
  return v > 0 ? `${Math.round(v * 100)}R` : `${Math.round(-v * 100)}L`
}

function formatSpread(v) {
  return `${Math.round(v * 100)}%`
}

export default function MixerStrip({ trackId }) {
  const track = useMixerStore(s => s.tracks[trackId])
  const setVolume = useMixerStore(s => s.setVolume)
  const setPan = useMixerStore(s => s.setPan)
  const setSpread = useMixerStore(s => s.setSpread)
  const toggleMute = useMixerStore(s => s.toggleMute)
  const toggleSolo = useMixerStore(s => s.toggleSolo)
  const toggleVisualOnly = useMixerStore(s => s.toggleVisualOnly)

  const handleVolume = useCallback((gain) => setVolume(trackId, gain), [trackId, setVolume])
  const handlePanLive = useCallback((v) => setPan(trackId, v), [trackId, setPan])
  const handlePanCommit = useCallback((v) => setPan(trackId, v), [trackId, setPan])
  const handleSpreadLive = useCallback((v) => setSpread(trackId, v), [trackId, setSpread])
  const handleSpreadCommit = useCallback((v) => setSpread(trackId, v), [trackId, setSpread])

  if (!track) return null

  return (
    <div className={`mixer-strip ${track.muted ? 'mixer-strip--muted' : ''} ${track.visualOnly ? 'mixer-strip--visual-only' : ''}`}>
      {/* Track name */}
      <div className="mixer-strip-label" title={track.name}>
        {track.name}
      </div>

      {/* Mute / Solo */}
      <div className="mixer-strip-controls">
        <button
          className={`mixer-ms-btn ${track.muted ? 'muted' : ''}`}
          onClick={() => toggleMute(trackId)}
          title="Mute"
        >
          M
        </button>
        <button
          className={`mixer-ms-btn ${track.solo ? 'active' : ''}`}
          onClick={() => toggleSolo(trackId)}
          title="Solo"
        >
          S
        </button>
        <button
          className={`mixer-ms-btn ${track.visualOnly ? 'active' : ''}`}
          onClick={() => toggleVisualOnly(trackId)}
          title="Visual Only — silences audio, keeps grid triggers"
        >
          V
        </button>
      </div>

      {/* Pan + Spread knobs */}
      <div className="mixer-strip-knobs">
        <Knob
          value={track.pan}
          min={-1}
          max={1}
          defaultValue={0}
          label="PAN"
          formatValue={formatPan}
          onLiveChange={handlePanLive}
          onCommit={handlePanCommit}
          size={36}
          dragRange={120}
        />
        <Knob
          value={track.spread}
          min={0}
          max={2}
          defaultValue={1}
          label="WIDTH"
          formatValue={formatSpread}
          onLiveChange={handleSpreadLive}
          onCommit={handleSpreadCommit}
          size={36}
          dragRange={120}
        />
      </div>

      {/* Effect chain */}
      <EffectChainPanel trackId={trackId} />

      {/* Fader + Meter area */}
      <div className="mixer-strip-fader-area">
        <PeakMeter trackId={trackId} />
        <VolumeFader value={track.volume} onChange={handleVolume} />
      </div>
    </div>
  )
}
