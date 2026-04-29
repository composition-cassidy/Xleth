'use strict';

const path = require('path');

function electronApp() {
  try {
    return require('electron').app || null;
  } catch {
    return null;
  }
}

function appPath() {
  const app = electronApp();
  if (app && typeof app.getAppPath === 'function') return app.getAppPath();
  return __dirname;
}

function isPackagedRuntime() {
  const app = electronApp();
  if (app && typeof app.isPackaged === 'boolean') return app.isPackaged;
  return typeof process.resourcesPath === 'string' && __dirname.toLowerCase().includes('.asar');
}

function devRepoRoot() {
  return path.resolve(appPath(), '..');
}

function devResourceRoot(bucket) {
  const repoRoot = devRepoRoot();
  switch (bucket) {
    case 'worker':
      return appPath();
    case 'bridge':
      return path.join(repoRoot, 'bridge', 'build', 'Release');
    case 'shm_helper':
      return path.join(repoRoot, 'shm_helper', 'build', 'Release');
    case 'media':
      return path.join(repoRoot, 'media');
    case 'engine':
      return path.join(repoRoot, 'build', 'engine', 'XlethEngine_artefacts', 'Release');
    case 'ffmpeg':
      return path.join(repoRoot, 'vendor', 'ffmpeg', 'bin');
    case 'node':
      return path.join(repoRoot, 'vendor', 'node');
    default:
      return path.join(repoRoot, bucket);
  }
}

function runtimeResource(...segments) {
  if (!segments.length) {
    return isPackagedRuntime() ? process.resourcesPath : devRepoRoot();
  }

  const [bucket, ...rest] = segments;

  // App code stays inside the Electron app bundle/app.asar. Native/runtime
  // artifacts live beside it under process.resourcesPath.
  if (bucket === 'app') return path.join(appPath(), ...rest);

  if (isPackagedRuntime()) return path.join(process.resourcesPath, ...segments);

  return path.join(devResourceRoot(bucket), ...rest);
}

function userDataPath(...segments) {
  const app = electronApp();
  if (!app || typeof app.getPath !== 'function') {
    throw new Error('userDataPath is only available in the Electron main process');
  }
  return path.join(app.getPath('userData'), ...segments);
}

module.exports = {
  runtimeResource,
  userDataPath,
  isPackagedRuntime,
};
