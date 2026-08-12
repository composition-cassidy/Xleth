```
Implement the Phanjer stock effect DSP core in the XLETH engine, replacing the existing pass-through stub.

Context:
- Project: XLETH — Sparta Remix DAW. C++ engine (JUCE 8) at C:\Users\Krasen\Desktop\XLETH\engine, Node-API bridge, Electron+React UI. Windows-only.
- The full DSP spec is C:\Users\Krasen\Desktop\XLETH\phanjer\PHANJER_HANDOFF.md — READ IT FIRST, all of it, before touching code. It defines the signal flow, all 24 parameter ids/ranges/defaults, the LFO engine, the three collision-handling modes (LINKED / SMART / WILD), the analytic collision-leveling engine, and the verification plan.
- Target file: engine/src/audio/PhanjerEffect.h (currently a 21-line stub, pluginId "phanjer", already registered in AudioGraph.cpp's factory — that registration already exists; do not duplicate it).
- Reference implementations to mirror for style, smoothing, and correctness patterns: engine/src/audio/XlethFlangerEffect.h (delay-line comb, Lagrange3rd, tanh feedback) and engine/src/audio/XlethPhaserEffect.h (biquad allpass cascade, Direct Form II Transposed). Base class: engine/src/audio/XlethEffectBase.h (APVTS, registerSmoothedParam, resolveSmoothed handles, writeMeterValue).

Scope (one logical unit):
1. Implement PhanjerEffect.h fully per the handoff: parallel flanger + phaser cores, shared LFO shape engine (sine/tri/saw/square/random + CHAOS), per-side tempo sync via XlethEffectBase::getGlobalBPM(), LINKED/SMART/WILD modes per the §5 config table, and the analytic collision-leveling engine (feature sets, 1/3-octave guard band, 30 ms lookahead, 5/60 ms attack/release gain, negative-feedback peak/notch role swap).
2. Factor resolveRateHz() and the collision-metric computation as pure static functions so tests can call them directly.
3. New test file engine/test/test_phanjer.cpp mirroring test_distortion.cpp's harness and its CMake registration in engine/CMakeLists.txt, covering handoff §7 items 1–6 (param contract, state round-trip, silence, fuzz/bounds, the SMART-vs-WILD leveling money test, resolveRateHz table).

Constraints:
- Audio thread: no allocation, no locks, no logging. All buffers/state sized in prepareEffect or fixed-size at compile time. juce::ScopedNoDenormals is already applied by the base class.
- Continuous params use registerSmoothedParam per handoff §6 (rates and delay bounds get manual 50 ms one-pole); discrete params (mode, lfo_shape, p_stages, sync/div/feel) read raw atomics. Resolve SmoothedHandles once in prepareEffect, never per sample.
- Metering: slot 0 = peak L, 1 = peak R, 2 = leveling gain L.
- Do NOT touch: StockParameterCatalog.{h,cpp} (dead uncompiled files), the bridge/RPC layer (params flow through generic APVTS enumeration), AudioGraph.cpp (factory entry exists), any other effect.
- Do NOT add parameters not in the handoff's 24-id table (no width/spread/resonance).
- Debug logging only behind #ifdef XLETH_DEBUG with [Phanjer] prefix.
- build.bat after C++ changes, then build.bat bridge-clean (mandatory — stale .node binaries cause false failures), then run test_phanjer.exe and confirm ALL TESTS PASSED.

Deliverable:
- Working PhanjerEffect.h + test_phanjer.cpp, clean build, all tests passing, single git commit with a clear message. Report the exact test output and the commit hash.
```
