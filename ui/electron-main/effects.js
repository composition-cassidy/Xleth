'use strict';

// ── P3 — Effect Chain + effect parameter / meter access ──────────────────────
// Extracted from ui/main.js (S5 Stage 4 decomposition). Chain add/remove/move/
// bypass (track + master), generic effect parameter/meter access, the dynamics
// effect visualization drain (binary ArrayBuffer payload) and the EQ- /
// SmartBalance- / Waveshaper-specific accessors. Chain mutations broadcast
// xleth:graph:changed through main.js's graphHandler; trackKey/masterKey are
// the broadcast keys, shared with effects-graph.js (exported below).

const { ipcMain } = require('electron');
const { callWorker } = require('./worker');

const trackKey = (_, trackId) => String(trackId);
const masterKey = () => 'master';

function init(deps) {
  const { safeHandler, graphHandler } = deps;

  ipcMain.handle('xleth:audio:addEffect',
    graphHandler(trackKey, (_, trackId, pluginId, position) => callWorker('audio_addEffect', [trackId, pluginId, position])));

  ipcMain.handle('xleth:audio:removeEffect',
    graphHandler(trackKey, (_, trackId, nodeId) => callWorker('audio_removeEffect', [trackId, nodeId])));

  ipcMain.handle('xleth:audio:moveEffect',
    graphHandler(trackKey, (_, trackId, nodeId, newPosition) => callWorker('audio_moveEffect', [trackId, nodeId, newPosition])));

  ipcMain.handle('xleth:audio:setEffectBypass',
    graphHandler(trackKey, (_, trackId, nodeId, bypassed) => callWorker('audio_setEffectBypass', [trackId, nodeId, bypassed])));

  ipcMain.handle('xleth:audio:getEffectChain',
    safeHandler((_, trackId) => callWorker('audio_getEffectChain', [trackId])));

  ipcMain.handle('xleth:audio:addMasterEffect',
    graphHandler(masterKey, (_, pluginId, position) => callWorker('audio_addMasterEffect', [pluginId, position])));

  ipcMain.handle('xleth:audio:removeMasterEffect',
    graphHandler(masterKey, (_, nodeId) => callWorker('audio_removeMasterEffect', [nodeId])));

  ipcMain.handle('xleth:audio:moveMasterEffect',
    graphHandler(masterKey, (_, nodeId, newPosition) => callWorker('audio_moveMasterEffect', [nodeId, newPosition])));

  ipcMain.handle('xleth:audio:setMasterEffectBypass',
    graphHandler(masterKey, (_, nodeId, bypassed) => callWorker('audio_setMasterEffectBypass', [nodeId, bypassed])));

  ipcMain.handle('xleth:audio:getMasterEffectChain',
    safeHandler(() => callWorker('audio_getMasterEffectChain')));

  // ── Generic effect parameter / meter access ───────────────────────────────

  ipcMain.handle('xleth:audio:getEffectParameters',
    safeHandler((_, trackId, nodeId) => callWorker('audio_getEffectParameters', [trackId, nodeId])));

  ipcMain.handle('xleth:audio:setEffectParameter',
    safeHandler((_, trackId, nodeId, paramId, value) => callWorker('audio_setEffectParameter', [trackId, nodeId, paramId, value])));

  ipcMain.handle('xleth:audio:getEffectMeter',
    safeHandler((_, trackId, nodeId) => callWorker('audio_getEffectMeter', [trackId, nodeId])));

  // ── Effect visualization (dynamics; binary ArrayBuffer payload) ────────────
  ipcMain.handle('xleth:audio:setEffectVisualizationEnabled',
    safeHandler((_, trackId, nodeId, enabled) =>
      callWorker('audio_setEffectVisualizationEnabled', [trackId, nodeId, !!enabled])));

  ipcMain.handle('xleth:audio:drainEffectVizFrames',
    safeHandler((_, trackId, nodeId, maxBuckets) =>
      callWorker('audio_drainEffectVizFrames', [trackId, nodeId, maxBuckets | 0])));

  // ── EQ-specific ────────────────────────────────────────────────────────────

  ipcMain.handle('xleth:audio:eqAddBand',
    safeHandler((_, trackId, nodeId) => callWorker('audio_eqAddBand', [trackId, nodeId])));

  ipcMain.handle('xleth:audio:eqRemoveBand',
    safeHandler((_, trackId, nodeId, bandIndex) => callWorker('audio_eqRemoveBand', [trackId, nodeId, bandIndex])));

  ipcMain.handle('xleth:audio:eqSetBandParam',
    safeHandler((_, trackId, nodeId, bandIndex, paramName, value) => callWorker('audio_eqSetBandParam', [trackId, nodeId, bandIndex, paramName, value])));

  ipcMain.handle('xleth:audio:eqGetResponseCurve',
    safeHandler((_, trackId, nodeId) => callWorker('audio_eqGetResponseCurve', [trackId, nodeId])));

  ipcMain.handle('xleth:audio:eqGetSpectrumData',
    safeHandler((_, trackId, nodeId) => callWorker('audio_eqGetSpectrumData', [trackId, nodeId])));

  ipcMain.handle('xleth:audio:eqSetPreSpectrum',
    safeHandler((_, trackId, nodeId, enabled) => callWorker('audio_eqSetPreSpectrum', [trackId, nodeId, enabled])));

  ipcMain.handle('xleth:audio:eqGetBands',
    safeHandler((_, trackId, nodeId) => callWorker('audio_eqGetBands', [trackId, nodeId])));

  ipcMain.handle('xleth:audio:eqGetBandGR',
    safeHandler((_, trackId, nodeId) => callWorker('audio_eqGetBandGR', [trackId, nodeId])));

  ipcMain.handle('xleth:audio:eqSetGlobalParam',
    safeHandler((_, trackId, nodeId, paramName, value) => callWorker('audio_eqSetGlobalParam', [trackId, nodeId, paramName, value])));

  ipcMain.handle('xleth:audio:eqGetGlobalParams',
    safeHandler((_, trackId, nodeId) => callWorker('audio_eqGetGlobalParams', [trackId, nodeId])));

  ipcMain.handle('xleth:audio:eqGetSampleRate',
    safeHandler((_, trackId, nodeId) => callWorker('audio_eqGetSampleRate', [trackId, nodeId])));

  // ── SmartBalance-specific ──────────────────────────────────────────────────

  ipcMain.handle('xleth:audio:smartBalanceGetDebug',
    safeHandler((_, trackId, nodeId) => callWorker('audio_smartBalanceGetDebug', [trackId, nodeId])));

  // ── Waveshaper-specific ────────────────────────────────────────────────────

  ipcMain.handle('xleth:audio:wsGetCurvePoints',
    safeHandler((_, trackId, nodeId) => callWorker('audio_wsGetCurvePoints', [trackId, nodeId])));

  ipcMain.handle('xleth:audio:wsSetCurvePoints',
    safeHandler((_, trackId, nodeId, pointsJSON) => callWorker('audio_wsSetCurvePoints', [trackId, nodeId, pointsJSON])));

  ipcMain.handle('xleth:audio:wsSetPreset',
    safeHandler((_, trackId, nodeId, presetIndex) => callWorker('audio_wsSetPreset', [trackId, nodeId, presetIndex])));
}

module.exports = { init, trackKey, masterKey };
