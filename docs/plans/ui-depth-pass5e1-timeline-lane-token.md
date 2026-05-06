# Pass 5E.1 — Register `--theme-timeline-lane-bg`

## Summary

Foundation-only pass. Registers a single new token in the catalog and both shipped themes. No consumer added; no visible UI change.

---

## Files changed

| File | Change |
|---|---|
| `ui/src/theming/tokens/catalog.ts` | Added `--theme-timeline-lane-bg` explicit token to Timeline subsystem block |
| `ui/src/theming/shipped/xleth-default.json` | Added dark-theme value |
| `ui/src/theming/shipped/xleth-light.json` | Added light-theme value |
| `ui/src/theming/tokens/__tests__/timeline-lane-bg-token.test.ts` | New registration test |

---

## Token added

**`--theme-timeline-lane-bg`**

- Kind: `color`
- Capability: `any`
- Subsystem: `timeline`
- Category: `Workspace panels`
- Derivation: `explicit`
- Placed after `--theme-timeline-well-top-shadow` in the Timeline block.

### Values

| Theme | Value |
|---|---|
| `xleth-default` (dark) | `#07070B` |
| `xleth-light` | `#CACAC6` |

The light value (`#CACAC6`) intentionally inverts the dark-theme logic — a distinct light work surface rather than a near-black pit.

---

## Why `--theme-bg-inset` was not changed

`--theme-bg-inset` is a shared foundational token consumed by Piano Roll, SmartBalance canvas, and other inset surfaces across the app. Changing it to deepen Timeline contrast would inadvertently darken every other inset surface.

`--theme-timeline-lane-bg` provides an isolated handle so Timeline bed contrast can be tuned in Pass 5E.3 without touching `--theme-bg-inset`.

---

## Consumer status

No consumer reads `--theme-timeline-lane-bg` yet. Pass 5E.3 will wire it into `TimelineCanvas.jsx` / `timelineDrawing.js`.

---

## Verification

### Build
`npm run build` — passed (2.50 s, no errors, only the expected chunk-size warning).

### Theme tests
`npx vitest run src/theming` — **49/49 passed** (5 test files).

New tests added in `timeline-lane-bg-token.test.ts`:
- token exists in catalog under `timeline` subsystem, kind `color`
- resolves to `#07070B` in default theme
- resolves to `#CACAC6` in light theme

### Scope check (`git diff --name-only HEAD`)
Pass-5E.1-specific changes visible in the diff:
- `ui/src/theming/tokens/catalog.ts`
- `ui/src/theming/shipped/xleth-default.json`
- `ui/src/theming/shipped/xleth-light.json`

New untracked file (confirmed via `git status`):
- `ui/src/theming/tokens/__tests__/timeline-lane-bg-token.test.ts`

---

## Untouched-files confirmation

The following files were **not modified** by this pass (hard exclusions respected):

- `--theme-bg-inset` — unchanged
- `--theme-timeline-bar-line` — unchanged
- `--theme-timeline-beat-line` — unchanged
- `--theme-timeline-subdivision-line` — unchanged
- `--theme-timeline-pattern-lane-tint` — unchanged
- `timelineDrawing.js` — unchanged
- `TimelineCanvas.jsx` — unchanged
- `app.css` — unchanged
- `windowing.css` — unchanged
- Mixer, Sample Selector, Project Media, Preview, Grid Settings, Piano Roll — unchanged
- Engine, bridge, IPC, project schema, package files — unchanged
- Playwright baselines — unchanged

---

## Expected UI effect

None. The token is registered but not consumed by any selector or canvas drawing code. No visible change in either theme.
