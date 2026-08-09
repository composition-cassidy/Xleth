'use strict';

// ── RPC method manifest — single source of truth for the RPC surface ─────────
// AUDIT.md S1. One entry here wires all five layers that used to be
// hand-maintained per method: the preload wrapper, the ipcMain channel, the
// worker method string, the addon export, and the engine dispatch line.
// See docs/rpc-manifest.md for the design and the migration plan.
//
// Consumed by:
//   ui/preload.js                    — attachRpcWrappers() builds window.xleth.* wrappers
//   ui/electron-main/rpc-registry.js — registers ipcMain.handle() channels
//   scripts/generate-rpc-registries.js — emits bridge/src/XlethRpcExports.inc and
//                                        engine/src/XlethRpcDispatch.inc (checked in;
//                                        staleness enforced by bridge/test_rpc_manifest.js)
//
// Entry fields:
//   method   — worker message string == addon export name == engine dispatch name
//   channels — ipcMain.handle channel(s) routed to this method (phase0 legacy
//              surfaces map two channels to one method, e.g. getFrameRGBA)
//   api      — window.xleth wrapper path(s) → which channel each invokes
//   handler  — C++ handler symbol inside engine/src/XlethEngineService.cpp
//   returns  — 'value' | 'void': shape of the generated dispatch wrapper
//   binary   — null | 'frame' | 'midiImport'. Binary transport handling stays
//              EXPLICIT in ui/addon-worker.js (frames as Buffer sends, ArrayBuffer
//              conversion); this field only declares which methods those explicit
//              branches apply to. Do not genericize the binary paths.
//   graph    — (optional) 'track' | 'master'. Declares a graph mutation: after
//              the worker call resolves, main.js broadcasts xleth:graph:changed
//              to every renderer, keyed by trackKey (first IPC arg is the
//              trackId) or masterKey ('master'). rpc-registry.js maps the value
//              to the canonical key fn (exported by electron-main/effects.js)
//              and registers through main.js's graphHandler instead of plain
//              safeHandler. Like `binary`, this is declarative metadata — the
//              broadcast logic itself stays in main.js, unchanged. Absent
//              (or null) means plain pass-through.
//
// Methods with per-call logic in main.js (arg fixups, dialogs, progress
// intervals) do NOT belong here — only pure pass-throughs migrate. The one
// sanctioned exception is the `graph` broadcast above: it is a fixed,
// declarative post-call side effect shared by every chain/wire mutation, not
// per-method business logic.

const METHODS = [
  {
    method: 'timeline_getBPM',
    channels: ['xleth:timeline:getBPM'],
    api: { 'timeline.getBPM': 'xleth:timeline:getBPM' },
    handler: 'Timeline_GetBPM',
    returns: 'value',
    binary: null,
  },
  {
    method: 'timeline_getTempoLocked',
    channels: ['xleth:timeline:getTempoLocked'],
    api: { 'timeline.getTempoLocked': 'xleth:timeline:getTempoLocked' },
    handler: 'Timeline_GetTempoLocked',
    returns: 'value',
    binary: null,
  },
  {
    method: 'timeline_setBPM',
    channels: ['xleth:timeline:setBPM'],
    api: { 'timeline.setBPM': 'xleth:timeline:setBPM' },
    handler: 'Timeline_SetBPM',
    returns: 'void',
    binary: null,
  },
  {
    // Phase 0 legacy frame fetch (per-call RGBA over IPC; the hot path is the
    // shm mapping, not this). Two legacy channels and four wrapper paths all
    // funnel into the one worker method — its Buffer 'frame' send stays
    // hand-written in addon-worker.js.
    method: 'getFrameRGBA',
    channels: ['xleth:currentFrame', 'xleth:frameRGBA'],
    api: {
      'getCurrentFrame':      'xleth:currentFrame',
      'getFrameRGBA':         'xleth:frameRGBA',
      'video.getFrameBuffer': 'xleth:currentFrame',
      'video.getFrameRGBA':   'xleth:frameRGBA',
    },
    handler: 'GetCurrentFrameRGBA',
    returns: 'value',
    binary: 'frame',
  },
  // ── Undo / redo (AUDIT.md S1 slice 2) ──
  {
    method: 'undo_undo',
    channels: ['xleth:undo:undo'],
    api: { 'undo.undo': 'xleth:undo:undo' },
    handler: 'Undo_Undo',
    returns: 'value',
    binary: null,
  },
  {
    method: 'undo_redo',
    channels: ['xleth:undo:redo'],
    api: { 'undo.redo': 'xleth:undo:redo' },
    handler: 'Undo_Redo',
    returns: 'value',
    binary: null,
  },
  {
    method: 'undo_canUndo',
    channels: ['xleth:undo:canUndo'],
    api: { 'undo.canUndo': 'xleth:undo:canUndo' },
    handler: 'Undo_CanUndo',
    returns: 'value',
    binary: null,
  },
  {
    method: 'undo_canRedo',
    channels: ['xleth:undo:canRedo'],
    api: { 'undo.canRedo': 'xleth:undo:canRedo' },
    handler: 'Undo_CanRedo',
    returns: 'value',
    binary: null,
  },
  {
    method: 'undo_getUndoDescription',
    channels: ['xleth:undo:getUndoDescription'],
    api: { 'undo.getUndoDescription': 'xleth:undo:getUndoDescription' },
    handler: 'Undo_GetUndoDescription',
    returns: 'value',
    binary: null,
  },
  {
    method: 'undo_getRedoDescription',
    channels: ['xleth:undo:getRedoDescription'],
    api: { 'undo.getRedoDescription': 'xleth:undo:getRedoDescription' },
    handler: 'Undo_GetRedoDescription',
    returns: 'value',
    binary: null,
  },

  // ── Phase 0 transport / status compatibility (AUDIT.md S1) ───────────────
  {
    method: 'play',
    channels: ['xleth:play'],
    api: { play: 'xleth:play', 'transport.play': 'xleth:play' },
    handler: 'Play',
    returns: 'void',
    binary: null,
  },
  {
    method: 'stop',
    channels: ['xleth:stop'],
    api: { stop: 'xleth:stop', 'transport.stop': 'xleth:stop' },
    handler: 'Stop',
    returns: 'void',
    binary: null,
  },
  {
    method: 'pause',
    channels: ['xleth:pause'],
    api: { pause: 'xleth:pause', 'transport.pause': 'xleth:pause' },
    handler: 'Pause',
    returns: 'void',
    binary: null,
  },
  {
    method: 'getTransportState',
    channels: ['xleth:transportState'],
    api: {
      getTransportState: 'xleth:transportState',
      'transport.getState': 'xleth:transportState',
    },
    handler: 'GetTransportState',
    returns: 'value',
    binary: null,
  },
  {
    method: 'proxy_getStatus',
    channels: ['xleth:proxy:getStatus'],
    api: { 'proxy.getStatus': 'xleth:proxy:getStatus' },
    handler: 'Proxy_GetStatus',
    returns: 'value',
    binary: null,
  },
  {
    method: 'posterPrepass_getStatus',
    channels: ['xleth:posterPrepass:getStatus'],
    api: { 'posterPrepass.getStatus': 'xleth:posterPrepass:getStatus' },
    handler: 'PosterPrepass_GetStatus',
    returns: 'value',
    binary: null,
  },
  {
    method: 'posterPrepass_skip',
    channels: ['xleth:posterPrepass:skip'],
    api: { 'posterPrepass.skip': 'xleth:posterPrepass:skip' },
    handler: 'PosterPrepass_Skip',
    returns: 'void',
    binary: null,
  },
  {
    method: 'getSyncStats',
    channels: ['xleth:syncStats'],
    api: { getSyncStats: 'xleth:syncStats', 'sync.getStats': 'xleth:syncStats' },
    handler: 'GetSyncStats',
    returns: 'value',
    binary: null,
  },
  {
    method: 'setVideoResolution',
    channels: ['xleth:setVideoResolution'],
    api: {
      setVideoResolution: 'xleth:setVideoResolution',
      'video.setResolution': 'xleth:setVideoResolution',
    },
    handler: 'SetVideoResolution',
    returns: 'void',
    binary: null,
  },

  // ── Transport (Phase 1 extension) (AUDIT.md S1 slice 2) ──────────────────
  {
    method: 'transport_seek',
    channels: ['xleth:transport:seek'],
    api: { 'transport.seek': 'xleth:transport:seek' },
    handler: 'Transport_Seek',
    returns: 'void',
    binary: null,
  },

  // ── Timeline queries + single-entity mutations (AUDIT.md S1 slice 2) ──
  {
    method: 'timeline_getDeclickMs',
    channels: ['xleth:timeline:getDeclickMs'],
    api: { 'timeline.getDeclickMs': 'xleth:timeline:getDeclickMs' },
    handler: 'Timeline_GetDeclickMs',
    returns: 'value',
    binary: null,
  },
  {
    method: 'timeline_getGlobalStretchMethod',
    channels: ['xleth:timeline:getGlobalStretchMethod'],
    api: { 'timeline.getGlobalStretchMethod': 'xleth:timeline:getGlobalStretchMethod' },
    handler: 'Timeline_GetGlobalStretchMethod',
    returns: 'value',
    binary: null,
  },
  {
    method: 'timeline_getSources',
    channels: ['xleth:timeline:getSources'],
    api: { 'timeline.getSources': 'xleth:timeline:getSources' },
    handler: 'Timeline_GetSources',
    returns: 'value',
    binary: null,
  },
  {
    method: 'timeline_getRegions',
    channels: ['xleth:timeline:getRegions'],
    api: { 'timeline.getRegions': 'xleth:timeline:getRegions' },
    handler: 'Timeline_GetRegions',
    returns: 'value',
    binary: null,
  },
  {
    method: 'timeline_getRegionsByLabel',
    channels: ['xleth:timeline:getRegionsByLabel'],
    api: { 'timeline.getRegionsByLabel': 'xleth:timeline:getRegionsByLabel' },
    handler: 'Timeline_GetRegionsByLabel',
    returns: 'value',
    binary: null,
  },
  {
    method: 'timeline_getTracks',
    channels: ['xleth:timeline:getTracks'],
    api: { 'timeline.getTracks': 'xleth:timeline:getTracks' },
    handler: 'Timeline_GetTracks',
    returns: 'value',
    binary: null,
  },
  {
    method: 'timeline_getTrackLayout',
    channels: ['xleth:timeline:getTrackLayout'],
    api: { 'timeline.getTrackLayout': 'xleth:timeline:getTrackLayout' },
    handler: 'Timeline_GetTrackLayout',
    returns: 'value',
    binary: null,
  },
  {
    method: 'timeline_getClips',
    channels: ['xleth:timeline:getClips'],
    api: { 'timeline.getClips': 'xleth:timeline:getClips' },
    handler: 'Timeline_GetClips',
    returns: 'value',
    binary: null,
  },
  {
    method: 'timeline_getClipsOnTrack',
    channels: ['xleth:timeline:getClipsOnTrack'],
    api: { 'timeline.getClipsOnTrack': 'xleth:timeline:getClipsOnTrack' },
    handler: 'Timeline_GetClipsOnTrack',
    returns: 'value',
    binary: null,
  },
  {
    method: 'timeline_getClipsInRange',
    channels: ['xleth:timeline:getClipsInRange'],
    api: { 'timeline.getClipsInRange': 'xleth:timeline:getClipsInRange' },
    handler: 'Timeline_GetClipsInRange',
    returns: 'value',
    binary: null,
  },
  {
    method: 'timeline_getLoopRegion',
    channels: ['xleth:timeline:getLoopRegion'],
    api: { 'timeline.getLoopRegion': 'xleth:timeline:getLoopRegion' },
    handler: 'Timeline_GetLoopRegion',
    returns: 'value',
    binary: null,
  },
  {
    method: 'timeline_getRouting',
    channels: ['xleth:timeline:getRouting'],
    api: { 'timeline.getRouting': 'xleth:timeline:getRouting' },
    handler: 'Timeline_GetRouting',
    returns: 'value',
    binary: null,
  },
  {
    method: 'timeline_getPreviewResolutionScale',
    channels: ['xleth:timeline:getPreviewResolutionScale'],
    api: { 'timeline.getPreviewResolutionScale': 'xleth:timeline:getPreviewResolutionScale' },
    handler: 'Timeline_GetPreviewResolutionScale',
    returns: 'value',
    binary: null,
  },
  {
    method: 'timeline_getPreviewEffectsBypass',
    channels: ['xleth:timeline:getPreviewEffectsBypass'],
    api: { 'timeline.getPreviewEffectsBypass': 'xleth:timeline:getPreviewEffectsBypass' },
    handler: 'Timeline_GetPreviewEffectsBypass',
    returns: 'value',
    binary: null,
  },
  {
    method: 'timeline_getPreviewPosterMode',
    channels: ['xleth:timeline:getPreviewPosterMode'],
    api: { 'timeline.getPreviewPosterMode': 'xleth:timeline:getPreviewPosterMode' },
    handler: 'Timeline_GetPreviewPosterMode',
    returns: 'value',
    binary: null,
  },
  {
    method: 'timeline_getVisualEffectChain',
    channels: ['xleth:timeline:getVisualEffectChain'],
    api: { 'timeline.getVisualEffectChain': 'xleth:timeline:getVisualEffectChain' },
    handler: 'Timeline_GetVisualEffectChain',
    returns: 'value',
    binary: null,
  },
  {
    method: 'timeline_setDeclickMs',
    channels: ['xleth:timeline:setDeclickMs'],
    api: { 'timeline.setDeclickMs': 'xleth:timeline:setDeclickMs' },
    handler: 'Timeline_SetDeclickMs',
    returns: 'void',
    binary: null,
  },
  {
    method: 'timeline_setGlobalStretchMethod',
    channels: ['xleth:timeline:setGlobalStretchMethod'],
    api: { 'timeline.setGlobalStretchMethod': 'xleth:timeline:setGlobalStretchMethod' },
    handler: 'Timeline_SetGlobalStretchMethod',
    returns: 'void',
    binary: null,
  },
  {
    method: 'timeline_setLoopRegion',
    channels: ['xleth:timeline:setLoopRegion'],
    api: { 'timeline.setLoopRegion': 'xleth:timeline:setLoopRegion' },
    handler: 'Timeline_SetLoopRegion',
    returns: 'void',
    binary: null,
  },
  {
    method: 'timeline_setTempoLocked',
    channels: ['xleth:timeline:setTempoLocked'],
    api: { 'timeline.setTempoLocked': 'xleth:timeline:setTempoLocked' },
    handler: 'Timeline_SetTempoLocked',
    returns: 'void',
    binary: null,
  },
  {
    method: 'timeline_addTrack',
    channels: ['xleth:timeline:addTrack'],
    api: { 'timeline.addTrack': 'xleth:timeline:addTrack' },
    handler: 'Timeline_AddTrack',
    returns: 'value',
    binary: null,
  },
  {
    method: 'timeline_removeTrack',
    channels: ['xleth:timeline:removeTrack'],
    api: { 'timeline.removeTrack': 'xleth:timeline:removeTrack' },
    handler: 'Timeline_RemoveTrack',
    returns: 'void',
    binary: null,
  },
  {
    method: 'timeline_setTrackMuted',
    channels: ['xleth:timeline:setTrackMuted'],
    api: { 'timeline.setTrackMuted': 'xleth:timeline:setTrackMuted' },
    handler: 'Timeline_SetTrackMuted',
    returns: 'void',
    binary: null,
  },
  {
    method: 'timeline_setTrackVisualOnly',
    channels: ['xleth:timeline:setTrackVisualOnly'],
    api: { 'timeline.setTrackVisualOnly': 'xleth:timeline:setTrackVisualOnly' },
    handler: 'Timeline_SetTrackVisualOnly',
    returns: 'void',
    binary: null,
  },
  {
    method: 'timeline_setTrackSolo',
    channels: ['xleth:timeline:setTrackSolo'],
    api: { 'timeline.setTrackSolo': 'xleth:timeline:setTrackSolo' },
    handler: 'Timeline_SetTrackSolo',
    returns: 'void',
    binary: null,
  },
  {
    method: 'timeline_setTrackOrder',
    channels: ['xleth:timeline:setTrackOrder'],
    api: { 'timeline.setTrackOrder': 'xleth:timeline:setTrackOrder' },
    handler: 'Timeline_SetTrackOrder',
    returns: 'value',
    binary: null,
  },
  {
    method: 'timeline_setTrackLayout',
    channels: ['xleth:timeline:setTrackLayout'],
    api: { 'timeline.setTrackLayout': 'xleth:timeline:setTrackLayout' },
    handler: 'Timeline_SetTrackLayout',
    returns: 'value',
    binary: null,
  },
  {
    method: 'timeline_createTrackFolder',
    channels: ['xleth:timeline:createTrackFolder'],
    api: { 'timeline.createTrackFolder': 'xleth:timeline:createTrackFolder' },
    handler: 'Timeline_CreateTrackFolder',
    returns: 'value',
    binary: null,
  },
  {
    method: 'timeline_setTrackFolderName',
    channels: ['xleth:timeline:setTrackFolderName'],
    api: { 'timeline.setTrackFolderName': 'xleth:timeline:setTrackFolderName' },
    handler: 'Timeline_SetTrackFolderName',
    returns: 'value',
    binary: null,
  },
  {
    method: 'timeline_setTrackFolderCollapsed',
    channels: ['xleth:timeline:setTrackFolderCollapsed'],
    api: { 'timeline.setTrackFolderCollapsed': 'xleth:timeline:setTrackFolderCollapsed' },
    handler: 'Timeline_SetTrackFolderCollapsed',
    returns: 'value',
    binary: null,
  },
  {
    method: 'timeline_removeTrackFolder',
    channels: ['xleth:timeline:removeTrackFolder'],
    api: { 'timeline.removeTrackFolder': 'xleth:timeline:removeTrackFolder' },
    handler: 'Timeline_RemoveTrackFolder',
    returns: 'value',
    binary: null,
  },
  {
    method: 'timeline_setTrackOutputRoute',
    channels: ['xleth:timeline:setTrackOutputRoute'],
    api: { 'timeline.setTrackOutputRoute': 'xleth:timeline:setTrackOutputRoute' },
    handler: 'Timeline_SetTrackOutputRoute',
    returns: 'value',
    binary: null,
  },
  {
    method: 'timeline_addSidechainRoute',
    channels: ['xleth:timeline:addSidechainRoute'],
    api: { 'timeline.addSidechainRoute': 'xleth:timeline:addSidechainRoute' },
    handler: 'Timeline_AddSidechainRoute',
    returns: 'value',
    binary: null,
  },
  {
    method: 'timeline_removeSidechainRoute',
    channels: ['xleth:timeline:removeSidechainRoute'],
    api: { 'timeline.removeSidechainRoute': 'xleth:timeline:removeSidechainRoute' },
    handler: 'Timeline_RemoveSidechainRoute',
    returns: 'value',
    binary: null,
  },
  {
    method: 'timeline_setSidechainRouteParams',
    channels: ['xleth:timeline:setSidechainRouteParams'],
    api: { 'timeline.setSidechainRouteParams': 'xleth:timeline:setSidechainRouteParams' },
    handler: 'Timeline_SetSidechainRouteParams',
    returns: 'value',
    binary: null,
  },
  {
    method: 'timeline_setTrackName',
    channels: ['xleth:timeline:setTrackName'],
    api: { 'timeline.setTrackName': 'xleth:timeline:setTrackName' },
    handler: 'Timeline_SetTrackName',
    returns: 'void',
    binary: null,
  },
  {
    method: 'timeline_setTrackFxMode',
    channels: ['xleth:timeline:setTrackFxMode'],
    api: { 'timeline.setTrackFxMode': 'xleth:timeline:setTrackFxMode' },
    handler: 'Timeline_SetTrackFxMode',
    returns: 'value',
    binary: null,
  },
  {
    method: 'timeline_setTrackGraphState',
    channels: ['xleth:timeline:setTrackGraphState'],
    api: { 'timeline.setTrackGraphState': 'xleth:timeline:setTrackGraphState' },
    handler: 'Timeline_SetTrackGraphState',
    returns: 'value',
    binary: null,
  },
  {
    method: 'timeline_setPatternName',
    channels: ['xleth:timeline:setPatternName'],
    api: { 'timeline.setPatternName': 'xleth:timeline:setPatternName' },
    handler: 'Timeline_SetPatternName',
    returns: 'void',
    binary: null,
  },
  {
    method: 'timeline_setPatternRegion',
    channels: ['xleth:timeline:setPatternRegion'],
    api: { 'timeline.setPatternRegion': 'xleth:timeline:setPatternRegion' },
    handler: 'Timeline_SetPatternRegion',
    returns: 'void',
    binary: null,
  },
  {
    method: 'timeline_convertToPatternTrack',
    channels: ['xleth:timeline:convertToPatternTrack'],
    api: { 'timeline.convertToPatternTrack': 'xleth:timeline:convertToPatternTrack' },
    handler: 'Timeline_ConvertToPatternTrack',
    returns: 'void',
    binary: null,
  },
  {
    method: 'timeline_convertToClipTrack',
    channels: ['xleth:timeline:convertToClipTrack'],
    api: { 'timeline.convertToClipTrack': 'xleth:timeline:convertToClipTrack' },
    handler: 'Timeline_ConvertToClipTrack',
    returns: 'void',
    binary: null,
  },
  {
    method: 'timeline_setVideoFlipConfig',
    channels: ['xleth:timeline:setVideoFlipConfig'],
    api: { 'timeline.setVideoFlipConfig': 'xleth:timeline:setVideoFlipConfig' },
    handler: 'Timeline_SetVideoFlipConfig',
    returns: 'void',
    binary: null,
  },
  {
    method: 'timeline_setVideoHoldLastFrame',
    channels: ['xleth:timeline:setVideoHoldLastFrame'],
    api: { 'timeline.setVideoHoldLastFrame': 'xleth:timeline:setVideoHoldLastFrame' },
    handler: 'Timeline_SetVideoHoldLastFrame',
    returns: 'void',
    binary: null,
  },
  {
    method: 'timeline_setVideoHoldLastFrameThreshold',
    channels: ['xleth:timeline:setVideoHoldLastFrameThreshold'],
    api: { 'timeline.setVideoHoldLastFrameThreshold': 'xleth:timeline:setVideoHoldLastFrameThreshold' },
    handler: 'Timeline_SetVideoHoldLastFrameThreshold',
    returns: 'void',
    binary: null,
  },
  {
    method: 'timeline_setTrackCornerRadius',
    channels: ['xleth:timeline:setTrackCornerRadius'],
    api: { 'timeline.setTrackCornerRadius': 'xleth:timeline:setTrackCornerRadius' },
    handler: 'Timeline_SetTrackCornerRadius',
    returns: 'void',
    binary: null,
  },
  {
    method: 'timeline_setTrackGapScaleOverride',
    channels: ['xleth:timeline:setTrackGapScaleOverride'],
    api: { 'timeline.setTrackGapScaleOverride': 'xleth:timeline:setTrackGapScaleOverride' },
    handler: 'Timeline_SetTrackGapScaleOverride',
    returns: 'void',
    binary: null,
  },
  {
    method: 'timeline_setTrackSubdivisionFactor',
    channels: ['xleth:timeline:setTrackSubdivisionFactor'],
    api: { 'timeline.setTrackSubdivisionFactor': 'xleth:timeline:setTrackSubdivisionFactor' },
    handler: 'Timeline_SetTrackSubdivisionFactor',
    returns: 'void',
    binary: null,
  },
  {
    method: 'timeline_setTrackColor',
    channels: ['xleth:timeline:setTrackColor'],
    api: { 'timeline.setTrackColor': 'xleth:timeline:setTrackColor' },
    handler: 'Timeline_SetTrackColor',
    returns: 'void',
    binary: null,
  },
  {
    method: 'timeline_setTrackBounceSettings',
    channels: ['xleth:timeline:setTrackBounceSettings'],
    api: { 'timeline.setTrackBounceSettings': 'xleth:timeline:setTrackBounceSettings' },
    handler: 'Timeline_SetTrackBounceSettings',
    returns: 'void',
    binary: null,
  },
  {
    method: 'timeline_setTrackZoomPanRotSettings',
    channels: ['xleth:timeline:setTrackZoomPanRotSettings'],
    api: { 'timeline.setTrackZoomPanRotSettings': 'xleth:timeline:setTrackZoomPanRotSettings' },
    handler: 'Timeline_SetTrackZoomPanRotSettings',
    returns: 'void',
    binary: null,
  },
  {
    method: 'timeline_setTrackPingPongSettings',
    channels: ['xleth:timeline:setTrackPingPongSettings'],
    api: { 'timeline.setTrackPingPongSettings': 'xleth:timeline:setTrackPingPongSettings' },
    handler: 'Timeline_SetTrackPingPongSettings',
    returns: 'void',
    binary: null,
  },
  {
    method: 'timeline_setTrackSlideNoteEffect',
    channels: ['xleth:timeline:setTrackSlideNoteEffect'],
    api: { 'timeline.setTrackSlideNoteEffect': 'xleth:timeline:setTrackSlideNoteEffect' },
    handler: 'Timeline_SetTrackSlideNoteEffect',
    returns: 'void',
    binary: null,
  },
  {
    method: 'timeline_setPreviewResolutionScale',
    channels: ['xleth:timeline:setPreviewResolutionScale'],
    api: { 'timeline.setPreviewResolutionScale': 'xleth:timeline:setPreviewResolutionScale' },
    handler: 'Timeline_SetPreviewResolutionScale',
    returns: 'void',
    binary: null,
  },
  {
    method: 'timeline_setPreviewEffectsBypass',
    channels: ['xleth:timeline:setPreviewEffectsBypass'],
    api: { 'timeline.setPreviewEffectsBypass': 'xleth:timeline:setPreviewEffectsBypass' },
    handler: 'Timeline_SetPreviewEffectsBypass',
    returns: 'void',
    binary: null,
  },
  {
    method: 'timeline_setPreviewPosterMode',
    channels: ['xleth:timeline:setPreviewPosterMode'],
    api: { 'timeline.setPreviewPosterMode': 'xleth:timeline:setPreviewPosterMode' },
    handler: 'Timeline_SetPreviewPosterMode',
    returns: 'void',
    binary: null,
  },
  {
    method: 'timeline_setNoteSlide',
    channels: ['xleth:timeline:setNoteSlide'],
    api: { 'timeline.setNoteSlide': 'xleth:timeline:setNoteSlide' },
    handler: 'Timeline_SetNoteSlide',
    returns: 'void',
    binary: null,
  },
  {
    method: 'timeline_addVisualEffect',
    channels: ['xleth:timeline:addVisualEffect'],
    api: { 'timeline.addVisualEffect': 'xleth:timeline:addVisualEffect' },
    handler: 'Timeline_AddVisualEffect',
    returns: 'value',
    binary: null,
  },
  {
    method: 'timeline_removeVisualEffect',
    channels: ['xleth:timeline:removeVisualEffect'],
    api: { 'timeline.removeVisualEffect': 'xleth:timeline:removeVisualEffect' },
    handler: 'Timeline_RemoveVisualEffect',
    returns: 'void',
    binary: null,
  },
  {
    method: 'timeline_reorderVisualEffect',
    channels: ['xleth:timeline:reorderVisualEffect'],
    api: { 'timeline.reorderVisualEffect': 'xleth:timeline:reorderVisualEffect' },
    handler: 'Timeline_ReorderVisualEffect',
    returns: 'void',
    binary: null,
  },
  {
    method: 'timeline_setVisualEffectParam',
    channels: ['xleth:timeline:setVisualEffectParam'],
    api: { 'timeline.setVisualEffectParam': 'xleth:timeline:setVisualEffectParam' },
    handler: 'Timeline_SetVisualEffectParam',
    returns: 'void',
    binary: null,
  },
  {
    method: 'timeline_setVisualEffectBypassed',
    channels: ['xleth:timeline:setVisualEffectBypassed'],
    api: { 'timeline.setVisualEffectBypassed': 'xleth:timeline:setVisualEffectBypassed' },
    handler: 'Timeline_SetVisualEffectBypassed',
    returns: 'void',
    binary: null,
  },
  {
    // Preview-only, non-undoable whole-chain mute for the chroma-key eyedropper
    // (ChainableEffectParams.jsx). Not persisted, not seen by export — see
    // Timeline::setVisualEffectChainPreviewMuted / FrameCollector's
    // applyPreviewEffectMute. Do not route this through UndoManager.
    method: 'timeline_setVisualEffectChainPreviewMuted',
    channels: ['xleth:timeline:setVisualEffectChainPreviewMuted'],
    api: { 'timeline.setVisualEffectChainPreviewMuted': 'xleth:timeline:setVisualEffectChainPreviewMuted' },
    handler: 'Timeline_SetVisualEffectChainPreviewMuted',
    returns: 'void',
    binary: null,
  },
  {
    method: 'timeline_setTrackVisualEffectChainOrder',
    channels: ['xleth:timeline:setTrackVisualEffectChainOrder'],
    api: { 'timeline.setTrackVisualEffectChainOrder': 'xleth:timeline:setTrackVisualEffectChainOrder' },
    handler: 'Timeline_SetTrackVisualEffectChainOrder',
    returns: 'void',
    binary: null,
  },
  {
    method: 'timeline_addClip',
    channels: ['xleth:timeline:addClip'],
    api: { 'timeline.addClip': 'xleth:timeline:addClip' },
    handler: 'Timeline_AddClip',
    returns: 'value',
    binary: null,
  },
  {
    method: 'timeline_removeClip',
    channels: ['xleth:timeline:removeClip'],
    api: { 'timeline.removeClip': 'xleth:timeline:removeClip' },
    handler: 'Timeline_RemoveClip',
    returns: 'void',
    binary: null,
  },
  {
    method: 'timeline_moveClip',
    channels: ['xleth:timeline:moveClip'],
    api: { 'timeline.moveClip': 'xleth:timeline:moveClip' },
    handler: 'Timeline_MoveClip',
    returns: 'void',
    binary: null,
  },
  {
    method: 'timeline_resizeClip',
    channels: ['xleth:timeline:resizeClip'],
    api: { 'timeline.resizeClip': 'xleth:timeline:resizeClip' },
    handler: 'Timeline_ResizeClip',
    returns: 'void',
    binary: null,
  },
  {
    method: 'timeline_resizeClipLeft',
    channels: ['xleth:timeline:resizeClipLeft'],
    api: { 'timeline.resizeClipLeft': 'xleth:timeline:resizeClipLeft' },
    handler: 'Timeline_ResizeClipLeft',
    returns: 'void',
    binary: null,
  },
  {
    method: 'timeline_stretchClip',
    channels: ['xleth:timeline:stretchClip'],
    api: { 'timeline.stretchClip': 'xleth:timeline:stretchClip' },
    handler: 'Timeline_StretchClip',
    returns: 'void',
    binary: null,
  },
  {
    method: 'timeline_stretchClipLeft',
    channels: ['xleth:timeline:stretchClipLeft'],
    api: { 'timeline.stretchClipLeft': 'xleth:timeline:stretchClipLeft' },
    handler: 'Timeline_StretchClipLeft',
    returns: 'void',
    binary: null,
  },
  {
    method: 'timeline_pitchShiftClip',
    channels: ['xleth:timeline:pitchShiftClip'],
    api: { 'timeline.pitchShiftClip': 'xleth:timeline:pitchShiftClip' },
    handler: 'Timeline_PitchShiftClip',
    returns: 'value',
    binary: null,
  },
  {
    method: 'timeline_reverseClip',
    channels: ['xleth:timeline:reverseClip'],
    api: { 'timeline.reverseClip': 'xleth:timeline:reverseClip' },
    handler: 'Timeline_ReverseClip',
    returns: 'value',
    binary: null,
  },
  {
    method: 'timeline_setClipParams',
    channels: ['xleth:timeline:setClipParams'],
    api: { 'timeline.setClipParams': 'xleth:timeline:setClipParams' },
    handler: 'Timeline_SetClipParams',
    returns: 'value',
    binary: null,
  },
  {
    method: 'timeline_beginClipControlEdit',
    channels: ['xleth:timeline:beginClipControlEdit'],
    api: { 'timeline.beginClipControlEdit': 'xleth:timeline:beginClipControlEdit' },
    handler: 'Timeline_BeginClipControlEdit',
    returns: 'value',
    binary: null,
  },
  {
    method: 'timeline_previewClipControlEdit',
    channels: ['xleth:timeline:previewClipControlEdit'],
    api: { 'timeline.previewClipControlEdit': 'xleth:timeline:previewClipControlEdit' },
    handler: 'Timeline_PreviewClipControlEdit',
    returns: 'value',
    binary: null,
  },
  {
    method: 'timeline_commitClipControlEdit',
    channels: ['xleth:timeline:commitClipControlEdit'],
    api: { 'timeline.commitClipControlEdit': 'xleth:timeline:commitClipControlEdit' },
    handler: 'Timeline_CommitClipControlEdit',
    returns: 'value',
    binary: null,
  },
  {
    method: 'timeline_cancelClipControlEdit',
    channels: ['xleth:timeline:cancelClipControlEdit'],
    api: { 'timeline.cancelClipControlEdit': 'xleth:timeline:cancelClipControlEdit' },
    handler: 'Timeline_CancelClipControlEdit',
    returns: 'value',
    binary: null,
  },
  {
    method: 'timeline_setClipModulation',
    channels: ['xleth:timeline:setClipModulation'],
    api: { 'timeline.setClipModulation': 'xleth:timeline:setClipModulation' },
    handler: 'Timeline_SetClipModulation',
    returns: 'value',
    binary: null,
  },

  // ── Project lifecycle (AUDIT.md S1 slice 3) ──
  // Pure engine pass-throughs from ui/electron-main/project.js. project.load /
  // project.newBlank are NOT here: they own per-call main-process logic (broadcast
  // xleth:project-loaded to all renderers + restartAutosaveTimer, and newBlank also
  // reads the settings default to build its arg). The xleth:dialog:* handlers own
  // Electron dialogs, not engine calls, and stay hand-written too. All engine
  // handlers below dispatch with the value shape (return Handler(info).raw()).
  {
    method: 'project_create',
    channels: ['xleth:project:create'],
    api: { 'project.create': 'xleth:project:create' },
    handler: 'Project_Create',
    returns: 'value',
    binary: null,
  },
  {
    method: 'project_save',
    channels: ['xleth:project:save'],
    api: { 'project.save': 'xleth:project:save' },
    handler: 'Project_Save',
    returns: 'value',
    binary: null,
  },
  {
    method: 'project_saveAs',
    channels: ['xleth:project:saveAs'],
    api: { 'project.saveAs': 'xleth:project:saveAs' },
    handler: 'Project_SaveAs',
    returns: 'value',
    binary: null,
  },
  {
    method: 'project_hasProjectDir',
    channels: ['xleth:project:hasProjectDir'],
    api: { 'project.hasProjectDir': 'xleth:project:hasProjectDir' },
    handler: 'Project_HasProjectDir',
    returns: 'value',
    binary: null,
  },
  {
    method: 'project_importSource',
    channels: ['xleth:project:importSource'],
    api: { 'project.importSource': 'xleth:project:importSource' },
    handler: 'Project_ImportSource',
    returns: 'value',
    binary: null,
  },
  {
    method: 'project_removeSource',
    channels: ['xleth:project:removeSource'],
    api: { 'project.removeSource': 'xleth:project:removeSource' },
    handler: 'Project_RemoveSource',
    returns: 'value',
    binary: null,
  },
  {
    method: 'project_validateMedia',
    channels: ['xleth:project:validateMedia'],
    api: { 'project.validateMedia': 'xleth:project:validateMedia' },
    handler: 'Project_ValidateMedia',
    returns: 'value',
    binary: null,
  },
  {
    method: 'project_relinkSource',
    channels: ['xleth:project:relinkSource'],
    api: { 'project.relinkSource': 'xleth:project:relinkSource' },
    handler: 'Project_RelinkSource',
    returns: 'value',
    binary: null,
  },
  {
    method: 'project_relinkRegionAudio',
    channels: ['xleth:project:relinkRegionAudio'],
    api: { 'project.relinkRegionAudio': 'xleth:project:relinkRegionAudio' },
    handler: 'Project_RelinkRegionAudio',
    returns: 'value',
    binary: null,
  },
  {
    method: 'project_getInfo',
    channels: ['xleth:project:getInfo'],
    api: { 'project.getInfo': 'xleth:project:getInfo' },
    handler: 'Project_GetInfo',
    returns: 'value',
    binary: null,
  },
  {
    method: 'project_isDirty',
    channels: ['xleth:project:isDirty'],
    api: { 'project.isDirty': 'xleth:project:isDirty' },
    handler: 'Project_IsDirty',
    returns: 'value',
    binary: null,
  },
  {
    method: 'project_isExportRunning',
    channels: ['xleth:project:isExportRunning'],
    api: { 'project.isExportRunning': 'xleth:project:isExportRunning' },
    handler: 'Project_IsExportRunning',
    returns: 'value',
    binary: null,
  },

  // ── Patterns / regions / notes (AUDIT.md S1 slice 4) ──
  // Pure engine pass-throughs from ui/electron-main/patterns.js: the region /
  // syllable group, patterns, pattern-blocks, single-note editing, and the
  // read-only .fsc parse. The value/void shape below mirrors each removed hand
  // dispatch line verbatim. EXCLUDED and left hand-written in patterns.js:
  //   • timeline_previewNote — its preload wrapper supplies a velocity=0.8
  //     default the generic attachRpcWrappers forward would drop (behavior
  //     change on a 2-arg call), same disqualifier class as autoTrimClip.
  //   • moveNotesBatch / addNotesBatch / quantizeClipsBatch / resizeNotesBatch —
  //     batch / multi-entry ops, excluded per the timeline.js batch precedent.
  // fsc_parse keeps its own xleth:fsc:* namespace (attachRpcWrappers creates the
  // fsc.* wrapper namespace on demand).
  {
    method: 'timeline_addRegion',
    channels: ['xleth:timeline:addRegion'],
    api: { 'timeline.addRegion': 'xleth:timeline:addRegion' },
    handler: 'Timeline_AddRegion',
    returns: 'value',
    binary: null,
  },
  {
    method: 'timeline_modifyRegion',
    channels: ['xleth:timeline:modifyRegion'],
    api: { 'timeline.modifyRegion': 'xleth:timeline:modifyRegion' },
    handler: 'Timeline_ModifyRegion',
    returns: 'void',
    binary: null,
  },
  {
    method: 'timeline_setSyllables',
    channels: ['xleth:timeline:setSyllables'],
    api: { 'timeline.setSyllables': 'xleth:timeline:setSyllables' },
    handler: 'Timeline_SetSyllables',
    returns: 'void',
    binary: null,
  },
  {
    method: 'timeline_getSyllables',
    channels: ['xleth:timeline:getSyllables'],
    api: { 'timeline.getSyllables': 'xleth:timeline:getSyllables' },
    handler: 'Timeline_GetSyllables',
    returns: 'value',
    binary: null,
  },
  {
    method: 'timeline_removeRegion',
    channels: ['xleth:timeline:removeRegion'],
    api: { 'timeline.removeRegion': 'xleth:timeline:removeRegion' },
    handler: 'Timeline_RemoveRegion',
    returns: 'void',
    binary: null,
  },
  {
    method: 'timeline_addPattern',
    channels: ['xleth:timeline:addPattern'],
    api: { 'timeline.addPattern': 'xleth:timeline:addPattern' },
    handler: 'Timeline_AddPattern',
    returns: 'value',
    binary: null,
  },
  {
    method: 'timeline_getPattern',
    channels: ['xleth:timeline:getPattern'],
    api: { 'timeline.getPattern': 'xleth:timeline:getPattern' },
    handler: 'Timeline_GetPattern',
    returns: 'value',
    binary: null,
  },
  {
    method: 'timeline_getAllPatterns',
    channels: ['xleth:timeline:getAllPatterns'],
    api: { 'timeline.getAllPatterns': 'xleth:timeline:getAllPatterns' },
    handler: 'Timeline_GetAllPatterns',
    returns: 'value',
    binary: null,
  },
  {
    method: 'timeline_removePattern',
    channels: ['xleth:timeline:removePattern'],
    api: { 'timeline.removePattern': 'xleth:timeline:removePattern' },
    handler: 'Timeline_RemovePattern',
    returns: 'void',
    binary: null,
  },
  {
    method: 'timeline_updateSamplerSettings',
    channels: ['xleth:timeline:updateSamplerSettings'],
    api: { 'timeline.updateSamplerSettings': 'xleth:timeline:updateSamplerSettings' },
    handler: 'Timeline_UpdateSamplerSettings',
    returns: 'void',
    binary: null,
  },
  {
    method: 'timeline_getPatternAudioInfo',
    channels: ['xleth:timeline:getPatternAudioInfo'],
    api: { 'timeline.getPatternAudioInfo': 'xleth:timeline:getPatternAudioInfo' },
    handler: 'Timeline_GetPatternAudioInfo',
    returns: 'value',
    binary: null,
  },
  {
    method: 'timeline_getRegionAudioInfo',
    channels: ['xleth:timeline:getRegionAudioInfo'],
    api: { 'timeline.getRegionAudioInfo': 'xleth:timeline:getRegionAudioInfo' },
    handler: 'Timeline_GetRegionAudioInfo',
    returns: 'value',
    binary: null,
  },
  {
    // Selection-first AUTO loop (policy v2 port). Computes + writes a period-
    // aligned, formant-stable loop inside the given selection (engine-buffer
    // samples; omit/collapse to auto-loop the whole sample) and returns the
    // chosen loop plus telemetry. Undoable — routes through the same
    // sampler-settings command as manual loop edits.
    method: 'timeline_autoLoopForSelection',
    channels: ['xleth:timeline:autoLoopForSelection'],
    api: { 'timeline.autoLoopForSelection': 'xleth:timeline:autoLoopForSelection' },
    handler: 'Timeline_AutoLoopForSelection',
    returns: 'value',
    binary: null,
  },
  {
    method: 'timeline_addPatternBlock',
    channels: ['xleth:timeline:addPatternBlock'],
    api: { 'timeline.addPatternBlock': 'xleth:timeline:addPatternBlock' },
    handler: 'Timeline_AddPatternBlock',
    returns: 'value',
    binary: null,
  },
  {
    method: 'timeline_getPatternBlocks',
    channels: ['xleth:timeline:getPatternBlocks'],
    api: { 'timeline.getPatternBlocks': 'xleth:timeline:getPatternBlocks' },
    handler: 'Timeline_GetPatternBlocks',
    returns: 'value',
    binary: null,
  },
  {
    method: 'timeline_removePatternBlock',
    channels: ['xleth:timeline:removePatternBlock'],
    api: { 'timeline.removePatternBlock': 'xleth:timeline:removePatternBlock' },
    handler: 'Timeline_RemovePatternBlock',
    returns: 'void',
    binary: null,
  },
  {
    method: 'timeline_movePatternBlock',
    channels: ['xleth:timeline:movePatternBlock'],
    api: { 'timeline.movePatternBlock': 'xleth:timeline:movePatternBlock' },
    handler: 'Timeline_MovePatternBlock',
    returns: 'void',
    binary: null,
  },
  {
    method: 'timeline_resizePatternBlock',
    channels: ['xleth:timeline:resizePatternBlock'],
    api: { 'timeline.resizePatternBlock': 'xleth:timeline:resizePatternBlock' },
    handler: 'Timeline_ResizePatternBlock',
    returns: 'void',
    binary: null,
  },
  {
    method: 'timeline_resizePatternBlockLeft',
    channels: ['xleth:timeline:resizePatternBlockLeft'],
    api: { 'timeline.resizePatternBlockLeft': 'xleth:timeline:resizePatternBlockLeft' },
    handler: 'Timeline_ResizePatternBlockLeft',
    returns: 'void',
    binary: null,
  },
  {
    method: 'timeline_setPatternBlockLoop',
    channels: ['xleth:timeline:setPatternBlockLoop'],
    api: { 'timeline.setPatternBlockLoop': 'xleth:timeline:setPatternBlockLoop' },
    handler: 'Timeline_SetPatternBlockLoop',
    returns: 'void',
    binary: null,
  },
  {
    method: 'timeline_addNote',
    channels: ['xleth:timeline:addNote'],
    api: { 'timeline.addNote': 'xleth:timeline:addNote' },
    handler: 'Timeline_AddNote',
    returns: 'value',
    binary: null,
  },
  {
    method: 'timeline_removeNote',
    channels: ['xleth:timeline:removeNote'],
    api: { 'timeline.removeNote': 'xleth:timeline:removeNote' },
    handler: 'Timeline_RemoveNote',
    returns: 'void',
    binary: null,
  },
  {
    method: 'timeline_moveNote',
    channels: ['xleth:timeline:moveNote'],
    api: { 'timeline.moveNote': 'xleth:timeline:moveNote' },
    handler: 'Timeline_MoveNote',
    returns: 'void',
    binary: null,
  },
  {
    method: 'timeline_resizeNote',
    channels: ['xleth:timeline:resizeNote'],
    api: { 'timeline.resizeNote': 'xleth:timeline:resizeNote' },
    handler: 'Timeline_ResizeNote',
    returns: 'void',
    binary: null,
  },
  {
    method: 'timeline_setNoteVelocity',
    channels: ['xleth:timeline:setNoteVelocity'],
    api: { 'timeline.setNoteVelocity': 'xleth:timeline:setNoteVelocity' },
    handler: 'Timeline_SetNoteVelocity',
    returns: 'void',
    binary: null,
  },
  {
    method: 'timeline_previewNoteOff',
    channels: ['xleth:timeline:previewNoteOff'],
    api: { 'timeline.previewNoteOff': 'xleth:timeline:previewNoteOff' },
    handler: 'Timeline_PreviewNoteOff',
    returns: 'void',
    binary: null,
  },
  {
    method: 'timeline_previewAllNotesOff',
    channels: ['xleth:timeline:previewAllNotesOff'],
    api: { 'timeline.previewAllNotesOff': 'xleth:timeline:previewAllNotesOff' },
    handler: 'Timeline_PreviewAllNotesOff',
    returns: 'void',
    binary: null,
  },
  {
    method: 'fsc_parse',
    channels: ['xleth:fsc:parse'],
    api: { 'fsc.parse': 'xleth:fsc:parse' },
    handler: 'Fsc_Parse',
    returns: 'value',
    binary: null,
  },

  // ── Audio / MixEngine (AUDIT.md S1 slice 5) ──
  // Pure engine pass-throughs from ui/electron-main/audio.js: sample loading,
  // region->sample mapping, peak meters, realtime-diagnostics reset/get,
  // performance telemetry, mixer volume/pan/spread + master volume, and
  // output-device get/set. Each returns shape mirrors the removed hand dispatch
  // line verbatim (setTrackVolume/Pan/Spread/MasterVolume are value: their
  // engine handlers return JsonApi::Value even though semantically undefined).
  // EXCLUDED and left hand-written in audio.js:
  //   * setRealtimeDiagnosticsEnabled — preload (!!enabled) and the main-process
  //     handler (Boolean(enabled)) both coerce the arg; the generic passthrough
  //     wrappers would drop that (arg-fixup disqualifier, autoTrimClip class).
  //   * captureAudioPerformanceReport — its handler injects a userDataPath
  //     outputDir default (../runtimePaths), not a pure engine round-trip.
  // loadSample is the Phase-0 unprefixed export (like getFrameRGBA); its single
  // api path audio.loadSample routes the same worker string. getOutputDevices /
  // setOutputDevice enumerate/select OS devices inside the C++ engine handler,
  // which the migration leaves untouched — the JS side is a plain pass-through.
  // audio_getAudioPerformanceTelemetry: only the prefixed name migrates here; the
  // non-prefixed getAudioPerformanceTelemetry alias stays hand-written (shared
  // bridge wrapper + engine branch, same engine handler, equivalent routing).
  {
    method: 'loadSample',
    channels: ['xleth:audio:loadSample'],
    api: { 'audio.loadSample': 'xleth:audio:loadSample' },
    handler: 'LoadSample',
    returns: 'value',
    binary: null,
  },
  {
    method: 'audio_mapRegionToSample',
    channels: ['xleth:audio:mapRegionToSample'],
    api: { 'audio.mapRegionToSample': 'xleth:audio:mapRegionToSample' },
    handler: 'Audio_MapRegionToSample',
    returns: 'void',
    binary: null,
  },
  {
    method: 'audio_loadSourceRegion',
    channels: ['xleth:audio:loadSourceRegion'],
    api: { 'audio.loadSourceRegion': 'xleth:audio:loadSourceRegion' },
    handler: 'Audio_LoadSourceRegion',
    returns: 'value',
    binary: null,
  },
  {
    method: 'audio_getMasterPeak',
    channels: ['xleth:audio:getMasterPeak'],
    api: { 'audio.getMasterPeak': 'xleth:audio:getMasterPeak' },
    handler: 'Audio_GetMasterPeak',
    returns: 'value',
    binary: null,
  },
  {
    method: 'audio_getMasterLoudness',
    channels: ['xleth:audio:getMasterLoudness'],
    api: { 'audio.getMasterLoudness': 'xleth:audio:getMasterLoudness' },
    handler: 'Audio_GetMasterLoudness',
    returns: 'value',
    binary: null,
  },
  {
    method: 'audio_setMasterLoudnessEnabled',
    channels: ['xleth:audio:setMasterLoudnessEnabled'],
    api: { 'audio.setMasterLoudnessEnabled': 'xleth:audio:setMasterLoudnessEnabled' },
    handler: 'Audio_SetMasterLoudnessEnabled',
    returns: 'value',
    binary: null,
  },
  {
    method: 'audio_resetMasterLoudness',
    channels: ['xleth:audio:resetMasterLoudness'],
    api: { 'audio.resetMasterLoudness': 'xleth:audio:resetMasterLoudness' },
    handler: 'Audio_ResetMasterLoudness',
    returns: 'value',
    binary: null,
  },
  {
    method: 'audio_getTrackPeak',
    channels: ['xleth:audio:getTrackPeak'],
    api: { 'audio.getTrackPeak': 'xleth:audio:getTrackPeak' },
    handler: 'Audio_GetTrackPeak',
    returns: 'value',
    binary: null,
  },
  {
    method: 'audio_getAllPeaks',
    channels: ['xleth:audio:getAllPeaks'],
    api: { 'audio.getAllPeaks': 'xleth:audio:getAllPeaks' },
    handler: 'Audio_GetAllPeaks',
    returns: 'value',
    binary: null,
  },
  {
    method: 'audio_resetRealtimeDiagnostics',
    channels: ['xleth:audio:resetRealtimeDiagnostics'],
    api: { 'audio.resetRealtimeDiagnostics': 'xleth:audio:resetRealtimeDiagnostics' },
    handler: 'Audio_ResetRealtimeDiagnostics',
    returns: 'value',
    binary: null,
  },
  {
    method: 'audio_getRealtimeDiagnostics',
    channels: ['xleth:audio:getRealtimeDiagnostics'],
    api: { 'audio.getRealtimeDiagnostics': 'xleth:audio:getRealtimeDiagnostics' },
    handler: 'Audio_GetRealtimeDiagnostics',
    returns: 'value',
    binary: null,
  },
  {
    method: 'audio_getAudioPerformanceTelemetry',
    channels: ['xleth:audio:getAudioPerformanceTelemetry'],
    api: { 'audio.getAudioPerformanceTelemetry': 'xleth:audio:getAudioPerformanceTelemetry' },
    handler: 'Audio_GetAudioPerformanceTelemetry',
    returns: 'value',
    binary: null,
  },
  {
    method: 'audio_setTrackVolume',
    channels: ['xleth:audio:setTrackVolume'],
    api: { 'audio.setTrackVolume': 'xleth:audio:setTrackVolume' },
    handler: 'Audio_SetTrackVolume',
    returns: 'value',
    binary: null,
  },
  {
    method: 'audio_setTrackPan',
    channels: ['xleth:audio:setTrackPan'],
    api: { 'audio.setTrackPan': 'xleth:audio:setTrackPan' },
    handler: 'Audio_SetTrackPan',
    returns: 'value',
    binary: null,
  },
  {
    method: 'audio_setTrackSpread',
    channels: ['xleth:audio:setTrackSpread'],
    api: { 'audio.setTrackSpread': 'xleth:audio:setTrackSpread' },
    handler: 'Audio_SetTrackSpread',
    returns: 'value',
    binary: null,
  },
  {
    method: 'audio_setMasterVolume',
    channels: ['xleth:audio:setMasterVolume'],
    api: { 'audio.setMasterVolume': 'xleth:audio:setMasterVolume' },
    handler: 'Audio_SetMasterVolume',
    returns: 'value',
    binary: null,
  },
  {
    method: 'audio_getOutputDevices',
    channels: ['xleth:audio:getOutputDevices'],
    api: { 'audio.getOutputDevices': 'xleth:audio:getOutputDevices' },
    handler: 'Audio_GetOutputDevices',
    returns: 'value',
    binary: null,
  },
  {
    method: 'audio_getCurrentOutputDevice',
    channels: ['xleth:audio:getCurrentOutputDevice'],
    api: { 'audio.getCurrentOutputDevice': 'xleth:audio:getCurrentOutputDevice' },
    handler: 'Audio_GetCurrentOutputDevice',
    returns: 'value',
    binary: null,
  },
  {
    method: 'audio_setOutputDevice',
    channels: ['xleth:audio:setOutputDevice'],
    api: { 'audio.setOutputDevice': 'xleth:audio:setOutputDevice' },
    handler: 'Audio_SetOutputDevice',
    returns: 'value',
    binary: null,
  },

  // ── Effects: chain + parameters + EQ/SmartBalance/Waveshaper (AUDIT.md S1 slice 6) ──
  // From ui/electron-main/effects.js. The 8 chain mutations (add/remove/move/
  // bypass, track + master) carry `graph: 'track' | 'master'` — they broadcast
  // xleth:graph:changed after the call resolves (see the field doc above); the
  // rest are plain pass-throughs. Every returns shape mirrors the removed hand
  // dispatch line verbatim (all 28 were `return Handler(info).raw()` = value).
  // EXCLUDED and left hand-written in effects.js:
  //   * setEffectVisualizationEnabled — its main-process handler coerces the
  //     arg (!!enabled); the generic passthrough would drop that (arg-fixup
  //     disqualifier, setRealtimeDiagnosticsEnabled class).
  //   * drainEffectVizFrames — coerces maxBuckets|0 AND returns the dynamics-viz
  //     binary payload ({ frames: ArrayBuffer }); stays fully explicit.
  {
    method: 'audio_addEffect',
    channels: ['xleth:audio:addEffect'],
    api: { 'audio.addEffect': 'xleth:audio:addEffect' },
    handler: 'Audio_AddEffect',
    returns: 'value',
    binary: null,
    graph: 'track',
  },
  {
    method: 'audio_removeEffect',
    channels: ['xleth:audio:removeEffect'],
    api: { 'audio.removeEffect': 'xleth:audio:removeEffect' },
    handler: 'Audio_RemoveEffect',
    returns: 'value',
    binary: null,
    graph: 'track',
  },
  {
    method: 'audio_moveEffect',
    channels: ['xleth:audio:moveEffect'],
    api: { 'audio.moveEffect': 'xleth:audio:moveEffect' },
    handler: 'Audio_MoveEffect',
    returns: 'value',
    binary: null,
    graph: 'track',
  },
  {
    method: 'audio_setEffectBypass',
    channels: ['xleth:audio:setEffectBypass'],
    api: { 'audio.setEffectBypass': 'xleth:audio:setEffectBypass' },
    handler: 'Audio_SetEffectBypass',
    returns: 'value',
    binary: null,
    graph: 'track',
  },
  {
    method: 'audio_addMasterEffect',
    channels: ['xleth:audio:addMasterEffect'],
    api: { 'audio.addMasterEffect': 'xleth:audio:addMasterEffect' },
    handler: 'Audio_AddMasterEffect',
    returns: 'value',
    binary: null,
    graph: 'master',
  },
  {
    method: 'audio_removeMasterEffect',
    channels: ['xleth:audio:removeMasterEffect'],
    api: { 'audio.removeMasterEffect': 'xleth:audio:removeMasterEffect' },
    handler: 'Audio_RemoveMasterEffect',
    returns: 'value',
    binary: null,
    graph: 'master',
  },
  {
    method: 'audio_moveMasterEffect',
    channels: ['xleth:audio:moveMasterEffect'],
    api: { 'audio.moveMasterEffect': 'xleth:audio:moveMasterEffect' },
    handler: 'Audio_MoveMasterEffect',
    returns: 'value',
    binary: null,
    graph: 'master',
  },
  {
    method: 'audio_setMasterEffectBypass',
    channels: ['xleth:audio:setMasterEffectBypass'],
    api: { 'audio.setMasterEffectBypass': 'xleth:audio:setMasterEffectBypass' },
    handler: 'Audio_SetMasterEffectBypass',
    returns: 'value',
    binary: null,
    graph: 'master',
  },
  {
    method: 'audio_getEffectChain',
    channels: ['xleth:audio:getEffectChain'],
    api: { 'audio.getEffectChain': 'xleth:audio:getEffectChain' },
    handler: 'Audio_GetEffectChain',
    returns: 'value',
    binary: null,
  },
  {
    method: 'audio_getMasterEffectChain',
    channels: ['xleth:audio:getMasterEffectChain'],
    api: { 'audio.getMasterEffectChain': 'xleth:audio:getMasterEffectChain' },
    handler: 'Audio_GetMasterEffectChain',
    returns: 'value',
    binary: null,
  },
  {
    method: 'audio_getEffectParameters',
    channels: ['xleth:audio:getEffectParameters'],
    api: { 'audio.getEffectParameters': 'xleth:audio:getEffectParameters' },
    handler: 'Audio_GetEffectParameters',
    returns: 'value',
    binary: null,
  },
  {
    method: 'audio_setEffectParameter',
    channels: ['xleth:audio:setEffectParameter'],
    api: { 'audio.setEffectParameter': 'xleth:audio:setEffectParameter' },
    handler: 'Audio_SetEffectParameter',
    returns: 'value',
    binary: null,
  },
  {
    method: 'audio_getEffectMeter',
    channels: ['xleth:audio:getEffectMeter'],
    api: { 'audio.getEffectMeter': 'xleth:audio:getEffectMeter' },
    handler: 'Audio_GetEffectMeter',
    returns: 'value',
    binary: null,
  },
  {
    method: 'audio_eqAddBand',
    channels: ['xleth:audio:eqAddBand'],
    api: { 'audio.eqAddBand': 'xleth:audio:eqAddBand' },
    handler: 'Audio_EQ_AddBand',
    returns: 'value',
    binary: null,
  },
  {
    method: 'audio_eqRemoveBand',
    channels: ['xleth:audio:eqRemoveBand'],
    api: { 'audio.eqRemoveBand': 'xleth:audio:eqRemoveBand' },
    handler: 'Audio_EQ_RemoveBand',
    returns: 'value',
    binary: null,
  },
  {
    method: 'audio_eqSetBandParam',
    channels: ['xleth:audio:eqSetBandParam'],
    api: { 'audio.eqSetBandParam': 'xleth:audio:eqSetBandParam' },
    handler: 'Audio_EQ_SetBandParam',
    returns: 'value',
    binary: null,
  },
  {
    method: 'audio_eqGetResponseCurve',
    channels: ['xleth:audio:eqGetResponseCurve'],
    api: { 'audio.eqGetResponseCurve': 'xleth:audio:eqGetResponseCurve' },
    handler: 'Audio_EQ_GetResponseCurve',
    returns: 'value',
    binary: null,
  },
  {
    method: 'audio_eqGetSpectrumData',
    channels: ['xleth:audio:eqGetSpectrumData'],
    api: { 'audio.eqGetSpectrumData': 'xleth:audio:eqGetSpectrumData' },
    handler: 'Audio_EQ_GetSpectrumData',
    returns: 'value',
    binary: null,
  },
  {
    method: 'audio_eqSetPreSpectrum',
    channels: ['xleth:audio:eqSetPreSpectrum'],
    api: { 'audio.eqSetPreSpectrum': 'xleth:audio:eqSetPreSpectrum' },
    handler: 'Audio_EQ_SetPreSpectrum',
    returns: 'value',
    binary: null,
  },
  {
    method: 'audio_eqGetBands',
    channels: ['xleth:audio:eqGetBands'],
    api: { 'audio.eqGetBands': 'xleth:audio:eqGetBands' },
    handler: 'Audio_EQ_GetBands',
    returns: 'value',
    binary: null,
  },
  {
    method: 'audio_eqGetBandGR',
    channels: ['xleth:audio:eqGetBandGR'],
    api: { 'audio.eqGetBandGR': 'xleth:audio:eqGetBandGR' },
    handler: 'Audio_EQ_GetBandGR',
    returns: 'value',
    binary: null,
  },
  {
    method: 'audio_eqSetGlobalParam',
    channels: ['xleth:audio:eqSetGlobalParam'],
    api: { 'audio.eqSetGlobalParam': 'xleth:audio:eqSetGlobalParam' },
    handler: 'Audio_EQ_SetGlobalParam',
    returns: 'value',
    binary: null,
  },
  {
    method: 'audio_eqGetGlobalParams',
    channels: ['xleth:audio:eqGetGlobalParams'],
    api: { 'audio.eqGetGlobalParams': 'xleth:audio:eqGetGlobalParams' },
    handler: 'Audio_EQ_GetGlobalParams',
    returns: 'value',
    binary: null,
  },
  {
    method: 'audio_eqGetSampleRate',
    channels: ['xleth:audio:eqGetSampleRate'],
    api: { 'audio.eqGetSampleRate': 'xleth:audio:eqGetSampleRate' },
    handler: 'Audio_EQ_GetSampleRate',
    returns: 'value',
    binary: null,
  },
  // ── APEX curve state + generic effect latency ──
  // APEX's ~50 scalar parameters need no entries here: they are ordinary APVTS
  // parameters served by audio_getEffectParameters / audio_setEffectParameter.
  // Only the per-band dynamics curve (variable-length node list + per-segment
  // tensions) needs its own door, because it cannot travel through a scalar
  // parameter API. Curve state persists via the effect's existing APVTS state
  // blob — these methods are the live edit path, not a second save path.
  // audio_getEffectLatency is deliberately generic across all stock effects.
  {
    method: 'audio_apexGetCurves',
    channels: ['xleth:audio:apexGetCurves'],
    api: { 'audio.apexGetCurves': 'xleth:audio:apexGetCurves' },
    handler: 'Audio_Apex_GetCurves',
    returns: 'value',
    binary: null,
  },
  {
    method: 'audio_apexGetBandCurve',
    channels: ['xleth:audio:apexGetBandCurve'],
    api: { 'audio.apexGetBandCurve': 'xleth:audio:apexGetBandCurve' },
    handler: 'Audio_Apex_GetBandCurve',
    returns: 'value',
    binary: null,
  },
  {
    method: 'audio_apexSetBandCurve',
    channels: ['xleth:audio:apexSetBandCurve'],
    api: { 'audio.apexSetBandCurve': 'xleth:audio:apexSetBandCurve' },
    handler: 'Audio_Apex_SetBandCurve',
    returns: 'value',
    binary: null,
  },
  {
    method: 'audio_apexResetBandCurve',
    channels: ['xleth:audio:apexResetBandCurve'],
    api: { 'audio.apexResetBandCurve': 'xleth:audio:apexResetBandCurve' },
    handler: 'Audio_Apex_ResetBandCurve',
    returns: 'value',
    binary: null,
  },
  {
    method: 'audio_getEffectLatency',
    channels: ['xleth:audio:getEffectLatency'],
    api: { 'audio.getEffectLatency': 'xleth:audio:getEffectLatency' },
    handler: 'Audio_GetEffectLatency',
    returns: 'value',
    binary: null,
  },
  {
    method: 'audio_smartBalanceGetDebug',
    channels: ['xleth:audio:smartBalanceGetDebug'],
    api: { 'audio.smartBalanceGetDebug': 'xleth:audio:smartBalanceGetDebug' },
    handler: 'Audio_SmartBalance_GetDebug',
    returns: 'value',
    binary: null,
  },
  {
    method: 'audio_wsGetCurvePoints',
    channels: ['xleth:audio:wsGetCurvePoints'],
    api: { 'audio.wsGetCurvePoints': 'xleth:audio:wsGetCurvePoints' },
    handler: 'Audio_WS_GetCurvePoints',
    returns: 'value',
    binary: null,
  },
  {
    method: 'audio_wsSetCurvePoints',
    channels: ['xleth:audio:wsSetCurvePoints'],
    api: { 'audio.wsSetCurvePoints': 'xleth:audio:wsSetCurvePoints' },
    handler: 'Audio_WS_SetCurvePoints',
    returns: 'value',
    binary: null,
  },
  {
    method: 'audio_wsSetPreset',
    channels: ['xleth:audio:wsSetPreset'],
    api: { 'audio.wsSetPreset': 'xleth:audio:wsSetPreset' },
    handler: 'Audio_WS_SetPreset',
    returns: 'value',
    binary: null,
  },

  // ── Effects graph: wire mutations + graph-owned instances + topology (AUDIT.md S1 slice 7) ──
  // From ui/electron-main/effects-graph.js — the last of the audio/effects/graph
  // trio. The 8 wire mutations (add/remove connection + setWire gain/mute, track +
  // master) carry `graph: 'track' | 'master'`: they broadcast xleth:graph:changed
  // after the call resolves — identical mechanism to effects.js's chain mutations.
  // The other 16 are plain pass-throughs that deliberately do NOT broadcast:
  //   * getGraphTopology / setNodePosition / isGraphLinear (+ master variants) —
  //     topology reads and node-position persistence.
  //   * the FXG.3-b graph-owned effect instances (add/remove/getEngineNodeId) and
  //     the FXG.4-a parameter descriptors (getParameters, get/setParameter value):
  //     graphState persistence, not a chain re-fetch, keeps the renderer in sync, so
  //     they are safeHandler-only by design — plain entries preserve that (no graph:).
  //   * hydrate / syncLinear / sync / adopt (FXG.3-d) — their batch init, topology
  //     rebuild and adoption logic lives entirely in the engine C++ handler; the JS
  //     layers are a single callWorker pass-through, so they migrate like the rest.
  // Every returns shape mirrors the removed hand dispatch line verbatim (all 24 were
  // `return Handler(info).raw()` = value). effects-graph.js has NO exclusions — it is
  // fully migrated by this slice.
  {
    method: 'audio_addConnection',
    channels: ['xleth:audio:addConnection'],
    api: { 'audio.addConnection': 'xleth:audio:addConnection' },
    handler: 'Audio_AddConnection',
    returns: 'value',
    binary: null,
    graph: 'track',
  },
  {
    method: 'audio_removeConnection',
    channels: ['xleth:audio:removeConnection'],
    api: { 'audio.removeConnection': 'xleth:audio:removeConnection' },
    handler: 'Audio_RemoveConnection',
    returns: 'value',
    binary: null,
    graph: 'track',
  },
  {
    method: 'audio_setWireGain',
    channels: ['xleth:audio:setWireGain'],
    api: { 'audio.setWireGain': 'xleth:audio:setWireGain' },
    handler: 'Audio_SetWireGain',
    returns: 'value',
    binary: null,
    graph: 'track',
  },
  {
    method: 'audio_setWireMute',
    channels: ['xleth:audio:setWireMute'],
    api: { 'audio.setWireMute': 'xleth:audio:setWireMute' },
    handler: 'Audio_SetWireMute',
    returns: 'value',
    binary: null,
    graph: 'track',
  },
  {
    method: 'audio_getGraphTopology',
    channels: ['xleth:audio:getGraphTopology'],
    api: { 'audio.getGraphTopology': 'xleth:audio:getGraphTopology' },
    handler: 'Audio_GetGraphTopology',
    returns: 'value',
    binary: null,
  },
  {
    method: 'audio_setNodePosition',
    channels: ['xleth:audio:setNodePosition'],
    api: { 'audio.setNodePosition': 'xleth:audio:setNodePosition' },
    handler: 'Audio_SetNodePosition',
    returns: 'value',
    binary: null,
  },
  {
    method: 'audio_isGraphLinear',
    channels: ['xleth:audio:isGraphLinear'],
    api: { 'audio.isGraphLinear': 'xleth:audio:isGraphLinear' },
    handler: 'Audio_IsGraphLinear',
    returns: 'value',
    binary: null,
  },
  {
    method: 'audio_addGraphEffectNode',
    channels: ['xleth:audio:addGraphEffectNode'],
    api: { 'audio.addGraphEffectNode': 'xleth:audio:addGraphEffectNode' },
    handler: 'Audio_AddGraphEffectNode',
    returns: 'value',
    binary: null,
  },
  {
    method: 'audio_removeGraphEffectNode',
    channels: ['xleth:audio:removeGraphEffectNode'],
    api: { 'audio.removeGraphEffectNode': 'xleth:audio:removeGraphEffectNode' },
    handler: 'Audio_RemoveGraphEffectNode',
    returns: 'value',
    binary: null,
  },
  {
    method: 'audio_getGraphEffectEngineNodeId',
    channels: ['xleth:audio:getGraphEffectEngineNodeId'],
    api: { 'audio.getGraphEffectEngineNodeId': 'xleth:audio:getGraphEffectEngineNodeId' },
    handler: 'Audio_GetGraphEffectEngineNodeId',
    returns: 'value',
    binary: null,
  },
  {
    method: 'audio_getGraphEffectParameters',
    channels: ['xleth:audio:getGraphEffectParameters'],
    api: { 'audio.getGraphEffectParameters': 'xleth:audio:getGraphEffectParameters' },
    handler: 'Audio_GetGraphEffectParameters',
    returns: 'value',
    binary: null,
  },
  {
    method: 'audio_getGraphEffectParameterValue',
    channels: ['xleth:audio:getGraphEffectParameterValue'],
    api: { 'audio.getGraphEffectParameterValue': 'xleth:audio:getGraphEffectParameterValue' },
    handler: 'Audio_GetGraphEffectParameterValue',
    returns: 'value',
    binary: null,
  },
  {
    method: 'audio_setGraphEffectParameterNormalized',
    channels: ['xleth:audio:setGraphEffectParameterNormalized'],
    api: { 'audio.setGraphEffectParameterNormalized': 'xleth:audio:setGraphEffectParameterNormalized' },
    handler: 'Audio_SetGraphEffectParameterNormalized',
    returns: 'value',
    binary: null,
  },
  {
    method: 'audio_hydrateGraphEffectNodes',
    channels: ['xleth:audio:hydrateGraphEffectNodes'],
    api: { 'audio.hydrateGraphEffectNodes': 'xleth:audio:hydrateGraphEffectNodes' },
    handler: 'Audio_HydrateGraphEffectNodes',
    returns: 'value',
    binary: null,
  },
  {
    method: 'audio_syncLinearGraphTopology',
    channels: ['xleth:audio:syncLinearGraphTopology'],
    api: { 'audio.syncLinearGraphTopology': 'xleth:audio:syncLinearGraphTopology' },
    handler: 'Audio_SyncLinearGraphTopology',
    returns: 'value',
    binary: null,
  },
  {
    method: 'audio_syncGraphTopology',
    channels: ['xleth:audio:syncGraphTopology'],
    api: { 'audio.syncGraphTopology': 'xleth:audio:syncGraphTopology' },
    handler: 'Audio_SyncGraphTopology',
    returns: 'value',
    binary: null,
  },
  {
    method: 'audio_adoptGraphEffectNodes',
    channels: ['xleth:audio:adoptGraphEffectNodes'],
    api: { 'audio.adoptGraphEffectNodes': 'xleth:audio:adoptGraphEffectNodes' },
    handler: 'Audio_AdoptGraphEffectNodes',
    returns: 'value',
    binary: null,
  },
  {
    method: 'audio_addMasterConnection',
    channels: ['xleth:audio:addMasterConnection'],
    api: { 'audio.addMasterConnection': 'xleth:audio:addMasterConnection' },
    handler: 'Audio_AddMasterConnection',
    returns: 'value',
    binary: null,
    graph: 'master',
  },
  {
    method: 'audio_removeMasterConnection',
    channels: ['xleth:audio:removeMasterConnection'],
    api: { 'audio.removeMasterConnection': 'xleth:audio:removeMasterConnection' },
    handler: 'Audio_RemoveMasterConnection',
    returns: 'value',
    binary: null,
    graph: 'master',
  },
  {
    method: 'audio_setMasterWireGain',
    channels: ['xleth:audio:setMasterWireGain'],
    api: { 'audio.setMasterWireGain': 'xleth:audio:setMasterWireGain' },
    handler: 'Audio_SetMasterWireGain',
    returns: 'value',
    binary: null,
    graph: 'master',
  },
  {
    method: 'audio_setMasterWireMute',
    channels: ['xleth:audio:setMasterWireMute'],
    api: { 'audio.setMasterWireMute': 'xleth:audio:setMasterWireMute' },
    handler: 'Audio_SetMasterWireMute',
    returns: 'value',
    binary: null,
    graph: 'master',
  },
  {
    method: 'audio_getMasterGraphTopology',
    channels: ['xleth:audio:getMasterGraphTopology'],
    api: { 'audio.getMasterGraphTopology': 'xleth:audio:getMasterGraphTopology' },
    handler: 'Audio_GetMasterGraphTopology',
    returns: 'value',
    binary: null,
  },
  {
    method: 'audio_setMasterNodePosition',
    channels: ['xleth:audio:setMasterNodePosition'],
    api: { 'audio.setMasterNodePosition': 'xleth:audio:setMasterNodePosition' },
    handler: 'Audio_SetMasterNodePosition',
    returns: 'value',
    binary: null,
  },
  {
    method: 'audio_isMasterGraphLinear',
    channels: ['xleth:audio:isMasterGraphLinear'],
    api: { 'audio.isMasterGraphLinear': 'xleth:audio:isMasterGraphLinear' },
    handler: 'Audio_IsMasterGraphLinear',
    returns: 'value',
    binary: null,
  },

  // ── VST3 scanner / editor / missing-plugin / crash recovery (AUDIT.md S1) ──
  // Pure engine pass-throughs from ui/electron-main/vst3.js. All dispatch with
  // the value shape (engine returns Handler(info).raw() for every one, including
  // the editor mutations). audio_scanPlugins is NOT here: its vst3.js handler
  // reshapes the argument (paths && paths.length ? [paths] : []) before
  // forwarding, so it stays hand-written. xleth:dialog:addVstSearchPath owns an
  // Electron dialog, not an engine call, and stays hand-written too.
  {
    method: 'audio_getScanProgress',
    channels: ['xleth:audio:getScanProgress'],
    api: { 'audio.getScanProgress': 'xleth:audio:getScanProgress' },
    handler: 'Audio_GetScanProgress',
    returns: 'value',
    binary: null,
  },
  {
    method: 'audio_getScannedPlugins',
    channels: ['xleth:audio:getScannedPlugins'],
    api: { 'audio.getScannedPlugins': 'xleth:audio:getScannedPlugins' },
    handler: 'Audio_GetScannedPlugins',
    returns: 'value',
    binary: null,
  },
  {
    method: 'audio_getFailedPlugins',
    channels: ['xleth:audio:getFailedPlugins'],
    api: { 'audio.getFailedPlugins': 'xleth:audio:getFailedPlugins' },
    handler: 'Audio_GetFailedPlugins',
    returns: 'value',
    binary: null,
  },
  {
    method: 'audio_openPluginEditor',
    channels: ['xleth:audio:openPluginEditor'],
    api: { 'audio.openPluginEditor': 'xleth:audio:openPluginEditor' },
    handler: 'Audio_OpenPluginEditor',
    returns: 'value',
    binary: null,
  },
  {
    method: 'audio_closePluginEditor',
    channels: ['xleth:audio:closePluginEditor'],
    api: { 'audio.closePluginEditor': 'xleth:audio:closePluginEditor' },
    handler: 'Audio_ClosePluginEditor',
    returns: 'value',
    binary: null,
  },
  {
    method: 'audio_closeAllPluginEditors',
    channels: ['xleth:audio:closeAllPluginEditors'],
    api: { 'audio.closeAllPluginEditors': 'xleth:audio:closeAllPluginEditors' },
    handler: 'Audio_CloseAllPluginEditors',
    returns: 'value',
    binary: null,
  },
  {
    method: 'audio_isPluginEditorOpen',
    channels: ['xleth:audio:isPluginEditorOpen'],
    api: { 'audio.isPluginEditorOpen': 'xleth:audio:isPluginEditorOpen' },
    handler: 'Audio_IsPluginEditorOpen',
    returns: 'value',
    binary: null,
  },
  {
    method: 'audio_getMissingPlugins',
    channels: ['xleth:audio:getMissingPlugins'],
    api: { 'audio.getMissingPlugins': 'xleth:audio:getMissingPlugins' },
    handler: 'Audio_GetMissingPlugins',
    returns: 'value',
    binary: null,
  },
  {
    method: 'audio_retryMissingPlugin',
    channels: ['xleth:audio:retryMissingPlugin'],
    api: { 'audio.retryMissingPlugin': 'xleth:audio:retryMissingPlugin' },
    handler: 'Audio_RetryMissingPlugin',
    returns: 'value',
    binary: null,
  },
  {
    method: 'audio_removeAllMissing',
    channels: ['xleth:audio:removeAllMissing'],
    api: { 'audio.removeAllMissing': 'xleth:audio:removeAllMissing' },
    handler: 'Audio_RemoveAllMissing',
    returns: 'value',
    binary: null,
  },
  {
    method: 'audio_resetCrashedPlugin',
    channels: ['xleth:audio:resetCrashedPlugin'],
    api: { 'audio.resetCrashedPlugin': 'xleth:audio:resetCrashedPlugin' },
    handler: 'Audio_ResetCrashedPlugin',
    returns: 'value',
    binary: null,
  },

  // ── Export progress/cancel + HW encoders + GPU (AUDIT.md S1) ───────────────
  // Pure engine pass-throughs from ui/electron-main/export.js. audio_exportStart
  // and video_exportStart are NOT here: both kick off a 100ms progress-poll
  // interval after forwarding, a real main-process side effect, so they stay
  // hand-written. The video-export methods live under window.xleth.videoExport.*
  // (not video.*); gpu_getAvailableGpus under window.xleth.gpu.*.
  {
    method: 'audio_exportGetProgress',
    channels: ['xleth:audio:exportGetProgress'],
    api: { 'audio.exportGetProgress': 'xleth:audio:exportGetProgress' },
    handler: 'Audio_ExportGetProgress',
    returns: 'value',
    binary: null,
  },
  {
    method: 'audio_exportCancel',
    channels: ['xleth:audio:exportCancel'],
    api: { 'audio.exportCancel': 'xleth:audio:exportCancel' },
    handler: 'Audio_ExportCancel',
    returns: 'value',
    binary: null,
  },
  {
    method: 'video_exportGetProgress',
    channels: ['xleth:video:exportGetProgress'],
    api: { 'videoExport.exportGetProgress': 'xleth:video:exportGetProgress' },
    handler: 'Video_ExportGetProgress',
    returns: 'value',
    binary: null,
  },
  {
    method: 'video_exportCancel',
    channels: ['xleth:video:exportCancel'],
    api: { 'videoExport.exportCancel': 'xleth:video:exportCancel' },
    handler: 'Video_ExportCancel',
    returns: 'value',
    binary: null,
  },
  {
    method: 'hwenc_getAvailableEncoders',
    channels: ['xleth:video:getAvailableEncoders'],
    api: { 'videoExport.getAvailableEncoders': 'xleth:video:getAvailableEncoders' },
    handler: 'HwEnc_GetAvailableEncoders',
    returns: 'value',
    binary: null,
  },
  {
    method: 'hwenc_getDefaultEncoder',
    channels: ['xleth:video:getDefaultEncoder'],
    api: { 'videoExport.getDefaultEncoder': 'xleth:video:getDefaultEncoder' },
    handler: 'HwEnc_GetDefaultEncoder',
    returns: 'value',
    binary: null,
  },
  {
    method: 'gpu_getAvailableGpus',
    channels: ['xleth:gpu:getAvailableGpus'],
    api: { 'gpu.getAvailableGpus': 'xleth:gpu:getAvailableGpus' },
    handler: 'Gpu_GetAvailableGpus',
    returns: 'value',
    binary: null,
  },
];

// Binary kinds addon-worker.js knows how to transport. A manifest entry with
// any other value is a wiring mistake, caught by validateManifest().
const KNOWN_BINARY_KINDS = new Set(['frame', 'midiImport']);

// Graph-broadcast keys rpc-registry.js knows how to map to a key function
// (electron-main/effects.js's trackKey / masterKey). The field is optional —
// absent or null means plain pass-through, no broadcast.
const KNOWN_GRAPH_KEYS = new Set(['track', 'master']);

function validateManifest() {
  const methods = new Set();
  const channels = new Set();
  const apiPaths = new Set();
  for (const m of METHODS) {
    if (!m.method || typeof m.method !== 'string')
      throw new Error(`rpc-manifest: entry with missing method name`);
    if (methods.has(m.method))
      throw new Error(`rpc-manifest: duplicate method '${m.method}'`);
    methods.add(m.method);
    if (!Array.isArray(m.channels) || m.channels.length === 0)
      throw new Error(`rpc-manifest: '${m.method}' has no channels`);
    for (const ch of m.channels) {
      if (channels.has(ch))
        throw new Error(`rpc-manifest: duplicate channel '${ch}'`);
      channels.add(ch);
    }
    if (!m.api || typeof m.api !== 'object')
      throw new Error(`rpc-manifest: '${m.method}' has no api map`);
    for (const [apiPath, ch] of Object.entries(m.api)) {
      if (apiPaths.has(apiPath))
        throw new Error(`rpc-manifest: duplicate api path '${apiPath}'`);
      apiPaths.add(apiPath);
      if (!m.channels.includes(ch))
        throw new Error(
          `rpc-manifest: api '${apiPath}' targets '${ch}' which is not a channel of '${m.method}'`);
    }
    if (!m.handler || typeof m.handler !== 'string')
      throw new Error(`rpc-manifest: '${m.method}' has no engine handler symbol`);
    if (m.returns !== 'value' && m.returns !== 'void')
      throw new Error(`rpc-manifest: '${m.method}' returns must be 'value' or 'void'`);
    if (m.binary !== null && !KNOWN_BINARY_KINDS.has(m.binary))
      throw new Error(`rpc-manifest: '${m.method}' has unknown binary kind '${m.binary}'`);
    if (m.graph !== undefined && m.graph !== null && !KNOWN_GRAPH_KEYS.has(m.graph))
      throw new Error(`rpc-manifest: '${m.method}' has unknown graph key '${m.graph}'`);
  }
  return true;
}

// Build window.xleth.* wrappers from the manifest. `target` is the object
// literal preload.js just created; nested namespaces (timeline, video, …)
// already exist there, but are created on demand so a manifest entry can
// introduce a new namespace without touching preload.js.
function attachRpcWrappers(target, invoke) {
  for (const m of METHODS) {
    for (const [apiPath, channel] of Object.entries(m.api)) {
      const parts = apiPath.split('.');
      let obj = target;
      for (let i = 0; i < parts.length - 1; i++) {
        if (!obj[parts[i]]) obj[parts[i]] = {};
        obj = obj[parts[i]];
      }
      obj[parts[parts.length - 1]] = (...args) => invoke(channel, ...args);
    }
  }
}

module.exports = { METHODS, validateManifest, attachRpcWrappers };
