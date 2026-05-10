# Xleth Audio Performance Capture

## Summary
- Captured at: 2026-05-09T16:10:16Z
- Diagnosis: Warning
- Duration: 30.142 s, blocks: 3012
- Sample rate: 48000 Hz, block size: 480

## Realtime CPU
- CPU health: Warning
- Callback deadline: 10000 us
- Callback p50/p95/p99/max: 1709 / 2002 / 2259 / 3068 us
- MixEngine p50/p95/p99/max: 1707 / 1999 / 2256 / 3064 us
- Callback overruns: 0, MixEngine overruns: 0
- Lock misses: 0, stale chain reuse: 0, dropped telemetry samples: 0

## Telemetry Coverage
- Coverage quality: good
- Expected callback count: 3014
- Callback samples: 3012 (99.9336%)
- MixEngine samples: 3012 (99.9336%)
- Effect samples: 50966
- Dropped during capture: 0
- Capture accumulator overflow drops: 0
- Verbose effect sampling: not downsampled

## Latency / PDC
- Max audible track latency: 204 samples
- Master insert latency: 4096 samples
- Device output latency: 480 samples
- Live presentation latency: 4780 samples
- Latency epoch changes: 0, compensation target changes: 13
- Interpretation: PDC and presentation latency are expected compensated timing and are separate from CPU deadline pressure.

## RS HQ
- Active RS HQ instances: 2
- WOLA p99/max: 201 / 306 us
- Risk: warning
- Reasons: multipleInstances
- Recommended action: reduceHqInstances, useNormalQualityForRealtime, useHqForExport, increaseBufferSize
- Appears in worst effects: yes

## Worst Effects
- unknown track 30 node 3: p99 244 us, max 403 us
- resonancesuppressor track -1 node 4: p99 234 us, max 321 us
- resonancesuppressor track -1 node 3: p99 227 us, max 333 us
- resonancesuppressor track -1 node 4: p99 205 us, max 288 us
- resonancesuppressor track -1 node 3: p99 201 us, max 306 us
- unknown track 33 node 3: p99 193 us, max 293 us
- unknown track 51 node 4: p99 164 us, max 221 us
- limiter track 42 node 3: p99 110 us, max 201 us

## Diagnosis
- Status: Warning
- CPU deadline pressure: no callback or MixEngine deadline overrun observed
- PDC / presentation latency: reported separately as compensated timing, not CPU deadline pressure
- Lock / stale-state: no lock misses or stale chain reuse observed
- Telemetry pressure: no dropped telemetry samples observed

Privacy: Report intentionally omits raw media paths, project directories, usernames, and full project JSON.
