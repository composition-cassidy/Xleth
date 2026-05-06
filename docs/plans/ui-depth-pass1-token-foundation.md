# UI Depth — Pass 1 Token Foundation

> **Pass 1 is selector-free.** This document describes the token vocabulary
> registered in this pass. No `app.css`, `windowing.css`, JSX, or canvas
> paint code was modified. The only acceptable visible change is a new
> "Depth & elevation" branch under "Foundations" in the Theme Editor's
> AdvancedMode tree.

Companion to:
- [ui-depth-pass0-diagnostic.md](ui-depth-pass0-diagnostic.md) — the audit that motivated this work.
- The approved plan at `~/.claude/plans/pass-1-add-xleth-s-synthetic-moore.md`.

---

## What changed

### Files touched
- [ui/src/theming/tokens/catalog.ts](../../ui/src/theming/tokens/catalog.ts) — added one `SUBSYSTEMS` entry (`depth`) under Foundations and 30 token declarations in a new "Depth & elevation" block placed after the existing `borders` block.
- [ui/src/theming/tokens/__tests__/depth-tokens.test.ts](../../ui/src/theming/tokens/__tests__/depth-tokens.test.ts) — new vitest suite asserting registration, kind correctness, grouping, and resolution through `resolveTheme()`.
- [docs/plans/ui-depth-pass1-token-foundation.md](ui-depth-pass1-token-foundation.md) — this document.

### Files explicitly NOT touched
- `ui/src/theming/tokens/base.ts`, `derivation.ts` — base set + derivation formulas unchanged.
- `ui/src/theming/tokens/__tests__/derivation.test.ts` — its hardcoded list (lines 198–248) only governs `derived-formula` tokens; Pass 1 used only `explicit()` and `ref()`, so the count is unaffected.
- `ui/src/theming/schema/*` — no new `TokenKind`, no new derivation type.
- `ui/src/theming/runtime/*` — `resolveTheme()` already handles every derivation type used.
- `ui/src/theming/editor/*` — `AdvancedMode` auto-discovers new SubsystemMeta entries; `SimpleMode` keeps the same 5 base knobs.
- `ui/src/theming/shipped/*.json` — every new token has a sensible default in the catalog itself. Light-theme softening of the new shadow values is deferred to **Pass 2** (lands in the same commit as the selectors that consume them, to avoid orphan diff).
- `ui/src/styles/app.css`, `ui/src/windowing/components/windowing.css`, every JSX/JS canvas paint path — Pass 1 is selector-free.
- C++ engine, Node-API bridge, FFmpeg/JUCE/OpenGL, IPC — out of scope.

---

## Tokens added (30) — by category

All under `subsystem: 'depth'`, `category: 'Foundations'`. Names follow the existing convention `--theme-{subsystem}-{element}[-{state}]`.

### Surface aliases (kind: `color`, capability: `solid`)

Semantic handles so future selectors can read "elevation level" / "well" / "floating" / "pressed" without coupling to the raw `bg-*` token names. Default values delegate to the existing background family via `var()` references.

| Token | Default (resolves to) | Intended use |
|---|---|---|
| `--theme-depth-elevation-1-bg`        | `var(--theme-bg-secondary)` | Toolbars, panel bodies, pattern-list, track-header column. |
| `--theme-depth-elevation-2-bg`        | `var(--theme-bg-surface)`   | Idle floating panel body, raised cards, dropdown body. |
| `--theme-depth-elevation-3-bg`        | `var(--theme-bg-elevated)`  | Focused floating panel, modals, popovers, tooltip body. |
| `--theme-depth-well-bg`               | `var(--theme-bg-inset)`     | Recessed editor surfaces (timeline lanes, piano-roll grid, velocity lane, waveform scrubber, video canvas). |
| `--theme-depth-floating-bg`           | `var(--theme-bg-elevated)`  | Floating panel default — semantic alias of elevation-3. |
| `--theme-depth-pressed-bg`            | `var(--theme-bg-active)`    | Buttons / tabs in pressed/active state. |

### Borders (kind: `color`, capability: `solid`)

Replaces today's near-universal use of `var(--theme-border-subtle)` for every container, giving each elevation level its own border handle.

| Token | Default | Intended use |
|---|---|---|
| `--theme-depth-elevation-1-border`         | `var(--theme-border-subtle)` | 1px chrome around toolbars, header columns. |
| `--theme-depth-elevation-2-border`         | `rgba(232, 232, 237, 0.10)` | Slightly lighter rim on raised cards / floating panels. |
| `--theme-depth-elevation-3-border`         | `var(--theme-border-strong)` | Modals, popovers, focused floating chrome. |
| `--theme-depth-floating-border`            | `var(--theme-border-subtle)` | Floating panel idle border. |
| `--theme-depth-floating-focused-border`    | `var(--theme-border-focus)` | Focused panel border (= accent). |
| `--theme-depth-well-border`                | `rgba(0, 0, 0, 0.5)` | Inner border of recessed editor wells (sits inside the well-inner-shadow). |

### Highlights / inset edges (kind: `shadow`, capability: `solid`)

Stored as box-shadow strings so consumers apply them via `box-shadow:` directly. The inset top-highlight is the single most missing primitive identified in Pass 0.

| Token | Default |
|---|---|
| `--theme-depth-elevation-1-top-highlight` | `inset 0 1px 0 rgba(255, 255, 255, 0.04)` |
| `--theme-depth-elevation-2-top-highlight` | `inset 0 1px 0 rgba(255, 255, 255, 0.06)` |
| `--theme-depth-elevation-3-top-highlight` | `inset 0 1px 0 rgba(255, 255, 255, 0.08)` |
| `--theme-depth-floating-top-highlight`    | `inset 0 1px 0 rgba(255, 255, 255, 0.06)` |
| `--theme-depth-elevation-1-bottom-edge`   | `inset 0 -1px 0 rgba(0, 0, 0, 0.30)` |

### Outer / inner shadows (kind: `shadow`, capability: `solid`)

| Token | Default |
|---|---|
| `--theme-depth-elevation-2-outer-shadow` | `0 4px 12px rgba(0, 0, 0, 0.35)` |
| `--theme-depth-elevation-3-outer-shadow` | `var(--theme-chrome-shadow)` |
| `--theme-depth-floating-shadow`          | `var(--theme-chrome-shadow)` |
| `--theme-depth-floating-focused-shadow`  | `0 0 0 1px var(--theme-accent), 0 12px 40px rgba(0, 0, 0, 0.6)` |
| `--theme-depth-well-inner-shadow`        | `inset 0 2px 4px rgba(0, 0, 0, 0.45), inset 0 0 0 1px rgba(0, 0, 0, 0.30)` |
| `--theme-depth-well-top-shadow`          | `inset 0 4px 8px rgba(0, 0, 0, 0.35)` |
| `--theme-depth-pressed-inner-shadow`     | `inset 0 1px 2px rgba(0, 0, 0, 0.45)` |

### Accent glow / focus halo (kind: `shadow`, capability: `solid`)

For selected clip / note / focused panel / playhead / hover-pressed control. Two of the values use `var(--theme-accent)` directly so a theme change cascades; the alpha-tinted variants currently use hardcoded `rgba(51, 206, 214, …)` matching the shipped default — see **Known debt** below.

| Token | Default |
|---|---|
| `--theme-depth-accent-glow-subtle` | `0 0 8px rgba(51, 206, 214, 0.20)` |
| `--theme-depth-accent-glow-medium` | `0 0 16px rgba(51, 206, 214, 0.28)` |
| `--theme-depth-accent-glow-strong` | `0 0 26px rgba(51, 206, 214, 0.35)` |
| `--theme-depth-accent-ring`        | `0 0 0 1px var(--theme-accent)` |
| `--theme-depth-accent-halo`        | `0 0 0 2px rgba(51, 206, 214, 0.20), 0 0 0 1px var(--theme-accent)` |

### Depth amplitude (kind: `dimension`, capability: `solid`)

| Token | Default |
|---|---|
| `--theme-depth-amplitude` | `1` |

Unitless multiplier consumed at **selector level** in Pass 2/3/4. Default `1` preserves current visual language. Range guidance: `0` flat, `0.5` subtle, `1` Xleth default, `1.5–2` FL-style strong.

`'dimension'` kind is correct because the validator at `themeSchema.ts:36–38` accepts bare numbers via `NUMBER_RE`. `'opacity'` would cap at 1 and block the FL-style range.

---

## How `--theme-depth-amplitude` should be consumed (future passes)

Token values themselves cannot do CSS math — the catalog stores literal strings only and `compileTokenValue()` is a pure pass-through. The amplitude is therefore consumed **at selector level** in `app.css` / `windowing.css`, like this (Pass 2+):

```css
/* SPECULATIVE — Pass 2 must verify calc(<length> * var(<unitless>))
   in Xleth's exact Electron 41 Chromium runtime before broad use. */
.xleth-panel-frame {
  box-shadow:
    0
    calc(12px * var(--theme-depth-amplitude))
    calc(40px * var(--theme-depth-amplitude))
    rgba(0, 0, 0, 0.6);
}

/* For inset highlights, scale the alpha via opacity instead. */
.titlebar::before {
  box-shadow: var(--theme-depth-elevation-1-top-highlight);
  opacity: var(--theme-depth-amplitude);
}
```

### Verification gate for Pass 2

Before Pass 2/3/4 commits to `calc(<length> * var(--theme-depth-amplitude))` widely, the implementer must verify the syntax actually multiplies correctly in Electron 41's Chromium build. Open a scratch element in DevTools, change `--theme-depth-amplitude` live, and confirm the box-shadow recomputes as expected. **A broken depth amplitude would silently make shadows invalid.**

If `calc()` multiplication is unreliable, fall back to one of:

- **Stepped amplitude classes**: ship 3–4 precomputed shadow tokens (e.g. `--theme-depth-elevation-2-outer-shadow-flat | -subtle | -default | -strong`) and switch via `[data-depth="strong"]` on `<html>`.
- **Per-property amplitude tokens**: replace the single multiplier with a small set of pre-multiplied values (e.g. `--theme-depth-amplitude-shadow-blur` swapped wholesale per amplitude preset).

### Theme Editor knob (later pass — NOT this one)

A future pass will add an `<input type="range">` knob in `SimpleMode.tsx` that calls:

```ts
updateTokens({ '--theme-depth-amplitude': String(value) })
```

with `min=0`, `max=2`, `step=0.05`. The `KNOBS` array in [SimpleMode.tsx:7–13](../../ui/src/theming/editor/SimpleMode.tsx) currently hardcodes 5 base color tokens; that pass extends it (or adds a sibling array for non-color knobs) without changing the catalog. Pass 1 deliberately does **not** wire this — registering the token is enough for the foundation.

---

## Known debt left for Pass 2/3 to clean up

1. **Hardcoded accent rgba in glow tokens.** `rgba(51, 206, 214, …)` in `--theme-depth-accent-glow-{subtle,medium,strong}` and `--theme-depth-accent-halo` matches `--theme-accent = #33CED6` in the shipped default. Warm / Cool / Light themes will not get accent-matched glow until these are converted to either:
   - new `derivedFormula(...)` entries in `derivation.ts` using `withAlpha(accent, 0.20|0.28|0.35)` (would need updating `derivation.test.ts`'s hardcoded list — out of scope for Pass 1), or
   - explicit per-theme overrides in each shipped JSON (mirrors how `xleth-light.json` already overrides `--theme-chrome-shadow` for light-mode contrast).

   This was a deliberate Pass 1 shortcut to keep the change selector-free, derivation-untouched, and pixel-identical. Pass 2/3 must address it before broad selector adoption.

2. **Light-theme shadow softening.** `xleth-light.json` already overrides `--theme-chrome-shadow`, `--theme-modal-shadow`, etc. to 0.20 alpha. The new depth shadow tokens will need parallel overrides in light mode. Deferred to Pass 2 to keep the diff atomic with the selectors that consume the shadows.

3. **Cool / Warm theme depth overrides.** Same story — once selectors consume `--theme-depth-*` tokens, those themes may want their own values. Deferred.

---

## Verification

Run from repo root.

1. **TypeScript / build** — `cd ui && npm run build` — catalog passes type-check.
2. **Vitest theming suite** — `cd ui && npx vitest run src/theming` — derivation/tokenValue tests stay green; new `depth-tokens.test.ts` passes.
3. **`:root` introspection** — `cd ui && npm run dev`, then in the renderer DevTools console:
   ```js
   const r = getComputedStyle(document.documentElement);
   r.getPropertyValue('--theme-depth-amplitude').trim();          // → "1"
   r.getPropertyValue('--theme-depth-elevation-2-top-highlight'); // → "inset 0 1px 0 rgba(255, 255, 255, 0.06)"
   r.getPropertyValue('--theme-depth-floating-shadow');           // → resolves through chrome-shadow ref
   r.getPropertyValue('--theme-depth-accent-glow-medium');        // → "0 0 16px rgba(51, 206, 214, 0.28)"
   ```
4. **AdvancedMode tree** — open the Theme Editor → Advanced. New "Depth & elevation" branch appears under "Foundations" listing all 30 tokens. SimpleMode unchanged.
5. **Playwright pixel baselines** — `cd ui && XLETH_PLAYWRIGHT=1 npx playwright test`. Report current pass/fail/skip counts in the commit message; do **not** update baselines. The only acceptable Theme Editor diff is the new tree branch.
6. **Other shipped themes** — switch to Cool / Light / Warm in the editor with the validation panel open. Verify all 30 new tokens resolve to non-empty strings at `:root`, and that no unknown-token warnings appear. If they fail, update the shipped JSONs to include catalog defaults explicitly (current behaviour should be silent fallback through catalog defaults).

---

## Acceptance bar (universal)

- No change to: dimensions, spacing, fonts, transitions, z-index, hit-test areas, ARIA, keyboard navigation, engine code, bridge code, IPC, rendering pipeline.
- All four shipped themes load without validation warnings.
- `git diff --name-only` lists only: `ui/src/theming/tokens/catalog.ts`, `ui/src/theming/tokens/__tests__/depth-tokens.test.ts`, `docs/plans/ui-depth-pass1-token-foundation.md`. (Plus optionally the plan file at `~/.claude/plans/`.)
- `rg "var\\(--theme-depth-" ui/src` returns zero hits in the Pass 1 diff.
- New token group appears in AdvancedMode tree; SimpleMode unchanged.
- Pass 0 diagnostic vocabulary now exists in code, ready for Pass 2/3/4 selectors.
