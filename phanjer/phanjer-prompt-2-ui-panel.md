```
Build the Phanjer editor panel in the XLETH React UI — a faithful three-column recreation of the original Phanjer VST layout, wired to the engine effect implemented in the previous task.

Context:
- Project: XLETH — Sparta Remix DAW. UI is Electron + React 18 + Zustand at C:\Users\Krasen\Desktop\XLETH\ui. Raw CSS in ui/src/styles/app.css, themed exclusively via CSS custom-property tokens (never hardcoded hex).
- The engine side is done: pluginId "phanjer" exposes 24 APVTS params. The authoritative param-id/range/default table and mode semantics are in C:\Users\Krasen\Desktop\XLETH\phanjer\PHANJER_HANDOFF.md §2 and §5 — READ IT FIRST. Every control id in your panel must match that table verbatim; params are read/written through the generic bridge calls window.xleth.audio.getEffectParameters(trackId, nodeId) and window.xleth.audio.setEffectParameter(trackId, nodeId, id, value) — no new bridge work.
- Pattern to mirror: ui/src/components/mixer/PhaserPanel.jsx + ui/src/stores/phaserStore.js (hydration, previewParam/commitParam with rAF-coalesced engine writes, draggable floating panel, PluginUIKitKnob with MIXER_RING_APPEARANCE, XlethSelect). Knob component: ui/src/plugin-ui/runtime/components/PluginUIKitKnob.jsx. Select: ui/src/components/common/XlethSelect.jsx.
- Reference UI shape (the original VST, being recreated): header row with LINKED / SMART / WILD segmented mode buttons and a "?" help button; three columns — FLANGER (MIX, RATE, DEPTH, FEEDBACK knobs; DELAY MIN / DELAY MAX horizontal sliders; sync row: note icon toggle + division select + feel select), center (PHANJER title, GLOBAL MIX knob, LFO SHAPE 5-icon selector [sine/triangle/saw/square/random as inline SVG icons], CHAOS knob), PHASER (MIX, FEEDBACK, RATE, DEPTH knobs; stage count with − / + stepper; FREQ MIN / FREQ MAX horizontal sliders; sync row). Style it with XLETH panel conventions (flat, zero border-radius, token colors, the hard 4px 5px 0 rgba(0,0,0,0.5) shadow), not the original's navy/rounded look — the likeness to copy is the LAYOUT and control set.
- Existing tokens you can use: --theme-mod-phanjer-flanger and --theme-mod-phanjer-phaser (per-column accents) plus the standard --theme-accent / surface / text tokens. tokenValue() must never be called at module scope.

Scope (one logical unit):
1. ui/src/stores/phanjerStore.js — clone of phaserStore.js (target/open/close only).
2. ui/src/components/mixer/PhanjerPanel.jsx — the full panel per the layout above. Behaviors: hydration on open (reset to defaults then apply engine values); drag writes coalesced to one engine write per animation frame per param; discrete writes immediate. LINKED mode disables the phaser RATE/sync row (shared LFO follows the flanger side — grey it, don't hide it). A side's RATE knob disables while its sync toggle is on. CHAOS knob greys out unless shape = Random.
3. ui/src/components/mixer/PhanjerResponseCanvas.jsx — a full-width canvas strip under the header (~90 px) drawing both analytic comb responses vs frequency (log axis) from current params: flanger peaks at k/dF, notches at (k+1/2)/dF from the swept delay; phaser notches at the stage frequencies (same formulas as the engine — handoff §3/§5). Highlight collision zones (peak-peak or notch-notch pairs within 1/3 octave). No audio data needed — pure function of params, redrawn on param change. If the collision highlighting gets unwieldy, ship the two curves without it; do not block the panel on it.
4. Registration: add phanjer to EFFECT_EDITORS and its store to EFFECT_EDITOR_STORES in ui/src/components/mixer/effectEditorOpeners.js (it is already in PLUGIN_NAMES — keep that entry), and mount <PhanjerPanel /> in ui/src/components/mixer/EffectEditorHost.jsx.
5. CSS: .phanjer-* classes in ui/src/styles/app.css, token-based, following the phaser-panel block's conventions.
6. Help overlay: "?" toggles a HOW IT WORKS overlay inside the panel covering GLOBAL MIX, LINKED, SMART, WILD, LFO SHAPE, CHAOS, NOTE SYNC — one short paragraph each, matching the engine's actual behavior per handoff §5.

Constraints:
- All state through the store + bridge calls above; never invent new bridge methods — the four-layer bridge silently swallows undefined calls via optional chaining, so verify each call exists before using it (grep the preload/bridge for getEffectParameters/setEffectParameter first).
- No Tailwind, no CSS-in-JS — plain classes in app.css. No new dependencies.
- Do not modify any other panel, store, or engine file.
- Reserved identifiers (window.top, self, parent, name, length, status, location, history, event, screen, navigator, opener, origin, closed) must never be declared as variables in script scope.

Deliverable:
- Panel opens from both the Mixer Chain and FX Graph Edit paths for pluginId "phanjer"; every control hydrates from and writes to its engine param; npm run build (or the project's UI build/test script) passes, plus the existing effectCatalog.test.js / EffectEditorHost.test.jsx still pass. Report what you verified and the git commit hash.
```
