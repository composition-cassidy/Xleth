# UniFlange — implementation handoff

**Target:** a new stock effect for XLETH, modelled on Fruity Flangus (Didier Dambrin, Image-Line).
**Audience:** an implementing model/engineer with no prior context on this work.
**Status of the analysis:** two rounds of black-box measurement complete. Topology and the
stereo/gain stages are solved. Five parameter mappings remain unfitted and are marked as such.

Read section 1 and section 9 before writing any code. Section 9 is the list of mistakes that
this analysis specifically ruled out, and each one is the kind that stays hidden until late.

---

## 1. What you are building, in one paragraph

Flangus is **not a flanger**, despite the name. It has no feedback path. It is a **unison /
ensemble generator**: N parallel modulated delay taps, each read from a shared delay line with
2-point linear interpolation, each panned into the stereo field, summed, then passed through a
plain unnormalised 2×2 stereo cross-mix, then blended with dry. Everything in that sentence
was measured, not assumed. Build exactly that shape and the remaining work is fitting five
scalar curves.

```
        mono/stereo in
              │
              ▼
     ┌────────────────────┐
     │  shared delay line │   (linear interpolation, NO feedback)
     └────────┬───────────┘
              │  N taps, each with its own LFO (rate/depth/phase from SPREAD)
              ▼
     tap_i  ──►  pan (p_L, p_R)  ──►  Σ  ──►  wet_L, wet_R
              │
              ▼
     ┌──────────────────────────────┐
     │ cross:  [[1, c], [c, 1]]     │   c = CROSS/100, unnormalised
     └────────┬─────────────────────┘
              ▼
       dry·DRY/100 + out·WET/100
```

---

## 2. Source material and provenance

All measurements come from black-box renders of Fruity Flangus in FL Studio, bounced by the
project owner. No decompilation, no reverse-engineering of binaries — only input/output
analysis of audio the user rendered themselves.

**Round 1 probe:** 523.2511 Hz (C5) square wave, mono content, peak 0.325, 44.1 kHz / 16-bit
stereo, 0.857 s (37 800 frames). Odd harmonics only.
**Round 2 probe:** 523.251 Hz (C5) sawtooth, same format and length. All harmonics.

| file | order | depth | speed | delay | spread | cross |
|---|---|---|---|---|---|---|
| `wetonly – order 1 …` (square) | 1 | 50 | 75 | 0 | 100 | −25 |
| `wetonly – order 2 …` (square) | 2 | 50 | 75 | 0 | 100 | −25 |
| `wetonly – order 4 …` (square) | 4 | 50 | 75 | 0 | 100 | −25 |
| `saw-wetonly … speed 0, delay 0` | 4 | 50 | 0 | 0 | 100 | −25 |
| `saw-wetonly … speed 0, delay 100` | 4 | 50 | 0 | 100 | 100 | −25 |
| `saw-wetonly … speed 100, delay 100` | 4 | 100 | 100 | 100 | 100 | −25 |

All renders are wet-only (DRY = 0, WET = 100).

**Manual text (Image-Line), for the parameter semantics:**
- *Order (ORD)* — number of "stacked" flangers. More = smoother, richer.
- *Depth* — amplitude of pitch oscillation for each stacked flanger.
- *Speed* — speed of pitch oscillation.
- *Delay* — "variable amounts of delay can be applied to **each** of the stacked flangers; use
  this to define the overall amount of delay applied."
- *Spread* — "each flanger is assigned a different speed, depth, etc. in a range defined by the
  basic properties. Increase SPRD to smooth the spreading of the stacked flangers across the
  parameter ranges."
- *Stereo Cross* — mixes L into R and vice versa, range −100…100; negative mixes inverted.
- *Dry / Wet* — range −100…100 each; negative inverts.

---

## 3. The measurement technique that mattered

Both probes are periodic, which makes every frequency-domain delay estimate ambiguous modulo
the probe period (1.911 ms). The thing that broke it open:

**The delay buffers start empty.** Each render begins at t = 0 with an unfilled delay line, so
the wet output is silent until the shortest tap delay elapses, then steps up as each further
tap comes online. That onset staircase yields **absolute** tap delays and the full 2×N gain
matrix, with no modulo ambiguity and no phase unwrapping.

This is why the numbers in section 4 are trustworthy: the onset method and the round-1
frequency-domain method are unrelated estimators, and they agree to within 0.04 ms.

---

## 4. CONFIRMED — port these verbatim

### 4.1 No feedback

After un-mixing the cross, the single-voice transfer magnitude at 523 Hz is **0.9374 ± 0.0002**
across the entire delay sweep. A regeneration path cannot produce that — feedback makes |H|
swing between 1/(1+k) and 1/(1−k) as the delay moves through the comb. Flat to 0.02 %.

**No feedback anywhere.** No allpass regeneration, no cross-feedback, nothing recirculating.

### 4.2 The stereo cross matrix

The order-1 square render contains exactly two taps, making it a clean 2-source / 2-sensor
problem. Joint fit over samples 560–2000, residual 2.518 %:

```
out_L = +0.93679 · v1  − 0.23448 · v2
out_R = −0.23417 · v1  + 0.93783 · v2
```

- **L→R leak = −0.24997, R→L leak = −0.25002.** Symmetric to five decimals, from a knob at −25 %.
- Therefore: `c = CROSS / 100`, exactly, applied as a plain 2×2 mix.

```
out_L = wet_L + c · wet_R
out_R = wet_R + c · wet_L
```

**No normalisation.** No `1/(1+|c|)`, no `1/√(1+c²)`, no rotation. At CROSS = ±100 this has
+6 dB of gain and will clip. That is the real behaviour.

### 4.3 Per-voice gain at order 1 = 0.9373

Measured flat versus frequency from 523 Hz to 19.36 kHz once the interpolator rolloff is
divided out (0.9384 / 0.9383 / 0.9380 at 13.1 / 16.2 / 19.4 kHz; 0.9374 at 523 Hz). It is a
gain, not a filter.

An earlier hypothesis that this was `1 − c² = 0.9375` (cross normalisation) is **dead** — the
matrix diagonal in §4.2 is itself 0.937, so the two cannot be the same factor.

### 4.4 Delay taps use 2-point linear interpolation

The high-harmonic magnitude ripple is fitted by `|(1−f) + f·e^{−jω}|` where `f` is the
fractional part of the delay in samples:

| harmonic | freq | residual, linear-interp model | residual, flat model |
|---|---|---|---|
| 25 | 13 081 Hz | **1.74 %** | 16.47 % |
| 31 | 16 221 Hz | **2.64 %** | 28.69 % |
| 37 | 19 360 Hz | **3.61 %** | 45.56 % |

The recovered fractional offset came out as **0.12 at all three harmonics independently** —
the same physical quantity measured three times.

Consequence: linear interpolation costs ~5.5 dB at 16 kHz at the worst fractional phase, and
**that loss moves with the LFO**. A large part of Flangus's soft, smeared character is this
artefact. It is not a static tone difference you can EQ back.

`juce::dsp::DelayLine<float, juce::dsp::DelayLineInterpolationTypes::Linear>` implements
exactly this.

### 4.5 Voices are PANNED, not assigned to a channel

The single most important structural finding, and the one most likely to be got wrong.

In both order-4 saw renders the first arrival is a **single tap** whose raw channel gains are:

| render | tap 1 delay | raw L gain | raw R gain | R/L |
|---|---|---|---|---|
| depth 50, speed 0, delay 100 | 0.6719 ms | +0.52671 | −0.03292 | −0.062500 |
| depth 100, speed 100, delay 100 | 1.8639 ms | +0.52671 | −0.03292 | −0.062500 |

Removing the confirmed cross matrix gives pre-cross gains of **0.5531 (L) and 0.1053 (R) for
one and the same physical tap.**

Two facts make this airtight rather than coincidence:

1. The gains are **identical to five decimal places across two renders with different DEPTH and
   different SPEED.** Pan is a function of voice index and SPREAD only; DEPTH and SPEED do not
   touch it.
2. Tap 2 (at 26.77 ms) carries the **mirrored** pair (0.105 L / 0.553 R). The ladder is
   symmetric about centre.

A voice is **one delay-line read**, panned into both outputs. It is not a left voice and a
right voice.

(For completeness: if you instead assume voices are hard-assigned to banks, you are forced to
conclude `c = −0.0625` for the saw renders and `c = −0.25` for the square one, from the same
knob position. That contradiction is what this measurement resolves.)

### 4.6 Order 1 produces TWO taps

Absolute delays at t = 0: **12.1100 ms** and **0.1855 ms**, panned hard-right and hard-left
respectively (pan gains 0.0086/0.9389 and 0.8136/0.0142 after cross removal).

So `order` is **not** a raw voice count — order 1 already yields a stereo pair. Current working
assumption is `n_voices = 2 × order`, which is consistent with everything measured but has only
been verified at order 1. The impulse render in §8.1 confirms or kills it in one bounce.

### 4.7 SPEED = 0 % does not stop the LFO

Taps still drift at **≈ 3.2 samples/s (0.073 ms/s)** in the SPEED = 0 renders — about 2 samples
across the file. There is no true freeze. Whatever curve you fit for `map_speed()` must have a
non-zero floor, and "park the LFO and measure statically" is not an available technique.

### 4.8 DELAY sets voice *spacing*, not a common offset

| DELAY | tap 1 | remaining taps |
|---|---|---|
| 0 % | 0.596 ms | clustered: ~1.3 / 2.1 / 3.0 ms |
| 100 % | 0.672 ms | tap 2 at **26.77 ms** |

Tap 1 barely moves; DELAY fans the later voices outward. This matches the manual's phrasing
("delay can be applied to *each* of the stacked flangers") literally. A naive
`base_delay + offset` implementation will be wrong in precisely the way that destroys the
unison character.

### 4.9 Output does not scale as √N with order

Measured RMS (dry RMS = 0.2741):

| order | wet RMS L | wet RMS R | ratio vs order 1 |
|---|---|---|---|
| 1 | 0.2554 | 0.2570 | 1.000 |
| 2 | 0.2875 | 0.3344 | 1.126 |
| 4 | 0.3044 | 0.3640 | 1.192 |

An unnormalised parallel sum of N decorrelated taps grows by √N (1.414, 2.000). It grows by
1.126 and 1.192. So a per-voice normalisation between `N^(−1/4)` and `N^(−1/2)` exists.
Not resolvable from a single-pitch probe (taps are partially coherent, which corrupts the RMS
arithmetic) — see §8.

---

## 5. UNKNOWN — do not trust the placeholder constants

| # | Unknown | What is actually known | Blocker |
|---|---|---|---|
| 1 | `SPEED % → Hz`, and the LFO waveshape | SPEED 75 ⇒ period > 1.7 s; SPEED 0 ⇒ ≈ 0.03 Hz, not zero | No render contains a full LFO cycle. Every file is 0.857 s. |
| 2 | `DEPTH % → ms` | At DEPTH 50 / SPREAD 100 / order 1 the two voices swung **1.749 ms** and **2.332 ms** peak-to-peak (ratio exactly 4/3) | Only 50 % and 100 % seen, never isolated from SPREAD |
| 3 | `DELAY % → spacing` | Two points, §4.8 | No intermediate values |
| 4 | Per-voice gain vs order | 0.9373 at order 1; voice 1 of 4 has pan gains summing to 0.6584 | One voice of four measured |
| 5 | Pan ladder vs SPREAD | Symmetric about centre; independent of DEPTH/SPEED | Only SPREAD = 100 % ever rendered |

Every one of these is blocked by render length and single-point sweeps — **not** by analysis
technique. Section 8 lists exactly what to render to close them.

Additional smaller unknowns: whether DRY/WET knobs are linear in percent (assumed yes,
negative = polarity inversion per the manual), and whether the input is summed to mono before
the delay line (assumed yes; all probes were mono so it is untested).

---

## 6. Runnable reference model (Python)

This is a specification you can execute, not a shipping DSP core. Blocks marked
`[CONFIRMED]` should be ported verbatim; `[UNKNOWN]` blocks have correct units and wrong
constants.

```python
import numpy as np

MAX_DELAY_MS = 40.0
WET_GAIN_ORDER1 = 0.9373      # [CONFIRMED] flat vs frequency, 523 Hz .. 19.4 kHz


def map_depth(depth_pct):
    """DEPTH% -> peak LFO excursion, ms.  [UNKNOWN]
    Anchor: DEPTH 50 / SPREAD 100 / order 1 gave 1.749 ms and 2.332 ms peak-to-peak
    for the two voices, so depth is per-voice and scaled by the spread ladder."""
    return 0.035 * depth_pct                                   # GUESS, linear


def map_speed(speed_pct):
    """SPD% -> LFO rate, Hz.  [UNKNOWN]
    Hard constraints: SPEED 75 -> period > 1.7 s; SPEED 0 -> ~0.03 Hz, NOT zero."""
    return 0.03 + 0.05 * (200.0 ** (speed_pct / 100.0))        # GUESS


def map_delay_spacing(delay_pct):
    """DEL% -> inter-voice delay SPACING, ms.  [INFERRED shape, UNKNOWN constants]
    NOT a common base offset.  Voice 1 sits at 0.596 ms (DEL 0) vs 0.672 ms (DEL 100)
    -- essentially unmoved -- while voice 2 moves from ~1.3 ms to 26.77 ms."""
    return 0.7 + 0.26 * delay_pct                              # ~0.7 -> ~26.8 ms


def voice_layout(n_voices, spread_pct, delay_pct, depth_pct):
    """Per-voice (delay_centre_ms, depth_ms, lfo_phase_turns, pan).  [UNKNOWN]
    Anchors: order 1 -> two taps at 12.1100 and 0.1855 ms (DEL 0, SPREAD 100);
    order 4 DEL 100 SPREAD 100 -> voice 1 pan (0.5531, 0.1053), voice 2 the mirror.
    Pan is independent of DEPTH and SPEED.  pan is in [-1, +1]."""
    n = max(int(n_voices), 1)
    idx = np.arange(n)
    frac = idx / max(n - 1, 1) if n > 1 else np.array([0.5])

    spacing = map_delay_spacing(delay_pct)
    centres = 0.65 + spacing * frac                                # GUESS
    depths  = map_depth(depth_pct) * (1.0 + 0.33 * (frac - 0.5))   # GUESS (4/3 ratio)
    phases  = frac * (spread_pct / 100.0) * 0.5                    # GUESS
    pans    = (2 * frac - 1) * (spread_pct / 100.0)                # GUESS
    return centres, depths, phases, pans


def pan_gains(pan):
    """pan in [-1,+1] -> (gL, gR).  [UNKNOWN law, one data point]
    The single measured voice gave (0.5531, 0.1053): sum 0.6584, quadratic norm 0.5630.
    Neither matches a textbook constant-power or constant-gain law against the order-1
    figure of 0.9373, so pan law and per-voice normalisation are still entangled."""
    a = (1.0 - pan) * 0.5
    return a, 1.0 - a


def voice_gain(n_voices):
    """Overall per-voice gain before panning.  [UNKNOWN]
    order 1 -> 0.9373 (confirmed).  Output RMS grows 1.126x (order 2) / 1.192x (order 4)
    against the sqrt(N) an unnormalised sum would give."""
    return WET_GAIN_ORDER1 / (max(int(n_voices), 1) ** 0.33)   # GUESS


class UniFlange:
    def __init__(self, sr=44100.0, order=4, depth=50.0, speed=75.0,
                 delay=0.0, spread=100.0, cross=-25.0, dry=0.0, wet=100.0):
        self.sr = float(sr)
        self.order = int(order)
        self.p = dict(depth=depth, speed=speed, delay=delay, spread=spread,
                      cross=cross, dry=dry, wet=wet)

    def process(self, x):
        x = np.asarray(x, dtype=np.float64)
        if x.ndim == 1:
            x = np.stack([x, x], axis=1)
        n, sr = len(x), self.sr
        t = np.arange(n) / sr

        n_voices = 2 * self.order              # [INFERRED] order 1 gave 2 taps
        centres, depths, phases, pans = voice_layout(
            n_voices, self.p['spread'], self.p['delay'], self.p['depth'])
        rate = map_speed(self.p['speed'])
        g = voice_gain(n_voices)

        mono = x.mean(axis=1)
        wet = np.zeros((n, 2))
        for i in range(n_voices):
            d_ms = centres[i] + depths[i] * np.sin(2*np.pi*(rate*t + phases[i]))
            v = g * _read_linear(mono, np.maximum(d_ms, 0.0) * sr / 1000.0)
            pl, pr = pan_gains(pans[i])
            wet[:, 0] += pl * v
            wet[:, 1] += pr * v

        c = self.p['cross'] / 100.0            # [CONFIRMED] exact, unnormalised
        out = np.empty_like(wet)
        out[:, 0] = wet[:, 0] + c * wet[:, 1]
        out[:, 1] = wet[:, 1] + c * wet[:, 0]

        return (self.p['dry'] / 100.0) * x + (self.p['wet'] / 100.0) * out


def _read_linear(buf, delay_samples):
    """2-point linear interpolated tap.  [CONFIRMED interpolator]"""
    n = len(buf)
    idx = np.arange(n) - delay_samples
    i0 = np.floor(idx).astype(np.int64)
    fr = idx - i0
    i1 = i0 + 1
    s0 = np.where((i0 >= 0) & (i0 < n), buf[np.clip(i0, 0, n - 1)], 0.0)
    s1 = np.where((i1 >= 0) & (i1 < n), buf[np.clip(i1, 0, n - 1)], 0.0)
    return (1.0 - fr) * s0 + fr * s1
```

---

## 7. XLETH integration constraints

XLETH's engine is **C++ with JUCE 8**, Windows-only, running in a forked child process. The
effect slots into the existing stock-effects system alongside the other 15.

**Hard rules from the project (non-negotiable):**
- **Audio thread: no allocation, no locks, no logging.** Delay lines and voice state are
  allocated in `prepareToPlay` and never resized during `processBlock`.
- Debug instrumentation gated behind `#ifdef XLETH_DEBUG`, with a bracketed prefix
  (`[UniFlange]`) so it can be grepped out of logs.
- Build with `build.bat`; after any C++ change, `build.bat bridge-clean` is mandatory —
  stale `.node` binaries produce false "still broken" reports.
- Commit after every successful build, one logical unit per commit.

**Implementation notes:**

- **Delay-line capacity.** Confirmed delays reach ~27 ms and DELAY = 100 % may push further.
  Size for `MAX_DELAY_MS = 40` plus the maximum LFO excursion plus one sample of interpolation
  headroom, at the highest supported sample rate. Round up to a power of two and mask the
  read index rather than branching.
- **One shared delay line, N read taps.** Do not allocate a line per voice. All voices read the
  same buffer at different offsets; this is both cheaper and structurally correct.
- **Mono sum before the line** (assumed — see §5). One write per sample, N reads.
- **LFO.** Rates are sub-Hz. A per-sample phase accumulator is affordable but unnecessary;
  updating the delay target every 16–64 samples and linearly interpolating the delay time in
  between is inaudible at these rates and much cheaper. Do **not** apply generic parameter
  smoothing on top of the LFO output — you will filter the modulation itself.
- **Parameter smoothing** is still needed on the *user* parameters (DEPTH, DELAY, SPREAD, CROSS,
  DRY, WET) to avoid zipper noise. `juce::SmoothedValue` with a ~20 ms ramp. Note that smoothing
  DELAY changes pitch transiently — that is correct and matches a real delay line.
- **Order changes** alter the voice count. Pre-allocate the maximum voice count and ramp
  per-voice gains in and out over ~20 ms rather than switching hard, or the order knob clicks.
- **Denormals.** There is no feedback, so no denormal accumulation in a recirculating path, but
  still set FTZ/DAZ (`juce::ScopedNoDenormals`) since the tail of a decaying input through
  N taps can still produce subnormals.
- **CROSS clipping.** The matrix is unnormalised and reaches +6 dB at ±100. Reproduce the
  coefficient exactly, but expose an optional output trim so an already-hot Sparta chorus stack
  doesn't blow up. See §10.
- **Interpolation quality switch.** Ship `LEGACY` (2-point linear, matches Flangus, required for
  null-testing) and `HQ` (higher-order tap) as a mode. Default new instances to whichever you
  prefer, but `LEGACY` must exist or you can never validate against the reference.

---

## 8. Closing the five unknowns

The unfitted maps in §5 need one more round of renders. This is the highest-value work
remaining and it is mechanical once the files exist.

### 8.1 The single highest-leverage file: a click test

One full-scale sample (or 1 ms of noise) at t = 0, then 2 seconds of digital silence.
`order 4, spread 100, delay 50, cross 0`.

The wet output **is** the impulse response. Every tap delay, tap gain and pan position reads
straight off the waveform with zero estimation. It settles unknowns #4 and #5 outright and
verifies the `n_voices = 2 × order` assumption. One bounce.

Repeat once per ORDER value (1…8) if bounces are cheap — that turns unknown #4 from a fit into
a direct read.

### 8.2 The sweeps

**Probe:** white noise, full band, fixed seed, bounced once and reused for every render.
**Length: ≥ 12 seconds.** This is the requirement that has been missed twice and it is the one
that blocks the LFO entirely — 0.857 s does not contain a full cycle at any tested speed.
**CROSS = 0** throughout; it adds nothing and complicates every fit.

Hold at `order 4, depth 50, speed 50, delay 50, spread 50, cross 0, dry 0, wet 100`, sweep one
parameter at a time:

| # | sweep | values | closes |
|---|---|---|---|
| A | DEPTH | 0, 25, 50, 75, 100 | #2 |
| B | SPEED | 0, 25, 50, 75, 100 | #1 |
| C | DELAY | 0, 25, 50, 75, 100 | #3 |
| D | SPREAD | 0, 25, 50, 75, 100 | #5 |
| E | ORDER | 1, 2, 3, 4, 5, 6, 7, 8 | #4 |
| F | DRY/WET | (100,0), (−100,0), (0,−100) | polarity/knob law |

32 files. Format: 44.1 kHz, **32-bit float** (16-bit costs you ~3 dB of null depth for free),
no limiter or dither on the master, Flangus alone on the chain.

### 8.3 Analysis harness

`flangus_probe.py` (shipped alongside this document) already ingests all of the above. Key
entry points:

- `onset_taps(dry, wet, sr)` — **primary estimator.** Absolute tap delays + full 2×N gain
  matrix from the onset staircase. Caveats: taps arriving within ~1 ms of each other cannot be
  separated (use the click test); a tap whose delay sweeps far during the render may appear as
  two adjacent entries with the same pan — read the pan column, not the tap count.
- `solve_cross(dry, wet, sr)` — recovers `c` by finding the value that makes the un-mixed
  single-voice magnitude flat.
- `unpan(gl_i, gr_i, c)` — removes the cross matrix from one tap's channel gains, giving true
  pan gains.
- `identify_interpolator(...)` — linear vs flat vs allpass discrimination.
- `fit_lfo(...)` — globally-optimal sinusoid fit (linear in the coefficients for fixed rate).
  **It self-reports degeneracy**: if it returns `degenerate=True`, the render is shorter than
  one LFO cycle and the answer is meaningless. Do not paper over that flag.

One implementation warning, learned the hard way: on a periodic probe with a *moving* tap, a
naive onset detector locks onto probe-period comb aliases (spaced at half the probe period,
alternating sign) and reports them as real taps. The shipped version refits existing tap
delays for drift *before* testing for a new arrival, and requires a candidate to explain
>30 % of the local signal. Keep both guards if you touch it.

---

## 9. DO NOT — each of these was specifically ruled out

1. **Do not add feedback / regeneration.** §4.1. The name says flanger; the measurement says
   there is none.
2. **Do not build two independent per-channel banks.** §4.5. Voices are panned reads of a
   shared line. This mistake stays invisible until you try to null and cannot.
3. **Do not normalise the cross matrix.** §4.2. No `1/(1+|c|)`, no `1/√(1+c²)`. It really does
   reach +6 dB.
4. **Do not treat DELAY as a common base offset.** §4.8. It sets inter-voice spacing.
5. **Do not assume SPEED = 0 stops the LFO.** §4.7. It drifts at 0.073 ms/s.
6. **Do not substitute higher-order interpolation in LEGACY mode.** §4.4. The linear-interp HF
   loss is delay-dependent, so it modulates; it is part of the sound, not an artefact to fix.
7. **Do not ship the `[UNKNOWN]` constants in §6 as if they were measured.** They have correct
   units and wrong values. Gate them behind §8 or behind an explicit "not yet matched" note.
8. **Do not compress the delay range for tidiness.** ~0.2–27 ms with spread fanning voices
   apart is what makes Flangus read as *unison* rather than *chorus*. Narrowing it loses the
   plugin's identity.
9. **Do not trust a completion report over a measurement.** Verify with a null test (§10),
   not by reading the diff.

---

## 10. Verification plan

**Unit-level (fast, deterministic, run in CI):**

1. **Cross matrix exactness** — feed an impulse into one bank only, assert
   `out_R / out_L == CROSS/100` to 1e−6.
2. **Interpolator identity** — for a static fractional delay `f`, assert the frequency response
   equals `(1−f) + f·e^{−jω}` to 1e−6.
3. **No-feedback check** — with the LFO frozen, assert `|H(f)|` is flat in time to 1e−6 for a
   static delay. Any drift means a recirculating path crept in.
4. **Pan invariance** — assert pan gains do not change when DEPTH or SPEED change. §4.5.
5. **Delay-line bounds** — fuzz DELAY/DEPTH/SPREAD at extremes and assert no read index escapes
   the buffer at every supported sample rate.

**System-level (the one that actually matters):**

**Null test.** Render the identical probe through Fruity Flangus and through UniFlange at
matched settings, subtract, and measure null depth in dB relative to the Flangus render.

- Right now, with the §5 maps unfitted, expect only a **structural** match — the topology
  should be right but the parameter values will not line up. Do not chase a deep null yet.
- Once §8's renders are analysed and the maps are fitted, target **better than −40 dB** on the
  order-1 case (the fully-solved one), degrading gracefully with order.
- Test at CROSS = 0 first. Cross is confirmed and only adds a source of confusion during
  debugging.

**Perceptual check.** On real Sparta chorus material at 140 BPM: the effect should read as
*unison thickening*, not as a sweeping comb. If you hear a jet-plane whoosh, feedback has
crept in somewhere or the delay range has been compressed.

---

## 11. Companion files

- `uniflange_ref.py` — the runnable reference model in §6, with all CONFIRMED/UNKNOWN tags.
- `flangus_probe.py` — the measurement harness described in §8.3.
- `FLANGUS_FINDINGS.md` — the full two-round analysis log, including the measurements that
  were discarded and why.

## 12. Provenance note

Every figure in this document came from black-box analysis of audio renders produced by the
project owner from their own licensed copy of FL Studio. No plugin binary was disassembled,
decompiled, or otherwise inspected. UniFlange should be an independent implementation informed
by these behavioural measurements — not a port of anyone's code.
