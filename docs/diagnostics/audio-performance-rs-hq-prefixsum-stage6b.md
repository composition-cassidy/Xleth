# Stage 6B RS HQ Detector Prefix-Sum Report

Stage 6B audited and optimized the Resonance Suppressor High Quality WOLA
detector baseline calculation. This remains an optimization pass only: no UI
warning, product gate, export-only mode, background spectral engine, FFT size,
hop size, window, latency, PDC, presentation, transport, or export timing was
changed.

## Equivalence Result

Prefix-sum equivalence is proven for the current detector baseline within a
0.01 dB tolerance in `test_pdc_stage1`.

The preserved detector source is the per-channel, unweighted magnitude dB vector:

```text
m[k] = 10 * log10(max(re[k]^2 + im[k]^2, 1.0e-24)), for 1 <= k <= N - 2
m[0] = m[N - 1] = -240 dB
```

For each interior bin:

```text
r(k) = clamp(k / 6 + 4, 6, 48)
lo = max(1, k - r(k))
hi = min(N - 2, k + r(k))
gapLo = max(lo, k - centerGap)
gapHi = min(hi, k + centerGap)
baseline = (sum(m[lo..hi]) - sum(m[gapLo..gapHi])) / count
```

`count` is the clamped local-window bin count minus the excluded center-gap
count. If `count` is zero, the existing fallback of `m[k]` is preserved, though
the current radius and gap settings leave at least one neighbor for valid
interior bins.

The edge behavior is unchanged:

- Bin `0` and Nyquist bin `N - 1` are not detector candidates.
- Local windows clamp to `1..N - 2`; there is no padding.
- Bins with `abs(j - k) <= centerGap` are excluded.
- Weighting is not part of the baseline source; weighting is still applied
  later in `applyReductionMask`.
- Smoothing still happens after salience is computed.

## Implementation

- Added `magDbPrefix_` as WOLA-owned scratch, allocated in `prepare()` and
  cleared in `release()`.
- Built the prefix once per processed WOLA frame:

```text
prefix[i + 1] = prefix[i] + m[i]
```

- Replaced the nested local baseline scan with two prefix range sums: one for
  the full clamped detector window and one for the excluded center gap.
- Kept the slow reference path only behind
  `XLETH_RESONANCE_SUPPRESSOR_TEST_HOOKS` for equivalence tests.
- No heap allocation, logging, locking, graph work, or latency publication was
  added to the audio path. The project still has no allocation guard test for
  this effect, so realtime allocation safety is documented by audit.

## Tests

Added baseline equivalence cases in `test_pdc_stage1`:

- Flat spectrum.
- Single-bin spike.
- Multiple harmonic spikes.
- Deterministic random spectrum.
- Low-bin edge.
- High-bin edge.
- Near-floor magnitudes.
- Weighted-shaped source vector. Weighting is not applied before the production
  baseline, but this verifies a shaped source still matches the range-sum
  formula.

Existing RS HQ stability and latency coverage remains in place:

- RS High Quality reports 2048 samples before processing.
- RS High Quality output remains finite through WOLA processing.
- RS High Quality `processBlock` does not publish latency.
- State restore and prepare paths refresh High Quality latency before audio
  processing.

## Commands Run

The requested build command pattern clears `PATH`; on this machine that also
hides `cmake`. The same builds were run with the absolute CMake path:
`C:\Program Files\CMake\bin\cmake.exe`.

- `test_audio_perf_scenarios`: passed, 74 checks.
- `test_audio_telemetry`: passed, 16 checks.
- `test_pdc_stage1`: passed, 517 checks.
- `test_mix`: passed, 243 checks.
- `xleth_audio_perf_report`: built successfully.

## Before/After Summary

Timings are microseconds. Callback, MixEngine, and WOLA columns are `p99/max`.
Overruns are callback overruns. Stage 6A values are from
`docs/diagnostics/audio-performance-rs-hq-optimization-stage6a.md`.

| Scenario | Block | Deadline | Stage 6A callback | Stage 6B callback | Stage 6A MixEngine | Stage 6B MixEngine | Stage 6A WOLA | Stage 6B WOLA | Stage 6A overruns | Stage 6B overruns | Stage 6A class | Stage 6B class |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|
| `resonance_suppressor_high_quality` | 64 | 1333 | 2223/2868 | 1788/1841 | 2222/2866 | 1788/1840 | 1967/2423 | 1573/1637 | 115 | 114 | overrunning | overrunning |
| `resonance_suppressor_high_quality` | 128 | 2667 | 2695/3992 | 1981/2630 | 2693/3990 | 1979/2628 | 2421/3633 | 1668/2392 | 6 | 1 | overrunning | overrunning |
| `resonance_suppressor_high_quality` | 256 | 5333 | 3630/5231 | 2053/2445 | 3627/5228 | 2052/2443 | 2924/4389 | 1626/1879 | 0 | 0 | warning | warning |
| `resonance_suppressor_high_quality` | 512 | 10667 | 2558/2912 | 3733/4602 | 2556/2910 | 3730/4599 | 2038/2304 | 2453/3624 | 0 | 0 | healthy | healthy |
| `multi_track_resonance_suppressor_high_quality` | 64 | 1333 | 7886/7895 | 7017/7072 | 7884/7893 | 7015/7071 | 1871/1940 | 1770/1932 | 43 | 43 | overrunning | overrunning |
| `multi_track_resonance_suppressor_high_quality` | 128 | 2667 | 11423/11526 | 6657/6679 | 11420/11523 | 6656/6678 | 2711/3453 | 1777/1841 | 86 | 86 | overrunning | overrunning |
| `multi_track_resonance_suppressor_high_quality` | 256 | 5333 | 8630/9037 | 9890/12113 | 8629/9036 | 9887/12109 | 2006/2707 | 2461/3834 | 170 | 171 | overrunning | overrunning |
| `multi_track_resonance_suppressor_high_quality` | 512 | 10667 | 14689/15295 | 11767/13604 | 14687/15291 | 11765/13601 | 3816/4067 | 2629/2841 | 13 | 4 | overrunning | overrunning |

Lock misses and stale chain reuse remained `0` in all Stage 6B runs.

## Findings

Single-track HQ improved at 64, 128, and 256 samples. The 64- and 128-sample
cases still classify as `overrunning`, but callback p99 and WOLA p99 both
dropped. The 256-sample case remains `warning`, with WOLA p99 dropping from
2924 us to 1626 us.

Single-track 512 samples stayed `healthy`, but this run was slower than Stage
6A: callback p99/max moved from 2558/2912 us to 3733/4602 us, and WOLA p99/max
moved from 2038/2304 us to 2453/3624 us. Since it remains far below the 10667
us deadline, this does not change the product risk classification, but it is
worth re-sampling before claiming a universal 512-sample speedup.

Multi-track HQ improved at 64, 128, and especially 512 samples, but still
overruns at every tested block size. The 512-sample case is the important
signal: callback p99/max improved from 14689/15295 us to 11767/13604 us and
callback overruns dropped from 13 to 4, but callback p99 remains above the
10667 us deadline.

The multi-track 256-sample run regressed versus Stage 6A in this measurement.
It was already well over the deadline, and Stage 6B does not make that case
viable.

## Rejected Alternatives

- Did not average weighted magnitudes in the detector baseline. The current
  baseline source is unweighted magnitude dB; weighting is part of the later
  reduction-mask equation.
- Did not use a double-precision prefix. That would be numerically clean but
  would change the float accumulation order more than necessary and add
  bandwidth.
- Did not share a detector baseline across stereo channels. Magnitudes are
  channel-specific before stereo linking.
- Did not change FFT size, hop size, window, latency, suppression shape,
  smoothing, transport, export, presentation, or PDC math.

## Report Directories

- `build/engine/audio_perf_scenarios/stress_after_stage6b/resonance_suppressor_high_quality_bs64`
- `build/engine/audio_perf_scenarios/stress_after_stage6b/resonance_suppressor_high_quality_bs128`
- `build/engine/audio_perf_scenarios/stress_after_stage6b/resonance_suppressor_high_quality_bs256`
- `build/engine/audio_perf_scenarios/stress_after_stage6b/resonance_suppressor_high_quality_bs512`
- `build/engine/audio_perf_scenarios/stress_after_stage6b/multi_track_resonance_suppressor_high_quality_bs64`
- `build/engine/audio_perf_scenarios/stress_after_stage6b/multi_track_resonance_suppressor_high_quality_bs128`
- `build/engine/audio_perf_scenarios/stress_after_stage6b/multi_track_resonance_suppressor_high_quality_bs256`
- `build/engine/audio_perf_scenarios/stress_after_stage6b/multi_track_resonance_suppressor_high_quality_bs512`

## Recommendation

Stage 6B reduces detector CPU cost and proves the math, but it does not remove
the product risk for multi-track High Quality realtime use. The next stage
should add product guardrails for small buffers and multiple HQ instances, keep
HQ safe for export and high-buffer contexts, and consider a larger architectural
move such as a background or precomputed spectral engine if realtime multi-track
HQ must become reliable at 512 samples.
