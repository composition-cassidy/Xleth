# Prompt 4 — GLOSS One-Knob Skin
**Model: Sonnet · Effort: High** (small, well-scoped — reuses everything from APEX)

```
Build GLOSS, the one-knob companion skin over the APEX engine, as a selectable stock effect in XLETH.

Context:
- Project: XLETH — open-source Sparta Remix DAW. C++ engine (JUCE 8 + FFmpeg 7) → Node-API bridge → Electron 41 + React 18 + Zustand UI. Windows only. Project root: C:\Users\Krasen\Desktop\XLETH.
- APEX (multiband maximizer stock effect) is complete: DSP core, bridge, editor UI, preset/state serialization (previous tasks). Design spec: "XLETH — APEX & GLOSS Design Spec.docx" (attached) — Section 7.2 is the contract.
- GLOSS is modeled on Image-Line's Soundgoodizer concept: the same engine with a radically simplified interface. It is NOT a separate DSP effect — it is a second UI descriptor over the APEX engine class, so every APEX fix propagates automatically.

UI:
- One giant AMOUNT knob (0–100 %) bound to the engine's BAND MIX parameter.
- Four lettered buttons: A / B / C / D. Each loads a complete APEX parameter snapshot (factory presets). Selecting a letter applies the snapshot; AMOUNT stays independent of preset selection.
- Header text: "powered by APEX".

Presets:
- Author four factory snapshots in-house as distinct, musical starting points for 140 BPM Sparta Remix material (suggested: gentle glue / punchy / bright lift / wall). Each snapshot is a full APEX parameter state (curve nodes, tensions, all knobs).
- Do NOT attempt to extract or replicate FL Studio's Soundgoodizer A–D preset values — those are Image-Line's. The letters are generic; the values must be ours.

Constraints:
- Same engine class and state serialization as APEX — a GLOSS instance's state is an APEX state + selected letter. Opening the same instance in the APEX editor (if supported by the effect window system) must show coherent state.
- CSS custom-property tokens, no hardcoded hex; tokenValue() never at module scope; "color is earned, not default" (accent on the active letter and AMOUNT activity); flat, zero-border-radius; Lucide icons only.
- Knob drag discipline: local preview during drag, single commit on mouseup through UndoManager, never IPC during drag.
- Never declare reserved identifiers (top, self, parent, name, length, status, location, history, event, screen, navigator, opener, origin, closed) in script scope.

Before modifying anything:
- Read how effect UI descriptors are registered and how the APEX editor + preset path work. List every file you inspected in your final report.

Deliverable:
- GLOSS selectable as a stock effect; AMOUNT verified end-to-end against engine BAND MIX; A/B/C/D apply their snapshots verified end-to-end; state survives project save/load including the selected letter.
- build.bat bridge-clean if any C++ was touched (prefer zero C++ changes — this should be UI + preset data only); git commit with a clear message.
```
