import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { validatePreset } from '../fxPresetSchema.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FACTORY_DIR = join(__dirname, '..', 'factory', 'xform')

const EXPECTED_SLUGS = [
  'slam-zoom', 'slow-push', 'punch-out', 'drift-left', 'shake', 'spin-in',
]

function loadFactoryPreset(slug) {
  const raw = readFileSync(join(FACTORY_DIR, `${slug}.json`), 'utf8')
  return JSON.parse(raw)
}

describe('xform factory presets', () => {
  it('ships exactly the six named built-ins', () => {
    const files = readdirSync(FACTORY_DIR).filter(f => f.endsWith('.json'))
    expect(files.map(f => f.replace(/\.json$/, '')).sort()).toEqual([...EXPECTED_SLUGS].sort())
  })

  it.each(EXPECTED_SLUGS)('%s is a valid xform preset envelope', (slug) => {
    const doc = loadFactoryPreset(slug)
    const check = validatePreset(doc, 'xform')
    expect(check.ok).toBe(true)
  })

  it.each(EXPECTED_SLUGS)('%s carries real keyframe+bezier data, not a named shortcut', (slug) => {
    const { state } = loadFactoryPreset(slug)
    expect(state.tracks).toBeTruthy()
    const channels = ['panX', 'panY', 'zoomLog2', 'rotationDeg']
    let totalKeys = 0
    for (const ch of channels) {
      const track = state.tracks[ch]
      expect(track).toHaveProperty('constantValue')
      expect(Array.isArray(track.keys)).toBe(true)
      for (const k of track.keys) {
        expect(typeof k.t).toBe('number')
        expect(typeof k.v).toBe('number')
        totalKeys += 1
      }
    }
    // At least one channel must carry actual keyframes — a preset that's
    // constantValue-only everywhere wouldn't animate anything.
    expect(totalKeys).toBeGreaterThan(0)
  })

  it.each(EXPECTED_SLUGS)('%s keeps zoomLog2 non-empty even when flat (engine trigger-path gate)', (slug) => {
    // CellAnimation::triggerNote (AnimationManager.cpp) decides "use the
    // authored tracks verbatim" vs. "derive all four channels from the legacy
    // scalars" based ONLY on zoomLog2.animated() (keys non-empty). A preset
    // that leaves zoomLog2 empty while authoring panX/panY/rotationDeg would
    // silently have those authored keyframes discarded and re-derived from
    // scalars instead. Presets with no real zoom motion (Drift Left, Shake)
    // carry a flat 2-key zoomLog2 (both keys at the same value) specifically
    // to satisfy this gate — this test guards against that regressing.
    const { state } = loadFactoryPreset(slug)
    expect(state.tracks.zoomLog2.keys.length).toBeGreaterThan(0)
  })

  it.each(EXPECTED_SLUGS)('%s keyframes are sorted ascending in [0,1]', (slug) => {
    const { state } = loadFactoryPreset(slug)
    for (const ch of ['panX', 'panY', 'zoomLog2', 'rotationDeg']) {
      const keys = state.tracks[ch].keys
      for (let i = 0; i < keys.length; i++) {
        expect(keys[i].t).toBeGreaterThanOrEqual(0)
        expect(keys[i].t).toBeLessThanOrEqual(1)
        if (i > 0) expect(keys[i].t).toBeGreaterThan(keys[i - 1].t)
      }
    }
  })
})
