import { useEffect } from 'react'
import useMixerStore, { peaksSnapshot } from '../../stores/mixerStore.js'
import useVstStore from '../../stores/vstStore.js'
import { timelineEvents } from '../../timelineEvents.js'
import { clearAllMeterTelemetry, mergeMeterTelemetry } from './meterTelemetry.js'
import MixerStrip from './MixerStrip.jsx'
import MasterStrip from './MasterStrip.jsx'
import EqPanel from './EqPanel.jsx'
import CompressorPanel from './CompressorPanel.jsx'
import LimiterPanel from './LimiterPanel.jsx'
import DistortionPanel from './DistortionPanel.jsx'
import WaveshaperPanel from './WaveshaperPanel.jsx'
import DelayPanel from './DelayPanel.jsx'
import ChorusPanel from './ChorusPanel.jsx'
import FlangerPanel from './FlangerPanel.jsx'
import PhaserPanel from './PhaserPanel.jsx'
import OTTPanel from './OTTPanel.jsx'
import ReverbPanel from './ReverbPanel.jsx'
import TransientProcPanel from './TransientProcPanel.jsx'
import SmartBalancePanel from './SmartBalancePanel.jsx'
import ResonanceSuppressorPanel from './ResonanceSuppressorPanel.jsx'
import VstBrowser from './VstBrowser.jsx'
import ScanProgressBar from './ScanProgressBar.jsx'

export default function MixerPanel() {
  const visible = useMixerStore(s => s.visible)
  const trackOrder = useMixerStore(s => s.trackOrder)
  const init = useMixerStore(s => s.init)
  const syncFromTimeline = useMixerStore(s => s.syncFromTimeline)
  const openVstBrowser = useVstStore(s => s.openBrowser)

  // Init on mount + when tracks change
  useEffect(() => {
    if (!visible) return
    init()
    const onTracksChanged = async () => {
      try {
        const list = await window.xleth?.timeline?.getTracks()
        if (Array.isArray(list)) syncFromTimeline(list)
      } catch {}
    }
    timelineEvents.addEventListener('timeline-tracks-changed', onTracksChanged)
    timelineEvents.addEventListener('timeline-clips-changed', onTracksChanged)
    timelineEvents.addEventListener('timeline-patterns-changed', onTracksChanged)
    return () => {
      timelineEvents.removeEventListener('timeline-tracks-changed', onTracksChanged)
      timelineEvents.removeEventListener('timeline-clips-changed', onTracksChanged)
      timelineEvents.removeEventListener('timeline-patterns-changed', onTracksChanged)
    }
  }, [visible, init, syncFromTimeline])

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
      <EqPanel />
      <CompressorPanel />
      <LimiterPanel />
      <DistortionPanel />
      <WaveshaperPanel />
      <DelayPanel />
      <ChorusPanel />
      <FlangerPanel />
      <PhaserPanel />
      <OTTPanel />
      <ReverbPanel />
      <TransientProcPanel />
      <SmartBalancePanel />
      <ResonanceSuppressorPanel />
      <VstBrowser />
      <div className="mixer-toolbar">
        <button
          className="mixer-toolbar-btn"
          onClick={() => openVstBrowser(null)}
          title="Open VST3 Browser — scan and manage plugins"
        >
          VST Browser
        </button>
        <ScanProgressBar />
      </div>
      <div className="mixer-strips-row">
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
