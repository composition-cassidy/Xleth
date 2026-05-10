# Xleth Audio Performance Capture

## Summary
- Captured at: 2026-05-09T16:07:08Z
- Diagnosis: Healthy
- Duration: 30.126 s, blocks: 3009
- Sample rate: 48000 Hz, block size: 480

## Realtime CPU
- CPU health: Healthy
- Callback deadline: 10000 us
- Callback p50/p95/p99/max: 287 / 437 / 559 / 3584 us
- MixEngine p50/p95/p99/max: 284 / 434 / 555 / 3576 us
- Callback overruns: 0, MixEngine overruns: 0
- Lock misses: 0, stale chain reuse: 0, dropped telemetry samples: 0

## Telemetry Coverage
- Coverage quality: good
- Expected callback count: 3013
- Callback samples: 3009 (99.8672%)
- MixEngine samples: 3009 (99.8672%)
- Effect samples: 549
- Dropped during capture: 0
- Capture accumulator overflow drops: 0
- Verbose effect sampling: not downsampled

## Latency / PDC
- Max audible track latency: 0 samples
- Master insert latency: 0 samples
- Device output latency: 480 samples
- Live presentation latency: 480 samples
- Latency epoch changes: 0, compensation target changes: 0
- Interpretation: PDC and presentation latency are expected compensated timing and are separate from CPU deadline pressure.

## RS HQ
- RS HQ was not active in this capture.

## Worst Effects
- third_party track 27 node 3: p99 175 us, max 226 us

## Diagnosis
- Status: Healthy
- CPU deadline pressure: no callback or MixEngine deadline overrun observed
- PDC / presentation latency: reported separately as compensated timing, not CPU deadline pressure
- Lock / stale-state: no lock misses or stale chain reuse observed
- Telemetry pressure: no dropped telemetry samples observed

Privacy: Report intentionally omits raw media paths, project directories, usernames, and full project JSON.
