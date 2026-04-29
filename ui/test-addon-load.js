'use strict';
const path = require('path');
const fs = require('fs');
const { runtimeResource } = require('./runtimePaths');
const dllDir = runtimeResource('bridge');
const ffmpegDir = runtimeResource('ffmpeg');
const pathEntries = [dllDir];
if (fs.existsSync(ffmpegDir)) pathEntries.push(ffmpegDir);
if (process.env.PATH) pathEntries.push(process.env.PATH);
process.env.PATH = pathEntries.join(path.delimiter);
console.log('Before require');
console.log('PATH head:', process.env.PATH.slice(0, 200));
try {
  const addonPath = path.join(dllDir, 'xleth_native.node');
  console.log('Addon path:', addonPath);
  const xleth = require(addonPath);
  console.log('After require, keys:', Object.keys(xleth).slice(0, 8));
} catch (e) {
  console.log('Error:', e.message);
}
console.log('Done');
process.exit(0);
