// A populated Browser for the dev-only UI kit gallery (?view=ui-kit, built with
// VITE_XLETH_UI_KIT_GALLERY=1). GALLERY ONLY: it is imported by ui-kit/Gallery.jsx
// and nowhere else. It installs a stub `window.xleth` that answers the Browser's
// reads with MOCK sources and regions so the real Media and Samples lists can be
// shot with rows, groups, a selection and a pending proxy. Nothing here is engine
// data and none of it ships in a real view.

import { useState } from 'react'
import LeftPanel from '../LeftPanel.jsx'
import { ToastProvider } from '../Toast.jsx'
import XlethRootContext from '../../windowing/contexts/XlethRootContext.jsx'

const NOOP = () => {}

const MOCK_SOURCES = [
  { id: 1, fileName: 'verse_take_03.mp4', filePath: 'C:\\mock\\verse_take_03.mp4', width: 1920, height: 1080, fps: 29.97, duration: 204.4, hasVideo: true, proxyReady: true },
  { id: 2, fileName: 'chorus_vocal.wav', filePath: 'C:\\mock\\chorus_vocal.wav', duration: 8.5, hasVideo: false, proxyReady: true },
  { id: 3, fileName: 'intro_clip.mov', filePath: 'C:\\mock\\intro_clip.mov', width: 1280, height: 720, fps: 24, duration: 62.2, hasVideo: true, proxyReady: false },
  { id: 4, fileName: 'a_much_longer_source_file_name_for_the_overflow_case.mp4', filePath: 'C:\\mock\\long.mp4', width: 1920, height: 1080, fps: 60, duration: 3727, hasVideo: true, proxyReady: true },
]

const region = (id, label, name, startTime, endTime, extra = {}) => ({ id, sourceId: 1, label, name, startTime, endTime, ...extra })
const MOCK_REGIONS = [
  region(1, 'Kick', 'Kick 1', 12.1, 12.46),
  region(2, 'Kick', 'Kick 2', 20.0, 20.31),
  region(3, 'Kick', 'Kick 3', 31.7, 32.02),
  region(4, 'Snare', 'Snare 1', 14.2, 14.52),
  region(5, 'Snare', 'Snare 2 with a long name that overflows', 22.9, 23.3),
  region(6, 'HiHat', 'HiHat 1', 40.0, 40.12),
  region(7, 'Pitch', 'Pitch 1', 52.0, 54.6, { sourceId: 2 }),
  region(8, 'Pitch', 'Pitch 2', 60.0, 61.4, { sourceId: 2, hasSwappedAudio: true, swappedAudioPath: 'C:\\mock\\Pitch 2.wav' }),
  region(9, 'Quote', 'Quote 1', 80.0, 83.4),
  region(10, 'Sub drop', 'Sub drop 1', 100, 101.2),
]

function installMock() {
  if (typeof window === 'undefined') return
  window.xleth = {
    ...(window.xleth || {}),
    getMediaPort: async () => null,
    timeline: {
      getSources: async () => MOCK_SOURCES,
      getRegions: async () => MOCK_REGIONS,
    },
    project: { getSourceThumbnail: async () => null },
    audio: { ...(window.xleth?.audio || {}), detectRootNote: async () => ({ note: 60 }) },
    settings: { get: async () => null, set: async () => {} },
  }
}

export default function BrowserGalleryFixture({ tab, width = 280, height = 520 }) {
  // Render phase on purpose: the Browser reads window.xleth in its mount effects.
  useState(installMock)
  const [activeSampleId, setActiveSampleId] = useState(tab === 'samples' ? 4 : null)
  const value = {
    onOpenPicker: NOOP,
    activeSampleId,
    setActiveSampleId,
    currentPatternIdByTrack: {},
    setCurrentPatternIdByTrack: NOOP,
    activeCenterTab: 'timeline',
    availablePatterns: [],
    onSwitchPattern: null,
    onNewPattern: NOOP,
    onOpenMidiImport: NOOP,
  }
  return (
    <ToastProvider>
      <XlethRootContext.Provider value={value}>
        <div data-testid="browser-gallery-fixture" style={{ width, height, border: '1px solid var(--ui-g4)' }}>
          <LeftPanel tab={tab} onOpenPicker={NOOP} activeSampleId={activeSampleId} setActiveSampleId={setActiveSampleId} />
        </div>
      </XlethRootContext.Provider>
    </ToastProvider>
  )
}
