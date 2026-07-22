# Loop Optimizer Lab

Phase 1 of the XLETH auto loop optimizer. Generates candidate loops for
monophonic tonal samples, scores them with a six-metric suite computed on an
**emulation of XLETH's real sampler render path**, and evaluates the result
against the gold-labelled corpus.

This is the reference implementation the C++ port will be read against, and the
permanent regression harness for it. It is **measurement infrastructure only** —
no weight tuning, no accept/reject thresholds, no auto-apply. Those are a later
phase and deliberately live nowhere in this tree.

## Running it

```bash
cd tools/loop_optimizer
python -m loop_optimizer report --corpus ../../loop-lab-corpus
```

Useful flags:

| Flag | Purpose |
| --- | --- |
| `--selection {auto,full,gold}` | Where to search. `auto` (default) detects the steady-state window and so also tests region selection; `gold` searches the gold region ± a margin and isolates the loop-point question; `full` searches the whole file. |
| `--rank-by METRIC` | Which single metric orders candidates. An **untuned placeholder**, not a cost function. Default `seam_step`. |
| `--only ID [ID ...]` | Restrict to specific `sample_id`s. |
| `--summary-only` | Drop the per-sample detail blocks. |
| `--json PATH` | Write full results as JSON. |
| `--write-features PATH` | Write a **copy** of `dataset.json` with `measured_features` filled in. Never in place. |

Tests: `python -m pytest` (93 tests, ~1 min - the joint length x crossfade search
in `candidates.py` measures far more candidates per sample than the earlier
fixed-crossfade version). Dependency: numpy. Not librosa.

## What makes this different from idealised loop math

Every metric is measured on the output of `engine_emu.py`, which mirrors
`engine/src/audio/Sampler.cpp` statement by statement. That matters because the
engine does things a clean-room loop model does not:

**The audible loop period is not `loopEnd - loopStart`.** The wrap skips the
first `effXfade` samples of the loop region (`Sampler.cpp:1024-1028`), so the
position cycle is `[loopStart + xfade, loopEnd)` and the material repeats every
`loopEnd - loopStart - xfade` samples. **A crossfade shortens the loop's repeat
period.** A loop whose span is a perfect multiple of the period goes out of tune
the moment you apply a crossfade that is not itself a period multiple. This is
why `candidates.py` runs a JOINT search over length AND crossfade, both
quantised to whole periods (crossfade capped at `floor(len/2)` per length, so
the engine's own clamp never binds — see below), and why `cents_err_per_loop`
measures `wrap_advance` rather than the loop span.

**The engine's own crossfade clamp can create that detune.** `effXfade` is
clamped to `(loopEnd - loopStart) / 2` (`Sampler.cpp:905`). Ask for a 6-period
crossfade on a loop spanning an *odd* number of periods and the clamp cuts it to
half the span — a *half*-period multiple — leaving an advance of k.5 periods.
Corpus sample `hard_tuned_vocal_0009` does exactly this and plays 149 cents flat,
from a crossfade request and a loop span that were both individually in tune.
Nothing about this is visible without emulating the clamp.
(`tests/test_engine_emu.py::test_engine_crossfade_clamp_can_itself_detune_a_short_loop`)
Every candidate `generate_candidates` emits is verified against `resolve()`
before being returned, so a candidate can never reach the report already
detuned by this trap — see `out/delta_phase1_vs_advance_aligned.txt` for the
corpus samples (`_0009`, `_0013`) this actually caught.

**An out-of-bounds voice freezes rather than walking on.** The bounds check's
`continue` (`Sampler.cpp:1051`) skips the `playPosition += stride` at `:1132`, so
the voice stalls and emits silence forever rather than advancing past the buffer.

**The blend is equal-power, which only preserves power for uncorrelated
sources.** Two anti-correlated sources — what a half-period-misaligned loop
produces — subtract, and the render dips in the middle of the fade.
`zero_lag_corr` predicts it; `rms_ripple_db` measures the damage.

## Layout

| Module | Role |
| --- | --- |
| `constants.py` | Engine facts (transcribed, not tunable) vs analysis policy (mirrors `dsp/LoopOptimizer.h`). The split is enforced by comment and matters. |
| `wavio.py` | RIFF reader/writer. Handles PCM 8/16/24/32 and float. |
| `ingest.py` | File → engine domain: mono merge, resample to 48 kHz, `SampleBank::applyFades`. |
| `engine_emu.py` | The `Sampler::processVoice` mirror. Scalar reference + vectorised window renderer, proven bit-identical. |
| `pitch.py` | YIN tracker and steady-state window detection. |
| `candidates.py` | `k*T` loop lengths, WSOLA-style NCC start search, crossfade variants. `xfade_variants` is where the engine-clamp invariant is enforced. |
| `formants.py` | LPC formant tracking (F1–F3). A **search** objective, not a metric — it decides where the loop goes, not how good it is. |
| `metrics.py` | The six metrics. |
| `features.py` | Per-sample `measured_features`. |
| `corpus.py` | `dataset.json` IO and the file↔engine domain conversion. |
| `analysis.py` | Per-sample pipeline, ranking, gold comparison. |
| `export.py` | `candidates.json`: the arms the blind A/B rater auditions, and the selection-first policies that generate them. |
| `report.py` / `__main__.py` | Text report, the policy gate table, and CLI. |

`engine_emu.py` provides two renderers on purpose. `render_reference` is a slow,
literal transcription of the C++ loop in C++ statement order — it is the readable
spec, meant to be diffed against `Sampler.cpp` by eye. `render_window` is a
closed-form vectorised solve that can render an arbitrary output range without
walking the samples before it, which is what makes measuring one seam in a long
sample across hundreds of candidates affordable. A test asserts they are
bit-identical over randomised configurations.

## The six metrics

All computed on the emulated render, except `zero_lag_corr` which is by
definition a property of the two source regions the blend mixes.

1. **`seam_step`** — discontinuity at the seam, as a linear-prediction residual
   normalised by the render's local RMS. The larger of the sample-value and slope
   residuals, combined with `max()` rather than a weighted sum, because weights
   would be tuning. Has a floor of roughly `(2*pi*f0/fs)^2`: a sine has real
   curvature, so a perfect loop reads ~0.005, not 0. Two to three orders of
   magnitude below a genuine click.
2. **`seam_ncc`** — normalised cross-correlation one period either side of the
   seam in the render. **Degenerate for very short loops**: a one-period loop
   scores exactly 1.0 by construction. Do not rank on it alone.
3. **`zero_lag_corr`** — correlation between the fade-out and fade-in source
   regions. NaN without a crossfade. Negative predicts cancellation.
4. **`cents_err_per_loop`** — `1200*log2(wrap_advance / (k*T))` against the
   **measured** period, never `root_note`. The corpus sits a few cents off equal
   temperament, and quantising to the label instead of the material is exactly
   the error this catches.
5. **`rms_ripple_db`** — peak deviation of the RMS envelope near the seam from
   the render's median level, signed so a cancellation dip stays negative.
6. **`spectral_dist`** — RMS log-spectral distance between a frame **centred on**
   the seam and the frame furthest from any seam. Centred deliberately: a click
   sits exactly at the boundary, so two frames flanking it would step around the
   artefact being looked for.

## Corpus results (26 gold loops: 20 `Hard-tuned vocal` + 6 `Natural vocal`, all `stable_periodic`)

Ranked by `seam_step`. `gold` selection isolates loop-point choice from region
selection; `auto` includes region selection. Candidate generation is now a
JOINT search over length and crossfade, both quantised to whole periods (see
"What makes this different" above) — an earlier version of this table, run
against a fixed 0/6/12-period crossfade guess per length on a differently
composed 26-sample (all `Hard-tuned vocal`) corpus, is preserved in
`out/report_gold.txt` / `out/report_auto.txt`; the isolated before/after delta
is in `out/delta_phase1_vs_advance_aligned.txt`.

| | `auto` | `gold` | `full` |
| --- | --- | --- | --- |
| top-1 matches gold (points + xfade) | 0/26 | 0/26 | 0/26 |
| some candidate matches | 3/26 | 2/26 | 2/26 |
| some candidate's loop POINTS match | 8/26 | 9/26 | 7/26 |
| top-1 crossfade within 2× | 4/26 | 4/26 | 4/26 |
| closest candidate to gold (median) | 13.06 periods | 2.44 periods | 10.40 periods |
| gold outside the detected window | 12/26 | — | — |

Per-metric, tool's top candidate vs gold (`gold` selection, full 26-sample
corpus). "beat gold" is the share of **all** candidates beating gold on that
metric:

| Metric | tool | gold | tie | beat gold |
| --- | --- | --- | --- | --- |
| `seam_step` | 26 | 0 | 0 | 50% |
| `seam_ncc` | 12 | 13 | 1 | 43% |
| `zero_lag_corr` | 24 | 0 | 2 | 91% |
| `cents_err_per_loop` | 25 | 1 | 0 | 100% |
| `rms_ripple_db` | 9 | 17 | 0 | 49% |
| `spectral_dist` | 14 | 12 | 0 | 47% |

### Reading these numbers

**The tool never reproduces gold, and gold is not obviously better.** The top
candidate beats gold on seam smoothness 26/26 and on per-loop tuning 25/26, while
gold wins on envelope ripple 17/26. Gold's loop points are chosen for reasons
these six metrics do not measure — which vowel is sustained, where a consonant
falls — and the seam objective is nearly flat across a sustain, so it does not
uniquely determine a loop start. That is the headline calibration signal, and it
is a finding about the metrics, not a bug to fix.

**`cents_err_per_loop` is now the flattest metric of all** (100% of candidates
beat gold in `gold` selection, up from 95% when the crossfade search was three
fixed guesses per length). Gold loop lengths are not period multiples, so gold
carries real per-loop detune while every generated candidate is now
GUARANTEED period-aligned in its audible advance, not just quantised on paper —
see `out/delta_phase1_vs_advance_aligned.txt` for the two samples
(`hard_tuned_vocal_0009`, `_0013`) where the old fixed-crossfade search still
let a clamp-detuned candidate through. A near-useless discriminator *among*
candidates; a strong signal *against* hand-authored loops.

**19 of 26 samples now have a candidate that beats gold on tuning AND every
seam-smoothness metric at once** (`seam_step`, `seam_ncc`, `rms_ripple_db`,
`spectral_dist` — one candidate, all four, plus tuning, simultaneously; not
the independent per-metric shares above). Two of those 19
(`hard_tuned_vocal_0011`, `_0013`) are also full gold matches — the strongest
calibration signal in the corpus: the metric suite's own top pick there is
what a human actually chose. Detail in `out/delta_phase1_vs_advance_aligned.txt`.

**`rms_ripple_db` is the most selective now** (49% beat gold, down from
`spectral_dist`'s 36% under the old search). If a later phase needs one metric
that actually rules candidates out, this is the one the corpus currently points
at — re-check this if the crossfade search changes again, since which metric is
"most selective" moved once already.

**Region selection is a separate, unsolved problem.** In `auto` mode the detected
steady-state window excludes gold entirely on 12/26 samples, so the tool cannot
reach gold there no matter how good the metrics are. The `gold` vs `auto` split
in the table above exists to keep that from being mistaken for a scoring failure.

### Corpus metadata: 1/26 `root_note`s disagree with the audio

Measured while running the suite, and the reason the brief's "never use the
declared `root_note`" rule is not merely stylistic. Most of the disagreements
recorded in the original 26-`Hard-tuned-vocal` corpus were corrected in the
dataset alongside the sample swap described above; one remains:

| Sample | `root_note` | Declared | Measured | Disagreement |
| --- | --- | --- | --- | --- |
| `natural_vocal_0022` | 72 | 523.25 Hz | 261.72 Hz | −1 octave |

The other 25 agree to within a few cents. The octave case is **not
necessarily mislabelled**: a loop must be quantised to the period at which the
waveform actually repeats, which is what YIN measures, and that can legitimately
sit an octave above the note a listener would name. Either way the analysis
uses the measurement, and the report raises a note per sample.

## Documented divergences from the engine

Recorded because they are real, not because they are believed harmless:

* **Resampler kernel.** The engine uses JUCE's `LagrangeInterpolator`
  (`SampleBank.cpp:69`), a 5-point Lagrange FIR with several dB of passband
  droop. This tool uses a windowed-sinc (Kaiser) resampler, so ingest is not
  bit-identical. Gold and candidates are measured on the identical ingested
  signal, so the comparison is unaffected; and the C++ port will run on the
  engine's own buffer, where the question disappears.
* **Mono merge.** The engine keeps buffers multi-channel and never mixes them
  (`Sampler.cpp:1121`); this tool merges to mono to measure one seam. A no-op for
  the monophonic material in scope, but a sample with genuinely decorrelated
  channels would need one measurement per channel.
* **Pitch detector.** The engine's `dsp/LoopAnalysis.h` uses NSDF/McLeod; this
  tool uses YIN, per the phase brief. They disagree mainly in how they fail, and
  the tonal-band gate that actually protects the result is shared.
* **Envelope, LFOs, velocity.** Held at unity/off. A decaying envelope would
  smear every seam metric with an amplitude trend unrelated to the seam, and a
  pitch LFO would make `stride` time-varying and invalidate the closed-form
  position solve.

## Unrelated engine issue noticed while building this

`stride` is held at 1.0 here, which is the **intended** behaviour at root pitch on
a buffer already at the engine rate. The shipping engine may not currently
achieve that: `SampleBank` resamples every sample to 48 kHz and records both
`originalSampleRate` (the file rate) and `bufferSampleRate` (48 kHz), but
`MixEngine.cpp:1793` / `:2352` pass `originalSampleRate` into
`Sampler::loadSample`, and `Sampler.cpp:876` derives
`srRatio = sourceSampleRate_ / engineSampleRate` from it. For a 44.1 kHz source
that gives a stride of 0.91875 against a 48 kHz buffer — roughly 146 cents flat.
`bufferSampleRate` is currently read only by `ClipRenderCache.cpp:90`, which is
where the same bug was fixed for clips in c45d353.

**Not verified at runtime**, and out of scope for this phase — flagged as
separate work. If it is real, it should be fixed rather than emulated, and this
tool's `stride = 1.0` is already the post-fix behaviour.

## A note for whoever ports this

`EffectiveLoop.wrap_advance` is the single most likely thing to get wrong. Every
other sampler worth comparing against uses `loopEnd - loopStart` as the loop
period. XLETH does not. If the ported metrics disagree with this reference,
check that first.


## The selection-first policy arm, rounds 3 and 4

Full-auto candidate generation ranked by the metric suite lost to human gold
43–3–3 across rounds 1–2. The shipping product does not do full-auto placement
anyway — the user drags a rough region and the machine snaps — so rounds 3 and 4
test that shape instead. Both are closed-form policies with no metric ranking
anywhere in them.

| | round 3 (`--policy v1`) | round 4 (`--policy v2`, default) |
| --- | --- | --- |
| length | snapped to the whole dragged span | longest span whose F1–F3 drift passes the gate |
| placement | best seam NCC | best NCC among the stable spans |
| fade | longest the engine clamp allows | longest whose two sources are still the same vowel |
| result | 7–17–1 vs gold; mechanical tags gone, 12 of 17 losses tagged timbre-jump | pending |

### Setting the gates: a threshold that refuses gold is a bug

Every gate was implemented from an audibility figure first and then measured
against the corpus's own human answers, on the principle that a gate whose job
is to catch a bad tail must not be refusing what the winner does. Two of the
three failed that test and changed:

| gate | audibility figure | what gold actually does | shipped |
| --- | --- | --- | --- |
| fade formant distance | 150 cents (~5–8% JND) | median 127, p90 303, **max 494** — over 150 on 8 of 19 | 300 (gold's p90), labelled corpus-bounded |
| fade envelope RMS | 3 dB (`hollow`'s reference) | up to 5.1 dB | **removed** — see below |
| click / flam | 2.0 / 20.0 (`PERCEPTUAL_REFERENCE`) | 0.79–1.07 and 0.0 | kept unchanged |

The RMS gate was removed for a second and more basic reason than firing on gold:
it is **anti-monotone in the thing it controls**. "Shorten until it passes" is
only a procedure if shortening helps, and here it does the opposite — the two
fade sources are windows at the loop's end and start, so a longer fade averages
them towards each other while a shorter one converges on the raw level step at
the seam. On `hard_tuned_vocal_0001` the difference runs 4.6 dB at the longest
fade and 10.2 dB at the one-period floor. The reading is still computed and
reported; it just decides nothing.

### What the placement gate is betting on

The round-3 losses were tagged as placement errors, and the two measurements
point that way without settling it. Paired against gold across the corpus, the
losing round-3 arm has the higher fade-source formant distance on 11 of 15
samples (median 174 vs 127) and the higher span drift on 17 of 25 (73 vs 66).
Both are around p = 0.06 — suggestive, not significant, and neither is evidence
the gate will help. Round 4 is the test.

### What round 4 actually changed

`python -m loop_optimizer export --corpus ../../loop-lab-corpus --selection gold
--top-k 0 --policy-table out/policy_table_round4.txt` produced
`candidates.round4.json` (25 policy arms; `hard_tuned_vocal_0019`'s gold region
is too short for one, as in round 3):

* the **placement gate shortened 18 of 25** loops, median length 0.81 of the
  longest span available. Where the material moves it moves a lot —
  `hard_tuned_vocal_0004` went from a span drifting 313 cents to one drifting
  29, `natural_vocal_0024` from 253 to 49;
* the **fade gate never fired**, on any sample. It was not close either: the
  largest fade-source distance at any chosen span is 216 cents against a gate of
  300. Once placement is fixed, the fades stop spanning transitions on their
  own, which is a result about the mechanism rather than about the threshold;
* **7 of 25 arms are byte-identical to round 3's**, which is the gate correctly
  doing nothing on material that does not drift — and a free consistency check,
  since those trials should reproduce their round-3 verdicts.

The two generations are separate provenances (`policy`, `policy_v2`) rather than
one slot whose meaning depends on the file. `armContentHash` mixes provenance
in, so a round-3 verdict can never be silently credited to a round-4 arm that
lands on the same loop points — the failure mode 2d5c5d1 had to fix once
already.
