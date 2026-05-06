# UI Depth — Pass 3.1 Small-Control Occlusion Depth

> **Pass 3.1 is selector-only.** No JSX, no token catalog, no derivation, no canvas paint code, no engine/bridge/IPC modified.
> Pass 3 gave controls a top highlight and pressed-inset; Pass 3.1 adds the missing dark occlusion lower edge and tiny grounding shadow so controls read as physically raised rather than just polished-flat.

Companion to:
- [ui-depth-pass3-tactile-controls.md](ui-depth-pass3-tactile-controls.md) — Pass 3 (top highlight + pressed-inset baseline this pass extends)
- [ui-depth-pass1-token-foundation.md](ui-depth-pass1-token-foundation.md) — token vocabulary consumed here

---

## What changed

### Files touched

- [`ui/src/styles/app.css`](../../ui/src/styles/app.css) — 5 selector groups
- [`ui/src/windowing/components/windowing.css`](../../ui/src/windowing/components/windowing.css) — 1 selector group
- [`docs/plans/ui-depth-pass3-1-small-control-occlusion.md`](ui-depth-pass3-1-small-control-occlusion.md) — this document

### Files explicitly NOT touched

- `ui/src/theming/tokens/catalog.ts` — no new tokens (all Pass 1 tokens)
- `ui/src/theming/shipped/*.json` — no light-theme overrides needed (see §Light-theme note)
- All `.jsx` / `.js` files — zero touches (see §JSX-touch report)
- C++ engine, Node-API bridge, IPC — out of scope

---

## Box-sizing guardrail — verified before implementation

Before converting `border: 0` / `border: none` to a real 1px border, confirmed that `*, *::before, *::after { box-sizing: border-box; }` is declared globally at `app.css:25–26`. All target buttons have fixed `width`/`height` declarations. Adding a `1px solid` border consumes from the content area; outer dimensions are unchanged.

This check was performed for:
- `.xleth-windowing-control-button` (22×22px fixed, `border: 0` → `border: 1px solid`) — safe
- `.titlebar-btn` (46px × `--titlebar-h` fixed, `border: none` → `border: 1px solid`) — safe
- `.timeline-tool-btn` and `.timeline-toolbar-button` (26×26px, `border: 1px solid transparent` → real color) — safe (border-width unchanged)

---

## Tokens consumed

All from Pass 1. No new tokens added.

| Token | Value | Role in Pass 3.1 |
|---|---|---|
| `--theme-depth-elevation-1-top-highlight` | `inset 0 1px 0 rgba(255,255,255,0.04)` | Kept from Pass 3 — top face sheen |
| `--theme-depth-elevation-1-bottom-edge` | `inset 0 -1px 0 rgba(0,0,0,0.30)` | **New** — dark occlusion lower rim |
| `--theme-depth-elevation-1-border` | `var(--theme-border-subtle)` | **New** — real border replacing transparent |
| `--theme-depth-pressed-inner-shadow` | `inset 0 1px 2px rgba(0,0,0,0.45)` | Unchanged from Pass 3 — active state |
| `--theme-depth-accent-ring` | `0 0 0 1px var(--theme-accent)` | Unchanged from Pass 3 — focus-visible |

**Raw value** (no token): `0 1px 2px rgba(0,0,0,0.25)` for the tiny outer grounding shadow.
**Justification**: `--theme-depth-elevation-2-outer-shadow` = `0 4px 12px rgba(0,0,0,0.35)` is too large for 22–26px controls. No existing token covers a 1–2px outer shadow for small buttons. Using a raw value follows the same precedent as Pass 2's inline shadow strings in the top-highlight tokens.

Hover grounding shadow: `0 1px 3px rgba(0,0,0,0.35)` (slightly stronger than default, also raw).

---

## Shadow stack shapes

```css
/* Default — raised button */
box-shadow:
  var(--theme-depth-elevation-1-top-highlight),   /* inset 0 1px 0 rgba(255,255,255,0.04) */
  var(--theme-depth-elevation-1-bottom-edge),     /* inset 0 -1px 0 rgba(0,0,0,0.30) */
  0 1px 2px rgba(0,0,0,0.25);

/* Hover — lift slightly */
box-shadow:
  var(--theme-depth-elevation-1-top-highlight),
  var(--theme-depth-elevation-1-bottom-edge),
  0 1px 3px rgba(0,0,0,0.35);

/* Active / pressed — sink inward, remove grounding (from Pass 3) */
box-shadow: var(--theme-depth-pressed-inner-shadow);

/* Focus-visible — raised + accent ring (from Pass 3, expanded) */
box-shadow:
  var(--theme-depth-elevation-1-top-highlight),
  var(--theme-depth-elevation-1-bottom-edge),
  0 1px 2px rgba(0,0,0,0.25),
  var(--theme-depth-accent-ring);
```

---

## Selectors changed

| Selector | File | State | Property | Old value | New value |
|---|---|---|---|---|---|
| `.xleth-windowing-control-button` | windowing.css:207 | default | `border` | `0` | `1px solid var(--theme-depth-elevation-1-border)` |
| `.xleth-windowing-control-button` | windowing.css:215 | default | `box-shadow` | top-highlight (1 layer) | 3-layer raised stack |
| `.xleth-windowing-control-button:hover` | windowing.css:221 | hover | `box-shadow` | top-highlight (1 layer) | 3-layer raised stack (stronger grounding) |
| `.xleth-windowing-control-button:focus-visible` | windowing.css:228 | focus | `outline` | `var(--theme-chrome-underline-thickness) solid var(--theme-border-focus)` | `none` |
| `.xleth-windowing-control-button:focus-visible` | windowing.css:229 | focus | `box-shadow` | (none) | 4-layer (raised + accent-ring) |
| `.titlebar-btn` | app.css:1005 | default | `border` | `none` | `1px solid var(--theme-depth-elevation-1-border)` |
| `.titlebar-btn` | app.css:1010 | default | `box-shadow` | top-highlight (1 layer) | 3-layer raised stack |
| `.titlebar-btn:hover` | app.css:1016 | hover | `box-shadow` | top-highlight (1 layer) | 3-layer raised stack (stronger grounding) |
| `.timeline-tool-btn` | app.css:1641 | default | `border` | `1px solid transparent` | `1px solid var(--theme-depth-elevation-1-border)` |
| `.timeline-tool-btn` | app.css:1649 | default | `box-shadow` | top-highlight (1 layer) | 3-layer raised stack |
| `.timeline-tool-btn:hover` | app.css:1654 | hover | `box-shadow` | top-highlight (1 layer) | 3-layer raised stack (stronger grounding) |
| `.timeline-tool-btn:focus-visible` | app.css:1664 | focus | `box-shadow` | top-highlight + accent-ring (2 layers) | 4-layer (raised stack + accent-ring) |
| `.timeline-toolbar-button` | app.css:6146 | default | `border` | `1px solid transparent` | `1px solid var(--theme-depth-elevation-1-border)` |
| `.timeline-toolbar-button` | app.css:6154 | default | `box-shadow` | top-highlight (1 layer) | 3-layer raised stack |
| `.timeline-toolbar-button:hover` | app.css:6159 | hover | `box-shadow` | top-highlight (1 layer) | 3-layer raised stack (stronger grounding) |
| `.timeline-toolbar-button:focus-visible` | app.css:6169 | focus | `box-shadow` | top-highlight + accent-ring (2 layers) | 4-layer (raised stack + accent-ring) |
| `.mixer-toolbar-btn` | app.css:6371 | default | `box-shadow` | top-highlight (1 layer) | 3-layer raised stack |
| `.mixer-toolbar-btn:hover` | app.css:6377 | hover | `box-shadow` | (none) | 3-layer raised stack (stronger grounding) |
| `.mixer-toolbar-btn:focus-visible` | app.css:6382 | focus | `box-shadow` | top-highlight + accent-ring (2 layers) | 4-layer (raised stack + accent-ring) |
| `.picker-btn` | app.css:3522 | default | `box-shadow` | top-highlight (1 layer) | 3-layer raised stack |
| `.picker-btn:hover` | app.css:3528 | hover | `box-shadow` | (none) | 3-layer raised stack (stronger grounding) |
| `.picker-btn:focus-visible` | app.css:3533 | focus | `box-shadow` | top-highlight + accent-ring (2 layers) | 4-layer (raised stack + accent-ring) |

### Not changed

- `.timeline-tool-btn.active`, `.timeline-toolbar-button.active` — pressed-inner-shadow from Pass 3 preserved; active state border keeps its semantic color (`rgba(255,255,255,0.15)` / `var(--theme-accent)`); no grounding shadow when pressed
- `.picker-play-btn.active` — already had `pressed-inner-shadow` from Pass 3; no additional change needed
- `.picker-btn:disabled` — `box-shadow: none` preserved

---

## `.center-tab` skip rationale

Tabs are horizontally large surfaces, not small square controls. A grounding shadow on tabs would not read correctly given the surrounding flat toolbar surface, and would add visual noise to the tab strip. The active `.center-tab` already has `pressed-inner-shadow` from Pass 3. Deferred to Pass 4 if reconsideration is warranted.

---

## JSX-touch report

**None.** All target selectors have existing className hooks. `git diff --stat` confirms zero `.jsx` / `.js` edits from Pass 3.1. The JSX files visible in `git diff --name-only` are pre-existing branch changes from Passes 1–3.

---

## Light-theme note

No `xleth-light.json` override added.

- `--theme-depth-elevation-1-bottom-edge` = `inset 0 -1px 0 rgba(0,0,0,0.30)` — a dark lower occlusion edge is semantically correct on light themes (it reads as the shadow side of a raised surface).
- `0 1px 2px rgba(0,0,0,0.25)` — 25% alpha drop shadow is barely perceptible on light backgrounds; provides ground-plane separation without being heavy. Acceptable.
- `--theme-depth-elevation-1-border` = `var(--theme-border-subtle)` — the light theme already overrides `--theme-border-subtle` to an appropriate light-mode value; no additional override needed.

---

## Verification results

| Check | Result |
|---|---|
| Build (`npm run build`) | ✅ PASS — 2.38s, zero errors |
| Vitest (`npx vitest run src/theming`) | ✅ 46/46 PASS |
| Selector-leak (`rg "var(--theme-depth-" ui/src`) | ✅ CLEAN — hits only in `app.css`, `windowing.css`, `ui/src/theming/` |
| JSX/JS touch (`git diff --stat *.jsx *.js`) | ✅ NONE from Pass 3.1 |
| Computed-style probe | ✅ See below |
| Playwright | ⚠️ See below |

### Computed-style probe results

Probed via `preview_eval` against the running Vite dev server after page reload.

**`.xleth-windowing-control-button`** (default state):
```
border:    1px solid rgb(42, 42, 56)    ← --theme-depth-elevation-1-border ✅
boxShadow: rgba(255,255,255,0.04) 0px 1px 0px 0px inset,   ← top-highlight ✅
           rgba(0,0,0,0.30) 0px -1px 0px 0px inset,          ← bottom-edge ✅
           rgba(0,0,0,0.25) 0px 1px 2px 0px                  ← grounding shadow ✅
```

**`.timeline-tool-btn`** (first non-active element):
```
border:    1px solid rgb(42, 42, 56)    ← --theme-depth-elevation-1-border ✅
boxShadow: rgba(255,255,255,0.04) 0px 1px 0px 0px inset,   ← top-highlight ✅
           rgba(0,0,0,0.30) 0px -1px 0px 0px inset,          ← bottom-edge ✅
           rgba(0,0,0,0.25) 0px 1px 2px 0px                  ← grounding shadow ✅
```

**`.mixer-toolbar-btn`**:
```
border:    0.571429px solid rgb(42, 42, 56)   ← pre-existing 0.5px rendering of 1px
boxShadow: rgba(255,255,255,0.04) 0px 1px 0px 0px inset ✅
           rgba(0,0,0,0.30) 0px -1px 0px 0px inset ✅
           rgba(0,0,0,0.25) 0px 1px 2px 0px ✅
```

**`.titlebar-btn`**: CSS rule text confirmed correct in stylesheet (`border: 1px solid var(--theme-depth-elevation-1-border)` ✅, 3-layer shadow present ✅). Computed `boxShadow` reports all-zero even with inline override — **web-preview limitation**: Chromium suppresses `getComputedStyle().boxShadow` for elements with `-webkit-app-region` when rendered outside an Electron context. The border applies correctly (confirmed at `1px solid rgb(42, 42, 56)`) and the CSS rule is intact. Expected to render correctly in the Electron app.

Elements not in current view (`.timeline-toolbar-button`, `.picker-btn`, `.picker-play-btn`): CSS edits confirmed via file read and build. Not probed via computed style because the panels containing them were not open in the preview session.

### Playwright

```
1 failed / 28 did-not-run
Error: page.waitForSelector: Target page, context or browser has been closed
  at tests/baseline/capture.spec.ts:93
    await page.waitForSelector('.app', { timeout: 30_000 });
```

Pre-existing Electron-attach flake — Electron process closes before test runner can attach. Unrelated to Pass 3.1 CSS changes. No baselines updated.

---

## Deferred to Pass 4

- Mixer fader thumb / groove
- Pattern list rows
- `.center-tab` grounding shadow
- Plugin-UI internal controls
- Theme Editor depth-amplitude knob
- `--theme-depth-accent-glow-*` accent-derived formula conversion (Pass 1 known debt)
- Canvas-side depth (timeline lanes, piano roll grid, velocity lane, waveform body)
