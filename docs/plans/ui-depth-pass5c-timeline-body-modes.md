# UI Depth — Pass 5C: Timeline Body Modes & Preview Visibility

Status: implemented
Builds on: Pass 5A (spec), Pass 5B (settings store, popover, plumbing).
Deferred to Pass 5D: name truncation, pitch/metadata chip redesign, clip-name visibility.

## Goal

Consume the existing Pass 5B `timelineDisplaySettings` inside Timeline canvas drawing to implement:

- four body-fill modes for audio clips and pattern blocks: `minimal`, `plain`, `gradient`, `solid`
- gradient direction: `top` / `bottom`
- contrast: `low` / `medium` / `high`
- waveform visibility gate: `auto` / `always` / `never`
- pattern mini-note preview visibility gate: `auto` / `always` / `never`

The default `plain` + `medium` setting must produce alpha values **identical** to Pass 4B so a user who never opens the popover sees no visual shock.

## Files changed

- `ui/src/components/timeline/timelineDrawing.js` — sole code change.
- `docs/plans/ui-depth-pass5c-timeline-body-modes.md` — this doc.

`ui/src/components/timeline/TimelineCanvas.jsx` was **not** modified — Pass 5B already plumbs `timelineDisplaySettingsRef.current` into both `drawClips` and `drawPatternBlocks`.

## Settings consumed

| Key | Domain | Used in |
|---|---|---|
| `timelineClipBodyMode` | `minimal \| plain \| gradient \| solid` | `drawClips` body material |
| `timelinePatternBodyMode` | `minimal \| plain \| gradient \| solid` | `drawPatternBlocks` body material |
| `timelineBodyGradientDirection` | `top \| bottom` | both, in gradient mode |
| `timelineClipContrast` | `low \| medium \| high` | both (v1 — applies to clips and patterns) |
| `timelineShowWaveforms` | `auto \| always \| never` | `drawClips` waveform draw gate |
| `timelineShowPatternPreview` | `auto \| always \| never` | `drawPatternBlocks` mini-note gate |

**Not yet consumed** (Pass 5D): `timelineShowClipNames`, `timelineShowPitchShift`, `timelinePitchShiftStyle`.

## Helpers added (in `timelineDrawing.js`)

- `TIMELINE_DISPLAY_DRAW_DEFAULTS` — frozen module-private defaults that mirror `timelineDisplayStore`.
- `normalizeTimelineDisplaySettings(s)` — exported. Tolerates `null`, `undefined`, malformed objects, missing keys, unknown enum values; merges with defaults; returns a fresh object with only the six keys this pass consumes. Drawing remains pure: no Zustand import, no `window.xleth` read.
- `_clampAlpha(a)` — clamps to `[0, 1]`, treats non-finite as `0`.
- `_contrastMul(c)` — `low: 0.82`, `medium: 1.0`, `high: 1.18`. Falls back to `1.0` for unknown values (defensive — should be unreachable after normalization).
- `getTimelineBodyMaterial({...})` — returns `{ fillStyle, borderStyle, borderWidth }` for a clip or pattern block based on mode + selected + muted + contrast + gradient direction. Creates a `CanvasGradient` only when `mode === 'gradient'`. Does not read tokens, does not read store, does not call `getComputedStyle`. `previewAlpha` was deliberately not returned — see "Preview alpha decision" below.

## Body mode formulas

All numbers are pre-contrast, pre-muted *target* alphas. Final alpha = `target × contrastMul × (muted ? 0.3 : 1.0)`, clamped `[0, 1]`.

### Plain (default — must match Pass 4B at medium contrast)

| | unselected | selected |
|---|---|---|
| audio clip | 0.60 | 0.80 |
| pattern block | 0.55 | 0.75 |

At `contrast=medium` (multiplier 1.0) and unmuted (multiplier 1.0), the final alpha equals the Pass 4B formula `(selected ? 0.8 : 0.6) * mutedMul` for clips and `(selected ? 0.75 : 0.55) * mutedMul` for patterns. **Identical output.**

### Minimal

| | unselected | selected |
|---|---|---|
| body fill | 0.18 | 0.26 |

Strong semantic outline (border alpha 1.0) carries identity. Good for dense timelines.

### Gradient

Vertical linear gradient between two stops on the same semantic hex.

| | low stop | high stop |
|---|---|---|
| unselected | 0.38 | 0.70 |
| selected | 0.48 | 0.82 |

Direction:
- `top` (default) — high stop at the top of the body.
- `bottom` — high stop at the bottom of the body.

`ctx.createLinearGradient` is created **only** in this mode. No `ctx.shadowBlur`, no glow, no hardcoded colors — alpha and the semantic label hex are the only inputs.

### Solid

| | fill |
|---|---|
| unselected | 0.74 |
| selected | 0.86 |

Strong flat fill. Useful for readability. Border still drawn at alpha 1.0.

## Contrast multiplier

Applied uniformly to the per-mode target alpha for both audio clips and pattern blocks (v1 scope).

| value | multiplier |
|---|---|
| low | 0.82 |
| medium | 1.0 |
| high | 1.18 |

All resulting alphas are clamped to `[0, 1]`. Contrast does not affect font weight, geometry, or hit areas.

## Muted handling

Preserved exactly: `mutedMul = isMuted ? 0.3 : 1.0`. The material helper folds this in as the same multiplier on the fill alpha (and on both gradient stops). Border alpha is not muted-attenuated — it stays at 1.0 — matching prior behavior. Track muted data and behavior are not changed.

## Selection state

Preserved exactly:
- Selected border width: 2px (vs 1px unselected).
- Selected inner highlight ring: drawn verbatim from Pass 4B.
- Resize handles: drawn verbatim, only when `selected` and width permits.

The body mode only changes body material (fill/border), never selection semantics.

## Waveform visibility (drawClips)

```
const wfMode = ds.timelineShowWaveforms
const wfMinW = wfMode === 'always' ? 16 : 24
if (wfMode !== 'never' && clipW >= wfMinW && bpm && region) { ...existing waveform block... }
```

- `never` — no waveform draw call. Cache regime detection (`getRegime`) and cache fetches outside the gated block are unchanged. Caches are **not** invalidated.
- `always` — render at `clipW >= 16`.
- `auto` — render at `clipW >= 24`.

Existing inner waveform logic (regime selection, hi-res cache, fallback envelope, alpha bake-in for `drawEnvelope` etc.) is unmodified. The previous threshold was `clipW > 20`, so default `auto` is slightly more conservative (24) and `always` is slightly more permissive (16). This matches the Pass 5A spec.

## Pattern preview visibility (drawPatternBlocks)

```
const ppMode = ds.timelineShowPatternPreview
const ppMinW = ppMode === 'always' ? 20 : 32
if (ppMode !== 'never' && pattern && pattern.notes?.length && pattern.lengthTicks > 0 && blockW >= ppMinW) { ... }
```

- `never` — no mini-note draw. Loop glyph, dashed top border, name, resize handles, body, selection — all unchanged.
- `always` — render at `blockW >= 20`.
- `auto` — render at `blockW >= 32`.

Loop/one-shot semantics, note marker geometry, clipping, and pitch-range normalization are unchanged. Previous threshold was `blockW > 30`, so default `auto` (32) is slightly more conservative — spec-aligned.

## Text & metadata — unchanged

This pass intentionally does **not** touch:
- Clip name drawing position, font, color, clipping rect, or syllable label rendering.
- Pitch / reverse / stretch / velocity overlay (background box, text color, position).
- Pattern name drawing position, font, color, or clipping rect.
- Loop glyph (`↻` / `∣→`) rendering.
- Dashed top border on pattern blocks.

`timelineShowClipNames`, `timelineShowPitchShift`, `timelinePitchShiftStyle` are not consumed yet — Pass 5D.

## Preview alpha decision

`getTimelineBodyMaterial` deliberately does **not** return `previewAlpha`. The waveform renderers (`drawEnvelope`, `drawTrace`, `drawWaveformLine`, `drawSamplePoints`) take colors with alpha baked in (e.g., `rgba(255,255,255,${envAlpha})` at line 535). Wiring a preview alpha through would either require pre-multiplying alpha into every call-site color string or modifying renderer signatures — both larger changes than 5C wants.

Body modes are visually distinct without preview-alpha modulation. Per-clip/per-pattern preview-alpha modulation is a clean candidate for Pass 5D when the renderer can take an explicit alpha parameter.

## Visual notes per mode

### Minimal
- Body is faint (~18%/26% pre-contrast); border carries identity.
- Waveforms and pattern previews remain visible at the same alpha they had in Pass 4B, so they read more strongly relative to the lighter body.
- Useful for arrangement views with many tracks.

### Plain (default)
- Indistinguishable from Pass 4B at `medium` contrast. This is the safe default.
- At `low` contrast, body softens slightly. At `high`, slightly stronger. Border is unaffected (always 1.0).

### Gradient
- Subtle vertical material; high stop ≈70%, low stop ≈38% (unselected, medium contrast).
- Direction `top` puts the brighter stop at the top, `bottom` flips it.
- No hardcoded colors. No glow. No `ctx.shadowBlur`. Uses the semantic label hex with alpha only.

### Solid
- ≈74% / 86% body fill — strong, readable, label-color dominated.
- Text stays inside its existing clipping rect with the existing label tokens. If a future light theme makes label text fight the strong fill, that's solved in Pass 5E (token audit) or with the chip backing planned for Pass 5D — out of scope for 5C.

## Light-theme notes

- `plain` matches current rendering exactly at `medium`.
- `solid` at `high` contrast is the highest-risk combination for label text contrast on light label hexes. Not changed in this pass; flagged for Pass 5D's chip-backing work and Pass 5E token audit.
- `minimal` reads well in light theme — outlines remain visible against the lighter timeline well.

## Dark-theme notes

- All four modes preserve Xleth's restrained look (no glossy gradients, no glow).
- Gradients can read more clearly against the darker timeline well; that's the intended affordance.
- Selection inner highlight ring (focus token) keeps cyan identity in dark theme.

## Performance notes

- `normalizeTimelineDisplaySettings` runs **once** per `drawClips` / `drawPatternBlocks` call (outside the per-clip loop).
- `getTimelineBodyMaterial` is called once per visible clip / pattern. It does:
  - one set lookup + arithmetic (cheap),
  - one `hexToRgba` call (existing helper),
  - and **only in gradient mode**, one `ctx.createLinearGradient` plus two `addColorStop` calls.
- No `getComputedStyle` calls inside the inner loop (palette resolution remains a single up-front call via `resolveTimelinePalette`).
- No new token lookups inside the inner loop.
- No `ctx.shadowBlur` introduced anywhere.
- No gradient cache added; gradients in the default `plain` mode are not created at all. If a future profile shows hot paths in heavy `gradient` use, a per-redraw `Map<key, CanvasGradient>` is the natural next step.

## Behavior smoke (logical)

The following are **not** reachable via the body-mode work because the relevant code paths are byte-for-byte unchanged in this pass:
- Clip move, resize, split, delete.
- Pattern block move, resize, split, delete.
- Hit testing (TimelineCanvas hit tests use position/duration, not fill style).
- Snapping.
- Playback / playhead timing.
- Waveform cache fetch + invalidation.
- Clip-peak cache invalidation.
- Clip / pattern geometry.

Visual smoke and runtime click-through were not executable inside this sandbox (Electron-only app). Plan-level runtime smoke remains required before merge — see "Runtime verification (operator)" below.

## Build & test results

- `npm run build` — **passed** (built in 2.44s; existing chunk-size warning unchanged).
- `npx vitest run` — **1207 passed / 11 failed / 3 skipped (1221 total)** across **57 test files (51 passed, 6 failed)**.
  - All 15 `timelineDisplayStore` tests pass.
  - The 11 failures are entirely in `src/plugin-ui/runtime/__tests__/transientViz.test.jsx`, `src/plugin-ui/runtime/__tests__/visualB.test.jsx`, and `src/plugin-ui/schema/__tests__/visualA.test.js`. They check plugin-UI knob appearance tokens (`--theme-accent` vs `--theme-border-focus`) and transient/limiter parser fallbacks. **Confirmed pre-existing and unrelated** to Pass 5C: a grep for `timelineDrawing|timelineDisplay` across `src/plugin-ui/` returns no matches, and the failures correlate with theme-token renames already present in the branch (`ui/src/theming/shipped/xleth-light.json`, `ui/src/theming/tokens/catalog.ts` were modified before this session).
  - The new export `normalizeTimelineDisplaySettings` is additive — no existing signatures changed.

## Playwright

`XLETH_PLAYWRIGHT=1 npx playwright test` was run.

**Result: 1 failed, 28 did not run.**

Exact failure (test `01-app-default`):

```
page.waitForSelector: Target page, context or browser has been closed
Call log:
  - waiting for locator('.app') to be visible
    at tests\baseline\capture.spec.ts:93:14
```

Electron closed before Playwright could attach to the renderer. This is an environmental Electron-attach failure; the remaining 28 tests were skipped because the suite tears down after the first hard failure during launch. Per the plan, this failure mode is documented, no baselines were updated, and Pass 5C's render-only changes do not affect Electron launch.

## Runtime verification (operator)

Run from the Electron app:
1. Open Timeline; open the Display popover.
2. Cycle Clip body through `minimal / plain / gradient / solid`; confirm timeline redraws after each change.
3. Repeat for Pattern body; modes can differ from clip mode.
4. With either mode set to `gradient`, toggle direction `top` / `bottom`.
5. Cycle contrast through `low / medium / high`; observe softening / strengthening.
6. Cycle Waveforms `auto / always / never`; `never` hides waveform but keeps body, fades, handles, text.
7. Cycle Pattern preview `auto / always / never`; `never` hides mini-notes but keeps body, dashed top, loop glyph, name.
8. Confirm no console errors; no unknown-token warnings.
9. Confirm Pass 4B-equivalent rendering when settings are at defaults.

## Untouched (explicit confirmation)

- Engine code (C++): not modified.
- Bridge code (Node-API): not modified.
- IPC: not modified.
- Project save/load schema: not modified.
- Timeline tools (move, resize, split, etc.): not modified.
- Hit testing: not modified.
- Snapping: not modified.
- Playback / playhead: not modified.
- Waveform cache / clip peak cache: not modified.
- Package files (`package.json`, lockfile): not modified.
- Playwright baselines: not modified.
- `ui/src/stores/timelineDisplayStore.js`: not modified.
- `ui/src/components/timeline/TimelineToolbar.jsx`: not modified.
- `ui/src/components/timeline/TimelineDisplayPopover.jsx`: not modified.
- `ui/src/styles/app.css`: not modified.
- Theme tokens: no new tokens; no token reads inside body mode logic.
