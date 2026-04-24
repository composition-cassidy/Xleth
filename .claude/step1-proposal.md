Now the combined change list. Below is the full Step 1 output — diagnostic summary first, then proposed changes grouped by approval-unit.

---

# Step 1 Diagnostic — Results

## 1.1 Catalog facts

- **489** total tokens in `catalog.ts` (TOKENS_BY_NAME). All 489 resolve to a concrete value after flattening `derived-var` refs (zero unresolvable).
- Fine-grained value-kind distribution (inferred from resolved values): **color 415 · rgba 55 · gradient 1 · dimension 9 · opacity 1 · other 8** (the "other" bucket is all shadow-compound strings — the classifier will treat those as `shadow`).
- **35** subsystems enumerated in `SUBSYSTEMS`.

## 1.2 Gate-coverage against 575 non-FP matches

| Gate | Pass | Fail | Cumulative coverage |
|---|---:|---:|---:|
| Gate 1 (value equality) | 343 | 232 | 59.7% |
| Gate 2 (capability) | 337 | 6 | 58.6% (of all) |
| Gate 3 (subsystem) | 254 | 83 | 44.2% |

So roughly **45% of matches reach a valid catalog candidate under v2's rules as the catalog stands today**. The rest split into: 232 pure new-token candidates, 83 cross-subsystem drift (value exists, wrong subsystem), 6 capability mismatch.

## 1.3 Named-colors audit

Exactly **one** named color appears across all 584 matches:

| Raw | Hex | Count | Example |
|---|---|---:|---|
| `black` | `#000000` | 1 | `ui/src/styles/app.css:2243` (sample-selector, bg) |

The v2 normalizer's named-color table needs to cover `black`. I'll include a sensible superset (the ~30 most common CSS named colors) defensively, but only `black` is load-bearing in this audit.

## 1.4 Drift findings

### Sampler LFO color/bg tokens — VALUE SWAP + MIS-NAMED (catalog bug beyond Q1's original scope)

Catalog (lines 400–405):
- `--theme-sampler-lfo-color-pitch` = `#33CED6` (teal)
- `--theme-sampler-lfo-color-filter` = `#9B59B6` (purple)
- `--theme-sampler-lfo-color-volume` = `#E8A020` (orange)
- `--theme-sampler-lfo-bg-pitch` = `#1E3A3C` (dark teal)
- `--theme-sampler-lfo-bg-filter` = `#2A1E3A` (dark purple)
- `--theme-sampler-lfo-bg-volume` = `#3C2E1A` (dark orange)

Component (`LfoSection.jsx:5-6`):
```js
const LFO_COLORS = { vol: '#33CED6', pan: '#9B59B6', pitch: '#E8A020' }
const LFO_BG     = { vol: '#1E3A3C', pan: '#2A1E3A', pitch: '#3C2E1A' }
```

Catalog has: (a) `pitch`↔`volume` **values swapped** (pitch should be orange, volume should be teal) and (b) `-filter` named incorrectly — the component has no "filter" LFO tab, it has a `pan` tab with the purple values.

### Sampler envelope/lfo fills — 0.08 value drift

- `--theme-sampler-envelope-fill` = `rgba(51,206,214,0.08)` in catalog. Component uses `rgba(51,206,214,0.35)` at `SamplerWaveform.jsx:110` (envelope fill). **Drift confirmed — repoint per Q2.**
- `--theme-sampler-lfo-fill` = `rgba(51,206,214,0.08)` in catalog. Value appears 5× in code but never in sampler subsystem (gap-scan evidence). Likely also drift; actual LFO canvas fill unclear without reading `LfoWaveformCanvas.jsx` drawing code.

### Shadow-match classifier design gap (not a catalog change)

Many Gate-1 failures for shadow-role matches are because the scanner extracted just `rgba(0,0,0,0.5)` from a `box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5)` rule — but the catalog's `--theme-fx-plugin-shadow` holds the full compound `0 8px 32px rgba(0, 0, 0, 0.5)`. Gate 1 fails because `rgba(0,0,0,0.5) ≠ 0 8px 32px rgba(0,0,0,0.5)`.

**Classifier design decision to record in Step 3:** when `elementRole === 'shadow'` and `matchedText` starts with `rgba(...)`, reconstruct the full `box-shadow`/`text-shadow` property value from `surroundingContext` and compare against shadow-valued tokens' full strings. Without this, every shadow embedded-rgba goes to NO-FIT even though the catalog covers it.

### Cross-subsystem drift in FX subsystems — shared opacity values used as subsystem-specific tokens

Catalog has ~20 different tokens across `stock-effects.*`, `sampler`, `piano-roll`, `node-editor`, `timeline` that resolve to the same ~5 rgba values (`rgba(51,206,214,{0.08,0.12,0.18,0.30})` and `rgba(255,255,255,{0.03,0.05,0.06,0.10,0.25})`). Components use these values freely across subsystems, which is why Gate 3 kicks out 83 matches. This is the same "shared opacity" pattern that Q3 identifies for waveform values.

## 1.5 New-token candidates (zero-candidate Gate 1 gaps)

Full gap list has **219 unique (subsystem, value, role) groups** covering **321 matches**. Top-frequency zero-candidate values, grouped by proposed token:

### High-frequency universal gaps
| Value | Role | Count | Proposed token |
|---|---|---:|---|
| `#ffffff` | color | 22 (timeline 6, stock-fx 4, piano-roll 3, grid 3, sampler 2, node-editor 2, pattern-list 2) | `--theme-fg-inverse` (base/universal) — NEW base token |
| `#000000` | color | 5 (timeline 3, syllable 2) | Assign to existing `--theme-sampler-key-black` BUT lift to universal, OR new `--theme-black-ink` |
| `rgba(255,255,255,0.05)` | rgba (bg) | 19 across 5 FX subsystems + time | `--theme-fx-surface-tint-subtle` (stock-effects.shared, cross-FX) |
| `rgba(0,0,0,0.5)` | shadow rgba | ~10 across FX subsystems | resolved via classifier shadow-compound logic — most go to existing `--theme-fx-plugin-shadow` |
| `rgba(0,0,0,0.6)` | shadow rgba | 5 dialogs-modals | resolved via classifier shadow-compound logic — goes to existing `--theme-chrome-shadow` / `--theme-modal-shadow` |

### Medium-frequency genuine new tokens
| Value | Subsystem | Count | Proposed token |
|---|---|---:|---|
| `#0a0a10` | sampler | 10 | Reuse `--theme-pianoroll-key-black-bg` cross-subsystem via new shared subsystem, OR add `--theme-sampler-canvas-deep-bg` |
| `#0d0d14` | dialogs-modals (8), piano-roll (2) | 10 | `--theme-dialog-surface-bg` or shared `--theme-bg-deep` (darker variant of bg-primary) |
| `#6aa9ff` | pattern-list (2), timeline (drag preview evidence earlier) | ≥3 | `--theme-pattern-accent-default` + share with `--theme-timeline-drag-preview-default` (as Krasen expected) |
| `#1b1b24` | syllable-splitter | 1+ (bg constant, used on every canvas paint) | `--theme-syllable-splitter-canvas-bg` |
| `rgba(51,206,214,0.06)` | syllable-splitter | 1+ | `--theme-syllable-section-alt` |
| `rgba(51,206,214,0.07)` | sampler | 1 (SamplerWaveform.jsx:135) | `--theme-waveform-subtle-bg` or derivation from waveform-shared |
| `rgba(51,206,214,0.30)` | sampler gradient-stop | 2 | `--theme-waveform-gradient-stop` or ref waveform-shared |
| `rgba(51,206,214,0)` | sampler gradient-stop | 2 | `transparent` normalizer entry OR new `--theme-waveform-gradient-fade` |
| `rgba(0,0,0,0.35)` | sampler gradient-stop | 2 | `--theme-waveform-gradient-dark` or similar |
| `#ff8a8a`, `#ff9aa2`, `#ffa5b5`, `#ff9500` | labels-ish (sample-selector, grid, dialogs) | 1–2 each | Investigate — likely belong in `labels` subsystem or as notification-color tokens |
| `#6bcb77`, `#2ea8a0`, `#ff8c00`, `#4ecdc4`, `#4d96ff` | stock-effects.dynamics (SmartBalancePanel) | 1–2 each | Smart Balance–specific data-encoding colors — need per-channel tokens |

### Low-frequency one-off gaps (47 remaining groups, each x1)

Mostly local decorative values in `SmartBalancePanel.jsx`, `pattern-list`, `dialogs-modals`. I'll enumerate the full 219 groups in the change list only if you want a token per gap. Default proposal: leave one-off x1 gaps as NO-FIT and resolve via component-level inlining decisions post-migration.

---

# Combined Change Proposal (review per-change)

Legend: `[A]` approve as-stated · `[M]` approve with modification · `[R]` reject/defer.

## Group A — Sampler LFO swap + rename (Q1-driven, expanded to cover discovered catalog bug)

**A1.** Fix value swap in `--theme-sampler-lfo-color-pitch` and `--theme-sampler-lfo-color-volume`:
- `--theme-sampler-lfo-color-pitch` : `#33CED6` → **`#E8A020`** (component ground truth)
- `--theme-sampler-lfo-color-volume` : `#E8A020` → **`#33CED6`** (component ground truth)

**A2.** Rename `--theme-sampler-lfo-color-filter` → `--theme-sampler-lfo-color-pan` (keep value `#9B59B6`). Component has a `pan` tab, not a `filter` tab.

**A3.** Symmetric fix on LFO backgrounds (same swap pattern):
- `--theme-sampler-lfo-bg-pitch` : `#1E3A3C` → **`#3C2E1A`**
- `--theme-sampler-lfo-bg-volume` : `#3C2E1A` → **`#1E3A3C`**
- Rename `--theme-sampler-lfo-bg-filter` → `--theme-sampler-lfo-bg-pan` (keep value `#2A1E3A`)

**A4.** Classifier routes the sampler envelope-tab callsites at `SamplerPanel.jsx:642,650,684` to the same `--theme-sampler-lfo-color-*` tokens (smallest-diff; Q1 explicitly said "Only add env-color-* if env differs from LFO in ways that matter"). **No new `--theme-sampler-env-color-*` tokens.**

## Group B — Waveform-fill drift repoints (Q2-driven)

**B1.** Repoint `--theme-sampler-envelope-fill` : `rgba(51,206,214,0.08)` → **`rgba(51,206,214,0.35)`** (component ground truth at `SamplerWaveform.jsx:110`).

**B2.** `--theme-sampler-lfo-fill` : currently `rgba(51,206,214,0.08)`. Gap-scan shows this value is never used in sampler subsystem. Proposal: keep value at `rgba(51,206,214,0.08)` pending a read of `LfoWaveformCanvas.jsx` rendering code — if LFO canvas uses 0.08, leave alone; if LFO uses 0.35 or other, repoint. **Recommendation: investigate as part of this change (add 1 extra read); likely repoint to ref the new `--theme-waveform-envelope-fill`.**

## Group C — Shared `waveform-shared` subsystem (Q3-driven)

**C1.** Add new subsystem entry to `SUBSYSTEMS`:
```ts
{ key: 'waveform-shared', label: 'Waveform (shared)', section: '3.4.x', ... }
```

**C2.** Rename + move to new subsystem:
- `--theme-lipsync-playback-indicator` (`rgba(51,206,214,0.35)`) → **`--theme-waveform-envelope-fill`** (subsystem: `waveform-shared`)
- `--theme-lipsync-scroll-thumb` (`rgba(51,206,214,0.55)`) → **`--theme-waveform-rms-body`** (subsystem: `waveform-shared`)

**C3. RECOMMENDATION on scope mechanism** — you asked me to surface a choice here:

- **Option C3.a — extend `UNIVERSAL_SUBSYSTEMS`** to `{base, derived, borders, text, semantic, labels, waveform-shared}`. Minimal code, but makes every subsystem's classifier "see" waveform-shared. Risk: the looseness is hard to audit; a future waveform-shared token could accidentally capture a non-waveform match in a component file that happens to use the same rgba.
- **Option C3.b — per-token `crossSubsystem: true` flag** on the waveform-shared tokens (and future cross-cutting tokens), respected by Gate 3. Narrower: only tokens explicitly marked cross-subsystem bypass the subsystem check; the subsystem itself stays scoped normally.

**My recommendation: Option C3.b.** Waveform rendering today is sampler + syllable-splitter + lip-sync-picker, but there's already evidence that *other* rgba-teal opacity values cross FX subsystems without being waveform-semantics. If C3.a is adopted and we later need a different cross-subsystem shared family (e.g., "fx-shared-surface-tints"), we'd be back here widening UNIVERSAL again. The flag model generalizes cleanly and keeps audit surface explicit.

Concretely under C3.b:
- Add `crossSubsystem: true` to `--theme-waveform-envelope-fill`, `--theme-waveform-rms-body` (and any other new waveform-shared tokens from this wave).
- Gate 3 filter becomes: keep token if `t.subsystem === match.subsystem OR t.subsystem in UNIVERSAL_SUBSYSTEMS OR t.crossSubsystem === true`.
- `waveform-shared` stays out of `UNIVERSAL_SUBSYSTEMS`.

**C4.** Repoint sampler + syllable tokens to the new waveform-shared tokens:
- `--theme-sampler-envelope-fill` — after B1, additionally convert to `derived-var` ref to `--theme-waveform-envelope-fill`. Or leave as explicit `rgba(51,206,214,0.35)`. **Recommendation: `derived-var` ref — single source of truth for the 0.35 teal fill; future themes override waveform-shared once and sampler + syllable + lipsync all follow.**
- If `--theme-sampler-lfo-fill` ends up at 0.35 per B2: also make it a ref.

**C5.** Amend spec:
- §3.4.21 (Lip Sync Picker): remove `--theme-lipsync-playback-indicator` and `--theme-lipsync-scroll-thumb` from the enumeration; add a note "waveform envelope + RMS fills now live in `waveform-shared` — see §3.4.N". Lip-sync keeps subsystem-specific tokens that aren't shared (selection fill, in/out markers, handles, etc.).
- Add new §3.4.N "Waveform (shared)" subsection listing `--theme-waveform-envelope-fill` and `--theme-waveform-rms-body` with the cross-subsystem flag documented.
- If C3.b is chosen: add a one-paragraph note in §3.5 explaining the `crossSubsystem` flag and its Gate 3 semantics.

## Group D — Confirmed NEW tokens from original Q-prompt list

**D1.** `--theme-syllable-splitter-bg` = `#1b1b24` — subsystem `syllable-splitter`, kind `color`, capability `any`. Default ships explicit. Used at `SyllableSplitter.jsx:10` (canvas bg constant).

**D2.** `--theme-syllable-section-alt` = `rgba(51, 206, 214, 0.06)` — subsystem `syllable-splitter`, kind `rgba`, capability `any`. Default ships explicit. Used at `SyllableSplitter.jsx:15`.

**D3.** `--theme-timeline-drag-preview-default` = `#6aa9ff` — subsystem `timeline`, kind `color`, capability `solid`. Default ships explicit. Used at `TimelineView.jsx:1446` and `PatternListPanel.jsx:18` and `app.css:813` (pattern-list hover border — SHARED with pattern-list).
- **Sub-decision**: since pattern-list also uses `#6aa9ff`, either (a) rename to `--theme-drag-preview-default` with `crossSubsystem: true` and make it usable by both, or (b) add a separate `--theme-pattern-list-accent` at the same value and have two tokens.
- **Recommendation**: (a) — use a shared token with `crossSubsystem: true` (same pattern as Group C).

## Group E — NEW universal/shared catalog additions (from gap scan)

Only the high-frequency ones; you can reject to keep migration surface small.

**E1.** `--theme-fg-inverse` = `#ffffff` — subsystem `base`, kind `color`. Rationale: 22 matches across 8 subsystems use pure white for canvas strokes/text-on-dark/etc.; currently no universal token covers it. `--theme-fx-drag-indicator` = `#FFFFFF` is semantically specific.

**E2.** `--theme-fx-surface-tint-subtle` = `rgba(255, 255, 255, 0.05)` — subsystem `stock-effects.shared`, kind `rgba`, with `crossSubsystem: true`. 19 sites across 5 FX subsystems + time. Rationale: standard "inset panel subtle bg" pattern used uniformly across FX UIs.

**E3.** `--theme-bg-deep` = `#0d0d14` — subsystem `base` (darker than `--theme-bg-primary` = `#0A0A0F`? — actually the ordering is weird; `#0d0d14` > `#0A0A0F` in L*). Subsystem `derived` may be better if we express as a formula. 10 sites (dialogs-modals + piano-roll). **Recommendation: explicit, subsystem `base`, name `--theme-bg-dialog` or `--theme-bg-panel-inset` depending on intended semantics. Pending your preference.**

## Group F — Shadow-compound classifier handling (no catalog change; v2 logic)

**F1.** When `elementRole === 'shadow'` and `matchedText` is a bare `rgba(...)`, the v2 classifier reconstructs the full `box-shadow`/`text-shadow` property value from `surroundingContext` (the closing parenthesis-bounded declaration) and compares against shadow-valued tokens' full strings via normalize. Resolves ~10 shadow-color Gate-1 misses without any catalog edit.

## Group G — Deferred (flagged, not proposed as changes this wave)

**G1.** Cross-subsystem rgba opacity family in stock-effects (0.08, 0.12, 0.18, 0.30). These are the same pattern as waveform-shared but for FX UIs. A future `fx-shared` subsystem could consolidate them. **Recommendation: defer to a later pass; do not add FX-shared tokens in this wave. Document in gaps.md as a future cleanup.**

**G2.** Per-data-color tokens in `SmartBalancePanel.jsx` (`#6bcb77`, `#2ea8a0`, `#ff8c00`, `#4ecdc4`, `#4d96ff`). These look like data-encoding colors (channels, stereo-field tints). Proper naming requires product knowledge. **Defer; component author should assign.**

**G3.** One-off low-frequency gaps (47 groups × 1 occurrence each). Likely local decorative. Defer; accept as NO-FIT and flag for inline cleanup later.

---

## Summary counts (if all of A–F approved as-recommended)

- **Drift fixes (in-place value changes)**: A1 (2 tokens), A3 (2 tokens), B1 (1), optionally B2 (1) → 5–6
- **Renames**: A2 (1), A3 (1), C2 (2) → 4
- **New tokens**: C1 (subsystem), C2+C4 (2 + refs), D1, D2, D3, E1, E2, E3 → ~8 new tokens + 1 subsystem + 2 refs
- **Retirements**: 0 (all drifts repointed or renamed; no orphans)
- **Spec amendments**: §3.4.21 (edit), §3.4.N waveform-shared (add), §3.5 crossSubsystem flag note (add)
- **Classifier behavior (F1)**: shadow-compound reconstruction — documented in Step 3

## Awaiting catalog-change approval.

Reply per group (A1, A2, A3, A4, B1, B2, C1, C2, C3 [pick C3.a or C3.b], C4, C5, D1, D2, D3 [and D3 sub-decision], E1, E2, E3, F1) with `[A]`, `[M modification-note]`, or `[R]`. I'll wait before writing anything.