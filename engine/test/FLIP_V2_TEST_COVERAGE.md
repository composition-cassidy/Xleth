# Flip v2 — Test Coverage Map

This file is the canonical map between the eleven acceptance criteria in
[xleth-flip-v2-architecture-spec.md §9](../../xleth-flip-v2-architecture-spec.md)
and the test cases that prove each one. Use it to find the right test when a
property regresses, and update it when you add or remove a test.

**Run the whole suite:** `node scripts/test-flip-v2.js`
(or `cd bridge && npm run test:flip-v2`).

---

## Acceptance criteria

| # | Acceptance criterion (spec §9)                                                                          | Where it's proven                                                  |
|---|----------------------------------------------------------------------------------------------------------|--------------------------------------------------------------------|
| 1 | Legacy migrations 3.5 produce byte-identical render to pre-migration projects on ordinals 0..7 and beyond. | `test_video_flip_resolver` §[18] (CPU UV-mirror against legacy); `test_timeline` §[15] (JSON migration round-trip); `test_flip_determinism` §[3] (engine-end migration → expected stateIndex sequence) |
| 2 | New tracks default to `enabled: false`.                                                                  | `test_timeline` §[15a]; `bridge/test_patterns.js` (Phase 6 IPC round-trip — disabled config branch) |
| 3 | The 4 v1 modifiers all resolve correctly per Section 4 algorithm.                                        | `test_video_flip_resolver` §[2]–[8]                                  |
| 4 | Acceptance tests #1–6 (Section 7) pass.                                                                  | `test_video_flip_resolver` §[3] (ac#1), §[9] (ac#2), §[10] (ac#3), §[7] (ac#4), §[5] (ac#5), §[18] (ac#6) |
| 5 | Wrap is the only cycle behavior.                                                                         | Structural — `resolveStateIndex` has no other code path. Covered by every modifier test producing wrap behaviour at boundary. |
| 6 | Chord events transparent (render last mono state, no advance, no memory update).                         | `test_video_flip_applier` §[3]–[6]; `test_flip_determinism` §[2]     |
| 7 | RT preview ≡ offline export pixel-identical at every tick.                                               | `test_flip_determinism` §[1] — `OfflineRenderer::buildVideoEvents` is bit-stable across calls; both RT and export funnel through `videoFlipApplier::applyAll` (Phase 3), so identical inputs → identical outputs. Platform determinism of D3D11 + FFmpeg inherited (spec §5.5). |
| 8 | Re-export from clean transport-stop produces byte-identical output files.                                | `test_flip_determinism` §[1] (input determinism); platform-level encoder determinism inherited. |
| 9 | UI panel renders all chrome via theme tokens (no hardcoded hex).                                         | Manual — `TrackFlipPropertiesPanel.jsx` uses only `var(--theme-*)` (verified by Phase 5 grep at delivery). Add a CI lint if hardcoding ever creeps back in. |
| 10 | Cell dispatch perf: 12 tracks × 12-state config ≤10% over 1-state baseline (per-frame).                  | `test_flip_determinism` §[5]. The resolver runs at event-build time, so per-frame compositor cost is unaffected by state count by construction. The harness records the build-time delta as a sanity floor (5× headroom; tighter would be flaky on noisy CI runners). |
| 11 | Insertion-stability test asserts the documented limitation (later clips renumber).                       | `test_flip_determinism` §[4]                                         |

---

## Per-test sections

### `test_timeline.cpp`
- §1–14: pre-flip data-model checks (TickTime math, JSON round-trips, etc.)
- §15: VideoFlipConfig **JSON migration** round-trip for all 4 legacy modes
  - 15a: `None` migration + JSON round-trip
  - 15b: `HorizontalEven` migration
  - 15c: `Clockwise` migration
  - 15d: `CounterClockwise` migration
  - 15e: New v2 config losslessly survives save+load
  - 15f: `every-n-beats` modifier round-trips with nested config
  - 15g: `projectFileVersion = 2` written on save; legacy v1 projects load

### `test_video_flip_resolver.cpp`
- §1: Short-circuits — disabled / single-state / empty input
- §2: every-note — startIdx variants, wrap, pitch-blindness
- §3: **acceptance #1** — Krasen's `D5,D5,D#5,D5,D4,C5,C5` (new-note)
- §4: new-note edges — first-trigger, all-same-pitch, alternating
- §5: **acceptance #5** — specific-pitches `[60,67]`
- §6: specific-pitches edges — empty whitelist, first-trigger override, mixed
- §7: **acceptance #4** — `every-n-beats(n=1, beat)` clock-driven cycle
- §8: every-n-beats edges — n>1, bar (4/4 + 3/4), startIdx, pitch-blindness
- §9: **acceptance #2** — pattern-loop flat walk, no reset
- §10: **acceptance #3** — polyphony transparency (mono-only resolver input)
- §11: mono-between-chords memory continuity
- §12: determinism (3× same call → same output)
- §13: startStateIndex out-of-range clamp
- §14: 12-state max cycle wrap
- §15: output size invariant
- §16: walked modifiers tick-agnostic
- §17: Phase 4 6-orientation UV golden (CPU mirror of HLSL `PSMain`)
- §18: **acceptance #6** — legacy migration UV parity (4 modes × 8 ordinals × 7 sample UVs = 224 byte-identity assertions)

### `test_video_flip_applier.cpp`
- §1: Disabled config short-circuit
- §2: First mono trigger no-advance
- §3: Chord detection (3-note chord at same tick)
- §4: Chord events inherit prior mono state
- §5: new-note remembers last mono pitch across chord gap
- §6: Chord with no prior mono → `startStateIndex`
- §7: `applyAll` per-track grouping (active + disabled track interleaved)
- §8: Empty input no-op
- §9: Out-of-order events sorted by tick

### `test_flip_orientation_golden.cpp` (GPU)
- 6 orientations × 4-quadrant test texture, real D3D11 readback. Asserts each
  output quadrant carries the colour predicted by the §5.3 UV transform.
- Skips cleanly when no D3D11 device is available (CI runners without GPU).

### `test_flip_determinism.cpp`
- §1: `buildVideoEvents` deterministic across 3 calls on each of **6 fixture
  projects**: clip-track every-note, pattern new-note, specific-pitches,
  every-n-beats, chord-events fixture, 12-track × 12-state stress.
- §2: Chord transparency in the engine-end pipeline (acceptance #6)
- §3: Migration parity end-to-end — each legacy mode rebuilds via the engine
  and produces the spec-§3.5 stateIndex sequence on ordinals 0..7.
- §4: Insertion-stability — insert clip at beat 0.5 mid-track, assert later
  clips renumber. Documents the limitation (acceptance #11).
- §5: Perf budget — 12-track × 12-state event-build ≤5× the disabled-1-state
  baseline. (10% per-frame ceiling is structural; this is a build-time floor.)
- §6: State-count coverage smoke — every value in 1..12 produces in-range
  stateIndex on every event.

### `bridge/test_patterns.js` (extended in Phase 6)
- IPC round-trip for `timeline_setVideoFlipConfig`:
  - Clockwise-equivalent v2 config
  - `specific-pitches` with multi-entry whitelist
  - `every-n-beats(n=2, bar)` with nested modifier.config
  - Disabled + single-state config (covers acceptance #2)
  - Verifies derived legacy `videoFlipMode` field stays UI-compatible

---

## Building the test executables

The engine tests are built by CMake; configure the build directory once, then
build each target you need (or the whole `flip-v2` group):

```sh
cmake -B engine/build -S engine
cmake --build engine/build --target test_timeline test_video_flip_resolver \
                                    test_video_flip_applier test_flip_determinism \
                                    test_flip_orientation_golden
```

The bridge IPC test (`test_patterns.js`) requires the native addon to be built
first:

```sh
cd bridge && npm run rebuild
```

---

## When a test fails

1. **First, identify which acceptance criterion the failing test gates.** Find
   the criterion in the table above.
2. **Read the failing test's section in the appropriate test file** — the
   inline comments document the spec section the assertion is checking.
3. **Don't relax the test to make it pass.** The byte-identity claims in
   acceptance #1, #6, #7, #8 are byte-identity, not "close enough."
4. **If the spec-property has been deliberately changed**, update both the
   spec and the test in the same commit, with rationale.

---

## CI integration

The runner `scripts/test-flip-v2.js` exits non-zero on any failure and `0` on
all-pass-or-skip. Wire it into pre-merge as `node scripts/test-flip-v2.js`
once a build of the engine tests is available in the runner image. Tests that
require a GPU (`test_flip_orientation_golden`) skip cleanly on headless CI; the
remaining tests are pure CPU and safe everywhere.
