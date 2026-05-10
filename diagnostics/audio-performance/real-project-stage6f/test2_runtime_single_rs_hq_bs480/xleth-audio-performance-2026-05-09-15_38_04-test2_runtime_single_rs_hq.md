# Xleth Audio Performance Capture

## Summary
- Captured at: 2026-05-09T15:37:34Z
- Diagnosis: Warning
- Duration: 30.04 s, blocks: 71
- Sample rate: 48000 Hz, block size: 480

## Realtime CPU
- Callback deadline: 10000 us
- Callback p50/p95/p99/max: 1461 / 1624 / 1760 / 1760 us
- MixEngine p50/p95/p99/max: 1456 / 1621 / 1758 / 1758 us
- Callback overruns: 0, MixEngine overruns: 0
- Lock misses: 0, stale chain reuse: 0, dropped telemetry samples: 165866

## Latency / PDC
- Max audible track latency: 204 samples
- Master insert latency: 2048 samples
- Device output latency: 480 samples
- Live presentation latency: 2732 samples
- Latency epoch changes: 0, compensation target changes: 0
- Interpretation: PDC and presentation latency are expected compensated timing and are separate from CPU deadline pressure.

## RS HQ
- Active RS HQ instances: 1
- WOLA p99/max: 230 / 230 us
- Risk: healthy
- Reasons: None
- Recommended action: increaseBufferSize, reduceHqInstances, useNormalQualityForRealtime, useHqForExport
- Appears in worst effects: yes

## Worst Effects
- resonancesuppressor track -1 node 3: p99 255 us, max 255 us
- resonancesuppressor track -1 node 3: p99 230 us, max 230 us
- unknown track 33 node 3: p99 205 us, max 205 us
- unknown track 30 node 3: p99 175 us, max 175 us
- unknown track 51 node 4: p99 144 us, max 144 us
- limiter track 48 node 4: p99 102 us, max 102 us
- limiter track 42 node 3: p99 87 us, max 87 us
- unknown track 36 node 3: p99 79 us, max 79 us

## Diagnosis
- Status: Warning
- CPU deadline pressure: no callback or MixEngine deadline overrun observed
- PDC / presentation latency: reported separately as compensated timing, not CPU deadline pressure
- Lock / stale-state: no lock misses or stale chain reuse observed
- Telemetry pressure: telemetry samples were dropped

Privacy: Report intentionally omits raw media paths, project directories, usernames, and full project JSON.
