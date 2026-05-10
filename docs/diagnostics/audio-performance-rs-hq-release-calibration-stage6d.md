# Audio Performance: RS HQ Release Guardrail Calibration Stage 6D

Stage 6D calibrates the Stage 6C Resonance Suppressor High Quality realtime
guardrails against Release-build telemetry. This pass did not optimize DSP and
did not change PDC, latency reporting, transport, export, presentation timing,
or dynamic latency refresh behavior.

## Run Environment

- Date/time: 2026-05-09T18:07:44.0869618+03:00
- Build config: Release for `xleth_audio_perf_report`; Debug for regression
  tests.
- Sample rate: 48000 Hz.
- Duration: 5 seconds per scenario.
- Block sizes: 64, 128, 256, 512 samples.
- Strict mode: off (`XLETH_STRICT_AUDIO_PERF` cleared).
- OS: Microsoft Windows 11 Pro 10.0.26200.
- CPU: 13th Gen Intel(R) Core(TM) i7-13700KF, 16 cores, 24 logical processors.
- RAM: 137259696128 bytes.
- Runtime DLL path: the requested vcpkg runtime paths were sufficient:
  `bridge\build\vcpkg_installed\x64-windows\bin` and
  `bridge\build\vcpkg_installed\x64-windows\debug\bin`.

## Commands Run

The first nested `cmd /c` build attempt used the prompt's quoting shape and
failed before CMake started because `cmd` split `C:\Program Files`. The
successful build used equivalent corrected Windows quoting:

```bat
cmd /c '"C:\Program Files\CMake\bin\cmake.exe" --build build --target xleth_audio_perf_report --config Release'
```

The Release matrix used this command shape for each scenario/block pair:

```bat
cmd /c "set XLETH_STRICT_AUDIO_PERF=& set PATH=C:\Users\Krasen\Desktop\XLETH\bridge\build\vcpkg_installed\x64-windows\bin;C:\Users\Krasen\Desktop\XLETH\bridge\build\vcpkg_installed\x64-windows\debug\bin;C:\Windows\System32;C:\Windows& build\engine\Release\xleth_audio_perf_report.exe --scenario <scenario> --block-size <blockSize> --sample-rate 48000 --seconds 5 --output-dir build\engine\audio_perf_scenarios\release_guardrail_calibration\<scenario>_bs<blockSize>"
```

## Release Summary

Timings are microseconds. Callback and MixEngine columns are `p50/p95/p99/max`.
RS HQ WOLA is `p99/max`.

| Scenario | Block | Deadline | Callback | MixEngine | RS HQ WOLA | Callback overruns | MixEngine overruns | Dropped telemetry | Lock misses | Stale reuse | Classification |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| `baseline_empty_mix` | 64 | 1333 | 79/104/164/274 | 79/104/164/273 | n/a | 1 | 1 | 6809 | 0 | 0 | overrunning |
| `baseline_empty_mix` | 128 | 2667 | 80/91/119/189 | 80/91/118/189 | n/a | 1 | 1 | 0 | 0 | 0 | overrunning |
| `baseline_empty_mix` | 256 | 5333 | 81/149/274/2298 | 81/149/274/2294 | n/a | 0 | 0 | 0 | 0 | 0 | healthy |
| `baseline_empty_mix` | 512 | 10667 | 80/87/115/2409 | 80/87/114/2406 | n/a | 0 | 0 | 0 | 0 | 0 | healthy |
| `dry_track_mix` | 64 | 1333 | 80/94/133/221 | 80/94/132/221 | n/a | 1 | 1 | 14309 | 0 | 0 | overrunning |
| `dry_track_mix` | 128 | 2667 | 81/91/134/182 | 81/91/134/182 | n/a | 0 | 0 | 3059 | 0 | 0 | warning |
| `dry_track_mix` | 256 | 5333 | 82/87/101/113 | 82/87/101/113 | n/a | 0 | 0 | 0 | 0 | 0 | healthy |
| `dry_track_mix` | 512 | 10667 | 83/100/164/2655 | 83/100/164/2653 | n/a | 0 | 0 | 0 | 0 | 0 | healthy |
| `resonance_suppressor_normal_quality` | 64 | 1333 | 98/122/188/225 | 98/122/187/225 | n/a | 1 | 1 | 21809 | 0 | 0 | overrunning |
| `resonance_suppressor_normal_quality` | 128 | 2667 | 109/118/149/426 | 109/118/148/426 | n/a | 1 | 1 | 6809 | 0 | 0 | overrunning |
| `resonance_suppressor_normal_quality` | 256 | 5333 | 130/233/281/403 | 130/233/281/403 | n/a | 0 | 0 | 0 | 0 | 0 | healthy |
| `resonance_suppressor_normal_quality` | 512 | 10667 | 169/284/377/4386 | 169/283/377/4384 | n/a | 0 | 0 | 0 | 0 | 0 | healthy |
| `resonance_suppressor_high_quality` | 64 | 1333 | 86/227/262/434 | 86/227/262/434 | 164/260 | 1 | 1 | 25559 | 0 | 0 | overrunning |
| `resonance_suppressor_high_quality` | 128 | 2667 | 91/247/368/541 | 91/247/368/540 | 255/281 | 1 | 1 | 8684 | 0 | 0 | overrunning |
| `resonance_suppressor_high_quality` | 256 | 5333 | 233/258/284/322 | 233/257/284/322 | 174/193 | 0 | 0 | 251 | 0 | 0 | warning |
| `resonance_suppressor_high_quality` | 512 | 10667 | 244/377/540/2056 | 244/376/540/2056 | 288/455 | 0 | 0 | 0 | 0 | 0 | healthy |
| `multi_track_resonance_suppressor_high_quality` | 64 | 1333 | 102/656/705/723 | 102/656/705/723 | 184/189 | 1 | 1 | 81809 | 0 | 0 | overrunning |
| `multi_track_resonance_suppressor_high_quality` | 128 | 2667 | 117/682/760/1133 | 117/682/760/1133 | 167/322 | 1 | 1 | 36809 | 0 | 0 | overrunning |
| `multi_track_resonance_suppressor_high_quality` | 256 | 5333 | 249/756/917/924 | 248/756/917/923 | 212/220 | 0 | 0 | 14321 | 0 | 0 | warning |
| `multi_track_resonance_suppressor_high_quality` | 512 | 10667 | 760/925/1169/1229 | 760/924/1168/1228 | 243/371 | 0 | 0 | 3065 | 0 | 0 | warning |

## Debug-to-Release Comparison

Debug values are the latest Stage 6B rows from
`docs/diagnostics/audio-performance-rs-hq-prefixsum-stage6b.md`. Callback
ratios are `p99/max` divided by the block deadline.

| Scenario | Block | Debug callback p99/max | Debug ratio | Debug overruns | Debug class | Release callback p99/max | Release ratio | Release overruns | Release class |
|---|---:|---:|---:|---:|---|---:|---:|---:|---|
| `resonance_suppressor_high_quality` | 64 | 1788/1841 | 1.341/1.381 | 114 | overrunning | 262/434 | 0.197/0.326 | 1 | overrunning |
| `resonance_suppressor_high_quality` | 128 | 1981/2630 | 0.743/0.986 | 1 | overrunning | 368/541 | 0.138/0.203 | 1 | overrunning |
| `resonance_suppressor_high_quality` | 256 | 2053/2445 | 0.385/0.458 | 0 | warning | 284/322 | 0.053/0.060 | 0 | warning |
| `resonance_suppressor_high_quality` | 512 | 3733/4602 | 0.350/0.431 | 0 | healthy | 540/2056 | 0.051/0.193 | 0 | healthy |
| `multi_track_resonance_suppressor_high_quality` | 64 | 7017/7072 | 5.264/5.305 | 43 | overrunning | 705/723 | 0.529/0.542 | 1 | overrunning |
| `multi_track_resonance_suppressor_high_quality` | 128 | 6657/6679 | 2.496/2.504 | 86 | overrunning | 760/1133 | 0.285/0.425 | 1 | overrunning |
| `multi_track_resonance_suppressor_high_quality` | 256 | 9890/12113 | 1.854/2.271 | 171 | overrunning | 917/924 | 0.172/0.173 | 0 | warning |
| `multi_track_resonance_suppressor_high_quality` | 512 | 11767/13604 | 1.103/1.275 | 4 | overrunning | 1169/1229 | 0.110/0.115 | 0 | warning |

## Interpretation

Release timing is much lower than Debug timing. Single-instance RS HQ p99 is
comfortably below deadline at 256 and 512 samples, and multi-instance p99 is
also below deadline at 256 and 512 samples in this synthetic runner.

That improvement is not clean enough to relax Stage 6C in this calibration
pass. The requested report classifications still produce:

- single RS HQ 64 and 128: `overrunning`, with callback and MixEngine overrun
  counters.
- single RS HQ 256: `warning`, because telemetry drops were still observed.
- single RS HQ 512: `healthy`.
- multi RS HQ 64 and 128: `overrunning`, with callback and MixEngine overrun
  counters.
- multi RS HQ 256 and 512: `warning`, because telemetry drops were still
  observed.

Lock misses and stale reuse stayed zero for every row. This remains a realtime
CPU/telemetry pressure issue, not PDC, lock contention, stale state, transport,
presentation latency, or export timing.

## Guardrail Policy Decision

Decision: keep Stage 6C thresholds unchanged.

The Release p99/max ratios argue that Debug overstated raw CPU cost, especially
for single RS HQ at 256 and multi RS HQ at 512. However, the Release
classification data does not clearly justify relaxing warnings yet because the
policy-relevant 256 and multi-instance rows are still `warning` or
`overrunning` in the requested matrix. Relaxing single-instance 256 would be
premature until telemetry drops are understood or real-project telemetry shows
stable clean runs.

No stronger multi-instance 512 warning is justified. Release no longer shows a
deadline breach there, so escalation would overreact to Debug-only timings.
Stage 6C's warning-only multi-instance policy remains the right middle ground.

## Preference Decision

Decision: do not add an explicit `allowRiskyRealtimeResonanceSuppressorHighQuality`
preference now.

Release data does not show a clean conservative-warning-only case. A preference
would also be ambiguous while telemetry drops can still drive warnings, and it
could be mistaken for a way to hide realtime health problems. Power-user opt-in
should wait for real-project telemetry, with semantics that soften only static
policy warnings and never hide actual overrun telemetry.

## Report Directories

- `build/engine/audio_perf_scenarios/release_guardrail_calibration/baseline_empty_mix_bs64`
- `build/engine/audio_perf_scenarios/release_guardrail_calibration/baseline_empty_mix_bs128`
- `build/engine/audio_perf_scenarios/release_guardrail_calibration/baseline_empty_mix_bs256`
- `build/engine/audio_perf_scenarios/release_guardrail_calibration/baseline_empty_mix_bs512`
- `build/engine/audio_perf_scenarios/release_guardrail_calibration/dry_track_mix_bs64`
- `build/engine/audio_perf_scenarios/release_guardrail_calibration/dry_track_mix_bs128`
- `build/engine/audio_perf_scenarios/release_guardrail_calibration/dry_track_mix_bs256`
- `build/engine/audio_perf_scenarios/release_guardrail_calibration/dry_track_mix_bs512`
- `build/engine/audio_perf_scenarios/release_guardrail_calibration/resonance_suppressor_normal_quality_bs64`
- `build/engine/audio_perf_scenarios/release_guardrail_calibration/resonance_suppressor_normal_quality_bs128`
- `build/engine/audio_perf_scenarios/release_guardrail_calibration/resonance_suppressor_normal_quality_bs256`
- `build/engine/audio_perf_scenarios/release_guardrail_calibration/resonance_suppressor_normal_quality_bs512`
- `build/engine/audio_perf_scenarios/release_guardrail_calibration/resonance_suppressor_high_quality_bs64`
- `build/engine/audio_perf_scenarios/release_guardrail_calibration/resonance_suppressor_high_quality_bs128`
- `build/engine/audio_perf_scenarios/release_guardrail_calibration/resonance_suppressor_high_quality_bs256`
- `build/engine/audio_perf_scenarios/release_guardrail_calibration/resonance_suppressor_high_quality_bs512`
- `build/engine/audio_perf_scenarios/release_guardrail_calibration/multi_track_resonance_suppressor_high_quality_bs64`
- `build/engine/audio_perf_scenarios/release_guardrail_calibration/multi_track_resonance_suppressor_high_quality_bs128`
- `build/engine/audio_perf_scenarios/release_guardrail_calibration/multi_track_resonance_suppressor_high_quality_bs256`
- `build/engine/audio_perf_scenarios/release_guardrail_calibration/multi_track_resonance_suppressor_high_quality_bs512`

## Regression Tests

- `test_audio_perf_scenarios`: passed, 74 checks.
- `test_audio_telemetry`: passed, 28 checks.
- `test_pdc_stage1`: passed, 517 checks.
- `test_mix`: passed, 243 checks.

Bridge and UI tests were not run for Stage 6D because no bridge or UI source
change was made by this calibration pass.

## Recommendation

Do not continue tuning warning thresholds from synthetic Debug/Release runs
alone. The next useful stage is real-project telemetry capture. If real-project
capture confirms that multi-instance HQ must be reliable at low buffers, move
to a background or precomputed spectral architecture rather than another static
warning pass.
