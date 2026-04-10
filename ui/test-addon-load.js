'use strict';
const path = require('path');
const dllDir = path.resolve(__dirname, '../bridge/build/Release');
const vcpkgBin = path.resolve(__dirname, '../build/vcpkg_installed/x64-windows/bin');
process.env.PATH = dllDir + ';' + vcpkgBin + ';' + process.env.PATH;
console.log('Before require');
console.log('PATH head:', process.env.PATH.slice(0, 200));
try {
  const addonPath = path.resolve(__dirname, '../bridge/build/Release/xleth_native.node');
  console.log('Addon path:', addonPath);
  const xleth = require(addonPath);
  console.log('After require, keys:', Object.keys(xleth).slice(0, 8));
} catch (e) {
  console.log('Error:', e.message);
}
console.log('Done');
process.exit(0);
