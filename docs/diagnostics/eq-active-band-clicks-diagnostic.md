# Active EQ Band Clicks at Clip Boundaries — Xleth Diagnostic Report

**Status:** Diagnostic only. No code changes made.
**Date:** 2026-05-05
**Subsystem:** audio engine / stock Parametric EQ / track FX chain
**Branch inspected:** `codex-save-progress-20260424`

---

## TL;DR — Direct Answer to the Success-Condition Question

> "Are active EQ bands clicking because Xleth is resetting/recreating/skipping
> stateful EQ processing at clip boundaries or silence gaps, or because the EQ
> filter implementation itself has unsafe coefficient/state/buffer behavior?"

**The EQ filter implementation itself is sound.** Coefficients, biquad
topology, smoothing, denormal handling and channel layout are all reasonable.
The biquad state is **never explicitly reset on a clip boundary** by any
per-clip code path.

**The clicks are caused by the track-level FX chain being _skipped entirely_
during silence gaps between clips** — `MixEngine::processBlock()` early-`continue`s
for any track whose `hasClips`/`hasReleasingVoices` are both false and whose
chain tail has elapsed (`engine/src/audio/MixEngine.cpp:2487-2498`).

That skip is fine for stateless effects, but for an IIR biquad cascade it
**freezes** the per-band Direct-Form-II-Transposed state vector
`(z1, z2)` at whatever it was at the last sample of the previous clip.
The frozen state encodes the filter's natural ring-out (impulse-response
tail) of clip A. When clip B begins, the very first output sample is

```
y[0] = b0 * x[0] + z1_frozen
```

so the ring-out tail of clip A is **spliced onto the start of clip B as a
single-sample step**, with no chance to decay through the intervening silence.
That step is the click. Larger band gain ⇒ larger `z1, z2` magnitude ⇒
louder/more frequent clicks, exactly matching the reported symptom.

Flat-null EQ does not click for a different reason explained in §6: with
`gainDb = 0`, Bell coefficients reduce to a literal mathematical pass-through
(`b == a`), the state stays at zero, so freezing zero-state is a no-op.

---

## 1. Files Inspected

| File | Role |
|------|------|
| `engine/src/audio/XlethEffectBase.h` | Base class for all stock effects; bypass crossfade, smoother harness, `processBlock` wrapper. |
| `engine/src/audio/XlethEQEffect.h` | `XlethParametricEQ` — biquad cascade, Bristow-Johnson coeffs, dynamic/spectral modes, lin-phase FIR, oversampling. |
| `engine/src/audio/EffectChainManager.h/.cpp` | Per-track chain wrapper around `AudioGraph`; exposes `processBlock`, `resetProcessors`, `getMaxTailLengthSeconds`. |
| `engine/src/audio/AudioGraph.cpp` | `AudioProcessorGraph` host; `resetProcessors()` walks every node and calls `proc->reset()`. |
| `engine/src/audio/MixEngine.cpp` | Mix loop; renders clips → track buffer → FX chain → fader → master. Contains the silence-skip and reset-trigger logic. |
| `engine/src/audio/Sampler.cpp` | Per-pattern sampler; clip rendering does not run through any EQ. |
| `engine/src/audio/TrackMixer.h` | Stateless static helpers (volume / pan / spread / peak). Not relevant to clicks. |
| `engine/src/render/OfflineRenderer.cpp` | Offline export — calls `mixer_.processBlock()`, **identical** path to preview. |

---

## 2. Functions / Classes Involved

- **EQ filter core:**
  - `XlethParametricEQ::processEffect()` — `XlethEQEffect.h:480`
  - `XlethParametricEQ::computeCoefficients()` — `XlethEQEffect.h:1028`
  - `XlethParametricEQ::BandState` (struct + `clearState()`) — `XlethEQEffect.h:863`, `923`
  - `XlethParametricEQ::resetEffect()` — `XlethEQEffect.h:855`
  - `XlethParametricEQ::prepareEffect()` — `XlethEQEffect.h:341`
- **Effect chain hosting:**
  - `XlethEffectBase::processBlock()` — `XlethEffectBase.h:183`
  - `XlethEffectBase::reset()` — `XlethEffectBase.h:318` (calls `resetEffect()`)
  - `EffectChainManager::processBlock()` — `EffectChainManager.cpp:194`
  - `EffectChainManager::resetProcessors()` — `EffectChainManager.cpp:200`
  - `AudioGraph::resetProcessors()` — `AudioGraph.cpp:1308`
- **Mix loop / silence-gap gating:**
  - `MixEngine::processBlock()` — `MixEngine.cpp:1971`
  - Track-FX gate — `MixEngine.cpp:2469-2530`
  - `pendingEffectChainReset_` triggers — `MixEngine.cpp:2001` (transport stop), `MixEngine.cpp:2065` (transport seek)

---

## 3. Are EQ Processors Continuous Per Track or Recreated per Clip?

**Continuous per track.** EQ instances live in `EffectChainManager::graph_`,
which is owned by `MixEngine::effectChains_[trackId]`. They are constructed
once when the track gets its first effect (or via project load) and persist
until the track is destroyed.

- No clip-level code creates, destroys, prepares, releases, or `reset()`s
  any node in the FX graph.
- `Sampler` does not own or invoke an FX chain — it renders raw clip audio
  into the per-track buffer (`MixEngine.cpp:2317`); FX run later on the
  whole-track buffer (`MixEngine.cpp:2513`).

The only places that explicitly reset filter state:

| Trigger | Site | Effect |
|---|---|---|
| Transport stop (`wasPlaying_ && !isPlaying`) | `MixEngine.cpp:2001` | sets `pendingEffectChainReset_ = true`; on the next `processBlock` the flag drains all chains via `chain->resetProcessors()` (`MixEngine.cpp:2451-2463`). |
| Seek (`bufStart != lastBufferEnd_`) | `MixEngine.cpp:2065` | same flag. |
| `addBand()` / `removeBand()` | `XlethEQEffect.h:129, 146, 148` | clears state of the touched band only. |
| `setStateInformation()` | `XlethEQEffect.h:99` | clears all bands of that instance. |
| `prepareEffect()` / `releaseEffect()` | `XlethEQEffect.h:382, 851` | clears all bands. |

**None of these fire for a clip boundary, silence gap, or chopped-clip
playback.** Continuity is preserved across clips except as described in §4.

---

## 4. Is Silence Processed Through the EQ During Clip Gaps?

**No. Silence gaps bypass the FX chain entirely.** This is the proximate
cause of the click.

`MixEngine::processBlock()` decides per-track-per-block whether to invoke the
FX chain:

```cpp
// engine/src/audio/MixEngine.cpp:2487-2498
const bool hasAudio  = trackSlots[i].hasClips || trackSlots[i].hasReleasingVoices;
const bool isTailing = !hasAudio
                     && tailEndSamples_[i] > 0
                     && bufStart < tailEndSamples_[i];

if (!hasAudio && !isTailing)
{
    trackPeaks_[i].peakL.store(0.0f, std::memory_order_relaxed);
    trackPeaks_[i].peakR.store(0.0f, std::memory_order_relaxed);
    tailEndSamples_[i] = 0;
    continue;          // ← FX chain NEVER runs for this block
}
```

The tail window is keyed off `getMaxTailLengthSeconds()`. `XlethEffectBase`
returns `0.0` (`XlethEffectBase.h:291`) and the EQ does not override it, so
**`tailEndSamples_[i]` is always 0 once content stops** — the very first
silence block after a clip drops `isTailing == false` and the chain is
skipped immediately.

Consequences for an IIR cascade:

- The biquad's per-channel state `z1[ch], z2[ch]` (`XlethEQEffect.h:882`)
  is **frozen** at the value it held on the last sample of the previous
  active block. It does not advance, does not decay, does not zero out.
- The per-band smoothers (`freqSmooth, gainSmooth, qSmooth` —
  `XlethEQEffect.h:873-875`) are likewise frozen, but this is
  innocuous because their targets haven't changed across the gap.
- `XlethEffectBase::updateSmootherTargets()` and the bypass crossfade ramp
  also do not advance during the gap.

When the next clip's first block arrives, biquad processing resumes with
the stale state vector. The DFII-Transposed update at `XlethEQEffect.h:818-820`:

```cpp
float y  = bs.b0 * x + bs.z1[ch];
bs.z1[ch] = bs.b1 * x - bs.a1 * y + bs.z2[ch];
bs.z2[ch] = bs.b2 * x - bs.a2 * y;
```

evaluates `y[0] = b0*x[0] + z1_old`. The `z1_old` term is the convolution
of the previous clip's last few input/output samples and acts as a
single-sample step injection. For a peaking band of meaningful gain,
`z1, z2` can be tens to hundreds of times larger than the new clip's
fade-in samples, producing an audible click that the per-clip Hann
declick fade cannot mask (it only attenuates `x`, not the state).

---

## 5. Are Coefficients Updated Safely?

Yes. Coefficient handling is not the cause.

- **Once-per-block update** (`XlethEQEffect.h:608-636`). The smoother targets
  are updated, advanced via `skip(numSamples)`, then `computeCoefficients()`
  is called once per band per block.
- **Coefficient assignment does not touch state.** `computeCoefficients()`
  only writes `bs.b0, b1, b2, a1, a2` — it does NOT touch `bs.z1, z2`
  (`XlethEQEffect.h:1124-1130`). So gradual coefficient changes do not
  zero state mid-processing.
- **No filter object reallocation in the audio path.** The biquad is just
  five floats per band — no `std::unique_ptr`, no `dsp::IIR::Filter` reset,
  no `ProcessorDuplicator` recreate.
- **Smoothers** use multiplicative on freq/Q (30 ms) and linear on gain (20 ms),
  initialised in `prepareEffect()` and reset only there
  (`XlethEQEffect.h:375-380`).
- **Inactive bands are correctly skipped:** `if (!bs.enabled || bs.mode == 2) continue;`
  at `XlethEQEffect.h:788, 816`. A disabled band contributes nothing.
- **Denormals:** `XlethEffectBase::processBlock()` opens a
  `juce::ScopedNoDenormals` (`XlethEffectBase.h:185`) for the whole block,
  and JUCE biquads + Bristow-Johnson coeffs are well-conditioned at audio
  sample rates.
- **Channel handling:** `numCh = std::min(buffer.getNumChannels(), 2)` —
  no out-of-range writes; mono input correctly skips channel 1.

The only subtle wrinkle is in §6.

---

## 6. Why Does Flat / Null EQ Sound Clean While Active Bands Click?

The two paths through `processEffect()` differ only in the values of
`b0, b1, b2, a1, a2` at coefficient-compute time. With `gainDb = 0`:

For Bell (`XlethEQEffect.h:1043-1050`):
```
A = 10^(0/40) = 1
b0 = 1 + alpha * 1 = 1 + alpha
b1 = -2*cosw
b2 = 1 - alpha
a0 = 1 + alpha / 1 = 1 + alpha
a1 = -2*cosw
a2 = 1 - alpha
```
After the `1/a0` normalisation step (`XlethEQEffect.h:1124-1130`), the
numerator coefficients are bit-exactly equal to the denominator coefficients,
so `H(z) ≡ 1` — a literal pass-through filter at every frequency.

When the filter starts from state `z1 = z2 = 0` and processes
`x[0] = 0` (clip-fade-in start) the recurrence yields
`y[0] = 0, z1' = 0, z2' = 0`. State stays at zero forever as long as the
input remains scalar pass-through (which it does). Freezing zero-state
across a silence gap is a no-op, so no click is produced.

The same near-pass-through behaviour applies to LowPass / HighPass / Notch
when they're at unity gain in their flat region; a true LP/HP at +30 dB
shelf etc. would still inject state.

For active bands (`gainDb != 0`):
- `b ≠ a`, so the filter has a real frequency response with non-zero impulse
  response.
- During processing, `z1, z2` accumulate energy proportional to the
  resonance and gain of each band.
- Even if the source clip ends with a perfect Hann declick fade
  (`x[last] → 0`), the recurrence
  `z1' = b1*0 - a1*y[last] + z2 = -a1*z1_prev + z2_prev`
  leaves `z1, z2` non-zero. They would naturally decay if processing
  continued through silence — but processing is **skipped** instead (§4),
  so they remain.
- More active bands ⇒ deeper biquad cascade ⇒ each band's frozen
  state contributes → clicks scale with active-band count, matching the
  reported symptom "More active EQ processing appears to make clicking
  more prevalent."
- Boosting the EQ to "EQ out the click" only adds **more** state to freeze,
  which is why that workaround makes things worse, not better.

---

## 7. Buffer / Routing Sanity Check

Inspected for completeness; none of these explain the click.

- **Track buffers** are zeroed at the top of every block
  (`MixEngine.cpp:2114-2116`: `trackBuffers_[i].clear(0, numSamples)`).
- **Per-block MidiBuffers** are cleared at `MixEngine.cpp:2347-2348`.
- **Channel count match.** EQ uses `min(numChannels, 2)`; Sampler renders
  to the same `trackBuffers_[i]` which is sized to 2 ch in `ensureTrackBuffers`.
- **Bypassed bands** correctly `continue` out of the inner sample loop —
  no stale wet leak.
- **Fully bypassed effect** path is handled: `XlethEffectBase` always calls
  `processEffect` even when bypassMix is at the dry endpoint
  (`XlethEffectBase.h:201-227`), and uses a 5 ms wet/dry crossfade ramp;
  no internal state desync caused by bypass toggling.
- **Lin-phase FIR + oversampling** paths exist
  (`XlethEQEffect.h:711-769, 771-799`) but the click occurs even with the
  vanilla biquad cascade (`else` branch at `XlethEQEffect.h:802-826`),
  so they are not on the critical path. They WILL exhibit the same
  silence-gap freeze with their own state (FIR delay line + oversampler
  internal state).
- **STFT / spectral-mode** state lives in `stftInRing_/stftOutRing_` ring
  buffers; same freeze-during-silence problem if bands are in mode 2,
  but the user reports clicks even with non-spectral bands.
- **Offline render vs preview** — both go through `MixEngine::processBlock`
  (`OfflineRenderer.cpp:557`); behaviour and bug surface identically. The
  user's "No FX render sounds clean" observation is consistent: render
  doesn't differ from preview, only the presence of active EQ does.

---

## 8. Ranked Likely Root Causes

1. **(Primary, ~95% confidence) Silence-gap FX-chain skip leaves IIR state
   stranded across clip boundaries.**
   - Site: `MixEngine.cpp:2487-2498` early-`continue` when `!hasAudio && !isTailing`.
   - Mechanism: §4 above. `z1, z2` of every active biquad band are frozen
     at the previous clip's last value and re-injected as a single-sample
     step at the next clip's first sample.
   - Diagnostic match: only active bands click; flat bands don't (§6);
     more bands ⇒ more clicks (deeper cascade); EQ-ing the click frequency
     adds state, making it worse; per-clip declick fades cannot mask it
     (they fade `x`, not state).

2. **(Secondary, ~25%, may compound) `getMaxTailLengthSeconds() == 0` for
   the EQ.** The silence-skip uses tail length to keep processing alive
   so reverb/delay tails can drain. EQ reports 0, so it is dropped on
   the very first silent block. Even if the click root cause is fixed by
   resetting state at gap onset, returning a small non-zero tail
   (e.g. 50–200 ms) would let biquad ringing decay naturally into silence
   the way a DAW track effect does — the user's stated desired behaviour.

3. **(Tertiary, ~5%) Lin-phase / oversampler internal state across gaps.**
   `os2x_, os4x_` (JUCE `Oversampling`) and the `firDelay_[2]` ring carry
   their own state. They will also "freeze" during the skip. Less likely
   to be heard as a click than biquad ringing because their impulse
   responses are usually shorter / lower-Q, but worth fixing in the same
   pass.

4. **(Negligible, but listed) Per-band sidechain BPF state and dynamic
   activation atomic.** `sc_z1, sc_z2, dynActivation` are also frozen.
   In Normal mode (the user's case) `dynActivation` is forced to 0 so
   this is moot; in Dynamic mode it would cause an extra "wake-up"
   activation transient at clip-B start.

5. **(Effectively ruled out) Coefficient instability / per-block recompute
   clears state.** Verified §5: `computeCoefficients` writes only the b/a
   five floats; `z1, z2` are untouched.

6. **(Ruled out) Distortion / Waveshaper involvement.** Code shows the
   biquad cascade is the only stateful processing on the user's reported
   path; Waveshaper / Distortion are different processors not invoked
   unless explicitly inserted.

---

## 9. Concrete Patch Plan (Not Yet Implemented)

**Goal:** restore DAW-style continuous EQ behaviour across clip boundaries
without violating the "per-clip auto-declick fades remain source-boundary
protection only" constraint, without lengthening clip auto-fades, and
without adding post-FX declicking as a band-aid.

The patch space splits into three options. Recommend implementing **A**
(small, surgical, low-risk) and possibly later **B** (cleaner, larger
scope) — they can land separately.

### Option A — Reset filter state at the silence-gap → audio transition (minimal)

When a track transitions from the silence-skipped state back to active
processing, reset its FX chain BEFORE the first sample of the new clip
enters the EQ. This zeroes the leftover state instead of letting it
splice in.

- Add a per-track `bool fxNeedsResetOnNextActive_[kMaxTracks]`
  (initialised true) in `MixEngine`.
- In the silence-skip block (`MixEngine.cpp:2492-2498`), set the flag.
- Right before `chainIt->second->processBlock(...)` at
  `MixEngine.cpp:2513`, if the flag is set, call
  `chainIt->second->resetProcessors()` and clear it.
- Clear the flag whenever the chain is processed at full rate.

**Trade-off:** the very first sample of clip B sees a clean, zero-state
filter. The filter's natural impulse response then ramps in from there
and cooperates with the per-clip Hann fade-in. No phantom tail. **Cost:**
loses the (also-broken) "filter ring continues across short gaps" DAW
behaviour, but the user's existing setup also lacks that — so this is a
net improvement and will not regress chopped playback.

### Option B — Continuous FX processing with EQ tail reporting (preferred long-term)

Make the EQ report a non-zero tail (e.g. 200 ms — a few thousand samples,
covering any reasonable biquad decay) and **always** run the FX chain
when the track ever held content this session. This matches DAW
behaviour: the filter rings out into the silence gap and naturally
settles to ~zero before the next clip arrives.

- `XlethParametricEQ::getTailLengthSeconds()` override returning, say,
  `0.2` (or computed from minimum band Q over band freq).
- In `MixEngine::processBlock`, drop the `!hasAudio && !isTailing` skip
  and instead always call `chainIt->second->processBlock(...)` once the
  track exists, summing only when output is non-trivial. Or keep the
  tail check but increase the tail length so silence gaps comfortably
  fit inside it.
- Audit other stock effects (Compressor, Limiter, Distortion, etc.)
  for `getTailLengthSeconds()` honesty on the same pass.

**Trade-off:** small CPU increase (one biquad cascade per track per block
during gaps); proper DAW-like ring-out. May expose latent state-freeze
bugs in other effects.

### Option C — Last-resort, do-not-pick: post-FX clip-boundary fade

Apply the per-clip Hann declick fade AFTER the FX chain instead of (or
in addition to) before. This masks any FX boundary transient.

The user explicitly excluded this approach ("Do not add post-FX
declicking as the fix"). Listed only for completeness.

### What NOT to change

- Do **not** lengthen `clipBoundaryFadeSamples_` or per-clip fades.
- Do **not** call `chain->resetProcessors()` between every block — that
  would prevent legitimate filter ringing inside a clip.
- Do **not** call `clearState()` from inside `processEffect()`.
- Do **not** alter `pendingEffectChainReset_` semantics — it is correctly
  bound to transport stop and seek.

---

## 10. Proposed Tests / Debug Renders

### Reproduction / regression tests

1. **Unit-level golden-file biquad test.** Construct a `XlethParametricEQ`
   with one Bell band at 1 kHz / +12 dB / Q=8. Feed it sequence:
   `[1024 samples of impulse-padded noise]` → `[2048 samples of zeros]` →
   `[1024 samples of zeros]` (the second block emulating the silence skip
   by NOT calling processBlock on it). Compare the output of block 3
   against the same input run through a continuously-processed reference.
   Difference at sample 0 of block 3 = the click magnitude; should be
   numerically near zero for both Option A and Option B fixes.

2. **`engine/test/test_real_render.cpp`-style timeline test.** Place two
   short clips on a single track separated by a 100 ms silence gap, with
   one EQ band at +12 dB / Q=10 / 5 kHz. Render through `MixEngine` (or
   `OfflineRenderer`) and assert max sample magnitude in the first 10 ms
   of clip B is below a threshold (e.g. < 1.2× the clip's RMS without EQ).

3. **A/B against flat-EQ baseline.** Same timeline, run twice (active EQ
   vs. all bands at 0 dB). Output peaks should match within tolerance —
   they currently don't.

4. **Chopped-rhythmic test.** 16th-note chops, 50 ms each, EQ as above.
   Currently produces audible clicking on every onset; assert null peak
   delta vs. flat-EQ baseline.

### Debug instrumentation (temporary, clearly marked)

- In `XlethParametricEQ::processEffect()`, log first N samples of `z1[0]`
  on entry to each block when `XLETH_DEBUG` is defined.
- In `MixEngine::processBlock()`, log every track's silence-skip
  transitions (`active → silent` and `silent → active`) with sample
  index and block number.
- After verifying the diagnostic, REMOVE this instrumentation before
  finalising any patch.

### Listening test

- Record output of preview playback over a 4-bar chopped pattern with
  one EQ band ramped from 0 dB → +12 dB at 5 kHz / Q=10. The click
  prevalence should scale monotonically with gain. After Option A or B,
  no clicks at any gain.

---

## Appendix — Key Code Locations (Quick Reference)

| Symptom site | File | Lines |
|---|---|---|
| Silence-skip early-continue (root cause) | `engine/src/audio/MixEngine.cpp` | 2487-2498 |
| Tail-aware FX dispatch | `engine/src/audio/MixEngine.cpp` | 2508-2530 |
| `pendingEffectChainReset_` (transport-only) | `engine/src/audio/MixEngine.cpp` | 2001, 2065, 2451-2464 |
| EQ biquad inner loop (DFII-T) | `engine/src/audio/XlethEQEffect.h` | 802-826 |
| EQ band state & `clearState()` | `engine/src/audio/XlethEQEffect.h` | 863-932 |
| EQ `resetEffect()` / `prepareEffect()` | `engine/src/audio/XlethEQEffect.h` | 855-859, 341-478 |
| Coefficient compute (Bristow-Johnson) | `engine/src/audio/XlethEQEffect.h` | 1028-1131 |
| Base bypass crossfade & smoother harness | `engine/src/audio/XlethEffectBase.h` | 169-322 |
| `EffectChainManager::resetProcessors` | `engine/src/audio/EffectChainManager.cpp` | 200-204 |
| Graph-level `resetProcessors` | `engine/src/audio/AudioGraph.cpp` | 1308-1337 |
| Offline render uses same path | `engine/src/render/OfflineRenderer.cpp` | 557 |

---

*End of diagnostic. No source files modified.*
