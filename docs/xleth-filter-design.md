# XLETH — Xleth Filter: Design & Implementation Plan

**What this is:** the architecture and implementation plan for finalizing Xleth Filter — the stock filter effect currently sitting as a 20-line pass-through stub (`engine/src/audio/XlethFilterEffect.h`) — based on the merged Gemini + Claude filter taxonomies, five web-research reports, and two codebase audits.

**Bottom line up front:** one Zavalishin-TPT / Cytomic-Simper SVF core in the generic m0/m1/m2 mix form covers ~80% of both lists from a single struct; a multi-slot serial engine clones the proven `XlethParametricEQ` band pattern; modulation is a hybrid — the existing `envmod`/`lfomod` graph engine for envelope/LFO, plus a small in-effect dynamics follower for the auto-wah/303 case. Four paste-ready prompts, executed in order.

---

## 1. Scope verdict — what Xleth Filter is and is not

The two source lists (Gemini's 3-tier taxonomy, Claude's topology catalog) describe ~25 filter concepts. They are not all the same kind of thing. Roughly a third of them are not "a filter slot in an effect" — they are entire standalone effects, and building them inside Xleth Filter would turn it into a bloated suite nobody can navigate. Decisive split:

**In scope — Xleth Filter slot types:**

| Slot type | Implementation core | Ship phase |
|---|---|---|
| LP / HP / BP / Notch (12 dB, resonant) | TPT SVF (mix form) | Prompt 1 |
| Morphing multimode (LP→BP→HP→notch, one knob) | TPT SVF mix-coefficient lerp | Prompt 1 |
| Allpass, Peak/Bell, Low/High Shelf | TPT SVF mix coefficients | Prompt 1 |
| Slopes 6 / 24 / 48 dB | 1st-order section; Butterworth-staged SVF cascade (Q tables) | Prompt 1 |
| Drive + self-oscillation mode | Pre-filter tanh + in-loop soft clip, k→0 with safety clip | Prompt 1 |
| Moog ladder (24 dB, self-osc, saturated feedback) | 4-pole TPT ladder, fixed-point tanh iteration | Prompt 4 |
| TB-303 diode ladder (acid flagship) | Port Open303 engine core (MIT licensed) | Prompt 4 |
| Sallen-Key (clean ARP-style) | TPT 2-pole SK, optional ×2 cascade | Prompt 4 |
| Steiner-Parker multimode | SVF core with input-injection variants | Prompt 4 |
| Comb (feedforward + feedback/KS) | Dedicated ring-buffer delay line + allpass interp + loop damping | Prompt 4 |
| Formant / vowel | Parallel bank of 3–5 SVF/biquad BPFs + vowel morph table | Prompt 4 |
| Tilt EQ | Twin shelves from the SVF shelf coefficients, one knob | Prompt 4 |

**Out of scope — do not build these into Xleth Filter:**

- **Phaser, Flanger, Chorus** — already exist as separate XLETH stock effects (`XlethPhaserEffect.h`, `XlethFlangerEffect.h`, UniFlange). Duplicating them inside the filter is wrong.
- **Vocoder** — an N-band analysis/synthesis system with carrier/modulator routing. Separate effect.
- **Spectral / FFT filtering** — frequency-domain processing with latency and a totally different DSP path. Separate effect, if ever.
- **Convolution filtering** — an IR loader with partitioned convolution and latency reporting. Separate effect.
- **Frequency shifter (Hilbert/SSB), physical-modeling waveguides, chaotic feedback filters** — each is its own instrument/effect project. Not slots.
- **Brickwall IIR** — does not exist honestly; a true brickwall is a linear-phase FIR with real latency. If wanted later, it is a separate latency-aware path, not an IIR cascade pretending to be steep. 48 dB/oct staged Butterworth is the honest steep option.

---

## 2. The core bet: one SVF to rule the clean filters

**Decision: the Zavalishin-TPT / Cytomic-Simper state-variable filter is the single unified core.** Three independent research lines converged on this:

- **Modulation stability.** Direct-form biquads are unsafe under fast cutoff sweeps at high resonance — the exact TB-303 use case. The TPT SVF embeds all cutoff/resonance history in its two integrator states, so per-sample coefficient changes are unconditionally stable for 0 < fc < fs/2 at any Q. (Chamberlin SVF: rejected — blows up above ~fs/6 and overshoots ~180% on fast sweeps.)
- **One core, every response.** With the generic form, every 2-pole response is a mix of input + two states: `out = m0·v0 + m1·v1 + m2·v2`. LP = (0,0,1), BP = (0,k,0), HP = (1,−k,−1), notch = (1,−k,0), allpass = (1,−2k,0), peak/shelves have known coefficients. **Mode morphing is a 3-float lerp** — click-free, and itself modulatable (the Hydrasynth SEM approach), strictly better than crossfading two divergent filter states.
- **Cheap.** 2 state floats per slot per channel; coefficient math (one `tan`, one divide) in double at control-block rate; per-sample loop is 8 mul + 6 add in float, SIMD-friendly across slots.

**Core equations (Simper "optimised 2" form, public Cytomic paper):**

```
// coefficient update (control block, double precision):
g  = tan(pi * fc / fs)         // prewarped integrator gain
k  = 1 / Q                     // damping
a1 = 1 / (1 + g*(g + k));  a2 = g * a1;  a3 = g * a2

// per sample (float):
v3 = v0 - ic2eq
v1 = a1*ic1eq + a2*v3          // bandpass
v2 = ic2eq + a2*ic1eq + a3*v3  // lowpass
ic1eq = 2*v1 - ic1eq
ic2eq = 2*v2 - ic2eq
out = m0*v0 + m1*v1 + m2*v2
```

**Guard rails (non-negotiable):**

- Clamp fc ∈ [10 Hz, 0.45·fs], Q ∈ [0.5, 30] always — after modulation summing, before coefficient math.
- Self-osc mode: allow k→~0 only with a `tanh` soft clip inside the resonance feedback path (bounds amplitude, analog-like compression) plus a post-stage DC blocker. Never expose raw k=0 linear.
- `juce::ScopedNoDenormals` on the audio callback + flush states below ~1e-20; double for coefficient calc.
- Nonlinearity iteration counts are fixed (1–2), deterministic — no convergence loops on the audio thread.

**Slope staging:** 6 dB = one-pole; 12 dB = single SVF; 24 dB = two SVFs at same fc with Butterworth staging Q₁ = 0.5412, Q₂ = 1.3065 (Q = 0.7071 on both is wrong — gives −6 dB droop at fc); 48 dB = four stages from the standard Butterworth Q table (Q_k = 1 / (2 cos(π(2k + N − 1) / 2N))). Resonant cascades share fc and Q across stages; Butterworth staging applies to non-resonant steep slopes only.

---

## 3. Multi-slot engine architecture

**Pattern: clone `XlethParametricEQ` (`XlethEQEffect.h`), smooth like `XlethPhaserEffect.h`.** This is the proven in-tree multi-slot design — do not invent a new one.

- **Fixed slot array.** `kMaxSlots = 8`, `SlotState slots_[kMaxSlots]` preallocated in `prepareEffect`; `std::atomic<int> slotCount_` read once per block. `addSlot()`/`removeSlot()` main-thread only, swap-with-last on remove, count serialized as an XML attribute alongside APVTS state (EQ's `getStateInformation` override is the template).
- **Param namespacing.** All slot params declared upfront in `createLayout()`: `s{i}_enabled`, `s{i}_type`, `s{i}_cutoff`, `s{i}_q`, `s{i}_gain`, `s{i}_morph`, `s{i}_slope`, `s{i}_drive`, `s{i}_mix`, plus modulation params below. Same `paramId(i, suffix)` convention as the EQ.
- **Serial chain.** Slots run in series, each pure-wet with per-slot `enabled` bypass and `mix` (additive `dry + mix·wet` per slot, the phaser's phase-safe pattern). Watch cumulative resonance gain across a resonant series — per-slot output soft clip is the safety net.
- **Smoothing.** Cutoff/Q: `registerSmoothedParam(id, SmoothType::Multiplicative, 15–30 ms)` — exponential-ish glide, musically correct. Mix/gain: Linear 20 ms. Coefficients recomputed per 32-sample control block from smoothed values with the base class's `peekAfter()` block-rate trick and per-sample lerp — never `tan()` per sample in v1.
- **Tail.** `getTailLengthSeconds()` ≈ 0.2 s so resonant state decays across clip chops.

**Custom RPCs (all four layers, mirroring the EQ's five):** `audio_filterAddSlot`, `audio_filterRemoveSlot`, `audio_filterSetSlotParam`, `audio_filterGetSlots`, `audio_filterGetResponseCurve`. Each requires: `ui/rpc-manifest.js` entry → `bridge/src/XlethRpcExports.inc` export → `engine/src/XlethRpcDispatch.inc` mapping → handler in `XlethEngineService.cpp`. Verify with `cd ui && npx vitest run rpcManifest`. Plain per-param writes go through the existing generic `audio_setEffectParameter` path and need no new RPC.

---

## 4. Modulation architecture — the hybrid

**What the audit found:** XLETH already has a production-grade envelope + LFO → effect-parameter engine (`xleth::envmod`, `xleth::lfomod`) with bounded mapping, bezier curves, per-sample downstream smoothing, and multi-slot addressing by `effectInstanceId` + `parameterId`. The only missing piece is an audio-driven dynamics follower.

### 4.1 Envelope & LFO — reuse the graph engine, zero new engine code

- Every APVTS slot param (cutoff, Q, morph, mix, drive) is automatically an FX-graph modulation target. Envelope and LFO nodes drive it via `ModulationMapping`: `value = clamp(base + depth · shaped(env))` — base+depth bipolar is mathematically the user's min/max pair in normalized domain; env = 0 yields exactly base, so idle modulators are inert.
- The cutoff param's log-skewed `NormalisableRange` means normalized-domain modulation sweeps in approximately-octave space — the perceptually correct behavior for acid sweeps — for free.
- Evaluation is block-rate into atomic mailboxes, applied by a helper thread, smoothed per-sample inside the effect. Zipper-safe for musical-rate sweeps. Never push this path to per-sample rate; never touch `chainsMutex_` from the audio thread.
- Trap to avoid: the Sampler's `advanceLfo` tempo-sync formula `(bpm/60)·(4/division)` is confirmed backwards (`LfoParameterModulation.h:39-48`). Use `lfomod`'s `evaluateLfoAtPosition`, which is a stateless pure function of absolute transport position — correct across seek and loop-wrap.

### 4.2 Dynamics follower — small in-effect mod engine (the auto-wah / 303 path)

The graph path structurally cannot see the audio stream, so the signal-driven follower lives inside the effect, one per slot:

- **Detector.** Reuse `xleth_apex::EnvelopeFollower` (`ApexDsp.h:509-554`): branching attack/release with sustain-hold + RMS pre-stage. Coefficients per block via `onePoleCoeff(ms, sr)` — never per-sample `exp` (the Compressor's `XlethCompressorEffect.h:339-342` pattern is an anti-example).
- **Mapping.** Follower output e ∈ [0,1] → exponential frequency map: `hz = minHz · (maxHz/minHz)^e`, with user min/max as ordinary APVTS params `s{i}_cut_min` / `s{i}_cut_max`. Compose with the smoothed base cutoff **multiplicatively in log domain**, then clamp to [10 Hz, 0.45·fs]. Clamp the sum, never individual sources.
- **303 authenticity features (worth the bytes):** accent-style transient boost with a stateful leaky-integrator lag (~47–150 ms RC) that does not fully discharge between quick accents — the rising "distressed cry" of an acid run; optional detector high-pass so sub-bass doesn't pin the envelope; optional threshold-triggered AR mode (Polyverse-style) for rhythmic retriggering.
- **Sidechain source** requires `withSidechainInput` on the base ctor — v1 is self-input only; sidechain is a deliberate later increment.

### 4.3 The TB-303 acid reference patch (acceptance test for the whole system)

303 slot → diode ladder type (or SVF BP/LP until Prompt 4), cutoff parked 200–800 Hz, resonance 70–90%, dynamics follower depth high with min/max = 300 Hz–3 kHz, attack ~1–3 ms, decay 30–300 ms, plus a shallow second route onto Q. If that patch squelches, the architecture is right.

---

## 5. Implementation sequence — four prompts, in order

One logical unit per prompt. Build + commit between each. Full paste-ready text in the companion files.

| # | File | Scope | Model + effort |
|---|---|---|---|
| 1 | `xleth-filter-prompt-1-dsp-core.md` | SVF core + slot types (LP/HP/BP/notch/allpass/peak/shelves/morph) + slopes + drive/self-osc + multi-slot engine + APVTS layout + engine tests | Opus, High |
| 2 | `xleth-filter-prompt-2-modulation.md` | In-effect dynamics follower + cut min/max clamp + 303 accent lag + graph-port wiring check + modulation tests | Opus, High |
| 3 | `xleth-filter-prompt-3-ui-panel.md` | FilterPanel.jsx + store + editor registry + custom RPCs (4 layers) + response-curve canvas + design-system compliance | Sonnet, High |
| 4 | `xleth-filter-prompt-4-analog-character-pack.md` | Moog ladder, Open303 diode-ladder port (MIT), Sallen-Key, Steiner injection modes, comb, formant, tilt | Opus, High |

**Dependencies:** 2 depends on 1 (needs slots + params). 3 depends on 1 (needs the param contract) and is more useful after 2. 4 depends on 1 (extends the slot-type enum and adds cores). Do not parallelize 1 with anything.

**Verification per prompt:** `build.bat bridge-clean` after any C++ change (stale binaries cause false "still broken" reports), focused `ctest` on the new/updated test exe, `cd ui && npx vitest run rpcManifest` after any custom RPC, commit after each green build.

**Licensing note:** the SVF core derives from the public Cytomic paper (clean); the 303 ladder ports Robin Schmidt's Open303 engine — MIT, keep the license header; JUCE's own `LadderFilter`/`StateVariableTPTFilter` are usable as test oracles. Surge XT's sst-filters is GPLv3 — architecture reference only, no code.

---

## 6. Key research sources

- Zavalishin, *The Art of VA Filter Design* (free NI PDF, v2.1.2) — TPT/ZDF framework, ladder, SK
- Cytomic/Simper, `SvfLinearTrapOptimised2.pdf` (public domain) + hollance's C++ port (all mix coefficients)
- Vicanek — *Matched Second Order Digital Filters*; *Fast Modulation of Filter Parameters*
- Robin Schmidt, Open303 (MIT) — TPT diode ladder + accent behavior; Tim Stinchcombe's TB-303 diode ladder analysis (validation reference); Robin Whittle's 303 MEG/accent-sweep analysis
- RBJ Audio EQ Cookbook (baseline EQ coefficient bank); EarLevel Engineering (biquad structures, Chamberlin instability)
- GeoFex (R.G. Keen) — auto-wah/envelope-filter mapping; AAS Multiphonics CV-2 manual (peak vs RMS detection); Fractal Audio wiki (start/stop freq, sweep shape)
- Huovilainen & Välimäki — improved Moog ladder VA model; Pirkle — ZDF Moog/Korg35 app notes, self-oscillation control
- Peterson & Barney (1952) — canonical formant frequency table
- Dattorro (JAES 1997) — allpass interpolation for modulated delay lines (comb)
- Butterworth/Linkwitz-Riley Q staging tables (Hypex/RANE); JUCE docs/forums — TPT filter, denormal prevention
