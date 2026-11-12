// A populated Mixer for the dev-only UI kit gallery (?view=ui-kit, built with
// VITE_XLETH_UI_KIT_GALLERY=1). GALLERY ONLY: it is imported by ui-kit/Gallery.jsx
// and nowhere else, and it seeds the real stores with MOCK data so the real
// strips, routing band and loudness dock can be shot in every state at once.
// None of this ships in the real Mixer view, and nothing here is engine data.
//
// States shown: selected (5), muted (3), soloed (6), visual-only (8), clipped
// meter (4), a bus route (2, 3 -> 5; 8 -> 10), a sidechain (1 -> 6), named inserts
// (1 with one bypassed, 2, 7 with more than five so the last row is "+N more", 9 on
// an FX graph), the dB gutter and the loudness dock. "Armed" is not shown: the
// engine has no record-arm.

import { useEffect, useState } from 'react'
import useMixerStore, { peaksSnapshot } from '../../stores/mixerStore.js'
import useEffectChainStore from '../../stores/effectChainStore.js'
import { TRACK_PALETTE_FALLBACK } from '../timeline/trackColorResolver.js'
import MixerStrip from './MixerStrip.jsx'
import MasterStrip from './MasterStrip.jsx'
import { MixerGutter } from './MixerPanel.jsx'
import RoutingBand from './RoutingBand.jsx'
import MasterLoudnessMeter, { LOUDNESS_ENABLED_KEY, pollMasterLoudness } from '../MasterLoudnessMeter.jsx'
import { publishMeters } from './mixerMeterBus.js'
import { createPeakEntry } from './meterTelemetry.js'
import useMixerUiStore, { STRIP_WIDTHS } from './mixerUiStore.js'
import panel from './MixerPanel.module.css'

const NAMES = [
  'Kick', 'Snare', 'Hats', 'Chorus A', 'Chorus B', 'Pitch lead', 'Pitch low', 'Perc',
  'Crowd', 'Bus drums', 'Stab', 'Sub', 'Riser', 'Vox', 'Vox double', 'FX tail',
]
const IDS = NAMES.map((_, i) => i + 1)
// The longest chain in the mock is seven devices, shown in five rows so one strip reads "+3 more".
const GALLERY_ROWS = 5

const MOCK_LOUDNESS = {
  enabled: true, momentary: -13.2, shortTerm: -14.6, integrated: -14.1, momentaryMax: -9, shortTermMax: -12,
  lra: 4.2, truePeakDbtp: -2.1,
}

function mockTracks() {
  const tracks = {}
  IDS.forEach((id, i) => {
    tracks[id] = {
      id, name: NAMES[i], volume: id === 6 ? 0.7 : 1, pan: id === 2 ? -0.35 : (id === 9 ? 0.6 : 0), spread: id === 12 ? 0 : 1,
      muted: id === 3, solo: id === 6, visualOnly: id === 8, type: 'Clip',
    }
  })
  return tracks
}

function mockPeaks() {
  const snap = { tracks: {}, master: { ...createPeakEntry(), hasTelemetry: true, peakL: 0.55, peakR: 0.5 } }
  IDS.forEach((id) => {
    snap.tracks[id] = {
      ...createPeakEntry(), hasTelemetry: true,
      peakL: id === 4 ? 1 : 0.03 + 0.045 * (id % 9), peakR: id === 4 ? 0.9 : 0.025 + 0.04 * (id % 7),
    }
  })
  return snap
}

export default function MixerGalleryFixture({ stripMode = 'compact', insertsOpen: initialOpen = true }) {
  const stripW = STRIP_WIDTHS[stripMode]
  const [insertsOpen, setInsertsOpen] = useState(initialOpen)
  const identity = Object.fromEntries(IDS.map((id, i) => [id, TRACK_PALETTE_FALLBACK[i % 16]]))
  // The dock reads its on/off preference once, at mount: set it before the first render.
  useState(() => {
    try { localStorage.setItem(LOUDNESS_ENABLED_KEY, '1') } catch { /* gallery only */ }
    return true
  })

  useEffect(() => {
    const prior = {
      mixer: useMixerStore.getState(),
      chains: useEffectChainStore.getState().chains,
      fxModes: useEffectChainStore.getState().fxModes,
      xleth: window.xleth,
      loud: (() => { try { return localStorage.getItem(LOUDNESS_ENABLED_KEY) } catch { return null } })(),
      width: useMixerUiStore.getState().stripWidthMode,
    }
    const outputRoutes = Object.fromEntries(IDS.map((id) => [id, id === 2 || id === 3 ? 5 : (id === 8 ? 10 : -1)]))
    useMixerStore.setState({
      tracks: mockTracks(), trackOrder: IDS, outputRoutes, selectedChainKey: '5', master: { volume: 1 },
      sidechainRoutes: [{
        routeId: 'gallery-sc', sourceTrackId: 1, targetTrackId: 6, targetEffectInstanceId: 'gallery-fx',
        gain: 1, preFader: false, enabled: true, status: 'ok',
      }],
    })
    const fx = (nodeId, pluginId, extra) => ({ nodeId, pluginId, ...extra })
    const mockChains = {
      1: [fx(1, 'xletheq'), fx(2, 'compressor'), fx(3, 'reverb', { bypassed: true })],
      2: [fx(4, 'limiter'), fx(14, 'resonancesuppressor'), fx(15, 'transientproc'), fx(16, 'smartbalance'), fx(17, 'varimu')],
      7: [fx(5, 'xletheq'), fx(6, 'compressor'), fx(7, 'uniflange'), fx(8, 'delay'), fx(9, 'reverb'), fx(10, 'limiter'), fx(11, 'apex')],
      master: [fx(12, 'xletheq'), fx(13, 'limiter')],
    }
    useEffectChainStore.setState({
      chains: { ...prior.chains, ...mockChains },
      fxModes: { ...prior.fxModes, 9: 'graph' },
    })
    // The dock reads the engine through window.xleth; a MOCK stands in, for the gallery only.
    // Each strip fetches its own chain when it mounts, so the MOCK answers that call too.
    window.xleth = {
      ...(window.xleth || {}),
      audio: {
        ...(window.xleth?.audio || {}),
        getMasterLoudness: async () => MOCK_LOUDNESS,
        setMasterLoudnessEnabled: () => {},
        getEffectChain: async (id) => mockChains[id] ?? [],
        getMasterEffectChain: async () => mockChains.master,
      },
    }
    // The strips mounted (and asked for their chains) before this effect installed the MOCK,
    // so ask again: the newest fetch per chain wins.
    const { fetchChain } = useEffectChainStore.getState()
    fetchChain('master')
    IDS.forEach((id) => fetchChain(String(id)))
    pollMasterLoudness()
    // The strips only mount once the store above is seeded, so their meters
    // subscribe a render later: push the (steady) mock levels after that.
    const mock = mockPeaks()
    Object.assign(peaksSnapshot.master, mock.master)
    const timers = [50, 300].map((ms) => setTimeout(() => publishMeters(mock), ms))
    return () => {
      timers.forEach(clearTimeout)
      useMixerStore.setState(prior.mixer, true)
      useEffectChainStore.setState({ chains: prior.chains, fxModes: prior.fxModes })
      window.xleth = prior.xleth
      try {
        if (prior.loud == null) localStorage.removeItem(LOUDNESS_ENABLED_KEY)
        else localStorage.setItem(LOUDNESS_ENABLED_KEY, prior.loud)
      } catch { /* gallery only */ }
    }
  }, [])

  return (
    <div className={panel.panel} style={{ width: 1660, height: 380, flex: 'none', '--mx-ins-rows': insertsOpen ? GALLERY_ROWS : 0 }} data-testid="mixer-gallery-fixture">
      <div className={panel.gutterDock}>
        <MixerGutter stripMode={stripMode} onStripMode={() => {}} insertsOpen={insertsOpen} onInsertsOpen={setInsertsOpen} />
      </div>
      <div className={panel.scroll}>
        <div className={panel.lane}>
          {IDS.map((id, i) => (
            <MixerStrip key={id} trackId={id} index={i + 1} color={identity[id]} stripW={stripW} insertRowCount={GALLERY_ROWS} insertsOpen={insertsOpen} />
          ))}
          <RoutingBand orderedIds={IDS} stripW={stripW} idColors={identity} />
        </div>
      </div>
      <div className={panel.dock}>
        <MasterStrip stripW={stripW} insertRowCount={GALLERY_ROWS} insertsOpen={insertsOpen} />
        <MasterLoudnessMeter />
      </div>
    </div>
  )
}
