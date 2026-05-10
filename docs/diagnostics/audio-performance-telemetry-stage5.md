# Stage 5 Audio Performance Telemetry

Stage 5 separates realtime CPU deadline diagnostics from plugin delay
compensation diagnostics. PDC answers "is the audio aligned after known plugin
latency?" Audio performance telemetry answers "did the audio callback finish
before the device needed the next block?"

## Realtime Rule

The audio callback writes only fixed-size POD telemetry samples into a
preallocated SPSC ring, or increments atomics. It does not allocate, log, format
strings, build JSON, or take diagnostic locks. Snapshot aggregation, percentiles,
worst-scope grouping, string names, and JSON conversion happen on the
main/control side when diagnostics are read.

## Captured On The Audio Thread

- Audio callback duration, block size, sample rate, and callback deadline.
- `MixEngine::processBlock` duration and deadline usage.
- Source/render phase timing where the render phase is separated.
- Per-track insert-chain duration.
- Master insert-chain duration.
- Per-effect timing for stock `XlethEffectBase` effects.
- Per-effect timing for `GuardedPluginWrapper` third-party plugins.
- ResonanceSuppressor High Quality WOLA section timing.
- PDC delay processing timing.
- Output post-processing timing where separated.
- Deadline overrun counters.
- Chain mutex try-lock misses.
- Track chain skipped count on chain-lock contention.
- Stale chain state reuse when a pending reset cannot acquire the chain lock.
- Guarded third-party plugin crashed/skipped process count.
- Latency epoch changes observed by audio processing.
- Compensation target changes observed by audio processing.

## Aggregated Off The Audio Thread

`MixEngine::getRealtimeDiagnosticsSnapshot()` drains the telemetry ring and
computes p50/p95/p99/max summaries off the audio thread. The bridge's existing
`audio_getRealtimeDiagnostics()` path receives the same diagnostic object with
additional fields such as:

- `p50ProcessBlockMs`, `p95ProcessBlockMs`, `p99ProcessBlockMs`
- `p50AudioCallbackMs`, `p95AudioCallbackMs`, `p99AudioCallbackMs`
- `droppedTelemetrySamples`
- `masterChainSkippedCount`, `trackChainSkippedCount`
- `staleSnapshotReuseCount`
- `guardedPluginCrashedSkippedCount`
- `latencyEpochChangeCount`
- `worstEffectsByMax`, `worstEffectsByP99`
- `worstChainsByMax`, `worstChainsByP99`
- `recentAudioCallbackUs`

## Bridge API

Stage 5A is exposed to Node/Electron as:

```js
addon.getAudioPerformanceTelemetry()
addon.audio_getAudioPerformanceTelemetry()
```

The UI preload exposes the same snapshot as:

```js
window.xleth.audio.getAudioPerformanceTelemetry()
```

The API returns a plain JavaScript object. Timing summaries use microsecond
fields for diagnostics and also include millisecond fields in nested summaries:

- `sampleRate`, `blockSize`, `callbackDeadlineUs`
- `callback` and `mixEngine`: `{ count, averageUs, p50Us, p95Us, p99Us, maxUs, averageMs, p50Ms, p95Ms, p99Ms, maxMs }`
- `callbackP50Us`, `callbackP95Us`, `callbackP99Us`, `callbackMaxUs`
- `mixEngineP50Us`, `mixEngineP95Us`, `mixEngineP99Us`, `mixEngineMaxUs`
- `callbackOverrunCount`, `mixEngineOverrunCount`, `overBudgetBlockCount`
- `droppedTelemetrySamples`, `lockMissCount`, `masterChainSkippedCount`, `trackChainSkippedCount`, `staleSnapshotReuseCount`
- `guardedPluginCrashedSkippedCount`, `latencyEpochChanges`, `compensationTargetChanges`
- `worstChainsByMax`, `worstChainsByP99`, `worstEffectsByMax`, `worstEffectsByP99`
- `resonanceSuppressorHighQuality`: WOLA call count, average/max WOLA timing, reprepare counters, and realtime-safe status
- `maxAudibleTrackLatencySamples`, `masterInsertLatencySamples`, `audioDeviceOutputLatencySamples`, `livePresentationLatencySamples`
- `rawPositionSamples`, `presentationPositionSamples`

Worst-scope entries include `kind`, `effectTypeName`, `flags`, `trackId`,
`slotOrNodeId`, `count`, `p99Us`, `maxUs`, and a nested `timing` summary.

## UI Panel

The compact diagnostics panel lives in `Settings -> Audio Diagnostics`. It polls
`window.xleth.audio.getAudioPerformanceTelemetry()` every 500 ms while Settings
is open, and stops polling when Settings unmounts.

The panel separates:

- `Latency / PDC`: max audible track latency, master insert latency, device
  output latency, and total live presentation latency.
- `Realtime CPU`: callback deadline, callback p95/p99/max, overrun count,
  dropped telemetry samples, lock misses, and stale chain-state reuse.
- `Worst Effects`: worst effect by max, worst effect by p99, worst chain by
  max, and Resonance Suppressor High Quality WOLA timing when present.

The health label is intentionally small:

- `Healthy`: callback p99 is below 60 percent of the callback deadline and no
  overrun increased since the previous UI poll.
- `Warning`: callback p99 is at or above 60 percent of the deadline, or dropped
  telemetry samples increased.
- `Overrunning`: callback p99 or max meets/exceeds the callback deadline, or
  callback/MixEngine overrun count increased since the previous UI poll.

## Interpreting Overruns

The callback deadline is:

```text
deadlineUs = blockSize / sampleRate * 1,000,000
```

An overrun means measured processing time was greater than or equal to that
deadline. That is a CPU/scheduling deadline failure, not a PDC proof failure.
PDC tests can remain green while the realtime callback still misses its device
deadline under a heavy High Quality effect path.

## High Quality Effects

ResonanceSuppressor High Quality is identified by its WOLA section timing with
`HighQuality` and `Wola` flags. If `rsWolaMaxMs`, the WOLA p99, or a
ResonanceSuppressor entry in `worstEffectsByP99` approaches the callback
deadline, the issue should be diagnosed as CPU pressure unless a separate PDC
alignment test fails.

## Scenario Harness

Stage 5 also includes a deterministic diagnostics harness:

```bat
cmd /c "set Path=& cmake --build build --target test_audio_perf_scenarios --config Debug"
cmd /c "set Path=& set PATH=C:\Users\Krasen\Desktop\XLETH\bridge\build\vcpkg_installed\x64-windows\debug\bin;C:\Windows\System32;C:\Windows& build\engine\Debug\test_audio_perf_scenarios.exe"
```

The harness writes:

```text
build/engine/audio_perf_scenarios/audio-performance-scenarios.json
build/engine/audio_perf_scenarios/audio-performance-scenarios.md
```

Set `XLETH_AUDIO_PERF_REPORT_DIR` to redirect the output. See
`docs/diagnostics/audio-performance-scenarios-stage5.md` for the scenario list,
report schema, soft budget classifications, and strict local mode.

Normal harness tests assert report correctness and telemetry presence, not
machine-specific p95/p99 wall-clock budgets. Optional strict local mode is
enabled with `XLETH_STRICT_AUDIO_PERF=1`.

## Reading PDC Versus CPU

PDC latency is expected delay introduced by plugins and alignment buffers. Xleth
compensates it in the engine and publishes the resulting live presentation
breakdown so the playhead/video view can be delayed by the same amount. Large
`maxAudibleTrackLatencySamples`, `masterInsertLatencySamples`, or
`livePresentationLatencySamples` values are not underruns by themselves.

CPU overrun telemetry is different. A rising `callbackOverrunCount`,
`mixEngineOverrunCount`, p99/max timing at or beyond `callbackDeadlineUs`, or
Resonance Suppressor WOLA timing near the deadline means realtime processing did
not finish with enough margin for the audio device.

`lockMissCount`, `trackChainSkippedCount`, `masterChainSkippedCount`, and
`staleSnapshotReuseCount` indicate contention or stale chain-state reuse around
main-thread chain mutation. They are CPU/realtime-health diagnostics; they do
not change the PDC formula.

XlethEQ Spectral mode, Compressor/Limiter lookahead paths, and third-party
plugins are visible through per-effect timing and chain slot identity. Per-mode
flags are currently explicit for ResonanceSuppressor WOLA; other modes are
identified by effect type and track/node identity.

## Limitations

- Source/render timing is coarse for the current MixEngine render phase; track
  insert chains and individual effects have stronger identity.
- Third-party plugin names are not copied from the realtime thread. They are
  reported under a stable `third_party` effect type with track/node identity.
- The telemetry proves deadline behavior; it deliberately does not publish or
  change host-visible plugin latency.
