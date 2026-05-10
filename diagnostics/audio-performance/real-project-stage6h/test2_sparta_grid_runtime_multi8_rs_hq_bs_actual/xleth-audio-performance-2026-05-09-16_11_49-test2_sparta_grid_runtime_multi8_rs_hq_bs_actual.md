# Xleth Audio Performance Capture

## Summary
- Captured at: 2026-05-09T16:11:19Z
- Diagnosis: Warning
- Duration: 30.021 s, blocks: 2997
- Sample rate: 48000 Hz, block size: 480

## Realtime CPU
- CPU health: Warning
- Callback deadline: 10000 us
- Callback p50/p95/p99/max: 2820 / 3075 / 3242 / 4082 us
- MixEngine p50/p95/p99/max: 2818 / 3074 / 3238 / 4076 us
- Callback overruns: 0, MixEngine overruns: 0
- Lock misses: 0, stale chain reuse: 0, dropped telemetry samples: 0

## Telemetry Coverage
- Coverage quality: good
- Expected callback count: 3002
- Callback samples: 2997 (99.8334%)
- MixEngine samples: 2997 (99.8334%)
- Effect samples: 86913
- Dropped during capture: 0
- Capture accumulator overflow drops: 0
- Verbose effect sampling: not downsampled

## Latency / PDC
- Max audible track latency: 204 samples
- Master insert latency: 16384 samples
- Device output latency: 480 samples
- Live presentation latency: 17068 samples
- Latency epoch changes: 0, compensation target changes: 13
- Interpretation: PDC and presentation latency are expected compensated timing and are separate from CPU deadline pressure.

## RS HQ
- Active RS HQ instances: 8
- WOLA p99/max: 197 / 782 us
- Risk: warning
- Reasons: multipleInstances
- Recommended action: reduceHqInstances, useNormalQualityForRealtime, useHqForExport, increaseBufferSize
- Appears in worst effects: yes

## Worst Effects
- unknown track 30 node 3: p99 272 us, max 403 us
- resonancesuppressor track -1 node 3: p99 246 us, max 807 us
- resonancesuppressor track -1 node 4: p99 233 us, max 333 us
- unknown track 33 node 3: p99 232 us, max 300 us
- resonancesuppressor track -1 node 5: p99 226 us, max 319 us
- resonancesuppressor track -1 node 6: p99 225 us, max 297 us
- resonancesuppressor track -1 node 3: p99 212 us, max 782 us
- resonancesuppressor track -1 node 10: p99 211 us, max 308 us

## Diagnosis
- Status: Warning
- CPU deadline pressure: no callback or MixEngine deadline overrun observed
- PDC / presentation latency: reported separately as compensated timing, not CPU deadline pressure
- Lock / stale-state: no lock misses or stale chain reuse observed
- Telemetry pressure: no dropped telemetry samples observed

Privacy: Report intentionally omits raw media paths, project directories, usernames, and full project JSON.
