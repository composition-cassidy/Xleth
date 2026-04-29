# Xleth per-track video flip system v2 — architecture spec

**Version:** 1.0 (LOCKED — diagnostic-informed; ready for Codex)
**Status:** approved for implementation
**Owner:** Krasen
**Scope:** Replaces the current 4-option "Video Flip" track context-menu feature with a state-machine-based flipping system supporting up to 12 flip states and 4 configurable trigger modifiers. Per-track only. No per-clip override in v1. No per-state visual effects in v1.
**Implementation target:** Codex.
**Diagnostic source:** `xleth-flip-v2-diagnostic-prompt.md` (Claude Code, completed).
**Companion docs:** `xleth-windowing-spec.md`, `xleth-theming-spec.md`.

---

## 0. Why this exists

The current flipping system (None / Horizontal (Even) / Clockwise / Counter-Clockwise) is one static rule applied per cell render via a per-track ordinal counter. Sparta remixers want compositional flipping: 2–12 ordered visual states cycled through under configurable trigger logic, fully predictable across pattern loops and exports.

v2 reframes flipping as a **per-track deterministic state machine** computed at event-build time and baked into each `VideoEvent`. State is a pure function of position-ordinal on the track and the chosen modifier rule. No runtime state. The current 4 options auto-migrate cleanly.

---

## 1. Locked decisions

| Area | Decision |
|---|---|
| Scope | Per-track only. No per-clip override in v1. |
| Max states per track | 12. |
| Anchor | **Position-ordinal on the track.** State at any clip/note is `f(ordinal, modifier, states)`, computed at event-build time. Resolver runs inside `rebuildVideoEventsFromClips`. |
| Runtime state | None. State is baked into `VideoEvent.stateIndex` at event-build time. No runtime walker, no per-frame cache, no transport-stop reset (nothing to reset). |
| First mono-trigger behavior | No advance. State at ordinal 0 = `startStateIndex`. |
| Polyphony rule | A chord event (≥2 onsets sharing the same tick on the same track) is transparent to the modifier: renders the current state but does not advance. Only mono onsets are trigger events. For `new-note`, "previous pitch" looks back to the last mono onset, skipping past chords. |
| Pattern loop boundary | No reset. Each loop iteration generates fresh `VideoEvent`s with successive ordinals; state walks naturally. |
| Region boundary (clip track) | No reset. Same-track regions share one ordinal stream. |
| Cycle mode | Wrap only. Users replicate ping-pong by enumerating states (e.g. `[normal, h, v, h]`). |
| Determinism | Mandatory. Inherits from existing event-build architecture: same project + same playhead = same `VideoEvent` list = same render in preview AND export. Single code path confirmed by diagnostic. |
| Per-state visual FX | Deferred to v2. Schema accommodates future addition without breaking change. |
| Cell-jump trigger ("if G5 → next cell") | Out of v1. Different feature class. |
| Modifier count in v1 | 4: `every-note`, `new-note`, `specific-pitches`, `every-n-beats`. |
| Trigger source — pattern track | Each MIDI note onset on the piano roll. Mono-vs-chord = same/different onset tick on the same track. |
| Trigger source — clip track | Each clip onset on the timeline. Pitch = clip's pitch-shift value (semitones from source). Chord rule applies if ≥2 clips share an onset tick. |
| `globalNoteIndex` instability | Inherited from existing system. Inserting a clip mid-track shifts flip states of all later clips. Accepted limitation. Mitigations deferred to v2 (per-clip state lock or phase offset). |
| UI location | Track context menu's "Video Flip" entry → opens an inline Track Flip Properties popover. Will move into Track Properties tab once the windowing spec ships. |

---

## 2. Glossary

- **State**: one entry in the ordered cycle. Has an orientation and an optional label.
- **State index**: integer 0..N−1 identifying the active state for a given event.
- **Ordinal**: zero-based position of the trigger event among all qualifying events on the track, in timeline order. The same integer the existing `globalNoteIndex` represents.
- **Trigger event**: a single mono-note onset (pattern track) or a single mono-clip onset (clip track). Chord events are not trigger events.
- **Modifier**: rule that decides whether each trigger event advances the state.
- **Resolver**: pure function that takes the modifier, the event list, and config; returns a `stateIndex` per event. Runs at event-build time.

---

## 3. Data model

### 3.1 `VideoFlipConfig` (per-track, persisted)

```ts
interface VideoFlipConfig {
  enabled: boolean;                  // master on/off; false = single identity render, no resolver work
  states: VideoFlipState[];          // 1..12
  modifier: VideoFlipModifier;
  startStateIndex: number;           // 0..states.length-1; default 0
}
```

No reset flags. No cycle-mode field (wrap implicit). No FX field (v2).

Default for a new track:
```ts
{
  enabled: false,
  states: [{ id: 's0', orientation: 'none' }],
  modifier: { type: 'every-note', config: {} },
  startStateIndex: 0,
}
```

### 3.2 `VideoFlipState`

```ts
interface VideoFlipState {
  id: string;                        // stable identifier
  orientation: Orientation;
  label?: string;                    // optional user-facing name
}

type Orientation =
  | 'none'                           // identity
  | 'horizontal'                     // mirror left-right (UV: x = 1 - x)
  | 'vertical'                       // mirror up-down  (UV: y = 1 - y)
  | 'rotate-180'                     // half turn       (UV: x = 1 - x; y = 1 - y)
  | 'rotate-90-cw'                   // quarter turn CW  (UV: (u,v) → (v, 1-u))
  | 'rotate-90-ccw';                 // quarter turn CCW (UV: (u,v) → (1-v, u))
```

Six orientations. Diagonal mirrors (the other two D₄ elements) are deferred — not used in any practical Sparta case I've seen.

### 3.3 `VideoFlipModifier`

```ts
type VideoFlipModifier =
  | { type: 'every-note';        config: {} }
  | { type: 'new-note';          config: {} }
  | { type: 'specific-pitches';  config: { pitches: number[] } }   // MIDI note numbers
  | { type: 'every-n-beats';     config: { n: number; subdivision: 'beat' | 'bar' } };
```

#### 3.3.1 `every-note`
Every mono trigger event advances state by 1. With `startStateIndex: s` and N states, ordinal `k`'s state is `(s + k) mod N` (because first trigger doesn't advance, but all subsequent do — net result is identical to modulo-indexing).

#### 3.3.2 `new-note`
Advance only when the current mono trigger's pitch differs from the previous mono trigger's pitch.
- First mono trigger of track: no advance.
- Chord events: transparent, do not update "previous mono pitch" memory.

#### 3.3.3 `specific-pitches`
Advance only when the mono trigger's pitch is in the configured `pitches` whitelist.
- Whitelisted-pitch always advances, including the first one. (Whitelist semantics override first-trigger rule — a whitelist that ignores its first match feels broken.)
- Non-whitelisted mono triggers render the current state without advancing.
- Chord events transparent regardless of contained pitches.

#### 3.3.4 `every-n-beats`
Advance every N beats (or N bars), pitch-blind, note-blind. State at any tick T = `((floor((T - trackAnchorTick) / ticksPerUnit / n) + startStateIndex) mod numStates)`.

`trackAnchorTick` for v1 = `0` (project start). This is the only modifier that uses tick math instead of event ordinals.

> **Engineering note.** This is the only v1 modifier requiring infrastructure not present in the existing video event builder. Cost is bounded — the audio engine already knows `ticksPerBeat` from the project tempo. Codex needs to expose tempo-to-tick math to `rebuildVideoEventsFromClips` for video event timing, then apply the modulo. Estimated 2–4 hours of plumbing, not a multi-day item.

### 3.4 Modifier roadmap (v2, deferred)

| Modifier | Semantics |
|---|---|
| `velocity-gate` | Advance only when velocity ≥ threshold. |
| `pitch-direction` | Rising melodic motion advances forward; falling advances backward. |
| `random-with-seed` | Random advance per mono trigger; reproducible because seed is stored. |
| `manual-automation` | Dedicated automation lane drives state index directly. |
| `probability` | N% chance to advance per mono trigger. |
| `chained` | Combine two modifiers ("every note, but reset on G5"). |

> Removed from v0.2's roadmap: `pattern-position-modulo` is mathematically identical to `every-note` under the position-ordinal anchor. Not a separate modifier.

### 3.5 Backward compatibility (v1 → v2 migration)

All four legacy values map cleanly to discrete-state configs. Diagnostic confirmed `Clockwise` / `CounterClockwise` are 4-phase axis-flip cycles, not rotation animations.

| Legacy value | v2 config |
|---|---|
| `None` | `{ enabled: false, states: [{none}], modifier: every-note, startStateIndex: 0 }` |
| `HorizontalEven` | `{ enabled: true, states: [{none}, {horizontal}], modifier: every-note, startStateIndex: 1 }` |
| `Clockwise` | `{ enabled: true, states: [{none}, {vertical}, {rotate-180}, {horizontal}], modifier: every-note, startStateIndex: 0 }` |
| `CounterClockwise` | `{ enabled: true, states: [{none}, {horizontal}, {rotate-180}, {vertical}], modifier: every-note, startStateIndex: 0 }` |

**Verification:** for ordinals 0..7, each of the above produces UV transforms byte-identical to the existing pixel shader output for the corresponding legacy mode. This is acceptance test #6 (Section 7.6).

`HorizontalEven` migration uses `startStateIndex: 1` because the legacy shader flips on `% 2 == 0` (ordinal 0 is flipped). State index 1 = horizontal. With `every-note`: ordinal 0 → state 1 (horizontal, no advance), ordinal 1 → state 0 (none, advance + wrap), ordinal 2 → state 1 (horizontal). Matches.

Project file format version bumps. Old field (`videoFlipMode: string`) read once at load, transformed to new schema, written back on save. After save, old field is gone.

---

## 4. State resolution algorithm

### 4.1 Where it runs

Inside `OfflineRenderer::rebuildVideoEventsFromClips()` (and the equivalent pattern-track loop), immediately after `globalNoteIndex` is assigned. For each `VideoEvent`, the resolver computes `stateIndex` and the orientation enum, both stored on the event.

```cpp
// pseudocode in event-build loop
int ordinal = (eventIsChord || eventIsNonWhitelistMatch) ? -1 : monoOrdinalCounter++;
int stateIdx = resolveStateIndex(track.flipConfig, ordinal, event, monoHistory, currentTick, ticksPerBeat);
ev.stateIndex   = stateIdx;
ev.orientation  = track.flipConfig.states[stateIdx].orientation;
ev.globalNoteIndex = totalOrdinalCounter++;  // existing field, still useful for analytics / future modifiers
```

### 4.2 Walking algorithm (pseudocode)

```ts
function resolveStateIndex(
  config: VideoFlipConfig,
  monoTriggerEvents: TriggerEvent[],     // mono only, ordered ascending tick; chord events filtered out upstream
  ticksPerBeat: number,
): number[] {                             // returns one stateIdx per mono event
  if (!config.enabled || config.states.length === 1) {
    return monoTriggerEvents.map(() => 0);
  }

  // Clock-driven modifier short-circuits — no event walk needed
  if (config.modifier.type === 'every-n-beats') {
    return monoTriggerEvents.map(ev => resolveByBeats(config, ev.tick, ticksPerBeat));
  }

  const result: number[] = [];
  let stateIdx = config.startStateIndex;
  let previousMonoPitch: number | null = null;

  for (const event of monoTriggerEvents) {
    // First trigger never advances (except for specific-pitches whitelist match)
    const isFirst = previousMonoPitch === null;
    const advance = !isFirst && shouldAdvance(config.modifier, event, previousMonoPitch)
                 || (isFirst && config.modifier.type === 'specific-pitches' && config.modifier.config.pitches.includes(event.pitch));

    if (advance) {
      stateIdx = (stateIdx + 1) % config.states.length;
    }
    result.push(stateIdx);
    previousMonoPitch = event.pitch;
  }

  return result;
}
```

The function is called **once per event-build pass** (not per frame, not per draw call). Its output is consumed inline as each `VideoEvent` is constructed.

### 4.3 Mono / chord event filtering

Done upstream, in the same loop that assigns `globalNoteIndex` today. For each onset tick on a track:
- If exactly one note/clip onset on that tick → mono event (passed to resolver).
- If ≥2 → chord event (skipped by resolver; its `stateIndex` = the state of the most recent mono event before it, or `startStateIndex` if no preceding mono event).

Mono ordinal counter advances only on mono events. Chord events do NOT advance the mono ordinal.

### 4.4 Edge-case rule summary

| Situation | Behavior |
|---|---|
| First mono trigger on track | No advance (`every-note`, `new-note`); does advance for `specific-pitches` if whitelisted; clock-driven for `every-n-beats`. |
| Chord event | Renders state of most recent prior mono event (or `startStateIndex` if none). Does not advance. Does not update "previous mono pitch". |
| Mono trigger between two chords | Modifier compares against the last mono pitch, ignoring intervening chords. |
| Pattern loop iteration | No reset. Each iteration generates fresh `VideoEvent`s with successive mono ordinals. |
| Region boundary (clip track) | No reset. Same-track regions share one ordinal stream. |
| Transport stop / play | No effect on `stateIndex` — it's baked into `VideoEvent` at build time. |
| Playhead seek | No effect — same `VideoEvent` list, same render. |
| Modifier or state list edit | Triggers `rebuildVideoEventsFromClips` (existing mechanism). All `stateIndex` values recompute. |
| Inserting a clip mid-track | Renumbers all later mono ordinals. All later `stateIndex` values shift. **Inherited limitation; documented.** |

---

## 5. Engine integration

### 5.1 `VideoEvent` schema additions

```cpp
struct VideoEvent {
    // ... existing fields ...
    int globalNoteIndex;        // existing — total ordinal including chords
    int monoOrdinal;            // NEW — mono-only ordinal, -1 for chord events
    int stateIndex;             // NEW — resolved state index (0..numStates-1)
    Orientation orientation;    // NEW — flat enum, what the shader consumes
};
```

The shader can read either `stateIndex` (and look up orientation in a constant array) or `orientation` directly. Locking: shader reads `orientation` directly. State index isn't needed at the GPU.

### 5.2 Compositor consumption

```cpp
// in GridCompositor::drawCell
CellConstants cb;
cb.cellRect = ...;
cb.opacity  = ev.opacity;
cb.orientation = static_cast<int>(ev.orientation);   // 0..5
cb.cornerRadius = ev.cornerRadius;
// NOTE: drop legacy flipMode + globalNoteIndex from constant buffer
//       (kept on VideoEvent for debug/analytics, but not sent to GPU)
```

### 5.3 Shader rewrite (`GridComposite.hlsl`)

Replace the current `flipMode + globalNoteIndex` switch with an `orientation` switch:

```hlsl
cbuffer CellConstants : register(b0)
{
    float4 cellRect;
    float  opacity;
    int    orientation;     // 0=none, 1=h, 2=v, 3=rot180, 4=rot90cw, 5=rot90ccw
    float  cornerRadius;
};

// in pixel shader
float2 uv = localUV;
if      (orientation == 1) uv.x = 1.0f - uv.x;                              // horizontal
else if (orientation == 2) uv.y = 1.0f - uv.y;                              // vertical
else if (orientation == 3) { uv.x = 1.0f - uv.x; uv.y = 1.0f - uv.y; }      // rotate-180
else if (orientation == 4) uv = float2(localUV.y, 1.0f - localUV.x);        // rotate-90 CW
else if (orientation == 5) uv = float2(1.0f - localUV.y, localUV.x);        // rotate-90 CCW
// orientation == 0: identity
```

Acceptance test: for migrated legacy projects, the new shader's output is byte-identical to the old shader's output at every ordinal. Diagnostic confirmed legacy phase tables; migration tables in 3.5 are constructed to satisfy this.

### 5.4 IPC contract

New IPC: `track:setVideoFlipConfig`. Renderer → main → engine. Payload: `{ trackId: number, config: VideoFlipConfig }`. Engine receives it, persists, calls `rebuildVideoEventsFromClips()` on the track, next render uses new state. The existing single-mode IPC (`xleth:timeline:setVideoFlipMode`) is removed in v1; legacy clients won't exist post-migration.

For live edits during drag (e.g. modifier `n` value), use the existing direct-atomic-write path so renderer can preview without IPC round-trip per drag tick. Single IPC commit on mouseup.

### 5.5 Determinism guarantees

Inherited free from existing architecture (diagnostic confirmed):
- `rebuildVideoEventsFromClips` runs the same way for preview and export.
- `VideoEvent.stateIndex` is deterministic given the same project state.
- Same project + same playhead = same render. Period.

Test harness must verify, on ≥5 representative projects:
1. RT preview frame at tick T = offline export frame at tick T (pixel-identical).
2. Re-export from a clean state produces byte-identical files (twice in a row).
3. Migrated legacy projects render byte-identical to pre-migration.

---

## 6. UI architecture

### 6.1 Entry point

The track context menu's "Video Flip" entry no longer opens a 4-option submenu. It opens an inline **Track Flip Properties** popover anchored to the track header. Existing `TimelineView.jsx:1390–1399` block is replaced.

### 6.2 Panel layout

Top to bottom:

1. **Master toggle.** "Video Flip: ☐ Enabled". Off by default. When off, rest of panel greyed out.
2. **Flipping Style row.** Horizontal scroll of state cards (1..12). Each card:
   - Orientation visual (figure with arrow showing the transform).
   - Click → orientation picker.
   - Right-click or hover-X → delete (disabled when ≥1 state remains).
   - Drag → reorder states. Reordering automatically renumbers `startStateIndex` to point at the same card.
   - Right end: `+` button to add. Disabled at 12 states.
3. **Modifier section.** Dropdown: `[every-note | new-note | specific-pitches | every-n-beats]`. Conditional rows:
   - `specific-pitches`: pitch-input row (free-form note text or piano keyboard mini-widget).
   - `every-n-beats`: `n` stepper (integer 1..32) + subdivision dropdown (`beat | bar`).
4. **Start state.** Number stepper, 1..N (1-indexed in UI), maps to `startStateIndex` (0-indexed).
5. **Live preview hint.** Read-only strip showing the next 8 mono trigger events on this track (from current playhead) and the resolved state for each. Format: `D5 → 1 | D5 → 1 | D#5 → 2 | D5 → 1 | …` with mini orientation icons.

No cycle-mode dropdown. No reset checkboxes. No FX assignment row.

### 6.3 Theme integration

All chrome reads `xleth-theming-spec.md` tokens. Active state card highlight = `--theme-accent` during playback. Inactive cards = `--theme-bg-elevated`.

### 6.4 Keyboard

Panel-scoped:
- `Tab` between state cards.
- `Delete` removes focused card (≥1 state required).
- `Enter` opens orientation picker for focused card.

No global F-key.

---

## 7. Worked examples (acceptance tests)

### 7.1 Krasen's example — `new-note` modifier

States `[{none}, {horizontal}]`, `new-note`, `startStateIndex: 0`. Pattern: `D5, D5, D#5, D5, D4, C5, C5` (all mono).

| # | Pitch | Prev mono | Advance? | State |
|---|---|---|---|---|
| 1 | D5 | (none) | No (first) | 0 |
| 2 | D5 | D5 | No (same) | 0 |
| 3 | D#5 | D5 | Yes | 1 |
| 4 | D5 | D#5 | Yes | 0 |
| 5 | D4 | D5 | Yes | 1 |
| 6 | C5 | D4 | Yes | 0 |
| 7 | C5 | C5 | No (same) | 0 |

**Acceptance #1.**

### 7.2 Pattern loop — flat walk, no reset

Same config as 7.1. Pattern `D5, D5, D#5, D5` looping forever:

| Loop | States |
|---|---|
| 1 | 0, 0, 1, 0 |
| 2 | 0, 0, 1, 0 |
| 3 | 0, 0, 1, 0 |

Loop seam is `D5 → D5` (no advance), so state stabilizes. **Acceptance #2.**

### 7.3 Polyphony transparency

States `[{none}, {horizontal}]`, `every-note`. Events:
- Tick 0: D5 (mono)
- Tick 480: chord [D5, F#5, A5]
- Tick 960: D5 (mono)
- Tick 1440: D#5 (mono)

| Tick | Type | mono ord | Advance? | stateIndex |
|---|---|---|---|---|
| 0 | mono | 0 | No (first) | 0 |
| 480 | chord | -1 | (transparent) | 0 (inherited) |
| 960 | mono | 1 | Yes | 1 |
| 1440 | mono | 2 | Yes | 0 (wrap) |

**Acceptance #3.**

### 7.4 `every-n-beats` clock test

States `[none, h, v]`, `every-n-beats(n=1, subdivision=beat)`, `startStateIndex: 0`. At 480 PPQ, beat = 480 ticks. trackAnchorTick = 0:

| Tick range | State |
|---|---|
| 0–479 | 0 |
| 480–959 | 1 |
| 960–1439 | 2 |
| 1440–1919 | 0 |

**Acceptance #4.** Note activity irrelevant.

### 7.5 `specific-pitches` whitelist

States `[none, horizontal]`, `specific-pitches({pitches: [60, 67]})`. Pattern: `C4, D4, G4, A4, C4, C4`.

| # | Pitch | In list? | Advance? | State |
|---|---|---|---|---|
| 1 | C4 (60) | Yes | Yes (whitelist overrides first-trigger rule) | 1 |
| 2 | D4 (62) | No | No | 1 |
| 3 | G4 (67) | Yes | Yes | 0 |
| 4 | A4 (69) | No | No | 0 |
| 5 | C4 | Yes | Yes | 1 |
| 6 | C4 | Yes | Yes | 0 |

**Acceptance #5.**

### 7.6 Legacy migration parity

For a project with the legacy `Clockwise` mode, ordinals 0..7 produce shader output identical to the v2-migrated config (`states: [{none}, {vertical}, {rotate-180}, {horizontal}], every-note`).

| Ordinal | Legacy phase | Legacy UV transform | v2 stateIndex | v2 orientation | v2 UV transform |
|---|---|---|---|---|---|
| 0 | 0 | identity | 0 | none | identity |
| 1 | 1 | y = 1-y | 1 | vertical | y = 1-y |
| 2 | 2 | x = 1-x; y = 1-y | 2 | rotate-180 | x = 1-x; y = 1-y |
| 3 | 3 | x = 1-x | 3 | horizontal | x = 1-x |
| 4 | 0 (wrap) | identity | 0 (wrap) | none | identity |
| 5 | 1 | y = 1-y | 1 | vertical | y = 1-y |
| 6 | 2 | both | 2 | rotate-180 | both |
| 7 | 3 | x = 1-x | 3 | horizontal | x = 1-x |

**Acceptance #6.** Same exercise for `HorizontalEven` (with `startStateIndex: 1`) and `CounterClockwise`.

---

## 8. Implementation phases

**Phase 1 — Schema, persistence, migration.** New `VideoFlipConfig` + `VideoFlipState` + `VideoFlipModifier` types in engine, bridge, renderer. JSON serialization. Legacy `videoFlipMode` field auto-migrates on `from_json`. Project file format version bumps. Migration round-trip test (acceptance #6) passes.

**Phase 2 — Resolver + tests.** `resolveStateIndex` in engine. All 4 modifiers. Mono/chord upstream filtering. Unit tests for every modifier and every edge case in 4.4. Acceptance tests #1–5 from Section 7 pass. **Phase 2 is the keystone — get the resolver right and the rest is plumbing.**

**Phase 3 — Engine integration.** Wire resolver into `rebuildVideoEventsFromClips()` for clip tracks and pattern tracks; same hook in `ArpVideoExpander.cpp` for arp events. New `stateIndex` and `orientation` fields populated on `VideoEvent`. Drop legacy `flipMode` / `globalNoteIndex` from `CellConstants` (keep `globalNoteIndex` on `VideoEvent` for analytics).

**Phase 4 — Shader rewrite.** Replace current `GridComposite.hlsl` flip switch with the 6-orientation switch from Section 5.3. Acceptance test #6 verifies byte-identical output for migrated legacy projects.

**Phase 5 — UI panel.** Replace context-menu submenu in `TimelineView.jsx` with the inline Flip Properties popover. State cards, modifier dropdown, start-state stepper, live preview hint.

**Phase 6 — Test harness.** Determinism harness: ≥5 projects pixel-diff RT vs export, byte-diff repeat-export. Insertion-stability test (asserts behavior, doesn't fix it). Migration round-trip from real legacy projects.

Estimated effort: 3–5 days. Phase 2 dominates. Phase 4 (shader) is straightforward once orientation enum is locked.

---

## 9. Acceptance criteria

1. Legacy migrations 3.5 produce byte-identical render to pre-migration projects on ordinals 0..7 and beyond. (Test #6.)
2. New tracks default to `enabled: false`.
3. The 4 v1 modifiers all resolve correctly per Section 4 algorithm.
4. Acceptance tests #1–6 (Section 7) pass.
5. Wrap is the only cycle behavior; no hidden ping-pong / hold / stop.
6. Chord events are transparent: render state of most recent mono predecessor (or `startStateIndex` if none), no advance, no previous-mono memory update.
7. RT preview and offline export are pixel-identical at every tick on the determinism harness.
8. Re-export from clean transport-stop produces byte-identical output files.
9. UI panel renders all chrome via theme tokens (no hardcoded hex).
10. Cell dispatch performance: 12 tracks × 12-state config stays within 10% of a baseline 1-state config in per-frame compositor cost. (Resolver is event-build-time, not per-frame, so no per-frame regression expected.)
11. Insertion-stability test asserts current behavior (later clips renumber). This is a documented limitation, not a bug.

---

## 10. Test inventory the new system must add

Diagnostic confirmed near-zero existing test coverage. v1 ships with:

- **Engine unit tests** for `resolveStateIndex` covering every modifier × every edge case in 4.4.
- **Engine unit tests** for legacy migration (each of `None`, `HorizontalEven`, `Clockwise`, `CounterClockwise` round-trips through the new schema and produces the right `stateIndex` for ordinals 0..7).
- **Bridge integration test** for `track:setVideoFlipConfig` round-trip.
- **Shader golden-frame test** for each of the 6 orientations against a fixed input texture.
- **End-to-end determinism test** running ≥5 projects through preview-vs-export pixel diff.

---

## 11. Known decision debt (deferred post-v1)

- Per-state visual FX (planned for v2; schema accommodates without breaking change).
- Per-clip state lock override (mitigation for `globalNoteIndex` instability — clip ignores modifier, renders fixed state).
- Per-clip phase offset (alternative mitigation — clip shifts the modulo phase locally).
- Cell-jump triggers ("if G5 → next cell"). Separate feature class.
- Arbitrary rotation angles + per-frame transform animation.
- Diagonal-mirror orientations (the other 2 D₄ elements).
- v2 modifier types: `velocity-gate`, `pitch-direction`, `random-with-seed`, `manual-automation`, `probability`, `chained`.
- Cross-track sync ("advance flip on track A when track B's note fires").
- Modifier preset library shareable like themes.
- Per-state video-source override (state changes the source clip too).
- Optional ping-pong cycle mode if state-list enumeration trick proves unwieldy in practice.
- Visual regression test infrastructure beyond golden-frame shader tests.

---

## 12. Locked answers to v0.2's open sub-decisions

1. **`specific-pitches` first-trigger rule** → whitelisted-pitch always advances, including the first one. Locked.
2. **Clockwise / Counter-Clockwise legacy migration** → discrete 4-state cycles per Section 3.5. Locked.
3. **`every-n-beats` `n` valid range** → integer 1..32 in v1. Fractional values deferred to v2 if requested.
4. **`startStateIndex` clamp on state-count reduction** → auto-clamp to `states.length - 1` on edit. UI reflects clamped value.
5. **Mono-vs-chord onset-tick threshold** → exact tick equality. Locked. (Xleth ticks are integer at 960 PPQ; no FP tolerance question.)
