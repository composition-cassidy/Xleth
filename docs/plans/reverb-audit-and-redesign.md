# XLETH Stock Reverb Audit & Redesign Plan

Date: 2026-07-23 · Scope: all stock reverb DSP in the engine, the plate instability report, and a phased redesign plan. **Analysis only — no code was changed.**

---

## 1. Inventory

There is exactly **one** stock reverb effect, registered as `pluginId "reverb"` in the factory at `engine/src/audio/AudioGraph.cpp:2763` (`XlethReverbEffect`). All DSP lives in one 2011-line header, `engine/src/audio/XlethReverbEffect.h`, with **four backends** dispatched per block from the `style` choice parameter (`processEffect`, lines 959–1010):

| Style | Backend | Actual topology |
|---|---|---|
| Generic (smoothness=0) | `processBlockLegacy` (1026) | 8×8 FDN, Hadamard (FWHT, 1/√8), consecutive-prime delays 809–1499 samp @48k, per-line one-pole damping, per-line DC blocker, per-line sine LFO delay modulation, even/odd L/R output split. Bit-frozen legacy path. |
| Generic (smoothness>0), Room | `processBlockEnhanced` (1173) | Same 8×8 FDN skeleton with log-spread non-adjacent-prime delays, signed decorrelated input/output vectors, smoothness-driven damping/ER-soften/HF-shelf. |
| Hall | `processBlockHall` (1365) | Dedicated 16×16 FDN (FWHT-16), delays 1097–2999 samp, two-stage per-line damping (decorrelated stage A + fixed HF tilt), 2-stage Schroeder input diffusion, 16-element I/O vectors. |
| Plate | `processBlockPlate` (1581) | Ad-hoc **Dattorro-inspired but structurally reduced** cross-coupled two-arm tank: 4-stage input diffusion → arm A `[mod-AP → long delay → LPF → fixed AP → DC]` → ×fb → arm B (same) → ×fb → back to A via a 1-sample cross-feed (`lastB`). 6 output taps (3 per arm, all from the two long delays). |

Also present: `engine/src/audio/ReverbEffect.h` — a **dead pass-through stub** with the same `pluginId "reverb"`. It is never registered (factory instantiates `XlethReverbEffect`). It should be deleted; it is a trap for anyone grepping for the reverb.

Shared plumbing (all styles): pre-delay (non-interpolated, **unsmoothed**, read per block — header line 51 "None — read per block"), hicut/locut one-pole output tone filters, 5 ms bypass crossfade and per-block smoother-target updates in `XlethEffectBase` (`engine/src/audio/XlethEffectBase.h`). `juce::ScopedNoDenormals` is active for every effect block (`XlethEffectBase.h:310`).

Parameter flow (verified end-to-end):
- **UI** `ui/src/components/mixer/ReverbPanel.jsx` — knob min/max/defaults **exactly mirror** the engine APVTS ranges (decay 0.1–30 s, size 0–100 %, etc.). Values sent denormalised via `window.xleth.audio.setEffectParameter(trackId, nodeId, id, value)` on both `onLiveChange` and `onCommit`.
- **Engine** `XlethEffectBase::setParameterValue` (XlethEffectBase.h:213) converts through `convertTo0to1`, which **clamps to the NormalisableRange** — the UI cannot push out-of-range values into the DSP.
- Smoothing: every continuous param is registered with 20–30 ms Linear/Multiplicative smoothing (XlethReverbEffect.h:870–880); targets pulled from APVTS atomics once per block (`updateSmootherTargets`), advanced per sample. Parameter changes are therefore **block-quantized at the target level but sample-smooth in value** — no step discontinuities enter the feedback loops. Exceptions: `predelay` (unsmoothed, block-rate, non-interpolated line → zipper/clicks while dragging) and `style` (hard reset of all tanks on switch, lines 971–979 → audible dropout, mitigated on Plate by a 21 ms entry ramp, lines 1834–1841).
- `StockParameterCatalog.cpp:46–55` is display metadata only. Note: it labels reverb `mod_rate` with unit "Hz"/log — the engine treats `mod_rate` as a 0–100 % scalar on per-line Hz tables. Cosmetic mislabel.
- FX graph feedback: impossible — `AudioGraph::wouldCreateCycle` guards every connect path (AudioGraph.cpp:399, 501, 1466, 1587). Reverb is an insert; there is no send-return loop that could externally regenerate it.

---

## 2. Plate instability — root cause

### 2a. What the code proves about the *historical* runaway

The in-source comments document that the reported symptom **was real and was caused by three concrete defects**, since fixed (file history: last touched 2026-05-06):

1. **Dual-arm input injection** — the diffused input was injected into *both* arms, doubling per-round-trip excitation (comment at lines 1734–1739: "that was the original bug… caused ~20× steady-state gain at high decay").
2. **Input gain 0.6** with near-unity feedback (comment at lines 491–495: "preventing the gain explosion that occurred at 0.6f with near-unity feedback"). Now `kPlateInputGain = 0.20`.
3. **Feedback ceiling 0.97** → steady-state tank bound `0.6/(1−0.97²) ≈ 10×` per arm (≈20× wet). Now ceiling `0.93 − smoothFrac·0.08` (line 1665), bound `0.20/(1−0.93²) ≈ 1.48×`.

The regression test `testPlateAggressiveImpulseDecays` (`engine/test/test_reverb.cpp:2680–2746`) locks the fix: max decay, zero damping, impulse → peak must stay < 2.0.

### 2b. Verdicts on each hypothesis (current code)

| Hypothesis | Verdict | Evidence |
|---|---|---|
| Feedback coefficient ≥ 1 / summing above unity | **Ruled out (current)** / **Confirmed (historical)** | `feedbackGain = clamp(10^(−1.5·τ/T60), 0, 0.93−0.08·smooth)` applied twice per round trip → loop gain ≤ 0.93² = 0.865 at every frequency (lines 1665–1668, 1678–1679, 1740). All other loop elements have |H| ≤ 1 (Schroeder allpasses unity; one-pole LPFs unity at DC; DC blockers peak ≈ 1.0003 at Nyquist). Spectral radius < 0.87 → exponential decay guaranteed. |
| Missing/insufficient LP damping in loop | **Ruled out as instability; confirmed as a tuning flaw** | Damping has a hard floor: `dampG = clamp(0.20 + damping·0.75 + smooth·0.25, 0, 0.95)` (1645–1647). But it is a *single* one-pole per arm, and the 6 output taps read the long delays **before** damping (push at 1695, taps 1699–1710, LPF only at 1719–1720) — the wet output is brighter/spikier than the recirculating signal. |
| Missing DC blocker in loop | **Ruled out** | Per-arm 5 Hz DC blockers inside the loop (1726–1730, 1779–1783). |
| Broken T60 mapping | **Partially confirmed — this is a real defect** | Mapping formula is correct in form (`10^(−1.5·τ_roundtrip/T60)` per application, 1655–1668) but: (a) it **saturates at the 0.93 ceiling for every decay ≥ ~6.4 s** (size 50) — the top **80 % of the knob range (6.4→30 s) is dead**; (b) `roundtripSec` scales *all* delays by `sizeScale` (1596–1599, 1655–1656) but the mod-allpass and fixed-allpass delays are **not** size-scaled at runtime (1686–1688; fixed APs sized at prepare, 834–837) — T60 is mildly wrong as a function of size. |
| Unbounded wet output / additive mix | **Partially confirmed** | Mix is a proper linear crossfade (1866–1869), not additive. But the 6-tap bus has **no energy normalization**: Σ\|gain\| ≈ 2.75/channel × 0.55 trim; worst-case coherent wet through-gain ≈ **2.2× input** (+7 dB) at max `er_late`/`mix`. No limiter/soft-clip on wet (only non-finite guards, 1791–1798, 1824–1825). |
| Denormal amplification | **Ruled out** | `ScopedNoDenormals` wraps every `processBlock` (XlethEffectBase.h:310). |
| Modulated APs destabilizing the loop | **Ruled out as driver** | Depth ≤ ±1.5 samples (3.0 × 0.5 scalar, 486–487, 1670–1672) against a ≥1.26 dB/round-trip decay margin. |

### 2c. The *remaining* mechanism that reproduces the reported symptom

The current plate cannot grow exponentially — but it is engineered to **sound and behave exactly like a feedback loop** at high decay, and to get genuinely loud on sustained tonal input. Three compounding design defects:

1. **It is a single fixed-period series loop.** The whole tank is one ~6428-sample round trip (≈134 ms at size 50, ≈167 ms at size 100). That yields a uniform comb of resonant modes every **~7 Hz** with closed-loop magnification `1/(1−0.865) ≈ 7.4×` at each mode. *Any* sustained pitch lands within ~3.5 Hz of a mode.
2. **The loop period is effectively unmodulated.** Unlike the FDN styles — whose delay lines themselves are LFO-modulated (`popSample(0, modulatedDelay)`), decohering resonances — the plate's long delays are read at a fixed delay ("no interpolation; modulation lives in the modulated allpass stage", 721–722), and the allpass modulation is ±0.3 samples at default `mod_depth`. Regeneration is therefore **phase-coherent**: repetitive pitched material (the Sparta Remix use case — one sample retriggered rapidly at fixed pitch) pumps the same modes every hit and builds toward the 7.4× resonant ceiling over ~1–2 s.
3. **The decay knob pins at the ceiling.** Everything from ~6.4 s to 30 s produces the identical maximal ring (RT60 ≈ 6.4–8 s of *periodic 134–167 ms echo*, since in-loop diffusion — two short APs per arm, ≤21 ms — cannot fill a 134 ms period). Perceptually: a repeating, slowly-decaying slapback that stacks with dense input and pushes wet ~+7 dB over dry.

**Conclusion:** confirmed root cause of the *runaway* = the pre-May triple defect (2a), now fixed in source; confirmed root cause of the *still-reported* "feedback-loops and gets extremely loud" = the bounded-but-resonant single-loop design in 2c. One residual uncertainty — whether the binary the user hears actually contains the May fix — is a runtime check (§5, item 1); `bridge/build/Release/xleth_native.node` is dated 2026-07-23 13:36, so it is *probably* current.

### 2d. Why the existing tests didn't catch it

`test_reverb.cpp` plate tests (2415–2746) are all: 48 kHz only, block size 512 only, parameters set **before** `prepareToPlay`, and impulse or 0.1-amplitude short-sine excitation. None of them: run at 44.1 kHz (the app's actual rate), sweep decay/size/damping while audio runs, or drive **sustained loud tonal input at max decay and measure steady-state wet gain** — which is precisely the reported failure mode.

---

## 3. Per-reverb critique vs. reference designs

### Legacy Generic (8-line FDN) — reference: well-formed Jot FDN
- **Stability:** unconditional. `g = 10^(−3·τ_line/T60)` per line (1110–1115) is the textbook Jot formula, always < 1; Hadamard is orthonormal (1/√8, 1931–1932); damping LPFs and DC blockers inside the loop. Verified stable across the full parameter range.
- **Decay/coloration:** consecutive primes 809–1499 span only a 1.85× ratio — modal clustering → the documented metallic ring (this is *why* the "anti-metal"/Ring Tame program exists). Equal in-phase input injection to all 8 lines (1122–1123) excites clustered modes coherently.
- **Echo density:** no input diffusion (0 stages) — tail onset is granular/clicky on transients. A reference FDN puts 2–4 series allpasses before the lines.
- **Stereo:** even→L / odd→R line split (1126–1127) — cheap but acceptable decorrelation.
- **Verdict:** frozen by design for project compatibility. Do not touch (in-source contract, 1018–1025).

### Enhanced Generic / Room (8-line FDN) — reference: same
- Real improvements over legacy: log-spread non-adjacent primes, signed decorrelated I/O vectors, energy-normalized (Σ|g|²≈8 in, Σg²≈4/channel out).
- **Room ships with zero input diffusion** (`kRoomTuning` stages = 0, line 304–310) — a "Room" whose tail onset is a bundle of discrete comb hits. Reference designs diffuse the FDN feed.
- The reserved SMOOTH diffuser pair (197/313 samples) is allocated and documented as disconnected (211–216) — dead CPU-adjacent state, but a ready seam.
- ER network is a shared mono tap line with static gains; no ER diffusion, no size-dependent gain shaping beyond tap-time scaling.

### Hall (16-line FDN) — reference: modern 16-line FDN
- The best of the four. 16 log-spread lines (22.9–62.5 ms, ratio checked against small-integer fractions), FWHT-16, **two-stage per-line damping with decorrelated per-line offsets** (1467–1478) — this is the correct anti-metal lever and mirrors what commercial FDNs do. 2-stage input diffusion. Sub-chorus modulation.
- Weaknesses: input diffusion is short (4.4 + 7.6 ms) for a hall; ER still the shared static tap line; `decayScale = 1.4` silently makes the knob read 30 s while targeting 42 s (knob dishonesty in the opposite direction from Plate's).
- **Stability:** unconditional, same Jot argument. Verified.

### Plate (cross-coupled tank) — reference: Dattorro (JAES 1997)
What Dattorro does that XLETH's plate doesn't:
1. **Two delays per arm** (`mod-AP → delay1 → damp → AP → delay2`), giving four long tank delays; XLETH has one per arm — half the tank, half the mode density, and the fixed AP feeds the cross-feed directly.
2. **~3–5× longer loop** relative to sample rate. Dattorro's tank round trip is several hundred ms; XLETH's is 134 ms → 7 Hz comb, audible periodicity.
3. **7 output taps per channel distributed across all four tank delays**, spatially and temporally interleaved so no single period dominates; XLETH takes 3 taps per arm from the same two delays, all offsets < 31 ms — the output restates the loop period every 134 ms.
4. **Decay gain applied inside each arm** (between delay1 and delay2), and decay is an honest 0–1 control; XLETH applies it at the two cross-feed points and then clamps to 0.93, deadening 80 % of the knob.
5. Dattorro modulates the tank's first allpass with enough depth (±8 samples @ 29.8 kHz) to decohere regeneration; XLETH's ±0.3–1.5 samples on a fixed-period loop does not.
6. Taps read **post-damping** signal paths in Dattorro's tap set; XLETH taps pre-damping (bright spikes).
- **Stability:** bounded (proven, §2b) but perceptually indistinguishable from feedback at high decay (§2c). This is the one to rewrite, not tune.

### Cross-cutting quality issues (all styles)
- **Mix law:** linear crossfade → −6 dB center dip vs. equal-power. Audible when automating mix.
- **Wet-level calibration:** styles are only loosely level-matched (test tolerance is ±4×, `testPlateWetLevelBounded` 2536–2543). Style A/B comparison is confounded by loudness.
- **`er_level`/`er_late` silently change meaning on Plate** (bloom blend / tank level, 1574–1577) with no UI hint — the UI labels are ER LEVEL / LATE LEVEL for every style.
- **`getTailLengthSeconds` returns the decay knob** (952–955) — up to 30 s while Plate's real ceiling is ~8 s. Harmless today only because MixEngine's tail drain is output-level driven (MixEngine.cpp:33–40).
- **Pre-delay is unsmoothed and non-interpolated** — dragging it zipper-clicks.

---

## 4. RT-safety findings (audio callback path)

- **No allocations, no locks, no logging** in any `processBlock*` path. All buffers sized in `prepareEffect` to worst-case across styles (908–931). The NaN guard's `plateLate_.reset()` (1793) memsets several delay buffers mid-callback — allocation-free but a CPU spike; acceptable as a panic path.
- **Real finding — per-sample string-keyed map lookups:** `getNextSmoothedValue(const std::string&)` (XlethEffectBase.h:439–444) is called **11× per sample** in every reverb backend (and pattern-repeats across all stock effects). Each call constructs a `std::string` temporary (SSO — no heap for ids ≤ 15 chars, but any future longer id would silently heap-allocate per sample) and does an `unordered_map` hash+find. At 44.1 kHz that is ~485k hashed lookups/s per reverb instance of pure overhead.
- **Transcendental load:** per sample the FDN paths compute 8–16 `std::sin` + 8–16 `std::pow(10, x)` + 2 `std::exp` (hicut/locut coefficients recomputed every sample even when the params are static). Hall ≈ 1.4 M transcendentals/s. None of this is hoisted to block rate.
- Meters are relaxed atomics (fine). Parameter writes go through APVTS atomics (fine). `TimingScope`/`steady_clock` only when diagnostics are enabled (fine).

---

## 5. Not confirmable from code reading — runtime tests required

1. **Binary provenance.** Confirm the running `xleth_native.node` embeds the post-fix plate. Test: rebuild bridge addon, launch app via the CDP smoke recipe (`XLETH_PLAYWRIGHT=1` + `--remote-debugging-port`), insert reverb → Plate → decay 30/size 100/damping 0, feed a looped sample for 30 s, watch the track meter. Bounded ≈ +7 dB ceiling ⇒ current code (symptom = §2c); unbounded growth past +20 dB ⇒ stale binary or an unknown defect.
2. **Perceptual periodicity claim.** Render a single impulse through Plate at decay 30 and autocorrelate: predicted strong peaks at ~134·sizeScale ms multiples, decaying ~1.26 dB per period.
3. **44.1 kHz + live-sweep behavior.** No test exists at the app's real rate or with params swept during processing. Add engine tests (Phase 0) sweeping size 0↔100 and decay 0.1↔30 over 10 s of sustained sine at 44 100 Hz, asserting finite + bounded peak.
4. **Realtime vs. export instance sharing.** Whether `AudioExporter` ever processes the same effect instances concurrently with the realtime graph (data race → garbage bursts). Needs a runtime/export trace.
5. **Steady-state gain numbers** (1.48× tank, ~2.2× wet, 7.4× modal Q) are closed-form estimates; the Phase 0 test should measure them.

---

## 6. Phased redesign plan

Priorities: **Plate = rewrite** (topology is unsalvageable for the genre's sustained-tonal input); **Hall = keep, polish**; **Enhanced Generic/Room = fix diffusion + calibration**; **Legacy Generic = frozen, untouched**; **base-class CPU pass = shared win**. Every phase is one implementation prompt with build + `test_reverb` + addon smoke verification. Audio-thread constraints (no alloc/locks/logging) hold for every phase; all buffers keep being sized in `prepareEffect`.

### Phase 0 — Reproduce, measure, and lock the truth (tests only, no DSP change)
- Extend `test_reverb.cpp`: (a) 44 100 Hz duplicates of the plate stability tests; (b) sustained-sine steady-state gain test at max decay/size, min damping — assert wet peak ≤ a stated bound (measured, expected ≈ 2.3×) and **record** the value; (c) live-sweep tests (decay, size, damping ramped during processing) asserting finite + bounded; (d) impulse-autocorrelation periodicity test documenting the 134 ms comb (this becomes the *failing-by-design* spec test that Phase 1 must fix, guarded behind an `#if` until then).
- Runtime check §5.1 (binary provenance) via the CDP smoke recipe.
- **Interim guard (explicitly a band-aid, separate from the real fix):** if product wants immediate relief before Phase 1 lands, a wet-bus soft-clip (`tanh`-style, engaging above ~0 dBFS) on the Plate wet sum only. It must be labeled temporary and removed in Phase 1; it does not fix the feedback math and must not be accepted as the fix.

### Phase 1 — Plate rewrite on true Dattorro topology (the real fix)
- Keep: APVTS ids/ranges (zero bridge/UI churn), 4-stage input diffusion, entry ramp, per-arm DC blockers, NaN guard.
- Rebuild the tank: per arm `mod-AP → delay1 → damping LPF → decay-gain → AP → delay2`, cross-coupled figure-8; four long delays totaling a ≥ 400 ms round trip at 48 k (scaled by size ±25 %); decay gain applied **inside** each arm.
- Honest T60: per-application gain `10^(−3·τ_actual/ (2·T60))` with `τ_actual` summing the *actual* runtime delays (including APs, size-scaled consistently). Ceiling raised to 0.9995 — stability now comes from the exact T60 relation, not a clamp; the knob's full 0.1–30 s range maps to real RT60.
- 7 output taps per channel drawn from all four delays (post-damping points included), gains normalized Σg² = 1 per channel, then a single calibrated wet trim.
- Tank modulation moved onto delay1 of each arm (±6–8 samples, existing mod_rate/mod_depth semantics) to decohere regeneration — this is what kills the "feedback loop" percept at long decay.
- Verification: Phase 0 tests all green including the periodicity spec test (autocorrelation peak at loop period must drop below threshold), steady-state gain test, 44.1 k, live sweeps; `testPlateBackendIsDistinct` etc. still pass; full `test_reverb` + bridge contract + app smoke.

### Phase 2 — Level calibration + knob honesty (all styles except Legacy)
- Equal-loudness wet calibration across Generic-enhanced/Room/Plate/Hall (pink-noise RMS match within ±1 dB, locked by test).
- Equal-power mix law (√ crossfade) for the non-legacy paths.
- `getTailLengthSeconds` returns the effective (style-scaled, ceiling-aware) RT60.
- Fix `StockParameterCatalog` `mod_rate` unit mislabel; document per-style `er_level`/`er_late` semantics in the catalog so the UI can relabel knobs per style (UI text change only, `ReverbPanel.jsx` STYLE-aware labels).

### Phase 3 — Room/Generic-enhanced diffusion + ER polish
- Give Room 2-stage input diffusion (reuse the reserved `smoothDiffusers` seam, 211–216 — either wire it or delete it); optional 1-stage for enhanced Generic behind Ring Tame.
- ER improvements: per-style ER decorrelation via a short allpass on the ER bus; smooth `predelay` (Linear 30 ms + interpolated read) to kill zipper.
- Crossfade style switches (short dual-run or output fade) instead of the hard reset dropout.

### Phase 4 — Base-class CPU pass (benefits every stock effect)
- Replace per-sample string lookups with prepare-time-resolved smoother handles (e.g. `SmoothedHandle h = resolveSmoothed("decay")` in `prepareEffect`, `h.next()` per sample). Keep the string API for compatibility; migrate reverb + the hottest effects.
- Hoist per-sample `exp`/`pow` coefficient math (hicut/locut, RT60 gains) to block rate with per-sample linear interpolation of the *coefficients* — **excluding `processBlockLegacy`**, which stays bit-frozen.
- Cheap phasor/parabolic LFO instead of `std::sin` in the FDN modulators (also excluding legacy).
- Verify: determinism tests for legacy path bit-identical; RMS-delta tolerance tests for the others; CPU before/after via the realtime timing context.

### Phase 5 — Cleanup
- Delete dead `engine/src/audio/ReverbEffect.h`.
- Remove the Phase 0 interim soft-clip if it was added.
- Update the metering/docs comments in the reverb header to match the new plate.

Dependency order: 0 → 1 → 2; 3 and 4 independent after 2; 5 last. Phase 1 is the only large one and is deliberately isolated to `processBlockPlate` + `PlateLate` + the plate constants block, with the parameter surface unchanged.

---

## 7. ERRATA (2026-07-24) — §2b/§2c are SUPERSEDED

**§2b and §2c are wrong and must not be trusted.** They were derived by code-reading and were contradicted at runtime (Phase 0) and then root-caused empirically (Phase 1 stabilization). Corrections:

- **The plate was NOT bounded.** §2b claims "spectral radius < 0.87, exponential decay guaranteed." In fact the plate ran away exponentially at high decay: measured **~67× per tank round-trip** (steady-state wet gain 1.85e38 / +765 dBFS at 44.1 kHz; +589 dB in 3 s in the live app). Stable at decay ≤ 2 s, runaway by decay ~15 s.

- **Root cause = a Schroeder allpass SIGN ERROR**, not the feedback ceiling or input gain. Both the shared `AllpassDiffuser::process` and the two inlined modulated allpasses computed `v = x − g·delayed`, giving `H(z) = (z⁻ᴰ − g)/(1 **+** g·z⁻ᴰ)` — **not** an allpass. Its magnitude peaks at **(1+g)/(1−g) ≈ 3.4–4.7×** at the frequencies where `cos(ωD) = −1`. §2b's load-bearing assumption "Schroeder allpasses unity" (line 47) is the false premise. Four such resonators sit inside the plate's feedback loop (2 modulated + 2 fixed allpasses per round trip), so the loop gain far exceeded 1 despite `feedbackGain² = 0.865`. Verified by an element-isolation matrix: bypassing the allpasses dropped the per-round-trip gain the most; the captured runtime coefficients (feedbackGain 0.93, dampG 0.20, sizeScale 1.25) exactly matched the formulas — so the coefficient math was right and the topology assumption was wrong.

- **The decay gate is explained:** the resonators supply a fixed frequency-dependent magnification R > 1; the loop is `feedbackGain² · R` at the worst frequency. At decay 2 s `feedbackGain = 0.79` → `0.63·R < 1` (stable); by decay 15 s `feedbackGain` clamps to 0.93 → `0.865·R > 1` (runaway). Same reason `testPlateAggressiveImpulseDecays` "locked the fix" but never passed — it was committed red in `8d7f0a0`, the same commit that added it. The "May fix" (`da0ffd6→8d7f0a0`: input gain 0.6→0.2, ceiling 0.97→0.93, removed arm-B double-injection) was a set of symptom-patches that never addressed the sign error.

- **The Phase 0 stabilization fix (committed):** correct the allpass sign (`v = x + g·delayed`) via a new `AllpassDiffuser::processAllpass()` used by the plate's input diffusers + fixed allpasses, and `+` in the two inlined modulated allpasses. `AllpassDiffuser::process()` is left byte-identical because Hall uses it feed-forward (outside any loop) and Hall's tuning depends on its coloration — Hall/Room/Generic are unchanged. `kPlateInputGain` restored 0.20→0.60 (it scales injection, not loop gain — a level control the symptom-patch had wrongly lowered).

- **Measured post-fix baseline (replaces §2b/§2c's fictional 1.48×/7.4×/2.2×):** per-round-trip loop gain **0.81** (stable) at 44.1 k and 48 k; sustained-sine worst-case steady-state wet gain **3.72× (+11.4 dB) at 392 Hz**, single off-mode tone **0.28×** → residual **modal magnification ≈ 13×** (the comb the Phase 1 rewrite must tame); live-sweep worst peak **1.88×**; impulse-tail autocorrelation at the loop period **0.098** (weak; tail now decays +2.07 dB/period).

- **Known-remaining, OUT OF SCOPE for this stabilization:** (a) the plate is now ~16% of Generic's level (uncalibrated) — equal-loudness matching is **Phase 2**; (b) plate L/R correlation 0.968 (still non-mono) and the ~13× modal magnification — **Phase 1 topology rewrite**; (c) `AllpassDiffuser::process()` retains the sign bug for Hall's feed-forward diffusion (harmless to stability but not a true allpass) — fold the correct allpass into Hall when Hall is re-tuned; (d) `test_reverb`'s `testHallStereoDecorrelation` (Hall |L/R corr| 0.94 > 0.9) was **already failing at HEAD**, unrelated to the plate, left untouched.
