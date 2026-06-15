import { useEffect, useRef } from 'react'
import useMixerStore, { peaksSnapshot } from '../../stores/mixerStore.js'
import useTimelineFocusStore from '../../stores/timelineFocusStore.js'
import { timelineEvents } from '../../timelineEvents.js'
import { clearAllMeterTelemetry, mergeMeterTelemetry } from './meterTelemetry.js'
import MixerStrip from './MixerStrip.jsx'
import MasterStrip from './MasterStrip.jsx'
import SelectedEffectRack from './SelectedEffectRack.jsx'
// Stock effect editor panels are NOT rendered here. They live in the global
// EffectEditorHost (mounted at the app root) so they are never a DOM descendant
// of the Mixer's floating PanelFrame and cannot be clipped/trapped by it.
// The Mixer only *requests* an editor via the effect store's open() (see
// EffectModule.jsx / effectEditorOpeners.js).

export default function MixerPanel() {
  const visible = useMixerStore(s => s.visible)
  const trackOrder = useMixerStore(s => s.trackOrder)
  const tracks = useMixerStore(s => s.tracks)
  const selectedChainKey = useMixerStore(s => s.selectedChainKey)
  const setSelectedChainKey = useMixerStore(s => s.setSelectedChainKey)
  const routingError = useMixerStore(s => s.routingError)
  const init = useMixerStore(s => s.init)
  const syncFromTimeline = useMixerStore(s => s.syncFromTimeline)
  const refreshRouting = useMixerStore(s => s.refreshRouting)
  const focusedTrackId = useTimelineFocusStore(s => s.focusedTrackId)
  const previousFocusedTrackIdRef = useRef(null)

  // Init on mount + when tracks change
  useEffect(() => {
    if (!visible) return
    init()
    const onTracksChanged = async () => {
      try {
        const list = await window.xleth?.timeline?.getTracks()
        if (Array.isArray(list)) syncFromTimeline(list)
        await refreshRouting()
      } catch {}
    }
    timelineEvents.addEventListener('timeline-tracks-changed', onTracksChanged)
    timelineEvents.addEventListener('timeline-routing-changed', onTracksChanged)
    timelineEvents.addEventListener('timeline-clips-changed', onTracksChanged)
    timelineEvents.addEventListener('timeline-patterns-changed', onTracksChanged)
    const offProjectLoaded = window.xleth?.onProjectLoaded?.(onTracksChanged)
    return () => {
      timelineEvents.removeEventListener('timeline-tracks-changed', onTracksChanged)
      timelineEvents.removeEventListener('timeline-routing-changed', onTracksChanged)
      timelineEvents.removeEventListener('timeline-clips-changed', onTracksChanged)
      timelineEvents.removeEventListener('timeline-patterns-changed', onTracksChanged)
      offProjectLoaded?.()
    }
  }, [visible, init, syncFromTimeline, refreshRouting])

  useEffect(() => {
    if (!visible) return
    const previousFocusedTrackId = previousFocusedTrackIdRef.current
    previousFocusedTrackIdRef.current = focusedTrackId
    if (focusedTrackId == null || !tracks[focusedTrackId]) return
    if (focusedTrackId !== previousFocusedTrackId) {
      setSelectedChainKey(String(focusedTrackId))
    }
  }, [visible, focusedTrackId, tracks, setSelectedChainKey])

  useEffect(() => {
    if (!visible || selectedChainKey === 'master') return
    if (selectedChainKey != null && tracks[Number(selectedChainKey)]) return

    const fallbackTrackId = focusedTrackId != null && tracks[focusedTrackId]
      ? focusedTrackId
      : trackOrder[0]
    setSelectedChainKey(fallbackTrackId == null ? null : String(fallbackTrackId))
  }, [visible, selectedChainKey, focusedTrackId, tracks, trackOrder, setSelectedChainKey])

  // Peak polling — sequential async loop, 1 IPC call per cycle
  useEffect(() => {
    if (!visible) return
    let polling = true
    ;(async function loop() {
      while (polling) {
        try {
          const data = await window.xleth?.audio?.getAllPeaks()
          if (data) {
            mergeMeterTelemetry(peaksSnapshot, data, performance.now())
          } else {
            clearAllMeterTelemetry(peaksSnapshot)
          }
        } catch {
          clearAllMeterTelemetry(peaksSnapshot)
        }
        // 50 ms ≈ 20 Hz.  Previously 33 ms (30 Hz): getAllPeaks iterates every
        // active track under a lock shared with the audio thread.  At 30 Hz with
        // 10+ tracks each Napi::Object allocation adds up.  20 Hz is imperceptible
        // to the eye for peak meters but meaningfully reduces JUCE message-thread
        // starvation when a VST editor window is open.
        await new Promise(r => setTimeout(r, 50))
      }
    })()
    return () => {
      polling = false
      clearAllMeterTelemetry(peaksSnapshot)
    }
  }, [visible])

  if (!visible) return null

  return (
    <div className="mixer-panel" style={{ position: 'relative' }}>
      <div className="mixer-strips-row">
        {routingError && (
          <span className="mixer-routing-warning mixer-routing-warning--floating" role="status">
            {routingError}
          </span>
        )}
        <SelectedEffectRack />
        <div className="mixer-tracks-scroll">
          {trackOrder.length === 0
            ? <div className="mixer-empty-state">No tracks — add tracks in the timeline</div>
            : trackOrder.map(id => <MixerStrip key={id} trackId={id} />)
          }
        </div>
        <MasterStrip />
      </div>
    </div>
  )
}
