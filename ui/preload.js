'use strict';

const { ipcRenderer } = require('electron');
const { runtimeResource } = require('./runtimePaths');

// Thin helper — keeps call sites concise
const invoke = (ch, ...args) => ipcRenderer.invoke(ch, ...args);

// Load the shared-memory helper addon. It has zero JUCE/FFmpeg deps and
// loads reliably in the Electron renderer's preload Node context. It opens
// a Windows file mapping by name and returns it as an external ArrayBuffer
// pointing at the same physical pages the engine (in the forked worker)
// writes to. With contextIsolation:false the returned buffer reaches the
// renderer as a live reference — zero copy, zero IPC in the hot path.
let shmHelper = null;
let frameShm = null;  // { meta, bufA, bufB, readIndex, syncFrame }
try {
  const shmPath = runtimeResource('shm_helper', 'shm_helper.node');
  shmHelper = require(shmPath);
} catch (e) {
  console.warn('[preload] shm_helper load failed:', e.message);
}

function openFrameShm() {
  if (frameShm) return frameShm;
  if (!shmHelper) return null;
  const meta = ipcRenderer.sendSync('xleth:video:getFrameShmSync');
  if (!meta) return null;
  try {
    const handle = shmHelper.openSharedMemory(meta.name, meta.totalSize);
    // Two renderer-owned destination buffers — one per half of the mapping.
    // We memcpy the active half from native into one of these per swap.
    const bufA = new Uint8Array(meta.bufferSize);
    const bufB = new Uint8Array(meta.bufferSize);
    frameShm = {
      meta,
      bufA, bufB,
      readIndex: () => shmHelper.readInt32(handle, meta.indexOffset),
      syncFrame: (idx) => {
        const dst = (idx === 0) ? bufA : bufB;
        const srcOff = (idx === 0) ? 0 : meta.bufferSize;
        shmHelper.readBytes(handle, dst, srcOff, meta.bufferSize);
      },
    };
    return frameShm;
  } catch (e) {
    console.error('[preload] openSharedMemory failed:', e.message);
    return null;
  }
}

window.xleth = ({

  // ── Media server (for <video> elements) ────────────────────────────────────
  getMediaPort: () => invoke('xleth:getMediaPort'),

  // ── Legacy flat API (Phase 0 backward compat) ─────────────────────────────
  play:               ()      => invoke('xleth:play'),
  stop:               ()      => invoke('xleth:stop'),
  pause:              ()      => invoke('xleth:pause'),
  triggerSample:      (id)    => invoke('xleth:trigger', id),
  getTransportState:  ()      => invoke('xleth:transportState'),
  getCurrentFrame:    ()      => invoke('xleth:currentFrame'),
  getFrameRGBA:       ()      => invoke('xleth:frameRGBA'),
  getSyncStats:       ()      => invoke('xleth:syncStats'),
  importVideo:        ()      => invoke('xleth:importVideo'),
  readStartupLog:     ()      => invoke('xleth:readStartupLog'),
  setVideoResolution: (w, h)  => invoke('xleth:setVideoResolution', w, h),

  // ── Phase 1: project ──────────────────────────────────────────────────────
  project: {
    create:             (dir, name) => invoke('xleth:project:create', dir, name),
    save:               ()          => invoke('xleth:project:save'),
    saveAs:             (dir, name) => invoke('xleth:project:saveAs', dir, name),
    hasProjectDir:      ()          => invoke('xleth:project:hasProjectDir'),
    load:               (dir)       => invoke('xleth:project:load', dir),
    importSource:       (filePath)  => invoke('xleth:project:importSource', filePath),
    validateMedia:      ()          => invoke('xleth:project:validateMedia'),
    getInfo:            ()          => invoke('xleth:project:getInfo'),
    openNewProjectDialog: ()        => invoke('xleth:dialog:newProject'),
    openProjectDialog:   ()         => invoke('xleth:dialog:openProject'),
    openSaveAsDialog:    ()         => invoke('xleth:dialog:saveProjectAs'),
    openImportDialog:   ()          => invoke('xleth:dialog:importSources'),
    getSourceThumbnail: (filePath, duration) => invoke('xleth:project:getSourceThumbnail', filePath, duration),
    isDirty:            ()          => invoke('xleth:project:isDirty'),
    newBlank:           ()          => invoke('xleth:project:newBlank'),
    isExportRunning:    ()          => invoke('xleth:project:isExportRunning'),
  },

  // ── Autosave ──────────────────────────────────────────────────────────────
  autosave: {
    restart: () => invoke('xleth:autosave:restart'),
  },

  // ── Phase 1: timeline ─────────────────────────────────────────────────────
  timeline: {
    getBPM:           ()                    => invoke('xleth:timeline:getBPM'),
    setBPM:           (bpm)                 => invoke('xleth:timeline:setBPM', bpm),
    getTempoLocked:   ()                    => invoke('xleth:timeline:getTempoLocked'),
    setTempoLocked:   (locked)              => invoke('xleth:timeline:setTempoLocked', locked),
    getDeclickMs:     ()                    => invoke('xleth:timeline:getDeclickMs'),
    setDeclickMs:     (ms)                  => invoke('xleth:timeline:setDeclickMs', ms),
    getGlobalStretchMethod: ()              => invoke('xleth:timeline:getGlobalStretchMethod'),
    setGlobalStretchMethod: (method)        => invoke('xleth:timeline:setGlobalStretchMethod', method),
    getSources:       ()                    => invoke('xleth:timeline:getSources'),
    getRegions:       ()                    => invoke('xleth:timeline:getRegions'),
    getRegionsByLabel:(label)               => invoke('xleth:timeline:getRegionsByLabel', label),
    getTracks:        ()                    => invoke('xleth:timeline:getTracks'),
    getClips:         ()                    => invoke('xleth:timeline:getClips'),
    getClipsOnTrack:  (trackId)             => invoke('xleth:timeline:getClipsOnTrack', trackId),
    getClipsInRange:  (startBeat, endBeat)  => invoke('xleth:timeline:getClipsInRange', startBeat, endBeat),
    addTrack:         (info)                => invoke('xleth:timeline:addTrack', info),
    removeTrack:      (id)                  => invoke('xleth:timeline:removeTrack', id),
    setTrackMuted:      (trackId, muted)      => invoke('xleth:timeline:setTrackMuted', trackId, muted),
    setTrackVisualOnly: (trackId, visualOnly) => invoke('xleth:timeline:setTrackVisualOnly', trackId, visualOnly),
    setTrackSolo:       (trackId, solo)       => invoke('xleth:timeline:setTrackSolo', trackId, solo),
    setTrackName:     (trackId, name)       => invoke('xleth:timeline:setTrackName', trackId, name),
    setTrackFxMode:   (trackId, mode)       => invoke('xleth:timeline:setTrackFxMode', trackId, mode),
    setTrackGraphState: (trackId, graphState) => invoke('xleth:timeline:setTrackGraphState', trackId, graphState),
    setPatternName:   (patternId, name)     => invoke('xleth:timeline:setPatternName', patternId, name),
    setPatternRegion: (patternId, regionId) => invoke('xleth:timeline:setPatternRegion', patternId, regionId),
    convertToPatternTrack: (trackId)        => invoke('xleth:timeline:convertToPatternTrack', trackId),
    convertToClipTrack: (trackId)           => invoke('xleth:timeline:convertToClipTrack', trackId),
    setVideoFlipConfig: (trackId, config)   => invoke('xleth:timeline:setVideoFlipConfig', trackId, config),
    setVideoHoldLastFrame: (trackId, hold) => invoke('xleth:timeline:setVideoHoldLastFrame', trackId, hold),
    setTrackCornerRadius:     (trackId, v) => invoke('xleth:timeline:setTrackCornerRadius', trackId, v),
    setTrackGapScaleOverride: (trackId, v) => invoke('xleth:timeline:setTrackGapScaleOverride', trackId, v),
    setTrackSubdivisionFactor: (trackId, factor) => invoke('xleth:timeline:setTrackSubdivisionFactor', trackId, factor),
    setTrackColor:            (trackId, assignment) => invoke('xleth:timeline:setTrackColor', trackId, assignment),
    setTrackBounceSettings:        (trackId, bounce) => invoke('xleth:timeline:setTrackBounceSettings', trackId, bounce),
    setTrackZoomPanRotSettings:    (trackId, zpr)   => invoke('xleth:timeline:setTrackZoomPanRotSettings', trackId, zpr),
    setTrackPingPongSettings:      (trackId, pp)    => invoke('xleth:timeline:setTrackPingPongSettings', trackId, pp),
    setTrackSlideNoteEffect:       (trackId, s)     => invoke('xleth:timeline:setTrackSlideNoteEffect', trackId, s),
    getPreviewResolutionScale:     ()               => invoke('xleth:timeline:getPreviewResolutionScale'),
    setPreviewResolutionScale:     (scale)          => invoke('xleth:timeline:setPreviewResolutionScale', scale),
    getPreviewEffectsBypass:       ()               => invoke('xleth:timeline:getPreviewEffectsBypass'),
    setPreviewEffectsBypass:       (bypass)         => invoke('xleth:timeline:setPreviewEffectsBypass', bypass),
    setNoteSlide:                  (patternId, noteId, isSlide, cx, cy) =>
        invoke('xleth:timeline:setNoteSlide', patternId, noteId, isSlide, cx, cy),
    addVisualEffect:         (trackId, effectType) => invoke('xleth:timeline:addVisualEffect', trackId, effectType),
    removeVisualEffect:      (trackId, idx)        => invoke('xleth:timeline:removeVisualEffect', trackId, idx),
    reorderVisualEffect:          (trackId, from, to)   => invoke('xleth:timeline:reorderVisualEffect', trackId, from, to),
    setTrackVisualEffectChainOrder: (trackId, newOrder) => invoke('xleth:timeline:setTrackVisualEffectChainOrder', trackId, newOrder),
    setVisualEffectParam:    (trackId, ei, pi, val) => invoke('xleth:timeline:setVisualEffectParam', trackId, ei, pi, val),
    setVisualEffectBypassed: (trackId, ei, bp)     => invoke('xleth:timeline:setVisualEffectBypassed', trackId, ei, bp),
    getVisualEffectChain:    (trackId)             => invoke('xleth:timeline:getVisualEffectChain', trackId),
    addClip:          (clip)                => invoke('xleth:timeline:addClip', clip),
    removeClip:       (id)                  => invoke('xleth:timeline:removeClip', id),
    moveClip:         (id, trackId, pos)    => invoke('xleth:timeline:moveClip', id, trackId, pos),
    resizeClip:       (id, dur)             => invoke('xleth:timeline:resizeClip', id, dur),
    resizeClipLeft:   (id, pos, dur, offset) => invoke('xleth:timeline:resizeClipLeft', id, pos, dur, offset),
    stretchClip:      (id, dur)             => invoke('xleth:timeline:stretchClip', id, dur),
    stretchClipLeft:  (id, pos, dur)        => invoke('xleth:timeline:stretchClipLeft', id, pos, dur),
    pitchShiftClip:   (id, semi, cents)     => invoke('xleth:timeline:pitchShiftClip', id, semi, cents),
    reverseClip:      (id)                  => invoke('xleth:timeline:reverseClip', id),
    autoTrimClip:            (id, thresholdDb=-54) => invoke('xleth:timeline:autoTrimClip', id, thresholdDb),
    spliceClipsAtPlayhead:   (entries)             => invoke('xleth:timeline:spliceClipsAtPlayhead', entries),
    setClipParams:           (id, params)          => invoke('xleth:timeline:setClipParams', id, params),
    setClipModulation:       (id, modulation)      => invoke('xleth:timeline:setClipModulation', id, modulation),
    addRegion:        (region)              => invoke('xleth:timeline:addRegion', region),
    modifyRegion:     (id, region)          => invoke('xleth:timeline:modifyRegion', id, region),
    setSyllables:     (id, syllables)       => invoke('xleth:timeline:setSyllables', id, syllables),
    getSyllables:     (id)                  => invoke('xleth:timeline:getSyllables', id),
    removeRegion:     (id)                  => invoke('xleth:timeline:removeRegion', id),
    getGridLayout:       ()                              => invoke('xleth:timeline:getGridLayout'),
    setGridLayout:       (layout)                        => invoke('xleth:timeline:setGridLayout', layout),
    assignTrackToGrid:   (trackId, gx, gy, sx, sy)       => invoke('xleth:timeline:assignTrackToGrid', trackId, gx, gy, sx, sy),
    assignTrackToGridWithZOrder: (trackId, gx, gy, sx, sy, z) => invoke('xleth:timeline:assignTrackToGridWithZOrder', trackId, gx, gy, sx, sy, z),
    removeTrackFromGrid: (trackId)                       => invoke('xleth:timeline:removeTrackFromGrid', trackId),
    setFullscreenLayers: (layers)                        => invoke('xleth:timeline:setFullscreenLayers', layers),
    setPreviewFps:       (fps)                           => invoke('xleth:timeline:setPreviewFps', fps),
    // Convenience wrappers for grid-level gapScale (delegate to full grid layout
    // round-trip — dedicated named endpoints for consistency with the rest of
    // the four-layer bridge). Range is clamped engine-side in jsToGridLayout.
    getGapScale:         async () => {
      const l = await invoke('xleth:timeline:getGridLayout');
      return l && typeof l.gapScale === 'number' ? l.gapScale : 0;
    },
    setGapScale:         async (v) => {
      const l = await invoke('xleth:timeline:getGridLayout');
      if (!l) return;
      return invoke('xleth:timeline:setGridLayout', { ...l, gapScale: v });
    },
    // ── Patterns ─────────────────────────────────────────────────────────
    addPattern:             (info)                              => invoke('xleth:timeline:addPattern', info),
    getPattern:             (id)                                => invoke('xleth:timeline:getPattern', id),
    getAllPatterns:         ()                                  => invoke('xleth:timeline:getAllPatterns'),
    removePattern:          (id)                                => invoke('xleth:timeline:removePattern', id),
    updateSamplerSettings:  (regionId, settings)                => invoke('xleth:timeline:updateSamplerSettings', regionId, settings),
    getPatternAudioInfo:    (id)                                => invoke('xleth:timeline:getPatternAudioInfo', id),
    getRegionAudioInfo:      (regionId)                          => invoke('xleth:timeline:getRegionAudioInfo', regionId),
    // Pipeline B (getRegionWaveformPeaks) retired — use waveform.getRegionPeaks instead
    addPatternBlock:        (block)                             => invoke('xleth:timeline:addPatternBlock', block),
    getPatternBlocks:       ()                                  => invoke('xleth:timeline:getPatternBlocks'),
    removePatternBlock:     (id)                                => invoke('xleth:timeline:removePatternBlock', id),
    movePatternBlock:       (id, trackId, posTicks)             => invoke('xleth:timeline:movePatternBlock', id, trackId, posTicks),
    resizePatternBlock:     (id, durTicks)                      => invoke('xleth:timeline:resizePatternBlock', id, durTicks),
    resizePatternBlockLeft: (id, posTicks, durTicks, offTicks)  => invoke('xleth:timeline:resizePatternBlockLeft', id, posTicks, durTicks, offTicks),
    setPatternBlockLoop:    (id, enabled)                       => invoke('xleth:timeline:setPatternBlockLoop', id, enabled),
    addNote:                (patternId, note)                   => invoke('xleth:timeline:addNote', patternId, note),
    removeNote:             (patternId, noteId)                 => invoke('xleth:timeline:removeNote', patternId, noteId),
    moveNote:               (patternId, noteId, posTicks, pitch)=> invoke('xleth:timeline:moveNote', patternId, noteId, posTicks, pitch),
    moveNotesBatch:         (patternId, moves)                  => invoke('xleth:timeline:moveNotesBatch', patternId, moves),
    quantizeClipsBatch:     (specs)                             => invoke('xleth:timeline:quantizeClipsBatch', specs),
    resizeNotesBatch:       (patternId, resizes)                => invoke('xleth:timeline:resizeNotesBatch', patternId, resizes),
    resizeNote:             (patternId, noteId, durTicks)       => invoke('xleth:timeline:resizeNote', patternId, noteId, durTicks),
    setNoteVelocity:        (patternId, noteId, velocity)       => invoke('xleth:timeline:setNoteVelocity', patternId, noteId, velocity),
    previewNote:            (patternId, pitch, velocity=0.8)    => invoke('xleth:timeline:previewNote', patternId, pitch, velocity),
    previewNoteOff:         (patternId, pitch)                  => invoke('xleth:timeline:previewNoteOff', patternId, pitch),
    previewAllNotesOff:     (regionId)                          => invoke('xleth:timeline:previewAllNotesOff', regionId),
  },

  // ── Phase 1: undo ─────────────────────────────────────────────────────────
  undo: {
    undo:               () => invoke('xleth:undo:undo'),
    redo:               () => invoke('xleth:undo:redo'),
    canUndo:            () => invoke('xleth:undo:canUndo'),
    canRedo:            () => invoke('xleth:undo:canRedo'),
    getUndoDescription: () => invoke('xleth:undo:getUndoDescription'),
    getRedoDescription: () => invoke('xleth:undo:getRedoDescription'),
  },

  // ── Phase 1: transport ────────────────────────────────────────────────────
  transport: {
    play:     ()        => invoke('xleth:play'),
    stop:     ()        => invoke('xleth:stop'),
    pause:    ()        => invoke('xleth:pause'),
    seek:     (beatPos) => invoke('xleth:transport:seek', beatPos),
    getState: ()        => invoke('xleth:transportState'),
  },

  // ── Waveform mipmap (replaces Pipeline A FFmpeg extraction) ────────────────
  waveform: {
    getRegionPeaks: (regionId, startTime, endTime, targetPixels, channel) =>
      invoke('xleth:waveform:getRegionPeaks', regionId, startTime, endTime, targetPixels, channel),
    getRawSamples: (regionId, startSample, endSample, channel) =>
      invoke('xleth:waveform:getRawSamples', regionId, startSample, endSample, channel),
    getFilePeaks: (filePath, startTime, endTime, targetPixels, channel) =>
      invoke('xleth:waveform:getFilePeaks', filePath, startTime, endTime, targetPixels, channel),
    getClipPeaks: (clipId, startSec, endSec, numPeaks) =>
      invoke('xleth:waveform:getClipPeaks', clipId, startSec, endSec, numPeaks),
  },

  // ── Phase 1: audio ────────────────────────────────────────────────────────
  audio: {
    loadSample:        (path)               => invoke('xleth:audio:loadSample', path),
    triggerSample:     (id, vel)            => invoke('xleth:trigger', id, vel),
    mapRegionToSample: (regionId, sampleId) => invoke('xleth:audio:mapRegionToSample', regionId, sampleId),
    loadSourceRegion:  (filePath, startTime, endTime) => invoke('xleth:audio:loadSourceRegion', filePath, startTime, endTime),
    getMasterPeak:     ()                   => invoke('xleth:audio:getMasterPeak'),
    getTrackPeak:      (trackId)            => invoke('xleth:audio:getTrackPeak', trackId),
    getAllPeaks:        ()                   => invoke('xleth:audio:getAllPeaks'),
    setRealtimeDiagnosticsEnabled: (enabled) => invoke('xleth:audio:setRealtimeDiagnosticsEnabled', !!enabled),
    resetRealtimeDiagnostics: ()             => invoke('xleth:audio:resetRealtimeDiagnostics'),
    getRealtimeDiagnostics: ()               => invoke('xleth:audio:getRealtimeDiagnostics'),
    getAudioPerformanceTelemetry: ()         => invoke('xleth:audio:getAudioPerformanceTelemetry'),
    captureAudioPerformanceReport: (options) => invoke('xleth:audio:captureAudioPerformanceReport', options || {}),
    setTrackVolume:    (trackId, vol)       => invoke('xleth:audio:setTrackVolume', trackId, vol),
    setTrackPan:       (trackId, pan)       => invoke('xleth:audio:setTrackPan',    trackId, pan),
    setTrackSpread:    (trackId, spread)    => invoke('xleth:audio:setTrackSpread', trackId, spread),
    setMasterVolume:   (vol)               => invoke('xleth:audio:setMasterVolume', vol),
    // Replaced by WaveformMipmap N-API bindings — see window.xleth.waveform
    // getWaveformData / getWaveformRegion removed (Pipeline A)
    // Sample Selector: detect root note from WAV smpl chunk
    detectRootNote:    (filePath) => invoke('xleth:audio:detectRootNote', filePath),
    // ── SourcePlayer (Sample Picker audio preview via C++ engine) ────────
    loadSource:        (filePath) => invoke('xleth:audio:loadSource', filePath),
    playSource:        (startTime) => invoke('xleth:audio:playSource', startTime),
    pauseSource:       ()          => invoke('xleth:audio:pauseSource'),
    resumeSource:      ()          => invoke('xleth:audio:resumeSource'),
    seekSource:        (time)      => invoke('xleth:audio:seekSource', time),
    stopSource:        ()          => invoke('xleth:audio:stopSource'),
    getSourcePosition: ()          => invoke('xleth:audio:getSourcePosition'),
    isSourcePlaying:   ()          => invoke('xleth:audio:isSourcePlaying'),
    unloadSource:      ()          => invoke('xleth:audio:unloadSource'),
    // ── Output device selection ───────────────────────────────────────────
    getOutputDevices:       ()     => invoke('xleth:audio:getOutputDevices'),
    getCurrentOutputDevice: ()     => invoke('xleth:audio:getCurrentOutputDevice'),
    setOutputDevice:        (name) => invoke('xleth:audio:setOutputDevice', name),
    // ── Audio Export ─────────────────────────────────────────────────────
    exportStart:       (cfg)          => invoke('xleth:audio:exportStart', cfg),
    exportGetProgress: ()             => invoke('xleth:audio:exportGetProgress'),
    exportCancel:      ()             => invoke('xleth:audio:exportCancel'),
    exportSaveAsDialog:(defName, fmt) => invoke('xleth:dialog:exportAudio', defName, fmt),
    exportRegion:        (regionId)             => invoke('xleth:audio:exportRegion', regionId),
    openSwapAudioDialog: ()                     => invoke('xleth:dialog:swapAudio'),
    swapRegionAudio:     (regionId, processed)  => invoke('xleth:audio:swapRegionAudio', regionId, processed),
    revertRegionAudio:   (regionId)             => invoke('xleth:audio:revertRegionAudio', regionId),
    loadRegionAudio:     (regionId)             => invoke('xleth:audio:loadRegionAudio', regionId),
    probeAudioDuration:  (filePath)             => invoke('xleth:audio:probeAudioDuration', filePath),
    // ── P3: Effect Chain ────────────────────────────────────────────────
    addEffect:            (trackId, pluginId, position) => invoke('xleth:audio:addEffect', trackId, pluginId, position),
    removeEffect:         (trackId, nodeId)             => invoke('xleth:audio:removeEffect', trackId, nodeId),
    moveEffect:           (trackId, nodeId, newPosition) => invoke('xleth:audio:moveEffect', trackId, nodeId, newPosition),
    setEffectBypass:      (trackId, nodeId, bypassed)   => invoke('xleth:audio:setEffectBypass', trackId, nodeId, bypassed),
    getEffectChain:       (trackId)                     => invoke('xleth:audio:getEffectChain', trackId),
    addMasterEffect:      (pluginId, position)          => invoke('xleth:audio:addMasterEffect', pluginId, position),
    removeMasterEffect:   (nodeId)                      => invoke('xleth:audio:removeMasterEffect', nodeId),
    moveMasterEffect:     (nodeId, newPosition)         => invoke('xleth:audio:moveMasterEffect', nodeId, newPosition),
    setMasterEffectBypass:(nodeId, bypassed)             => invoke('xleth:audio:setMasterEffectBypass', nodeId, bypassed),
    getMasterEffectChain: ()                             => invoke('xleth:audio:getMasterEffectChain'),
    // ── Generic effect parameter / meter access ──────────────────────
    getEffectParameters: (trackId, nodeId)                    => invoke('xleth:audio:getEffectParameters', trackId, nodeId),
    setEffectParameter:  (trackId, nodeId, paramId, value)    => invoke('xleth:audio:setEffectParameter',  trackId, nodeId, paramId, value),
    getEffectMeter:      (trackId, nodeId)                    => invoke('xleth:audio:getEffectMeter',      trackId, nodeId),
    // ── Effect visualization (dynamics; binary ArrayBuffer payload) ─
    setEffectVisualizationEnabled: (trackId, nodeId, enabled) =>
      invoke('xleth:audio:setEffectVisualizationEnabled', trackId, nodeId, enabled),
    drainEffectVizFrames:          (trackId, nodeId, maxBuckets) =>
      invoke('xleth:audio:drainEffectVizFrames', trackId, nodeId, maxBuckets),
    // ── EQ-specific ─────────────────────────────────────────────────
    eqAddBand:          (trackId, nodeId)                          => invoke('xleth:audio:eqAddBand', trackId, nodeId),
    eqRemoveBand:       (trackId, nodeId, bandIndex)               => invoke('xleth:audio:eqRemoveBand', trackId, nodeId, bandIndex),
    eqSetBandParam:     (trackId, nodeId, bandIndex, paramName, v) => invoke('xleth:audio:eqSetBandParam', trackId, nodeId, bandIndex, paramName, v),
    eqGetResponseCurve: (trackId, nodeId)                          => invoke('xleth:audio:eqGetResponseCurve', trackId, nodeId),
    eqGetSpectrumData:  (trackId, nodeId)                          => invoke('xleth:audio:eqGetSpectrumData', trackId, nodeId),
    eqSetPreSpectrum:   (trackId, nodeId, enabled)                 => invoke('xleth:audio:eqSetPreSpectrum', trackId, nodeId, enabled),
    eqGetBands:         (trackId, nodeId)                          => invoke('xleth:audio:eqGetBands', trackId, nodeId),
    eqGetBandGR:        (trackId, nodeId)                          => invoke('xleth:audio:eqGetBandGR', trackId, nodeId),
    eqSetGlobalParam:   (trackId, nodeId, paramName, value)        => invoke('xleth:audio:eqSetGlobalParam', trackId, nodeId, paramName, value),
    eqGetGlobalParams:  (trackId, nodeId)                          => invoke('xleth:audio:eqGetGlobalParams', trackId, nodeId),
    eqGetSampleRate:    (trackId, nodeId)                          => invoke('xleth:audio:eqGetSampleRate', trackId, nodeId),
    // ── SmartBalance-specific ───────────────────────────────────────
    smartBalanceGetDebug: (trackId, nodeId)                         => invoke('xleth:audio:smartBalanceGetDebug', trackId, nodeId),
    // ── Waveshaper-specific ──────────────────────────────────────────
    wsGetCurvePoints:   (trackId, nodeId)                          => invoke('xleth:audio:wsGetCurvePoints', trackId, nodeId),
    wsSetCurvePoints:   (trackId, nodeId, pointsJSON)              => invoke('xleth:audio:wsSetCurvePoints', trackId, nodeId, pointsJSON),
    wsSetPreset:        (trackId, nodeId, presetIndex)             => invoke('xleth:audio:wsSetPreset', trackId, nodeId, presetIndex),
    // ── Graph-mode routing ────────────────────────────────────────────
    addConnection:          (trackId, srcId, dstId)        => invoke('xleth:audio:addConnection', trackId, srcId, dstId),
    removeConnection:       (trackId, srcId, dstId)        => invoke('xleth:audio:removeConnection', trackId, srcId, dstId),
    setWireGain:            (trackId, srcId, dstId, gain)  => invoke('xleth:audio:setWireGain', trackId, srcId, dstId, gain),
    setWireMute:            (trackId, srcId, dstId, muted) => invoke('xleth:audio:setWireMute', trackId, srcId, dstId, muted),
    getGraphTopology:       (trackId)                      => invoke('xleth:audio:getGraphTopology', trackId),
    setNodePosition:        (trackId, nodeId, x, y)        => invoke('xleth:audio:setNodePosition', trackId, nodeId, x, y),
    isGraphLinear:          (trackId)                      => invoke('xleth:audio:isGraphLinear', trackId),
    // ── Graph-owned effect instances (FXG.3-b) ─────────────────────────
    // Stable effectInstanceId ↔ transient engine nodeId. Separate from the
    // chain add/remove APIs above; never rewires the linear chain.
    addGraphEffectNode:        (trackId, effectInstanceId, pluginId) => invoke('xleth:audio:addGraphEffectNode', trackId, effectInstanceId, pluginId),
    removeGraphEffectNode:     (trackId, effectInstanceId)           => invoke('xleth:audio:removeGraphEffectNode', trackId, effectInstanceId),
    getGraphEffectEngineNodeId:(trackId, effectInstanceId)           => invoke('xleth:audio:getGraphEffectEngineNodeId', trackId, effectInstanceId),
    hydrateGraphEffectNodes:   (trackId, graphEffectNodes)           => invoke('xleth:audio:hydrateGraphEffectNodes', trackId, graphEffectNodes),
    syncLinearGraphTopology:   (trackId, topology)                   => invoke('xleth:audio:syncLinearGraphTopology', trackId, topology),
    // FXG.3-d: general graph routing (linear + parallel) + chain→graph adoption.
    syncGraphTopology:         (trackId, topology)                   => invoke('xleth:audio:syncGraphTopology', trackId, topology),
    adoptGraphEffectNodes:     (trackId, mapping)                    => invoke('xleth:audio:adoptGraphEffectNodes', trackId, mapping),
    addMasterConnection:    (srcId, dstId)                 => invoke('xleth:audio:addMasterConnection', srcId, dstId),
    removeMasterConnection: (srcId, dstId)                 => invoke('xleth:audio:removeMasterConnection', srcId, dstId),
    setMasterWireGain:      (srcId, dstId, gain)           => invoke('xleth:audio:setMasterWireGain', srcId, dstId, gain),
    setMasterWireMute:      (srcId, dstId, muted)          => invoke('xleth:audio:setMasterWireMute', srcId, dstId, muted),
    getMasterGraphTopology: ()                             => invoke('xleth:audio:getMasterGraphTopology'),
    setMasterNodePosition:  (nodeId, x, y)                => invoke('xleth:audio:setMasterNodePosition', nodeId, x, y),
    isMasterGraphLinear:    ()                             => invoke('xleth:audio:isMasterGraphLinear'),
    onExportProgress:  (cb) => {
      const h = (_e, data) => cb(data);
      ipcRenderer.on('export:progress', h);
      return () => ipcRenderer.removeListener('export:progress', h);
    },
    onWorldProcessingStart: (cb) => {
      const h = (_e, data) => cb(data);
      ipcRenderer.on('stretch:worldProcessingStart', h);
      return () => ipcRenderer.removeListener('stretch:worldProcessingStart', h);
    },
    onWorldProcessingComplete: (cb) => {
      const h = (_e, data) => cb(data);
      ipcRenderer.on('stretch:worldProcessingComplete', h);
      return () => ipcRenderer.removeListener('stretch:worldProcessingComplete', h);
    },
    // ── VST3 plugin scanner ──────────────────────────────────────────────
    scanPlugins:          (paths)            => invoke('xleth:audio:scanPlugins', paths),
    getScanProgress:      ()                 => invoke('xleth:audio:getScanProgress'),
    getScannedPlugins:    ()                 => invoke('xleth:audio:getScannedPlugins'),
    getFailedPlugins:     ()                 => invoke('xleth:audio:getFailedPlugins'),
    // ── VST3 plugin editor windows ───────────────────────────────────────
    openPluginEditor:     (trackId, nodeId)  => invoke('xleth:audio:openPluginEditor', trackId, nodeId),
    closePluginEditor:    (trackId, nodeId)  => invoke('xleth:audio:closePluginEditor', trackId, nodeId),
    closeAllPluginEditors: ()                => invoke('xleth:audio:closeAllPluginEditors'),
    isPluginEditorOpen:   (trackId, nodeId)  => invoke('xleth:audio:isPluginEditorOpen', trackId, nodeId),
    addVstSearchPath:     ()                 => invoke('xleth:dialog:addVstSearchPath'),
    // ── Missing-plugin helpers ────────────────────────────────────────────
    getMissingPlugins:    ()                 => invoke('xleth:audio:getMissingPlugins'),
    retryMissingPlugin:   (trackId, nodeId)  => invoke('xleth:audio:retryMissingPlugin', trackId, nodeId),
    removeAllMissing:     ()                 => invoke('xleth:audio:removeAllMissing'),
    // ── VST3 crash recovery ───────────────────────────────────────────────
    resetCrashedPlugin:   (trackId, nodeId)  => invoke('xleth:audio:resetCrashedPlugin', trackId, nodeId),
  },

  // ── Phase 1: video ────────────────────────────────────────────────────────
  video: {
    setResolution:  (w, h)  => invoke('xleth:setVideoResolution', w, h),
    getFrameBuffer: ()      => invoke('xleth:currentFrame'),
    getFrameRGBA:   ()      => invoke('xleth:frameRGBA'),
    // Open the Windows named-shared-memory region the engine writes frames
    // into. Zero-copy: renderer reads pixels directly via typed-array views.
    // Returns { buffer: ArrayBuffer, meta: {name, width, height, bufferSize, indexOffset, totalSize} }
    // or null if the engine hasn't initialized the shm yet.
    openFrameShm:   () => openFrameShm(),
    // FrameServer: open/close a decoder for a source (fast native path)
    openSource:     (id)    => invoke('xleth:video:openSource', id),
    closeSource:    (id)    => invoke('xleth:video:closeSource', id),
    // Get JPEG frame — pass sourceId (number) for native path, filePath (string) for legacy
    getFrameAtTime: (idOrPath, t, maxW, maxH) =>
        invoke('xleth:video:getFrameAtTime', idOrPath, t, maxW, maxH),
  },

  // ── Video Export ──────────────────────────────────────────────────────────
  videoExport: {
    exportStart:          (cfg)   => invoke('xleth:video:exportStart', cfg),
    exportGetProgress:    ()      => invoke('xleth:video:exportGetProgress'),
    exportCancel:         ()      => invoke('xleth:video:exportCancel'),
    exportSaveAsDialog:   (name)  => invoke('xleth:dialog:exportVideo', name),
    getAvailableEncoders: (codec) => invoke('xleth:video:getAvailableEncoders', codec),
    getDefaultEncoder:    (codec) => invoke('xleth:video:getDefaultEncoder', codec),
    computeDurationSeconds: (startBeat, endBeat) =>
        invoke('xleth:video:computeDurationSeconds', startBeat, endBeat),
    getExportPresets:     ()       => invoke('xleth:video:getExportPresets'),
    saveExportPresets:    (p)      => invoke('xleth:video:saveExportPresets', p),
    onExportProgress: (cb) => {
      const h = (_e, data) => cb(data);
      ipcRenderer.on('video-export:progress', h);
      return () => ipcRenderer.removeListener('video-export:progress', h);
    },
  },

  // ── GPU adapter detection ─────────────────────────────────────────────────
  gpu: {
    getAvailableGpus: () => invoke('xleth:gpu:getAvailableGpus'),
  },

  // ── Diagnostics (Settings → Graphics → Export Visual Preview Log) ────────
  // The renderer-side helper below collects WebGL info from the live preview
  // canvas (the main process cannot introspect the renderer's GL context) and
  // forwards everything to the main process IPC handler, which formats the
  // .txt and shows a save dialog.
  diag: {
    exportVisualPreviewLog: (extras) =>
      invoke('xleth:diag:exportVisualPreviewLog', extras || {}),
  },

  // ── Phase 1: sync ─────────────────────────────────────────────────────────
  sync: {
    getStats: () => invoke('xleth:syncStats'),
  },

  // ── User settings (persisted to userData/xleth-settings.json) ───────────────
  settings: {
    get: (key)        => invoke('xleth:settings:get', key),
    set: (key, value) => invoke('xleth:settings:set', key, value),
  },

  // ── Window layout (persisted to userData/layout.json) ──────────────────────
  layout: {
    read:  ()      => invoke('xleth:layout:read'),
    write: (value) => invoke('xleth:layout:write', value),
  },

  // ── Phase 7 — Preview visibility ──────────────────────────────────────────
  preview: {
    setEnabled: (enabled) => invoke('xleth:preview:setEnabled', enabled),
  },

  // ── User themes (persisted to userData/themes/<slug>.json) ─────────────────
  theme: {
    saveUser: (slug, theme) => invoke('xleth:theme:saveUser', slug, theme),
    loadUser: (slug)        => invoke('xleth:theme:loadUser', slug),
    listUser: ()            => invoke('xleth:theme:listUser'),
  },

  // ── Stock plugin UI layouts ───────────────────────────────────────────────
  // User-override layouts live in userData/plugin-ui/<pluginId>.json.
  // Shipped defaults are bundled with the renderer and never written here.
  pluginUi: {
    getShipped:         (pluginId)         => invoke('xleth:pluginUi:getShipped', pluginId),
    loadUserOverride:  (pluginId)         => invoke('xleth:pluginUi:loadUserOverride', pluginId),
    saveUserOverride:  (pluginId, layout) => invoke('xleth:pluginUi:saveUserOverride', pluginId, layout),
    clearUserOverride: (pluginId)         => invoke('xleth:pluginUi:clearUserOverride', pluginId),
    importDialog:      ()                 => invoke('xleth:dialog:importPluginUi'),
    exportDialog:      (pluginId, layout) => invoke('xleth:dialog:exportPluginUi', pluginId, layout),
    listKnobPresets:   ()                 => invoke('xleth:pluginUi:listKnobPresets'),
    saveKnobPreset:    (preset)           => invoke('xleth:pluginUi:saveKnobPreset', preset),
    deleteKnobPreset:  (id)               => invoke('xleth:pluginUi:deleteKnobPreset', id),
    // Returns a cleanup function (call it to unsubscribe)
    onLayoutChanged: (cb) => {
      const h = (_e, pluginId) => cb(pluginId)
      ipcRenderer.on('xleth:pluginUi:changed', h)
      return () => ipcRenderer.removeListener('xleth:pluginUi:changed', h)
    },
  },

  // ── User-imported decal assets ────────────────────────────────────────────────
  // Layout JSON stores only assetId. Never exposes raw fs, paths, or arbitrary URLs.
  pluginUiAssets: {
    list:        ()        => invoke('xleth:pluginUiAssets:list'),
    import:      ()        => invoke('xleth:pluginUiAssets:import'),
    getDataUrl:  (assetId) => invoke('xleth:pluginUiAssets:getDataUrl', assetId),
    delete:      (assetId) => invoke('xleth:pluginUiAssets:delete', assetId),
    scanOrphans: ()        => invoke('xleth:pluginUiAssets:scanOrphans'),
  },

  // ── Global engine defaults ─────────────────────────────────────────────────
  engine: {
    setGlobalStretchMethod:   (m) => invoke('xleth:engine:setGlobalStretchMethod', m),
    getGlobalStretchMethod:   ()  => invoke('xleth:engine:getGlobalStretchMethod'),
    setGlobalFormantPreserve: (v) => invoke('xleth:engine:setGlobalFormantPreserve', v),
    getGlobalFormantPreserve: ()  => invoke('xleth:engine:getGlobalFormantPreserve'),
  },

  // ── Shell ──────────────────────────────────────────────────────────────────
  shell: {
    showItemInFolder: (path) => invoke('xleth:shell:showItemInFolder', path),
    openPath:         (path) => invoke('xleth:shell:openPath', path),
  },

  // ── MIDI Import ───────────────────────────────────────────────────────────
  midi: {
    parseSummary:  (filePath)          => invoke('xleth:midi:parseSummary', filePath),
    importFull:    (filePath, options) => invoke('xleth:midi:importFull', filePath, JSON.stringify(options || {})),
    executeImport: (noteData, options) => {
      // Convert ArrayBuffer/TypedArray to Buffer before crossing the renderer→main
      // Electron IPC boundary. Buffer is the form main.js and the worker expect,
      // and it transits Electron's structured-clone IPC cleanly as a Uint8Array.
      const buf = noteData instanceof ArrayBuffer
        ? Buffer.from(noteData)
        : ArrayBuffer.isView(noteData)
          ? Buffer.from(noteData.buffer, noteData.byteOffset, noteData.byteLength)
          : noteData
      return invoke('xleth:midi:executeImport', buf, JSON.stringify(options || {}))
    },
  },

  // ── Dialogs ───────────────────────────────────────────────────────────────
  dialog: {
    openMidiDialog: () => invoke('xleth:dialog:importMIDI'),
  },

  // ── Window controls (frameless title bar) ─────────────────────────────────
  window: {
    minimize: () => ipcRenderer.send('xleth:window:minimize'),
    maximize: () => ipcRenderer.send('xleth:window:maximize'),
    close:    () => ipcRenderer.send('xleth:window:close'),
    zoomIn:   () => ipcRenderer.send('xleth:window:zoomIn'),
    zoomOut:  () => ipcRenderer.send('xleth:window:zoomOut'),
    resetZoom: () => ipcRenderer.send('xleth:window:resetZoom'),
    openNodeEditor:  (key, pos) => ipcRenderer.send('xleth:window:openNodeEditor', key, pos),
    closeNodeEditor: () => ipcRenderer.send('xleth:window:closeNodeEditor'),
  },

  // ── Cross-window graph change notifications ──────────────────────────────
  onGraphChanged: (callback) => {
    ipcRenderer.on('xleth:graph:changed', (_, key) => callback(key));
  },

  // ── Project load notification ─────────────────────────────────────────────
  // Fired after project_load completes. All effect chain nodeIds have been
  // reassigned by AudioGraph::fromJSON — cached nodeIds in UI stores are stale.
  onProjectLoaded: (callback) => {
    const h = () => callback();
    ipcRenderer.on('xleth:project-loaded', h);
    return () => ipcRenderer.removeListener('xleth:project-loaded', h);
  },
});

