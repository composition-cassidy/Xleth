# Prompt 2 — APEX Bridge, Metering & Latency Surfacing
**Model: Opus · Effort: High** (multi-file wiring with silent-failure invariants — needs judgment)

```
Wire the APEX stock effect end-to-end through XLETH's Node-API bridge: parameters, curve node data, state serialization, metering channel, and latency surfacing.

Context:
- Project: XLETH — open-source Sparta Remix DAW. C++ engine (JUCE 8 + FFmpeg 7) → Node-API bridge → Electron 41 + React 18 UI. Windows only. Project root: C:\Users\Krasen\Desktop\XLETH. Build via build.bat (cmake-js + MSVC).
- APEX's DSP core already exists as a native stock effect node (previous task): multiband maximizer with LOW/MID/HIGH + MASTER bands, per-band curve editor state (nodes + segment tensions), per-band saturation/separation/gains, 4-state band switch, SOLO, crossover splits + slopes, LOOKAHEAD, BAND MIX, LOW CUT. It reports latency (LOOKAHEAD amount) engine-side.
- Design spec: "XLETH — APEX & GLOSS Design Spec.docx" (attached). Read Sections 4 and 6 first.
- The UI does not exist yet — this task is the data path only. A minimal renderer-side console harness is acceptable for verification.

Before modifying anything:
- Read and diagnose how existing stock effects expose parameters and state through the four-layer bridge (engine → Node-API → preload → renderer), how effect state is serialized into projects/presets, and whether any engine→UI metering/telemetry path already exists. List every file you inspected in your final report.
- Verify whether child_process.fork in the engine host is configured with serialization: 'advanced'. Default JSON serialization mangles ArrayBuffers — if the metering payload must cross this boundary, confirm the setting or fix it.

Constraints:
- The four-layer bridge silently swallows undefined calls via optional chaining. Every new bridge call must be verified end-to-end with console smoke tests on BOTH sides; during your testing an undefined call must fail loudly, not silently.
- Metering: per-band gain reduction (dB), per-band output level, and input spectrum (FFT 2048) pushed to the renderer at ~30 Hz as ONE batched typed-array payload per tick. Never per-scalar RPC per frame. Reuse the existing metering/telemetry path if one exists; otherwise add the minimum consistent mechanism.
- Curve data (node list + per-segment tensions per band) must round-trip through the bridge as structured state — it is effect state, serialized into presets and projects, undoable through UndoManager.
- LOOKAHEAD latency must be readable from the renderer (for UI display). If the earlier audit found engine PDC exists, ensure APEX is compensated; if not, document the exact monitoring-delay behavior in code comments and in your report.
- Audio-thread discipline is unchanged: no allocations, locks, or logging added to the callback path; metering taps are pre-allocated and decimated.
- build.bat bridge-clean after ALL C++ changes before drawing any conclusion — stale binaries cause false "still broken" reports.

Deliverable:
- Every APEX parameter + full curve state settable/gettable from the renderer through the bridge, verified end-to-end (console smoke test: set each parameter from the renderer, read it back from the engine, print PASS/FAIL per parameter group).
- Metering payload arriving in the renderer at ~30 Hz, verified with a console log of one sample payload (then remove the logs).
- Effect state survives a project save/load round-trip including curve nodes and tensions.
- build.bat bridge-clean clean build; git commit with a clear message. Do not build UI — that is the next task.
```
