// The sample picker sheet for the dev-only UI kit gallery (?view=ui-kit, built
// with VITE_XLETH_UI_KIT_GALLERY=1). GALLERY ONLY: imported by ui-kit/Gallery.jsx
// and nowhere else. It stubs the engine calls the picker makes so the real
// picker layout can be shot at the sheet's real sizes. There is NO engine here,
// so the waveform area honestly reports that it has no waveform: nothing is
// drawn that is not signal. The marked list shows the Browser fixture's regions.

import { useRef, useState } from 'react'
import SamplePicker from './SamplePicker.jsx'

const NOOP = () => {}
const SOURCE = {
  id: 1, name: 'verse_take_03.mp4', filePath: 'C:\mock\verse_take_03.mp4',
  width: 1920, height: 1080, fps: 29.97, duration: 204.4, hasVideo: true,
}

function installMock() {
  if (typeof window === 'undefined') return
  const prior = window.xleth || {}
  window.xleth = {
    ...prior,
    audio: {
      ...(prior.audio || {}),
      loadSource: async () => ({ success: true, duration: SOURCE.duration }),
      unloadSource: async () => {},
      stopSource: async () => {},
    },
    waveform: { getFilePeaks: async () => null },
    timeline: { getRegions: async () => [], ...(prior.timeline || {}) },
  }
}

export default function PickerGalleryFixture({ width = 1086, height = 340 }) {
  useState(installMock)
  const scopeRef = useRef(null)
  return (
    <div
      ref={scopeRef}
      data-testid="picker-gallery-fixture"
      style={{ width, height, border: '1px solid var(--ui-boundary)', background: 'var(--ui-g1)' }}
    >
      <SamplePicker source={SOURCE} onClose={NOOP} scopeRef={scopeRef} />
    </div>
  )
}
