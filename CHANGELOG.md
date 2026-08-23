# Changelog

## 1.2.2-beta

### Fixed

- **The packaged app no longer hangs forever on the splash screen.** 1.2.1-beta
  froze at "Starting…" on both the installer and portable builds, and a
  reinstall did not help. `addon-worker.js` runs outside `app.asar` and is
  shipped by a per-file electron-builder entry; it had grown a
  `require('./worker-dispatch-priority.js')` that was never added to that list,
  so the packaged engine worker threw at load. The throw by itself would have
  been survivable — what produced a dead splash is that the worker's
  `uncaughtException` handler did not exit, and its open IPC channel kept the
  process alive, so the main process saw neither a ready signal nor an exit and
  waited on a Promise that could never settle. The missing module is now
  shipped, the worker exits on a fatal startup error so the failure surfaces as
  a real message, engine startup is bounded by a timeout
  (`XLETH_WORKER_READY_TIMEOUT_MS`, default 90s), and a test now fails the build
  if a new worker-side `require` is left unshipped.

## Unreleased

### Changed

- **Zoom/Pan/Rot now interpolates zoom in log2 space (project schema v6).** The
  animation is stored as four keyframe tracks (`panX`, `panY`, `zoomLog2`,
  `rotationDeg`) and evaluated with CSS `cubic-bezier` easing. Projects saved by
  earlier builds migrate automatically: **endpoints and the post-animation hold
  state are bit-exact**, and the named easings map to their exact bezier
  equivalents, but the **interior of a zoom sweep renders differently** — a
  1×→8× sweep now reads 2.83× at its midpoint instead of 4.5×. This is
  intentional: linear zoom interpolation is perceptually non-uniform and made
  long sweeps appear to decelerate. There is no legacy linear mode.
- Animation timing on the live preview now runs off the audio-master transport
  clock instead of an accumulated `steady_clock` delta, so preview and exported
  output match frame-for-frame and frame hitches no longer drop animation time.
