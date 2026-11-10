# ResonanceCore

`engine/src/dsp/ResonanceCore.{h,cpp}`, namespace `xleth::dsp::resonance`.

A self-contained spectral resonance suppressor core: it finds narrow spectral peaks that stand out of the local
spectrum (a ringing room mode, a whistle, a harsh formant), and attenuates exactly those bands, per channel, with a
real zero-phase gain applied through a weighted overlap-add (WOLA) transform. It has no `juce::AudioProcessor` or
APVTS dependency: it is driven with raw channel pointers and a plain parameter struct, so it can be unit-tested and
benchmarked without an engine. As of this document it is **not wired into any effect**; the existing
`XlethResonanceSuppressorEffect` and the EQ spectral band are separate implementations. Section 8 is the surface the
Resonance Suppressor's High Quality mode needs (band grid and weight curve, sharpness, mono / Mid / Side operation, a
visualization tap, meters, parameter-change safety, the instance hop-phase helper) and how the effect maps its
parameters onto the core. Section 9 is live frame-tier switching (Fast / Normal / High while processing, from any thread, without
allocation), the aligned dry output an effect mixes against, and the parameter hardening at intake.

This file describes what the code does, why each constant has its value, what was tried and rejected, and where the
core is known to be limited. Numbers quoted here were measured with `engine/tools/xleth_rs_quality_bench.cpp` and
`engine/test/test_resonance_core.cpp` (see "Running the bench against the core"); a quoted number is a measurement
on the bench's synthetic signals (pink noise with a planted RBJ bell, +12 dB / Q 8 unless stated), not a guarantee
for arbitrary program material.

## Contents

1. Architecture
2. Tunables
3. Rejected approaches
4. G1 resolution ceiling, and what to tell users
5. Real-time rules: allocation and threading
6. Running the bench against the core
7. Measured margins (7.1 single-seed robustness, 7.2 D1 vs the bench, 7.3 worst-case CPU, 7.4 seed protocol and tier study, 7.5 multi-instance bursts)
8. Resonance Suppressor integration surface (8.1 grid and weight curve, 8.2 sharpness, 8.3 channels and Mid / Side, 8.4 visualization tap, 8.5 meters, 8.6 parameter changes, 8.7 instance hop phases, 8.8 RS parameter mapping, 8.9 what the core still cannot do)
9. Live frame-tier switching, aligned dry, parameter hardening (9.1 structure, 9.2 the transition contract, 9.3 what the effect must do, 9.4 detector state across a switch, 9.5 hop phase across tiers, 9.6 parameter hardening, 9.7 API summary, 9.8 bit-identity and CPU checks, 9.9 limitations)

## 1. Architecture

### 1.1 Frame engine

- **Frame size N**: Fast 512, Normal 1024, High 2048 at sample rates up to 50 kHz, doubled for every further sample-rate
  octave (Normal: 2048 at 88.2 / 96 kHz), so a Normal frame is about 21.3 ms at any rate. Hop H = N / 4. `setFrameTier()`
  picks the tier `prepare()` starts on; `prepare()` builds all three, and `requestTier()` switches between them while
  processing (section 9).
- **Windows:** periodic sqrt-Hann for analysis and for synthesis; the synthesis window is also scaled by the
  per-hop-phase constant 1 / sum(w^2) so that overlap-add reconstructs the input exactly (depth 0 is a pass-through
  with an error of -160 dBFS RMS, max |diff| 6e-8).
- **Latency** is exactly N samples of the tier in use, for every parameter value and every block size. Output is bit-identical across
  block schedules (any `numSamples >= 0` is accepted; frames are produced as the hop fills). The input goes into a per-channel ring that
  is every tier's analysis FIFO (9.1).
- **Transform:** `juce::dsp::FFT` real, forward, per-bin gain, inverse. One FFT pair per channel per hop.
- **Hop phase offset** (`setHopPhaseOffset()`, before `prepare()`, default 0): shifts the initial frame grid by `offset` samples (modulo the hop). The hop
  counter starts that far into a hop, so the first frame completes after `hop - offset` input samples and then every hop; the stream behaves as if it had been
  preceded by `offset` zero samples. Latency stays exactly N, steady-state COLA and every time constant are unchanged, and 0 / hop / any multiple of the hop
  is bit-identical to a core that never called it. It exists for one reason: n instances run back to back in one thread complete all of a hop's FFT / detector /
  gain work in the same block unless their phases differ; give instance i the offset `i x hop / n` (section 7.5).

### 1.2 Band grid

96 bands, uniformly spaced on the ERB-rate axis `E(f) = 21.4 log10(1 + 0.00437 f)`, from 20 Hz to
min(0.45 fs, 20 kHz). A band is a triangular (in the ERB domain) weighting of FFT bins; where a band is narrower than
a bin it is the linear interpolation of the two nearest bins. Each bin is weighted by its frequency, so the band
**level is in per-octave units: pink noise is flat across bands**, which is what makes a single threshold usable from
bass to treble.

### 1.3 Slow and fast estimates

Per bin, two recursive averages of the frame power |X_k|^2 are kept: a **slow** one (time constant 200 ms) and a
**fast** one (40 ms). Both are bias-corrected while they start up, and both time constants are converted to a per-hop
coefficient with the hop duration, so they are in milliseconds at every N and every sample rate.

For each estimate and band:

- **level** (dB) = 10 log10 of the band-weighted average power;
- **baseline** (dB) = the straight line (dB against log2 f) through the **medians** of the band levels on the two
  flanks, evaluated at the band centre. A flank starts outside the resonance's main lobe, at max(0.5 octave, 2 FFT
  bins) from the band, and is 0.75 octave wide. A median is robust to a second resonance on the same flank. At the
  grid edges only one flank exists; the flank median is then carried to the band along a wideband tilt (least-squares
  line over 200 Hz - 10 kHz).
- **excess** E = level - baseline (dB);
- **sigma_E**: the standard deviation of the excess for noise-like input, predicted from the averaging geometry
  (frame-overlap and bin correlation of this window, the recursive weights including the start-up count, the band's
  bin weights, and the variance of the flank medians; log-Gamma statistics). Every threshold in the core is a
  multiple of the sigma **of the estimate in use**, so the false-trigger rate on noise is a property of the
  statistics, not of a dB value tuned on one signal. The slow sigma is about 0.5 dB at 2.5 kHz; the fast one is larger.
  On clean pink noise the measured std of the excess is 0.96 - 1.05 times the predicted sigma_E in four frequency regions.

**Detection threshold** T = z x sigma_E with z = 6 - 4 x sensitivity: 6 sigma at sensitivity 0, 4 at 0.5 (default),
2 at 1.

### 1.4 Which estimate a band uses (the onset rule and the release latch)

The slow estimate is precise but needs about 200 ms to reach a new level; it would delay both the start of a cut and,
worse, the end of one. The fast estimate follows within a few frames but is noisy. Per band and per frame:

| situation | rule | threshold | why |
|---|---|---|---|
| **steady** | use the slow estimate | - | smallest sigma, so the lowest false-trigger rate and the least jitter |
| **onset** | fast - slow > `kSwitchUpSigmas` fast sigmas: use the fast estimate | **2.5** | a new resonance lifts the fast level well before the slow one; noise stays inside 2.5 sigma |
| **release latch, set** | slow - fast > `kVetoSetSigmas` fast sigmas: latch the band to the fast estimate | **2.0** | after the resonance stops, the slow estimate falls only as 10 log10(1 + 9 e^(-t / 200 ms)); it is still 3-5 dB above the clean level while already inside 2.5 fast sigmas of the fast estimate, so a symmetric +-2.5 rule never hands over (G9a 6/9). 2.0 sets the latch about 45 ms after the offset (one 5.3 ms hop, the 21 ms window, and the 40 ms average having to fall by 2 fast sigmas, about 2.1 dB; measured at 2.5 kHz) |
| **release latch, clear** | slow - fast < `kVetoClearSigmas` fast sigmas: back to the slow estimate | **0.75** | hysteresis; the latch must not chatter while the slow estimate converges back |

The threshold, the knee width and the depth cap all run on the estimate that is in charge, with that estimate's own
sigma. While a band is latched, the cut follows the fast excess (which falls to 0 within a few frames) and the
per-band release (`releaseMs`, default 200 ms) runs from the cut the band had: a 9.3 dB cut decays below 1 dB about
(500 - 45) ms later (9.3 dB x e^(-455 / 200) = 0.95 dB), i.e. the release the user asked for, not the detector's lag.
In steady state the false-latch rate is about 2 % per band-frame, lasting a few frames, and the steady cut differs from the
slow-only core by <= 0.5 dB (unit test D2: 9.32 dB against 9.32 dB at 2.5 kHz).

### 1.5 From excess to reduction

1. **Salience** u = (E - T) / sigma_E; **knee** K = smoothstep(u / kappa), kappa = 3 sigma (Soft) or 1.5 sigma (Hard).
2. **Main-lobe gating:** each band takes the maximum K over its own main-lobe zone (the zone the baseline excludes). A
   resonance confidently detected anywhere in the zone takes its shoulders with it (and, at low f, the analysis
   window's leakage of it into neighbouring bins).
3. **Target** = K x E: the **whole excess**, i.e. towards the baseline, not "excess minus threshold" (which would leave
   the threshold standing as a residual).
4. **Sub-bin depth correction** (below about 300 Hz at N = 1024, where an ERB is narrower than the analysis kernel): the
   *depth* of the cut, not the detection decision, uses the excess an auditory filter centred on the peak would see.
5. **Depth cap:** R = r / (1 + (r / Rmax)^p)^(1/p), Rmax = depth x 12 dB (Soft, p = 2) or depth x 24 dB (Hard, p = 6).
6. **Per-band attack / release** in dB at the frame rate (one-pole), then **[1 2 1] / 4** smoothing across bands
   (at the default `sharpness` 0.5; section 8.2), then the **stereo link** (each channel blends towards max(L, R) by
   `stereoLink`), then the optional **weight curve** (section 8.1).
7. **G(f):** the band curve in dB is interpolated linearly on the ERB axis to every bin and applied as a real,
   zero-phase gain. If every gain is exactly 1 the multiply is skipped.

### 1.6 Cost control

The per-band flank medians are the dominant detector cost. Each band's baseline is recomputed every 4th frame (slow
estimate) / 2nd frame (fast estimate) at N = 1024, staggered over the bands (`kSlowBaselineRefreshMs` = 21.33 ms,
`kFastBaselineRefreshMs` = 10.67 ms, converted to whole frames in `prepare()`), and **all** baselines are recomputed in
the frame where the mean band level has moved by more than `kBaselineJumpDb` = 1.5 dB since the last full refresh (a
broadband onset out of silence otherwise meets a stale baseline and shows a false excess; without the guard a lone
impulse failed the unit test T3 with a height of 0.83). Levels are exact in every frame.

## 2. Tunables

### 2.1 `Params` (copied by value into `process()`, may change every block)

| field | range | unit | effect |
|---|---|---|---|
| `depth` | 0 - 1 | - | ceiling of the cut of one band: depth x 12 dB (Soft) or x 24 dB (Hard). 0 = pass-through |
| `sensitivity` | 0 - 1 | sigma | threshold z = 6 - 4 x sensitivity sigma (6 / 4 / 2 at 0 / 0.5 / 1). Higher = more sensitive |
| `attackMs` | 0.1 - 1000 | ms | per-band attack of the applied reduction (default 15) |
| `releaseMs` | 1 - 10000 | ms | per-band release of the applied reduction (default 200) |
| `hardKnee` | bool | - | false: Soft (knee 3 sigma, ceiling 12 dB x depth, p = 2); true: Hard (knee 1.5 sigma, 24 dB x depth, p = 6) |
| `stereoLink` | 0 - 1 | - | 0 = independent channels, 1 = both channels take max(L, R) of the reductions |
| `sharpness` | 0 - 1 | - | narrowness of the applied cut (cross-band smoothing): 0.5 (default) = [1 2 1] / 4, the historical behaviour; 1 = none (narrowest); 0 = [1 2 1]^4 / 256 (broadest). Section 8.2 |
| `weightCurve` | pointer | - | nullptr (default) = flat 1. Else `numBands()` floats in [0, 2.5] on the band grid; scales the applied reduction with the RS weighting semantics (w <= 1: w x R; w > 1: deeper up to the depth ceiling). Section 8.1 |

`process()` sanitises a copy at intake: a non-finite field takes its default, every field is clamped to the range above
(9.6). Valid values pass through bit-identically.

The bench subjects use: **C1** = defaults (depth 0.5, Soft), **C1c** = depth 1, Hard, everything else default (the
"capability" setting every gate is graded at), **C1s** = depth 1, sensitivity 1, Hard (the most sensitive and deepest
setting; the musical-noise gate G4 is graded on it).

### 2.2 Structural settings (before `prepare()`, no live change) and the live tier request

| setter | default | unit | effect |
|---|---|---|---|
| `setFrameTier()` | Normal | tier | the tier `prepare()` starts on: N = 512 / 1024 / 2048 (window 10.7 / 21.3 / 42.7 ms at <= 50 kHz); latency = N. Nothing is retuned per tier |
| `requestTier()` | - | tier | **live**, any thread: switch the tier while processing (section 9). Not structural |
| `setKeepDetectorStateOnTierSwitch()` | true | bool | study option: false starts the new tier from reset state on a switch (9.4) |
| `setDetectorTimeConstantMs()` | 200 | ms | slow estimate |
| `setFastTimeConstantMs()` | 40 | ms | fast estimate; 0 disables the fast path (slow only) |
| `setHopPhaseOffset()` | 0 | samples | initial hop phase, modulo the hop; latency stays N; 0 = historical behaviour (bit-identical). Use `Core::hopPhaseOffsetForInstance(i, hop)` for instance i in one thread (7.5, 8.7). Kept as a fraction of the hop across tier switches (9.5) |
| `setVizSink()` | nullptr | - | visualization tap (not structural: may be set between `process()` calls on the processing thread). Section 8.4 |

### 2.3 Constants (compile time)

| constant | value | unit | role |
|---|---|---|---|
| `kSwitchUpSigmas` | 2.5 | fast sigma | onset: fast - slow above this uses the fast estimate |
| `kVetoSetSigmas` | 2.0 | fast sigma | release latch: slow - fast above this latches the fast estimate |
| `kVetoClearSigmas` | 0.75 | fast sigma | release latch: clears below this |
| `kBaselineJumpDb` | 1.5 | dB | mean-band-level jump that forces a full baseline refresh |
| `kSlowBaselineRefreshMs` / `kFastBaselineRefreshMs` | 21.33 / 10.67 | ms | staggered baseline refresh interval of a band |
| `kGapOct` / `kGapBins` | 0.5 / 2 | octave / bin | flank exclusion around a band (main lobe of a Q >= 4 resonance, and the analysis main lobe) |
| `kFlankOct` | 0.75 | octave | flank width beyond the exclusion |
| `kGridBands` | 96 | bands | ERB-spaced detector / gain grid |

## 3. Rejected approaches

Each row was graded on the whole bench gate set, not only on the gate it targeted. Gates referred to: **G1** residual of
the planted resonance after processing (12 frequencies, limit 0.30 x ideal), **G4** musical-noise jitter on the most
sensitive setting (std <= 0.6 dB), **G8a** onset (t50 <= 100 ms), **G9a** the cut is gone 500 ms after the resonance stops
(|r_off(500)| <= 1.0 dB). Subject C1c; "quick" = the bench's 8 s signals. The baseline (slow estimate only, 200 ms) is
G8a 4/6, G9a 1/9, G1 11/12, G4 std 0.129 dB.

| # | approach | G8a | G9a | G1 | G4 std | why it was rejected |
|---|---|---|---|---|---|---|
| S | **Shorten the averaging time alone** (slow estimate only, 100 / 60 / 40 ms) | 6/6 | 5/9, 9/9, 9/9 | 10, 9, 8 of 12 | 0.171 / 0.204 / 0.232 | trades the dynamic gates for the static ones: the 150 Hz residual grows to 3.6 / 5.0 / 6.0 dB, jitter rises. The slow estimate's precision is what makes the low-frequency detection work |
| 1a | **Symmetric switch**, +-2.5 fast sigma | 6/6 | 6/9 | 11/12 | 0.133 | the release side fires too late: the slow estimate is within 2.5 sigma_f of the fast one while still 3-5 dB above the clean level (K > 0, a plateau of cut) |
| 1b | **Loose release switch**, 0.5 sigma, not latched | 6/6 | 9/9 | 10/12 | 0.130 | the fast estimate is in charge in about 31 % of steady-state frames and lowers the mean cut by 0.1 - 0.4 dB at every f0; 150 Hz residual 2.41 dB against a 2.07 dB limit |
| 1d | **Latch 1.5 / 0.5** | 6/6 | 9/9 (worst 0.80 dB) | 10/12 | 0.135 | false latches at low frequency: 150 Hz residual 2.13 dB, 220 Hz +0.2 dB |
| 1e | **Fast tau 25 ms** (with the 2.0 / 0.75 latch) | 6/6 | 7/9 | 10/12 | 0.148 | noisier fast estimate (larger sigma_f): more false latches, fails G9a |
| 1e | **Fast tau 60 ms** (same latch) | 4/6 | 9/9 | 11/12 | 0.129 | reacts too late at 500 Hz: t50 101 - 104 ms against the 100 ms gate |
| - | Detector tau 400 ms (slow only) | - | - | 9/12 | 0.086 | detects sub-bin resonances more often, but the clean-pink low-frequency bias (+0.6 dB) becomes ~1 sigma (false-trigger rate 2 % per band-frame) and the cut lingers ~2 tau after a resonance stops. It also does not pass G1 at 100 Hz (residual converges to ~3.5 dB) |

**Kept: 1c**, the two-speed detector with the release latch set at 2.0 / clear at 0.75 fast sigma and fast tau 40 ms:
G8a 6/6, G9a 9/9, G1 11/12 (the missing one is 100 Hz, section 4), G4 std 0.130 (quick) / 0.156 (full), steady state
untouched. Two earlier, separate failed attempts at the 100 Hz case (main-lobe-gated reduction; auditory-resolution
target) are in section 4.

## 4. G1 resolution ceiling, and what to tell users

**Fact.** On the bench's default noise, G1 passes at 11 of the 12 scan frequencies. At **f0 = 100 Hz it fails**: the in-window
residual of a +12 dB / Q 8 bell is +3.1 to +3.6 dB over seven noise realisations (+3.45 dB on the default one) against a limit of
2.10 dB (the bell's mean boost over the gate window is 7.23 dB, so about half of it is removed). The same ceiling holds at
N = 2048 (+3.65 dB on the default noise). **150 Hz is also at the edge** (section 7: it fails on 5 of 6 other noise
realisations by 0.1 - 0.2 dB); the waiver does not cover it.

**Cause.** A Q 8 bell at 100 Hz is 12.5 Hz wide at -3 dB. An FFT bin is 46.9 Hz at N = 1024 and 23.4 Hz at N = 2048, so
the resonance is narrower than one analysis bin. The detector sees the **bin-average** excess (about 4.7 dB at N = 1024:
barely above the 5.1 dB threshold, detected in 43 % of frames at tau 100 ms, 82 % at 200 ms), and the cut is that
average, so the sub-bin peak stays standing. At N = 2048 the resonance is resolved better (bin excess 6.34 dB, detected)
but the mean cut is still 5.86 dB against an in-window peak of about 8.6 dB, for the same reason. The WOLA renderer
adds to this: its response is the per-bin gains convolved (in amplitude) with the sine-window power kernel (bin offsets 0 /
+-1 / +-2 weigh 1 / 0.111 / 0.004), so a notch narrower than about two bins cannot reach full depth.

**What was tried (two strikes, then stopped):**

1. *Main-lobe-gated reduction* (which bands are cut), averaging tau 100 ms: 100 Hz residual 5.43 -> 4.84 dB.
2. *Auditory-resolution target* (how deep the cut is, below ~300 Hz): 4.84 -> 4.25 dB at tau 100 ms and 2.92 dB at tau 200 ms (the
   default); it fixed 150 / 220 / 330 Hz but not 100 Hz.
3. Longer averaging (tau 400 ms): detection saturates, the residual converges to ~3.5 dB. Not a detection problem.
4. N = 2048 (High tier): +3.65 dB. Not fixed.
5. N = 512 (Fast tier) *passes* (+0.96 dB), but not by resolving the resonance: its 94 Hz bin cuts a +-47 Hz neighbourhood,
   i.e. it over-suppresses around the resonance. It fails G8a 500 Hz / D 300 (t50 104 ms) and G9a 500 Hz / D 1000 (-1.08 dB),
   so it is not a fix.

**Not attempted:** renderer-kernel pre-compensation (sharpening the gain curve before the WOLA kernel smooths it, which
needs gains above 1 on the neighbouring bins or a constrained solve), and a gate change (grade the window against the
auditory resolution at low frequency). Either would be a separate piece of work.

**Waiver.** The bench evaluator has a named exception: G1 at 100 Hz is waived for C1c, C1c-N and C1c-H, printed as
"resonance narrower than one analysis bin (resolution ceiling); see design doc", the raw G1 count (11/12) stays
visible, and the verdict reads `PASS (1 waiver)` when everything else passes. No other subject or frequency is waived.

**User guidance (for the effect that will wrap this core).**

- Below roughly 150 Hz, a resonance narrower than the analysis bin (a Q of about 8 or more at 100 Hz) is **only partly
  reduced**. On the bench's +12 dB / Q 8 bell the core removes about 50 % of the bell's in-window boost at 100 Hz, about
  65 - 70 % at 150 Hz and 85 - 95 % from 220 Hz upward (residuals of 3.5 / 1.9 - 2.3 / 0.5 - 1.2 dB).
- For a single fixed low-frequency mode, a conventional parametric EQ notch at that frequency is the right tool; this
  core targets resonances that move, appear and disappear, and sit above that range.
- The Fast tier (N = 512) removes more at 100 Hz only by also cutting a wider neighbourhood. It is a trade-off, not a
  more accurate detector.
- Do not describe the 100 Hz behaviour as a bug that a tier or a sensitivity setting will fix: sensitivity changes
  what is detected, not how narrow a cut the renderer can make.

## 5. Real-time rules: allocation and threading

- **Allocation.** `prepare()` and `release()` allocate (and free) everything `process()` will ever touch, for every frame
  tier; they run on a non-audio thread. `process()`, `reset()` and `requestTier()` **never allocate, lock, log or throw**,
  including across tier switches. Unit test T4 counts `operator new` on the measuring thread: 0 calls with static parameters,
  with parameters changed before **every** block, and in a cold pass armed from the first block after `prepare()`; T-D0 / T-D
  count `operator new` and `operator delete` over thousands of tier switches (9.2).
- **`numSamples` is not limited to the prepared `maxBlockSize`;** the core consumes any block length by filling hops.
  `maxBlockSize` is accepted for interface symmetry and not used for sizing.
- **Threading.** A `Core` is **not thread-safe** and owns **no thread**. One instance per audio chain. `prepare()`,
  `release()` and the structural setters (`setFrameTier`, `setDetectorTimeConstantMs`, `setFastTimeConstantMs`, `setHopPhaseOffset`,
  `setKeepDetectorStateOnTierSwitch`) belong to a non-audio thread and must not run concurrently with `process()` (they take effect at
  the next `prepare()`). `process()`, `reset()` and the introspection accessors (`bandLevelDb`, `bandReductionDb`, `framesProcessed`, ...)
  belong to the processing thread; the accessors return pointers into state that the next `process()` rewrites. **Any thread:**
  `requestTier()` (one release store), `latencyFor()` / `fftSizeFor()` (pure), `currentLatency()`, `frameTier()`, `tierSwitchCount()` and
  the meters (relaxed atomics); memory orders in 9.2.
- **Parameters** (`Params`) are copied by value into every `process()` call; change them freely between calls
  (unit test P1 changes every one of them before every block, section 8.6). `weightCurve` is a pointer: the array
  (`numBands()` floats) is read during that `process()` call only and must stay valid and unchanged for its duration.
- **Visualization sink** (`setVizSink()`): called synchronously from inside `process()`, once per hop and channel, on
  the processing thread; it must not block, lock, allocate, log or call back into the core (section 8.4). Set or clear it
  between `process()` calls (or while not processing); the core never owns it.
- **Meters** (`lastMaxReductionDb()`) are lock-free relaxed atomics, written once per hop: the only accessor that may be
  read from any thread.
- **`reset()`** clears all signal state (FIFOs, overlap-add, both power averages, baselines, latches, reduction
  smoothers) without touching the allocations; it is real-time safe and equals a freshly prepared instance (test T7).
  After `reset()` the detector re-enters its start-up (bias-corrected) phase.
- **Latency** is `currentLatency()` = N samples of the tier the output is aligned to; report it to the host before audio runs, and
  `latencyFor(sr, t)` when requesting tier t (9.3).

## 6. Running the bench against the core

Build (Release, root `build/`; invoke the `.bat` by absolute path from PowerShell):

```
C:\Users\Krasen\Desktop\XLETH\build.bat engine
```

Unit tests (run through ctest, not directly: the executables need the FFmpeg DLLs on PATH):

```
ctest --test-dir build -C Release -R "test_resonance_core" -V
```

The quality bench is `xleth_rs_quality_bench` (`engine/tools/xleth_rs_quality_bench.cpp`). The core subjects are registered
there: **C1**, **C1c**, **C1s** (G4 companion), the frame-tier subjects **C1c-F / C1c-N / C1c-H** with companions
**C1s-F / C1s-H**. A run writes CSVs, `summary.md` and WAVs under `<out-dir>/<UTC>_<git hash>/`; `bench_out/` and `*.wav`
are not tracked.

```
build\engine\Release\xleth_rs_quality_bench.exe --subjects C1c --no-cpu --out-dir bench_out\mine
```

| option | effect |
|---|---|
| `--subjects ID,ID` | run only these subjects (plus their G4 companion and S3, the G7 CPU reference); metric definitions and thresholds are untouched |
| `--ref-subjects` | add the calibration subjects R0 (pass-through, must fail G1 / G3 / G8) and R1 (oracle, must pass everything) |
| `--no-cpu` / `--quick` | skip the CPU run (G7 reads "n/a") / 8 s signals |
| `--seed N` | shift the noise seeds of every generated signal (default 0 = the original seeds, output unchanged); no gate or metric reads it |
| `--wav label=path` | also run a real file through the default subjects and the gated capability variants: depth-0 null and the real-material proxy table (mean / p95 cut, flicker, fraction of frames with a band cut > 6 dB; informational) |
| `--core-tau MS` / `--core-fast MS` | study runs: slow / fast time constant of the core subjects |
| `--seedset default\|dev\|heldout` | grade every gate once per seed of the set (default = seed 0, dev = 1..6, heldout = 101..106) and write the per-gate / per-cell seeds-passing, worst margin, median value and the **robust verdict** (a gate passes only if it passes on every seed; the G1 waiver applies per seed). The single-seed verdict is unchanged. **Tuning work uses default + dev only; heldout is reserved for the final confirmation by the person grading.** Incompatible with `--seed` (section 7.4) |
| `--cpu-worst` | worst-case per-block CPU of C1c and S3c at blocks 64 / 128 on pink noise with a resonance toggling every 2 s; classifies C1c blocks (no frame / frame / forced baseline refresh) |
| `--cpu-burst` | 8 stereo instances (`--burst-instances`) of C1c-N and S3c back to back per block in one thread, aligned vs staggered hop phases (`--burst-stagger preroll\|core`, `--burst-seconds`); section 7.5 |
| `--d1-reconcile` | the core's applied cut (`bandReductionDb`) next to the bench's -r_off(T) on the 9 T1 signals |

**Gates** (fixed thresholds, constants in the tool; never tune them per subject): G1 / G2 residual and outside deviation at 12
frequencies, G1q / G2q / G1l / G2l shape scans, G3 right-only resonance, G4 jitter, G5 pre-echo, G6 latency, G7 CPU relative
to the RS HQ Normal effect, G8a / G8b onset speed and leak, G9a / G9b the cut is gone after 500 / 1000 ms. The verdict of C1c, C1c-N
and C1c-H reads `PASS (1 waiver)` when everything except the waived G1 cell at 100 Hz passes (see section 4 and 7.1: it does not on every
noise realisation); any other subject reads `PASS` or `FAIL`. The raw G1 count stays in the gate table and the first CSV columns
(`g1`, `overall` are raw; `verdict` carries the waived verdict).

**Reading the unit test D1 against the bench.** `test_resonance_core` D1 measures the time for the **max-band applied
reduction** within f0 +- 1/6 octave to fall to <= 1 dB, stamped at the **decision time**. The bench's G9a measures the **energy
of the aligned output** in that window, N / 2 later on its time axis. They are different quantities and are expected to differ
by 0.1 - 0.5 dB at 500 ms (section 7).

## 7. Measured margins

Measured on the bench's synthetic signals, C1c (depth 1, Hard, defaults), Normal tier, 48 kHz, Release build. A pass of a gate
on the default noise is one noise realisation; section 7.1 repeats the run on six more.

### 7.1 Seed robustness (`--seed 1..6`, full-length signals)

C1c, gate by gate over the six seeds. "Worst margin" is the distance of the worst seed / case from the unchanged threshold.

| gate | seeds fully passing (of 6) | worst margin over the seeds |
|---|---:|---|
| G1 residual, 12 f0 (raw) | 0 (11/12 on one seed, 10/12 on five) | **150 Hz fails on 5 of 6 seeds**: residual +1.97 .. +2.27 dB against a 2.07 dB limit (worst -0.20 dB; the default noise gives +1.94, a pass by 0.13 dB). 100 Hz (waived) +3.12 .. +3.56 dB against 2.10. Every other f0 passes with at least +0.87 dB (330 Hz) on the upper side and +1.44 dB on the over-suppression floor |
| G2 outside deviation | 6 | 0.096 dB against 0.5 |
| G4 jitter (on C1s) | 6 | std 0.162 dB against 0.6; isolated cells 3.6e-5 against 1e-3 |
| G5 pre-echo (D2) | 6 | broadband -1.54 dB, band -2.91 dB against +1.0 |
| G8a onset t50 | **1** (6/6 cases on one seed, 4/6 - 5/6 on the other five) | **500 Hz only**: t50 61 - 144 ms over the seeds and the D = 300 / 1000 cases (worst 144 ms, limit 100); 2500 and 8000 Hz are always 29 - 45 ms. The 62 Hz-wide bell at 500 Hz is narrower than one bin, so the onset time depends on the noise. The default noise passes with 96.0 ms in the worst case |
| G8b leak | 6 | 0.336 against 0.5 (D = 300), 0.147 against 0.3 (D = 1000) |
| G9a release at 500 ms | 6 | worst \|r_off(500)\| 0.94 dB against 1.0 (the default noise gives 0.95: the margin is about 5 % on every realisation) |
| G9b release at 1000 ms | 6 | worst \|r_off(1000)\| 0.11 dB against 0.5 |

Also 6 / 6 on every seed: G1q, G2q, G1l, G2l, G3, G6. The calibration subjects behave as designed on every seed (the
oracle R1 passes everything, the pass-through R0 fails G1 / G3 / G8).

What this means for the verdict: the `PASS (1 waiver)` of the default run holds on the default noise and on one of the six
other seeds. On the other five it is a fail, for two reasons that are not covered by the waiver: **150 Hz in G1** (the same
sub-bin resolution limit as 100 Hz, just below the threshold on average) and **500 Hz in G8a** (the same limit seen
through the onset time). Both are noise-limited, not detector bugs, and are recorded rather than fixed.

For comparison, the RS HQ Normal effect at its capability setting (S3c) fails G1 at 8 of 12 f0 (4/12 on every seed), G2, G9a and
G9b on every seed, and has G4 jitter at 0.599 dB against 0.6.

### 7.2 Unit test D1 against the bench

The two measure different quantities on different signals; read on the same signals, at the same time and as the same quantity, they agree.

- **D1** (`test_resonance_core`): +12 dB / Q 8 bell, **1.2 s on / 2.5 s off**, 6 events, pink noise seed 71, C1c settings. It reads
  the applied band reduction (`bandReductionDb`) as the **maximum over the band-grid bands within f0 +- 1/6 octave of channel 0**,
  averages the events, and takes the first frame at which that is <= 1.0 dB, **time-stamped at the decision** (the input seen
  up to that hop). Result at 48 kHz: steady cut 8.00 / 9.32 dB, release to <= 1 dB **592 / 523 ms** at 500 / 2500 Hz.
- **Bench G9a / G9b** read `r_off(T)`: the energy of the latency-aligned **output** in f0 +- 1/6 octave (STFT 1024 Hann, +- 10 ms
  interval, event mean) relative to the clean reference, T ms after the offset.

On the 9 T1 signals (D = 100 / 300 / 1000 ms) the same C1c run gives, in dB, at T = 500 ms: bench 0.42 - 0.95; D1's max-band
measure at the decision time 0.55 - 1.47; the same measure read N / 2 = 10.67 ms later (the frame whose output window is centred
on the aligned time T) 0.52 - 1.39; and the energy-domain mean of the gain the core applies over the bench's bins in that window,
at that time, **0.57 - 1.10**. At 2500 and 8000 Hz that last figure equals the bench value to within 0.03 dB at T = 500 and 1000 ms
and within 0.10 dB at T = 100 and 250 ms (e.g. 2500 Hz / D 1000: 0.93 against 0.94 at T = 500, 5.13 against 5.04 at T = 100). At 500 Hz
it is higher than the bench by 0.08 - 0.15 dB at T = 500 ms and by up to 0.8 dB at T = 100 ms: that bell (62 Hz) is only 2 - 3 STFT bins
wide and the renderer's kernel smooths a notch that narrow, which is consistent with the difference but was not isolated.

The 523 - 661 ms of D1 and the "r_off(500) <= 0.95 dB" of the bench therefore do not contradict each other:

1. **Different quantity.** The maximum band is deeper than the in-window energy mean (about 0.25 dB at T = 500 ms, 1.17 against 0.93).
2. **Time stamp.** The decision time leads the aligned output by N / 2 = 10.7 ms (about 0.06 dB at T = 500 ms).
3. **Shallow slope.** Near 1 dB the cut falls about 0.005 dB per ms (200 ms release), so 0.2 dB is 40 ms: the time to reach 1 dB is a
   noisy statistic. The same definition on D1's signal and on the T1 signal (D = 1000 ms) gives 523 and 602 ms at 2500 Hz.
4. D1's bell is on for 1.2 s and its steady cut (9.32 dB) is a little deeper than the cut at the end of the T1 D = 1000 case (8.83 dB).

Time to <= 1 dB on the T1 signals, ms, D = 1000 (D1 definition / like-for-like window at the aligned time / bench):
500 Hz 580 / 519 / 473, 2500 Hz 602 / 481 / 489, 8000 Hz 513 / 433 / 434. D1's 700 ms bound is a regression guard on the
max-band measure, not the G9a criterion.

### 7.3 Worst-case CPU (`--cpu-worst`)

48 kHz stereo, 60 s of pink noise (-20 dBFS) per repetition, five fresh instances pooled, first second untimed; 221 250 timed blocks
at 64 samples and 110 625 at 128. Budget = block / sample rate (1333 us at 64, 2667 us at 128). Two signals: the +12 dB / Q 8 bell at
2500 Hz toggled every 2 s (5 ms crossfades), and a broadband +-12 dB level step every 2 s, which forces the baseline refresh at every
toggle. 13th Gen i7-13700KF, single thread, normal priority, no isolation from other processes.

| signal | subject | block | mean us | p95 | p99 | p99.9 | max | max % of budget |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| bell toggle | C1c | 64 | 18.0 | 71.5 | 81.0 | 106.7 | 338.9 | 25.4 |
| bell toggle | S3c | 64 | 22.0 | 75.0 | 83.7 | 110.8 | 283.6 | 21.3 |
| bell toggle | C1c | 128 | 35.8 | 72.5 | 84.8 | 124.9 | 236.3 | 8.9 |
| bell toggle | S3c | 128 | 41.7 | 77.9 | 90.7 | 129.8 | 252.5 | 9.5 |
| level step | C1c | 64 | 18.4 | 73.1 | 84.3 | 106.7 | 254.8 | 19.1 |
| level step | S3c | 64 | 21.8 | 74.6 | 82.8 | 107.9 | 224.6 | 16.9 |
| level step | C1c | 128 | 36.6 | 76.5 | 87.3 | 124.6 | 211.6 | 7.9 |
| level step | S3c | 128 | 41.5 | 77.6 | 90.0 | 134.1 | 214.3 | 8.0 |

No run exceeds 50 % of the budget at 64 samples (largest 25.4 %); mean load is 1.3 - 1.4 % of real time for C1c, 1.6 % for S3c.

Where the time goes in C1c (blocks classified from the introspection accessors, bell toggle, block 64): 75 % of the blocks complete no hop and
cost 0.03 us; the 25 % that complete a hop cost 71.8 us on average (5.4 % of the 64-sample budget) because **all of the FFT, detector and gain work
of a hop lands in the block that completes it**. A forced full baseline refresh is not the cause of the highest peaks: with the level step
(1 800 forced slow and 1 380 forced fast refreshes) a frame with a forced slow refresh costs 81.6 us, a forced fast refresh 80.0 us, both 90.7 us, against
72.8 us for a regular frame (+12 % / +10 % / +25 %), and the slowest forced frame was 211 us. The highest peaks (255 - 339 us, 3.5 - 4.7 times the
mean frame cost) are **ordinary frame blocks at random times** (not near a toggle), S3c shows the same, and the same C1c run gave a 243 us maximum on
a repetition of the measurement and 339 us on the next: that is the scheduling and cache noise of a desktop measured with a wall clock, not a
property of the algorithm. The bench cannot separate the two further without an isolated core.

### 7.4 Seed protocol and tier study (`--seedset`)

A single noise realisation can flatter a design that was tuned on it (7.1: the core was tuned on the default seed and fails G1 at 150 Hz and G8a at 500 Hz on most others).
`--seedset` grades **every** gate once per seed of a set and reports, per gate and per cell, the seeds passing, the worst margin (value against the unchanged limit, positive =
headroom) and the median value over the seeds. A gate counts as passed in the **robust verdict** only if it passes on every seed of the set; the named G1 waiver at 100 Hz applies per seed
exactly as in the single-seed verdict (it is used only on the seeds where that cell actually fails). No threshold and no metric definition changed; the single-seed verdict and the default
seed's output are bit-identical to before (a default run was compared file by file with the previous build).

| set | seeds | use |
|---|---|---|
| `default` | 0 (the original signals) | the historical single-seed run |
| `dev` | 1 .. 6 | tuning and every study |
| `heldout` | 101 .. 106 | **reserved**: implemented, not run during tuning; run only for the final confirmation by the person grading |

**Tuning work uses default + dev only.** No held-out result exists in this document or in any tuning note.

Tier study, dev seeds 1..6, subjects C1c-F (N 512), C1c-N (1024), C1c-H (2048), S3c (RS HQ Normal, capability) and the calibration subjects, CPU run included (G7). Robust verdict:

| subject | seeds with a non-FAIL single-seed verdict | robust verdict | gates not passed on every seed (seeds passing) |
|---|---:|---|---|
| C1c-F | 1/6 | FAIL | G3 (5/6), G8a (1/6), G9a (4/6) |
| C1c-N | 1/6 | FAIL | G1 (1/6, waiver applied), G8a (1/6) |
| C1c-H | 1/6 | FAIL | G8a (1/6) |
| S3c | 0/6 | FAIL | G1, G2, G1q, G2q, G2l, G3, G7, G9a, G9b (all 0/6) |
| R0 (pass-through) | 0/6 | FAIL (as designed) | G1, G1q, G1l, G3, G8a, G8b |
| R1 (oracle) | 6/6 | PASS (as designed) | none |

The cells the study asks about (seeds passing of 6, worst margin, median value over the seeds; dB except G8a in ms):

| tier | G1 150 Hz (limit +2.07) | G1 220 Hz (limit +2.05) | G8a 500 Hz, D 300 / D 1000 (limit 100 ms) | G9a (limit 1.0 dB) | G5 broadband (limit +1.0) | G4 std (limit 0.6) | G3 |
|---|---|---|---|---|---|---|---|
| C1c-F | 6/6, worst +0.79 (margin +1.28), median +0.64 | 6/6, +1.27 (+0.78), +1.09 | 3/6 + 3/6, worst 109 / 144 ms, median 100 / 97 | **4/6**, worst 1.067 (500 Hz, D 1000; margin -0.07), median 0.94 | 6/6, worst -2.03 (margin +3.03), median -2.11 | 6/6, 0.246 (median 0.242) | **5/6**, L 100 Hz in-window -1.013 vs -1.0 |
| C1c-N | **1/6**, worst +2.270 (margin -0.20), median +2.23 | 6/6, +1.05 (+1.00), +0.98 | 3/6 + 3/6, worst 112 / 144 ms, median 100 / 97 | 6/6, worst 0.944 (2500 Hz, D 300; margin +0.056), median 0.87 | 6/6, -1.54 (+2.54), -1.58 | 6/6, 0.162 (0.154) | 6/6 |
| C1c-H | 6/6, +1.90 (+0.18), +1.78 | 6/6, +0.83 (+1.22), +0.72 | 3/6 + 3/6, worst 147 / 141 ms, median 101 / 99 | 6/6, worst 0.880 (margin +0.12), median 0.84 | 6/6, -0.59 (+1.59), -0.66 | 6/6, 0.155 (0.152) | 6/6 |
| S3c | 0/6, -7.19 (over-suppresses), median -7.10 | 0/6, -4.61, -4.50 | 6/6, 0 ms | 0/6, worst 3.05, median 2.53 | 6/6, +0.11 (+0.89), +0.03 | 6/6, 0.599 (0.593) | 0/6 |

Reading it: **no tier passes every gate on every seed.** The 500 Hz onset (G8a) fails on 5 of 6 seeds at every tier by a similar amount (worst 141 - 147 ms; each tier passes the D = 300 and the D = 1000 cell on 3 of 6 seeds): the 62 Hz-wide bell at 500 Hz is
narrower than one analysis bin at all three frame sizes, so the onset time depends on the noise (7.1). The tier decides the rest. **High** passes everything else on every seed (G1 under the 100 Hz waiver; its 150 Hz margin is thin, +0.18 dB, and
G9a +0.12 dB). **Normal** adds G1 at 150 Hz (fails on 5 of 6 seeds, worst +0.20 dB over the limit; 220 Hz passes everywhere); its G9a margin is +0.056 dB. **Fast** passes G1 on every seed but loses G9a on 2 of 6 seeds (500 Hz / D 1000, by up to 0.067 dB)
and G3 on 1 of 6 (the untouched left channel is over-suppressed at 100 Hz, -1.013 dB against -1.0). Every other gate passes on every seed at every tier (G2, G1q / G2q, G1l / G2l, G4, G5, G6, G7, G8b, G9b). S3c fails G1 / G2 / G3 on every seed (it over-suppresses), G9 and G7
(cost ratio against the default HQ Normal effect S3: median 1.008, worst 1.032); the C1c tiers pass G7 on every seed (worst ratio 0.88 / 0.82 / 0.86 for F / N / H at block 128). Everything here is deterministic to the last digit except the G7 ratios (wall-clock).

Check on the tool itself: a seed-set run grades several seeds in ONE process, so every cache must be keyed by the seed. The clean-reference Welch PSD cache was not (it graded seeds 2.. against seed 1's clean noise; found by comparing a seed-set seed with a standalone `--seed`, 2.136 against 2.236 dB at C1c-N / 150 Hz) and is now. With the fix a seed inside a
seed set and the same standalone `--seed N` run give identical files (checked for N = 2 and 6, every non-CPU CSV of the six subjects).

### 7.5 Multi-instance bursts (`--cpu-burst`)

All the FFT, detector and gain work of a hop lands in the block that completes it (about 72 us, 5.4 % of a 64-sample budget, 7.3). With n instances in one thread whose hop boundaries coincide, one block
carries n times that. Measured: 8 stereo C1c-N instances back to back per block, each on its own pink noise (-20 dBFS), 3 x 60 s per case (aligned and staggered repetitions interleaved, fresh instances each,
first second untimed, copy-in excluded), 48 kHz, Release, 13th Gen i7-13700KF, one thread at normal priority; per-block TOTAL time of the 8 instances against the budget of one block
(1333 us at 64, 2667 us at 128). Staggered = instance i is prepared with `setHopPhaseOffset(i x 256 / 8)` (S3c, which has no such option, is staggered by feeding the instance i x 256 / 8 samples first).
132 954 blocks per case at 64, 66 477 at 128.

| subject | block | hop phases | mean us | p99 us | p99.9 us | max us | max % of budget | blocks > 25 % budget |
|---|---:|---|---:|---:|---:|---:|---:|---:|
| C1c-N | 64 | aligned | 143.5 | 631.0 | 733.5 | 1806.6 | 135.5 | 33 240 (25 % of blocks) |
| C1c-N | 64 | staggered | 143.6 | 188.6 | 256.4 | 483.5 | 36.3 | 5 |
| C1c-N | 128 | aligned | 287.2 | 662.8 | 754.5 | 1026.5 | 38.5 | 601 |
| C1c-N | 128 | staggered | 287.6 | 368.5 | 474.0 | 3350.3 | 125.6 | 4 |
| S3c | 64 | aligned | 177.6 | 673.7 | 853.8 | 1443.9 | 108.3 | 33 240 |
| S3c | 64 | staggered | 177.4 | 244.0 | 320.1 | 433.2 | 32.5 | 62 |
| S3c | 128 | aligned | 336.0 | 720.3 | 1105.9 | 1466.9 | 55.0 | 2 107 |
| S3c | 128 | staggered | 335.8 | 433.5 | 590.5 | 675.2 | 25.3 | 1 |

What it shows. The mean is identical (10.8 % of the budget at either block size, 8 instances x 1.35 %): staggering moves work, it does not remove it. In the aligned case the hop block carries all 8 frames (read from `framesProcessed()`:
25 % of the 64-sample blocks complete 8 hops, mean 573.5 us = 43 % of the budget; at 128 every second block, 50 %), the other blocks cost 0.2 us. Staggered, every block completes 2 hops at 64 samples and 4 at 128 (a hop is 4 blocks of 64 or 2 of 128),
mean 144 / 288 us. The stable statistics are the percentiles: p99 falls 3.3x at 64 (631 -> 189 us) and 1.8x at 128 (663 -> 369 us), p99.9 2.9x / 1.6x. The **max** column is one scheduling outlier of the desktop, not a property of the algorithm: the per-repetition
maxima of the same case range 970 - 1807 us (aligned) against 321 - 484 us (staggered) at 64, and the staggered 128 case has one 3350 us block while its quietest repetition peaks at 560 us (an earlier run with the bench-only pre-roll stagger gave 1892 / 1443 us at 64 and 6263 / 549 us
at 128, aligned / staggered); it must not be read as the cost of a frame. What does not depend on the outliers: an aligned 8-instance burst costs about 574 us (43 % of a 64-sample budget) by construction, a staggered one about 144 us (11 %).

Decision: aligned worst blocks are 3.3x (p99) above the staggered ones at 64 samples, so the offset was added (a prepare-time integer, default 0, no change to any output). Whoever hosts several instances in one thread should
pass `i x hop / n` to `setHopPhaseOffset()` for instance i of n, or, when n is not known in advance, `Core::hopPhaseOffsetForInstance(i, hop)` (section 8.7).

Not addressed: the baseline-refresh slice is `band + frames_ % period` (`bandLevelsAndBaseline`) and every instance counts frames from 0, so two instances that complete a hop in the same block (2 at 64 samples) also refresh the same band slice in that block.
A per-instance slice rotation would spread that too; it was not tried (staggered p99.9 is 256 us = 19 % of the 64-sample budget for 8 instances).

## 8. Resonance Suppressor integration surface

What the standalone Resonance Suppressor's High Quality mode needs from the core, and how the effect should use it. Every addition
has a default that leaves the output bit-identical to the core before it (unit tests W1, S2, V2; the bench comparison in 8.10).
The core is still unwired; nothing here changes the effect. Unit tests W0-W4, S1-S2, M1-M4, V1-V4, E1, P1, H1-H3 in
`test_resonance_core` (numbers below are from that run, 48 kHz, Normal tier).

### 8.1 Band grid and weight curve

- **Grid.** `numBands()` = 96 (`kGridBands`), `bandCentreHz(i)` = the centres, uniform on the ERB-rate axis from 20 Hz to
  min(0.45 fs, 20 kHz) (19 845 Hz at 44.1 kHz, 20 kHz at 48 / 96 kHz; test W0). The grid depends on the sample rate only, not
  on the frame tier, so a curve built for a rate is valid at every tier. Valid after `prepare()`.
- **`Params::weightCurve`**: nullptr (default) = flat 1, the historical behaviour (the loop is skipped). Otherwise `numBands()`
  floats; each is clamped to [0, `kMaxWeight` = 2.5], NaN and negative values read as 0. With R = the band's applied reduction
  after attack / release, sharpness and the stereo link, and Rmax = depth x 12 dB (Soft) / x 24 dB (Hard):

  | weight w | applied reduction |
  |---|---|
  | w <= 1 | w x R (0 = the band is never cut) |
  | w > 1 | min(w x R, max(Rmax, R)) (deeper, up to the depth ceiling; never below R, which may exceed a just-lowered ceiling while it releases) |

  This is the RS weighting (`targetDb = clamp(reduction(salience) x weight, 0, maxReductionDb)`, per bin): a weight scales the cut
  of what was detected; it never creates a detection (test W4: a flat 2.5 on plain pink noise gives a mean band cut of 0.001 dB).
- **Why it is applied after the smoothers.** For a constant curve it is the same as the RS's "weight the target, then smooth": a
  positive factor commutes with the per-band one-pole (w x target > w x state exactly when target > state) and with the max(L, R)
  of the link; only the clamp at the ceiling sits after the smoothers instead of before them. Applying it last also makes weight 0
  exact: before the cross-band smoothing, the [1 2 1] / 4 and the main-lobe gating would carry a neighbour's cut into a zero-weight band.
- **Resolution.** The RS weights every bin; the core weights 96 bands and builds G(f) by linear interpolation between band centres
  (ERB axis). A zero-weight band is untouched at its centre and everywhere between two zero-weight bands; the transition to a weighted
  neighbour spans one band spacing (about 0.41 ERB: ~55 Hz at 1 kHz, ~12 Hz at 50 Hz).
- **Tests.** W1: a curve of 1.0 everywhere is bit-identical to nullptr. W2: frame by frame against an unweighted twin core (C1, link
  0.5, weights {0, 0.3, 1, 1.7, 2.5, 4 -> 2.5, -1 -> 0, NaN -> 0} repeated over the bands): 0 of 216 000 band values differ from the
  table above; 40 940 deeper than unweighted, 8 556 at the 6 dB ceiling, 15 290 cuts > 1 dB zeroed. W3: weight 0 on the 14 bands within
  +-1/2 octave of a planted 2.5 kHz resonance: the largest cut in those bands over every frame and both channels is exactly 0 dB (the
  unweighted core cuts 9.26 dB at f0), and every weight-1 band equals the unweighted core exactly. W4 (C1, ceiling 6 dB): flat 1 / 1.5 /
  2.5 give a mean cut at f0 of 4.97 / 6.00 / 6.00 dB, never above 6.000 dB.
- **How the effect builds it.** Evaluate its existing `weightingForFrequency(bandCentreHz(i))` for i = 0 .. 95 into a member
  `float[96]` whenever the weighting settings change (the same dirty check it has now), and pass the pointer every block. **The RS
  default curve is not flat** (0 below 40 Hz, a ramp from 40 to 80 Hz, a ramp down from 16 kHz towards Nyquist), so the effect always
  passes its curve; nullptr is not the RS default.

### 8.2 Sharpness

`Params::sharpness` (0..1, default 0.5) sets how narrow the applied cut is, through the cross-band smoothing of the band reduction
curve (after attack / release, before the link and the weight curve):

| sharpness s | kernel |
|---|---|
| 0.5 < s <= 1 | [a, 1 - 2a, a] with a = 0.5 (1 - s): 0.25 at 0.5, 0 (no smoothing) at 1 |
| s = 0.5 (default) | [0.25, 0.5, 0.25] = [1 2 1] / 4, exactly the historical expression (a = 0.25f and 1 - 2a = 0.5f are exact in float, so the default computes the very same operations) |
| 0 <= s < 0.5 | the [1 2 1] / 4 result blended towards three further [1 2 1] / 4 passes by t = 2 (0.5 - s); at 0 the kernel is [1 2 1]^4 / 256 (9 bands) |

NaN reads as 0.5, values outside 0..1 clamp (test S2, bit-identical). Detection is not affected: only the reduction curve that comes
out of it. Measured (S1, C1c, Q 8 / +12 dB planted bell, mean cut over 6 s; width = span where the cut is >= 3 dB, crossings
interpolated on log2 f):

| f0 | sharpness 0 | 0.5 (default) | 1 |
|---|---|---|---|
| 1 kHz | 0.492 oct (343 Hz), peak 7.04 dB | 0.424 oct (295 Hz), peak 8.72 dB | 0.395 oct (275 Hz), peak 9.76 dB |
| 2.5 kHz | 0.443 oct (770 Hz), peak 7.41 dB | 0.384 oct (667 Hz), peak 9.31 dB | 0.355 oct (617 Hz), peak 10.71 dB |

Strictly monotonic at both frequencies. Broader smoothing also lowers the peak (the cut is spread, not added), so sharpness 0 is gentler
as well as wider. The narrow end is bounded by the main-lobe gating (1.5): the shoulders of a detected resonance are cut by their own
excess at every sharpness, which is why 1 is only ~7 % narrower than 0.5.

**Not the RS HQ meaning.** In the RS HQ engine "sharpness" changes the detector, not the cut: the centre gap excluded from the
local-mean baseline (1 + round(4 s) bins) and the salience slope (0.055 + 0.085 s); higher = a given peak reads as MORE salient. In the
RS Low Latency engine it is the peak-filter Q (0.8 + 10 s), i.e. a narrowness, which is what the core implements. The core's detector
threshold is statistical (sigma), so the HQ detector-shape side effect has no counterpart.

### 8.3 Channels, and how the effect implements Mid / Side

- `prepare(sr, block, numChannels)` with 1 or 2 channels. `process(channels, n, ...)` processes min(n, prepared) channels; the others are
  untouched. Channels are independent except for `stereoLink` (and the shared frame count / sigma tables, which depend only on time).
  M1: a 1-channel core is bit-identical to channel 0 of a 2-channel core at link 0, and a 2-channel core run with n = 1 is bit-identical
  to the 1-channel core (channel 1 untouched).
- The detector is level-independent (thresholds in sigma, depth relative to the excess), so feeding (L + R) / 2 or (L - R) / 2 instead
  of L or R changes nothing about detection.
- **Recipe** (what the RS HQ path does with its WolaProcessor, `processHighQualityMidMode` / `SideMode`):

  | RS stereo_mode | input | core prepared | what the effect feeds | output |
  |---|---|---|---|---|
  | Stereo | stereo | 2 ch | L, R; `stereoLink = stereo_link / 100` | L', R' |
  | Mid | stereo | 2 ch (or 1) | M = (L + R) / 2 as channel 0, process(n = 1); S as the aux channel (`auxIn`), S_d = `auxOut` (9.2: on the dry timeline through a tier switch) | L' = M' + S_d, R' = M' - S_d |
  | Side | stereo | 2 ch (or 1) | S = (L - R) / 2 as channel 0, process(n = 1); M as the aux channel, M_d = `auxOut` | L' = M_d + S', R' = M_d - S' |
  | Stereo / Mid | mono | 1 ch | the channel | as is |
  | Side | mono | 1 ch | nothing to process (the RS feeds zeros to keep its state warm and outputs the delayed dry) | delayed dry |

  Call `reset()` on every stereo_mode change (as the RS does): channel 0's detector state belongs to whatever was fed before.
  `stereoLink` has no effect with one channel. An "M + S" mode (both components processed independently) is the two components as the
  two channels with link 0 (M4: bit-identical to two 1-channel cores).
- Tests. M2: both wrappers reconstruct the latency-aligned input at depth 0 (Mid -159.4 dBFS RMS, Side -165.1 dBFS, max |diff|
  8.9e-8). M3 (C1c; M carries a 1.5 kHz resonance, S a 4 kHz one): Mid mode cuts 9.27 dB at 1.5 kHz and 0.000 dB at 4 kHz; Side mode
  9.26 dB at 4 kHz and 0.000 dB at 1.5 kHz.

### 8.4 Visualization tap

`setVizSink(VizSink*)`; nullptr (default) = off, costing one pointer test per hop. With a sink set, after the gains of a frame are
final (after the weight curve, i.e. exactly what G(f) is built from), the core fills its member `VizFrame` once per processed channel
(channel 0, then 1) and calls `sink->onResonanceFrame(frame)` synchronously, on the processing thread, inside `process()`. The frame is
valid only during the call; the sink copies what it needs and must not block, lock, allocate, log or call back into the core. No
allocation, no lock, no logging in the core (V3: zero `operator new` with a sink, cold pass, parameters swept every block).

Frame layout (POD, trivially copyable, 1 176 bytes, 8-byte aligned; static_asserts in the unit test):

| offset | field | type | meaning |
|---:|---|---|---|
| 0 | `hopIndex` | int64 | 0-based frame index (== `framesProcessed()` before the frame); both channels of a hop share it. The frame's input ends `hopSize x (hopIndex + 1) - hopPhaseOffset()` samples into the stream |
| 8 | `channel` | int32 | 0 or 1 (Mid / Side: whatever the caller fed as that channel) |
| 12 | `numBands` | int32 | `numBands()` (96) |
| 16 | `hopSize` | int32 | samples per hop |
| 20 | `maxReductionDb` | float | max of `reductionDb` (== `lastMaxReductionDb(channel)`) |
| 24 | `levelDb[96]` | float | the detector's input level per band: the 40 ms fast estimate (the 200 ms slow one when the fast path is off), dB, per-octave units (pink noise is flat). **Not dBFS**: a constant offset that depends on N separates it from any calibrated scale; differences are exact dB |
| 408 | `baselineDb[96]` | float | that estimate's flank baseline (levelDb - baselineDb = the excess the detector thresholds) |
| 792 | `reductionDb[96]` | float | the applied reduction, dB >= 0, after every stage |

Rate: one frame per hop per channel, `sr / hop` per second (187.5 at 48 kHz Normal; 375 Fast, 93.75 High). V1 (2 s stereo, block 100):
750 frames per channel == `framesProcessed()`, hop indices consecutive, channels in order, every array equal to the core's own
`bandFastLevelDb` / `bandFastBaselineDb` / `bandReductionDb` at that moment; mono: 750 frames on channel 0 only. V2: the output with a
sink is bit-identical to the output without. V4 (cost, 3 s stereo at block 64, 9 interleaved repetitions): null / no-op-sink paired time
ratio median 1.005, the no-op sink's own overhead -0.5 % (inside the noise). Against the build before this change the null-sink path is
the whole bench (8.10).

**How the effect fills its `ResonanceBucket`** (128 log-frequency buckets per channel per hop): precompute (outside the audio thread) a
bucket -> band interpolation on log f (96 bands < 128 buckets, so interpolate rather than max-pool, or some buckets stay empty);
`spectrum` = (levelDb + a display offset the effect calibrates once + 120) / 120 clamped to 0..1; `reduction` = reductionDb / 24;
`weighting` from its own curve; `activity` = mean of the 12 largest band reductions / 24; `sampleClock` = hopIndex x hop (+ the hop phase
offset if used), `bucketSamples` = hop; `sampleRate`, `fftSize`, `qualityIndex`, `stereoMode`, `maxReductionDb` (the ceiling) from what it
already knows. Push into its existing `DynamicsVizCollector` from inside the sink (the collector's `push` is the effect's existing
audio-thread call). The display changes character: the RS showed the instantaneous per-bin magnitude of one frame (white noise flat);
`levelDb` is the 40 ms average in per-octave units (pink flat, smoother).

### 8.5 Meters

`lastMaxReductionDb(channel)`: the largest applied band reduction (dB) of the last completed frame, after every stage (exactly the
maximum of `bandReductionDb(channel)` / `VizFrame::reductionDb`). Channel 0 / 1 per channel; -1 (default) the maximum over the channels
that frame processed (a channel that was not processed reads 0). Written once per hop with relaxed atomic stores (lock-free,
`std::atomic<float>::is_always_lock_free` is asserted); readable from any thread; 0 after `prepare()` / `reset()`. E1: equal to the band
maximum per channel and combined after every hop of a 4 s run, 0 at start and after reset, channel 1 reads 0 on a mono run. The RS's meter
value 2 ("gain reduction activity": the top-12 average / 24 with a ballistic) is the effect's to derive (from the meter or the viz frame).

### 8.6 Parameter changes

What the core smooths, and what the caller provides:

| parameter | where it acts | time behaviour |
|---|---|---|
| `depth`, `sensitivity`, `hardKnee` | the target reduction (threshold, knee, ceiling) | through the per-band attack / release: a change glides at `attackMs` / `releaseMs` |
| `attackMs`, `releaseMs` | the one-pole coefficients | the next frame |
| `sharpness`, `stereoLink`, `weightCurve` | after the attack / release smoothers | a step at the next frame |

Every parameter is read once per frame, from the `process()` call that completes the hop; a value that does not reach a frame boundary is
never seen. Every change of the gain curve is a change between two frames, and every output sample is the sum of N / H = 4 overlapping
frames, each shaped by the sqrt-Hann synthesis window (zero at both ends): a step in G(f) between frames becomes a crossfade over the
window, never a sample discontinuity. P1 checks it: stereo, 6 s, pink -26 dBFS with a planted +12 dB / Q 8 bell at 1.2 kHz, a 2.5 kHz tone
(0.08) in both channels and a 700 Hz tone (0.05) in R; before EVERY block, depth, sensitivity, sharpness and stereoLink each jump to a random
extreme (0 or 1) and weightCurve to nullptr / all 0 / all 2.5 (Hard). Bound: the largest sample step |y[n] - y[n-1]| and second difference of the
stressed output (after latency + 0.5 s) <= 1.25 x the largest of four steady runs (all-low, all-high, C1c, all-high flat).

| block | max step | steady | ratio | max 2nd diff | steady | ratio | non-finite | allocations |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 64 | 0.1015 | 0.1049 | 0.968 | 0.1309 | 0.1328 | 0.986 | 0 | 0 |
| 100 | 0.0972 | 0.1049 | 0.927 | 0.1304 | 0.1328 | 0.982 | 0 | 0 |

So no internal smoothing was added (none was needed, and the steady state is untouched). The caller does not have to smooth anything for
click safety; the RS's existing parameter smoothers (20 ms) may stay for slower glides (a weight node dragged by the user changes the curve at the
hop rate otherwise). Every float field is sanitised by the core at intake (9.6): non-finite -> default, then clamped; non-finite weights read as 1.

### 8.7 Instance hop phases

`static int Core::hopPhaseOffsetForInstance(int instanceIndex, int hop)`: the base-2 van der Corput sequence (bit reversal of the index around
the binary point) times the hop, floored: 0, hop/2, hop/4, 3 hop/4, hop/8, 5 hop/8, 3 hop/8, 7 hop/8, hop/16, ... Every prefix of n instances is
as evenly spread as a dyadic grid allows, so instances can be added later without re-spacing the existing ones (the offset is structural: it
takes effect at `prepare()`). 0 for an index <= 0 or a hop <= 1; always in [0, hop). H1: {0, 128, 64, 192, 32, 160, 96, 224} at hop 256, doubled at
512. H2: indices 0 .. 255 at hop 256 are a permutation of 0 .. 255. H3: 8 real instances (48 kHz, Normal, hop 256) with these offsets, 64-sample
blocks: every block completes exactly 2 frames over the 8 instances (1 500 of 1 500 blocks; never more than 2); the all-zero control completes 8 frames
in every 4th block (375 blocks) and 0 in the others.

### 8.8 RS parameter mapping (the effect's job)

| RS parameter | core |
|---|---|
| `depth` (0..100 %, 50) | `depth = depth / 100` (same ceilings: 12 dB Soft, 24 dB Hard) |
| `selectivity` (0..100 %, 50) | `sensitivity = 1 - selectivity / 100` (RS: higher selectivity = higher threshold; core: higher sensitivity = lower threshold). The RS threshold is 2 + 14 x sel dB over a single-frame local mean, the core's 6 - 4 x sens sigma of a calibrated excess: same direction and the same midpoint, not the same numbers |
| `sharpness` (0..100 %, 50) | `sharpness = sharpness / 100` (8.2: narrowness of the cut, the LL meaning) |
| `mode` Soft / Hard | `hardKnee` |
| `attack` (1..200 ms), `release` (10..2000 ms) | `attackMs`, `releaseMs` (same coefficient formula, 1 - exp(-hop / tau)) |
| `stereo_link` (0..100 %, **100**) | `stereoLink = stereo_link / 100` (the core's default is 0) |
| weighting (`wc_hp`, `wc_lp`, `wc_b1..8_*`) | `weightCurve` = `weightingForFrequency(bandCentreHz(i))`, always passed (8.1) |
| `stereo_mode` | 8.3 |
| `quality` Fast / Normal / High | `setFrameTier()` before `prepare()`; while playing `requestTier()` + `setLatencySamples(Core::latencyFor(sr, t))`, never a reprepare (9.3) |
| `mix`, `trim`, `delta`, bypass, `processing_mode` (the LL engine) | stay in the effect; the dry they mix against is the core's `dryOut` (and `auxOut` for Mid / Side), not an own delay line (9.2, 9.3) |
| viz overlay, meters | 8.4, 8.5 |

### 8.9 What the core still cannot do for the RS

- ~~Live frame-tier switching~~: done (section 9).
- **The RS HQ detector semantics** of selectivity and sharpness (dB above a raw local mean, centre gap, salience slope): the core's detector is
  statistical; presets will not sound the same. Only direction and midpoint correspond (8.8).
- **Per-bin weighting**: the weight is sampled at the 96 band centres (8.1); weighting features narrower than a band spacing (below ~100 Hz the
  spacing is a third of an octave or more) are smoothed.
- **Viz**: no instantaneous per-bin spectrum; `levelDb` is uncalibrated (a constant display offset is the effect's) and on 96 bands, not 128 buckets.
- **RS meter "activity" and detector activity** (`blockDetectorActivity_`): not computed by the core (the `regionOutput()` hook is still a stub); the effect
  derives what it shows from `lastMaxReductionDb()` or the viz frames.
- ~~NaN in depth / sensitivity / link / attack / release~~: sanitised at intake (9.6).
- **Sub-frame parameter timing**: parameters apply per hop (5.3 ms at 48 kHz Normal), from the block that completes it.
- Out of scope here and unchanged: the named G1 waiver at 100 Hz and the seed-dependent G1 150 Hz / G8a 500 Hz shortfalls (7.1, 7.4).

### 8.10 Defaults are bit-identical (how it was checked)

- **Unit tests.** The 73 checks that existed before print byte-identical text (every measured number) from the old and the new
  `test_resonance_core` binary; the new build passes 101 / 0. W1 (curve of 1.0 == nullptr), S2 (sharpness clamping), V2 (sink == no sink) are bit-exact.
- **Bench.** The pre-change bench binary was frozen as a copy, the new one built, and both run with `--subjects C1,C1c,C1c-F,C1c-N,C1c-H,S3c,R0,R1
  --ref-subjects --no-cpu` (CPU off so that every file is deterministic), on the default seed and on `--seedset dev`. Every non-CPU file was compared byte by
  byte: default seed 89 files (20 CSV, 68 WAV, summary.md), dev 540 files (125 CSV, 408 WAV, 7 summaries): all identical except the run-directory names
  embedded in the summaries and in `seedset_per_seed.csv` (output folder and timestamp). Gate counts are therefore unchanged; C1c-N, default seed:
  `PASS (1 waiver)` (G1 11/12 raw + the 100 Hz waiver, every other gate passes, G7 n/a); dev seeds: robust FAIL, 1/6 seeds passing, G1 1/6 (150 Hz worst
  +2.270 against +2.074) and G8a 1/6 (500 Hz / D 1000 worst 144 ms), every other gate 6/6 - before and after alike.
- **Cost of the defaults (null sink, nullptr curve, sharpness 0.5).** `--cpu-only --subjects C1`, old and new binary alternated twice (pre, post, pre, post),
  mean per-block time of C1 (48 kHz stereo): block 64: 17.59 / 17.87 us before, 17.75 / 17.62 us after; block 128: 35.32 / 35.88 before, 35.39 / 35.29 after;
  block 512: 142.5 / 142.8 before, 142.0 / 140.8 after. Within the run-to-run spread (about 1 %); the extra per-hop work of the defaults is the meter's
  max over 96 bands per channel and one pointer test.

## 9. Live frame-tier switching, aligned dry, parameter hardening

The core can change its frame tier (Fast 512 / Normal 1024 / High 2048 at <= 50 kHz) while it processes, from any thread, without
allocating, locking or reprepare. This is the core-side fix for audit finding RT3 (`docs/RESONANCE_SUPPRESSOR_AUDIT.md` 2.5: the RS
re-prepares its `WolaProcessor` on the message thread while the audio thread may be inside `processBlock`). Fixed-tier output is
bit-identical to the core before this change (9.8). The core is still not wired into any effect. Unit tests T-A, T-B, T-C, T-D0, T-D,
T-E, T-H, T-M in `test_resonance_core` (numbers below are from that run, 48 kHz).

### 9.1 Structure: everything is built in `prepare()`

`prepare()` builds one complete **engine per tier**: its `juce::dsp::FFT` object, analysis and synthesis windows, band <- bin weights,
flank lists, main-lobe zones, bin -> band map, statistics tables, sigma arrays, and per channel the overlap-add accumulator, output FIFO,
FFT buffer, bin gains, both power averages and every per-band state array. It also allocates one **input ring** per channel (and one
for the aux channel, 9.3), a power of two >= 2 x the largest N at that rate (4096 at 48 kHz). The ring is every engine's analysis FIFO:
a frame that ends at stream position e reads `ring[e - N, e)`, so an engine that starts mid-stream already has its history. Scratch is
sized for the largest tier. After `prepare()` a tier change only changes which preallocated engine is read: it allocates, frees and
constructs nothing (T-D0 and T-D count `operator new` and `operator delete`: 0).

The band grid, and with it every per-band array (`Params::weightCurve`, the viz frame, the meters), does not depend on the tier; the
power averages and everything indexed by bin do. Each engine's frame grid is (e + offset) % H == 0 on one stream clock (input samples
since `prepare()` / `reset()`).

Fixed-tier code path: `process()` writes each block into the ring (in place of the old per-engine input FIFO), hands out the finished
output, and runs a frame when the hop completes, exactly as before. The analysis multiplies the same samples by the same window (read
from the ring in at most two segments), so every output sample is bit-identical.

### 9.2 The transition contract

**What the core guarantees**

1. **Request.** `requestTier(t)` may be called from any thread at any time (also before `prepare()` and while `process()` runs). It is
   one atomic store. The last request before the audio thread looks wins; earlier ones are overwritten, never queued.
2. **Adoption.** At the start of a `process()` call in which no transition is running, the core takes the pending request (one atomic
   exchange). A request for the tier already in use is consumed and ignored. A request made during a transition stays pending and is
   adopted at the first call after the transition has ended. At most one adoption per call.
3. **Hold.** From the adoption on, the new engine runs next to the old one. It starts from the old engine's detector / gain state
   (9.4), processes its first frame at its last grid point m <= the adoption position (the input is already in the ring), and then
   runs on its own grid. Its overlap-add output is complete **3 hops after that first frame** (valid = m + 3 H_new). Until `valid` the
   output is the old engine's output, **bit-identical to a core that was never asked to switch**; the meters, the viz tap, the
   introspection accessors, `frameTier()` and `currentLatency()` stay on the old tier. The hold lasts 2 to 3 hops of the new tier:
   at 48 kHz up to 8 ms to Fast, 16 ms to Normal, 32 ms to High.
4. **Crossfade.** From `valid` on (a frame boundary of the new engine) the output is `y = A + r (B - A)`, with A the old engine's
   output, B the new one's, and r = (k + 1) / F for the k-th sample of the fade (linear, the same form as the EQ spectral restart
   fade-in of eae4ab1), F = round(5 ms x fs) = 240 samples at 48 kHz (`Core::kTierCrossfadeMs`, `tierCrossfadeSamples()`). At the
   first sample of the fade `frameTier()` and `currentLatency()` switch to the new tier, the viz tap and the meters publish the new
   engine, and `framesProcessed()` keeps counting (frames of the tier in use). When r reaches 1 the output is exactly B and the old
   engine stops.
5. **Duration.** adoption -> end of crossfade = (2 .. 3) x H_new + F. Measured at 48 kHz (T-B, block 100): 600 samples to Fast,
   1 000 to Normal, 1 500 to High (12.5 / 20.8 / 31.3 ms). Both engines run during that time.
6. **Never silent, never a step.** The output is never muted and never switched without a crossfade. T-B, every ordered pair, C1c:
   the largest sample step from the adoption to the end of the crossfade is 0.880 - 0.961 x the steady runs' largest on pink noise
   with a +12 dB / Q 8 bell at 2.5 kHz, and 0.994 - 0.998 x on a 1 kHz sine (bound 1.25); no NaN / Inf.
7. **Alignment.** Outside the crossfade the wet output is the input delayed by `currentLatency()` (at depth 0 within -160 dBFS);
   during it, it is the blend of the two delays given above. After the transition a unit impulse comes out at exactly
   +`latencyFor(new tier)` with unit height (T-B, depth 0, every pair; max elsewhere <= 2.4e-8).

**Aligned dry (`dryOut`).** `process(channels, n, numSamples, params, dryOut)` writes, per processed channel, the input on exactly the
timeline of the wet output: delayed by `currentLatency()` outside a transition, the old delay during the hold, and
`x[t - N_old] + r (x[t - N_new] - x[t - N_old])` with the same r during the crossfade. At depth 0 wet == dryOut within the COLA
error at every sample of a switch (T-B: max |wet - dryOut| <= 4.5e-8 over the whole transition). So any mix
`(1 - mix) x dryOut + mix x wet`, a delta `wet - dryOut`, or a bypass crossfade to dryOut never combs and never steps. T-B measures it
on white noise at depth 0 over the whole transition: the spectrum of wet + dryOut equals that of 2 x dryOut to 0.0000 dB (flatness of
the ratio 1.00000). **Negative control:** a dry delay that follows `latencyFor(requested tier)` from the adoption on (an effect that keeps
its own delay line and switches it when it publishes the new latency) combs over the hold: deepest notch -22 to -31 dB, flatness of the
ratio 0.25 - 0.58. `dryOut` must not alias the channel buffers; a null entry skips that channel.

**Aux channel (`auxIn` / `auxOut`).** One extra delay-only channel, not analysed or processed, delayed onto exactly the `dryOut`
timeline. It is the other component of the Mid / Side recipe (8.3): Mid mode processes M as channel 0 of a 1-channel call and passes S as
aux; then L' = M' + S_d and R' = M' - S_d. T-M: through every ordered switch at depth 0 that reconstructs the stereo dry timeline to
<= 5.2e-8, and auxOut is bit-identical to the dryOut of a 2-channel core fed S as channel 1. Pass the aux on every call while it is in use
(its ring is written only when `auxIn != nullptr`); `reset()` clears it.

**Why the hold, and not an immediate switch with a dry bridge.** The alternative was to move the output to the new latency at the
adoption and to bridge the hold with the unsuppressed input at the new delay, then crossfade to the new wet once it is valid. That puts
the resonance back, unsuppressed, for 2 - 3 hops of the new tier (up to 32 ms at High) on every switch, and it breaks the step bound
wherever the core cuts something: T-B computes what it would do, max input step / steady wet step = 1.05 on pink + bell and **15.1 - 15.7 on
the 1 kHz sine** (C1c cuts a lone sine about 24 dB), against the 1.25 limit. The hold keeps the suppression continuous. Its cost: the
output reaches the new latency up to 3 hops + 5 ms after the request instead of at once (9.3, step 2).

**Memory orders.** `requestTier()` stores with `memory_order_release`. The audio thread first does a `relaxed` load (the common case,
nothing pending, costs one load per call) and, only if something is pending, `exchange(-1, memory_order_acquire)`. The value is a
self-contained tier index, so relaxed would be correct for the core; release / acquire are there so that whatever the requesting thread
wrote before the request (for example the effect's own parameter state) is visible to the audio thread once the request is adopted.
`frameTier()`, `currentLatency()` and `tierSwitchCount()` are written by the audio thread and read anywhere with relaxed atomics: they
are status values, not synchronisation. Out-of-range tier values clamp to Fast / High. There is no mutex, condition variable, spin-wait
or retry loop anywhere on the path.

### 9.3 What the effect must do (integration phase)

1. **prepareToPlay** (message thread, not processing): `core.setFrameTier(tier from the quality parameter)`, `core.prepare(sr, block,
   channels)`, then `setLatencySamples(core.currentLatency())`. Allocate `dryOut` buffers (and the aux buffer for Mid / Side) for the
   largest block the host can deliver.
2. **Quality change** (message thread, `onParameterValueChanged("quality")`): `core.requestTier(t)` and
   `setLatencySamples(Core::latencyFor(sr, t))`. **Never** `prepare()` or `reset()` for a quality change: that is RT3. The host's PDC
   recompute is not sample-synchronous with the core's adoption anyway; the core keeps its output aligned to `currentLatency()`
   throughout, and the gap between the published latency and the core's is at most the hold + 5 ms (9.2, step 3). An effect that wants
   to publish the latency only once the core has moved can watch `frameTier()` / `currentLatency()` from the message thread instead
   (both are atomics); the difference is the order of two transients, not their size.
3. **processBlock**: one `core.process(ch, n, numSamples, params, dryOut[, auxIn, auxOut])` per block, then mix with **the core's
   dryOut** (not with an own dry delay of `latencyFor()` or `currentLatency()` samples): `out = dryOut + mix x (wet - dryOut)`, delta
   = `wet - dryOut`. The effect needs no dry delay line of its own.
4. **Mid / Side**: Mid = process M (channel 0, n = 1) with S as aux; Side = process S with M as aux; recombine with the aux output. A
   stereo_mode change still calls `reset()` (8.3).
5. **Parameters**: pass the APVTS values as they are; the core sanitises them (9.6). `weightCurve` must stay valid for the call.
6. Do not call `prepare()`, `release()` or the structural setters while `process()` can run; `requestTier()` is the only tier call that
   may race with it.

CPU during a transition: both engines run for (2 .. 3) x H_new + F samples; a block then completes at most one frame of each tier, plus
the new engine's first frame in the adopting call (which may coincide with a frame of the old one). Fixed-tier cost: no change in p99 or in the same-run ratios; up to about 2 - 4 % of the mean not excluded (9.8.2).
The prepared footprint is the three engines together (N = 512 + 1024 + 2048: about 3.5 x the Normal tier's buffers) plus the rings; prepare() builds all three tiers' tables (its time was not measured).

### 9.4 Detector and gain state across a switch (kept, measured)

The detector's band-domain state is tier-invariant in meaning: per-band reductions (attack / release state, dB), the release latches,
and the bias-correction products a^n of both averages (a^n = exp(-t / tau) at every tier: the time constants are in ms). Band LEVELS are
not tier-invariant (they carry a constant offset that depends on N, 1.2), and the power averages live on the bins. On a switch the core
therefore:

- copies the per-band reductions, smoothed / applied curves and latches, and both a^n;
- remaps both power averages to the new bins with the |X|^2 scaling of a noise-like input (x N_new / N_old): linear interpolation in
  frequency to a finer grid, a triangular average over the old bins within +-r of the new bin to a coarser grid (r = 2 or 4), so a peak
  between two new bins is shared, not dropped;
- converts the frame count through time (round(frames x H_old / H_new); it indexes the sigma tables and the baseline stagger), recomputes
  sigma for it, and forces a full baseline refresh on the first new frame (the levels are recomputed from the remapped averages every frame).

Measured (T-C, C1c, pink noise with a steady +12 dB / Q 8 bell, switch after 4 s, published cut = max applied band reduction within
+-1/6 octave of f0, channel 0, sampled every 64 samples; "fresh" = a core of the new tier that processed the whole signal). Acceptance: the
cut stays above 1 dB from the adoption to 150 ms and is within 1.5 dB of the fresh core from 150 ms on.

| 2.5 kHz | kept: min cut 0-150 ms | kept: within 1.5 dB of fresh from | kept: worst \|diff\| after 150 ms | reset: min cut 0-150 ms | reset: within 1.5 dB from |
|---|---:|---:|---:|---:|---:|
| Fast -> Normal | 8.22 dB | 0 ms | 0.20 dB | 0.21 dB | 62.7 ms |
| Fast -> High | 8.23 | 0 | 0.21 | 5.48 | 62.7 |
| Normal -> Fast | 8.36 | 0 | 0.12 | 0.00 | 52.0 |
| Normal -> High | 8.40 | 0 | 0.06 | 5.48 | 62.7 |
| High -> Fast | 8.39 | 0 | 0.15 | 0.00 | 52.0 |
| High -> Normal | 8.43 | 0 | 0.02 | 0.21 | 62.7 |

Curves (ms after the adoption: kept / fresh / reset, dB):

| ms | Normal -> High | Normal -> Fast | High -> Normal |
|---:|---|---|---|
| 0 | 8.72 / 8.73 / 8.72 | 8.72 / 8.50 / 8.72 | 8.73 / 8.72 / 8.73 |
| 10 | 8.71 / 8.72 / 8.71 | 8.70 / 8.49 / **0.00** | 8.72 / 8.71 / 8.72 |
| 20 | 8.69 / 8.70 / 8.69 | 8.68 / 8.49 / **0.85** | 8.69 / 8.69 / **0.69** |
| 30 | 8.66 / 8.68 / **5.48** | 8.66 / 8.47 / 3.75 | 8.67 / 8.67 / 3.21 |
| 50 | 8.63 / 8.66 / 6.52 | 8.62 / 8.45 / 6.83 | 8.65 / 8.64 / 6.25 |
| 100 | 8.51 / 8.55 / 7.51 | 8.49 / 8.34 / 7.47 | 8.53 / 8.52 / 7.44 |
| 150 | 8.40 / 8.44 / 7.68 | 8.36 / 8.24 / 7.60 | 8.43 / 8.42 / 7.64 |
| 300 | 8.40 / 8.42 / 8.40 | 8.33 / 8.30 / 8.36 | 8.41 / 8.42 / 8.40 |
| 500 | 8.89 / 8.91 / 8.97 | 8.78 / 8.78 / 8.82 | 8.89 / 8.89 / 8.92 |

The reset alternative (`setKeepDetectorStateOnTierSwitch(false)`: the new engine starts from reset state) drops the cut to 0 - 5.5 dB
when the new engine takes over (the bias-corrected start-up and its large start-up sigma) and needs 52 - 63 ms to come back within 1.5 dB;
at 500 Hz (informational, the bell is narrower than one bin at every tier) it drops to 0.00 dB for 20 - 115 ms depending on the pair and needs 175 - 204 ms,
while the kept state stays at >= 7.22 dB with a worst difference to the fresh core of 0.24 - 0.51 dB after 150 ms. **Decision: the state is
kept** (default; the reset path remains a structural study option). The 1.5 dB criterion is met from the first sample because the three
tiers' steady cuts at 2.5 kHz differ by only 0.2 dB; the evidence that the transfer itself is right is the worst difference after 150 ms
(<= 0.21 dB at 2.5 kHz), not the 1.5 dB bound.

### 9.5 Hop phase across tiers

`setHopPhaseOffset()` is stored as a fraction of the prepare-time tier's hop (o / H at `prepare()`); every tier uses floor(fraction x its
hop) on the same stream clock. Going to a longer hop is always exact; going to a shorter one is exact when the offset is a multiple of the
hop ratio (2 or 4), which `hopPhaseOffsetForInstance(i, hop)` satisfies for up to hop / 4 instances. The fraction is never re-derived from
a rounded offset, so repeated switches do not drift. T-H: 8 instances prepared at Normal with `hopPhaseOffsetForInstance(i, 256)`, all
switched together Normal -> High -> Fast -> Normal at 64-sample blocks: in steady state at most 2 / 1 / 4 / 2 frame boundaries per block over
the 8 (8 x 64 / hop), every offset is the original x2 at High and /2 at Fast and the original again at Normal; the all-zero control has 8 at
every tier.

### 9.6 Parameter hardening (at intake, on the audio thread)

`process()` works on `Core::sanitizeParams(p)`, a copy of the caller's block (exposed for tests and for showing what is in effect):

| field | non-finite (NaN, +-Inf) | then clamped to |
|---|---|---|
| `depth` | 0.5 | 0 .. 1 |
| `sensitivity` | 0.5 | 0 .. 1 |
| `attackMs` | 15 | 0.1 .. 1000 |
| `releaseMs` | 200 | 1 .. 10000 |
| `stereoLink` | 0 | 0 .. 1 |
| `sharpness` | 0.5 | 0 .. 1 |
| `weightCurve[i]` (per frame, at use) | **1** (the band is left unweighted) | 0 .. `kMaxWeight` (2.5); negative -> 0 |

The finite test reads the bit pattern, so it holds under any floating-point model. A finite value inside its range passes bit-identically
(T-E: 20 000 random valid sets compared by bit pattern), so valid inputs give bit-identical results. **Change for invalid input:** a NaN
weight used to read as 0 (the band never cut) and now reads as 1, and +-Inf in `sharpness` now reads as 0.5 instead of 1 / 0; W2 was updated
accordingly. `hardKnee` (a bool) and the `weightCurve` pointer cannot be validated; non-finite input AUDIO is not sanitised (9.9). T-E: each of
the six float fields set to NaN, +Inf, -Inf, 1e30, -1e30, 7, -3 and 0 in turn (C1c otherwise), all fields non-finite at once, and a weight curve
of {NaN, Inf, -Inf, -1, 1e30, 0.5}: output finite, max |out| <= 0.46 against 4 x the input peak, bit-identical to passing the sanitised value
explicitly, zero allocations.

### 9.7 API summary for the effect

| call | thread | notes |
|---|---|---|
| `setFrameTier(t)`, `setHopPhaseOffset(o)`, `setKeepDetectorStateOnTierSwitch(b)`, `prepare()`, `release()` | non-audio, not processing | `prepare()` builds every tier |
| `requestTier(t)` | any | one atomic store; last wins |
| `Core::latencyFor(sr, t)`, `Core::fftSizeFor(sr, t)` | any | pure |
| `currentLatency()`, `frameTier()`, `tierSwitchCount()`, `lastMaxReductionDb()` | any | relaxed atomics |
| `process(ch, n, len, params, dryOut = nullptr, auxIn = nullptr, auxOut = nullptr)` | audio | adopts a pending request at its start |
| `reset()` | audio (or not processing) | completes a running transition at once on the requested tier; a pending request stays pending |
| `targetFrameTier()`, `tierTransitionActive()`, `tierCrossfadeSamples()`, introspection | audio | describe the tier the output is aligned to |
| `Core::sanitizeParams(p)` | any | pure |

### 9.8 How "fixed-tier output is bit-identical" and "CPU unchanged" were checked

- **T-A** (unit test): for each tier, the default configuration, a weighted / broadened one (depth 1, Hard, sensitivity 0.7, sharpness 0.15,
  link 0.5, weights {0, 0.3, 1, 1.7, 2.5}) and a weighted / narrowed one (Soft, sharpness 0.85, attack 3 ms, release 80 ms), plus Normal with hop
  offset 96, a 3 s stereo signal (pink + bell + 1 kHz tone) through the schedule {1, 37, 128, 255, 511, 1024, 37}: a 64-bit FNV-1a hash of
  every output sample. The hashes were recorded by building the same test against the core of 85df03d; the new core reproduces all 10.
- **The 101 checks that existed before** print byte-identical text (every measured number) from the old and the new binary, except W2 (its
  NaN entry, 9.6) and V4 (wall-clock).
- **Bench** (9.8.1) and **CPU** (9.8.2) below.

#### 9.8.1 Bench, byte for byte

The pre-change bench binary (85df03d) was frozen as `xleth_rs_quality_bench_tierpre.exe`, the new one built, and both run with
`--subjects C1,C1c,C1c-F,C1c-N,C1c-H,S3c,R0,R1 --ref-subjects --no-cpu` on the default seed and on `--seedset dev` (the held-out seeds were
not run). Every file was compared byte by byte, with the run-folder name / timestamp normalised:

| run | files | byte-identical | differ only in the run folder name / timestamp | content differences |
|---|---:|---:|---:|---:|
| default seed | 90 (21 CSV, 68 WAV, summary.md) | 89 | 1 (summary.md, its "Run directory" line) | 0 |
| dev seeds 1..6 | 546 (131 CSV, 408 WAV, 7 summaries) | 538 | 8 (7 summaries, `seedset_per_seed.csv`) | 0 |

Gate counts and verdicts are therefore unchanged (C1c-N default seed `PASS (1 waiver)`; dev robust verdicts C1c FAIL G1 1/6, G8a 1/6;
C1c-F G3 5/6, G8a 1/6, G9a 4/6; C1c-N G1 1/6, G8a 1/6; C1c-H G8a 1/6, as in 7.4).

#### 9.8.2 Fixed-tier CPU

`--cpu-only` times only the default (Primary) subjects, so C1c-N was timed through the full run, `--subjects C1c-N` (its G7 rows: 30 x 10 s stereo
pink noise per block size, fresh instance per repetition, against S3 in the same run). Six runs on an otherwise idle machine (one unrelated process
held about 0.9 of a core), in the order pre, post, pre, post, post, pre. Mean per-block time, us (ratio to S3 in the same run):

| run | C1c-N @64 | C1c-N @128 | S3 @64 | S3 @128 | C1c-N p99 @64 |
|---|---:|---:|---:|---:|---:|
| pre 1 | 18.84 (0.857) | 36.85 (0.843) | 21.99 | 43.73 | 120.2 |
| post 1 | 19.41 (0.799) | 37.93 (0.811) | 24.31 | 46.76 | 122.9 |
| pre 2 | 19.01 (0.746) | 37.12 (0.755) | 25.48 | 49.14 | 118.2 |
| post 2 | 18.98 (0.689) | 37.93 (0.845) | 27.57 | 44.89 | 120.0 |
| post 3 | 19.48 (0.810) | 39.39 (0.846) | 24.05 | 46.58 | 122.8 |
| pre 3 | 17.64 (0.804) | 35.33 (0.853) | 21.95 | 41.43 | 78.3 |

Reading it:

- **Same-run ratios to S3** (the bench's own normaliser, G7): pre 0.80 / 0.82, post 0.77 / 0.83 at 64 / 128 (means of three). The S3 reference
  runs identical code in both binaries yet moves by 25 % between runs, so the ratios scatter by about +-7 % and show no difference.
- **Raw means of C1c-N**: post is higher by 4.3 % at 64 and 5.5 % at 128 over all six runs. The last pre run caught a quieter machine state (its S3
  and both p99 values are far lower: 78 against about 120 us); over the four runs in the same state (p99 about 120 us) the difference is +1.9 % at
  64 and +3.9 % at 128, against a same-binary spread of about 1 % in that state.
- **Worst-case blocks** (p99) are unchanged in the comparable state: 120 - 123 us post against 118 - 120 us pre.

**Conclusion: a fixed-tier cost of up to about 2 - 4 % of the mean cannot be excluded by these wall-clock runs; no difference is visible in the
p99 or in the same-run ratios.** The per-sample and per-frame work did not grow (the input memcpy goes into the ring instead of the FIFO, the
per-frame memmove of N - H input samples is gone, the window reads the ring in at most two segments; per call one relaxed atomic load and the
six-field Params sanitise, a few ns), so a real difference, if any, would come from memory layout (the three engines and the 4096-sample ring
per channel against one engine and a 1024-sample FIFO). Settling it needs an in-process A/B (the 85df03d core compiled under another namespace
next to the new one, interleaved per repetition), which the bench cannot do as it stands. All six runs pass G7 (ratio <= 1.0) with a wide margin.

### 9.9 Limitations (for the effect integration)

- **Latency reaches the new tier 2 - 3 hops + 5 ms after the adoption**, not at once (9.2): with a PDC update published at the request, the
  track is misaligned by the latency difference for up to that time (32 + 5 ms at High, 48 kHz).
- **Fixed-tier mean CPU** may be up to about 2 - 4 % higher than before (9.8.2: not resolvable by wall-clock runs; p99 unchanged); an in-process A/B against the 85df03d core would settle it.
- **One transition at a time.** A request made during one waits until it ends (at most about 37 ms at 48 kHz); a request is never cancelled or
  re-targeted mid-transition.
- **During a transition both engines run** (9.3); a switch costs one extra frame of the new tier in the adopting call.
- **The crossfade is between two delays of the same audio**: for a stationary tone the blend of the two phases can dip during the 5 ms (a
  partial cancellation at frequencies where the two delays differ by about half a period). Broadband material shows nothing; this is the
  nature of moving a timeline, and the dry follows the same blend, so mixes stay consistent.
- **`VizFrame::hopIndex`** keeps counting frames of the tier in use; the sample-position formula `hopSize x (hopIndex + 1) - hopPhaseOffset()`
  holds only without a switch since `reset()`.
- **Mixed channel counts across calls** (a 2-channel core called with n = 1 and later n = 2) leave channel 1's ring stale for one latency, as the
  old per-channel FIFO did.
- **Non-finite input audio** is not sanitised (it would propagate through the averages like before); the effect's input stage owns that.
- An **isolated impulse after seconds of digital silence** is cut by 0.2 - 0.4 % by a steady Fast or Normal core, switched or not (seen in T-B with
  default parameters); a detector property, not part of the switch.
