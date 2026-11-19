// @vitest-environment jsdom
//
// useMotionData as a hook: what the Edit view's motion marker (R18) reads for a
// clip's Lens when the clips are refetched (undo / redo, any clip change).
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { useMotionData } from './useMotionData.js'
import { timelineEvents } from '../timelineEvents.js'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const LENS = { fit: 'Stretch', centerX: 0.5, centerY: 0.5, zoom: 1, rotationDeg: 0, flip: 'FollowTrack' }
const KEY = { channel: 'zoom', anchor: 'Origin', pos: 0, value: 2, interp: 'Linear' }
const TRACKS = [{ id: 2, name: 'Chorus', type: 'Clip' }]
const clip = (id, positionTicks, keys = []) => ({ id, trackId: 2, regionId: 1, positionTicks, durationTicks: 960, lens: { base: LENS, keys } })

let container
let root
let out
let getterClips

function Probe(props) {
  out = useMotionData({ tracks: TRACKS, patternBlocks: [], patterns: {}, regions: {}, ...props })
  return null
}

const render = (props) => act(async () => {
  root.render(<Probe {...props} />)
  for (let i = 0; i < 4; i++) await Promise.resolve()
})

beforeEach(() => {
  getterClips = []
  window.xleth = {
    timeline: {
      getLensRoam: vi.fn(async (sel) => ({
        tracks: [{ trackId: 2, keys: [], sweep: [], masks: [], parentTrackId: -1 }],
        sources: [],
        clips: Array.isArray(sel?.clipIds) ? getterClips : [],
      })),
      getGridLayout: async () => null,
      getMotionBlur: async () => null,
    },
  }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => { root.unmount() })
  container.remove()
  delete window.xleth
})

describe('clip Lens in the Edit view (R18 marker)', () => {
  it('an adopted clip Lens write gives way to the refetched clip.lens (undo)', async () => {
    const a = clip(30, 0)
    const b = clip(31, 960)
    await render({ clips: [a, b] })
    expect(out.motionTrackIds.has(2)).toBe(false)
    // Inspector adds a key: the post-state is adopted at once.
    await act(async () => {
      timelineEvents.dispatchEvent(new CustomEvent('lens-roam-changed', { detail: { clipId: 30, changed: true, lens: LENS, keys: [KEY] } }))
    })
    expect(out.motionTrackIds.has(2)).toBe(true)
    // Another clip changes (a delta splice): clip 30 is the same object, its adopted Lens stays.
    await render({ clips: [a, clip(31, 1200)] })
    expect(out.motionTrackIds.has(2)).toBe(true)
    // Ctrl+Z: the clips come back from the engine without the key.
    await render({ clips: [clip(30, 0), clip(31, 1200)] })
    expect(out.motionTrackIds.has(2)).toBe(false)
    expect(out.data.clipLensOf(out.data.clipsByTrack.get(2)[0]).keys).toEqual([])
  })

  it('the map Motion view fetched is kept on the way back, until the clips are refetched', async () => {
    getterClips = [{ clipId: 30, lens: LENS, keys: [KEY] }]
    const clips = [clip(30, 0)]
    await render({ clips, includeClipLens: true })
    expect(out.motionTrackIds.has(2)).toBe(true)
    // Back to the Edit view: clip.lens may not have the Motion view write yet.
    await render({ clips, includeClipLens: false })
    expect(out.motionTrackIds.has(2)).toBe(true)
    // Undo in the Edit view: the refetched clip.lens is the truth.
    await render({ clips: [clip(30, 0)], includeClipLens: false })
    expect(out.motionTrackIds.has(2)).toBe(false)
  })
})

describe('Clones (docs/XLETH_CLONE_SPEC.md)', () => {
  const LEAD = { id: 1, name: 'Lead', type: 'Pattern', order: 0, cloneOf: -1 }
  const VOICE = { id: 5, name: 'Lead · Clone 1', type: 'Pattern', order: 1, cloneOf: 1, clone: { cloneOf: 1, kind: 'Voice', lensMode: 'Linked', delayTicks: 0, tint: '#FFFFFF', opacity: 1, opacityKeys: [] } }
  const TRAIL = { id: 6, name: 'Lead · Trail 1', type: 'Pattern', order: 2, cloneOf: 1, clone: { cloneOf: 1, kind: 'Trail', lensMode: 'Linked', delayTicks: 480, tint: '#F07A2A', opacity: 0.9, opacityKeys: [] } }
  const PATTERNS = { 12: { id: 12, regionId: 100, lengthTicks: 3840, notes: [{ id: 1, positionTicks: 0, durationTicks: 960, pitch: 60 }] } }
  const BLOCKS = [{ id: 20, trackId: 1, patternId: 12, positionTicks: 0, durationTicks: 3840, offsetTicks: 0, loopEnabled: false }]

  it("fetches each Voice clone's own Track Lens for its source's regions", async () => {
    await render({ tracks: [LEAD, VOICE, TRAIL], patternBlocks: BLOCKS, patterns: PATTERNS })
    const sel = window.xleth.timeline.getLensRoam.mock.calls.at(-1)[0]
    expect(sel.sources).toEqual([{ trackId: 1, regionId: 100 }, { trackId: 5, regionId: 100 }])
    expect(sel.trackIds).toEqual([1, 5, 6])
  })

  it("adopts a Clone settings post-state at once ('clone-settings-changed')", async () => {
    await render({ tracks: [LEAD, VOICE, TRAIL], patternBlocks: BLOCKS, patterns: PATTERNS })
    expect(out.data.cloneOf(6).delayTicks).toBe(480)
    await act(async () => {
      timelineEvents.dispatchEvent(new CustomEvent('clone-settings-changed', {
        detail: { trackId: 6, changed: true, clone: { ...TRAIL.clone, delayTicks: 960, opacityKeys: [{ pos: 0, value: 0.5, interp: 'Hold' }] } },
      }))
    })
    expect(out.data.cloneOf(6).delayTicks).toBe(960)
    expect(out.data.noteStrip(6).starts[0]).toBe(960)
    expect(out.motionTrackIds.has(6)).toBe(true)
  })
})
