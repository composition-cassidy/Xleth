# ResonanceCore

`engine/src/dsp/ResonanceCore.{h,cpp}`, namespace `xleth::dsp::resonance`.

A self-contained spectral resonance suppressor core: it finds narrow spectral peaks that stand out of the local
spectrum (a ringing room mode, a whistle, a harsh formant), and attenuates exactly those bands, per channel, with a
real zero-phase gain applied through a weighted overlap-add (WOLA) transform. It has no `juce::AudioProcessor` or
APVTS dependency: it is driven with raw channel pointers and a plain parameter struct, so it can be unit-tested and
benchmarked without an engine. It is wired, opt-in, into the Resonance Suppressor's High Quality mode as
`hq_engine` = New (section 10; the default stays the Classic `WolaProcessor`), and, opt-in, into the Param EQ's Spectral bands as
`spectral_engine` = Core (section 11; the default stays the EQ's legacy 4096 STFT path). Section 8 is the surface the
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
4. Low frequencies: what limits the cut, the per-bin path, and what to tell users
5. Real-time rules: allocation and threading
6. Running the bench against the core
7. Measured margins (7.1 single-seed robustness, 7.2 D1 vs the bench, 7.3 worst-case CPU, 7.4 seed protocol and tier study, 7.5 multi-instance bursts)
8. Resonance Suppressor integration surface (8.1 grid and weight curve, 8.2 sharpness, 8.3 channels and Mid / Side, 8.4 visualization tap, 8.5 meters, 8.6 parameter changes, 8.7 instance hop phases, 8.8 RS parameter mapping, 8.9 what the core still cannot do)
9. Live frame-tier switching, aligned dry, parameter hardening (9.1 structure, 9.2 the transition contract, 9.3 what the effect must do, 9.4 detector state across a switch, 9.5 hop phase across tiers, 9.6 parameter hardening, 9.7 API summary, 9.8 bit-identity and CPU checks, 9.9 limitations)
10. Using the core in the Resonance Suppressor (10.1 selection and old states, 10.2 what prepare builds, memory, 10.3 structural transitions, 10.4 quality and the latency window, 10.5 mapping / curve / stereo / output stage, 10.6 hop phase, 10.7 viz / meters / telemetry, 10.8 bench subjects RSC-*)
11. Using the core in the Param EQ (11.1 selection and old states, 11.2 the EQ's parameter snapshot (locking), 11.3 what prepare builds, memory, 11.4 regions: one weight curve, shared vs per-region settings, 11.5 channels and routing, 11.6 structure and transitions, 11.7 quality, latency window, bypass, 11.8 hop phase / meters / display, 11.9 bench subjects EQS-*, 11.10 Legacy bit-identity, 11.11 limitations)

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
| **onset** | fast - slow > `kSwitchUpSigmas` fast sigmas: use the fast estimate | **2.0** | a new resonance lifts the fast level well before the slow one. 2.5 (the first value) fired in only 24 - 40 % of the rise frames of a 500 Hz bell (its fast sigma is 1.2 / 1.5 / 1.9 dB at F / N / H), so the slow average stayed in charge and G8a 500 Hz failed on 3 - 4 of 6 dev seeds; 1.5 regressed unit test F1 (clean pink, sensitivity 1: mean cut 0.243 dB against 0.2). 2.0: G8a 500 Hz 6/6 dev seeds at N / H, F1 0.116 dB |
| **release latch, set** | slow - fast > `kVetoSetSigmas` fast sigmas: latch the band to the fast estimate | **2.0** | after the resonance stops, the slow estimate falls only as 10 log10(1 + 9 e^(-t / 200 ms)); it is still 3-5 dB above the clean level while already inside 2.5 fast sigmas of the fast estimate, so a symmetric +-2.5 rule never hands over (G9a 6/9). 2.0 sets the latch about 45 ms after the offset (one 5.3 ms hop, the 21 ms window, and the 40 ms average having to fall by 2 fast sigmas, about 2.1 dB; measured at 2.5 kHz) |
| **release latch, clear** | slow - fast < `kVetoClearSigmas` fast sigmas: back to the slow estimate | **0.75** | hysteresis; the latch must not chatter while the slow estimate converges back |

The threshold, the knee width and the depth cap all run on the estimate that is in charge, with that estimate's own
sigma. While the fast estimate is in charge the knee is narrower: `kFastKneeSigmasHard` / `kFastKneeSigmasSoft` = 0.5 / 1.0 fast
sigma (one third of the steady 1.5 / 3 sigma); with the steady width an onset reached only part of its depth until the slow average
caught up. While a band is latched, the cut follows the fast excess (which falls to 0 within a few frames) and the
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
4. **Sub-bin depth correction** (legacy rule: where an ERB is narrower than the analysis kernel): the *depth* of the cut, not the
   detection decision, uses the excess an auditory filter centred on the peak would see. Since the low-frequency per-bin path
   (section 4) it is applied only to bands at or above the split's guard (band 15, ~270 Hz at 48 kHz); below that the per-bin path
   carries the sub-bin depth.
5. **Depth cap:** R = r / (1 + (r / Rmax)^p)^(1/p), Rmax = depth x 12 dB (Soft, p = 2) or depth x 24 dB (Hard, p = 6).
6. **Per-band attack / release** in dB at the frame rate (one-pole), then **[1 2 1] / 4** smoothing across bands
   (at the default `sharpness` 0.5; section 8.2), then the **stereo link** (each channel blends towards max(L, R) by
   `stereoLink`), then the optional **weight curve** (section 8.1).
7. **G(f):** the band curve in dB is interpolated linearly on the ERB axis to every bin and applied as a real,
   zero-phase gain; below `kLowSplitHz` (400 Hz) each bin takes the larger of that and the per-bin path's cut (section 4). If every
   gain is exactly 1 the multiply is skipped.

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
| `setLowFreqBinPath()` | true | bool | reference option: false removes the low-frequency per-bin path and restores the legacy sub-bin correction everywhere, bit-identical to the core before the path (section 4) |
| `setDetectorTimeConstantMs()` | 200 | ms | slow estimate |
| `setFastTimeConstantMs()` | 40 | ms | fast estimate; 0 disables the fast path (slow only) |
| `setHopPhaseOffset()` | 0 | samples | initial hop phase, modulo the hop; latency stays N; 0 = historical behaviour (bit-identical). Use `Core::hopPhaseOffsetForInstance(i, hop)` for instance i in one thread (7.5, 8.7). Kept as a fraction of the hop across tier switches (9.5) |
| `setVizSink()` | nullptr | - | visualization tap (not structural: may be set between `process()` calls on the processing thread). Section 8.4 |

### 2.3 Constants (compile time)

| constant | value | unit | role |
|---|---|---|---|
| `kSwitchUpSigmas` | 2.0 | fast sigma | onset: fast - slow above this uses the fast estimate (1.4) |
| `kFastKneeSigmasHard` / `kFastKneeSigmasSoft` | 0.5 / 1.0 | fast sigma | knee width while the fast estimate is in charge |
| `kLowSplitHz` | 400 | Hz | bins below it get the low-frequency per-bin path (section 4), every tier and sample rate |
| `kLowSplitGuardBands` | 6 | bands | the band path drops the sub-bin correction only this many bands below the split, so every bin >= 400 Hz stays bit-identical |
| `kLfDeltaSteps` / `kLfDepthSteps` / `kLfTaps` | 32 / 24 / 6 | - | notch table: offset 1/32 bin, depth 0 .. 24 dB in 1 dB, cut on floor(p) - 2 .. + 3 |
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
| - | Detector tau 400 ms (slow only) | - | - | 9/12 | 0.086 | detects marginal (about 1 sigma) low-frequency resonances more often, but the clean-pink low-frequency bias (+0.6 dB) becomes ~1 sigma (false-trigger rate 2 % per band-frame) and the cut lingers ~2 tau after a resonance stops. It also does not pass G1 at 100 Hz (residual converges to ~3.5 dB) |

**Kept: 1c**, the two-speed detector with the release latch set at 2.0 / clear at 0.75 fast sigma and fast tau 40 ms:
G8a 6/6, G9a 9/9, G1 11/12 (the missing one is 100 Hz, section 4), G4 std 0.130 (quick) / 0.156 (full), steady state
untouched. Two earlier attempts at the 100 Hz case kept their place in the core: main-lobe-gated reduction (5.43 -> 4.84 dB at tau 100 ms)
and the auditory-resolution depth target (-> 2.92 dB at tau 200 ms; it fixed 150 / 220 / 330 Hz but not 100 Hz). Neither touched the
gain path, which section 4 now shows was the limit.

## 4. Low frequencies: what limits the cut, the per-bin path, and what to tell users

**What the evidence says** (`--lowfreq-diag`, docs/RS_LOWFREQ_DIAGNOSIS.md, seeds 0..6). A +12 dB / Q 8 bell at 100 Hz is 12.5 Hz wide,
narrower than one analysis bin at every tier (93.8 / 46.9 / 23.4 Hz). That is **not** a resolution ceiling at Normal and High: cut-only
per-bin gains through the same WOLA transform (the `ls` oracle) pass the 100 Hz cell (N 1.10, H 0.41 dB against 2.10), and pre-compensating
the window kernel does **not** need gains above 1. The core missed the cell for two reasons of its own: (1) its gain path - 96 ERB bands, then
[1 2 1] / 4, then linear interpolation to the bins - cannot represent a 12.5 Hz notch at 100 Hz (even a perfect detector through it leaves
2.5 - 3.2 dB); (2) the depth was the window-averaged excess, about half the peak in dB. At Fast the transform IS the limit (the `ls` oracle
fails, 2.42 dB): Fast's earlier pass of the 100 Hz cell came from cutting ~7 dB across 44 - 205 Hz, which G2 does not see (it starts at 100 Hz).

**The per-bin path (below `kLowSplitHz` = 400 Hz, every tier and sample rate).** It replaces the old ERB-vs-ENBW coverage rule (which gave
281 / 750 / 23 Hz at N / F / H) with a fixed frequency. 400 Hz: a Q 8 bell is narrower than one Normal-tier bin below ~370 Hz; the band path
already meets G1 at 500 Hz on every tier; and the G8a onset cell (500 Hz) stays entirely on the band path. Per frame and channel:

1. **Peaks** of the slow bin excess fraction x_k (level over the interpolated flank baseline) below the split. Per peak: mass m (sum of x over
   +/- 2 bins), position p (the excess centroid mapped through a line-source centroid table of that tier's window, which removes the
   truncation bias next to DC), width w (the peak bin's share of the mass against the share of a width-w source at that offset: robust to a
   resonance's long tails, which made the old second-moment width read ~1 bin for a 0.2-bin-wide bell).
2. **Depth** D = 10 log10(1 + m / max(ERB(p), w)): the excess an auditory filter centred on the peak would see - the core's existing
   auditory-resolution definition, now evaluated at the peak itself.
3. **Detection, dynamics, routing**: target K x D, K = the gated knee of the band nearest p (the band path's own detection state and knee),
   the depth ceiling per bin (Soft / Hard shape), per-bin attack / release, the stereo link, the weight curve interpolated to the bin (a
   weight of 0 below 40 Hz still means no cut: unit test LF2). Sharpness, a band-curve smoothing, does not apply.
4. **Rendering**: the cut on bins floor(p) - 2 .. + 3 is read (bilinear) from a table solved in `prepare()` for each tier: the cut-only,
   minimum-norm (sum of dB^2) per-bin cut whose WOLA response at p is exactly -D (33 offsets x 25 depths x 6 taps; Lagrange + Lambert-W
   Newton, bisection on the multiplier). No solve, no allocation in `process()`. Combined with the band curve by **max() per bin**.
5. **Band path below the split**: the sub-bin depth correction is dropped for bands more than `kLowSplitGuardBands` = 6 below the split
   (below ~250 Hz) - the per-bin path now carries the sub-bin depth where it can be rendered, and the correction's +-1-bin spreading was
   what built Fast's plateau. Detection, gating, smoothing and the correction above the guard are unchanged, so **every bin at or above
   400 Hz is bit-identical** to the core without the path (unit test LF1: every frame, every tier, four parameter sets incl. sharpness 0 /
   1, weights, link). `setLowFreqBinPath(false)` reproduces the a2 output fixtures bit for bit (T-A).
6. **Published values** (`bandReductionDb`, the viz tap, the meters) below the split = max(band curve, per-bin path at the band centre),
   the latter weighted with the band's own weight, so the weight semantics (W2) and meter == max band (E1) hold exactly. `binGains(c)`
   gives the exact applied per-bin gains.
7. **Tier switching**: per-bin attack / release state is remapped to the new tier's bins (interpolated to a finer, max over the covered
   bins to a coarser grid); everything is preallocated for all three tiers. LF5: the largest cut in 70 - 140 Hz stays >= 1.95 dB through
   every ordered switch (a steady 100 Hz bell; it dips from ~7 dB while the new tier's detector settles). Memory: 90.6 KB of tables per
   instance (three tiers); LF4: zero `operator new` / `delete` with LF content and 20 tier switches.

Tried and rejected (one tuning iteration): full depth D wherever the band is detected (the diagnosis' P1 gated it this way). It passes the
100 Hz cell on the default seed (N 1.61, H 1.33) but lets noise peaks in a detected band take their full depth: unit test F1 (clean pink,
sensitivity 1) worst low band 1.085 dB against its 1.0 dB bound, and G3 at Fast. The knee is why the path stops short at 100 Hz: a narrow
low-frequency resonance sits only ~1 sigma above the threshold, so the gated knee averages 0.56 (N) / 0.59 (H) there.

**Results** (C1c-*, dev seeds 1..6, robust verdict; `RSC-*0` and `EQS-*` identical; held-out seeds not run):

| cell (limit) | before (a2) | after (a1) |
|---|---|---|
| G1 100 Hz N (2.10) | 0/6, worst 3.51 | 0/6, worst 2.79, median 2.52 |
| G1 100 Hz H (2.10) | 0/6, worst 3.75 | 1/6, worst 2.56, median 2.32 |
| G1 150 Hz N (2.07) | 1/6, worst 2.20 | **6/6**, worst 1.30 |
| G1 150 Hz H (2.07) | 6/6, worst 1.88 | 6/6, worst 0.58 |
| G1 100 / 150 Hz F | 6/6 (0.93 / 0.71) | 6/6 (-0.15 / -0.56) |
| G3 F, L 100 Hz in-window (+-1.0) | 4/6, worst -1.074 | 3/6, worst -1.144 |
| C1c-N / C1c-H robust verdict | FAIL (G1 150) / PASS (waiver) | **PASS (waiver)** / PASS (waiver, 100 Hz passes raw on 1/6) |

f0 scan 85 - 125 Hz (mean over seeds 0..6): every N / H position improves (e.g. N 93.75 Hz 3.96 -> 2.89, H 117 Hz 2.42 -> 0.97; H passes
111 - 125 Hz on 7/7); the High tier's grid-position swing shrinks from 2.4 - 4.5 to 1.0 - 3.0 dB; on-bin centres remain the hardest. Q 4 at
100 Hz now passes N / H (1.21 / 1.41 against 2.83); Q 16 does not (3.51 / 3.45 against 1.42; before 3.76 / 3.84).

**Low-frequency collateral (G2lo, report-only).** Fast's cut below 100 Hz with the resonance at 100 Hz: 6.4 dB before, 5.8 dB after (dev
median). It remains because at Fast the only bin holding a 100 Hz resonance is 93.75 Hz wide: any cut of that bin spans ~47 - 140 Hz through
the kernel. Normal 2.2 dB, High 0.6 dB, unchanged. Above 100 Hz (100 - 400 Hz outside +-1 octave) every tier stays <= 0.16 dB except Fast.

**Bass notes (T-bass, report-only).** At the capability setting (depth 1, Hard) a clean bass sine is cut 19 - 23 dB before and after this
change (steady notes within +-1.3 dB of before). Decaying 808-style notes come out **1.3 - 2.7 dB quieter** than before (worst High 55 Hz:
-16.6 -> -19.3 dB; Normal 82 Hz -16.6 -> -18.5 dB). Real material (vocal ad-lib, hat loop, C1c settings) loses 0.04 - 0.2 dB more on average below 400 Hz at N / H (up to
0.6 dB in single third-octaves) and up to 1.6 dB in 160 - 320 Hz at Fast.

**The bench waiver** still names G1 100 Hz for C1c / C1c-N / C1c-H / RSC-N / RSC-H / RSC-N0 / RSC-H0 with its old reason text (no gate or
waiver was changed). The reason text is now known to be wrong; see the proposed wording in docs/RS_LOWFREQ_DIAGNOSIS.md and the a1 report.

**User guidance (for the effects that wrap this core).**

- Below ~150 Hz a resonance narrower than the analysis kernel (Q ~8 or more at 100 Hz) is **still only partly reduced** at Normal and High:
  on the bench's +12 dB / Q 8 bell about 65 % of the in-window boost at 100 Hz (residual ~2.3 - 2.8 dB), ~80 - 95 % at 150 Hz.
- Sensitivity does move it: at Normal, sensitivity 1.0 took 100 Hz from 3.37 to 2.20 dB before this change (via the knee). The limit is the
  detector's confidence at low frequencies (the knee), not the renderer.
- The Fast tier removes more at 100 Hz only by also cutting a whole 94 Hz-wide bin's neighbourhood; it is a trade-off, not a more accurate
  detector.
- Bass notes are resonances to this detector: at deep settings a sustained or decaying bass note is cut by up to the depth ceiling. Use the
  focus / weight curve (the RS default curve is 0 below 40 Hz) or a lower depth on bass-heavy material.
- For a single fixed low-frequency mode a parametric EQ notch remains the precise tool.

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
  sigma for it, and forces a full baseline refresh on the first new frame (the levels are recomputed from the remapped averages every frame);
- remaps the low-frequency per-bin path's attack / release state and linked output (dB per bin, section 4) to the new bins: linear
  interpolation onto a finer grid, the maximum over the covered bins onto a coarser one (unit test LF5).

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

## 10. Using the core in the Resonance Suppressor

The core is wired into `XlethResonanceSuppressorEffect` (`engine/src/audio/XlethResonanceSuppressorEffect.h`) as an **opt-in** High
Quality engine next to the legacy `WolaProcessor` ("Classic"). Tests: `[RSCore]` groups in `test_effects`, `test_pdc_stage1` and
`test_effect_processblock_alloc` (cases e, e2, f, g); bench subjects RSC-F / RSC-N / RSC-H (section 10.8). Numbers below are from those
runs at 48 kHz unless stated.

### 10.1 Selection, defaults, old states

- Parameter `hq_engine` (choice `Classic` = 0, `New` = 1), **default Classic**, appended last to the APVTS layout (no existing parameter
  index moves). It is read only when `processing_mode` = High Quality; Low Latency (the IIR engine) is unchanged.
- A state without `hq_engine` restores as **Classic**: `setStateInformation` inserts `hq_engine = 0` (APVTS would otherwise keep the
  instance's current value for a missing parameter), next to the existing `processing_mode` insertion (missing = High Quality). Test: an
  old blob restored into an instance set to New reads Classic and renders bit-identically to a legacy instance with the same parameters,
  also when it is restored while the instance is running New.
- Classic is bit-identical to the pre-integration effect in steady state: every pre-existing check in `test_effects` (1472),
  `test_pdc_stage1` (754) and `test_effect_processblock_alloc` (167, LL null fixtures included) prints the same numbers, and the bench
  subjects S1-S4 and S1c-S4c (`--no-cpu`) write 83 files byte-identical to the pre-change binary (only summary.md's run-directory line
  differs). What changed for Classic is the TRANSITION behaviour (10.3): a `processing_mode` change used to reset both engines instantly on
  the message thread; it is now a fade (test_effects' mode-switch steps 0.187 -> 0.043 and 0.180 -> 0.046).

### 10.2 What prepare builds (nothing is built later)

`prepareEffect` (message thread, not processing) builds every engine the structure can select: one `WolaProcessor` per quality, a dry
delay sized for the longest Classic latency (`setDelay` re-targets it without reallocating), and one `Core` with all three frame tiers
(`setFrameTier` from `quality`, `setHopPhaseOffset` from the instance index, `setVizSink`, `prepare(sr, block, 2)`), plus the core's dry,
Mid / Side and aux buffers, the 96-entry weight curve and the viz resampling tables. **No engine, quality, mode or stereo-mode change
allocates, frees, reconstructs, prepares or resets anything on the message thread** (audit RT3 is gone for Classic too: its quality
change used to re-prepare the `WolaProcessor` in `onParameterValueChanged`).

Memory per instance (48 kHz stereo, block 512, case g): `operator new` bytes of `prepareToPlay` 0.869 MB, of which the core is 0.468 MB
(three tiers + the 4096-sample rings) and the three `WolaProcessor`s + buffers 0.401 MB; process private bytes per prepared instance
(16 instances) 1.02 MB. Below the 1.5 MB budget, so the core is prepared unconditionally. If it ever has to shrink, lazy allocation
would mean preparing the core on the message thread when `hq_engine` first becomes New and publishing it to the audio thread through an
atomic pointer (allocation off the audio thread, but a New request before that completes would have to keep the previous engine running).

### 10.3 Structural transitions (engine, processing mode, stereo mode, Classic quality)

The audio thread reads the requested structure from the APVTS atomics at every block start (so automation reaches it too) and compares
it with the structure it runs: `processing_mode`; for High Quality also `hq_engine` and `stereo_mode`; for Classic also `quality`. On a
difference:

1. **Fade-out**: the output is multiplied by a linear ramp 1 -> 0 over 5 ms (240 samples at 48 kHz), the bypass dry with it.
2. **Switch**, at the block boundary where the ramp reached 0 (the rest of that block is silence): the target engine is reset (Classic:
   the `WolaProcessor` of that quality, the dry delay set to its latency; New: `Core::reset()` directly onto the requested tier, see
   10.4; Low Latency: `reset()`).
3. **Fade-in of the INPUT**: the target engine's history is silence, so its output would start with a step one latency later. Ramping
   what enters it (and the dry it mixes with) 0 -> 1 over 5 ms makes the output start as a 5 ms ramp after the target's latency.

So the dip is fade-out + target latency + fade-in. Measured on DC at depth 0: **32.6 ms** for any change landing on a Normal-tier High
Quality engine (5 + 21.3 + 5 ms, plus one block of 100 samples when the request is seen in a block whose bypass dry the base class did
not take from the effect, below), **11.2 ms** for a change to Low Latency (5 + 0 + 5 ms + block). At High (2048) it is 5 + 42.7 + 5 = about 53 ms (computed, not measured).
Steps: the largest sample step of every transition (Classic <-> New, New <-> Low Latency, Stereo -> Mid -> Side -> Stereo on New) is
<= 1.0x the larger of the input's own largest step and the steady outputs' (pink + bell and a 1 kHz sine). On a lone resonant sine the
output swells towards the input level after the switch: the target engine starts from reset state, so a held resonance is unsuppressed
until its detector engages again (the same reason the core holds its old tier through a tier switch, 9.2). No comb: across Low Latency
<-> New (0 <-> 1024 samples) at depth 0 / mix 50 % on white noise, the share of a 128-sample window's output energy carried by the
second delay is <= 2.6 % (negative control, the two delays summed: 63 %). A state restore and `reset()` adopt the structure at once,
without a fade, from cleared state (as before).

The base class reads `usesLatencyAlignedBypassDry()` before `processEffect`, so the effect computes it for the next block: true while
the New engine is active and while a transition runs, and the dry it hands out is latched per block (the core's dry for New, the live
input otherwise, both with the transition gain). A change seen in a block whose bypass dry the base did not take from the effect waits
one block, so a bypassed or bypass-crossfading output fades with the wet instead of stepping.

### 10.4 Quality on the New engine, and the latency window

A quality change on the New engine is a tier request, never a prepare or reset: the audio thread calls `requestTier()` when the
`quality` parameter differs from its last request, and the core holds the old tier until the new one's overlap-add is complete, then
crossfades (9.2). Measured adoption -> core on the new latency at block 64: 26.7 ms Normal -> High, 13.3 ms High -> Fast, 18.7 ms
Fast -> Normal, 32 ms Normal -> High (from a later point in the hop). Entering the New engine from another structure resets the core
directly onto the requested tier (a zero-length `process()` adopts the pending request, `reset()` completes the transition it started).

**Latency publication and its window.** Every change that alters latency (`processing_mode`, `hq_engine`, `quality`, and for Classic /
Low Latency `mix` / `delta` / bypass) publishes the new latency **on the message thread at the request** (`onParameterValueChanged` /
`onBypassChanged` -> `setLatencySamples`, `Core::latencyFor(sr, tier)` for New), which raises the chain's `LatencyChangeSignal` (generic
path: inline recompute; direct path: the applier's service). The audio output reaches that latency later: after the 5 ms fade-out of a
structural change (the output is silent around the switch, so the PDC retarget is masked), or after the core's hold + crossfade for a
New-engine quality change, **at most 3 hops of the new tier + 5 ms: about 37 ms at 48 kHz going to High** (32 + 5). During that window
the chain is compensated for the new latency while the core still outputs the old one. Latency is never published from the audio thread.
Automation writes the parameter atomics without `onParameterValueChanged`, so an automated quality / engine change moves the audio but
not the PDC (the existing contract of the base class).

### 10.5 Mapping, weight curve, stereo modes, output stage

- Parameters per 8.8, from the raw APVTS values each block (finite-checked, clamped): `depth / 100`, `sensitivity = 1 - selectivity /
  100`, `sharpness / 100` (the core's narrowness meaning, not the Classic detector shape), `hardKnee` from Soft / Hard, `attackMs`,
  `releaseMs`, `stereoLink = stereo_link / 100` (the RS default 100 % is passed through).
- Weight curve: the effect's `weightingForFrequency` (one static definition both engines use) evaluated at the 96 `bandCentreHz` into a
  member array, only when `wc_hp`, `wc_lp` or a focus node changes, and always passed (the RS default curve is not flat: 0 below 40 Hz,
  ramp to 80 Hz, ramp down above 16 kHz; test: every band below 40 Hz is 0, every band 200 Hz - 12 kHz is 1, the top bands ~0.42).
- Stereo: core channels 0 / 1. Mid / Side: the effect matrixes, processes the selected component as channel 0 and passes the other
  through `auxIn` / `auxOut`; the dry is recombined the same way. Mid mode with a pure-side input and Side mode with a pure-mid input
  reproduce the input bit-identically one latency later at depth 0 and at depth 100; on general material the untouched component differs
  only by the float rounding of the M +- S recombination (1.5e-8). Mono Side feeds zeros and passes the input through aux.
- Output stage: mix / trim / delta against the core's `dryOut` (no own delay line). Mix 0 (the dry-only shortcut) and bypass output that
  dry, so the latency stays the tier's: bypass and mix 0 never retarget PDC (test: 0 latency notifications; an impulse comes out once, at
  +1024, bypassed and at mix 0). Cost: the core keeps running while bypassed or at mix 0 (CPU as when active; the detector stays warm).

### 10.6 Hop phase

Each instance gets `Core::hopPhaseOffsetForInstance(index, hop)` with `index` from a static atomic counter assigned at its first
`prepareToPlay` (`setCoreInstanceIndex()` pins it; tests and the bench pin 0, the core's historical grid). With the van der Corput
offsets, 8 Normal instances at 48 kHz complete **at most 2 frame boundaries in any 64-sample block** (8 x 64 / 256; 8.7 H3, 9.5 T-H),
instead of all 8 in every 4th block.

### 10.7 Visualization, meters, telemetry

- Viz: an always-attached `VizSink` resamples each frame (96 bands) to the existing schema-v3 `ResonanceBucket` (128 buckets on
  20 Hz x 1000^(i/127), linear on log f between band centres) and pushes it into the effect's `DynamicsVizCollector` when visualization
  is on. `spectrum` is the core's **40 ms averaged** per-octave level (pink noise flat), calibrated once per tier by -10 log10(N / 2) -
  10 log10(1 kHz): white noise of RMS r reads 20 log10 r dBFS in the 1 kHz bucket at every tier (-19.0 / -18.5 / -19.0 dB for -18.75 dBFS).
  The Classic display is the instantaneous per-bin magnitude of one frame, uncalibrated (about 10 log10(N / 2) dB hotter) and max-pooled.
  `reduction` = cut / 24, `weighting` = the focus curve at the bucket centre, `activity` = top-12 mean / 24, `sampleClock` = hopIndex x
  hop, `fftSize` / `qualityIndex` = the tier in use. One bucket per hop and channel, as Classic.
- Meters: slot 2 keeps its Classic meaning (mean of the 12 largest band cuts / 24, peak with a 0.92-per-block decay), from the frames;
  slot 3 (new, New engine only) = `lastMaxReductionDb()` in dB.
- Telemetry: realtime section `rs_core` for the New engine next to Classic's `rs_wola`.
- Nothing on the audio thread allocates, locks or logs (case e: parameters swept every block; e2: plus structural changes and the viz tap
  on; f: 200 000 blocks of 64 with a second thread changing quality / engine / mode / stereo mode at random, ~1 300-1 500 requests,
  ~400 transitions, ~90 tier switches: 0 allocations, finite, peak 0.34 for an input peak of 0.36).

### 10.8 Bench subjects RSC-F / RSC-N / RSC-H

The effect with `hq_engine` = New at the capability settings (depth 100 %, Hard, every other RS parameter at its default), G4 companions
RSCs-F / -N / -H (selectivity 0). They differ from C1c-* by the effect's layer only: the RS default focus curve (C1c: flat), the parameter
mapping (sensitivity 1 - 0.5 = 0.5, the core default) and stereo link 100 % (C1c: 0). The named G1 waiver (section 4) is NOT extended to
them (no gate or waiver was changed), so their raw G1 100 Hz cell counts.

Default seed (`--subjects RSC-F,RSC-N,RSC-H,C1c-F,C1c-N,C1c-H`, CPU on), RSC-N against C1c-N:

| gate | C1c-N | RSC-N | why they differ |
|---|---|---|---|
| G1 in-window | 11/12 raw, the 100 Hz cell WAIVED -> pass | FAIL 11/12 (100 Hz: 2.34 dB vs limit 2.10) | the same sub-bin cell (section 4); the waiver names C1c / C1c-N / C1c-H only and was not extended. RSC-N's residual is LOWER everywhere below 1 kHz (100 Hz 2.34 vs 3.45 dB, 150 Hz 1.02 vs 1.94) because stereo link 100 % applies max(L, R) of two noisy detectors |
| G2 outside-dev | 12/12 | 12/12 | |
| G1q / G2q / G1l / G2l | 3/3, 3/3, 2/2, 2/2 | same | |
| G3 R-only | PASS (L 12/12, L in-window -0.00 dB) | **FAIL (L 0/12, L in-window -6.78 dB)** | stereo link 100 % (the RS default): the untouched L channel receives R's cut. Expected and by design of the RS default; G3 assumes independent channels |
| G4 jitter | PASS (C1s: std 0.156, isolated 3.9e-5) | PASS (RSCs-N: std 0.199, isolated 5.1e-5) | the companion runs with link 100 % (max of two detectors) |
| G5 pre-echo | PASS (-1.475 / -3.180 dB) | PASS (-0.708 / -3.562 dB) | link 100 % |
| G6 latency | 1024 / 1024 at 48 and 44.1 kHz | same | |
| G7 CPU vs S3 | PASS 0.85 / 0.81 | **FAIL 1.00 / 0.99** (second run 1.01 / 1.01) | the effect layer (per-sample mix / trim / delta with string-keyed smoothers, the input copy and peaks, about 50 APVTS reads per block, the structure check, the always-on viz sink). S3 carries the same layer around the Classic engine, so in the effect the New engine costs what Classic costs (core ~= WolaProcessor at Normal) |
| G8a / G8b | 6/6, 6/6 | 6/6, 6/6 (faster: t50 at 500 Hz / 1000 ms 85 vs 96 ms, lower leak) | link 100 % |
| G9a r_off500 | 9/9 | **FAIL 7/9** (500 Hz / 1000 ms -1.25 dB, 2500 Hz / 1000 ms -1.17 dB vs limit 1.0; C1c-N -0.95 / -0.94) | link 100 %: the max of two decaying reductions stays above 1 dB slightly longer |
| G9b r_off1000 | 9/9 | 9/9 | |
| overall | PASS (1 waiver) | FAIL (G1 unwaived, G3, G7, G9a) | |

The focus curve is not a factor here: every scan f0 (100 Hz - 8 kHz) and every T1 f0 sits where the RS default curve is exactly 1. The
parameter mapping is not a factor either (selectivity 50 % -> sensitivity 0.5, the core default). **Diagnostic RSC-N0** (the same
effect with stereo link 0 and the curve opened to 20 Hz - 20 kHz, i.e. the C1c settings through the effect) reproduces C1c-N exactly
on every DSP gate: identical per-f0 G1 / G2 values, G3 PASS 12/12, G5 -1.475 / -3.180, G9a 9/9 with identical r_off, tau_fit 228.4 ms;
only G7 differs (1.01 / 1.01 vs 0.83 / 0.76 in the same run). So the wiring is exact, every quality difference of RSC-N comes from the
RS default stereo link, and the CPU difference is the effect layer.

RSC-F / RSC-H on the default seed: RSC-F G1 12/12, G3 FAIL (link), G7 1.08 / 1.06, G9a 7/9; RSC-H G1 11/12 (100 Hz unwaived), G3 FAIL
(link), G7 1.04 / 1.03, G9a 8/9.

Dev seeds 1..6 (`--seedset dev --no-cpu`; the held-out seeds were not run). Robust verdicts (a gate passes only if it passes on every
seed; the named waiver applies to C1c-N / C1c-H only):

| subject | seeds passing | gates failing on at least one seed |
|---|---:|---|
| C1c-N | 1/6 | G1 1/6 (150 Hz worst +2.270 vs 2.074; 100 Hz waived 6/6), G8a 1/6 (500 Hz / D 1000 worst 144 ms) |
| RSC-N | 0/6 | G1 1/6 (100 Hz, unwaived: worst 2.422 vs 2.096, median 2.146), G3 0/6 (L in-window -6.9 dB, link), G9a 3/6 (2500 Hz / D 300 worst 1.143 vs 1.0) |
| RSC-N0 | 0/6 | G1 0/6 (100 Hz unwaived 3.326 median; 150 Hz identical to C1c-N), G8a 1/6 (identical to C1c-N: 144 ms) |
| RSC-F | 0/6 | G3 0/6, G9a 0/6 (500 Hz / D 1000 median 1.090) |
| RSC-H | 0/6 | G1 0/6 (100 Hz unwaived), G3 0/6, G9a 5/6 |

RSC-N0 equals C1c-N on every gate value of every seed, so the dev picture says the same as the default seed: the integration is exact,
and RSC-N's differences are the RS default stereo link of 100 %. That link trades: it FIXES C1c-N's two seed-dependent weaknesses (G1
150 Hz 6/6 with worst +1.212, G8a 500 Hz 6/6 with worst 93 ms, both with margin) and costs G3 (by definition: a one-channel resonance is
cut on both channels) and G9a (the release is slightly deeper / longer at 500 ms: worst 1.143 dB). Whether the RS should keep 100 % as
the default for the New engine is a product decision for the UI phase; nothing was retuned here.

## 11. Using the core in the Param EQ

The core is wired into `XlethParametricEQ` (`engine/src/audio/XlethEQEffect.h`) as an **opt-in** renderer for the EQ's Spectral bands
(`mode` = 2) next to the legacy 4096-point WOLA path ("Legacy"). Tests: `[EQCore]` groups in `test_effects`, `test_pdc_stage1` and
`test_effect_processblock_alloc` (cases h, i, i2, j); bench subjects EQS-* (11.9). Numbers below are from those runs at 48 kHz unless stated.

### 11.1 Selection, defaults, old states

- `spectral_engine` (0 = Legacy, **default**; 1 = Core) and `spectral_quality` (the core's tier: 0 Fast 512, 1 Normal 1024 **default**, 2 High
  2048 at <= 50 kHz; Legacy ignores it), appended last to the APVTS layout (260 parameters, no existing index moves). Stepped floats like the
  EQ's `linphase` / `oversample`; `getGlobalParamsAsJSON` reports both.
- A state without them restores as **Legacy / Normal**: `setStateInformation` inserts both PARAM elements before `replaceState` (APVTS keeps
  the instance's current value for a missing parameter). Test: an old blob restored LIVE into an instance running the Core renders
  bit-identically to a fresh Legacy instance with that state from the restore on.
- Legacy is bit-identical to the EQ before the core (11.10).

### 11.2 Threading: the EQ's parameter snapshot (applies to the whole EQ, both engines)

The EQ's RPC / applier-thread mutators used to touch audio-thread state (band `clearState()` from add / remove / restore, removeBand's
16-parameter copy observable half-done, latency status atomics written by both threads). The EQ now reads every parameter its audio thread
uses **once per block** into a private `ParamSnapshot` through a sequence counter: multi-parameter edits (`addBand`, `removeBand`,
`setStateInformation`, the new `setBandParams` batch) run inside an `EditScope` (counter odd, writers serialised by a mutex the audio thread
never takes); a copy that overlapped an edit is rejected and the block keeps the previous snapshot (wait-free: no lock, no retry). Band DSP
state is cleared by the audio thread from a request mask published inside the same edit; a state restore's structure snap rides the same way.
The latency status atomics are written by the parameter path only. The RPC handlers are unchanged. Stress test (case h): a second thread
hammers whole-band tuples (`setBandParams`), single parameters, band modes, add / remove, restores, `spectral_engine` and `spectral_quality`
while the audio thread processes 200 000 blocks of 64: 0 torn snapshots, 0 allocations, finite, bounded; with the sequence check disabled the
same checker sees ~2 400 torn snapshots in 60 000 blocks (negative control).

**Several writers (case h2) and the latency refresh (`latencyRefreshMutex_`).** In the app the EQ has more than one non-audio writer at a
time: the RPC thread (the Node addon worker) and MixEngine's applier thread (FX Graph envelope / LFO modulation through
`setParameterValue`, which holds only `chainsMutex_`; the EQ RPC handlers release `chainsMutex_` before calling the EQ), and the two are not
serialised against each other. Multi-parameter edits were already serialised by the `EditScope` mutex. The latency refresh was not:
`refreshLatencySamples()` reads the parameters, computes the latency and publishes it, and a refresh that read the parameters BEFORE
another writer's latency-affecting change could publish AFTER that writer's own refresh, leaving a stale latency (a lost update). It is
now serialised by `latencyRefreshMutex_`, held across read-compute-publish, taken only by non-audio writers (never by the audio thread), so
the last refresh to run always sees every write before it. Tests (`test_effect_processblock_alloc`): **case h2**, 3 writer threads running
the whole mutation mix (tuples, single parameters, modes, enabled, channel, add / remove, restores, `spectral_engine` / `spectral_quality`, the
applier's `setParameterValue` path) against the audio thread for 200 000 blocks of 64: 0 torn snapshots, 0 allocations, finite, bounded,
latency correct at 200 quiescent points (negative control with the sequence check off: torn > 0); **case h2-lat**, writers issuing only
latency-affecting writes, started together each round and checked after every round: before the mutex 415 of 20 000 rounds left a stale
latency, after it 0 (detector negative control: an automation-handle write without a refresh is seen as stale). No handler, audio-thread or
DSP change (d75b109).

### 11.3 What prepare builds, memory

`prepareEffect` (not processing) builds the Legacy path as before and, unconditionally, one `Core` with all three tiers (`setFrameTier` from
`spectral_quality`, `setHopPhaseOffset` from the EQ's instance index, `prepare(sr, block, 2)`), the aligned-dry / live-dry / routed-mode / aux
buffers for the largest block, and the e^-jw tables of the 96 grid band centres. **No engine, quality, band-mode or routing change allocates,
frees, prepares or reconstructs anything later.** Memory (48 kHz stereo, block 512, case j): `operator new` bytes of `prepareToPlay`
1.180 MB, of which the core is 0.468 MB and the Legacy STFT / FIR / oversamplers / core buffers 0.712 MB; private bytes per prepared instance
(16 instances) 1.81 MB, including the EQ's own spectrum-analysis thread and `sizeof(XlethParametricEQ)` = 0.226 MB of in-object arrays.

### 11.4 Regions: one weight curve, and what one core can and cannot express

Every enabled Spectral band with a cut (gain < 0) is a **region** of ONE `Params::weightCurve` on the core's band grid:

- **Shape**: the band's own bell, i.e. the Legacy influence zone: an RBJ bell at the band's (smoothed) freq / Q and |gain| dB (>= 1 dB),
  evaluated at every `bandCentreHz`, in dB, normalised to 1 at its centre. Band type is ignored, as in Legacy.
- **Depth**: D = the deepest region's min(|gain|, 24 dB); the core runs Hard knee at `depth` = D / 24. A region's curve is its bell x
  min(|gain|, 24) / D, so a region reaches its own depth exactly where the core's cut saturates (bell x D x |gain| / D) and scales the core's
  cut proportionally below that (Legacy's depth is proportional too: depth x bell x knee(over)).
- **Union**: the maximum over regions (each grid band is owned by the region with the largest weight there; the owner table also feeds the
  per-band meter).
- **Recomputed** only when a region's smoothed freq / Q / gain moves by more than the Legacy weight cache's thresholds (0.1 % / 0.001 /
  0.01 dB) or the region set changes; std::array storage, no allocation (during a 30 ms knob glide that is once per block).

| per-band setting | on the Core | vs Legacy |
|---|---|---|
| freq, Q | per region (the bell) | same bell; sampled on 96 bands (spacing ~0.41 ERB) instead of 2048 bins |
| gain < 0 (cut depth) | per region, as the weight (11.4); deeper than 24 dB clamps at 24 | Legacy went to 30 dB |
| gain = 0 | inert region | same |
| **gain > 0 (upward)** | **not expressible** (the core only cuts): the band is inert on the Core, `getSpectralCoreUpwardBandMask()` | Legacy boosts detected peaks |
| enabled / mode | per band (the region set) | same |
| overlap of two regions | union (max of the weights) | Legacy multiplied the masks (cuts added in dB) |
| **spec_sens, spec_sel** | **shared**: core `sensitivity` = 1 - thr / (2 x thr_default), thr = 20 log10(1 + sens x sel) dB, from the **dominant** region | per band |
| **spec_attack, spec_release** | **shared**: `attackMs` / `releaseMs` of the dominant region | per band |
| **channel (routing)** | **shared**: one channel mode for the core (11.5) | Legacy ignores routing for Spectral bands (always both channels, detected on L) |
| detector | one statistical detector for all regions (excess over the flank baseline, in sigma) | one bin detector per band (Â±Â½-octave local mean, threshold in dB) |

**Dominant region**: the deepest cut, the lowest band index on a tie. With one Spectral band nothing is shared. With several, the shallower
regions use the dominant one's detector settings; the per-region settings that differ are not faked.

### 11.5 Channels and routing

- Stereo bands: core channels 0 / 1 with `Params::stereoLink` = **1** by default (both channels get the larger cut: Legacy applied ONE mask,
  detected on L, to both channels; link 1 keeps "one mask, image preserved" while detecting on both). Not a parameter yet
  (`setSpectralCoreStereoLinkForBench`); the bench grades link 0 (11.9).
- Left / Right bands: that channel is core channel 0, the other passes through `auxIn` / `auxOut`: bit-identical, delayed (test, at full
  depth). Mid / Side: M or S is channel 0, the other component through the aux channel, recombined like the RS (pure-side / pure-mid input
  bit-identical at depth 0; general material 1.5e-8 at full depth). Mono folds to Stereo.
- **One core = one channel configuration.** Bands asking for different routings run Stereo and raise `isSpectralCoreChannelConflict()`.
- Legacy: detection on L only (test: an R-only 2.5 kHz tone is cut 0.01 dB by Legacy, 8.6 dB by the Core; an L-only one 22.9 / 8.8 dB).

### 11.6 Structure and transitions

The audio thread selects a structure per block: None (no active Spectral band, or linear phase), Legacy, or Core + channel mode.
**None <-> Legacy** edges keep the Legacy semantics exactly (adopted at once; Legacy's own off -> on restart + 5 ms fade-in and its
un-bypass reset). **Every edge involving the Core** (band on / off, engine, routing, linear phase on / off) is the RS's structural
transition: 5 ms output fade-out (and of the bypass dry), switch at the block boundary where the fade reached 0 (Core: `reset()` onto the
requested tier; Legacy: a fresh stream), 5 ms INPUT fade-in. Oversampling follows the active structure, so it switches where the output is
silent. A state restore adopts the restored structure at once from cleared state; `reset()` completes a running transition.

Measured (`testEQCoreTransitions`, block 480; a clean 1 kHz sine at 0.5 through an inert band for steps and dips, pink noise + a +12 dB bell
through a -24 dB band for steps; bound = the larger of the input's own largest step and the steady output's):

| transition | dip (sine) | largest step / bound, sine | pink + bell |
|---|---:|---:|---:|
| band off -> on (None -> Core) | 26.8 ms | 1.000 | 0.853 |
| band on -> off (Core -> None) | 5.5 ms | 1.000 | 0.885 |
| engine Legacy -> Core | 26.8 ms | 1.000 | 0.853 |
| engine Core -> Legacy | 90.8 ms | 1.000 | 0.878 |
| routing Stereo -> Mid | 26.8 ms | 1.000 | 0.886 |
| quality Normal -> High, High -> Fast (tier switch, no structure change) | 0 | 1.000 | 0.852 |

(1.000 on the sine = exactly the sine's own largest step: the fades never add one.) The dip is fade-out + the target's latency + the rest
of the block in which the fade ended (+ one block when the change was seen in a block whose bypass dry the base did not take from the EQ).
**No stale splice**: after off -> on, a Core that ran before (and saw the signal jump 13 samples while off) is bit-identical, from the
re-enable on, to a Core that never ran. **Un-bypass**: the Core keeps running while bypassed, the bypassed output is the core's aligned dry
(the input delayed by exactly the latency), and after the base's 5 ms crossfade the output is bit-identical to a never-bypassed Core;
largest step 0.0645 (the sine's own 0.0653).

### 11.7 Quality, latency and its window, bypass

- Latency is published **on the message thread at the request** (`onParameterValueChanged` for `spectral_engine` / `spectral_quality`, and the
  existing band enabled / mode paths): `Core::latencyFor(sr, requested tier)` while a Spectral band is active on the Core, 4096 on Legacy, 0
  without an active Spectral band on either engine (Legacy dropped to 0 when its band was disabled, so the Core mirrors that). It raises the
  chain's `LatencyChangeSignal` (generic path: inline recompute; direct RPC path: the applier's service). Tests: reported == measured impulse
  delay == `Core::latencyFor` for every tier at 48 and 96 kHz; chain PDC follows engine, quality and band on / off at 48 and 96 kHz through
  both paths; `spectral_quality` on a Legacy EQ moves nothing.
- **Latency window.** A quality change is `Core::requestTier()` on the audio thread (never prepare / reset): the core holds the old tier until
  the new one's overlap-add is complete, then crossfades (9.2): the output reaches the published latency **<= 3 hops of the new tier + 5 ms
  after the request** (about 37 ms at 48 kHz going to High). A structural change's output fades out within 5 ms (+ at most one block), so the
  chain is compensated for the new latency while the old structure fades; after the switch the new structure's output starts after its own
  latency, on the new compensation. Automation writes the parameter atomics without `onParameterValueChanged`: an automated engine / quality
  change moves the audio but not the PDC (the base class's existing contract).
- **Bypass** keeps the latency on both engines (as Legacy did). On the Core the bypassed output is the core's aligned dryOut
  (`usesLatencyAlignedBypassDry`, computed for the next block, latched per block, faded with structural transitions), so the bypassed track
  stays aligned. Legacy keeps the base class's live-input bypass (unaligned by 4096 while bypassed), unchanged. Cost: the core keeps running
  while bypassed.
- **Cost when unused: zero.** The core is processed only while it is the active structure (test: Core engine without a Spectral band, and
  Legacy with one: 0 core frames). The per-block parameter snapshot (11.2) is the locking fix's, not the core's.

### 11.8 Hop phase, meters, display

- Hop phase: `Core::hopPhaseOffsetForInstance(index, hop)` with `index` from the **EQ's own** static counter (the RS keeps its own:
  neither numbering moves; test: an EQ prepared between two RS instances leaves their indices consecutive). `setCoreInstanceIndex()` pins it
  (tests and bench pin 0). EQ and RS instances in one thread can therefore share an offset.
- Per-band meter (`eqGetBandGR`): schema and scale unchanged (signed dB, negative = cut); on the Core a band shows the deepest applied cut
  over the grid bands its region owns, from the core's last frame. Upward / inert bands read 0.
- The EQ feeds no display from the Spectral path: the pre / post spectrum taps are unchanged. What the display does NOT show on the Core (left
  for the UI phase, not changed): a Spectral band is still drawn as its plain bell at its gain on the **Stereo** trace (`foldChannelForContext`
  folds Spectral routing for the curve), while the Core routes it, caps it at 24 dB, renders upward bands as nothing and shares detector
  settings.
- Telemetry: realtime section `eq_core`.

### 11.9 Bench subjects EQS-*

The EQ with `spectral_engine` = Core and one Spectral band at -24 dB (core depth 1, Hard), `spec_attack` / `spec_release` 15 / 200 ms (the core
defaults), `spec_sens` / `spec_sel` default (core sensitivity 0.5 exactly), the weight curve opened (`setSpectralCoreFlatWeightsForBench`: one
band covering the whole range; no user setting produces a flat region, bells only) and stereo link 0: **EQS-F / EQS-N / EQS-H = the C1c-F /
-N / -H settings through the EQ**, graded on every gate. EQSl-* = the same at the EQ's default link 1 (characterisation, G3 / G9a not graded).
EQSb-N = EQS-N with three 0 dB bells in the EQ's biquad path (diagnostic). G4 companions EQSs-* / EQSsl-* (`spec_sens` 0 = core sensitivity
1). The named G1 100 Hz waiver is not extended to them (no gate or waiver was changed), so their raw G1 100 Hz cell counts.

Default seed (`--subjects EQS-F,EQS-N,EQS-H,EQSl-F,EQSl-N,EQSl-H,EQSb-N,C1c-F,C1c-N,C1c-H`, CPU on), EQS-N against C1c-N:

| gate | C1c-N | EQS-N | why they differ |
|---|---|---|---|
| G1 in-window | 11/12 raw, 100 Hz WAIVED -> pass | **FAIL 11/12** (100 Hz 3.45 vs limit 2.10) | identical value (3.45 dB): the core's sub-bin ceiling (section 4). The named waiver lists C1c / C1c-N / C1c-H / RSC-* only and was not extended (no waiver changed) |
| G2, G1q / G2q / G1l / G2l | 12/12, 3/3, 3/3, 2/2, 2/2 | same | |
| G3 R-only | PASS (L 12/12, L in-window -0.00) | PASS, same values | link 0 |
| G4 jitter | PASS (C1s: std 0.156, isolated 3.9e-5) | PASS (EQSs-N: 0.156, 3.9e-5) | identical |
| G5 pre-echo | -1.475 / -3.180 dB | same | |
| G6 latency | 1024 / 1024 at 48 and 44.1 kHz | same | |
| G7 CPU vs S3 (<= 1.05) | PASS 0.8515 / 0.8041 | PASS 0.8619 / 0.8187 | the EQ layer around the core (+1.2 % / +1.8 %: the parameter snapshot, the dry copy, the per-band meter scan, the empty biquad pass, the spectrum taps) |
| G8a / G8b / G9a / G9b | 6/6, 6/6, 9/9, 9/9 | same, same values (tau_fit 228.4 ms) | |
| overall | PASS (1 waiver) | FAIL (G1 100 Hz unwaived only) | |

EQS-F == C1c-F and EQS-H == C1c-H in the same way (C1c-F fails G8a 5/6 and G9a 8/9 itself; EQS-H fails only the unwaived G1 100 Hz;
G7 EQS-F 0.9279 / 0.8826, EQS-H 0.9218 / 0.8753). **Every non-CPU CSV value of EQS-F / -N / -H equals C1c-F / -N / -H** (scan, residual scan,
shape scan, right-only, jitter, pre-echo D / D2, delta artefact, latency, block size, time-varying): the wiring is exact. The rendered WAVs
of EQS-H are byte-identical to C1c-H's; those of EQS-F / -N differ by at most 1 LSB of 24 bits in 0.2 - 1.7 % of the samples, because the
EQ's `spec_attack` parameter returns 15 ms through its APVTS range (0.1 - 100) as 15.000001 ms (the release 200 ms and the gain -24 dB round
trip exactly).

EQSb-N (three 0 dB bells in the biquad path) is bit-identical to EQS-N in every CSV and WAV: a flat RBJ bell is an exact identity in the
EQ's float DF-II-T (b = a after normalisation), so the EQ's other bands, flat, change nothing; G7 0.8800 / 0.8376 (three more biquads per
sample).

EQSl-* (the EQ's default link 1) behave like RSC-* (10.8): G3 L 0/12 (L in-window -6.78 dB: an R-only resonance is cut on both channels, by
design of link 1) and G9a 7/9 / 7/9 / 8/9 (not graded), but G1 is LOWER below 1 kHz (100 Hz 2.22, 150 Hz 1.02 vs 3.45 / 1.94 dB: max of two
detectors), G4 std 0.203 (EQSsl-N), G5 -1.737 / -3.563 dB, G7 0.8723 / 0.8242.

Dev seeds 1..6 (`--seedset dev --no-cpu`; the held-out seeds were not run). Robust verdicts (a gate passes only if it passes on every seed;
the named waiver applies to C1c-N / C1c-H only):

| subject | seeds passing | gates failing on at least one seed |
|---|---:|---|
| C1c-F | 1/6 | G3 5/6, G8a 1/6, G9a 4/6 |
| C1c-N | 1/6 | G1 1/6 (150 Hz worst 2.270 vs 2.074; 100 Hz waived 6/6), G8a 1/6 (500 Hz / D 1000 worst 144 ms) |
| C1c-H | 1/6 | G8a 1/6 (100 Hz waived 6/6) |
| EQS-F | 1/6 | G3 5/6, G8a 1/6, G9a 4/6 (= C1c-F) |
| EQS-N | 0/6 | G1 0/6 (100 Hz unwaived: worst 3.564, median 3.326; 150 Hz = C1c-N), G8a 1/6 (= C1c-N) |
| EQS-H | 0/6 | G1 0/6 (100 Hz unwaived: worst 3.776), G8a 1/6 (= C1c-H) |
| EQSb-N | 0/6 | identical to EQS-N in every cell |
| EQSl-F | 6/6 graded | not graded: G3 0/6, G9a 0/6 (500 Hz / D 1000 worst 1.239) |
| EQSl-N | 5/6 graded | G1 5/6 (100 Hz unwaived, worst 2.308 vs 2.096); not graded: G3 0/6, G9a 3/6 |
| EQSl-H | 0/6 graded | G1 0/6 (100 Hz unwaived, worst 2.794); not graded: G3 0/6, G9a 5/6 |

**Every one of the 95 per-seed cells of EQS-F / -N / -H has the same values (seeds passing, worst seed, worst / median / min / max) as
C1c-F / -N / -H**; the only differences are the waiver column (G1 100 Hz) and the G4 companion's name. So on dev seeds, as on the default
seed, the EQ's integration is exact and every EQS-vs-C1c verdict difference is the unextended waiver. The default link 1 (EQSl-*) does what
it did for the RS: it fixes C1c-N's two seed-dependent weaknesses (G1 150 Hz 6/6, worst 1.212; G8a 500 Hz 6/6, worst 93 ms) and lowers the
100 Hz residual (EQSl-N median 2.021 vs 3.326 dB), and costs G3 (by definition) and G9a. Whether the EQ should keep link 1 as its Core
default is a product decision for the UI phase; nothing was retuned.

### 11.10 Legacy is bit-identical (how it was checked)

- `testEQLegacyBitIdentity`: 64-bit FNV-1a of every output sample, every band's GR meter and the reported latency after every block, for five
  default-engine scenarios (mixed Spectral cut + upward band + Left / Mid bells + Dynamic Side band at 48 kHz; 44.1 kHz with smoother ramps;
  events: Spectral off -> on, linear phase on / off, bypass / un-bypass, mode change, state restore, remove / add, reset, oversampling;
  mono; 96 kHz). The hashes were recorded from the pre-[EQCore] EQ; every commit reproduces them.
- Every pre-existing check prints the same numbers (`test_effects`, `test_pdc_stage1` including [EQSpliceFix] / [EQBypassFix],
  `test_effect_processblock_alloc`, `test_effect_audio_thread_reset`, `test_effect_chain_commands`, `test_mix`).
- Bench S5 / S5s / S5z / S5qz / S5c / S5q / S5qd (`--no-cpu`): 62 files, byte-identical to the pre-change binary except summary.md's run
  directory / git hash lines.
- Bridge `probe_eq_chain_pdc.js` 14/14, `test_eq_channel_routing.js` 31/31.

### 11.11 Limitations (for the UI phase)

- Upward Spectral bands cannot run on the Core; routed Spectral bands that disagree run Stereo; detector settings are shared (11.4).
- Depth is capped at 24 dB on the Core (Legacy 30).
- The stereo link is fixed at 1 (bench override only); exposing it is a product decision (the RS default 100 % traded G3 / G9a for G1 / G8a,
  10.8).
- No user setting gives a flat (whole-range) region: regions are bells, as in Legacy.
- Bypassed while Legacy and switched to Core while still bypassed: the switch happens after the un-bypass (a bypassed Legacy EQ is not
  processed), with the structural fade; PDC already moved at the request.
- The 96-band grid limits a region's resolution (about 55 Hz at 1 kHz, a third of an octave below 100 Hz); below 400 Hz the core's
  per-bin path still reduces a marginal (about 1 sigma) low-frequency resonance only partly, because the knee scales the cut (section 4).
