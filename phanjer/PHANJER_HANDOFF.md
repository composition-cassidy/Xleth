# Phanjer — implementation handoff

**Target:** replace the `PhanjerEffect` pass-through stub (`engine/src/audio/PhanjerEffect.h`,
21 lines) with the real DSP: a **parallel flanger + phaser hybrid** whose signature behavior is
*collision leveling* — when comb peaks cross peaks, or notches cross notches, the combined
response levels out instead of amplifying / over-cancelling.

**Provenance:** a port of Krasen's first VST (also named Phanjer). The control set, layout,
and mode semantics below are taken from that plugin's UI and its built-in "HOW IT WORKS"
panel. This is an independent reimplementation informed by that design — no original code
exists to port.

**Audience:** an implementing model/engineer with no prior context.

Read section 1 and section 8 before writing any code.

---

## 1. What you are building, in one paragraph

Two modulation effects run **in parallel** on the same input: a modulated-delay flanger
(feedforward comb with bipolar feedback regen) and a biquad-allpass phaser (1–6 second-order
stages with feedback). Their comb paths are summed, scaled by per-effect submixes, then
blended against dry by GLOBAL MIX. A **mode** switch selects how collisions between the two
combs are handled: **LINKED** (one shared LFO, anti-phase sweeps, leveling guard on),
**SMART** (independent LFOs, lookahead leveling guard), **WILD** (independent LFOs, no guard,
soft saturator instead). A shared LFO shape selector (sine / triangle / saw / square / random)
plus a CHAOS control (random shape only) drive the sweeps. Each side can tempo-sync its LFO
to host BPM with a note division and feel.

```
                         ┌──────────────────────────────┐
            ┌───────────►│ FLANGER  delay dF(t), fb tanh│──► flPath ──► × mF ──┐
  in x ─────┤            └──────────────────────────────┘                      │
            │            ┌──────────────────────────────┐                      ├─► Σ = mF·flPath + mP·apPath
            └───────────►│ PHASER   N allpass, fb       │──► apPath ──► × mP ──┘        │
                         └──────────────────────────────┘                               ▼
                                                              LINKED/SMART: Σ × L(t)   (leveling, L ≤ 1)
                                                              WILD:         tanh(Σ)    (saturator)
                                                                                        ▼
                                                              out = x + G · Σ′     (G = globalMix)
```

Note the dry path: `out = x + G·(mF·flPath + mP·apPath)`. Each effect contributes only its
*processed path*; the comb interference happens against the shared dry `x`. Consequences:

- Both submixes at 0 ⇒ pure dry, always.
- Per-effect MIX = that effect's comb depth (0–100 %), not a dry/wet crossfade.
- GLOBAL MIX scales both combs together. Because the combined wet contains unity dry,
  `crossfade(x, x + paths)` and `x + G·paths` are algebraically identical — use the latter.

---

## 2. Control set (from the original UI — every control maps to exactly one engine param)

**Header:** mode selector — LINKED / SMART / WILD (default LINKED). Help overlay ("?").
*No preset bar* — XLETH persists effect state with the project; the original's SAVE/Load
row is deliberately dropped.

**FLANGER column**
| control | param id | range | default | notes |
|---|---|---|---|---|
| MIX | `f_mix` | 0–100 % | 75 | submix / comb depth |
| RATE | `f_rate` | 0.05–10 Hz (skew 0.5) | 0.5 | disabled while `f_sync` on |
| DEPTH | `f_depth` | 0–100 % | 70 | sweep excursion |
| FEEDBACK | `f_feedback` | −95–95 % | 40 | bipolar; negative swaps peak/notch roles |
| DELAY MIN | `f_delay_min` | 0.1–20 ms | 1.0 | sweep low bound |
| DELAY MAX | `f_delay_max` | 0.1–20 ms | 5.0 | sweep high bound; engine swaps if min > max |
| note icon | `f_sync` | bool | off | tempo-sync toggle |
| division | `f_sync_div` | choice: 1/1 1/2 1/4 1/8 1/16 1/32 | 1/4 | |
| feel | `f_sync_feel` | choice: Straight / Triplet / Dotted | Straight | |

**PHASER column**
| control | param id | range | default | notes |
|---|---|---|---|---|
| MIX | `p_mix` | 0–100 % | 75 | |
| RATE | `p_rate` | 0.05–10 Hz (skew 0.5) | 0.35 | disabled while `p_sync` on; whole row disabled in LINKED (shared LFO follows flanger) |
| DEPTH | `p_depth` | 0–100 % | 80 | |
| FEEDBACK | `p_feedback` | −95–95 % | 40 | |
| stage stepper (−/+) | `p_stages` | 1–6 int | 6 | second-order allpass stages = notch count |
| FREQ MIN | `p_freq_min` | 20–2000 Hz | 100 | sweep low bound |
| FREQ MAX | `p_freq_max` | 200–16000 Hz | 4000 | sweep high bound |
| note icon / division / feel | `p_sync`, `p_sync_div`, `p_sync_feel` | as flanger | off / 1/4 / Straight | |

**Center column**
| control | param id | range | default |
|---|---|---|---|
| GLOBAL MIX | `global_mix` | 0–100 % | 50 |
| LFO SHAPE (5 icons) | `lfo_shape` | choice: Sine / Triangle / Saw / Square / Random | Sine |
| CHAOS | `chaos` | 0–100 % | 0 — active only when shape = Random |

24 APVTS parameters total. These ids are the UI contract — the panel writes them verbatim
through the generic `setEffectParameter(trackId, nodeId, id, value)` bridge call.

---

## 3. DSP cores (reuse proven topologies)

**Flanger core** — copy the topology of `XlethFlangerEffect.h` verbatim, generalized to a
swept *range* instead of a single center delay:

- `juce::dsp::DelayLine<float, Lagrange3rd>` per channel. Lagrange3rd is the minimum
  acceptable interpolation for modulated comb delays (linear interp creates audible noise).
- Read-before-push; feedback path `tanh(delayed · fbGain)`, `fbGain = clamp(f_feedback/100, −0.95, +0.95)`.
- Sweep: `dF(t) = dMin · (dMax/dMin)^uF(t)` (log sweep, uF ∈ [0,1] from the LFO), then
  modulated: instantaneous delay `d = dF · (1 + 0.8·(depth/100)·(lfoSigned))` is **wrong** —
  depth is already the excursion of uF; see §4. Simply: `dF(t)` *is* the delay time;
  `depth` scales LFO excursion around the range center (§4).
- Delay-line capacity: worst-case read offset = `dMax` exactly (no extra modulation on top),
  so size for `20 ms + interpolation headroom` at the current sample rate, rounded up to a
  power of two. 20 ms @ 192 kHz = 3840 → 4096 samples.
- `flPath = delayed` (the regen-coloured delay output, *pre* dry mix — dry is added by the
  global sum, not here).

**Phaser core** — copy `XlethPhaserEffect.h`'s biquad-allpass cascade (Direct Form II
Transposed, Audio EQ Cookbook coefficients, feedback around the whole cascade via
`lastOutput`), with two deliberate simplifications: **no resonance knob** (fix Q = 1.0) and
**no spread knob** (stage stagger fixed, below). These controls don't exist on the original
UI; do not add hidden ones.

- Stage frequencies: geometric center `c = sqrt(fMin · fMax)`; sweep position
  `s = (uP − 0.5) · depth/100` ∈ [−0.5, 0.5]; per-stage stagger spreads the N stages evenly
  across one window in log space:
  `stageT_i = (N > 1) ? i/(N−1) − 0.5 : 0` (range ±0.5);
  `f_i = c · exp((s + 0.5·stageT_i) · ln(fMax/c))`, clamped to [20 Hz, 0.499·sr].
  (Same center-based symmetric log sweep as `XlethPhaserEffect`; stagger fixed at the
  equivalent of its spread = 50 %, i.e. ±0.25 octaves per end stage.)
- Feedback: `x += clamp(p_feedback/100, −0.95, 0.95) · lastCascadeOutput`, per channel.
- `apPath = cascadeOutput` (pre dry mix).

**Stereo:** both channels share the same delay/frequency trajectories (mono modulation —
the original has no width control; do not invent one). State (delay lines, biquad z1/z2,
lastOutput) is per channel.

---

## 4. LFO engine (shared)

One LFO **shape function** maps phase φ ∈ [0, 2π) → u ∈ [0, 1]:

| shape | u(φ) |
|---|---|
| Sine | `0.5 + 0.5·sin(φ)` |
| Triangle | `|2·(φ/2π mod 1) − 1|` inverted appropriately — standard tri, [0,1] |
| Saw | `φ/2π mod 1` |
| Square | `φ mod 2π < π ? 1 : 0` |
| Random | smooth random: new target per cycle, cubic-smoothed interpolation across the cycle |

Always pass u through a **1 ms one-pole** before use — de-clicks Square and the Random
cycle boundaries, inaudible otherwise. Never stack generic param smoothing on top of the
LFO output beyond this.

**CHAOS (Random shape only):** `u = clamp01(u + (chaos/100)·(0.5·r3 + 0.25·r7))`, where
r3, r7 ∈ [−1, 1] are independent smooth-random sources running at 3× and 7× the LFO rate.
At 0 the shape is a gentle wobble; at 100 a dense, broken sweep. For all other shapes CHAOS
is ignored (and the UI greys it).

**RNG:** fixed-seed xorshift32 per instance (seeded in `prepareEffect`, e.g. 0x9E3779B9 ⊕
instance counter). Deterministic per run, decorrelated across instances.

**Depth application:** for both engines, depth scales excursion around the sweep's midpoint:
`u_eff = 0.5 + (u − 0.5)·(depth/100)`. At depth 0 the sweep parks at the geometric center of
the range. (`f_depth` parks the *delay* sweep; `p_depth` parks the *frequency* sweep.)

**Tempo sync (per side):** when sync is on,
`rateHz = (bpm/60) · (4/div) · feelMult`, feelMult = Straight 1, Triplet 2/3, Dotted 3/2.
BPM comes from `XlethEffectBase::getGlobalBPM()` (already plumbed by MixEngine every block).
Factor this into a pure static function `resolveRateHz(rawRate, syncOn, div, feel, bpm)` so
the test harness can call it directly.

---

## 5. The collision-leveling engine (the point of the plugin)

Both combs are **analytically known** at every instant — flanger peaks/notches sit at
multiples of `1/dF`, phaser notches at the stage frequencies. That makes collision detection
exact and cheap. Run at control rate (once per block is enough; sweeps are sub-10 Hz).

**Feature sets** (evaluate at the lookahead horizon, see below):

- Flanger peaks `FP = { k/dF : k = 1,2,… while k/dF < 8 kHz }`
- Flanger notches `FN = { (k+½)/dF < 8 kHz }`
- Phaser notches `PN = { f_i, i = 0..N−1 }` (clamped set from §3)
- Phaser peaks `PP = { √(f_i · f_{i+1}) }` (geometric midpoints — where feedback regen rings)

**Negative feedback swaps roles:** if `f_feedback < 0`, swap FP ↔ FN. If `p_feedback < 0`,
swap PN ↔ PP. Do this before pairing — it's the same physics (regen flips which frequencies
reinforce).

**Collision metric:** for peak-peak pairs FP × PP and notch-notch pairs FN × PN, take
`δ = min over pairs |log2(fa/fb)|`. Guard band = ⅓ octave (δ₀ = 0.333).
`C = max(0, 1 − δ/δ₀)` ∈ [0, 1]; 1 = exact coincidence.

**Leveling gain:** `L_target = 1 − 0.5·C` (up to −6 dB at exact coincidence — enough to stop
the doubling without gutting the effect). Smooth L with an asymmetric one-pole: ~5 ms attack,
~60 ms release. Apply to the summed path: `Σ′ = L · (mF·flPath + mP·apPath)`.

**Lookahead:** evaluate both LFO trajectories at `t + 30 ms` (phases are known constants —
advance a scratch copy of the phase accumulators; for the Random shape read from the
already-determined next-cycle targets). The duck therefore lands *before* the coincidence,
not after. 30 ms of phase arithmetic per block is free.

**Cost bound:** ≤ 8 flanger features × ≤ 6 phaser features × 2 pair classes, once per
block. Fixed-size stack arrays. No allocation, no locks, no logging on the audio path.

### Modes as one configuration table

| | LFO topology | leveling guard | saturator |
|---|---|---|---|
| LINKED | one shared phase; `uP = 1 − uF` (anti-phase) | ON (lookahead 30 ms) | off |
| SMART | independent phases & rates | ON (lookahead 30 ms) | off |
| WILD | independent phases & rates | OFF | `tanh(1.5·Σ)/tanh(1.5)` on Σ |

LINKED's anti-phase mapping means the flanger's comb rises as the phaser's falls — crossings
happen at maximum relative velocity (minimum dwell) and are then caught by the guard.

**Honesty note:** the original VST's help text claimed LINKED makes collisions
"mathematically impossible". That is not true for two combs of different spacing sweeping
shared spectrum — crossings are unavoidable; what *is* achievable is bounded, brief,
leveled crossings. This implementation is strictly better than the original claim. Keep the
user-facing help text close to the original wording (it's his plugin's voice), but do not
encode the impossibility assumption anywhere in code.

---

## 6. XLETH integration constraints (non-negotiable)

- Engine is C++ / JUCE 8, header-only effect classes derived from `XlethEffectBase`
  (`engine/src/audio/XlethEffectBase.h`). Stereo in/out, APVTS-backed params, base-class
  smoothing. Follow `XlethFlangerEffect.h` / `XlethPhaserEffect.h` as the style and
  correctness reference.
- **Audio thread: no allocation, no locks, no logging.** Delay lines, biquad state, feature
  arrays, and the random-trajectory targets are sized in `prepareEffect` / fixed at compile
  time.
- Register continuous params with `registerSmoothedParam` (Linear 20 ms for mixes/depths/
  feedback/chaos/global_mix; Multiplicative 30 ms for `p_freq_min/max`; manual one-pole
  50 ms for `f_delay_min/max` and both `rate` params — delay-time and rate changes should
  glide, not zipper). Resolve handles once in `prepareEffect` via `resolveSmoothed`.
  Discrete params (`mode`, `lfo_shape`, `p_stages`, syncs, divs, feels) read raw atomics.
- Use `juce::ScopedNoDenormals` (base class already applies it in `processBlock`).
- Metering: slot 0 = output peak L, slot 1 = output peak R, slot 2 = current leveling gain
  L (0–1; 1 in WILD). The UI response canvas uses slot 2.
- `pluginId` stays `"phanjer"`. The factory entry in `AudioGraph.cpp` (`make_unique<
  PhanjerEffect>()`) and the UI catalog entries already exist — do not duplicate them.
- **Do not touch `StockParameterCatalog.{h,cpp}`** — dead, untracked, uncompiled files.
- After any C++ change: `build.bat`, then **`build.bat bridge-clean`** (stale `.node`
  binaries cause false "still broken" reports), then run the test exe, then commit. One
  logical unit per commit.
- Debug instrumentation behind `#ifdef XLETH_DEBUG`, `[Phanjer]` prefix.
- Windows-only. No new dependencies. Open source — clean, commented code.

---

## 7. Verification plan

**Unit tests — new `engine/test/test_phanjer.cpp`, mirroring `test_distortion.cpp`'s
harness and CMake registration:**

1. **Param contract** — all 24 ids exist with the ranges/defaults in §2; set/get round-trips.
2. **State round-trip** — `getStateInformation` → mutate → `setStateInformation` restores.
3. **Silence in → silence out** in all three modes × five shapes (2 s each).
4. **Fuzz** — random extreme param jumps per block while processing noise; assert finite
   output, |out| < 4, no read past the delay buffer (dMax = 20 ms, depth 100, sr = 192 kHz).
5. **Leveling works** — the money test. Park both sweeps (depth = 0) with ranges chosen so a
   flanger peak exactly coincides with a phaser feedback peak (compute ranges from the §5
   formulas). Feed white noise, measure the combined magnitude at the collision frequency:
   assert SMART's peak is at least 3 dB **below** WILD's at the same settings.
6. **`resolveRateHz`** — pure-function table test (sync off → raw rate; each div/feel pair
   at 140 BPM).

**Perceptual check:** on a 140 BPM Sparta chorus stack: LINKED should read as a smooth,
wide, clean sweep with no "blast" moments; SMART similar but with independent motion;
WILD should be allowed to get hairy but never harsh-clip (tanh keeps it glued). If SMART
sounds identical to WILD, the guard isn't engaging — check meter slot 2 moves.

**UI verification (Prompt 2):** every control writes its engine param (check against the
§2 id table), LINKED disables the phaser rate/sync row, sync disables its RATE knob, CHAOS
greys out unless shape = Random, hydration restores engine state on open, and
`effectCatalog.test.js` / `EffectEditorHost.test.jsx` still pass.

---

## 8. DO NOT

1. **Do not add width/spread/resonance knobs.** The original UI doesn't have them. Hidden
   unexposed params are debt.
2. **Do not smooth the LFO output with param smoothers.** One 1 ms one-pole on u only.
3. **Do not put dry inside `flPath`/`apPath`.** Dry enters once, in the global sum. Doubling
   dry breaks the §1 algebra and the leveling math.
4. **Do not skip the negative-feedback peak/notch swap** in the collision engine — with
   bipolar feedback it's physically wrong, and both knobs go negative.
5. **Do not allocate in `processEffect`** — not even `std::vector` "temporarily". Fixed
   arrays; the feature sets are bounded (≤ 8 + 6 entries).
6. **Do not trust `build.bat` success alone** — `bridge-clean` then test, then commit.
7. **Do not touch StockParameterCatalog, the bridge, or the RPC layer** — params flow
   through the generic APVTS enumeration that every other stock effect already uses.
8. **Do not "simplify" the modes into one.** The three modes are the product. The config
   table in §5 exists so they share code, not so they merge.

---

## 9. Companion files

- `phanjer-prompt-1-engine-dsp.md` — Prompt 1 (engine core + tests). Route: **Opus, High**.
- `phanjer-prompt-2-ui-panel.md` — Prompt 2 (React panel + registration). Route: **Sonnet, High**.

Run order: Prompt 1 → verify build/tests/commit → Prompt 2 → verify UI → commit. The UI
prompt depends on the engine's param ids existing; do not parallelize them.
