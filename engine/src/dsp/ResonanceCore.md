# ResonanceCore

`engine/src/dsp/ResonanceCore.{h,cpp}`, namespace `xleth::dsp::resonance`.

A self-contained spectral resonance suppressor core: it finds narrow spectral peaks that stand out of the local
spectrum (a ringing room mode, a whistle, a harsh formant), and attenuates exactly those bands, per channel, with a
real zero-phase gain applied through a weighted overlap-add (WOLA) transform. It has no `juce::AudioProcessor` or
APVTS dependency: it is driven with raw channel pointers and a plain parameter struct, so it can be unit-tested and
benchmarked without an engine. As of this document it is **not wired into any effect**; the existing
`XlethResonanceSuppressorEffect` and the EQ spectral band are separate implementations.

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
7. Measured margins

## 1. Architecture

### 1.1 Frame engine

- **Frame size N** is chosen before `prepare()` with `setFrameTier()`: Fast 512, Normal 1024, High 2048 at sample rates
  up to 50 kHz, doubled for every further sample-rate octave (Normal: 2048 at 88.2 / 96 kHz), so a Normal frame is
  about 21.3 ms at any rate. Hop H = N / 4.
- **Windows:** periodic sqrt-Hann for analysis and for synthesis; the synthesis window is also scaled by the
  per-hop-phase constant 1 / sum(w^2) so that overlap-add reconstructs the input exactly (depth 0 is a pass-through
  with an error of -160 dBFS RMS, max |diff| 6e-8).
- **Latency** is exactly N samples, for every parameter value and every block size. Output is bit-identical across
  block schedules (any `numSamples >= 0` is accepted; frames are produced as the hop fills).
- **Transform:** `juce::dsp::FFT` real, forward, per-bin gain, inverse. One FFT pair per channel per hop.

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
6. **Per-band attack / release** in dB at the frame rate (one-pole), then **[1 2 1] / 4** smoothing across bands,
   then the **stereo link** (each channel blends towards max(L, R) by `stereoLink`).
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
| `focusWeight` | pointer | - | **hook, ignored**: per-band focus weight |

The bench subjects use: **C1** = defaults (depth 0.5, Soft), **C1c** = depth 1, Hard, everything else default (the
"capability" setting every gate is graded at), **C1s** = depth 1, sensitivity 1, Hard (the most sensitive and deepest
setting; the musical-noise gate G4 is graded on it).

### 2.2 Structural settings (before `prepare()`, no live change)

| setter | default | unit | effect |
|---|---|---|---|
| `setFrameTier()` | Normal | tier | N = 512 / 1024 / 2048 (window 10.7 / 21.3 / 42.7 ms at <= 50 kHz); latency = N. Nothing is retuned per tier |
| `setDetectorTimeConstantMs()` | 200 | ms | slow estimate |
| `setFastTimeConstantMs()` | 40 | ms | fast estimate; 0 disables the fast path (slow only) |

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

- **Allocation.** `prepare()` and `release()` allocate (and free) everything `process()` will ever touch; they run on a
  non-audio thread. `process()` and `reset()` **never allocate, lock, log or throw**. Unit test T4 counts `operator new`
  on the measuring thread: 0 calls with static parameters, with parameters changed before **every** block, and in a
  cold pass armed from the first block after `prepare()`.
- **`numSamples` is not limited to the prepared `maxBlockSize`;** the core consumes any block length by filling hops.
  `maxBlockSize` is accepted for interface symmetry and not used for sizing.
- **Threading.** A `Core` is **not thread-safe** and owns **no thread**. One instance per audio chain. `prepare()`,
  `release()` and the structural setters (`setFrameTier`, `setDetectorTimeConstantMs`, `setFastTimeConstantMs`) belong to a
  non-audio thread and must not run concurrently with `process()` (they take effect at the next `prepare()`). `process()`,
  `reset()` and the introspection accessors (`bandLevelDb`, `bandReductionDb`, `framesProcessed`, ...) belong to the
  processing thread; the accessors return pointers into state that the next `process()` rewrites.
- **Parameters** (`Params`) are copied by value into every `process()` call; change them freely between calls.
  `focusWeight` is ignored; if it is ever used, the pointed-to array must outlive the call.
- **`reset()`** clears all signal state (FIFOs, overlap-add, both power averages, baselines, latches, reduction
  smoothers) without touching the allocations; it is real-time safe and equals a freshly prepared instance (test T7).
  After `reset()` the detector re-enters its start-up (bias-corrected) phase.
- **Latency** is `currentLatency()` = N samples, constant for a prepared instance; report it to the host before audio runs.

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
| `--cpu-worst` | worst-case per-block CPU of C1c and S3c at blocks 64 / 128 on pink noise with a resonance toggling every 2 s; classifies C1c blocks (no frame / frame / forced baseline refresh) |
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
