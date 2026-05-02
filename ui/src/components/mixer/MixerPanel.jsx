import { useEffect } from 'react'
import useMixerStore, { peaksSnapshot } from '../../stores/mixerStore.js'
import useVstStore from '../../stores/vstStore.js'
import { timelineEvents } from '../../timelineEvents.js'
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

function newPeakEntry() {
  return { peakL: 0, peakR: 0, holdL: 0, holdR: 0, holdTimeL: 0, holdTimeR: 0 }
}

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
            const now = performance.now()
            // Write all track peaks in one pass
            if (data.tracks) {
              for (const [tid, p] of Object.entries(data.tracks)) {
                if (!peaksSnapshot.tracks[tid]) {
                  peaksSnapshot.tracks[tid] = newPeakEntry()
                }
                const t = peaksSnapshot.tracks[tid]
                t.peakL = p.peakL
                t.peakR = p.peakR
                if (p.peakL >= t.holdL) { t.holdL = p.peakL; t.holdTimeL = now }
                if (p.peakR >= t.holdR) { t.holdR = p.peakR; t.holdTimeR = now }
                if (now - t.holdTimeL > 1500) t.holdL *= 0.95
                if (now - t.holdTimeR > 1500) t.holdR *= 0.95
              }
            }
            // Master peaks
            if (data.master) {
              const m = peaksSnapshot.master
              m.peakL = data.master.peakL
              m.peakR = data.master.peakR
              if (data.master.peakL >= m.holdL) { m.holdL = data.master.peakL; m.holdTimeL = now }
              if (data.master.peakR >= m.holdR) { m.holdR = data.master.peakR; m.holdTimeR = now }
              if (now - m.holdTimeL > 1500) m.holdL *= 0.95
              if (now - m.holdTimeR > 1500) m.holdR *= 0.95
            }
          }
        } catch {}
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
      // Zero all peaks on hide
      for (const t of Object.values(peaksSnapshot.tracks)) {
        t.peakL = t.peakR = t.holdL = t.holdR = 0
      }
      const m = peaksSnapshot.master
      m.peakL = m.peakR = m.holdL = m.holdR = 0
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
