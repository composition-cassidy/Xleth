'use strict';

const { ipcRenderer, webUtils, shell } = require('electron');
const { runtimeResource } = require('./runtimePaths');
const { attachRpcWrappers } = require('./rpc-manifest');

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

function normalizeBackdropState(state) {
  const mode = state && ['native-acrylic', 'image', 'video'].includes(state.mode) ? state.mode : 'off';
  const preference = state && ['off', 'acrylic', 'image', 'video', 'none'].includes(state.preference)
    ? state.preference
    : 'none';
  return {
    capability: state && state.capability ? state.capability : null,
    preference,
    mode,
    imagePath: typeof state?.imagePath === 'string' ? state.imagePath : null,
    imageUrl: typeof state?.imageUrl === 'string' ? state.imageUrl : null,
    videoPath: typeof state?.videoPath === 'string' ? state.videoPath : null,
    videoUrl: typeof state?.videoUrl === 'string' ? state.videoUrl : null,
    lastError: typeof state?.lastError === 'string' ? state.lastError : null,
  };
}

let backdropCurrent = normalizeBackdropState(null);
try {
  backdropCurrent = normalizeBackdropState(ipcRenderer.sendSync('xleth:backdrop:getStateSync'));
} catch (e) {
  console.warn('[preload] backdrop state seed failed:', e.message);
}

window.xleth = ({

  // ── Media server (for <video> elements) ────────────────────────────────────
  getMediaPort: () => invoke('xleth:getMediaPort'),

  // ── FL Studio Score (.fsc) parsing ─────────────────────────────────────────
  // Pure read-only parse: returns neutral note data (no Timeline mutation).
  // Pair with timeline.addNotesBatch to actually insert the parsed notes.
  // fsc.parse comes from the RPC manifest (attachRpcWrappers below, S1 slice 4);
  // attachRpcWrappers creates the fsc.* namespace on demand.

  // Electron 41 removed File.path. Resolve a dropped/selected File to its
  // absolute filesystem path synchronously via webUtils.
  getDroppedFilePath: (file) => webUtils.getPathForFile(file),

  // ── Legacy flat API (Phase 0 backward compat) ─────────────────────────────
  play:               ()      => invoke('xleth:play'),
  stop:               ()      => invoke('xleth:stop'),
  pause:              ()      => invoke('xleth:pause'),
  triggerSample:      (id)    => invoke('xleth:trigger', id),
  getTransportState:  ()      => invoke('xleth:transportState'),
  // getCurrentFrame / getFrameRGBA come from the RPC manifest (attachRpcWrappers below)
  getSyncStats:       ()      => invoke('xleth:syncStats'),
  importVideo:        ()      => invoke('xleth:importVideo'),
  readStartupLog:     ()      => invoke('xleth:readStartupLog'),
  setVideoResolution: (w, h)  => invoke('xleth:setVideoResolution', w, h),

  // ── Phase 1: project ──────────────────────────────────────────────────────
  // create / save / saveAs / hasProjectDir / importSource / removeSource /
  // validateMedia / relinkSource / relinkRegionAudio / getInfo / isDirty /
  // isExportRunning come from the RPC manifest (attachRpcWrappers below).
  // load + newBlank stay here — main.js broadcasts xleth:project-loaded and
  // restarts autosave for them, so they are not pure pass-throughs. The
  // xleth:dialog:* wrappers own Electron dialogs; exportZip / getSourceThumbnail
  // are handled outside project.js.
  project: {
    load:               (dir)       => invoke('xleth:project:load', dir),
    openNewProjectDialog: ()        => invoke('xleth:dialog:newProject'),
    openProjectDialog:   ()         => invoke('xleth:dialog:openProject'),
    openSaveAsDialog:    ()         => invoke('xleth:dialog:saveProjectAs'),
    openImportDialog:   ()          => invoke('xleth:dialog:importSources'),
    locateMediaDialog:  (displayName) => invoke('xleth:dialog:locateMedia', displayName),
    exportZip:          (opts)      => invoke('xleth:project:exportZip', opts),
    onZipExportProgress: (cb) => {
      const h = (_e, data) => cb(data);
      ipcRenderer.on('zip-export:progress', h);
      return () => ipcRenderer.removeListener('zip-export:progress', h);
    },
    getSourceThumbnail: (filePath, duration) => invoke('xleth:project:getSourceThumbnail', filePath, duration),
    newBlank:           ()          => invoke('xleth:project:newBlank'),
  },

  // ── Autosave ──────────────────────────────────────────────────────────────
  autosave: {
    restart: () => invoke('xleth:autosave:restart'),
  },

  // ── Phase 1: timeline ─────────────────────────────────────────────────────
  timeline: {
    // getBPM / setBPM / getTempoLocked and the timeline query + single-entity
    // mutation surface come from the RPC manifest (attachRpcWrappers below). The
    // region / syllable / pattern / pattern-block / single-note pass-throughs and
    // fsc.parse also come from the manifest now (S1 slice 4). Still hand-written
    // here: addClipsBatch / spliceClipsAtPlayhead and the *Batch note ops (batch
    // ops), plus autoTrimClip (thresholdDb=-54) and previewNote (velocity=0.8) —
    // their preload defaults would be lost by the generic manifest wrapper.
    // See docs/rpc-manifest.md.
    addClipsBatch:    (clips)               => invoke('xleth:timeline:addClipsBatch', clips),
    autoTrimClip:            (id, thresholdDb=-54) => invoke('xleth:timeline:autoTrimClip', id, thresholdDb),
    spliceClipsAtPlayhead:   (entries)             => invoke('xleth:timeline:spliceClipsAtPlayhead', entries),
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
    // ── Patterns / regions / notes ───────────────────────────────────────
    // The region, pattern, pattern-block and single-note pass-throughs (and
    // fsc.parse) come from the RPC manifest (attachRpcWrappers below, S1 slice
    // 4). Only the batch ops and previewNote (velocity=0.8 default) stay here.
    moveNotesBatch:         (patternId, moves)                  => invoke('xleth:timeline:moveNotesBatch', patternId, moves),
    addNotesBatch:          (patternId, notes)                  => invoke('xleth:timeline:addNotesBatch', patternId, notes),
    quantizeClipsBatch:     (specs)                             => invoke('xleth:timeline:quantizeClipsBatch', specs),
    resizeNotesBatch:       (patternId, resizes)                => invoke('xleth:timeline:resizeNotesBatch', patternId, resizes),
    previewNote:            (patternId, pitch, velocity=0.8)    => invoke('xleth:timeline:previewNote', patternId, pitch, velocity),
  },

  // ── Phase 1: undo ─────────────────────────────────────────────────────────
  // undo.* (undo/redo/canUndo/canRedo/get{Undo,Redo}Description) come entirely
  // from the RPC manifest (attachRpcWrappers below).

  // ── Phase 1: transport ────────────────────────────────────────────────────
  transport: {
    play:     ()        => invoke('xleth:play'),
    stop:     ()        => invoke('xleth:stop'),
    pause:    ()        => invoke('xleth:pause'),
    // seek comes from the RPC manifest (attachRpcWrappers below).
    getState: ()        => invoke('xleth:transportState'),
  },

  // ── Preview-proxy build status ─────────────────────────────────────────────
  // Read-only progress for the background proxy transcodes that warm up smooth
  // preview. getStatus() resolves to { pending, inFlight, completed, total };
  // wait for pending===0 after opening a project before the first Play so the
  // first playback is smooth instead of decoding the slow original source.
  proxy: {
    getStatus: () => invoke('xleth:proxy:getStatus'),
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
  // Most audio wrappers (loadSample, mapRegionToSample, loadSourceRegion, peak
  // meters, realtime-diagnostics reset/get, performance telemetry, mixer
  // volume/pan/spread + master volume, output-device get/set) come from the RPC
  // manifest (attachRpcWrappers below, S1 slice 5). Left hand-written here:
  // setRealtimeDiagnosticsEnabled (coerces !!enabled) and captureAudioPerformanceReport
  // (main-process supplies a userDataPath outputDir default).
  audio: {
    triggerSample:     (id, vel)            => invoke('xleth:trigger', id, vel),
    setRealtimeDiagnosticsEnabled: (enabled) => invoke('xleth:audio:setRealtimeDiagnosticsEnabled', !!enabled),
    captureAudioPerformanceReport: (options) => invoke('xleth:audio:captureAudioPerformanceReport', options || {}),
    // Replaced by WaveformMipmap N-API bindings — see window.xleth.waveform
    // getWaveformData / getWaveformRegion removed (Pipeline A)
    // Sample Selector: detect root note from WAV smpl chunk
    detectRootNote:    (filePath) => invoke('xleth:audio:detectRootNote', filePath),
    // ── SourcePlayer (Sample Picker audio preview via C++ engine) ────────
    loadSource:        (filePath) => invoke('xleth:audio:loadSource', filePath),
    playSource:        (startTime) => invoke('xleth:audio:playSource', startTime),
    playRegionPreview: (startTime, endTime) => invoke('xleth:audio:playRegionPreview', startTime, endTime),
    pauseSource:       ()          => invoke('xleth:audio:pauseSource'),
    resumeSource:      ()          => invoke('xleth:audio:resumeSource'),
    seekSource:        (time)      => invoke('xleth:audio:seekSource', time),
    stopSource:        ()          => invoke('xleth:audio:stopSource'),
    getSourcePosition: ()          => invoke('xleth:audio:getSourcePosition'),
    isSourcePlaying:   ()          => invoke('xleth:audio:isSourcePlaying'),
    unloadSource:      ()          => invoke('xleth:audio:unloadSource'),
    // ── Output device selection (get/set come from the RPC manifest, S1 slice 5) ──
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
    // ── P3: Effect Chain + parameter/meter + EQ/SmartBalance/Waveshaper ──
    // Migrated to ui/rpc-manifest.js (AUDIT.md S1 slice 6) — attachRpcWrappers
    // adds them to this namespace. Only the dynamics-viz pair stays literal:
    // its main-process handlers coerce args (!!enabled / maxBuckets|0).
    // ── Effect visualization (dynamics; binary ArrayBuffer payload) ─
    setEffectVisualizationEnabled: (trackId, nodeId, enabled) =>
      invoke('xleth:audio:setEffectVisualizationEnabled', trackId, nodeId, enabled),
    drainEffectVizFrames:          (trackId, nodeId, maxBuckets) =>
      invoke('xleth:audio:drainEffectVizFrames', trackId, nodeId, maxBuckets),
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
    // FXG.4-a: graph-owned effect parameter descriptors (normalized [0,1]).
    // Prefer stable (trackId, effectInstanceId, parameterId) identity; engine
    // node ids are never surfaced to the renderer here.
    getGraphEffectParameters:        (trackId, effectInstanceId)                          => invoke('xleth:audio:getGraphEffectParameters', trackId, effectInstanceId),
    getGraphEffectParameterValue:    (trackId, effectInstanceId, parameterId)             => invoke('xleth:audio:getGraphEffectParameterValue', trackId, effectInstanceId, parameterId),
    setGraphEffectParameterNormalized:(trackId, effectInstanceId, parameterId, value)     => invoke('xleth:audio:setGraphEffectParameterNormalized', trackId, effectInstanceId, parameterId, value),
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
    // getFrameBuffer / getFrameRGBA come from the RPC manifest (attachRpcWrappers below)
    // Open the Windows named-shared-memory region the engine writes frames
    // into. Zero-copy: renderer reads pixels directly via typed-array views.
    // Returns { buffer: ArrayBuffer, meta: {name, width, height, bufferSize, indexOffset, totalSize} }
    // or null if the engine hasn't initialized the shm yet.
    openFrameShm:   () => openFrameShm(),
    // FrameServer: open/close a decoder for a source (fast native path)
    openSource:     (id)    => invoke('xleth:video:openSource', id),
    closeSource:    (id)    => invoke('xleth:video:closeSource', id),
    requestPreviewFrameAtTimelinePosition: (position) =>
        invoke('xleth:video:requestPreviewFrameAtTimelinePosition', position),
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
    // Opt-in pixel-content verification flags, read from the environment the
    // app was launched with. The renderer (VideoPreview) uses `pixels` to gate
    // the (expensive) per-frame WebGL pixel-stat computation so there is zero
    // overhead in a normal run. Mirrors the native XLETH_VISUAL_DIAG_* gates.
    visualPixelDiag: {
      pixels: !!(process.env.XLETH_VISUAL_DIAG_PIXELS &&
                 process.env.XLETH_VISUAL_DIAG_PIXELS !== '0'),
      dumpFrames: !!(process.env.XLETH_VISUAL_DIAG_DUMP_FRAMES &&
                     process.env.XLETH_VISUAL_DIAG_DUMP_FRAMES !== '0'),
    },
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

  // Workspace backdrop state
  backdrop: {
    get current() { return backdropCurrent },
    getState: async () => {
      backdropCurrent = normalizeBackdropState(await invoke('xleth:backdrop:getState'));
      return backdropCurrent;
    },
    onModeChanged: (cb) => {
      const h = (_e, state) => {
        backdropCurrent = normalizeBackdropState(state);
        cb(backdropCurrent);
      };
      ipcRenderer.on('xleth:backdrop:modeChanged', h);
      return () => ipcRenderer.removeListener('xleth:backdrop:modeChanged', h);
    },
    chooseImage: async () => {
      backdropCurrent = normalizeBackdropState(await invoke('xleth:backdrop:chooseImage'));
      return backdropCurrent;
    },
    chooseVideo: async () => {
      backdropCurrent = normalizeBackdropState(await invoke('xleth:backdrop:chooseVideo'));
      return backdropCurrent;
    },
    setMedia: async (settings) => {
      backdropCurrent = normalizeBackdropState(await invoke('xleth:backdrop:setMedia', settings));
      return backdropCurrent;
    },
  },

  // Window layout (persisted to userData/layout.json)
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
    openExternal:     (url)  => shell.openExternal(url),
  },

  // ── Quick Launchers ────────────────────────────────────────────────────────
  launcher: {
    chooseExe:     ()        => invoke('xleth:launcher:chooseExe'),
    choosePng:     ()        => invoke('xleth:launcher:choosePng'),
    spawnDetached: (exePath) => invoke('xleth:launcher:spawn', exePath),
    // Pure path transform — mirrors buildXlethMediaUrl() in main.js
    buildIconUrl: (filePath) => {
      if (!filePath) return null
      const normalised = filePath.replace(/\\/g, '/')
      const m = normalised.match(/^([a-zA-Z]):\/(.*)$/)
      if (m) {
        return 'xleth-media://' + m[1].toLowerCase() + '/' +
          m[2].split('/').map(encodeURIComponent).join('/')
      }
      return 'xleth-media:///' + normalised.split('/').map(encodeURIComponent).join('/')
    },
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

  // ── Update notifier ───────────────────────────────────────────────────────
  onUpdateAvailable: (callback) => {
    const h = (_e, data) => callback(data);
    ipcRenderer.on('xleth:update-available', h);
    return () => ipcRenderer.removeListener('xleth:update-available', h);
  },
});

// ── Manifest-generated RPC wrappers (AUDIT.md S1) ─────────────────────────────
// Pure pass-through wrappers whose names live in ui/rpc-manifest.js — one entry
// there wires preload, the ipcMain channel, the worker call, the addon export
// and the engine dispatch. Hand-written wrappers above are deleted as their
// methods migrate. See docs/rpc-manifest.md.
attachRpcWrappers(window.xleth, invoke);

