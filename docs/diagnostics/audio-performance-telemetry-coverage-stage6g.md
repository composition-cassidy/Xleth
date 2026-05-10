# Xleth Audio Performance Telemetry Coverage - Stage 6G

Date: 2026-05-09

## Scope

Stage 6G fixes real-project audio performance telemetry capture coverage. It does not change Resonance Suppressor DSP, FFT size, hop size, window type, suppression equations, MixEngine PDC math, transport semantics, live presentation latency, export preroll/discard, dynamic latency refresh, latency reporting, or RS HQ guardrail policy.

## Root Cause

Stage 6F used a final telemetry snapshot for a 30 second real-project capture. The realtime timing ring is bounded, and the off-thread snapshot history retained only a small tail window. The real project emitted callback, MixEngine, track render, track chain, master chain, effect, RS WOLA, PDC delay, and output-post timing scopes on each callback. That produced roughly 165k-193k timing events over 30 seconds, far above the final retained history window.

As a result, Stage 6F reports kept only 64-74 callback samples from about 3000 expected callbacks and showed 156k-184k dropped timing samples. The overrun counters were still meaningful, but p99/max coverage was too thin for final product decisions.

## Implementation Fix

The telemetry core now has an off-thread capture accumulator. Starting a real-project capture records the starting timing sequence and enables accumulation. A bridge-side drain thread wakes every 250 ms while capture is active and drains pending timing samples from the ring into the accumulator. Any ordinary telemetry snapshot drain also tees samples into the active accumulator, so diagnostics polling does not steal capture samples.

The accumulator is memory-bounded at 1,000,000 timing samples. It keeps accumulator overflow drops explicit. The realtime audio thread still only performs the existing bounded POD timing writes and atomics; all accumulation, percentile computation, JSON formatting, Markdown formatting, and report export remain off the audio thread.

Callback and MixEngine samples are not downsampled. Verbose effect scopes are also retained when capacity allows; Stage 6G did not add deliberate verbose-scope sampling skips.

## Report Schema Additions

Real-project capture JSON/Markdown now includes:

- `cpuHealth`
- `telemetryCoverageQuality`
- `expectedApproxCallbackCount`
- `callbackSampleCount`
- `mixEngineSampleCount`
- `effectSampleCount`
- `callbackCoveragePercent`
- `mixEngineCoveragePercent`
- `effectCoveragePercent`
- `droppedTelemetrySamplesDuringCapture`
- `droppedTelemetryByScope`
- `telemetryCaptureAccumulatorOverflowDrops`
- `verboseEffectSampling`
- `accumulatedTimingSampleCount`

Coverage quality is separate from CPU health and RS HQ risk:

- `good`: callback coverage >= 90%
- `usable`: callback coverage >= 50%
- `poor`: callback coverage < 50%
- `inconclusive`: essential callback/MixEngine evidence missing or extremely low

## Real-Project Capture

Artifacts:

- Summary JSON: `diagnostics/audio-performance/real-project-stage6g/capture-summary.json`
- Stock project: `diagnostics/audio-performance/real-project-stage6g/test2_stock_real_project_bs480/`
- Single RS HQ runtime variant: `diagnostics/audio-performance/real-project-stage6g/test2_runtime_single_rs_hq_bs480/`
- Multi4 RS HQ runtime variant: `diagnostics/audio-performance/real-project-stage6g/test2_runtime_multi4_rs_hq_bs480/`

Configuration:

- Build: Release bridge/native
- Project label: `test 2`
- Device: 48000 Hz, block size 480
- Duration: 30 seconds per row
- Capture cadence: 250 ms off-thread drain

## Before / After Coverage

| Run | Stage | Callback samples | Expected callbacks | Coverage | Dropped telemetry | Callback p99/max us | MixEngine p99/max us | Overruns | Coverage quality |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| stock real project | 6F | 74 | ~3000 | ~2.5% | 156809 | 1531 / 1531 | 1530 / 1530 | 0 | poor |
| stock real project | 6G | 3010 | 3011 | 99.97% | 0 | 1850 / 3196 | 1847 / 3192 | 0 | good |
| single RS HQ | 6F | 71 | ~3000 | ~2.4% | 165866 | 1760 / 1760 | 1758 / 1758 | 0 | poor |
| single RS HQ | 6G | 3012 | 3013 | 99.97% | 0 | 2351 / 3792 | 2346 / 3791 | 0 | good |
| multi4 RS HQ | 6F | 64 | ~3000 | ~2.1% | 183809 | 2321 / 2321 | 2319 / 2319 | 0 | poor |
| multi4 RS HQ | 6G | 3018 | 3020 | 99.93% | 0 | 2681 / 4361 | 2676 / 4358 | 0 | good |

## Interpretation

Stage 6F's conclusion did not change. With healthy telemetry coverage, the same project still did not show callback or MixEngine deadline overruns at the live 480-sample device block. The highest Stage 6G multi4 RS HQ callback max was 4361 us against a 10000 us deadline, with zero callback/MixEngine overruns, zero lock misses, zero stale chain reuse, and zero telemetry drops.

The multi4 RS HQ row remains a warning because the existing warning-only RS HQ guardrail flags multiple active HQ instances. That is guardrail policy, not a confirmed CPU deadline failure.

## Decision

More real-project captures are now trustworthy for 10-30 second diagnosis. Guardrails remain unchanged. Do not add background/precomputed spectral architecture from this evidence. Do not add a risky-HQ preference. Do not hard-disable HQ.

Next recommended stage: Stage 6H should use the improved capture path on additional saved-project RS HQ material and, where the device/API permits, repeat coverage-good captures at smaller actual buffer sizes such as 128, 256, and 512 samples before changing product policy or architecture.
