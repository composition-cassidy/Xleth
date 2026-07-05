// Tests for ui/rpc-manifest.js (AUDIT.md S1, docs/rpc-manifest.md).
//
// Pins the exact channel strings and window.xleth API paths for every
// migrated method — a rename in the manifest must fail here, because the
// renderer and the smoke suite reference these strings verbatim. Also
// unit-tests attachRpcWrappers, the preload-side wrapper generator.

import { describe, it, expect } from 'vitest';
import { METHODS, validateManifest, attachRpcWrappers } from '../rpc-manifest.js';

describe('rpc-manifest invariants', () => {
  it('validates', () => {
    expect(validateManifest()).toBe(true);
  });

  it('methods, channels and api paths are unique', () => {
    const methods = METHODS.map((m) => m.method);
    expect(new Set(methods).size).toBe(methods.length);
    const channels = METHODS.flatMap((m) => m.channels);
    expect(new Set(channels).size).toBe(channels.length);
    const apiPaths = METHODS.flatMap((m) => Object.keys(m.api));
    expect(new Set(apiPaths).size).toBe(apiPaths.length);
  });

  it('pins the exact wiring of the migrated slice', () => {
    const byMethod = Object.fromEntries(METHODS.map((m) => [m.method, m]));

    expect(byMethod.timeline_getBPM.channels).toEqual(['xleth:timeline:getBPM']);
    expect(byMethod.timeline_getBPM.api).toEqual({ 'timeline.getBPM': 'xleth:timeline:getBPM' });
    expect(byMethod.timeline_getBPM.returns).toBe('value');

    expect(byMethod.timeline_getTempoLocked.channels).toEqual(['xleth:timeline:getTempoLocked']);
    expect(byMethod.timeline_getTempoLocked.returns).toBe('value');

    expect(byMethod.timeline_setBPM.channels).toEqual(['xleth:timeline:setBPM']);
    expect(byMethod.timeline_setBPM.returns).toBe('void');

    // The phase0 legacy frame fetch: two channels, four wrapper paths, binary.
    expect(byMethod.getFrameRGBA.channels).toEqual(['xleth:currentFrame', 'xleth:frameRGBA']);
    expect(byMethod.getFrameRGBA.api).toEqual({
      'getCurrentFrame':      'xleth:currentFrame',
      'getFrameRGBA':         'xleth:frameRGBA',
      'video.getFrameBuffer': 'xleth:currentFrame',
      'video.getFrameRGBA':   'xleth:frameRGBA',
    });
    expect(byMethod.getFrameRGBA.binary).toBe('frame');
  });
});

describe('attachRpcWrappers', () => {
  it('builds wrappers that invoke the right channel with the right args', async () => {
    const calls = [];
    const invoke = (channel, ...args) => {
      calls.push([channel, ...args]);
      return Promise.resolve('ok');
    };
    // video exists (as in preload); timeline is created on demand.
    const target = { video: { existing: true } };
    attachRpcWrappers(target, invoke);

    await target.timeline.getBPM();
    await target.timeline.setBPM(140);
    await target.getCurrentFrame();
    await target.video.getFrameRGBA();

    expect(calls).toEqual([
      ['xleth:timeline:getBPM'],
      ['xleth:timeline:setBPM', 140],
      ['xleth:currentFrame'],
      ['xleth:frameRGBA'],
    ]);
    // Existing namespace objects are extended, not replaced.
    expect(target.video.existing).toBe(true);
  });
});
