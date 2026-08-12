# Prompt 1 — APEX DSP Core
**Model: Opus · Effort: High** (audio engine work — never route this below Opus)

```
Implement the APEX multiband maximizer DSP core as a new native stock effect in the XLETH engine.

Context:
- Project: XLETH — open-source Sparta Remix DAW. C++ engine (JUCE 8 + FFmpeg 7) → Node-API bridge → Electron 41 + React 18 UI. Windows only. Project root: C:\Users\Krasen\Desktop\XLETH. Build via build.bat (cmake-js + MSVC).
- Phase 3 added a stock effects system + mixer/effects architecture. APEX is a new stock effect in that system — an AudioGraph effect node, NOT a VST3.
- Design spec: "XLETH — APEX & GLOSS Design Spec.docx" (attached). Read Sections 3–6 first; they are the contract for this task.
- Feature set (modeled on Image-Line Maximus, renamed): LOW/MID/HIGH bands + MASTER wideband stage; per-band node-based dynamics curve editor; per-band saturation (bipolar mode A/B + ceiling, 2× oversampled); per-band stereo separation (M/S width); per-band PRE/POST GAIN; 4-state band switch (ON / COMP OFF / MUTED / OFF); band SOLO (L/M/H); Linkwitz-Riley crossover with per-split 12/24 dB slope; global LOOKAHEAD (0–20 ms) for L/M/H; global BAND MIX (parallel dry/band blend); LOW CUT HPF 0–100 Hz.

Before modifying anything:
- Read and diagnose the existing stock effects implementation: the effect node base class, how effects register in the AudioGraph, the parameter get/set path, state serialization, and any existing latency reporting. List every file you inspected in your final report.
- Determine whether the engine has any plugin delay compensation (PDC). Report exactly what exists — this decides how LOOKAHEAD latency is reported.
- Do not modify code until you have stated the integration points you found.

Constraints:
- Audio callback path: no allocations, no locks, no logging. All parameter changes arrive via the existing parameter queue; the audio thread consumes pre-built state.
- Dynamics curve = nodes (IN dB, OUT dB, up to 32) + per-segment tension (-1…+1, 0 = linear). On any edit, rebuild a 1024-entry dB→dB gain LUT OFF the audio thread and hand it over by atomic pointer swap. The callback only does LUT lookups.
- Crossover: Linkwitz-Riley 2nd order (12 dB/oct) and 4th order (24 dB/oct — two cascaded 2nd-order Butterworth), selectable per split (LOW split 40 Hz–1 kHz default 200 Hz; HIGH split 1 kHz–18 kHz default 2 kHz). Magnitude-flat reconstruction is a hard requirement — BAND MIX parallel blending depends on it. No linear-phase FIR mode.
- Per-band chain order: PRE GAIN → LOOKAHEAD delay → envelope detect (PEAK/RMS, ATT 0.1–100 ms, REL 5–500 ms, SUSTAIN hold 0–500 ms) → curve-LUT gain → SAT → POST GAIN → STEREO SEP.
- Saturation: per band including MASTER. THRESH -100…+100 % (<0 = mode A smooth soft-clip tanh-family, 0 = dry, >0 = mode B harder clip with richer high-order harmonics). CEIL -60…0 dB sets onset level — signal exceeding the ceiling gets shaped. Oversample ONLY the waveshaper 2× (half-band polyphase up/down) to prevent aliasing.
- STEREO SEP: -100 % (mono) … +100 % (double side), M/S encode → side scale → decode.
- Band state semantics (exact): ON = full chain; COMP OFF = dynamics bypassed but saturation/gains/separation still active, band passes; MUTED = band silenced; OFF = band bypassed dry, its DSP skipped entirely.
- LOOKAHEAD: shared pre-allocated ring-buffer delay for L/M/H, 0–20 ms, smoothed on change (no zipper noise, no reallocation). The dry side of BAND MIX must be delayed by exactly the LOOKAHEAD amount so the parallel blend is time-aligned. MASTER has no lookahead.
- BAND MIX 0–100 % blends dry input ↔ summed L/M/H output, then feeds MASTER.
- LOW CUT: 0–100 Hz, 24 dB/oct HPF before the crossover.
- The effect must report its current latency (the LOOKAHEAD amount) through whatever mechanism the engine has; if none exists, add a clean one consistent with the existing architecture and flag it prominently in your report.
- All state (curve nodes, tensions, every knob) must serialize through the existing stock-FX preset/state path so UndoManager and project save/load work unchanged.
- Windows-only, MSVC, JUCE 8. Keep code clean and documented — XLETH is open source.

Deliverable:
- APEX DSP class integrated as a stock effect node, every parameter settable through the engine-side parameter API (bridge/JS wiring is a separate later task — do not touch the bridge here).
- build.bat bridge-clean completed with zero errors (mandatory after C++ changes — stale binaries cause false results).
- Engine-side console smoke test: feed generated tones (sub sine 60 Hz, kick-like burst, 5 kHz sine, noise) and print PASS/FAIL for: (a) band-split reconstruction flat within ±0.5 dB with all bands COMP OFF and BAND MIX 100 %; (b) LOOKAHEAD at 10 ms introduces exactly the reported latency (impulse test); (c) dry path of BAND MIX is sample-aligned with the band path (null test at 0 %/100 % crossfade midpoint tolerance documented); (d) saturation at ±100 % on a 5 kHz 0 dBFS sine through HIGH band shows no aliasing products above -60 dBFS; (e) MUTED band contributes digital silence, OFF band is bit-transparent dry.
- Git commit with a clear message after the build and smoke tests pass. Do not proceed to bridge or UI work.
```
