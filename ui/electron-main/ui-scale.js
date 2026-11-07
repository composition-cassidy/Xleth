'use strict';

// Global UI scale (Phase 7). The scale is the workspace window's Chromium zoom factor:
// 100 % to 200 % in 10 % steps, persisted as the `uiScale` percent in settings. Pure maths
// only (no Electron), so it is unit-tested; main.js applies the result with
// webContents.setZoomFactor.

const DEFAULT_ZOOM_FACTOR = 1;
const MIN_ZOOM_FACTOR = 1;
const MAX_ZOOM_FACTOR = 2;
const ZOOM_STEP = 0.1;
const UI_SCALE_SETTINGS_KEY = 'uiScale';

/** Snap to the 10 % grid inside [1, 2]. Anything non-numeric is 100 %. */
function clampZoomFactor(factor) {
  const f = Number.isFinite(factor) ? factor : DEFAULT_ZOOM_FACTOR;
  // Rounding keeps repeated nudges exact (1.1 + 0.1 + 0.1 drifts in floating point).
  return Math.min(MAX_ZOOM_FACTOR, Math.max(MIN_ZOOM_FACTOR, Math.round(f * 10) / 10));
}

/** The factor to restore from the persisted percent (undefined / garbage -> 100 %). */
function factorFromStoredPercent(percent) {
  const n = Number(percent);
  return Number.isFinite(n) ? clampZoomFactor(n / 100) : DEFAULT_ZOOM_FACTOR;
}

module.exports = {
  DEFAULT_ZOOM_FACTOR,
  MIN_ZOOM_FACTOR,
  MAX_ZOOM_FACTOR,
  ZOOM_STEP,
  UI_SCALE_SETTINGS_KEY,
  clampZoomFactor,
  factorFromStoredPercent,
};
