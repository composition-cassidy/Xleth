'use strict';

// ── Phase 1 handlers — Timeline (queries + mutations) ───────────────────────────
// Extracted from ui/main.js (S5 Stage 3 decomposition). Pure pass-through
// handlers to the engine worker, wrapped in main.js's safeHandler at
// registration time, so — like grid-layout.js — registration happens inside
// init(). Region/syllable, pattern and grid handlers live elsewhere.

const { ipcMain } = require('electron');
const { callWorker } = require('./worker');

function init(deps) {
  const { safeHandler } = deps;

  // ── Timeline queries ───────────────────────────────────────────────────────
  // getBPM / getTempoLocked / setBPM are registered by rpc-registry.js from
  // ui/rpc-manifest.js (AUDIT.md S1).

  ipcMain.handle('xleth:timeline:getDeclickMs',
    safeHandler(() => callWorker('timeline_getDeclickMs')));

  ipcMain.handle('xleth:timeline:setDeclickMs',
    safeHandler((_, ms) => callWorker('timeline_setDeclickMs', [ms])));

  ipcMain.handle('xleth:timeline:getGlobalStretchMethod',
    safeHandler(() => callWorker('timeline_getGlobalStretchMethod')));

  ipcMain.handle('xleth:timeline:setGlobalStretchMethod',
    safeHandler((_, method) => callWorker('timeline_setGlobalStretchMethod', [method])));

  ipcMain.handle('xleth:timeline:getSources',
    safeHandler(() => callWorker('timeline_getSources')));

  ipcMain.handle('xleth:timeline:getRegions',
    safeHandler(() => callWorker('timeline_getRegions')));

  ipcMain.handle('xleth:timeline:getRegionsByLabel',
    safeHandler((_, label) => callWorker('timeline_getRegionsByLabel', [label])));

  ipcMain.handle('xleth:timeline:getTracks',
    safeHandler(() => callWorker('timeline_getTracks')));

  ipcMain.handle('xleth:timeline:getClips',
    safeHandler(() => callWorker('timeline_getClips')));

  ipcMain.handle('xleth:timeline:getClipsOnTrack',
    safeHandler((_, trackId) => callWorker('timeline_getClipsOnTrack', [trackId])));

  ipcMain.handle('xleth:timeline:getClipsInRange',
    safeHandler((_, startBeat, endBeat) => callWorker('timeline_getClipsInRange', [startBeat, endBeat])));

  ipcMain.handle('xleth:timeline:getLoopRegion',
    safeHandler(() => callWorker('timeline_getLoopRegion')));

  // ── Timeline mutations ─────────────────────────────────────────────────────

  ipcMain.handle('xleth:timeline:setLoopRegion',
    safeHandler((_, region, minLengthTicks) => callWorker('timeline_setLoopRegion', [region, minLengthTicks])));

  ipcMain.handle('xleth:timeline:setTempoLocked',
    safeHandler((_, locked) => callWorker('timeline_setTempoLocked', [locked])));

  ipcMain.handle('xleth:timeline:addTrack',
    safeHandler((_, info) => callWorker('timeline_addTrack', [info])));

  ipcMain.handle('xleth:timeline:removeTrack',
    safeHandler((_, id) => callWorker('timeline_removeTrack', [id])));

  ipcMain.handle('xleth:timeline:setTrackMuted',
    safeHandler((_, trackId, muted) => callWorker('timeline_setTrackMuted', [trackId, muted])));

  ipcMain.handle('xleth:timeline:setTrackVisualOnly',
    safeHandler((_, trackId, visualOnly) => callWorker('timeline_setTrackVisualOnly', [trackId, visualOnly])));

  ipcMain.handle('xleth:timeline:setTrackSolo',
    safeHandler((_, trackId, solo) => callWorker('timeline_setTrackSolo', [trackId, solo])));

  ipcMain.handle('xleth:timeline:setTrackOrder',
    safeHandler((_, trackIds) => callWorker('timeline_setTrackOrder', [trackIds])));

  ipcMain.handle('xleth:timeline:setTrackOutputRoute',
    safeHandler((_, trackId, targetTrackId) => callWorker('timeline_setTrackOutputRoute', [trackId, targetTrackId])));

  ipcMain.handle('xleth:timeline:getRouting',
    safeHandler(() => callWorker('timeline_getRouting', [])));

  ipcMain.handle('xleth:timeline:addSidechainRoute',
    safeHandler((_, sourceTrackId, route) => callWorker('timeline_addSidechainRoute', [sourceTrackId, route])));

  ipcMain.handle('xleth:timeline:removeSidechainRoute',
    safeHandler((_, sourceTrackId, routeId) => callWorker('timeline_removeSidechainRoute', [sourceTrackId, routeId])));

  ipcMain.handle('xleth:timeline:setSidechainRouteParams',
    safeHandler((_, sourceTrackId, routeId, params) => callWorker('timeline_setSidechainRouteParams', [sourceTrackId, routeId, params])));

  ipcMain.handle('xleth:timeline:setTrackName',
    safeHandler((_, trackId, name) => callWorker('timeline_setTrackName', [trackId, name])));

  ipcMain.handle('xleth:timeline:setTrackFxMode',
    safeHandler((_, trackId, mode) => callWorker('timeline_setTrackFxMode', [trackId, mode])));

  ipcMain.handle('xleth:timeline:setTrackGraphState',
    safeHandler((_, trackId, graphState) => callWorker('timeline_setTrackGraphState', [trackId, graphState])));

  ipcMain.handle('xleth:timeline:setPatternName',
    safeHandler((_, patternId, name) => callWorker('timeline_setPatternName', [patternId, name])));

  ipcMain.handle('xleth:timeline:setPatternRegion',
    safeHandler((_, patternId, regionId) => callWorker('timeline_setPatternRegion', [patternId, regionId])));

  ipcMain.handle('xleth:timeline:convertToPatternTrack',
    safeHandler((_, trackId) => callWorker('timeline_convertToPatternTrack', [trackId])));

  ipcMain.handle('xleth:timeline:convertToClipTrack',
    safeHandler((_, trackId) => callWorker('timeline_convertToClipTrack', [trackId])));

  ipcMain.handle('xleth:timeline:setVideoFlipConfig',
    safeHandler((_, trackId, config) => callWorker('timeline_setVideoFlipConfig', [trackId, config])));

  ipcMain.handle('xleth:timeline:setVideoHoldLastFrame',
    safeHandler((_, trackId, hold) => callWorker('timeline_setVideoHoldLastFrame', [trackId, hold])));

  ipcMain.handle('xleth:timeline:setTrackCornerRadius',
    safeHandler((_, trackId, v) => callWorker('timeline_setTrackCornerRadius', [trackId, v])));

  ipcMain.handle('xleth:timeline:setTrackGapScaleOverride',
    safeHandler((_, trackId, v) => callWorker('timeline_setTrackGapScaleOverride', [trackId, v])));

  ipcMain.handle('xleth:timeline:setTrackSubdivisionFactor',
    safeHandler((_, trackId, factor) => callWorker('timeline_setTrackSubdivisionFactor', [trackId, factor])));

  ipcMain.handle('xleth:timeline:setTrackColor',
    safeHandler((_, trackId, assignment) => callWorker('timeline_setTrackColor', [trackId, assignment])));

  ipcMain.handle('xleth:timeline:setTrackBounceSettings',
    safeHandler((_, trackId, bounce) => callWorker('timeline_setTrackBounceSettings', [trackId, bounce])));

  ipcMain.handle('xleth:timeline:setTrackZoomPanRotSettings',
    safeHandler((_, trackId, zpr) => callWorker('timeline_setTrackZoomPanRotSettings', [trackId, zpr])));

  ipcMain.handle('xleth:timeline:setTrackPingPongSettings',
    safeHandler((_, trackId, pp) => callWorker('timeline_setTrackPingPongSettings', [trackId, pp])));

  ipcMain.handle('xleth:timeline:setTrackSlideNoteEffect',
    safeHandler((_, trackId, s) => callWorker('timeline_setTrackSlideNoteEffect', [trackId, s])));

  ipcMain.handle('xleth:timeline:getPreviewResolutionScale',
    safeHandler(() => callWorker('timeline_getPreviewResolutionScale', [])));
  ipcMain.handle('xleth:timeline:setPreviewResolutionScale',
    safeHandler((_, scale) => callWorker('timeline_setPreviewResolutionScale', [scale])));
  ipcMain.handle('xleth:timeline:getPreviewEffectsBypass',
    safeHandler(() => callWorker('timeline_getPreviewEffectsBypass', [])));
  ipcMain.handle('xleth:timeline:setPreviewEffectsBypass',
    safeHandler((_, bypass) => callWorker('timeline_setPreviewEffectsBypass', [bypass])));
  ipcMain.handle('xleth:timeline:getPreviewPosterMode',
    safeHandler(() => callWorker('timeline_getPreviewPosterMode', [])));
  ipcMain.handle('xleth:timeline:setPreviewPosterMode',
    safeHandler((_, poster) => callWorker('timeline_setPreviewPosterMode', [poster])));

  ipcMain.handle('xleth:timeline:setNoteSlide',
    safeHandler((_, patternId, noteId, isSlide, cx, cy) =>
      callWorker('timeline_setNoteSlide', [patternId, noteId, isSlide, cx, cy])));

  ipcMain.handle('xleth:timeline:addVisualEffect',
    safeHandler((_, trackId, effectType) => callWorker('timeline_addVisualEffect', [trackId, effectType])));
  ipcMain.handle('xleth:timeline:removeVisualEffect',
    safeHandler((_, trackId, idx) => callWorker('timeline_removeVisualEffect', [trackId, idx])));
  ipcMain.handle('xleth:timeline:reorderVisualEffect',
    safeHandler((_, trackId, from, to) => callWorker('timeline_reorderVisualEffect', [trackId, from, to])));
  ipcMain.handle('xleth:timeline:setVisualEffectParam',
    safeHandler((_, trackId, ei, pi, val) => callWorker('timeline_setVisualEffectParam', [trackId, ei, pi, val])));
  ipcMain.handle('xleth:timeline:setVisualEffectBypassed',
    safeHandler((_, trackId, ei, bypassed) => callWorker('timeline_setVisualEffectBypassed', [trackId, ei, bypassed])));
  ipcMain.handle('xleth:timeline:getVisualEffectChain',
    safeHandler((_, trackId) => callWorker('timeline_getVisualEffectChain', [trackId])));
  ipcMain.handle('xleth:timeline:setTrackVisualEffectChainOrder',
    safeHandler((_, trackId, newOrder) => callWorker('timeline_setTrackVisualEffectChainOrder', [trackId, newOrder])));

  ipcMain.handle('xleth:timeline:addClip',
    safeHandler((_, clip) => callWorker('timeline_addClip', [clip])));

  ipcMain.handle('xleth:timeline:addClipsBatch',
    safeHandler((_, clips) => callWorker('timeline_addClipsBatch', [clips])));

  ipcMain.handle('xleth:timeline:removeClip',
    safeHandler((_, id) => callWorker('timeline_removeClip', [id])));

  ipcMain.handle('xleth:timeline:moveClip',
    safeHandler((_, id, trackId, posTicks) => callWorker('timeline_moveClip', [id, trackId, posTicks])));

  ipcMain.handle('xleth:timeline:resizeClip',
    safeHandler((_, id, durTicks) => callWorker('timeline_resizeClip', [id, durTicks])));

  ipcMain.handle('xleth:timeline:resizeClipLeft',
    safeHandler((_, id, posTicks, durTicks, offsetTicks) => callWorker('timeline_resizeClipLeft', [id, posTicks, durTicks, offsetTicks])));

  ipcMain.handle('xleth:timeline:stretchClip',
    safeHandler((_, id, durTicks) => callWorker('timeline_stretchClip', [id, durTicks])));

  ipcMain.handle('xleth:timeline:stretchClipLeft',
    safeHandler((_, id, posTicks, durTicks) => callWorker('timeline_stretchClipLeft', [id, posTicks, durTicks])));

  ipcMain.handle('xleth:timeline:pitchShiftClip',
    safeHandler((_, id, semi, cents) => callWorker('timeline_pitchShiftClip', [id, semi, cents])));

  ipcMain.handle('xleth:timeline:reverseClip',
    safeHandler((_, id) => callWorker('timeline_reverseClip', [id])));

  ipcMain.handle('xleth:timeline:autoTrimClip',
    safeHandler((_, id, thresholdDb) => callWorker('timeline_autoTrimClip', [id, thresholdDb])));

  ipcMain.handle('xleth:timeline:spliceClipsAtPlayhead',
    safeHandler((_, entries) => callWorker('timeline_spliceClipsAtPlayhead', [entries])));

  ipcMain.handle('xleth:timeline:setClipParams',
    safeHandler((_, id, params) => callWorker('timeline_setClipParams', [id, params])));

  ipcMain.handle('xleth:timeline:setClipModulation',
    safeHandler((_, id, modulation) => callWorker('timeline_setClipModulation', [id, modulation])));
}

module.exports = { init };
