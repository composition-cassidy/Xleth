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

  it('pins the undo / transport / timeline slice (AUDIT.md S1 slice 2)', () => {
    const byMethod = Object.fromEntries(METHODS.map((m) => [m.method, m]));

    // All six undo channels are value queries.
    for (const short of ['undo', 'redo', 'canUndo', 'canRedo',
                         'getUndoDescription', 'getRedoDescription']) {
      const e = byMethod[`undo_${short}`];
      expect(e, `undo_${short} missing`).toBeTruthy();
      expect(e.channels).toEqual([`xleth:undo:${short}`]);
      expect(e.api).toEqual({ [`undo.${short}`]: `xleth:undo:${short}` });
      expect(e.returns).toBe('value');
    }

    // transport_seek is the one Phase-1 transport extension (void).
    expect(byMethod.transport_seek.channels).toEqual(['xleth:transport:seek']);
    expect(byMethod.transport_seek.api).toEqual({ 'transport.seek': 'xleth:transport:seek' });
    expect(byMethod.transport_seek.returns).toBe('void');

    // Representative timeline methods — value queries and single-entity mutations.
    expect(byMethod.timeline_getClips.channels).toEqual(['xleth:timeline:getClips']);
    expect(byMethod.timeline_getClips.returns).toBe('value');
    expect(byMethod.timeline_getRouting.returns).toBe('value');
    expect(byMethod.timeline_addTrack.returns).toBe('value');
    expect(byMethod.timeline_setTrackMuted.channels).toEqual(['xleth:timeline:setTrackMuted']);
    expect(byMethod.timeline_setTrackMuted.returns).toBe('void');
    expect(byMethod.timeline_setNoteSlide.returns).toBe('void');
    expect(byMethod.timeline_setClipModulation.returns).toBe('value');
  });

  it('pins the project lifecycle slice (AUDIT.md S1 slice 3)', () => {
    const byMethod = Object.fromEntries(METHODS.map((m) => [m.method, m]));

    // Every migrated project pass-through dispatches with the value shape and
    // keeps its verbatim xleth:project:* channel + project.* wrapper path.
    for (const short of ['create', 'save', 'saveAs', 'hasProjectDir',
                         'importSource', 'removeSource', 'validateMedia',
                         'relinkSource', 'relinkRegionAudio', 'getInfo',
                         'isDirty', 'isExportRunning']) {
      const method = `project_${short}`;
      const e = byMethod[method];
      expect(e, `${method} missing`).toBeTruthy();
      expect(e.channels).toEqual([`xleth:project:${short}`]);
      expect(e.api).toEqual({ [`project.${short}`]: `xleth:project:${short}` });
      expect(e.returns).toBe('value');
      expect(e.binary).toBe(null);
    }
  });

  it('pins the patterns / regions / notes slice (AUDIT.md S1 slice 4)', () => {
    const byMethod = Object.fromEntries(METHODS.map((m) => [m.method, m]));

    // Every migrated region / pattern / pattern-block / single-note pass-through
    // keeps its verbatim xleth:timeline:* channel + timeline.* wrapper path, and
    // dispatches with the shape below (mirrors the removed hand dispatch line).
    const timelineShape = {
      timeline_addRegion: 'value',
      timeline_modifyRegion: 'void',
      timeline_setSyllables: 'void',
      timeline_getSyllables: 'value',
      timeline_removeRegion: 'void',
      timeline_addPattern: 'value',
      timeline_getPattern: 'value',
      timeline_getAllPatterns: 'value',
      timeline_removePattern: 'void',
      timeline_updateSamplerSettings: 'void',
      timeline_getPatternAudioInfo: 'value',
      timeline_getRegionAudioInfo: 'value',
      timeline_addPatternBlock: 'value',
      timeline_getPatternBlocks: 'value',
      timeline_removePatternBlock: 'void',
      timeline_movePatternBlock: 'void',
      timeline_resizePatternBlock: 'void',
      timeline_resizePatternBlockLeft: 'void',
      timeline_setPatternBlockLoop: 'void',
      timeline_addNote: 'value',
      timeline_removeNote: 'void',
      timeline_moveNote: 'void',
      timeline_resizeNote: 'void',
      timeline_setNoteVelocity: 'void',
      timeline_previewNoteOff: 'void',
      timeline_previewAllNotesOff: 'void',
    };
    for (const [method, shape] of Object.entries(timelineShape)) {
      const e = byMethod[method];
      expect(e, `${method} missing`).toBeTruthy();
      const short = method.slice('timeline_'.length);
      expect(e.channels).toEqual([`xleth:timeline:${short}`]);
      expect(e.api).toEqual({ [`timeline.${short}`]: `xleth:timeline:${short}` });
      expect(e.returns).toBe(shape);
      expect(e.binary).toBe(null);
    }

    // fsc_parse keeps its own xleth:fsc:* namespace (not timeline.*).
    expect(byMethod.fsc_parse.channels).toEqual(['xleth:fsc:parse']);
    expect(byMethod.fsc_parse.api).toEqual({ 'fsc.parse': 'xleth:fsc:parse' });
    expect(byMethod.fsc_parse.returns).toBe('value');
    expect(byMethod.fsc_parse.binary).toBe(null);
  });

  it('excludes batch ops, default-arg autoTrimClip/previewNote, and project load/newBlank', () => {
    const methods = new Set(METHODS.map((m) => m.method));
    // Batch ops (batching logic) and the default-arg fixups autoTrimClip
    // (thresholdDb=-54) / previewNote (velocity=0.8) stay hand-written in
    // ui/electron-main/timeline.js + patterns.js. project_load / project_newBlank
    // stay hand-written in ui/electron-main/project.js — they broadcast
    // xleth:project-loaded + restart autosave. See docs/rpc-manifest.md.
    for (const excluded of ['timeline_addClipsBatch',
                            'timeline_spliceClipsAtPlayhead',
                            'timeline_autoTrimClip',
                            'timeline_moveNotesBatch',
                            'timeline_addNotesBatch',
                            'timeline_quantizeClipsBatch',
                            'timeline_resizeNotesBatch',
                            'timeline_previewNote',
                            'project_load',
                            'project_newBlank']) {
      expect(methods.has(excluded), `${excluded} must NOT be in the manifest`).toBe(false);
    }
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

  it('creates the undo / transport namespaces on demand and forwards args', async () => {
    const calls = [];
    const invoke = (channel, ...args) => { calls.push([channel, ...args]); return Promise.resolve('ok'); };
    // Fresh target: neither undo nor transport pre-exists (the committed preload
    // no longer declares an `undo` object — attachRpcWrappers must create it).
    const target = {};
    attachRpcWrappers(target, invoke);

    expect(typeof target.undo.undo).toBe('function');
    expect(typeof target.undo.getRedoDescription).toBe('function');
    expect(typeof target.transport.seek).toBe('function');
    // fsc is its own namespace (S1 slice 4), also created on demand.
    expect(typeof target.fsc.parse).toBe('function');

    await target.undo.undo();
    await target.transport.seek(12.5);
    await target.timeline.setTrackMuted('t1', true);
    await target.timeline.setNoteSlide('p1', 'n1', true, 0.2, 0.8);
    await target.timeline.addRegion({ name: 'r' });
    await target.fsc.parse('/tmp/x.fsc');

    expect(calls).toContainEqual(['xleth:undo:undo']);
    expect(calls).toContainEqual(['xleth:transport:seek', 12.5]);
    expect(calls).toContainEqual(['xleth:timeline:setTrackMuted', 't1', true]);
    expect(calls).toContainEqual(['xleth:timeline:setNoteSlide', 'p1', 'n1', true, 0.2, 0.8]);
    expect(calls).toContainEqual(['xleth:timeline:addRegion', { name: 'r' }]);
    expect(calls).toContainEqual(['xleth:fsc:parse', '/tmp/x.fsc']);
  });
});
