'use strict';
const { ipcRenderer } = require('electron');
window.splashIpc = { on: (channel, cb) => ipcRenderer.on(channel, cb) };
