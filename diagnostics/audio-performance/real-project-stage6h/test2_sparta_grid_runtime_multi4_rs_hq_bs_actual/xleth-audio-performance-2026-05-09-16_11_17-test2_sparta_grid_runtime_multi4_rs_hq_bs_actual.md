# Xleth Audio Performance Capture

## Summary
- Captured at: 2026-05-09T16:10:47Z
- Diagnosis: Warning
- Duration: 30.183 s, blocks: 3014
- Sample rate: 48000 Hz, block size: 480

## Realtime CPU
- CPU health: Warning
- Callback deadline: 10000 us
- Callback p50/p95/p99/max: 2107 / 2402 / 2590 / 5408 us
- MixEngine p50/p95/p99/max: 2105 / 2399 / 2586 / 5401 us
- Callback overruns: 0, MixEngine overruns: 0
- Lock misses: 0, stale chain reuse: 0, dropped telemetry samples: 0

## Telemetry Coverage
- Coverage quality: good
- Expected callback count: 3018
- Callback samples: 3014 (99.8675%)
- MixEngine samples: 3014 (99.8675%)
- Effect samples: 62937
- Dropped during capture: 0
- Capture accumulator overflow drops: 0
- Verbose effect sampling: not downsampled

## Latency / PDC
- Max audible track latency: 204 samples
- Master insert latency: 8192 samples
- Device output latency: 480 samples
- Live presentation latency: 8876 samples
- Latency epoch changes: 0, compensation target changes: 13
- Interpretation: PDC and presentation latency are expected compensated timing and are separate from CPU deadline pressure.

## RS HQ
- Active RS HQ instances: 4
- WOLA p99/max: 214 / 330 us
- Risk: warning
- Reasons: multipleInstances
- Recommended action: reduceHqInstances, useNormalQualityForRealtime, useHqForExport, increaseBufferSize
- Appears in worst effects: yes

## Worst Effects
- resonancesuppressor track -1 node 4: p99 249 us, max 351 us
- resonancesuppressor track -1 node 5: p99 245 us, max 338 us
- resonancesuppressor track -1 node 3: p99 244 us, max 393 us
- resonancesuppressor track -1 node 6: p99 230 us, max 321 us
- unknown track 30 node 3: p99 222 us, max 451 us
- resonancesuppressor track -1 node 5: p99 219 us, max 317 us
- resonancesuppressor track -1 node 3: p99 215 us, max 330 us
- resonancesuppressor track -1 node 4: p99 215 us, max 326 us

## Diagnosis
- Status: Warning
- CPU deadline pressure: no callback or MixEngine deadline overrun observed
- PDC / presentation latency: reported separately as compensated timing, not CPU deadline pressure
- Lock / stale-state: no lock misses or stale chain reuse observed
- Telemetry pressure: no dropped telemetry samples observed

Privacy: Report intentionally omits raw media paths, project directories, usernames, and full project JSON.
