'use strict';

// ── Quick Launchers ──────────────────────────────────────────────────────────
// Extracted from ui/main.js (S5 Stage 5 decomposition). File pickers for a
// launcher .exe / .png icon and a detached spawn of the chosen executable.
// Dialogs parent to the main window via the injected getWin.

const { ipcMain, dialog } = require('electron');
const { spawn } = require('child_process');
let getWin = () => null;


function init(deps) {
  if (deps && typeof deps.getWin === 'function') getWin = deps.getWin;

  ipcMain.handle('xleth:launcher:chooseExe', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(getWin(), {
      title: 'Choose Executable',
      filters: [{ name: 'Executables', extensions: ['exe'] }],
      properties: ['openFile'],
    })
    return canceled || !filePaths.length ? null : filePaths[0]
  })

  ipcMain.handle('xleth:launcher:choosePng', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(getWin(), {
      title: 'Choose Icon (PNG)',
      filters: [{ name: 'PNG Images', extensions: ['png'] }],
      properties: ['openFile'],
    })
    return canceled || !filePaths.length ? null : filePaths[0]
  })

  ipcMain.handle('xleth:launcher:spawn', (_, exePath) => {
    try {
      spawn(exePath, [], { detached: true, stdio: 'ignore' }).unref()
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

}

module.exports = { init };
