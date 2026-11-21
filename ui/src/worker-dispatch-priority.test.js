import { describe, it, expect } from 'vitest'
import { shouldDeferMethod, WAVEFORM_METHODS } from '../worker-dispatch-priority.js'

// Unit-tests the DECISION addon-worker.js makes about which RPC methods get
// their native call deferred via setImmediate. The deferral MECHANISM
// itself (setImmediate pushes to a later check-phase tick, so a message
// received right after still gets handled promptly) is standard Node.js
// behavior and isn't re-verified here — see addonWorker.waveformOrdering
// .test.js for a real-forked-process smoke test that the deferred path
// still produces a correct result, not a corrupted or dropped one.
describe('shouldDeferMethod', () => {
  it('defers exactly the four waveform RPCs', () => {
    for (const method of [
      'waveform_getRegionPeaks',
      'waveform_getRawSamples',
      'waveform_getFilePeaks',
      'waveform_getClipPeaks',
    ]) {
      expect(shouldDeferMethod(method)).toBe(true)
    }
  })

  it('does not defer transport/meter-polling or other ordinary RPCs', () => {
    for (const method of [
      'getTransportState',
      'timeline_getRouting',
      'audio_getEffectMeter',
      'transport_seek',
      'audio_addEffect',
    ]) {
      expect(shouldDeferMethod(method)).toBe(false)
    }
  })

  it('does not defer an unknown/unimplemented method name', () => {
    expect(shouldDeferMethod('totally_made_up_method')).toBe(false)
  })

  it('is not fooled by a method name merely containing "waveform"', () => {
    // Guards against a future accidental broadening of the set via a loose
    // substring check instead of exact membership.
    expect(shouldDeferMethod('waveform_invalidate')).toBe(false)
    expect(shouldDeferMethod('somewaveform_getRegionPeaks')).toBe(false)
  })

  it('WAVEFORM_METHODS contains exactly the four expected names', () => {
    expect([...WAVEFORM_METHODS].sort()).toEqual([
      'waveform_getClipPeaks',
      'waveform_getFilePeaks',
      'waveform_getRawSamples',
      'waveform_getRegionPeaks',
    ])
  })
})
