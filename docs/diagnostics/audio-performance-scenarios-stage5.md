# Stage 5 Audio Performance Scenarios

The deterministic Stage 5C scenario harness lives in:

```text
engine/test/test_audio_perf_scenarios.cpp
engine/src/audio/AudioPerformanceScenarioRunner.h
engine/src/audio/AudioPerformanceScenarioRunner.cpp
```

Build and run it with:

```bat
cmd /c "set Path=& cmake --build build --target test_audio_perf_scenarios --config Debug"
cmd /c "set Path=& set PATH=C:\Users\Krasen\Desktop\XLETH\bridge\build\vcpkg_installed\x64-windows\debug\bin;C:\Windows\System32;C:\Windows& build\engine\Debug\test_audio_perf_scenarios.exe"
```

The normal test target is deterministic. It verifies that reports are produced,
parseable, structurally valid, and able to identify expensive scopes such as
Resonance Suppressor High Quality WOLA and third-party plugin chains. It does
not fail because p95 or p99 wall-clock timing is high on the current machine.

## Manual MixEngine Runner

For developer diagnosis, Stage 5C also provides an explicit manual target:

```bat
cmd /c "set Path=& cmake --build build --target xleth_audio_perf_report --config Debug"
```

The runner is intentionally not a normal unit test. It drives real MixEngine
processing paths with generated audio material and writes the same report files:

```text
build/engine/audio_perf_scenarios/audio-performance-scenarios.json
build/engine/audio_perf_scenarios/audio-performance-scenarios.md
```

Run every scenario:

```bat
cmd /c "set Path=& set PATH=C:\Users\Krasen\Desktop\XLETH\bridge\build\vcpkg_installed\x64-windows\debug\bin;C:\Windows\System32;C:\Windows& build\engine\Debug\xleth_audio_perf_report.exe --scenario all"
```

Run only Resonance Suppressor High Quality:

```bat
cmd /c "set Path=& set PATH=C:\Users\Krasen\Desktop\XLETH\bridge\build\vcpkg_installed\x64-windows\debug\bin;C:\Windows\System32;C:\Windows& build\engine\Debug\xleth_audio_perf_report.exe --scenario resonance_suppressor_high_quality --block-size 256 --sample-rate 48000 --seconds 2"
```

Try different callback sizes:

```bat
cmd /c "set Path=& set PATH=C:\Users\Krasen\Desktop\XLETH\bridge\build\vcpkg_installed\x64-windows\debug\bin;C:\Windows\System32;C:\Windows& build\engine\Debug\xleth_audio_perf_report.exe --scenario resonance_suppressor_high_quality --block-size 64 --seconds 2"
cmd /c "set Path=& set PATH=C:\Users\Krasen\Desktop\XLETH\bridge\build\vcpkg_installed\x64-windows\debug\bin;C:\Windows\System32;C:\Windows& build\engine\Debug\xleth_audio_perf_report.exe --scenario resonance_suppressor_high_quality --block-size 128 --seconds 2"
cmd /c "set Path=& set PATH=C:\Users\Krasen\Desktop\XLETH\bridge\build\vcpkg_installed\x64-windows\debug\bin;C:\Windows\System32;C:\Windows& build\engine\Debug\xleth_audio_perf_report.exe --scenario resonance_suppressor_high_quality --block-size 512 --seconds 2"
```

Choose a report directory:

```bat
cmd /c "set Path=& set XLETH_AUDIO_PERF_REPORT_DIR=C:\tmp\xleth-audio-perf& set PATH=C:\Users\Krasen\Desktop\XLETH\bridge\build\vcpkg_installed\x64-windows\debug\bin;C:\Windows\System32;C:\Windows& build\engine\Debug\xleth_audio_perf_report.exe --scenario resonance_suppressor_high_quality"
```

The same directory can be supplied with `--output-dir`. Other command-line
options are:

- `--sample-rate <hz>`: default `48000`
- `--block-size <n>`: one of `64`, `128`, `256`, `512`, `1024`; default `256`
- `--seconds <n>`: default `5`
- `--scenario <id|all>`: default `all`
- `--strict`: returns nonzero if any report is `warning` or `overrunning`
- `--audio-engine`: currently deferred; the stable manual path is MixEngine

Environment defaults are also supported:

- `XLETH_AUDIO_PERF_SAMPLE_RATE`
- `XLETH_AUDIO_PERF_BLOCK_SIZE`
- `XLETH_AUDIO_PERF_SECONDS`
- `XLETH_AUDIO_PERF_SCENARIO`
- `XLETH_AUDIO_PERF_REPORT_DIR`
- `XLETH_STRICT_AUDIO_PERF=1`

The AudioEngine/device path is deliberately deferred in this pass. Headless
AudioEngine execution still needs a stable no-hardware device harness before it
can be useful without becoming a flaky machine-specific test. The report keeps
`livePresentationLatencySamples` at `0` for the MixEngine path.

## Scenarios

The default harness currently emits Stage 5A telemetry for:

- `baseline_empty_mix`
- `dry_track_mix`
- `resonance_suppressor_normal_quality`
- `resonance_suppressor_high_quality`
- `multi_track_resonance_suppressor_high_quality`
- `stock_latent_effect_chain`
- `third_party_wrapped_chain`
- `master_chain_latent_heavy_effect`

The scenarios use the same POD timing sample and off-thread snapshot aggregation
as realtime diagnostics. The harness is non-realtime code; it does not change
audio callback capture behavior, DSP, PDC math, transport semantics, export
preroll/discard, live presentation latency, or plugin latency reporting.

The manual runner supports the same scenario IDs. Unlike the deterministic unit
target, it uses generated audio clips, real MixEngine block processing, real
stock effects, real Resonance Suppressor HQ WOLA work, and a real
GuardedPluginWrapper chain around a lightweight processor for the
`third_party_wrapped_chain` route.

## Report Output

By default the test writes:

```text
build/engine/audio_perf_scenarios/audio-performance-scenarios.json
build/engine/audio_perf_scenarios/audio-performance-scenarios.md
```

Set `XLETH_AUDIO_PERF_REPORT_DIR` to choose another output directory.

The JSON report is for tooling. The Markdown report is for quick human triage.
Both separate:

- scenario metadata
- latency/PDC accounting
- realtime CPU deadline health
- worst chains/effects
- lock/stale-state health
- Resonance Suppressor HQ WOLA timing
- diagnosis evidence

## Budget Classification

Each scenario carries a soft classification:

- `healthy`: p99 is below 60 percent of the callback deadline and no overruns
  were observed.
- `warning`: p99 is at least 60 percent of the deadline, or dropped telemetry
  samples increased.
- `overrunning`: callback or MixEngine p99/max is at or beyond the deadline, or
  callback/MixEngine overrun counters increased.

These classifications are diagnostic labels in default runs. They are not
normal CI failure thresholds because exact callback timing depends on CPU,
power policy, debug build cost, driver behavior, and host scheduling.

## Strict Local Mode

Set this only for local budget checks:

```bat
set XLETH_STRICT_AUDIO_PERF=1
```

When strict mode is enabled, the harness may return nonzero if any generated
scenario is classified as `warning` or `overrunning`. Unit coverage validates
the strict failure helper with synthetic data rather than real wall-clock
measurements.

## CPU Deadline Versus PDC

PDC latency is expected alignment delay. Large `maxTrackLatencySamples`,
`masterLatencySamples`, or `livePresentationLatencySamples` values mean the
engine is accounting for plugin delay; those values are not deadline misses by
themselves.

Realtime CPU deadline health is different. A rising overrun count, p99/max at
or beyond `callbackDeadlineUs`, high Resonance Suppressor HQ WOLA timing, lock
misses, or stale chain reuse means the callback may not be finishing before the
audio device needs the next block. PDC proof tests can remain green while a
heavy HQ or third-party chain still causes realtime deadline pressure.

For Resonance Suppressor High Quality, inspect the Markdown section
`Resonance Suppressor HQ WOLA` first. It calls out:

- WOLA p99/max
- whether RS HQ appears in `worstEffectsByP99` or `worstEffectsByMax`
- callback p99/max as a percentage of deadline
- overrun counts

Then check `Diagnosis`. The evidence labels distinguish:

- `cpu_deadline_overrun`: callback or MixEngine timing exceeded deadline
- `cpu_deadline_margin_risk`: p99 is approaching the deadline
- `lock_or_stale_chain_issue`: lock misses or stale chain reuse were observed
- `telemetry_dropped_samples`: the telemetry ring dropped samples
- `compensated_latency_pdc_only`: latency was compensated, but no CPU/lock/drop
  issue was observed
- `insufficient_evidence`: timing samples were missing
- `no_realtime_instability_observed`: no instability was visible in the report

## Resonance Suppressor HQ Identity

Resonance Suppressor High Quality WOLA timing is identified without realtime
string formatting by stable telemetry fields:

```text
effectType = resonancesuppressor
flags      = HighQuality | Wola
kind       = effect_section
```

Third-party chains are reported as `third_party` with track and slot/node
identity. Plugin display names are not copied from the audio thread.
