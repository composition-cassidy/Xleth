import React, { useCallback, useEffect } from 'react'
import useMixerStore, { MASTER_OUTPUT_TARGET_ID, normalizeOutputTargetId } from '../../stores/mixerStore.js'
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
  const tracks = useMixerStore(s => s.tracks)
  const outputRoutes = useMixerStore(s => s.outputRoutes)
  const routingError = useMixerStore(s => s.routingError)
  const setVolume = useMixerStore(s => s.setVolume)
  const setPan = useMixerStore(s => s.setPan)
  const setSpread = useMixerStore(s => s.setSpread)
  const setOutputRoute = useMixerStore(s => s.setOutputRoute)
  const getEligibleOutputTargets = useMixerStore(s => s.getEligibleOutputTargets)
  const refreshRouting = useMixerStore(s => s.refreshRouting)
  const toggleMute = useMixerStore(s => s.toggleMute)
  const toggleSolo = useMixerStore(s => s.toggleSolo)
  const toggleVisualOnly = useMixerStore(s => s.toggleVisualOnly)

  const handleVolume = useCallback((gain) => setVolume(trackId, gain), [trackId, setVolume])
  const handlePanLive = useCallback((v) => setPan(trackId, v), [trackId, setPan])
  const handlePanCommit = useCallback((v) => setPan(trackId, v), [trackId, setPan])
  const handleSpreadLive = useCallback((v) => setSpread(trackId, v), [trackId, setSpread])
  const handleSpreadCommit = useCallback((v) => setSpread(trackId, v), [trackId, setSpread])
  const routeTargetId = normalizeOutputTargetId(outputRoutes[trackId])
  const routeTarget = routeTargetId === MASTER_OUTPUT_TARGET_ID ? null : tracks[routeTargetId]
  const busInputCount = Object.entries(outputRoutes).reduce((count, [sourceId, targetId]) => {
    if (Number(sourceId) === Number(trackId)) return count
    return normalizeOutputTargetId(targetId) === Number(trackId) && tracks[sourceId] ? count + 1 : count
  }, 0)
  const outputTargets = getEligibleOutputTargets(trackId)
  const hasSelectedTarget = outputTargets.some(option => option.targetTrackId === routeTargetId)
  const selectedMissingTarget = routeTargetId !== MASTER_OUTPUT_TARGET_ID && !hasSelectedTarget

  const handleOutputRouteChange = useCallback((e) => {
    setOutputRoute(trackId, Number(e.target.value))
  }, [trackId, setOutputRoute])

  useEffect(() => {
    if (routeTargetId !== MASTER_OUTPUT_TARGET_ID && !routeTarget) {
      refreshRouting()
    }
  }, [routeTargetId, routeTarget, refreshRouting])

  if (!track) return null

  return (
    <div className={`mixer-strip ${track.muted ? 'mixer-strip--muted' : ''} ${track.visualOnly ? 'mixer-strip--visual-only' : ''}`}>
      {/* Track name */}
      <div className="mixer-strip-label" title={track.name}>
        {track.name}
      </div>

      <div className="mixer-output-route">
        <label className="mixer-output-label" htmlFor={`mixer-output-${trackId}`}>Output</label>
        <select
          id={`mixer-output-${trackId}`}
          className="mixer-output-select"
          value={routeTargetId}
          onChange={handleOutputRouteChange}
          title={routingError || 'Output'}
        >
          {selectedMissingTarget && (
            <option value={routeTargetId} disabled>Missing track</option>
          )}
          {outputTargets.map(option => (
            <option key={option.targetTrackId} value={option.targetTrackId}>
              {option.name}
            </option>
          ))}
        </select>
      </div>

      <div className="mixer-route-badges" aria-live="polite">
        {routeTargetId !== MASTER_OUTPUT_TARGET_ID && (
          <span className="mixer-route-chip" title={routeTarget ? `Output to ${routeTarget.name}` : 'Output target missing'}>
            {`→ ${routeTarget?.name || 'Missing track'}`}
          </span>
        )}
        {busInputCount > 0 && (
          <span className="mixer-route-chip mixer-route-chip--input" title={`${busInputCount} routed input${busInputCount === 1 ? '' : 's'}`}>
            {`${busInputCount} input${busInputCount === 1 ? '' : 's'}`}
          </span>
        )}
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
