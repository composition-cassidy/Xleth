# Xleth Audio Performance Capture

## Summary
- Captured at: 2026-05-09T15:38:07Z
- Diagnosis: Warning
- Duration: 30.04 s, blocks: 64
- Sample rate: 48000 Hz, block size: 480

## Realtime CPU
- Callback deadline: 10000 us
- Callback p50/p95/p99/max: 1999 / 2248 / 2321 / 2321 us
- MixEngine p50/p95/p99/max: 1996 / 2246 / 2319 / 2319 us
- Callback overruns: 0, MixEngine overruns: 0
- Lock misses: 0, stale chain reuse: 0, dropped telemetry samples: 183809

## Latency / PDC
- Max audible track latency: 204 samples
- Master insert latency: 8192 samples
- Device output latency: 480 samples
- Live presentation latency: 8876 samples
- Latency epoch changes: 0, compensation target changes: 0
- Interpretation: PDC and presentation latency are expected compensated timing and are separate from CPU deadline pressure.

## RS HQ
- Active RS HQ instances: 4
- WOLA p99/max: 258 / 306 us
- Risk: warning
- Reasons: multipleInstances
- Recommended action: reduceHqInstances, useNormalQualityForRealtime, useHqForExport, increaseBufferSize
- Appears in worst effects: yes

## Worst Effects
- resonancesuppressor track -1 node 6: p99 329 us, max 329 us
- resonancesuppressor track -1 node 3: p99 321 us, max 321 us
- resonancesuppressor track -1 node 6: p99 306 us, max 306 us
- resonancesuppressor track -1 node 3: p99 294 us, max 294 us
- resonancesuppressor track -1 node 5: p99 278 us, max 278 us
- resonancesuppressor track -1 node 5: p99 258 us, max 258 us
- unknown track 51 node 4: p99 194 us, max 194 us
- unknown track 30 node 3: p99 193 us, max 193 us

## Diagnosis
- Status: Warning
- CPU deadline pressure: no callback or MixEngine deadline overrun observed
- PDC / presentation latency: reported separately as compensated timing, not CPU deadline pressure
- Lock / stale-state: no lock misses or stale chain reuse observed
- Telemetry pressure: telemetry samples were dropped

Privacy: Report intentionally omits raw media paths, project directories, usernames, and full project JSON.
