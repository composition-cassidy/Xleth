# Xleth Audio Performance Capture

## Summary
- Captured at: 2026-05-09T15:54:02Z
- Diagnosis: Warning
- Duration: 30.195 s, blocks: 3018
- Sample rate: 48000 Hz, block size: 480

## Realtime CPU
- CPU health: Warning
- Callback deadline: 10000 us
- Callback p50/p95/p99/max: 2169 / 2451 / 2681 / 4361 us
- MixEngine p50/p95/p99/max: 2167 / 2449 / 2676 / 4358 us
- Callback overruns: 0, MixEngine overruns: 0
- Lock misses: 0, stale chain reuse: 0, dropped telemetry samples: 0

## Telemetry Coverage
- Coverage quality: good
- Expected callback count: 3020
- Callback samples: 3018 (99.9338%)
- MixEngine samples: 3018 (99.9338%)
- Effect samples: 63378
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
- WOLA p99/max: 208 / 549 us
- Risk: warning
- Reasons: multipleInstances
- Recommended action: reduceHqInstances, useNormalQualityForRealtime, useHqForExport, increaseBufferSize
- Appears in worst effects: yes

## Worst Effects
- resonancesuppressor track -1 node 5: p99 240 us, max 403 us
- resonancesuppressor track -1 node 4: p99 234 us, max 464 us
- resonancesuppressor track -1 node 3: p99 230 us, max 575 us
- resonancesuppressor track -1 node 6: p99 229 us, max 405 us
- resonancesuppressor track -1 node 5: p99 216 us, max 367 us
- resonancesuppressor track -1 node 4: p99 207 us, max 412 us
- resonancesuppressor track -1 node 6: p99 206 us, max 367 us
- unknown track 30 node 3: p99 201 us, max 402 us

## Diagnosis
- Status: Warning
- CPU deadline pressure: no callback or MixEngine deadline overrun observed
- PDC / presentation latency: reported separately as compensated timing, not CPU deadline pressure
- Lock / stale-state: no lock misses or stale chain reuse observed
- Telemetry pressure: no dropped telemetry samples observed

Privacy: Report intentionally omits raw media paths, project directories, usernames, and full project JSON.
