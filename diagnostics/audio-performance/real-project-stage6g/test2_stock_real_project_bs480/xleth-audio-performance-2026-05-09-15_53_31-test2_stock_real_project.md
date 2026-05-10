# Xleth Audio Performance Capture

## Summary
- Captured at: 2026-05-09T15:53:01Z
- Diagnosis: Healthy
- Duration: 30.108 s, blocks: 3010
- Sample rate: 48000 Hz, block size: 480

## Realtime CPU
- CPU health: Healthy
- Callback deadline: 10000 us
- Callback p50/p95/p99/max: 1388 / 1652 / 1850 / 3196 us
- MixEngine p50/p95/p99/max: 1386 / 1650 / 1847 / 3192 us
- Callback overruns: 0, MixEngine overruns: 0
- Lock misses: 0, stale chain reuse: 0, dropped telemetry samples: 0

## Telemetry Coverage
- Coverage quality: good
- Expected callback count: 3011
- Callback samples: 3010 (99.9668%)
- MixEngine samples: 3010 (99.9668%)
- Effect samples: 39130
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
- unknown track 30 node 3: p99 267 us, max 405 us
- unknown track 33 node 3: p99 211 us, max 298 us
- unknown track 51 node 4: p99 166 us, max 225 us
- limiter track 42 node 3: p99 118 us, max 365 us
- limiter track 48 node 4: p99 104 us, max 389 us
- unknown track 36 node 3: p99 101 us, max 180 us
- unknown track 42 node 5: p99 93 us, max 167 us
- unknown track 45 node 3: p99 87 us, max 180 us

## Diagnosis
- Status: Healthy
- CPU deadline pressure: no callback or MixEngine deadline overrun observed
- PDC / presentation latency: reported separately as compensated timing, not CPU deadline pressure
- Lock / stale-state: no lock misses or stale chain reuse observed
- Telemetry pressure: no dropped telemetry samples observed

Privacy: Report intentionally omits raw media paths, project directories, usernames, and full project JSON.
