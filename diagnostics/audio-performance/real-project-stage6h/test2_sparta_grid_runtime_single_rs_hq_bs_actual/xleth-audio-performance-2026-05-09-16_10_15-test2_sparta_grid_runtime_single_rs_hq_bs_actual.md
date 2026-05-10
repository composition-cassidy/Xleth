# Xleth Audio Performance Capture

## Summary
- Captured at: 2026-05-09T16:09:44Z
- Diagnosis: Healthy
- Duration: 30.116 s, blocks: 3008
- Sample rate: 48000 Hz, block size: 480

## Realtime CPU
- CPU health: Healthy
- Callback deadline: 10000 us
- Callback p50/p95/p99/max: 1539 / 1812 / 1940 / 3622 us
- MixEngine p50/p95/p99/max: 1537 / 1810 / 1938 / 3619 us
- Callback overruns: 0, MixEngine overruns: 0
- Lock misses: 0, stale chain reuse: 0, dropped telemetry samples: 0

## Telemetry Coverage
- Coverage quality: good
- Expected callback count: 3012
- Callback samples: 3008 (99.8672%)
- MixEngine samples: 3008 (99.8672%)
- Effect samples: 44955
- Dropped during capture: 0
- Capture accumulator overflow drops: 0
- Verbose effect sampling: not downsampled

## Latency / PDC
- Max audible track latency: 204 samples
- Master insert latency: 2048 samples
- Device output latency: 480 samples
- Live presentation latency: 2732 samples
- Latency epoch changes: 0, compensation target changes: 13
- Interpretation: PDC and presentation latency are expected compensated timing and are separate from CPU deadline pressure.

## RS HQ
- Active RS HQ instances: 1
- WOLA p99/max: 197 / 305 us
- Risk: healthy
- Reasons: None
- Recommended action: reduceHqInstances, useNormalQualityForRealtime, useHqForExport
- Appears in worst effects: yes

## Worst Effects
- resonancesuppressor track -1 node 3: p99 225 us, max 348 us
- resonancesuppressor track -1 node 3: p99 197 us, max 305 us
- unknown track 30 node 3: p99 190 us, max 355 us
- unknown track 33 node 3: p99 170 us, max 271 us
- unknown track 51 node 4: p99 145 us, max 221 us
- limiter track 42 node 3: p99 85 us, max 158 us
- unknown track 36 node 3: p99 79 us, max 141 us
- limiter track 48 node 4: p99 77 us, max 218 us

## Diagnosis
- Status: Healthy
- CPU deadline pressure: no callback or MixEngine deadline overrun observed
- PDC / presentation latency: reported separately as compensated timing, not CPU deadline pressure
- Lock / stale-state: no lock misses or stale chain reuse observed
- Telemetry pressure: no dropped telemetry samples observed

Privacy: Report intentionally omits raw media paths, project directories, usernames, and full project JSON.
