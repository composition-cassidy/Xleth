'use strict';

const { ipcRenderer } = require('electron');

// Minimal preload for the Welcome window (mandatory startup gate). Mirrors
// splash-preload.js's minimalism rather than the full window.xleth surface —
// Welcome only needs recents, the two existing project folder dialogs,
// project create/load, the generic settings get/set, and its own window
// controls. contextIsolation is off app-wide (see preload.js), so this is a
// direct global assignment like every other preload in this codebase.
window.__xlethWelcomePreloadActive = true;

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

window.xlethWelcome = {
  recents: {
    list:   ()        => invoke('xleth:recentProjects:list'),
    touch:  (entry)    => invoke('xleth:recentProjects:touch', entry),
    remove: (dir)      => invoke('xleth:recentProjects:remove', dir),
  },

  project: {
    // Native folder pickers — reuse the SAME dialogs the in-app File menu
    // already uses (ui/main.js xleth:dialog:*), not new ones.
    chooseNewProjectFolder:  () => invoke('xleth:dialog:newProject'),
    chooseOpenProjectFolder: () => invoke('xleth:dialog:openProject'),
    // Writes project.json to disk immediately (ProjectManager::createProject)
    // and applies the chosen video settings. Resolves { ok, dir, name, error? }.
    create: (form) => invoke('xleth:welcome:createProject', form),
    // Reuses the existing project:load channel (electron-main/project.js) so
    // its xleth:project-loaded broadcast + autosave-restart stay in one
    // place. Resolves a boolean.
    load: (dir) => invoke('xleth:project:load', dir),
  },

  settings: {
    getShowOnStartup: () => invoke('xleth:settings:get', 'showWelcomeOnStartup'),
    setShowOnStartup: (value) => invoke('xleth:settings:set', 'showWelcomeOnStartup', value),
  },

  window: {
    minimize: () => ipcRenderer.send('xleth:welcome:minimize'),
    // The mandatory gate: this does not skip to the workspace under any
    // circumstance. It closes the Welcome window, and because no other
    // top-level window exists yet, Electron's window-all-closed handler
    // quits the whole app (Windows-only, so darwin's dock-stays-open
    // exception in main.js never applies here).
    close: () => ipcRenderer.send('xleth:welcome:close'),
  },

  // Signals main.js that a project was just created/opened successfully —
  // main.js closes this window and opens the real workspace. Distinct from
  // window.close(): that one quits the app.
  projectReady: (dir, name) => ipcRenderer.send('xleth:welcome:projectReady', { dir, name }),
};
