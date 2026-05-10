# Audio Performance Real-Project Diagnosis - Stage 6F

## Run Environment

- Date/time: 2026-05-09 18:36:56-18:38:37 EEST
- Build config: Release bridge/native, `xleth_native.node`
- Capture path: Stage 6E `captureAudioPerformanceReport()` during live playback
- Machine: Windows x64, 13th Gen Intel(R) Core(TM) i7-13700KF, 24 logical CPUs, 128 GiB RAM
- Audio device: Focusrite USB output
- Actual device sample rate: 48000 Hz
- Actual device block size: 480 samples
- Callback deadline: 10000 us
- Capture duration: 30 s requested for each final row
- Video playback: active; project had grid/video playback content

Stage 6E currently captures the live JUCE device block size. This Release path did not expose a safe runtime block-size override for 128, 256, or 512 samples, and this device opened at 480 samples. Per the measurement-pass rule, no source change was made to force the requested buffer matrix.

## Project Metadata

- Project label: `test 2`
- Approximate track count: 15
- Approximate effect count before runtime RS variants: 13
- Approximate source/region count: 1 source, 2 regions
- Approximate pattern/pattern-block count: 23 patterns, 15 pattern blocks
- Saved active RS HQ count: 0
- Saved active RS normal count: 0
- Runtime variants: one capture added 1 temporary master RS HQ instance; one capture added 4 temporary master RS HQ instances
- Raw media paths and full project JSON are intentionally omitted.

## Report Locations

- Summary JSON: `diagnostics/audio-performance/real-project-stage6f/capture-summary.json`
- Stock project: `diagnostics/audio-performance/real-project-stage6f/test2_stock_real_project_bs480/`
- Single RS HQ runtime variant: `diagnostics/audio-performance/real-project-stage6f/test2_runtime_single_rs_hq_bs480/`
- Multi RS HQ runtime variant: `diagnostics/audio-performance/real-project-stage6f/test2_runtime_multi4_rs_hq_bs480/`

## Summary Table

| Project label | Block | Deadline us | Callback p50/p95/p99/max us | Mix p50/p95/p99/max us | RS HQ WOLA p99/max us | RS HQ | Callback overruns | Mix overruns | Drops | Lock | Stale | Guarded skip/crash | Max track latency | Master latency | Device latency | Live presentation | RS HQ risk | Recommended action | Classification |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|---|
| `test2_stock_real_project` | 480 | 10000 | 1307 / 1466 / 1531 / 1531 | 1304 / 1462 / 1530 / 1530 | 0 / 0 | 0 | 0 | 0 | 156809 | 0 | 0 | 0 | 204 | 0 | 480 | 684 | healthy | investigate telemetry drops before policy changes | warning |
| `test2_runtime_single_rs_hq` | 480 | 10000 | 1461 / 1624 / 1760 / 1760 | 1456 / 1621 / 1758 / 1758 | 230 / 230 | 1 | 0 | 0 | 165866 | 0 | 0 | 0 | 204 | 2048 | 480 | 2732 | healthy | keep guardrails; investigate telemetry drops | warning |
| `test2_runtime_multi4_rs_hq` | 480 | 10000 | 1999 / 2248 / 2321 / 2321 | 1996 / 2246 / 2319 / 2319 | 258 / 306 | 4 | 0 | 0 | 183809 | 0 | 0 | 0 | 204 | 8192 | 480 | 8876 | warning | keep warning guardrails; investigate telemetry drops | warning |

## CPU vs PDC Interpretation

Compensated latency increased exactly where expected: the single RS HQ runtime variant raised master insert latency to 2048 samples, and the four-instance variant raised it to 8192 samples. Live presentation latency tracked compensated PDC plus device latency. This is not CPU deadline pressure.

Realtime CPU pressure did not present as captured deadline failure. Callback and MixEngine p99/max stayed below 25% of the 10000 us device deadline in all final rows, and callback/MixEngine overrun counters did not advance.

Lock and stale-state counters did not move. Lock misses, stale chain reuse, and guarded plugin skipped/crashed counters were all zero, so this pass does not point at audio-thread ownership, stale snapshots, or third-party crash-guard behavior.

Telemetry drops dominate every run. The capture reports only 64-74 callback samples over each 30 s run while dropped telemetry deltas are 156809-183809. That means the p99/max values are useful samples and the overrun counters are still meaningful, but the capture coverage is incomplete. Product policy should not be tightened from these rows alone.

## RS HQ Decision

Decision: capture more projects first.

These real-project runtime variants do not confirm RS HQ deadline overruns in Release at the actual 480-sample device block size. A single HQ instance stayed healthy by the existing RS HQ risk classifier, and four HQ instances produced the intended warning-only `multipleInstances` risk without CPU overruns.

Guardrails are enough for the evidence captured here, but the heavy telemetry-drop deltas prevent a stronger architectural conclusion. Do not add background/precomputed spectral architecture from this pass. Do not adjust static thresholds yet. Do not add a risky-HQ preference yet.

## Recommendation

Keep Stage 6C warning guardrails unchanged for now. The next stage should fix or expand the telemetry capture/export path so 30 s real-project captures do not drop most timing samples, then rerun the real-project matrix on projects that already contain saved RS HQ instances and on devices/configurations that can actually exercise 128, 256, and 512 sample buffers.

If a later real-project multi-instance RS HQ capture overruns at 256 or 512 samples with healthy telemetry coverage, then design background/precomputed spectral architecture or an export-preferred HQ path. This Stage 6F run does not justify that architecture yet.
