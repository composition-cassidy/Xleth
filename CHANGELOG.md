# Changelog

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
