'use strict';

// ── Pattern / region / note handlers ─────────────────────────────────────────
// Extracted from ui/main.js (S5 Stage 5 decomposition). All timeline_* region,
// syllable, pattern, pattern-block and note pass-throughs. The region/syllable
// group had been orphaned under a Stage-3 clip-defaults breadcrumb in main.js;
// it shares the timeline_* domain with the pattern handlers, so both live here.

const { ipcMain } = require('electron');
const { callWorker } = require('./worker');

function init(deps) {
  const { safeHandler } = deps;
  ipcMain.handle('xleth:timeline:addRegion',
    safeHandler((_, region) => callWorker('timeline_addRegion', [region])));

  ipcMain.handle('xleth:timeline:modifyRegion',
    safeHandler((_, id, region) => callWorker('timeline_modifyRegion', [id, region])));

  ipcMain.handle('xleth:timeline:setSyllables',
    safeHandler((_, id, syllables) => callWorker('timeline_setSyllables', [id, syllables])));

  ipcMain.handle('xleth:timeline:getSyllables',
    safeHandler((_, id) => callWorker('timeline_getSyllables', [id])));

  ipcMain.handle('xleth:timeline:removeRegion',
    safeHandler((_, id) => callWorker('timeline_removeRegion', [id])));


  // ── Pattern handlers ─────────────────────────────────────────────────────────

  ipcMain.handle('xleth:timeline:addPattern',
    safeHandler((_, info) => callWorker('timeline_addPattern', [info])));

  ipcMain.handle('xleth:timeline:getPattern',
    safeHandler((_, id) => callWorker('timeline_getPattern', [id])));

  ipcMain.handle('xleth:timeline:getAllPatterns',
    safeHandler(() => callWorker('timeline_getAllPatterns')));

  ipcMain.handle('xleth:timeline:removePattern',
    safeHandler((_, id) => callWorker('timeline_removePattern', [id])));

  ipcMain.handle('xleth:timeline:updateSamplerSettings',
    safeHandler((_, id, settings) => callWorker('timeline_updateSamplerSettings', [id, settings])));

  ipcMain.handle('xleth:timeline:getPatternAudioInfo',
    safeHandler((_, id) => callWorker('timeline_getPatternAudioInfo', [id])));

  ipcMain.handle('xleth:timeline:getRegionAudioInfo',
    safeHandler((_, regionId) => callWorker('timeline_getRegionAudioInfo', [regionId])));

  // Pipeline B (getRegionWaveformPeaks) retired — replaced by xleth:waveform:getRegionPeaks

  ipcMain.handle('xleth:timeline:addPatternBlock',
    safeHandler((_, block) => callWorker('timeline_addPatternBlock', [block])));

  ipcMain.handle('xleth:timeline:getPatternBlocks',
    safeHandler(() => callWorker('timeline_getPatternBlocks')));

  ipcMain.handle('xleth:timeline:removePatternBlock',
    safeHandler((_, id) => callWorker('timeline_removePatternBlock', [id])));

  ipcMain.handle('xleth:timeline:movePatternBlock',
    safeHandler((_, id, trackId, posTicks) => callWorker('timeline_movePatternBlock', [id, trackId, posTicks])));

  ipcMain.handle('xleth:timeline:resizePatternBlock',
    safeHandler((_, id, durTicks) => callWorker('timeline_resizePatternBlock', [id, durTicks])));

  ipcMain.handle('xleth:timeline:resizePatternBlockLeft',
    safeHandler((_, id, posTicks, durTicks, offTicks) => callWorker('timeline_resizePatternBlockLeft', [id, posTicks, durTicks, offTicks])));

  ipcMain.handle('xleth:timeline:setPatternBlockLoop',
    safeHandler((_, id, enabled) => callWorker('timeline_setPatternBlockLoop', [id, enabled])));

  ipcMain.handle('xleth:timeline:addNote',
    safeHandler((_, patternId, note) => callWorker('timeline_addNote', [patternId, note])));

  ipcMain.handle('xleth:timeline:removeNote',
    safeHandler((_, patternId, noteId) => callWorker('timeline_removeNote', [patternId, noteId])));

  ipcMain.handle('xleth:timeline:moveNote',
    safeHandler((_, patternId, noteId, posTicks, pitch) => callWorker('timeline_moveNote', [patternId, noteId, posTicks, pitch])));

  ipcMain.handle('xleth:timeline:moveNotesBatch',
    safeHandler((_, patternId, moves) => callWorker('timeline_moveNotesBatch', [patternId, moves])));

  ipcMain.handle('xleth:timeline:addNotesBatch',
    safeHandler((_, patternId, notes) => callWorker('timeline_addNotesBatch', [patternId, notes])));

  ipcMain.handle('xleth:fsc:parse',
    safeHandler((_, filePath) => callWorker('fsc_parse', [filePath])));

  ipcMain.handle('xleth:timeline:quantizeClipsBatch',
    safeHandler((_, specs) => callWorker('timeline_quantizeClipsBatch', [specs])));

  ipcMain.handle('xleth:timeline:resizeNotesBatch',
    safeHandler((_, patternId, resizes) => callWorker('timeline_resizeNotesBatch', [patternId, resizes])));

  ipcMain.handle('xleth:timeline:resizeNote',
    safeHandler((_, patternId, noteId, durTicks) => callWorker('timeline_resizeNote', [patternId, noteId, durTicks])));

  ipcMain.handle('xleth:timeline:setNoteVelocity',
    safeHandler((_, patternId, noteId, velocity) => callWorker('timeline_setNoteVelocity', [patternId, noteId, velocity])));

  ipcMain.handle('xleth:timeline:previewNote',
    safeHandler((_, patternId, pitch, velocity) => callWorker('timeline_previewNote', [patternId, pitch, velocity])));

  ipcMain.handle('xleth:timeline:previewNoteOff',
    safeHandler((_, patternId, pitch) => callWorker('timeline_previewNoteOff', [patternId, pitch])));

  ipcMain.handle('xleth:timeline:previewAllNotesOff',
    safeHandler((_, regionId) => callWorker('timeline_previewAllNotesOff', [regionId])));

}

module.exports = { init };
