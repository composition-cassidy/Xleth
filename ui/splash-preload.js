'use strict';
const { ipcRenderer } = require('electron');

// Marks the live path in splash.html so its demo boot loop stays disabled —
// electron-main drives window.splashStatus(message, percent) instead.
window.__xlethSplashPreloadActive = true;

ipcRenderer.on('splash:status', (_event, message, percent) => {
  if (typeof window.splashStatus === 'function') {
    window.splashStatus(message, percent);
  }
});
