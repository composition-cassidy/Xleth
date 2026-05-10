# Xleth Audio Performance Capture

## Summary
- Captured at: 2026-05-09T16:06:37Z
- Diagnosis: Healthy
- Duration: 30.146 s, blocks: 3012
- Sample rate: 48000 Hz, block size: 480

## Realtime CPU
- CPU health: Healthy
- Callback deadline: 10000 us
- Callback p50/p95/p99/max: 463 / 592 / 715 / 3140 us
- MixEngine p50/p95/p99/max: 461 / 589 / 699 / 3136 us
- Callback overruns: 0, MixEngine overruns: 0
- Lock misses: 0, stale chain reuse: 0, dropped telemetry samples: 0

## Telemetry Coverage
- Coverage quality: good
- Expected callback count: 3015
- Callback samples: 3012 (99.9005%)
- MixEngine samples: 3012 (99.9005%)
- Effect samples: 5994
- Dropped during capture: 0
- Capture accumulator overflow drops: 0
- Verbose effect sampling: not downsampled

## Latency / PDC
- Max audible track latency: 0 samples
- Master insert latency: 2048 samples
- Device output latency: 480 samples
- Live presentation latency: 2528 samples
- Latency epoch changes: 0, compensation target changes: 0
- Interpretation: PDC and presentation latency are expected compensated timing and are separate from CPU deadline pressure.

## RS HQ
- Active RS HQ instances: 1
- WOLA p99/max: 199 / 282 us
- Risk: healthy
- Reasons: None
- Recommended action: reduceHqInstances, useNormalQualityForRealtime, useHqForExport
- Appears in worst effects: yes

## Worst Effects
- resonancesuppressor track -1 node 3: p99 230 us, max 312 us
- resonancesuppressor track -1 node 3: p99 199 us, max 282 us

## Diagnosis
- Status: Healthy
- CPU deadline pressure: no callback or MixEngine deadline overrun observed
- PDC / presentation latency: reported separately as compensated timing, not CPU deadline pressure
- Lock / stale-state: no lock misses or stale chain reuse observed
- Telemetry pressure: no dropped telemetry samples observed

Privacy: Report intentionally omits raw media paths, project directories, usernames, and full project JSON.
