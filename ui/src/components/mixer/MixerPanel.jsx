import { useEffect, useMemo, useRef } from 'react'
import useMixerStore, { peaksSnapshot } from '../../stores/mixerStore.js'
import useTimelineFocusStore from '../../stores/timelineFocusStore.js'
import { timelineEvents } from '../../timelineEvents.js'
import { clearAllMeterTelemetry, mergeMeterTelemetry } from './meterTelemetry.js'
import MixerStrip from './MixerStrip.jsx'
import MasterStrip from './MasterStrip.jsx'
import SelectedEffectRack from './SelectedEffectRack.jsx'
import { buildMixerFolderLayout } from './mixerFolderLayout.js'

export default function MixerPanel() {
  const visible = useMixerStore(s => s.visible)
  const trackOrder = useMixerStore(s => s.trackOrder)
  const trackLayout = useMixerStore(s => s.trackLayout)
  const tracks = useMixerStore(s => s.tracks)
  const selectedChainKey = useMixerStore(s => s.selectedChainKey)
  const setSelectedChainKey = useMixerStore(s => s.setSelectedChainKey)
  const routingError = useMixerStore(s => s.routingError)
  const init = useMixerStore(s => s.init)
  const syncFromTimeline = useMixerStore(s => s.syncFromTimeline)
  const refreshRouting = useMixerStore(s => s.refreshRouting)
  const focusedTrackId = useTimelineFocusStore(s => s.focusedTrackId)
  const previousFocusedTrackIdRef = useRef(null)

  useEffect(() => {
    if (!visible) return
    init()
    const onTracksChanged = async () => {
      try {
        const [list, layout] = await Promise.all([
          window.xleth?.timeline?.getTracks(),
          window.xleth?.timeline?.getTrackLayout?.(),
        ])
        if (Array.isArray(list)) syncFromTimeline(list, layout)
        await refreshRouting()
      } catch {}
    }
    timelineEvents.addEventListener('timeline-tracks-changed', onTracksChanged)
    timelineEvents.addEventListener('timeline-track-layout-changed', onTracksChanged)
    timelineEvents.addEventListener('timeline-routing-changed', onTracksChanged)
    timelineEvents.addEventListener('timeline-clips-changed', onTracksChanged)
    timelineEvents.addEventListener('timeline-patterns-changed', onTracksChanged)
    const offProjectLoaded = window.xleth?.onProjectLoaded?.(onTracksChanged)
    return () => {
      timelineEvents.removeEventListener('timeline-tracks-changed', onTracksChanged)
      timelineEvents.removeEventListener('timeline-track-layout-changed', onTracksChanged)
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
    if (focusedTrackId !== previousFocusedTrackId) setSelectedChainKey(String(focusedTrackId))
  }, [visible, focusedTrackId, tracks, setSelectedChainKey])

  useEffect(() => {
    if (!visible || selectedChainKey === 'master') return
    if (selectedChainKey != null && tracks[Number(selectedChainKey)]) return
    const fallbackTrackId = focusedTrackId != null && tracks[focusedTrackId]
      ? focusedTrackId
      : trackOrder[0]
    setSelectedChainKey(fallbackTrackId == null ? null : String(fallbackTrackId))
  }, [visible, selectedChainKey, focusedTrackId, tracks, trackOrder, setSelectedChainKey])

  useEffect(() => {
    if (!visible) return
    let polling = true
    ;(async function loop() {
      while (polling) {
        try {
          const data = await window.xleth?.audio?.getAllPeaks()
          if (data) mergeMeterTelemetry(peaksSnapshot, data, performance.now())
          else clearAllMeterTelemetry(peaksSnapshot)
        } catch {
          clearAllMeterTelemetry(peaksSnapshot)
        }
        await new Promise(resolve => setTimeout(resolve, 125))
      }
    })()
    return () => {
      polling = false
      clearAllMeterTelemetry(peaksSnapshot)
    }
  }, [visible])

  const mixerLayout = useMemo(() => {
    return buildMixerFolderLayout(trackLayout, tracks)
  }, [trackLayout, tracks])

  if (!visible) return null

  return (
    <div className="mixer-panel" style={{ position: 'relative' }}>
      <div className="mixer-strips-row">
        {routingError && (
          <span className="mixer-routing-warning mixer-routing-warning--floating" role="status">
            {routingError}
          </span>
        )}
        {mixerLayout.hasFolderHeaders ? (
          <>
            <div className="mixer-offset-column mixer-offset-column--rack">
              <div className="mixer-folder-spacer" aria-hidden="true" />
              <SelectedEffectRack />
            </div>
            <div className="mixer-tracks-scroll mixer-tracks-scroll--foldered">
              {mixerLayout.items.map(item => item.kind === 'folder' ? (
                <section key={`folder-${item.folder.id}`} className="mixer-folder-group">
                  <div className="mixer-folder-header" title={item.folder.name}>
                    <span>{item.folder.name}</span>
                    <span className="mixer-folder-count">{item.trackIds.length}</span>
                  </div>
                  <div className="mixer-folder-strips">
                    {item.trackIds.map(id => <MixerStrip key={id} trackId={id} />)}
                  </div>
                </section>
              ) : (
                <div key={`track-${item.id}`} className="mixer-channel-column">
                  <div className="mixer-folder-spacer" aria-hidden="true" />
                  <MixerStrip trackId={item.id} />
                </div>
              ))}
            </div>
            <div className="mixer-offset-column mixer-offset-column--master">
              <div className="mixer-folder-spacer" aria-hidden="true" />
              <MasterStrip />
            </div>
          </>
        ) : (
          <>
            <SelectedEffectRack />
            <div className="mixer-tracks-scroll">
              {trackOrder.length === 0
                ? <div className="mixer-empty-state">No tracks — add tracks in the timeline</div>
                : trackOrder.map(id => <MixerStrip key={id} trackId={id} />)
              }
            </div>
            <MasterStrip />
          </>
        )}
      </div>
    </div>
  )
}
