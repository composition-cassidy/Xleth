# Xleth Audio Performance Capture

## Summary
- Captured at: 2026-05-09T15:37:00Z
- Diagnosis: Warning
- Duration: 30.039 s, blocks: 74
- Sample rate: 48000 Hz, block size: 480

## Realtime CPU
- Callback deadline: 10000 us
- Callback p50/p95/p99/max: 1307 / 1466 / 1531 / 1531 us
- MixEngine p50/p95/p99/max: 1304 / 1462 / 1530 / 1530 us
- Callback overruns: 0, MixEngine overruns: 0
- Lock misses: 0, stale chain reuse: 0, dropped telemetry samples: 156809

## Latency / PDC
- Max audible track latency: 204 samples
- Master insert latency: 0 samples
- Device output latency: 480 samples
- Live presentation latency: 684 samples
- Latency epoch changes: 0, compensation target changes: 0
- Interpretation: PDC and presentation latency are expected compensated timing and are separate from CPU deadline pressure.

## RS HQ
- RS HQ was not active in this capture.

## Worst Effects
- unknown track 30 node 3: p99 179 us, max 179 us
- unknown track 33 node 3: p99 153 us, max 153 us
- unknown track 51 node 4: p99 139 us, max 139 us
- unknown track 36 node 3: p99 82 us, max 82 us
- limiter track 42 node 3: p99 75 us, max 75 us
- limiter track 48 node 4: p99 70 us, max 70 us
- unknown track 42 node 5: p99 59 us, max 59 us
- unknown track 57 node 4: p99 53 us, max 53 us

## Diagnosis
- Status: Warning
- CPU deadline pressure: no callback or MixEngine deadline overrun observed
- PDC / presentation latency: reported separately as compensated timing, not CPU deadline pressure
- Lock / stale-state: no lock misses or stale chain reuse observed
- Telemetry pressure: telemetry samples were dropped

Privacy: Report intentionally omits raw media paths, project directories, usernames, and full project JSON.
