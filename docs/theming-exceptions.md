# Theming Exceptions — Phase 0

Matches skipped during Phase 0 migration with explicit rationale.
These are not oversights. Each was reviewed and dispositioned by Krasen.

---

## EX-001 · EX-002 · EX-003 — box-shadow geometry mismatch

**Subsystem:** stock-effects.shared  
**Files:**
- `ui/src/styles/app.css:5956` — `.compressor-panel`
- `ui/src/styles/app.css:6101` — `.limiter-panel`
- `ui/src/styles/app.css:6420` — `.ws-panel`

**matchedText:** `rgba(0,0,0,0.5)` (inside `box-shadow` shorthand)  
**Proposed token:** `--theme-fx-plugin-shadow`  
**Audit tier:** HIGH (misclassified — should have been NO-FIT)

**Root cause:** The audit matched only the `rgba` color fragment.
The full `box-shadow` shorthands in these three panels are
`0 -4px 24px rgba(0,0,0,0.5)` — upward shadow, 24px blur.
The token `--theme-fx-plugin-shadow` encodes
`0 8px 32px rgba(0,0,0,0.5)` — downward shadow, 32px blur.
Substituting the token would reverse shadow direction and resize blur.

**Disposition:** NO-FIT. Phase 1 action — add a second shadow token
`--theme-fx-plugin-shadow-top` encoding the upward geometry, then
migrate these three callsites.

---

## EX-004 · EX-005 — BANDS array partial-token inconsistency

**Subsystem:** stock-effects.dynamics  
**File:** `ui/src/components/mixer/SmartBalancePanel.jsx:10–11`

**matchedText:**
- Line 10: `'#FF6B6B'` (SUB band)
- Line 11: `'#FFD93D'` (LOW-MID band)

**Proposed tokens:** `--theme-label-kick`, `--theme-label-hihat`  
**Audit tier:** HIGH + MEDIUM (misclassified — architectural no-fit)

**Root cause:** The `BANDS` array is a static module-level constant.
`tokenValue()` called at module init time returns empty string because
ThemeProvider has not yet mounted. Additionally, the two sibling entries
(`#6BCB77` UPPER-MID, `#4D96FF` AIR) are NO-FIT with no catalog tokens,
making partial replacement leave the array permanently mixed — two
token-resolved entries and two hardcoded literals feeding the same
canvas draw loop via `band.color`.

**Disposition:** NO-FIT. Phase 1 action — add catalog tokens for all
four BANDS colors, then refactor the draw loop to call
`tokenValue()` inline at draw time instead of reading from the
static array.

---

## Phase 0 closure adjustment

Target in spec §11: 337 replacements (185H + 113M + 39L).  
Actual: **332 replacements** (181H + 112M + 39L).  
Delta: 5 matches dispositioned as architectural/geometric NO-FIT above.  
The ≤247 residual target for the Step 4 audit re-run is adjusted to **252**.

All other Phase 0 acceptance criteria unchanged.
