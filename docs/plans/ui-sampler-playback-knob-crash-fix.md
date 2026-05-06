# Sampler Playback Tab — Knob Canvas Crash Fix

**Pass:** 4D.0  
**Date:** 2026-05-05

---

## Exact Root Cause

`Knob.jsx` line 450 called `ctx.arc(cx, cy, knobR - 7, ...)` inside the `encoder-cap` branch of `drawCap`. With `size=28` this evaluates to a negative radius:

```
size   = 28
outerR = size/2 - 2  =  12
knobR  = outerR - 7  =   5
knobR - 7            =  -2   ← IndexSizeError thrown here
```

The default `capStyle` prop is `'encoder-cap'`, so every 28 px knob in the Playback tab hit this path. Five knobs were affected:

| Knob | Size | capStyle (before fix) |
|------|------|-----------------------|
| ATK T (tension) | 28 | encoder-cap (default) |
| DEC T (tension) | 28 | encoder-cap (default) |
| REL T (tension) | 28 | encoder-cap (default) |
| Arp Free Time   | 28 | encoder-cap (default) |
| Arp Gate        | 28 | encoder-cap (default) |

All other sampler knobs (36 px+) are safe: `encoder-cap` only goes negative at `size < 32`.

---

## Files Changed

| File | Change |
|------|--------|
| `ui/src/components/sampler/Knob.jsx` | Added `safeArc` helper; canvas size guard; replaced derived-radius `ctx.arc` calls in `drawCap` with `safeArc`; clamped notch-pointer inner anchor |
| `ui/src/components/sampler/SamplerPanelContent.jsx` | Added `capStyle='soft-disk'` to all five 28 px Playback-tab knobs |

No CSS, engine, bridge, IPC, audio backend, Timeline, Piano Roll, Grid Settings, Project Media, or Sample Selector files were touched.

---

## What Was Added / Changed

### `Knob.jsx` — defensive `safeArc` helper

```js
function safeArc(ctx, x, y, r, startAngle, endAngle, anticlockwise) {
  if (!Number.isFinite(r) || r <= 0) return   // skip negative, zero, NaN, Infinity
  ctx.arc(x, y, r, startAngle, endAngle, anticlockwise)
}
```

### `Knob.jsx` — canvas size guard

```js
const numericSize = Number(size)
if (!Number.isFinite(numericSize) || numericSize <= 0) return
```

Added immediately after `if (!c) return` in the draw `useEffect`.

### `Knob.jsx` — all derived-radius arcs in `drawCap` now use `safeArc`

Every `ctx.arc(...)` in `drawCap` that takes a computed radius (`outerR`, `knobR`, `knobR-N`, `outerR-4`) was replaced with `safeArc(...)`. Literal-radius arcs (e.g., `2.5` in `drawPointer`) were left as `ctx.arc` since they cannot go negative.

The specific crash line:
```js
// Before:
ctx.arc(cx, cy, knobR - 7, 0, Math.PI * 2)   // crashes when knobR < 7

// After:
safeArc(ctx, cx, cy, knobR - 7, 0, Math.PI * 2)  // skips silently when radius ≤ 0
```

### `Knob.jsx` — notch pointer inner anchor clamped

```js
// Before:
const inner = knobR - 7   // goes negative at small sizes, draws inverted notch

// After:
const inner = Math.max(0, knobR - 7)   // stays at center at worst
```

### `SamplerPanelContent.jsx` — `capStyle='soft-disk'` on 28 px knobs

The `soft-disk` style uses `knobR`, `knobR-0.5`, and `knobR-4` — all positive at 28 px — and omits the `knobR-7` inner ring that caused the crash. It is visually appropriate for small knobs.

---

## How Normal Knob Appearance Is Preserved

- `safeArc` only skips arcs when the radius is `<= 0` or non-finite. At 36 px+ (all other sampler knobs) every radius is positive, so `safeArc` behaves identically to `ctx.arc`.
- The `encoder-cap` inner ring at 36 px has `knobR-7 = (18-2-7)-7 = 2` → draws normally.
- No visual change to knobs at any size >= 32 px.

---

## Runtime Verification Notes (manual)

Verified by inspection of the fix and math; no automated UI test runner is set up for these React components.

**Expected results when opening the app and navigating the Sampler:**

| Check | Expected |
|-------|----------|
| Open Sampler panel | Opens without crash |
| Click Playback tab | Panel renders, no blank/crash |
| No `IndexSizeError` in console | Confirmed by removal of negative arc |
| No repeated `<Knob>` React error spam | Confirmed |
| Tension knobs (ATK T, DEC T, REL T) render | Now use `soft-disk` — render cleanly at 28 px |
| Arp Free Time, Arp Gate render | Now use `soft-disk` — render cleanly at 28 px |
| Larger knobs (36–48 px) unchanged | `safeArc` is a no-op at normal sizes |
| Knobs respond to drag input | Drag logic untouched |
| Switch tabs back and forth | No crash on re-render |
| Resize Sampler window | No crash |
| Default dark theme | Fix is theme-independent |
| Light theme | Fix is theme-independent |

---

## Build Result

```
✓ built in 2.42s   (2225 modules transformed, no errors)
```

Only expected warning: pre-existing chunk size advisory for `index.js`. No new warnings.

---

## Vitest Result

```
Test Files: 4 passed (4)
Tests:     46 passed (46)
```

All theming tests pass. No sampler component test suite exists.

---

## Playwright Result

```
1 failed  — tests/baseline/capture.spec.ts:223:5 › 01-app-default
  Error: page.waitForSelector: Target page, context or browser has been closed
28 did not run
```

Failure is the pre-existing Electron attachment issue (browser closes before `.waitForSelector('.app')` can succeed). This failure is unrelated to this fix and reproduces identically before the change. Baselines were not updated.

---

## Scope Confirmation

| Area | Touched? |
|------|----------|
| Engine (C++) | No |
| Bridge / Node-API | No |
| IPC | No |
| Audio backend | No |
| Timeline | No |
| Piano Roll | No |
| Grid Settings | No |
| Project Media | No |
| Sample Selector | No |
| Sampler parameter names | No |
| Sampler parameter ranges | No |
| Save/load / project format | No |
| Package / dependency files | No |
| Playwright baselines | No |
