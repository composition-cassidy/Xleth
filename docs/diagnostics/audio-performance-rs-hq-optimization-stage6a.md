# Stage 6A RS HQ WOLA Optimization Report

## Run Environment

- Date: 2026-05-09
- Build config: Debug
- Runner target: `xleth_audio_perf_report`
- Sample rate: 48000 Hz
- Block sizes: 64, 128, 256, 512
- Scenario duration: 5 seconds
- Strict mode: off (`XLETH_STRICT_AUDIO_PERF` cleared)
- Output root: `build/engine/audio_perf_scenarios/stress_after_stage6a`

The Stage 5E baseline is `docs/diagnostics/audio-performance-rs-hq-stress-stage5.md`.
Absolute Debug timings are not product gates, but the before/after deltas are useful
because the same MixEngine runner and scenarios were used.

## WOLA Path Map

| Responsibility | Location |
|---|---|
| Telemetry timing section | `XlethResonanceSuppressorEffect::processEffect`, around `wola_.beginBlock()` and `wola_.process*()`, recorded as `rs_wola` |
| WOLA sample accumulation | `WolaProcessor::processMono`, `WolaProcessor::processStereo` |
| Frame readiness | `WolaProcessor::processReadyFrames`, `WolaProcessor::processReadyStereoFrames` |
| Windowing | `WolaProcessor::forwardFrame` |
| FFT | `WolaProcessor::forwardFrame`, `juce::dsp::FFT::performRealOnlyForwardTransform` |
| Magnitude and spectral analysis | `WolaProcessor::updateDetector` |
| Resonance suppression curve | `WolaProcessor::applyReductionMask`, `salienceToReductionDb`, cached weighting table |
| IFFT | `WolaProcessor::inverseAndOverlapAdd`, `performRealOnlyInverseTransform` |
| Overlap-add | `WolaProcessor::inverseAndOverlapAdd`, `SpectralChannelState::addOutput` fallback |
| Dry/wet and trim | `XlethResonanceSuppressorEffect::applyOutputStage` |
| Denormal protection | `XlethEffectBase::processBlock` uses `juce::ScopedNoDenormals` |

## Hotspots Found

- `applyReductionMask` rebuilt the channel-independent frequency weighting curve
  for every bin, every frame, and every processed channel. That repeated `log2`
  and `exp` work even when all weighting parameters were unchanged.
- `applyReductionMask` recomputed block-invariant scalar values per frame/channel:
  max reduction, frame attack/release coefficients, stereo link, detector
  threshold, detector sharpness, and detector curve constants.
- `forwardFrame` cleared the full `fftSize * 2` scratch buffer although the first
  `fftSize` samples are overwritten before the forward transform.
- Steady-state frame reads still paid the defensive `readInput` negative-index
  branch on every frame sample after the initial causal priming period.
- `inverseAndOverlapAdd` used `% hopSize` inside the FFT-size loop and called the
  guarded `addOutput` helper for every output sample even when the frame schedule
  guarantees future output positions.
- `applyOutputStage` recalculated trim gain with `pow` every sample even when the
  trim smoother was stationary.
- Debug-only `std::fprintf` from `processEffect` was compiled into Debug builds.
  It was throttled, but it was still an audio-thread log path during manual
  Debug performance runs.

No heap allocation, lock, graph rebuild, latency publication, or host-visible
formatting was found in the steady-state WOLA frame path after prepare. The
project does not currently have an allocation guard test for this effect, so
allocation safety is documented by audit rather than enforced by a test.

## Optimizations Implemented

- Cached WOLA bin frequencies and the per-bin weighting curve. The curve now
  rebuilds only when weighting-affecting parameters change.
- Cached per-block detector and mask scalars in `beginBlock`.
- Cleared only the FFT scratch half that is not overwritten by input samples.
- Added a steady-state direct ring read path for non-negative frame starts.
- Replaced per-sample OLA modulo with increment/wrap phase indexing.
- Added a direct overlap-add ring write path when output positions are known to
  be future samples, retaining the guarded fallback.
- Cached trim gain inside the output stage when the trim dB value is exactly
  unchanged.
- Made the old Debug audio-thread `fprintf` opt-in with
  `XLETH_RESONANCE_SUPPRESSOR_AUDIO_LOG`.

These changes do not alter FFT size, hop size, window shape, latency reporting,
PDC, presentation timing, export preroll/discard, dynamic latency refresh, or
the suppression curve equations.

## Deferred As Too Risky

- Changing FFT size, hop size, window type, spectral resolution, smoothing
  constants, or latency.
- Replacing the nested local-baseline detector with a prefix-sum implementation.
  It should be a good Stage 6B candidate, but it changes floating-point summation
  order and needs an explicit equivalence test.
- Replacing `log`, `exp`, `pow`, or gain conversion with approximations.
- Hoisting stereo mask application into a single shared mask beyond the existing
  weighting cache. Stereo linking behavior must be proven equivalent first.
- Silent-input WOLA skipping. Tail and state correctness need a targeted proof.
- Background-thread or precomputed spectral processing. That remains a redesign,
  not a Stage 6A micro-optimization.

## Telemetry Scope

The existing `rs_wola` effect-section telemetry was kept. It already identifies
the high-quality WOLA section with stable POD fields:

```text
kind       = effect_section
effectType = resonancesuppressor
flags      = HighQuality | Wola
```

No FFT/mask/IFFT sub-scope timers were added in this pass. The current telemetry
was sufficient to confirm WOLA pressure, and per-frame sub-scope timers would add
multiple `steady_clock` reads and extra ring writes directly inside the WOLA
frame path being optimized.

## Before/After Summary

Timings are microseconds. Callback, MixEngine, and WOLA columns are `p99/max`.
Overruns are callback overruns.

| Scenario | Block | Deadline | Stage 5 callback | Stage 6A callback | Stage 5 MixEngine | Stage 6A MixEngine | Stage 5 WOLA | Stage 6A WOLA | Stage 5 overruns | Stage 6A overruns | Stage 5 class | Stage 6A class |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|
| `resonance_suppressor_high_quality` | 64 | 1333 | 3084/3328 | 2223/2868 | 3082/3325 | 2222/2866 | 2837/3050 | 1967/2423 | 114 | 115 | overrunning | overrunning |
| `resonance_suppressor_high_quality` | 128 | 2667 | 3363/4287 | 2695/3992 | 3361/4286 | 2693/3990 | 3051/3543 | 2421/3633 | 228 | 6 | overrunning | overrunning |
| `resonance_suppressor_high_quality` | 256 | 5333 | 4526/5730 | 3630/5231 | 4522/5725 | 3627/5228 | 3918/4602 | 2924/4389 | 1 | 0 | overrunning | warning |
| `resonance_suppressor_high_quality` | 512 | 10667 | 4699/5999 | 2558/2912 | 4696/5996 | 2556/2910 | 3715/5059 | 2038/2304 | 0 | 0 | healthy | healthy |
| `multi_track_resonance_suppressor_high_quality` | 64 | 1333 | 11904/11943 | 7886/7895 | 11902/11940 | 7884/7893 | 2976/3046 | 1871/1940 | 43 | 43 | overrunning | overrunning |
| `multi_track_resonance_suppressor_high_quality` | 128 | 2667 | 12647/12929 | 11423/11526 | 12645/12927 | 11420/11523 | 3372/3839 | 2711/3453 | 86 | 86 | overrunning | overrunning |
| `multi_track_resonance_suppressor_high_quality` | 256 | 5333 | 14679/16626 | 8630/9037 | 14677/16623 | 8629/9036 | 4411/4968 | 2006/2707 | 170 | 170 | overrunning | overrunning |
| `multi_track_resonance_suppressor_high_quality` | 512 | 10667 | 15101/20239 | 14689/15295 | 15099/20235 | 14687/15291 | 4414/5354 | 3816/4067 | 341 | 13 | overrunning | overrunning |

Lock misses remained `0` and stale chain reuse remained `0` for all eight Stage
6A runs.

## Findings

Single-track HQ improved at 64, 128, and 256 samples. The 256-sample case moved
from `overrunning` to `warning`, with callback p99 dropping from 4526 us to
3630 us and WOLA p99 dropping from 3918 us to 2924 us. The 64 and 128-sample
cases are still classified as `overrunning`, but WOLA p99 and callback p99 both
improved.

Single-track HQ at 512 samples remained healthy and became much cheaper:
callback p99/max dropped from 4699/5999 us to 2558/2912 us, and WOLA p99/max
dropped from 3715/5059 us to 2038/2304 us.

Multi-track HQ improved materially but still overruns at every tested block
size. The 512-sample case is the most important product signal: WOLA p99/max
improved from 4414/5354 us to 3816/4067 us and callback overruns dropped from
341 to 13, but callback p99 is still 14689 us against a 10667 us deadline.

The remaining bottleneck is still cumulative WOLA CPU. At four tracks, each
track can contribute a several-millisecond WOLA section around the same callback
window, which keeps the MixEngine callback over deadline even after the
channel-independent work was cached.

## Tests

- `test_audio_perf_scenarios`: passed, 74 checks.
- `test_audio_telemetry`: passed, 16 checks.
- `test_pdc_stage1`: passed, 485 checks.
- `test_mix`: passed, 243 checks.

Added coverage in `test_pdc_stage1`:

- RS High Quality reports 2048 samples before processing.
- RS High Quality output remains finite through WOLA processing.
- RS High Quality processBlock does not publish latency.
- Weighting-curve parameter changes keep output finite and do not change
  High Quality latency.

Existing coverage continues to prove state restore and prepare paths publish
correct latency, PDC remains aligned, and telemetry identifies RS HQ WOLA timing.

## Report Directories

- `build/engine/audio_perf_scenarios/stress_after_stage6a/resonance_suppressor_high_quality_bs64`
- `build/engine/audio_perf_scenarios/stress_after_stage6a/resonance_suppressor_high_quality_bs128`
- `build/engine/audio_perf_scenarios/stress_after_stage6a/resonance_suppressor_high_quality_bs256`
- `build/engine/audio_perf_scenarios/stress_after_stage6a/resonance_suppressor_high_quality_bs512`
- `build/engine/audio_perf_scenarios/stress_after_stage6a/multi_track_resonance_suppressor_high_quality_bs64`
- `build/engine/audio_perf_scenarios/stress_after_stage6a/multi_track_resonance_suppressor_high_quality_bs128`
- `build/engine/audio_perf_scenarios/stress_after_stage6a/multi_track_resonance_suppressor_high_quality_bs256`
- `build/engine/audio_perf_scenarios/stress_after_stage6a/multi_track_resonance_suppressor_high_quality_bs512`

## Recommended Next Action

Stage 6B should combine one more targeted micro-optimization pass with product
guardrails:

- Prototype a detector local-baseline prefix-sum path behind an equivalence test.
- Add buffer-size and track-count warnings for HQ realtime use.
- Prefer HQ for export or high-buffer live contexts when multiple HQ instances
  are active.
- Keep the background-thread/precomputed spectral path as the longer-term option
  if Stage 6B cannot make multi-track 512-sample playback reliable.
