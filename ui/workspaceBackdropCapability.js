'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const WORKSPACE_BACKDROP_CACHE_FILE = 'workspace-backdrop-capability.json';
const WORKSPACE_BACKDROP_DEFAULT_PREFERENCE = 'acrylic';
const WORKSPACE_BACKDROP_MIN_WINDOWS_BUILD = 22621;
const WORKSPACE_BACKDROP_PREFERENCES = new Set(['off', 'acrylic', 'image', 'video']);

function sanitizeWorkspaceBackdropPreference(value) {
  return WORKSPACE_BACKDROP_PREFERENCES.has(value)
    ? value
    : WORKSPACE_BACKDROP_DEFAULT_PREFERENCE;
}

function getWorkspaceBackdropCachePath(appLike) {
  if (!appLike || typeof appLike.getPath !== 'function') {
    throw new Error('getWorkspaceBackdropCachePath requires an Electron app-like object');
  }
  return path.join(appLike.getPath('userData'), WORKSPACE_BACKDROP_CACHE_FILE);
}

function getSystemVersionString(processLike = process, osLike = os) {
  try {
    if (processLike && typeof processLike.getSystemVersion === 'function') {
      const version = processLike.getSystemVersion();
      if (typeof version === 'string' && version.trim()) return version.trim();
    }
  } catch {}

  try {
    const release = osLike && typeof osLike.release === 'function' ? osLike.release() : '';
    return typeof release === 'string' ? release.trim() : '';
  } catch {
    return '';
  }
}

function parseWindowsBuild(osVersion) {
  if (typeof osVersion !== 'string') return null;
  const parts = osVersion.match(/\d+/g);
  if (!parts || parts.length === 0) return null;

  const buildText = parts.length >= 3 ? parts[2] : parts[parts.length - 1];
  const build = Number(buildText);
  return Number.isInteger(build) && build >= 0 ? build : null;
}

function computeWorkspaceBackdropCapability({
  platform,
  osVersion,
  windowsBuild,
  minimumWindowsBuild = WORKSPACE_BACKDROP_MIN_WINDOWS_BUILD,
} = {}) {
  const resolvedPlatform = typeof platform === 'string' ? platform : process.platform;
  const resolvedOsVersion = typeof osVersion === 'string' ? osVersion : '';
  const resolvedBuild = Number.isInteger(windowsBuild)
    ? windowsBuild
    : parseWindowsBuild(resolvedOsVersion);
  const supportsNativeSystemBackdrop = (
    resolvedPlatform === 'win32'
    && Number.isInteger(resolvedBuild)
    && resolvedBuild >= minimumWindowsBuild
  );

  return {
    platform: resolvedPlatform,
    osVersion: resolvedOsVersion,
    windowsBuild: Number.isInteger(resolvedBuild) ? resolvedBuild : null,
    supportsNativeSystemBackdrop,
    preferredMaterial: supportsNativeSystemBackdrop ? 'acrylic' : 'none',
  };
}

function getCurrentWorkspaceBackdropCapabilityInput({
  processRef = process,
  osRef = os,
} = {}) {
  const osVersion = getSystemVersionString(processRef, osRef);
  return {
    platform: processRef && typeof processRef.platform === 'string'
      ? processRef.platform
      : process.platform,
    osVersion,
    windowsBuild: parseWindowsBuild(osVersion),
  };
}

function isValidCapabilityShape(value) {
  return !!value
    && typeof value === 'object'
    && typeof value.platform === 'string'
    && typeof value.osVersion === 'string'
    && (Number.isInteger(value.windowsBuild) || value.windowsBuild === null)
    && typeof value.supportsNativeSystemBackdrop === 'boolean'
    && typeof value.preferredMaterial === 'string';
}

function isMatchingCapabilityCache(cached, current) {
  return isValidCapabilityShape(cached)
    && cached.platform === current.platform
    && cached.osVersion === current.osVersion
    && cached.windowsBuild === current.windowsBuild;
}

function readCapabilityCache(cachePath, fsRef = fs) {
  try {
    return JSON.parse(fsRef.readFileSync(cachePath, 'utf8'));
  } catch {
    return null;
  }
}

function writeCapabilityCache(cachePath, capability, fsRef = fs) {
  try {
    fsRef.mkdirSync(path.dirname(cachePath), { recursive: true });
    fsRef.writeFileSync(cachePath, JSON.stringify(capability, null, 2), 'utf8');
  } catch {}
}

function loadWorkspaceBackdropCapability({
  cachePath,
  processRef = process,
  osRef = os,
  fsRef = fs,
} = {}) {
  const current = getCurrentWorkspaceBackdropCapabilityInput({ processRef, osRef });
  const cached = cachePath ? readCapabilityCache(cachePath, fsRef) : null;
  if (cached && isMatchingCapabilityCache(cached, current)) return cached;

  const capability = computeWorkspaceBackdropCapability(current);
  if (cachePath) writeCapabilityCache(cachePath, capability, fsRef);
  return capability;
}

function applyWorkspaceBackdropMaterial(win, {
  capability,
  preference,
} = {}) {
  const resolvedPreference = sanitizeWorkspaceBackdropPreference(preference);
  const rendererMode = ['image', 'video'].includes(resolvedPreference) ? resolvedPreference : 'off';
  const methodExists = !!(win && typeof win.setBackgroundMaterial === 'function');
  const wantsNativeAcrylic = (
    resolvedPreference === 'acrylic'
    && capability
    && capability.supportsNativeSystemBackdrop === true
  );
  const requestedMaterial = wantsNativeAcrylic ? 'acrylic' : 'none';

  if (!methodExists) {
    return {
      mode: rendererMode,
      materialMethodExists: false,
      requestedMaterial,
      appliedMaterial: null,
      applySucceeded: false,
      error: requestedMaterial === 'acrylic'
        ? 'setBackgroundMaterial unavailable'
        : null,
      resetSucceeded: false,
    };
  }

  if (requestedMaterial === 'none') {
    try {
      win.setBackgroundMaterial('none');
      return {
        mode: rendererMode,
        materialMethodExists: true,
        requestedMaterial,
        appliedMaterial: 'none',
        applySucceeded: true,
        error: null,
        resetSucceeded: true,
      };
    } catch (err) {
      return {
        mode: rendererMode,
        materialMethodExists: true,
        requestedMaterial,
        appliedMaterial: null,
        applySucceeded: false,
        error: err,
        resetSucceeded: false,
      };
    }
  }

  try {
    win.setBackgroundMaterial('acrylic');
    return {
      mode: 'native-acrylic',
      materialMethodExists: true,
      requestedMaterial,
      appliedMaterial: 'acrylic',
      applySucceeded: true,
      error: null,
      resetSucceeded: false,
    };
  } catch (err) {
    let resetSucceeded = false;
    try {
      win.setBackgroundMaterial('none');
      resetSucceeded = true;
    } catch {}
    return {
      mode: 'off',
      materialMethodExists: true,
      requestedMaterial,
      appliedMaterial: resetSucceeded ? 'none' : null,
      applySucceeded: false,
      error: err,
      resetSucceeded,
    };
  }
}

module.exports = {
  WORKSPACE_BACKDROP_CACHE_FILE,
  WORKSPACE_BACKDROP_DEFAULT_PREFERENCE,
  WORKSPACE_BACKDROP_MIN_WINDOWS_BUILD,
  applyWorkspaceBackdropMaterial,
  computeWorkspaceBackdropCapability,
  getCurrentWorkspaceBackdropCapabilityInput,
  getSystemVersionString,
  getWorkspaceBackdropCachePath,
  isMatchingCapabilityCache,
  loadWorkspaceBackdropCapability,
  parseWindowsBuild,
  sanitizeWorkspaceBackdropPreference,
};
