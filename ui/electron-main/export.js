'use strict';

// ── Audio + Video export (progress polling + hardware-encoder / GPU queries) ──
// Extracted from ui/main.js (S5 Stage 5 decomposition). Owns the two export
// progress-poll intervals (audio + video) and exposes isExportBusy() for the
// autosave gate in main.js. The video handlers are physically split from their
// progress-poll helper in main.js by the WORLD-poll section (which stays inline);
// they are reunited here. Progress events go to the main window via getWin().

const { ipcMain } = require('electron');
const { callWorker } = require('./worker');

let getWin = () => null;

let exportProgressInterval = null;
function startExportProgressPoll() {
  if (exportProgressInterval) return;
  exportProgressInterval = setInterval(async () => {
    try {
      const p = await callWorker('audio_exportGetProgress', []);
      if (!p) return;
      const _w = getWin(); if (_w && !_w.isDestroyed()) _w.webContents.send('export:progress', p);
      if (!p.running) {
        clearInterval(exportProgressInterval);
        exportProgressInterval = null;
      }
    } catch {}
  }, 100);
}


let videoExportProgressInterval = null;
function startVideoExportProgressPoll() {
  if (videoExportProgressInterval) return;
  videoExportProgressInterval = setInterval(async () => {
    try {
      const p = await callWorker('video_exportGetProgress', []);
      if (!p) return;
      const _w = getWin(); if (_w && !_w.isDestroyed()) _w.webContents.send('video-export:progress', p);
      if (!p.running) {
        clearInterval(videoExportProgressInterval);
        videoExportProgressInterval = null;
      }
    } catch {}
  }, 100);
}


function isExportBusy() {
  return exportProgressInterval !== null || videoExportProgressInterval !== null;
}

function init(deps) {
  const { safeHandler } = deps;
  if (deps && typeof deps.getWin === 'function') getWin = deps.getWin;

  // exportStart (audio + video) stays hand-written: after forwarding to the
  // worker it kicks off the 100ms progress-poll interval — a real main-process
  // side effect a generic manifest pass-through cannot express. The
  // exportGetProgress / exportCancel handlers (audio + video), the hardware
  // encoder queries, and gpu_getAvailableGpus all migrated to the RPC manifest
  // (ui/rpc-manifest.js).
  ipcMain.handle('xleth:audio:exportStart',
    safeHandler(async (_, cfg) => {
      const ok = await callWorker('audio_exportStart', [cfg]);
      if (ok) startExportProgressPoll();
      return ok;
    }));

  ipcMain.handle('xleth:video:exportStart', safeHandler(async (_, cfg) => {
    const ok = await callWorker('video_exportStart', [cfg]);
    if (ok) startVideoExportProgressPoll();
    return ok;
  }));

}

module.exports = { init, isExportBusy };
