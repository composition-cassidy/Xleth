# Audio Performance Real-Project Capture - Stage 6E

Stage 6E adds a bounded capture/export flow for diagnosing the active project during real playback. It does not change Resonance Suppressor DSP, FFT size, hop size, windowing, PDC, transport semantics, export accounting, live presentation timing, dynamic latency refresh, or host-visible latency reporting.

## How to Capture

Open `Settings -> Audio Diagnostics`.

Use the duration selector (`5s`, `10s`, or `30s`) and press `Capture 10s Performance Report`. Playback can continue while the capture runs. The UI shows `idle`, `capturing`, `exported`, or `failed`, and displays the exported report path on success.

The bridge also exposes:

- `startAudioPerformanceCapture(options)`
- `stopAudioPerformanceCapture()`
- `exportAudioPerformanceCaptureReport(options)`
- `captureAudioPerformanceReport({ seconds, outputDir, includeJson, includeMarkdown, label, strict })`

`seconds` defaults to `10` and is clamped by validation to `3..60`.

## Written Files

The app writes:

- `xleth-audio-performance-<timestamp>-<label>.json`
- `xleth-audio-performance-<timestamp>-<label>.md`

From the UI, files go under the app user-data diagnostics folder. Native bridge callers can pass `outputDir`; otherwise the bridge uses the project diagnostics folder when a project directory exists, or a local diagnostics folder.

## Report Schema

Schema version: `xleth.audioPerformanceCapture.v1`.

The report includes capture time, build configuration, safe project metadata, sample rate, block size, capture duration, captured block/callback counts, callback deadline, callback and MixEngine p50/p95/p99/max, worst chains/effects by p99 and max, RS HQ WOLA p99/max, active RS HQ count, RS HQ risk level/reasons/actions, callback and MixEngine overruns, telemetry drops, lock misses, stale chain reuse, guarded plugin skip/crash counters, latency epoch changes, compensation target changes, PDC/presentation latency fields, raw/presentation positions at capture start/end, and transport playback state.

## Interpretation

The Markdown diagnosis reports one of:

- `Healthy`: captured callbacks and MixEngine work stayed below the deadline and no lock/stale/telemetry pressure was observed.
- `Warning`: timing neared the deadline, RS HQ risk is warning, or lock/stale/telemetry pressure appeared without a captured overrun.
- `Overrunning`: callback or MixEngine timing met/exceeded the callback deadline, or overrun counters advanced.
- `Inconclusive`: no callback or MixEngine blocks were captured.

PDC and live presentation latency are reported separately as compensated timing. They are not treated as CPU deadline pressure.

Lock/stale-state issues are called out from lock-miss and stale-chain-reuse counters. Telemetry pressure is called out from dropped telemetry samples.

## RS HQ Recommendations

When active RS HQ instances are present, the report shows active instance count, WOLA p99/max, whether Resonance Suppressor appears in worst effects, and the existing realtime risk level/reasons. Recommendations are derived from the existing guardrail classifier and include increasing buffer size, reducing HQ instances, using Normal quality for realtime, and reserving HQ for export.

If no RS HQ instance is active, the report states that RS HQ was not active in the capture.

## Privacy

Reports intentionally omit raw media paths, project directories, usernames, and full project JSON. Project metadata is limited to safe, user-visible or aggregate fields such as project name, duration, track count, effect count, source/region/media counts, clip count, and active RS HQ count.

## Known Limitations

- Captures are machine, driver, buffer-size, and project dependent.
- One capture is diagnostic evidence, not final product threshold calibration.
- This pass does not implement background or precomputed spectral processing.
- This pass does not add a risky-HQ preference and does not hard-disable HQ.
