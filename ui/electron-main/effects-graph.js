'use strict';

// ── Graph-mode routing + graph-owned effect instances (FXG.3-b) ───────────────
// Extracted from ui/main.js (S5 Stage 4 decomposition). Wire add/remove/gain/
// mute + topology queries (track and master graphs) and the graph-owned engine
// processors keyed by effectInstanceId (FXG.3-b / 3-d / 4-a). Shares the
// trackKey/masterKey broadcast keys with effects.js; wire mutations broadcast
// through main.js's graphHandler.

const { ipcMain } = require('electron');
const { callWorker } = require('./worker');
const { trackKey, masterKey } = require('./effects');

function init(deps) {
  const { safeHandler, graphHandler } = deps;

  ipcMain.handle('xleth:audio:addConnection',
    graphHandler(trackKey, (_, trackId, srcId, dstId) => callWorker('audio_addConnection', [trackId, srcId, dstId])));

  ipcMain.handle('xleth:audio:removeConnection',
    graphHandler(trackKey, (_, trackId, srcId, dstId) => callWorker('audio_removeConnection', [trackId, srcId, dstId])));

  ipcMain.handle('xleth:audio:setWireGain',
    graphHandler(trackKey, (_, trackId, srcId, dstId, gain) => callWorker('audio_setWireGain', [trackId, srcId, dstId, gain])));

  ipcMain.handle('xleth:audio:setWireMute',
    graphHandler(trackKey, (_, trackId, srcId, dstId, muted) => callWorker('audio_setWireMute', [trackId, srcId, dstId, muted])));

  ipcMain.handle('xleth:audio:getGraphTopology',
    safeHandler((_, trackId) => callWorker('audio_getGraphTopology', [trackId])));

  ipcMain.handle('xleth:audio:setNodePosition',
    safeHandler((_, trackId, nodeId, x, y) => callWorker('audio_setNodePosition', [trackId, nodeId, x, y])));

  ipcMain.handle('xleth:audio:isGraphLinear',
    safeHandler((_, trackId) => callWorker('audio_isGraphLinear', [trackId])));

  // ── Graph-owned effect instances (FXG.3-b) ──────────────────────────────────
  // Separate from the chain add/remove handlers. These create/destroy graph-owned
  // engine processors keyed by a stable effectInstanceId and never rewire the
  // linear chain. safeHandler (no graph:changed broadcast) — graphState
  // persistence keeps the renderer in sync; a chain re-fetch is not wanted here.
  ipcMain.handle('xleth:audio:addGraphEffectNode',
    safeHandler((_, trackId, effectInstanceId, pluginId) =>
      callWorker('audio_addGraphEffectNode', [trackId, effectInstanceId, pluginId])));

  ipcMain.handle('xleth:audio:removeGraphEffectNode',
    safeHandler((_, trackId, effectInstanceId) =>
      callWorker('audio_removeGraphEffectNode', [trackId, effectInstanceId])));

  ipcMain.handle('xleth:audio:getGraphEffectEngineNodeId',
    safeHandler((_, trackId, effectInstanceId) =>
      callWorker('audio_getGraphEffectEngineNodeId', [trackId, effectInstanceId])));

  // FXG.4-a: graph-owned effect parameter descriptors. Renderer-facing identity
  // is (trackId, effectInstanceId, parameterId); engine node ids stay internal.
  ipcMain.handle('xleth:audio:getGraphEffectParameters',
    safeHandler((_, trackId, effectInstanceId) =>
      callWorker('audio_getGraphEffectParameters', [trackId, effectInstanceId])));

  ipcMain.handle('xleth:audio:getGraphEffectParameterValue',
    safeHandler((_, trackId, effectInstanceId, parameterId) =>
      callWorker('audio_getGraphEffectParameterValue', [trackId, effectInstanceId, parameterId])));

  ipcMain.handle('xleth:audio:setGraphEffectParameterNormalized',
    safeHandler((_, trackId, effectInstanceId, parameterId, normalizedValue) =>
      callWorker('audio_setGraphEffectParameterNormalized', [trackId, effectInstanceId, parameterId, normalizedValue])));

  ipcMain.handle('xleth:audio:hydrateGraphEffectNodes',
    safeHandler((_, trackId, graphEffectNodes) =>
      callWorker('audio_hydrateGraphEffectNodes', [trackId, graphEffectNodes])));

  ipcMain.handle('xleth:audio:syncLinearGraphTopology',
    safeHandler((_, trackId, topology) =>
      callWorker('audio_syncLinearGraphTopology', [trackId, topology])));

  // FXG.3-d: general graph-mode runtime routing (linear OR parallel) + chain
  // processor adoption on chain→graph conversion.
  ipcMain.handle('xleth:audio:syncGraphTopology',
    safeHandler((_, trackId, topology) =>
      callWorker('audio_syncGraphTopology', [trackId, topology])));

  ipcMain.handle('xleth:audio:adoptGraphEffectNodes',
    safeHandler((_, trackId, mapping) =>
      callWorker('audio_adoptGraphEffectNodes', [trackId, mapping])));

  ipcMain.handle('xleth:audio:addMasterConnection',
    graphHandler(masterKey, (_, srcId, dstId) => callWorker('audio_addMasterConnection', [srcId, dstId])));

  ipcMain.handle('xleth:audio:removeMasterConnection',
    graphHandler(masterKey, (_, srcId, dstId) => callWorker('audio_removeMasterConnection', [srcId, dstId])));

  ipcMain.handle('xleth:audio:setMasterWireGain',
    graphHandler(masterKey, (_, srcId, dstId, gain) => callWorker('audio_setMasterWireGain', [srcId, dstId, gain])));

  ipcMain.handle('xleth:audio:setMasterWireMute',
    graphHandler(masterKey, (_, srcId, dstId, muted) => callWorker('audio_setMasterWireMute', [srcId, dstId, muted])));

  ipcMain.handle('xleth:audio:getMasterGraphTopology',
    safeHandler(() => callWorker('audio_getMasterGraphTopology')));

  ipcMain.handle('xleth:audio:setMasterNodePosition',
    safeHandler((_, nodeId, x, y) => callWorker('audio_setMasterNodePosition', [nodeId, x, y])));

  ipcMain.handle('xleth:audio:isMasterGraphLinear',
    safeHandler(() => callWorker('audio_isMasterGraphLinear')));
}

module.exports = { init };
