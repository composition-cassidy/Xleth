'use strict';

// ── Welcome screen (mandatory startup gate) ───────────────────────────────────
// Window lifecycle for the Welcome BrowserWindow, plus the one new piece of
// business logic this feature needs: composing the project directory from
// the New Project form and calling project_create with the chosen video
// settings. Opening a recent / browsed project reuses the existing
// xleth:project:load channel (project.js) directly from welcome-preload.js —
// no duplicate load logic here. Recents persistence is recent-projects.js.
//
// Welcome state and recents live in Electron main/renderer only — this
// module makes exactly one new engine call (the extended project_create;
// see ProjectManager::createProject / Project_Create), everything else
// reuses RPC methods that already existed.

const { BrowserWindow, ipcMain } = require('electron');
const path = require('path');

let welcomeWin = null;

function getWelcomeWindow() {
  return welcomeWin;
}

function createWelcomeWindow({ onReadyToShow, onClosed } = {}) {
  welcomeWin = new BrowserWindow({
    width: 1080,
    height: 700,
    resizable: false,
    icon: path.join(__dirname, '..', 'assets', 'icon.ico'),
    // Matches welcome.html's own --bg token — avoids a white flash before
    // the page's stylesheet paints (same reasoning as splash.html).
    backgroundColor: '#0b0b0b',
    frame: false,
    show: false,
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: false,
      sandbox: false,
      preload: path.join(__dirname, '..', 'welcome-preload.js'),
    },
  });

  welcomeWin.once('ready-to-show', () => {
    if (onReadyToShow) onReadyToShow(welcomeWin);
  });
  welcomeWin.on('closed', () => {
    welcomeWin = null;
    if (onClosed) onClosed();
  });

  welcomeWin.loadFile(path.join(__dirname, '..', 'welcome.html'));
  return welcomeWin;
}

// Sanitizes a project name into a filesystem-safe Windows folder name: drops
// the handful of characters Windows actually rejects in a path segment
// (< > : " / \ | ? * and control chars) plus trailing dots/spaces (Windows
// rejects both there too), and falls back if that leaves nothing. Spaces,
// hyphens and parentheses are left alone — they're valid on Windows and
// stripping them would mangle ordinary names like "Adubuyrus Tribute (WIP)".
const WINDOWS_RESERVED_NAME_CHARS = new RegExp('[<>:"/\\\\|?*\\x00-\\x1f]', 'g');
function sanitizeFolderName(name) {
  const cleaned = String(name || '')
    .replace(WINDOWS_RESERVED_NAME_CHARS, '')
    .trim()
    .replace(/[. ]+$/, '');
  return cleaned || 'Untitled Project';
}

function init(deps) {
  const { safeHandler, callWorker, log } = deps;

  ipcMain.on('xleth:welcome:minimize', () => { welcomeWin?.minimize(); });
  ipcMain.on('xleth:welcome:close', () => { welcomeWin?.close(); });

  ipcMain.on('xleth:welcome:projectReady', (_event, payload) => {
    const dir = payload && typeof payload.dir === 'string' ? payload.dir : null;
    if (!dir) return;
    if (welcomeWin && !welcomeWin.isDestroyed()) welcomeWin.close();
    deps.onProjectReady?.(dir, payload.name);
  });

  ipcMain.handle('xleth:welcome:createProject', safeHandler(async (_event, form) => {
    const parentDir = form && typeof form.parentDir === 'string' ? form.parentDir.trim() : '';
    const name = form && typeof form.name === 'string' ? form.name.trim() : '';
    if (!parentDir || !name) {
      return { ok: false, error: 'Name and folder are both required.' };
    }

    const dir = path.join(parentDir, sanitizeFolderName(name));
    const videoSettings = {
      width: Number(form.width) || 1920,
      height: Number(form.height) || 1080,
      fps: Number(form.fps) || 30,
      aspectRatio: typeof form.aspectRatio === 'string' && form.aspectRatio ? form.aspectRatio : '16:9',
    };

    const ok = await callWorker('project_create', [dir, name, videoSettings]);
    if (!ok) {
      return { ok: false, error: 'The engine could not create the project at ' + dir + '.' };
    }
    log?.(`[Welcome] Created project '${name}' at ${dir}`);
    return { ok: true, dir, name };
  }));
}

module.exports = { init, createWelcomeWindow, getWelcomeWindow, sanitizeFolderName };
