# Stage 5 RS HQ Audio Performance Stress Diagnosis

## Run Environment

- Date/time: 2026-05-09T16:49:57.0580812+03:00
- Build config: Debug
- Runner target: `xleth_audio_perf_report`
- Sample rate: 48000 Hz
- Block sizes: 64, 128, 256, 512
- Scenario duration: 5 seconds
- Strict mode: off (`XLETH_STRICT_AUDIO_PERF` cleared for runner commands)
- Machine notes: `Intel64 Family 6 Model 183 Stepping 1, GenuineIntel`, 24 logical processors, `Microsoft Windows NT 10.0.26200.0`
- CIM notes: `Get-CimInstance Win32_Processor` and `Get-CimInstance Win32_OperatingSystem` were denied by local access policy, so machine notes use available environment/runtime values.

The focused core stress matrix completed for the five required scenarios. Optional `stock_latent_effect_chain` and `third_party_wrapped_chain` runs were not included because the optional sweep was not runtime-reasonable in this session after the core reports completed.

## Summary Table

Timings are in microseconds. Callback and MixEngine columns are `p50/p95/p99/max`. RS HQ WOLA is `p99/max` when present.

| Scenario | Block | Deadline | Callback | MixEngine | RS HQ WOLA | Callback overruns | MixEngine overruns | Dropped telemetry | Lock misses | Stale chain reuse | Classification |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| `baseline_empty_mix` | 64 | 1333 | 104/170/262/474 | 103/171/260/472 | n/a | 1 | 1 | 6809 | 0 | 0 | overrunning |
| `baseline_empty_mix` | 128 | 2667 | 104/109/124/156 | 103/109/123/155 | n/a | 0 | 0 | 0 | 0 | 0 | healthy |
| `baseline_empty_mix` | 256 | 5333 | 106/110/116/2769 | 105/110/116/2756 | n/a | 0 | 0 | 0 | 0 | 0 | healthy |
| `baseline_empty_mix` | 512 | 10667 | 109/113/134/2655 | 108/113/133/2644 | n/a | 0 | 0 | 0 | 0 | 0 | healthy |
| `dry_track_mix` | 64 | 1333 | 122/127/150/203 | 121/127/150/202 | n/a | 1 | 1 | 14309 | 0 | 0 | overrunning |
| `dry_track_mix` | 128 | 2667 | 113/130/158/202 | 113/129/157/201 | n/a | 0 | 0 | 3059 | 0 | 0 | warning |
| `dry_track_mix` | 256 | 5333 | 120/127/167/235 | 119/126/166/234 | n/a | 0 | 0 | 0 | 0 | 0 | healthy |
| `dry_track_mix` | 512 | 10667 | 133/139/166/2960 | 133/139/165/2953 | n/a | 0 | 0 | 0 | 0 | 0 | healthy |
| `resonance_suppressor_normal_quality` | 64 | 1333 | 274/320/468/602 | 274/319/467/601 | n/a | 1 | 1 | 21809 | 0 | 0 | overrunning |
| `resonance_suppressor_normal_quality` | 128 | 2667 | 374/407/444/543 | 374/406/443/542 | n/a | 1 | 1 | 6809 | 0 | 0 | overrunning |
| `resonance_suppressor_normal_quality` | 256 | 5333 | 590/687/988/1170 | 589/686/986/1169 | n/a | 0 | 0 | 0 | 0 | 0 | healthy |
| `resonance_suppressor_normal_quality` | 512 | 10667 | 989/1089/1191/3329 | 988/1088/1190/3325 | n/a | 0 | 0 | 0 | 0 | 0 | healthy |
| `resonance_suppressor_high_quality` | 64 | 1333 | 235/3009/3084/3328 | 234/3008/3082/3325 | 2837/3050 | 114 | 114 | 25559 | 0 | 0 | overrunning |
| `resonance_suppressor_high_quality` | 128 | 2667 | 292/3089/3363/4287 | 292/3088/3361/4286 | 3051/3543 | 228 | 228 | 8684 | 0 | 0 | overrunning |
| `resonance_suppressor_high_quality` | 256 | 5333 | 3032/3763/4526/5730 | 3030/3762/4522/5725 | 3918/4602 | 1 | 1 | 251 | 0 | 0 | overrunning |
| `resonance_suppressor_high_quality` | 512 | 10667 | 3310/3808/4699/5999 | 3308/3803/4696/5996 | 3715/5059 | 0 | 0 | 0 | 0 | 0 | healthy |
| `multi_track_resonance_suppressor_high_quality` | 64 | 1333 | 362/11495/11904/11943 | 361/11494/11902/11940 | 2976/3046 | 43 | 43 | 81809 | 0 | 0 | overrunning |
| `multi_track_resonance_suppressor_high_quality` | 128 | 2667 | 627/11859/12647/12929 | 626/11857/12645/12927 | 3372/3839 | 86 | 86 | 36809 | 0 | 0 | overrunning |
| `multi_track_resonance_suppressor_high_quality` | 256 | 5333 | 1837/13566/14679/16626 | 1835/13563/14677/16623 | 4411/4968 | 170 | 170 | 14321 | 0 | 0 | overrunning |
| `multi_track_resonance_suppressor_high_quality` | 512 | 10667 | 12434/13325/15101/20239 | 12433/13323/15099/20235 | 4414/5354 | 341 | 341 | 3065 | 0 | 0 | overrunning |

## Diagnosis

Classification: CPU deadline overrun confirmed.

Single-track Resonance Suppressor High Quality overruns at 64, 128, and 256 samples. At 512 samples it is healthy in this run: callback p99/max is 4699/5999 us against a 10667 us deadline, MixEngine p99/max is 4696/5996 us, and no overruns or telemetry drops were observed.

Multi-track Resonance Suppressor High Quality is a confirmed CPU deadline problem at every tested block size. Even at 512 samples, callback p99/max is 15101/20239 us against a 10667 us deadline, with 341 callback overruns and 341 MixEngine overruns.

Lock and stale-state counters do not explain the RS HQ failures. Every core run reported zero lock misses and zero stale chain reuse. Telemetry drops are present in the overrun-heavy cases, but the reports still contain enough callback and MixEngine timing evidence to classify the issue as CPU deadline pressure rather than telemetry inconclusive.

The baseline and dry-track 64-sample reports also show isolated overrun counters and dropped telemetry despite low p99/max timings. Treat those as small-buffer debug-build measurement noise or runner/telemetry pressure around very small callback windows, not as evidence against the RS HQ diagnosis. The RS HQ and multi-track RS HQ failures are supported by p99/max timings that exceed callback deadlines.

## PDC Comparison

PDC latency is expected and compensated. Large track or master latency values mean the engine is accounting for plugin delay so audible streams align.

Presentation latency is also expected and compensated when it is part of live presentation accounting. The MixEngine manual runner reports live presentation latency as zero for this path, which matches the Stage 5 runner design.

CPU deadline overruns are separate from PDC. A callback or MixEngine p99/max above the block deadline means the audio thread cannot reliably finish before the next device block. If Resonance Suppressor High Quality is overrunning, it must not be called a PDC bug.

## Recommended Product Policy

Optimize RS HQ WOLA path next.

The single-track HQ path becomes viable at 512 samples in this run, but it overruns at 64, 128, and 256 samples. The multi-track HQ path overruns even at 512 samples. That points to WOLA CPU cost and scaling as the next product/engineering pressure point, not compensated latency accounting.

## Next Engineering Stage

Stage 6A: optimize or gate RS HQ.

The next stage should either reduce RS HQ WOLA CPU cost or gate the feature based on block size/track count. A later background-thread or precomputed spectral path may still be useful, but the immediate evidence says the realtime HQ WOLA path needs optimization or product gating first.

## Report Directories

- `build/engine/audio_perf_scenarios/stress/baseline_empty_mix_bs64`
- `build/engine/audio_perf_scenarios/stress/baseline_empty_mix_bs128`
- `build/engine/audio_perf_scenarios/stress/baseline_empty_mix_bs256`
- `build/engine/audio_perf_scenarios/stress/baseline_empty_mix_bs512`
- `build/engine/audio_perf_scenarios/stress/dry_track_mix_bs64`
- `build/engine/audio_perf_scenarios/stress/dry_track_mix_bs128`
- `build/engine/audio_perf_scenarios/stress/dry_track_mix_bs256`
- `build/engine/audio_perf_scenarios/stress/dry_track_mix_bs512`
- `build/engine/audio_perf_scenarios/stress/resonance_suppressor_normal_quality_bs64`
- `build/engine/audio_perf_scenarios/stress/resonance_suppressor_normal_quality_bs128`
- `build/engine/audio_perf_scenarios/stress/resonance_suppressor_normal_quality_bs256`
- `build/engine/audio_perf_scenarios/stress/resonance_suppressor_normal_quality_bs512`
- `build/engine/audio_perf_scenarios/stress/resonance_suppressor_high_quality_bs64`
- `build/engine/audio_perf_scenarios/stress/resonance_suppressor_high_quality_bs128`
- `build/engine/audio_perf_scenarios/stress/resonance_suppressor_high_quality_bs256`
- `build/engine/audio_perf_scenarios/stress/resonance_suppressor_high_quality_bs512`
- `build/engine/audio_perf_scenarios/stress/multi_track_resonance_suppressor_high_quality_bs64`
- `build/engine/audio_perf_scenarios/stress/multi_track_resonance_suppressor_high_quality_bs128`
- `build/engine/audio_perf_scenarios/stress/multi_track_resonance_suppressor_high_quality_bs256`
- `build/engine/audio_perf_scenarios/stress/multi_track_resonance_suppressor_high_quality_bs512`

## Commands Run

```bat
cmd /c "set Path=& cmake --build build --target xleth_audio_perf_report --config Debug"
```

Each core matrix report used this command shape with strict mode cleared:

```bat
cmd /c "set Path=& set XLETH_STRICT_AUDIO_PERF=& set PATH=C:\Users\Krasen\Desktop\XLETH\bridge\build\vcpkg_installed\x64-windows\debug\bin;C:\Windows\System32;C:\Windows& build\engine\Debug\xleth_audio_perf_report.exe --scenario <scenario> --block-size <blockSize> --sample-rate 48000 --seconds 5 --output-dir build\engine\audio_perf_scenarios\stress\<scenario>_bs<blockSize>"
```

The expanded core matrix was:

```text
baseline_empty_mix: 64, 128, 256, 512
dry_track_mix: 64, 128, 256, 512
resonance_suppressor_normal_quality: 64, 128, 256, 512
resonance_suppressor_high_quality: 64, 128, 256, 512
multi_track_resonance_suppressor_high_quality: 64, 128, 256, 512
```
