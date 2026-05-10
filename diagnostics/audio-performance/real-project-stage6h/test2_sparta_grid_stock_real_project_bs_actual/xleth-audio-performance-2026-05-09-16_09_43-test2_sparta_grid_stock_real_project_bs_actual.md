# Xleth Audio Performance Capture

## Summary
- Captured at: 2026-05-09T16:09:13Z
- Diagnosis: Healthy
- Duration: 30.094 s, blocks: 3005
- Sample rate: 48000 Hz, block size: 480

## Realtime CPU
- CPU health: Healthy
- Callback deadline: 10000 us
- Callback p50/p95/p99/max: 1353 / 1585 / 1787 / 3235 us
- MixEngine p50/p95/p99/max: 1351 / 1581 / 1783 / 3227 us
- Callback overruns: 0, MixEngine overruns: 0
- Lock misses: 0, stale chain reuse: 0, dropped telemetry samples: 0

## Telemetry Coverage
- Coverage quality: good
- Expected callback count: 3009
- Callback samples: 3005 (99.8671%)
- MixEngine samples: 3005 (99.8671%)
- Effect samples: 38961
- Dropped during capture: 0
- Capture accumulator overflow drops: 0
- Verbose effect sampling: not downsampled

## Latency / PDC
- Max audible track latency: 204 samples
- Master insert latency: 0 samples
- Device output latency: 480 samples
- Live presentation latency: 684 samples
- Latency epoch changes: 0, compensation target changes: 13
- Interpretation: PDC and presentation latency are expected compensated timing and are separate from CPU deadline pressure.

## RS HQ
- RS HQ was not active in this capture.

## Worst Effects
- unknown track 30 node 3: p99 189 us, max 400 us
- unknown track 33 node 3: p99 168 us, max 301 us
- unknown track 51 node 4: p99 155 us, max 256 us
- limiter track 42 node 3: p99 97 us, max 283 us
- unknown track 36 node 3: p99 81 us, max 192 us
- limiter track 48 node 4: p99 77 us, max 237 us
- unknown track 42 node 5: p99 68 us, max 245 us
- unknown track 45 node 3: p99 62 us, max 191 us

## Diagnosis
- Status: Healthy
- CPU deadline pressure: no callback or MixEngine deadline overrun observed
- PDC / presentation latency: reported separately as compensated timing, not CPU deadline pressure
- Lock / stale-state: no lock misses or stale chain reuse observed
- Telemetry pressure: no dropped telemetry samples observed

Privacy: Report intentionally omits raw media paths, project directories, usernames, and full project JSON.
