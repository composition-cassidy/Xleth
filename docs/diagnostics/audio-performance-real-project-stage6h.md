# Audio Performance Real-Project RS HQ Capture Sweep - Stage 6H

## Scope

Stage 6H is a measurement/report pass using the Stage 6G coverage-fixed telemetry capture path. No DSP, PDC, latency reporting, transport, export, presentation timing, guardrail policy, risky-HQ preference, or background/precomputed architecture changes were made.

## Run Environment

- Date/time: Sat May 09 2026 19:06:05 GMT+0300 (Eastern European Summer Time) to Sat May 09 2026 19:11:49 GMT+0300 (Eastern European Summer Time)
- Build config: Release bridge/native xleth_native.node
- Native/app path: `bridge/build/Release/xleth_native.node`
- Capture path: Release native bridge Stage 6G coverage-fixed startAudioPerformanceCapture/stopAudioPerformanceCapture with off-thread telemetry accumulator during live playback
- OS/CPU/RAM: Windows 10.0.26200 x64, 13th Gen Intel(R) Core(TM) i7-13700KF, 24 logical CPUs, 127.8 GiB RAM
- Audio device: Speakers (2- Focusrite USB Audio)
- Sample rate: 48000 Hz actual opened device/project playback rate
- Actual block size: 480 samples
- Callback deadline: 10000 us
- Capture duration: 30 s requested per final row
- Video playback: live transport was active. The native decoder/event path loaded media/grid content where present; the capture was headless with preview GPU disabled for stability, so this pass measures the native/app audio path plus project event work, not the rendered Electron viewport.
- Buffer-size matrix: No safe runtime block-size override was exposed through the bridge/device API; captures used the actual opened device block size. The bridge/device path did not expose a safe 128/256/512 override, so no source change was made to force buffers.

## Project Metadata

Privacy note: no raw media paths or full project JSON are included in this report.

| Project label | Role | Tracks | Effects | Sources/regions | Patterns/blocks | Saved RS HQ | Saved RS normal | Runtime HQ use | Video/media activity |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `buffer_test_light_video` | Light real project | 2 | 0 | 2/2 | 1/6 | 0 | 0 | 0/1 runtime-added master HQ | media/grid content loaded; headless preview GPU disabled |
| `test_light_video_vst` | Light real project with saved third-party effect metadata | 2 | 1 | 1/2 | 1/1 | 0 | 0 | 0/1 runtime-added master HQ | media/grid content loaded; headless preview GPU disabled |
| `sampler_pertrack_pattern` | Pattern/sampler project | 3 | 0 | 1/1 | 3/3 | 0 | 0 | 0/1 runtime-added master HQ | media/grid content loaded; headless preview GPU disabled |
| `test2_sparta_grid` | Typical Sparta/grid project | 15 | 13 | 1/2 | 23/15 | 0 | 0 | 0/1/2/4/8 runtime-added master HQ | media/grid content loaded; headless preview GPU disabled |

## Capture Artifacts

- Summary JSON: `diagnostics/audio-performance/real-project-stage6h/capture-summary.json`
- `stock_real_project` on `buffer_test_light_video`: `diagnostics/audio-performance/real-project-stage6h/buffer_test_light_video_stock_real_project_bs_actual/`
- `runtime_single_rs_hq` on `buffer_test_light_video`: `diagnostics/audio-performance/real-project-stage6h/buffer_test_light_video_runtime_single_rs_hq_bs_actual/`
- `stock_real_project` on `test_light_video_vst`: `diagnostics/audio-performance/real-project-stage6h/test_light_video_vst_stock_real_project_bs_actual/`
- `runtime_single_rs_hq` on `test_light_video_vst`: `diagnostics/audio-performance/real-project-stage6h/test_light_video_vst_runtime_single_rs_hq_bs_actual/`
- `stock_real_project` on `sampler_pertrack_pattern`: `diagnostics/audio-performance/real-project-stage6h/sampler_pertrack_pattern_stock_real_project_bs_actual/`
- `runtime_single_rs_hq` on `sampler_pertrack_pattern`: `diagnostics/audio-performance/real-project-stage6h/sampler_pertrack_pattern_runtime_single_rs_hq_bs_actual/`
- `stock_real_project` on `test2_sparta_grid`: `diagnostics/audio-performance/real-project-stage6h/test2_sparta_grid_stock_real_project_bs_actual/`
- `runtime_single_rs_hq` on `test2_sparta_grid`: `diagnostics/audio-performance/real-project-stage6h/test2_sparta_grid_runtime_single_rs_hq_bs_actual/`
- `runtime_multi2_rs_hq` on `test2_sparta_grid`: `diagnostics/audio-performance/real-project-stage6h/test2_sparta_grid_runtime_multi2_rs_hq_bs_actual/`
- `runtime_multi4_rs_hq` on `test2_sparta_grid`: `diagnostics/audio-performance/real-project-stage6h/test2_sparta_grid_runtime_multi4_rs_hq_bs_actual/`
- `runtime_multi8_rs_hq` on `test2_sparta_grid`: `diagnostics/audio-performance/real-project-stage6h/test2_sparta_grid_runtime_multi8_rs_hq_bs_actual/`

## Summary Table

| Project | Variant | Block | Deadline us | Callback p50/p95/p99/max us | Mix p50/p95/p99/max us | RS HQ WOLA p99/max us | HQ | Cb over | Mix over | Drops | Samples/expected | Coverage | Quality | Lock | Stale | Guard skip/crash | Track lat | Master lat | Device lat | Live lat | RS HQ risk | CPU | Diagnosis |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `buffer_test_light_video` | `stock_real_project` | 480 | 10000 | 280/408/491/2259 | 277/404/487/2256 | 0/0 | 0 | 0 | 0 | 0 | 3008/3011 | 99.90% | good | 0 | 0 | 0 | 0 | 0 | 480 | 480 | healthy | Healthy | Healthy |
| `buffer_test_light_video` | `runtime_single_rs_hq` | 480 | 10000 | 463/592/715/3140 | 461/589/699/3136 | 199/282 | 1 | 0 | 0 | 0 | 3012/3015 | 99.90% | good | 0 | 0 | 0 | 0 | 2048 | 480 | 2528 | healthy | Healthy | Healthy |
| `test_light_video_vst` | `stock_real_project` | 480 | 10000 | 287/437/559/3584 | 284/434/555/3576 | 0/0 | 0 | 0 | 0 | 0 | 3009/3013 | 99.87% | good | 0 | 0 | 0 | 0 | 0 | 480 | 480 | healthy | Healthy | Healthy |
| `test_light_video_vst` | `runtime_single_rs_hq` | 480 | 10000 | 486/668/750/2948 | 483/664/746/2947 | 203/316 | 1 | 0 | 0 | 0 | 3012/3015 | 99.90% | good | 0 | 0 | 0 | 0 | 2048 | 480 | 2528 | healthy | Healthy | Healthy |
| `sampler_pertrack_pattern` | `stock_real_project` | 480 | 10000 | 287/406/544/2734 | 284/402/539/2732 | 0/0 | 0 | 0 | 0 | 0 | 3010/3013 | 99.90% | good | 0 | 0 | 0 | 0 | 0 | 480 | 480 | healthy | Healthy | Healthy |
| `sampler_pertrack_pattern` | `runtime_single_rs_hq` | 480 | 10000 | 499/624/721/3190 | 496/620/717/3185 | 280/332 | 1 | 0 | 0 | 0 | 3013/3016 | 99.90% | good | 0 | 0 | 0 | 0 | 2048 | 480 | 2528 | healthy | Healthy | Healthy |
| `test2_sparta_grid` | `stock_real_project` | 480 | 10000 | 1353/1585/1787/3235 | 1351/1581/1783/3227 | 0/0 | 0 | 0 | 0 | 0 | 3005/3009 | 99.87% | good | 0 | 0 | 0 | 204 | 0 | 480 | 684 | healthy | Healthy | Healthy |
| `test2_sparta_grid` | `runtime_single_rs_hq` | 480 | 10000 | 1539/1812/1940/3622 | 1537/1810/1938/3619 | 197/305 | 1 | 0 | 0 | 0 | 3008/3012 | 99.87% | good | 0 | 0 | 0 | 204 | 2048 | 480 | 2732 | healthy | Healthy | Healthy |
| `test2_sparta_grid` | `runtime_multi2_rs_hq` | 480 | 10000 | 1709/2002/2259/3068 | 1707/1999/2256/3064 | 201/306 | 2 | 0 | 0 | 0 | 3012/3014 | 99.93% | good | 0 | 0 | 0 | 204 | 4096 | 480 | 4780 | warning | Warning | Warning |
| `test2_sparta_grid` | `runtime_multi4_rs_hq` | 480 | 10000 | 2107/2402/2590/5408 | 2105/2399/2586/5401 | 214/330 | 4 | 0 | 0 | 0 | 3014/3018 | 99.87% | good | 0 | 0 | 0 | 204 | 8192 | 480 | 8876 | warning | Warning | Warning |
| `test2_sparta_grid` | `runtime_multi8_rs_hq` | 480 | 10000 | 2820/3075/3242/4082 | 2818/3074/3238/4076 | 197/782 | 8 | 0 | 0 | 0 | 2997/3002 | 99.83% | good | 0 | 0 | 0 | 204 | 16384 | 480 | 17068 | warning | Warning | Warning |

## Interpretation

Realtime CPU deadline pressure: no capture row advanced callback or MixEngine overrun counters. The worst callback max was 5408 us and the worst callback p99 was 3242 us, both below the 10000 us deadline at the actual 480-sample device block. The 8x RS HQ Sparta/grid row remained below deadline with callback p99 3242 us and max 4082 us.

Expected compensated PDC/presentation latency: latency rose only with runtime-added master RS HQ instances. The Sparta/grid project moved from 684 samples live presentation latency stock to 2732, 4780, 8876, and 17068 samples for 1/2/4/8 HQ respectively. That is compensated latency, not CPU deadline failure.

RS HQ guardrail warning: 3 rows warned, all from multiple active RS HQ instances. Those warnings are policy-based guardrails; they were not deadline-confirmed in this sweep.

Telemetry coverage quality: every row was `good`, with callback coverage from 99.83% to 99.93%, dropped telemetry during capture = 0, and accumulator overflow drops = 0.

Lock/stale-state issues: lock miss delta = 0 and stale reuse delta = 0 in every row, so this pass does not implicate audio-thread ownership or stale snapshots.

Third-party plugin skip/crash issues: guarded plugin skipped/crashed delta = 0 in every row, including the light project with saved third-party effect metadata.

## Final RS HQ Recommendation

Recommendation: **A. Keep Stage 6C guardrails unchanged and close this arc.**

Rationale: the Release real-project captures did not overrun at the available device buffer, telemetry coverage is good, telemetry drops are zero, lock/stale counters are quiet, and the RS HQ warnings are policy warnings rather than confirmed deadline failures. The data does not justify background/precomputed spectral architecture, a risky-HQ preference, hard-disabling HQ, or source guardrail threshold changes in this pass.

Tiny report-only note: the multiple-HQ warning appears conservative on this machine at the fixed 480-sample device block, including the 8x runtime HQ Sparta/grid row. That observation should remain a report note, not a source policy change, because smaller practical buffers could not be exercised safely through the current device/API path.

## Can we close the RS HQ/PDC investigation?

Yes. For the available Release native/app real-project path at 48 kHz / 480 samples, Stage 6H confirms that RS HQ did not cause callback or MixEngine deadline overruns and that PDC/presentation latency is expected compensated latency. The RS HQ/PDC investigation can close with Stage 6C warning guardrails unchanged.

## Validation Status

- Engine telemetry: passed, 42 checks.
- PDC test: passed, 517 passed / 0 failed.
- Mix test: passed, 243 checks.
- Bridge telemetry: passed, 515 checks. The stripped `cmd` PATH did not include Node for the first invocation, so the same test was rerun with `C:\Program Files\nodejs\node.exe`.
- `git diff --check`: passed.

UI build was not required because no UI files were touched.
