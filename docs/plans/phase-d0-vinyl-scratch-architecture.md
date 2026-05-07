# Phase D.0 — Vinyl Scratch Architecture Diagnostic & Implementation Plan

> Status: design only. No production code is changed in this pass.
> Branch: `feature/clip-modulation-fx-integration`.
> Predecessor phases: A (data model) · B (pure evaluator) · C/C.1 (audible vibrato + deterministic seeding) · C.2 (vibrato UI MVP).

---

## 1. Executive summary

Phase D adds **Vinyl Scratch** — a per-clip readhead/time-warp effect — to the existing Clip Modulation FX pipeline. Unlike Vibrato (a pitch-only LFO around a forward-marching readhead), Scratch *owns* the source readhead: it can stop, reverse, ramp, and accelerate it in clip-local time.

The existing pieces line up surprisingly well:

- The **schema is already complete enough for MVP** (`ClipModulation::Scratch` + `ScratchPoint` in [TimelineTypes.h](engine/src/model/TimelineTypes.h:285)). No JSON / bridge changes are required for D.1.
- **`evaluateScratch.sourceOffsetSeconds` is the canonical, exact-for-piecewise-linear-curves time integral** of `rateMultiplier(t)` ([ClipModulationEvaluator.cpp:227](engine/src/model/ClipModulationEvaluator.cpp:227)). It already handles negative, zero, and held-past-end rates; constant-rate stop produces a frozen offset; linear ramps produce trapezoidal integrals.
- **`ClipModulatedReader` already owns the only modulated-clip read path** and already does fractional Hermite reads with per-clip seed/seek state ([ClipModulatedReader.cpp:49](engine/src/audio/ClipModulatedReader.cpp:49)). Scratch should reuse it, not fork it.
- The **recommended composition rule** is *Option A* with a small twist: Scratch defines the source readhead position from `sourceOffsetSeconds` directly (every sample), while Vibrato adds a *per-sample pitch* term that micro-resamples the source around that readhead. This eliminates Scratch's need for any persistent readhead state at all and makes seek deterministic by construction.
- Declick/smoothing belongs in the **reader** (per-clip state), not the evaluator (must remain pure). The MVP form is a one-pole rate slew + a Hann microfade triggered on direction flips.
- Scratch should activate under the same fallback policy as Vibrato (forward, unstretched, non-formant-preserve clips). Composing scratch with reverse/stretch/formant is a Phase E concern.

**Confidence in MVP feasibility:** high. No blockers were found. The single non-trivial design decision is composition with vibrato — addressed in §5.

---

## 2. Current code inventory

| Concern | File | Symbols |
|---|---|---|
| Schema (data model) | [engine/src/model/TimelineTypes.h](engine/src/model/TimelineTypes.h) | `ClipModulation` (`:262`), `ClipModulation::Scratch` (`:290`), `ClipModulation::ScratchPoint` (`:285`), `Scratch::CurveTimeMode` (`:291`), `Scratch::EdgeMode` (`:292`), `scratchTimeModeToString`/`stringToScratchTimeMode` (`:389/:398`), `scratchEdgeModeToString`/`stringToScratchEdgeMode` (`:405/:415`) |
| Pure evaluator | [engine/src/model/ClipModulationEvaluator.h](engine/src/model/ClipModulationEvaluator.h), [.cpp](engine/src/model/ClipModulationEvaluator.cpp) | `ClipModulationContext` (`:21`), `ScratchEval` (`:45`), `evaluateScratch` (`.cpp:182`), private helpers `scratchPointTimeSeconds` (`.cpp:109`), `lerpRate` (`.cpp:127`) |
| Audio reader | [engine/src/audio/ClipModulatedReader.h](engine/src/audio/ClipModulatedReader.h), [.cpp](engine/src/audio/ClipModulatedReader.cpp) | `ClipModulatedReader::renderBlock` (`.cpp:49`), `State` (`.h:106`), seed/reseed branch (`.cpp:88`), per-sample read loop (`.cpp:74`) |
| Vibrato seek seeding | [engine/src/audio/ClipVibratoIntegrator.h](engine/src/audio/ClipVibratoIntegrator.h), [.cpp](engine/src/audio/ClipVibratoIntegrator.cpp) | `VibratoSourceOffsetParams`, `computeVibratoIntegratedSourceOffsetSamples` |
| Hermite kernel | [engine/src/audio/HermiteInterp.h](engine/src/audio/HermiteInterp.h) | `hermiteSample` (4-pt cubic) |
| Activation + lifecycle | [engine/src/audio/MixEngine.cpp](engine/src/audio/MixEngine.cpp) | `useModulatedReader` predicate (`:2211`), `clipModReader_.renderBlock` (`:2239`), `markClipSeen` (`:2240`), `resetUnseenStates` (`:2329`), `resetAllStates` on prepare/stop/seek (`:712`, `:2006`, `:2071`) |
| Cache invalidation | [engine/src/audio/ClipRenderCache](engine/src/audio/ClipRenderCache.h) (slot policy mirrored in reader) | `kMaxClipId` |
| Declick helper | [engine/src/dsp/DeclickEnvelope.h](engine/src/dsp/DeclickEnvelope.h) | LUT-backed Hann `fadeIn`/`fadeOut`/`msToSamples` |
| Bridge plumbing | [bridge/src/XlethAddon.cpp](bridge/src/XlethAddon.cpp) | `clipModulationToJs` (`:1154`), `jsToClipModulation` (`:1218`), `clipModulationAudioChanged` (`:1332`), `Timeline_SetClipModulation` (`:4541`), export at line `11031` |
| IPC | [ui/main.js](ui/main.js) (`:735`), [ui/preload.js](ui/preload.js) (`:155`) | `xleth:timeline:setClipModulation` handler + `setClipModulation` preload |
| Existing UI | [ui/src/components/TimelineView.jsx](ui/src/components/TimelineView.jsx) | `handleSetClipVibrato` (`:2576`), Vibrato section in clip context menu (`:2738`) |
| Tests | [engine/test/test_clip_modulation_evaluator.cpp](engine/test/test_clip_modulation_evaluator.cpp) | tests 15..21 already cover empty-curve neutrality, linear interp, negative rate, stop, ClipPercent, Beats, integral |
| | [engine/test/test_clip_modulated_reader.cpp](engine/test/test_clip_modulated_reader.cpp) | ramp-buffer driven verification of source position |
| | [engine/test/test_undo.cpp](engine/test/test_undo.cpp) | tests 8/9 cover the modulation undo command + JSON round-trip |

CMake targets (confirmed in [engine/CMakeLists.txt](engine/CMakeLists.txt:531-584)):
- `test_undo`
- `test_clip_modulation_evaluator`
- `test_clip_modulated_reader`

---

## 3. Current Scratch data model and evaluator behavior

### 3.1 Schema (verbatim from `TimelineTypes.h:285-300`)

```cpp
struct ScratchPoint {
    float time           = 0.0f;
    float rateMultiplier = 1.0f;
    float curve          = 0.0f;
};
struct Scratch {
    enum class CurveTimeMode { ClipSeconds, ClipPercent, Beats };
    enum class EdgeMode      { Clamp, Silence, Wrap, PingPong };

    bool          enabled            = false;
    CurveTimeMode timeMode           = CurveTimeMode::ClipSeconds;
    float         smoothingMs        = 2.0f;
    float         gainCompensationDb = 0.0f;
    EdgeMode      edgeMode           = EdgeMode::Clamp;
    std::vector<ScratchPoint> curve;
};
```

Serialized strings (canonical, already round-tripped through bridge + JSON):

- `timeMode`: `"clipSeconds" | "clipPercent" | "beats"`
- `edgeMode`: `"clamp" | "silence" | "wrap" | "pingPong"`

**Schema sufficiency for MVP:**
- ✅ Negative rates are unrestricted floats (`rateMultiplier`).
- ✅ All three time modes are wired through bridge + evaluator.
- ✅ Edge modes are enumerated; D.1 implements the simplest one(s).
- ✅ `smoothingMs` exists as a transport for the reader-side declick width.
- ✅ `gainCompensationDb` exists for future loudness compensation under low rates (not used in MVP).
- ⚠️ `ScratchPoint::curve` (per-segment shape factor) is currently **unused** by the evaluator (it does straight linear interpolation). MVP does not need it; defer non-linear segment shapes to Phase E.
- ⚠️ No explicit `clipDurationBeats` is computed by the audio path today; the reader already populates it ([ClipModulatedReader.cpp:72](engine/src/audio/ClipModulatedReader.cpp:72)) and we get `Beats` mode for free.

**No schema change is required for Phase D.1.**

### 3.2 Evaluator behavior — `evaluateScratch` (`.cpp:182-277`)

`ScratchEval` returns:

| Field | Meaning | Computed by |
|---|---|---|
| `rateMultiplier` (float) | Instantaneous rate at `clipLocalSeconds` | Linear lerp between `pts[i]` / `pts[i+1]`, held flat past last point, unity before first point if `t0>0` |
| `reversed` (bool) | `currentRate < 0.0` | Trivial sign check |
| `intensity01` (float) | `clamp01(|rate − 1|)` | Visual-only intensity hint |
| `sourceOffsetSeconds` (double) | ∫₀^t rate(τ) dτ — **the source-time read position the source clip should be at** | Exact trapezoidal sum over fully-covered segments + partial trapezoid for the segment containing `tNow`; held-rate extrapolation past the last point |
| `phase01` (float) | `frac(|sourceOffsetSeconds|)` | Visual helper |

**What the evaluator does correctly today:**
- ✅ Negative rate → integrates negatively (readhead moves backward in source time).
- ✅ Rate `0.0` → integral stops accumulating (test 18 confirms `e1.sourceOffsetSeconds == e2.sourceOffsetSeconds` across a stopped segment).
- ✅ Held rate past last point → linear extrapolation at last value.
- ✅ Unity rate before first point → integral grows as `clipLocalSeconds`.
- ✅ Empty curve → neutral (`sourceOffsetSeconds = clipLocalSeconds`, `rateMultiplier = 1`, `reversed = false`).
- ✅ NaN/Inf guards on `bpm`, `clipDurationSeconds`, and the integral itself (final-fallback `if (!isFiniteD(integral)) integral = ctx.clipLocalSeconds;`).
- ✅ All three `CurveTimeMode` translations.

**Known gaps relevant to D.1:**
1. **Sort assumption.** The evaluator scans points in author order assuming monotonically non-decreasing `time`. A future UI can author out-of-order points and they will produce silently wrong results. *Remediation:* the bridge or the reader's seed step should sort/canonicalize once per change. Cheap (small N), not a blocker for MVP, but document.
2. **No per-segment `curve` factor** in the schema is read. Acceptable for MVP — linear is enough for ramp/stop/reverse/baby-scratch.
3. **Boundary semantics live entirely in the reader.** The evaluator never touches `edgeMode`; it emits `sourceOffsetSeconds` regardless. The reader maps that offset to a source PCM index and applies the edge policy. This is the correct factoring.

**Conclusion:** `evaluateScratch.sourceOffsetSeconds` is sufficient as-is to drive the Scratch readhead deterministically for piecewise-linear curves. No evaluator changes are required for D.1 except possibly defensive sort-canonicalization (deferred — see §6 risks).

---

## 4. Recommended Scratch readhead architecture

### 4.1 Reuse `ClipModulatedReader`, do not fork

**Decision:** Add a Scratch path *inside* `ClipModulatedReader::renderBlock`. Do **not** create a separate `ClipScratchReader`.

Rationale:
- The reader already owns the only modulated-clip render path that bypasses `ClipRenderCache` and reads raw PCM via Hermite. Forking it doubles MixEngine's branch surface and forces two parallel seed/state/declick implementations to drift apart.
- The reader's per-clip slot machinery (`states_`, `markClipSeen`, `resetUnseenStates`) is already exactly what Scratch + Vibrato co-existence needs.
- The activation predicate at [MixEngine.cpp:2211](engine/src/audio/MixEngine.cpp:2211) extends naturally — flip from "vibrato.enabled" to "vibrato.enabled OR scratch.enabled".

The structural change is small: the reader already has the per-sample loop, fractional `sourcePosD`, Hermite read, fade application, velocity gain, and seek-seeding hook. We extend the read-position computation, not the surrounding scaffolding.

### 4.2 Per-sample read-position rule (the load-bearing decision)

Two viable composition rules were considered:

**Option B — Stride-style (current reader's vibrato model, extended):**
```
sourcePos += staticRatio * vibratoPitchRatio * scratchRateMultiplier
```
Plus a `ClipScratchIntegrator` (analog of `ClipVibratoIntegrator`) for seek-seeding.

**Option A — Position-style (recommended):**
```
sourcePos = regionOffsetSamples
          + scratchSourceOffsetSeconds * sampleRate
          + vibratoOffsetWithinSample
```
Vibrato contributes a *pitch* term that micro-resamples the source by perturbing the *fractional* read position around the scratch-defined readhead.

**Recommendation: Option A** with the following formulation:

> **Scratch owns the source readhead. Vibrato is a pitch perturbation around it.**

Concretely, per output sample:

```
// Pure functions of (clip-local sample index, modulation):
ScratchEval  S = evaluateScratch(modulation.scratch, ctx, modulation.enabled);
VibratoEval  V = evaluateVibrato(modulation.vibrato, ctx, modulation.enabled);

// Static (block-hoisted) static-pitch ratio.
const double staticRatio = centsToRatio(staticCents);

// Scratch defines the deterministic source readhead in source-time seconds.
// Multiply by sampleRate to get a fractional source PCM index relative to clip-start.
double sourceClipSamples = S.sourceOffsetSeconds * sampleRate;

// Vibrato adds a *pitch* term: a tiny, sample-rate-bounded offset accumulated
// from `staticRatio * (V.pitchRatio - 1.0)` integrated continuously. Stored
// in per-clip state because it has no closed-form integral that survives
// arbitrary scratch motion.
double vibTrim = state.vibTrimD;       // updated per sample (see §4.3)

double sourcePosD = regionOffsetSamples + sourceClipSamples + vibTrim;
```

Why this is better than Option B for our requirements:

| Requirement | Option A wins because… |
|---|---|
| Deterministic seek/scrub | `sourcePos` is a *closed-form function* of clip-local time — same value whether reached continuously or by jump. No accumulator drift. |
| Reverse playback (`-1.0`) | `sourceOffsetSeconds` decreases naturally; no special "reverse mode" branch in the reader. |
| Stop (`0.0`) | `sourceOffsetSeconds` stays flat; readhead freezes; Vibrato still wobbles pitch *around the held position* (musically correct). |
| DJ ramps / scratch curves | Trapezoidal integrals are exact for piecewise-linear curves. |
| Preview/export determinism | Two engines computing the same `clipLocalSamples` get bit-identical readheads. No persistent state to disagree about. |
| Future video sync | The video FX plane already calls `evaluateScratch` to get `sourceOffsetSeconds` and `phase01`. Audio uses the same number. They cannot diverge. |
| CPU cost | One `evaluateScratch` per sample. The integral walks a small `pts` array; for typical curves (≤16 points) this is cache-resident and trivially cheap. Block-rate evaluation (next/last point + interpolation cache) is a future optimization. |

Option B requires a parallel `ClipScratchIntegrator` for exact seek seeding *plus* the vibrato integrator — and the two have to compose without drift. That's gratuitous engineering when the evaluator already gives us the integral in closed form.

### 4.3 What persistent state remains in the reader

With Option A, **Scratch needs no persistent readhead state** — `sourcePosD` is recomputed every sample from `evaluateScratch`. The only per-clip state we keep is:

```cpp
struct State {
    double  vibTrimD              = 0.0;   // micro-pitch accumulator (Phase C, kept)
    double  prevRate              = 1.0;   // for declick / direction-flip detection (NEW)
    double  smoothedRate          = 1.0;   // one-pole slew of S.rateMultiplier (NEW)
    int64_t expectedNextPosInClip = -1;    // continuity marker (kept)
    bool    seenThisBlock         = false; // unseen-sweep marker (kept)

    // Hann microfade at direction flips
    int     declickRemaining      = 0;     // samples left in fade-out-then-in
    int     declickWidth          = 0;     // total width in samples
    bool    declickInverting      = false; // first half = fade out current readhead
};
```

Note: the *current* `State::sourcePosD` field becomes the *vibrato pitch trim* under Option A. We rename for clarity.

This is materially simpler than Option B's combined-stride accumulator with two separate integrators for seeding.

---

## 5. Recommended Scratch / Vibrato composition rule

Final, explicit:

```
let s = evaluateScratch(scratch, ctx, top)              // sourceOffsetSeconds, rateMultiplier
let v = evaluateVibrato(vibrato, ctx, top)              // pitchRatio (per-sample)
let staticRatio = 2^(staticCents / 1200)

// Scratch readhead, in source PCM samples relative to the source asset:
sourceBase  = regionOffsetSamples + s.sourceOffsetSeconds * sampleRate

// Vibrato as a per-sample pitch perturbation around the scratch readhead.
// We integrate `staticRatio * (v.pitchRatio - 1.0)` continuously across the
// clip; this is the residual after scratch already moved the readhead at
// rate `s.rateMultiplier * sampleRate` per second.
vibTrim    += staticRatio * (v.pitchRatio - 1.0)        // per sample
sourcePosD  = sourceBase + vibTrim

// Read with Hermite at sourcePosD (with edge-mode policy).
```

### 5.1 Why split that way

- **Scratch is a time/readhead transform.** Its rate is in *source-seconds-per-clip-second*, not pitch. It must dominate the source-position calculation.
- **Vibrato is a pitch transform.** At unity (no scratch), `(v.pitchRatio - 1.0)` integrated = the same continuous pitch wobble Phase C delivers today. With scratch present, that wobble *adds on top of* whatever readhead motion scratch dictates — which is what users expect (a vinyl wobble *while* you scratch).
- **The static `pitchOffset` (semitones + cents)** is tricky: should it pre-scale scratch motion, or be applied around the scratch readhead like vibrato? **Decision: apply as a pitch wobble around scratch**, the same as vibrato. A vinyl scratch at `-1.0` plays the source backward at *normal* source speed; a clip with `pitchOffset = +2 semitones` should still scratch at `-1.0× source-rate` (not `-1× × +2st = roughly -1.122×`). The user-expected mental model is: `scratch = rate-of-source-time, pitchOffset = pitch-shift-of-what-comes-out`.
- This means **`staticRatio` is folded into `vibTrim` as well**, not into `sourceBase`. When scratch is *off*, vibTrim accumulates `staticRatio * v.pitchRatio` per sample (matching today's behavior, since `sourceBase` then reduces to `regionOffsetSamples + clipLocalSamples * 1.0` and the total stride degenerates back to `staticRatio * v.pitchRatio` per sample). When scratch is *on*, `sourceBase` carries the readhead; `vibTrim` carries the pitch wobble + static pitch on top.

Codified:

```
when scratch.enabled && scratch.curve.nonempty:
    sourceBase  = regionOffset + s.sourceOffsetSeconds * sampleRate
    vibTrim    += staticRatio * v.pitchRatio - 1.0     // per-sample integration
                                                        // residual above unity
    // Optional MVP simplification: when vibrato disabled, vibTrim≡0.
when scratch off (legacy Phase C path):
    sourcePosD += staticRatio * v.pitchRatio            // unchanged
```

The `-1.0` in the scratch-on branch comes from the fact that `sourceBase` itself already advances at `1.0 × sampleRate` per second when scratch rate is unity (i.e. `sourceOffsetSeconds == clipLocalSeconds`); vibTrim must only carry what `staticRatio * v.pitchRatio` adds *above* unity to avoid double-counting.

### 5.2 Composition is fully deterministic

For a given `(clipLocalSamples, modulation)`:
- `s.sourceOffsetSeconds` is a closed-form function (no state).
- `vibTrim(N)` = Σ_{i=0..N-1} `(staticRatio * v.pitchRatio(i) - 1.0)`. This sum has no scratch term in it — making it *the same problem `ClipVibratoIntegrator` already solves*. We reuse that integrator unchanged for seek-seeding `vibTrim`.

So seek seeding for the combined Scratch+Vibrato readhead at clip-local sample `N` is:

```
sourcePosD(N) = regionOffsetSamples
              + evaluateScratch(... N ...).sourceOffsetSeconds * sampleRate
              + computeVibratoIntegratedSourceOffsetSamples(... N ...) - N * staticRatio
```
*(where the last subtraction strips the `staticRatio * 1.0 = staticRatio` per sample baseline that the existing integrator returns; we want only the residual.)*

A small wrapper helper makes that explicit (see §6 deliverables).

---

## 6. Deterministic seek/seeding strategy

| Discontinuity | Phase D.1 strategy |
|---|---|
| First sample of clip (`posInClip == 0`) | `sourceBase = regionOffsetSamples + 0`; `vibTrim = 0`; `prevRate = s.rateMultiplier(t=0)`; `smoothedRate = prevRate`; `declickRemaining = 0`. |
| Mid-clip seek / scrub / `expectedNextPosInClip` mismatch | Recompute `sourceBase` from `evaluateScratch(... posInClip ...)` exactly (pure function, no helper needed). Reseed `vibTrim` via the existing `computeVibratoIntegratedSourceOffsetSamples` helper minus the unity baseline (see §5.2 formula). Seed `prevRate = smoothedRate = s.rateMultiplier(posInClip)` so we don't fire a phantom direction-flip declick on first sample after seek. |
| Continuous block-to-block | `sourceBase` is recomputed every sample anyway (closed form); `vibTrim` keeps accumulating per sample. No explicit per-block seeding needed beyond the existing `expectedNextPosInClip` check. |
| Transport stop / prepare / seek | `clipModReader_.resetAllStates()` (already wired at [MixEngine.cpp:712](engine/src/audio/MixEngine.cpp:712), `:2006`, `:2071`). |
| Clip leaves active set | `resetUnseenStates()` (already wired at [MixEngine.cpp:2329](engine/src/audio/MixEngine.cpp:2329)). |

**Sufficiency of `evaluateScratch.sourceOffsetSeconds` for seeding:** yes — it is exact for piecewise-linear curves, which is what MVP allows. No new integrator is required for the scratch component.

**Defensive sort:** if the scratch curve's points arrive out of time-order (UI bug, malformed JSON), the evaluator silently produces wrong integrals. Fix at the **bridge `jsToClipModulation`** path: after parsing, `std::sort(curve.begin(), curve.end(), by-time)`. One-line change, defensive. Mark explicitly as a Phase D.1 hardening item.

---

## 7. Declick / smoothing strategy

Constraints:
- The evaluator must remain pure — **no smoothing state in `evaluateScratch`**.
- `Scratch::smoothingMs` is the user-facing knob and must be consumed by the reader.
- Vinyl-style direction flips (`+1 → −1` instantly) cause readhead-derivative discontinuities → audible clicks.

### 7.1 Two-stage declick

**Stage 1 — One-pole rate slew** (cheap, always on):
```
const double slewMs   = max(0.5, scratch.smoothingMs);
const double tauSamps = slewMs * 0.001 * sampleRate;
const double alpha    = 1.0 - exp(-1.0 / tauSamps);
state.smoothedRate   += alpha * (s.rateMultiplier - state.smoothedRate);
```
The slewed rate is *informational only* under Option A — `sourceBase` is still computed from the unslewed `sourceOffsetSeconds` (because that's the closed-form integral). Use `state.smoothedRate` only to:
- detect direction flips (sign change of `prevRate` vs `smoothedRate`),
- attenuate the output gain mildly during fast transients (optional V2),
- drive the declick microfade trigger (below).

**Stage 2 — Hann microfade on direction flip**:
```
if (sign(prevRate) != sign(smoothedRate) && |smoothedRate| > 0.01) {
    state.declickWidth     = max(2, msToSamples(smoothingMs, sampleRate));
    state.declickRemaining = state.declickWidth;
    state.declickInverting = true;          // first half: fade-out current
}
```
During declick:
- If `declickInverting && declickRemaining > declickWidth/2`: multiply output by Hann fade-out (so the click during the position discontinuity is masked).
- If `declickInverting && declickRemaining <= declickWidth/2`: switch to fade-in.
- Decrement `declickRemaining` per sample.

The `DeclickEnvelope` LUT is already engine-warm (`DeclickEnvelope::initialize()` runs at [MixEngine.cpp:90](engine/src/audio/MixEngine.cpp:90)). Reuse it — no new helper needed.

### 7.2 What we deliberately do NOT do for MVP

- **No rate-slewed `sourceBase`.** Slewing the integral into the readhead is musically nice but breaks determinism (the reader's local one-pole state would diverge between continuous and seeded playback). Defer to Phase E with an explicit "smoothed scratch source" mode.
- **No look-ahead crossfade across direction flips.** That requires reading both directions and crossfading — costly and not needed for the MVP feature set.
- **No slew on `staticRatio` or `vibratoRatio`.** Both are continuous already.

---

## 8. Boundary / edge-mode strategy

The reader, not the evaluator, applies the edge policy. After computing `sourcePosD` (see §5):

| `EdgeMode` | Behavior | MVP? |
|---|---|---|
| `Clamp` | If `sourcePosD < 0` read from sample 0 with declick; if `>= srcTotal-1` read from `srcTotal-1`. | ✅ MVP default (matches current `ClipModulatedReader` behavior). |
| `Silence` | Out-of-bounds → emit 0.0. (This is the *current* reader behavior — we already silence beyond the Hermite-safe range.) | ✅ MVP supported; aligns with existing code. |
| `Wrap` | `sourcePosD = mod(sourcePosD - regionOffset, sourceLen) + regionOffset`. Useful for looped sample beds. | ⏸ Phase E. |
| `PingPong` | Reflect at boundaries. Useful for tape-stop-style oscillation. | ⏸ Phase E. |

**MVP default:** `Clamp` (matches the user-friendly DJ expectation: hold the boundary frame). We expose `Silence` for completeness because the current reader already implements it (out-of-bounds → 0).

`Wrap` and `PingPong` require sample-domain math the current reader doesn't perform; defer.

The **current reader's boundary behavior is *de facto* `Silence`** (see [ClipModulatedReader.cpp:155](engine/src/audio/ClipModulatedReader.cpp:155) — `pos >= srcTotal-1 → sampleL = sampleR = 0`). MVP needs a small change to add `Clamp` as the default and treat `edgeMode == Silence` as the existing behavior.

---

## 9. Activation predicate and fallback policy

Current ([MixEngine.cpp:2211](engine/src/audio/MixEngine.cpp:2211)):
```cpp
const bool useModulatedReader =
    ac.clip->modulation.enabled
 && ac.clip->modulation.vibrato.enabled
 && !ac.clip->reversed
 && ac.clip->stretchRatio == 1.0
 && !ac.clip->formantPreserve;
```

Phase D.1 update:
```cpp
const auto& mod = ac.clip->modulation;
const bool wantsModulation =
    mod.enabled
 && (mod.vibrato.enabled || mod.scratch.enabled);

const bool modulationCompatible =
    !ac.clip->reversed
 && ac.clip->stretchRatio == 1.0
 && !ac.clip->formantPreserve;

const bool useModulatedReader = wantsModulation && modulationCompatible;
```

**Fallback rule:** if the user enables Scratch on a reversed/stretched/formant-preserve clip, the modulated path is bypassed and the cache path renders normal playback (matching Vibrato's current Phase C policy). This is consistent and avoids surprising silent corruption.

**UI surfacing:** a small badge / tooltip in the clip context menu — *"Modulation requires forward, unstretched, non-formant playback"* — when scratch (or vibrato) is enabled but `modulationCompatible` is false. Wire into the same warning string as Vibrato.

---

## 10. UI MVP proposal

**Placement:** extend the existing clip context menu in [TimelineView.jsx](ui/src/components/TimelineView.jsx:2738) (right after the Vibrato section). No modal / inspector for D.1 — the context-menu pattern is already validated in C.2.

**Minimum controls (D.1):**

```
Scratch
  [✓] Enable
  Smoothing  [ slider 0..50 ms ]                  → scratch.smoothingMs
  Edge       ( Clamp ▼ )                          → scratch.edgeMode  (Clamp / Silence)
  Preset:    [Normal] [Stop] [Reverse] [Baby] [TapeStop]
  ── current curve points: 3
  (compact list: t=0 → r=1 ; t=0.5 → r=−1 ; t=1.0 → r=1 )
```

**Presets** (each replaces the curve with a small, well-known shape):

| Preset | Curve (`time` in `clipPercent`) |
|---|---|
| Normal | `[(0.0, 1.0), (1.0, 1.0)]` (unity, used for "scratch on but no curve" sanity) |
| Stop | `[(0.0, 1.0), (0.1, 0.0), (1.0, 0.0)]` — quick brake |
| Reverse | `[(0.0, -1.0), (1.0, -1.0)]` — full reverse playback |
| Baby Scratch | `[(0.0, 1.0), (0.25, -1.0), (0.5, 1.0), (0.75, -1.0), (1.0, 1.0)]` |
| Tape Stop | `[(0.0, 1.0), (1.0, 0.0)]` — linear wind-down |

**Defer to D.2/E:**
- Scratch-curve graphical editor (needs the same scaffolding as the fade bezier, plus point add/remove).
- Per-segment `curve` parameter UI.
- `gainCompensationDb`.
- `Wrap` / `PingPong` edge modes.
- The video Scratch Wave / Smear companion (separate phase).

Phase D.0 does not implement any of this — only specifies it.

---

## 11. Phase D.1 implementation steps

> All changes confined to the engine + bridge sort hardening. **No new files, no schema change, no UI change.**

1. **MixEngine activation predicate.** Update `useModulatedReader` ([MixEngine.cpp:2211](engine/src/audio/MixEngine.cpp:2211)) per §9.
2. **Reader — rename `State::sourcePosD` → `State::vibTrimD`** plus add `prevRate`, `smoothedRate`, `declickRemaining`, `declickWidth`, `declickInverting` ([ClipModulatedReader.h:106](engine/src/audio/ClipModulatedReader.h:106)).
3. **Reader — extend per-sample loop** ([ClipModulatedReader.cpp:74](engine/src/audio/ClipModulatedReader.cpp:74)) to:
   - Build the same `ClipModulationContext` once per sample (already done).
   - Call `evaluateScratch(p.modulation->scratch, ctx, p.modulation->enabled)` exactly once.
   - Compute `sourceBase = regionOffsetSamples + s.sourceOffsetSeconds * sampleRate` when scratch is active; else fall back to the legacy stride accumulator path (preserves Phase C bit-equivalence for non-scratch clips).
   - Update `vibTrimD` with `staticRatio * (vEval.pitchRatio - 1.0)` per sample (scratch active) or with full stride (scratch inactive — legacy path).
   - Compute `sourcePosD = sourceBase + vibTrimD`.
   - Run §7.1 declick: update `smoothedRate`, detect direction flip, manage `declickRemaining`, multiply `gain` by Hann.
   - Apply `edgeMode` policy before reading: `Clamp` (default) → clamp position into `[0, srcTotal-1)`; `Silence` → existing zero-emit.
4. **Reader — seed/reseed branch** ([ClipModulatedReader.cpp:88](engine/src/audio/ClipModulatedReader.cpp:88)):
   - When scratch active: `sourceBase` is closed-form; seed `vibTrimD` from the existing `computeVibratoIntegratedSourceOffsetSamples` helper *minus* the unity baseline (`N * staticRatio`), per §5.2.
   - When scratch inactive: keep the existing seed path verbatim.
5. **Bridge defensive sort.** In [bridge/src/XlethAddon.cpp](bridge/src/XlethAddon.cpp:1281) `jsToClipModulation` after curve parse, `std::sort(pts.begin(), pts.end(), [](const ScratchPoint& a, const ScratchPoint& b){ return a.time < b.time; });`. Also dedupe NaN/Inf `time` and `rateMultiplier` (replace with safe defaults). One-screen change.
6. **Cache invalidation.** No change required — `clipModulationAudioChanged` ([XlethAddon.cpp:1332](bridge/src/XlethAddon.cpp:1332)) already inspects `scratch.*` (via the existing equality check on the full struct field-by-field; verify field-by-field coverage is exhaustive — if not, extend).
7. **Tests.** Add ~10 focused tests (see §12).
8. **Manual smoke test.** Build, run engine + UI, place a clip, enable scratch via a temporary bridge fixture (before D.2 UI lands), verify audible reverse / stop / baby-scratch behavior.

**Files likely to change in D.1** (with rough line-of-change estimates):
- [engine/src/audio/ClipModulatedReader.h](engine/src/audio/ClipModulatedReader.h) — `State` fields, comment block (~20 lines)
- [engine/src/audio/ClipModulatedReader.cpp](engine/src/audio/ClipModulatedReader.cpp) — render loop, seed branch, declick (~100 lines)
- [engine/src/audio/MixEngine.cpp](engine/src/audio/MixEngine.cpp) — activation predicate (~10 lines)
- [bridge/src/XlethAddon.cpp](bridge/src/XlethAddon.cpp) — defensive scratch curve sort + sanitize (~15 lines)
- [engine/test/test_clip_modulated_reader.cpp](engine/test/test_clip_modulated_reader.cpp) — new scratch test cases (~250 lines)
- [engine/CMakeLists.txt](engine/CMakeLists.txt) — none expected (existing test target picks up new test functions)

---

## 12. Test plan for Phase D.1

Extend [test_clip_modulated_reader.cpp](engine/test/test_clip_modulated_reader.cpp) using the same ramp-buffer technique already in use (sample value = source position at integer indices ⇒ direct readhead inspection). All tests assume the unity ramp `src[i] = i`.

| # | Name | Setup | Assertion |
|---|---|---|---|
| D.1-01 | Scratch disabled is neutral (vs Phase C output) | `modulation.scratch.enabled = false`; vibrato off | Output == legacy stride loop output, sample-for-sample. |
| D.1-02 | Empty curve neutral | Scratch enabled, `curve` empty | Output == passthrough at unity. |
| D.1-03 | Constant rate 1.0 | `curve = [(0,1)]` | Output[s] ≈ s. |
| D.1-04 | Constant rate 2.0 | `curve = [(0,2)]` | Output[s] ≈ 2*s. |
| D.1-05 | Constant rate 0.0 freezes | `curve = [(0,0)]` | Output[s] ≈ 0 for all s (held at sample 0). |
| D.1-06 | Constant rate -1.0 reads backward from regionOffset | Set `regionOffset` to a sample N>0; `curve = [(0,-1)]` | Output[s] ≈ N - s, clamped at 0 by Clamp edge mode. |
| D.1-07 | Linear ramp 1 → -1 | `curve = [(0,1),(t,-1)]` over the clip | Readhead matches trapezoidal integral; reverses through sample-zero. |
| D.1-08 | Continuous == seeded (split-block test) | Render block of N at once vs N/2 + N/2 | Sample-for-sample equality (within Hermite ULP). |
| D.1-09 | Edge mode Clamp at past-end | Curve drives readhead past `srcTotal-1` | Output stays at last source sample (no zeroing). |
| D.1-10 | Edge mode Silence at past-end | `edgeMode = Silence` | Output goes to 0 past the boundary. |
| D.1-11 | Direction flip is bounded | Sharp `+2 → -2` step | No sample exceeds `max(|src|) * 1.5` (declick trims). |
| D.1-12 | Vibrato + Scratch determinism | Both on; render twice | Bit-equal output on both runs. |
| D.1-13 | Scratch overrides vibrato readhead | Scratch rate 0; vibrato 100¢ | Output sample stays bounded around `src[regionOffset]` (no readhead drift). |
| D.1-14 | Activation fallback (reversed clip) | `clip.reversed = true` + scratch on | `useModulatedReader` is false → cache-path output. |
| D.1-15 | Activation fallback (stretched clip) | `stretchRatio = 1.5` + scratch on | Cache-path output. |

**Existing tests must continue to pass:**
- All 21 `test_clip_modulation_evaluator` tests (unchanged code path).
- All Phase C `test_clip_modulated_reader` tests (the legacy stride path is preserved when `scratch.enabled == false`).
- `test_undo` tests 8 and 9 (no schema changes).

---

## 13. Risks & non-goals

### 13.1 Risks

| Risk | Severity | Mitigation |
|---|---|---|
| **Audio-callback CPU cost.** `evaluateScratch` walks `pts` per sample. | Low (curves typically ≤16 points). | If profiling shows it matters: cache `(segIdx, lastT)` per state and short-circuit linear lookup. Block-rate evaluation (every K samples) is also acceptable since the math is closed form. |
| **Direction-flip clicks.** Readhead derivative discontinuity = audible click. | Medium. | Hann microfade per §7. Width controlled by `scratch.smoothingMs`. |
| **Boundary aliasing.** Reading past source end with non-Silence policy. | Low. | Clamp default. Silence preserves current behavior. Wrap/PingPong deferred. |
| **Out-of-order or NaN scratch points.** | Low. | Bridge-side sort + sanitize (D.1 step 5). Evaluator already guards NaN/Inf integrals. |
| **Preview/export mismatch.** Audio render and video render disagree on readhead. | Low. | Both planes call the same pure `evaluateScratch`. Seek seeding is closed-form. |
| **Scratch + Vibrato compound bugs.** vibTrim integration can drift across seek if implemented wrong. | Medium. | Reuse the existing `ClipVibratoIntegrator` for seeding (already battle-tested in C.1). |
| **Scratch + reverse/stretch fallback feels broken to users.** They enable scratch and nothing happens. | Medium. | UI warning string in clip menu (D.2). Phase E composes Scratch with reverse/stretch properly. |
| **`gainCompensationDb` not implemented in MVP.** Reverse/stop sections may sound louder than expected at high rate magnitudes. | Low. | Document as known limitation; Phase E adds rate-aware loudness compensation. |
| **Schema drift.** Adding fields later (e.g. per-segment `curve`) without bumping `kProjectFileVersion`. | Very low for D.1 (no changes). | Defer to Phase E with explicit version bump if needed. |

### 13.2 Non-goals (for Phase D.1)

- Phase A JSON schema changes.
- New bridge / N-API entry points.
- Scratch UI (curve editor, presets) — that's D.2.
- Video Scratch Wave / Smear / GridCompositor / VideoCompositor changes.
- HLSL/GLSL shaders.
- FFmpeg filter routing.
- Composition of Scratch with `reversed`, `stretchRatio != 1.0`, or `formantPreserve`.
- Per-segment non-linear curve shapes.
- Wrap / PingPong edge modes.
- Loudness/gain compensation at extreme rates.

---

## 14. Files likely to change in Phase D.1

(Same list as §11 step "files", duplicated here for at-a-glance.)

- `engine/src/audio/ClipModulatedReader.h`
- `engine/src/audio/ClipModulatedReader.cpp`
- `engine/src/audio/MixEngine.cpp` (activation predicate only)
- `bridge/src/XlethAddon.cpp` (defensive sort/sanitize only)
- `engine/test/test_clip_modulated_reader.cpp` (new test cases)

Files explicitly **not** changing in D.1:
- `engine/src/model/TimelineTypes.h` (schema unchanged)
- `engine/src/model/ClipModulationEvaluator.{h,cpp}` (evaluator unchanged)
- `engine/src/model/Clip.{h,cpp}` (JSON unchanged)
- `engine/src/commands/TimelineCommands.{h,cpp}` (undo command unchanged)
- `engine/src/audio/ClipVibratoIntegrator.{h,cpp}` (consumed as-is)
- `ui/main.js`, `ui/preload.js`, `ui/src/components/TimelineView.jsx` (UI deferred to D.2)
- Anything in the video pipeline (`GridCompositor`, `VideoCompositor`, shaders)

---

## 15. Confirmation: nothing was implemented in this pass

This Phase D.0 pass produced **only** this diagnostic document at
`docs/plans/phase-d0-vinyl-scratch-architecture.md`.

Explicitly **not** done in this pass:
- ❌ No Scratch audio code.
- ❌ No Scratch UI.
- ❌ No video FX (swirl / wave / smear).
- ❌ No shaders (HLSL / GLSL).
- ❌ No bridge / API changes.
- ❌ No N-API surface changes.
- ❌ No Phase A schema changes.
- ❌ No FFmpeg filter changes.
- ❌ No `ClipModulatedReader` code change (not even comments).
- ❌ No `evaluateScratch` consumption in playback.
- ❌ No new branch.
- ❌ No work in `.claude/worktrees/*`.

Engine, bridge, and renderer responsibilities remain cleanly separated: the engine evaluates and renders, the bridge translates, the renderer (UI) authors and visualizes — and Phase D.1 will preserve that separation.
