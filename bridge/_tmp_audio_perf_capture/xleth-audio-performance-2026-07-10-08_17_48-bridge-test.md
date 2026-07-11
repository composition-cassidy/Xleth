# Xleth Audio Performance Capture

## Summary
- Captured at: 2026-07-10T08:17:48Z
- Diagnosis: Healthy
- Duration: 0.25 s, blocks: 26
- Sample rate: 44100 Hz, block size: 441

## Realtime CPU
- CPU health: Healthy
- Callback deadline: 10000 us
- Callback p50/p95/p99/max: 187 / 2273 / 2647 / 2647 us
- MixEngine p50/p95/p99/max: 184 / 2271 / 2644 / 2644 us
- Callback overruns: 0, MixEngine overruns: 0
- Lock misses: 0, stale chain reuse: 0, dropped telemetry samples: 0

## Telemetry Coverage
- Coverage quality: good
- Expected callback count: 25
- Callback samples: 26 (104%)
- MixEngine samples: 26 (104%)
- Effect samples: 0
- Dropped during capture: 0
- Capture accumulator overflow drops: 0
- Verbose effect sampling: not downsampled

## Latency / PDC
- Max audible track latency: 0 samples
- Master insert latency: 0 samples
- Device output latency: 441 samples
- Live presentation latency: 441 samples
- Latency epoch changes: 0, compensation target changes: 0
- Interpretation: PDC and presentation latency are expected compensated timing and are separate from CPU deadline pressure.

## RS HQ
- RS HQ was not active in this capture.

## Worst Effects
- None captured.

## Diagnosis
- Status: Healthy
- CPU deadline pressure: no callback or MixEngine deadline overrun observed
- PDC / presentation latency: reported separately as compensated timing, not CPU deadline pressure
- Lock / stale-state: no lock misses or stale chain reuse observed
- Telemetry pressure: no dropped telemetry samples observed

Privacy: Report intentionally omits raw media paths, project directories, usernames, and full project JSON.
