# Prompt 3 — APEX Editor UI
**Model: Sonnet · Effort: High** (large but well-scoped single-concern UI build)

```
Build the APEX effect editor window in XLETH's Electron + React UI.

Context:
- Project: XLETH — open-source Sparta Remix DAW. C++ engine (JUCE 8 + FFmpeg 7) → Node-API bridge → Electron 41 + React 18 + Zustand UI. Windows only. Project root: C:\Users\Krasen\Desktop\XLETH.
- APEX is a native stock effect (multiband maximizer, Maximus-style) whose DSP core and bridge wiring are complete (previous tasks). All parameters, full curve state (nodes + per-segment tensions), and a ~30 Hz batched metering payload (per-band gain reduction, per-band level, FFT-2048 input spectrum) are available in the renderer through the bridge.
- Design spec: "XLETH — APEX & GLOSS Design Spec.docx" (attached). Sections 4 and 7 are the UI contract. The Maximus screenshots (attached) are the layout reference — do not copy artwork.

UI structure:
- Top-left: canvas curve editor for the selected band — draggable nodes, per-segment tension (drag or wheel on a segment handle), double-click adds a node, right-click deletes. Both axes -24…+12 dB. Up to 32 nodes.
- Top-right: canvas analysis display — input spectrum with LOW/MID/HIGH regions tinted per band split, plus per-band gain-reduction indication driven by the metering payload.
- Band selector: LOW / MID / HIGH / MASTER tabs, each with the 4-state switch (ON / COMP OFF / MUTED / OFF) and SOLO (L/M/H only, mutually exclusive).
- Knob rows: PRE GAIN, POST GAIN, ATT, REL, SUSTAIN + PEAK/RMS toggle, SAT THRESH (-100…+100 %, bipolar), SAT CEIL, STEREO SEP.
- Right panel: LOOKAHEAD (0–20 ms), BAND MIX (0–100 %), LOW/HIGH split frequencies with 12/24 dB slope switches, LOW CUT (0–100 Hz).

Constraints:
- Curve editor and analysis display are canvas-drawn. NEVER place DOM overlays over canvas — it causes scroll/zoom drift and hit-test corruption. All hit-testing in canvas coordinates.
- Drag discipline: local preview during drag, single commit on mouseup through UndoManager. Never IPC during drag — this applies to knobs AND curve nodes.
- CSS custom-property tokens throughout; no hardcoded hex values in components. tokenValue() must never be called at module scope — it returns an empty string before ThemeProvider mounts.
- "Color is earned, not default": accent color only on meaningful state — active band, gain-reduction activity, solo/mute states. Flat, zero-border-radius, surface hierarchy per the established theming spec.
- Lucide icons only (no webfont icon packs — offline app).
- Never declare reserved identifiers (top, self, parent, name, length, status, location, history, event, screen, navigator, opener, origin, closed) as variables in script scope — it silently kills the entire script.
- State in Zustand, following the existing stock-effect UI patterns in the codebase.

Before modifying anything:
- Read and diagnose how existing stock effect windows are structured (registration, parameter binding, knob components, theming usage). List every file you inspected in your final report. Reuse existing knob/toggle components wherever they exist rather than building parallel ones.

Deliverable:
- Fully functional APEX editor: every control verified against engine state (change in UI → engine reflects it; automation/preset load → UI reflects it).
- Curve editing round-trips through UndoManager (edit → undo → redo restores exact node state).
- Analysis display rendering live metering at ~30 Hz without frame drops.
- Console smoke test printed for the verification pass (then logs removed); git commit with a clear message.
```
