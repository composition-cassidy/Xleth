# Xleth Audio Performance Capture

## Summary
- Captured at: 2026-05-09T15:35:43Z
- Diagnosis: Warning
- Duration: 3.035 s, blocks: 74
- Sample rate: 48000 Hz, block size: 480

## Realtime CPU
- Callback deadline: 10000 us
- Callback p50/p95/p99/max: 1100 / 1269 / 1354 / 1354 us
- MixEngine p50/p95/p99/max: 1099 / 1267 / 1352 / 1352 us
- Callback overruns: 0, MixEngine overruns: 0
- Lock misses: 0, stale chain reuse: 0, dropped telemetry samples: 8254

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
- unknown track 30 node 3: p99 176 us, max 176 us
- unknown track 51 node 4: p99 153 us, max 153 us
- unknown track 33 node 3: p99 152 us, max 152 us
- limiter track 48 node 4: p99 85 us, max 85 us
- unknown track 36 node 3: p99 80 us, max 80 us
- limiter track 42 node 3: p99 79 us, max 79 us
- unknown track 42 node 5: p99 56 us, max 56 us
- unknown track 45 node 3: p99 56 us, max 56 us

## Diagnosis
- Status: Warning
- CPU deadline pressure: no callback or MixEngine deadline overrun observed
- PDC / presentation latency: reported separately as compensated timing, not CPU deadline pressure
- Lock / stale-state: no lock misses or stale chain reuse observed
- Telemetry pressure: telemetry samples were dropped

Privacy: Report intentionally omits raw media paths, project directories, usernames, and full project JSON.
