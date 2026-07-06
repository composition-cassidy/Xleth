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
//
// Methods with per-call logic in main.js (arg fixups, dialogs, progress
// intervals) do NOT belong here — only pure pass-throughs migrate.

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

  // ── Transport (Phase 1 extension; play/pause/stop stay Phase 0) (AUDIT.md S1 slice 2) ──
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
];

// Binary kinds addon-worker.js knows how to transport. A manifest entry with
// any other value is a wiring mistake, caught by validateManifest().
const KNOWN_BINARY_KINDS = new Set(['frame', 'midiImport']);

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
