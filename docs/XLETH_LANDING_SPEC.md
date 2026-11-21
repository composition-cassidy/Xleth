# XLETH Landing spec (locked 2026-11-14)

One-shot build spec. Read all of it before writing code. Do the phases in order, run each phase's tests before you start the next one, and commit after each phase on a branch named `feature/landing`. After code changes, run `graphify update .` (see CLAUDE.md).

---

## 1. What we're building

Snapshot cues currently hard-cut, or blend two fully composited frames (A = outgoing snapshot, B = incoming snapshot). A track can't move into its snapshot-B slot *before* the cut. When the track isn't in snapshot A at all, it isn't drawn before the cut.

A **Landing** is a per-track move, owned by a cue, that **ends exactly on the cue's pin**. It runs during a **lead-in** before the pin. The track flies from a start rect to the rect its slot occupies in snapshot B, so the cut is seamless for that track.

### The reference scenario (the acceptance test, §9)

- Snapshot 1: two cells side by side. Chords on the left half, bass on the right half.
- Snapshot 2: chords in a small top-left cell, bass in a small top-right cell, lead in a big center cell, two percussion tracks in small cells at the bottom.
- Cue at bar 9 → snapshot 2, hard cut.
- Before the cut, chords and bass shrink and slide from their snapshot-1 halves into their snapshot-2 cells, and the lead rises from below the frame into its center cell. The percussion has no landing and appears on the downbeat.
- Optionally, the chords and bass fade from a lower opacity to full while moving (the user's choice per landing).

## 2. Names (final; use them in code, UI and docs)

- **Landing**: one track's move into its incoming-snapshot slot, ending on the cue pin.
- **Lead-in**: the landing's duration before the pin, in ticks.
- **From**: where the move starts. `Edge` (off-canvas along an angle), `Grow` (a zero-size rect at the destination center), `WhereItWas` (the track's rect in the outgoing snapshot), `Custom` (a canvas-normalized rect).
- **Reflow**: a cue-level action that adds a `WhereItWas` landing for every track whose rect changes between A and B.
- **Carry**: drawing landing tracks once, on top, instead of inside the A/B composites.

Never use Vegas or Keynote terms (no "Magic Move", "Track Motion", "Pan/Crop").

## 3. Locked rulings

1. **The cue owns landings, not the snapshot.** This is the same reason `SnapshotTransition` lives on `GridCue`: a snapshot is reused across many cues, and only the cue is an unambiguous boundary. Landings move with their cue.
2. **The destination is resolved at render time** from snapshot B's current slot. If the user edits B's slot, the landing follows. Nothing is baked.
3. **Interpolation happens in canvas space** (output UV, 0..1), never in grid units. A and B may have different columns, rows and gap.
4. **The end rect is pixel-identical to B's drawn rect.** The rect math (fine-grid → UV, gap inset, per-track gap override) is promoted to one pure function that the compositor and the landing resolver both call (§6.1).
5. **Video is always live.** While landing, a track shows exactly what it would show if it were in the layout at that tick: pickup notes play, and hold-last-frame rules apply. If no event is active, nothing is drawn: no poster frame and no placeholder.
6. **Landing tracks are carried.** From the lead-in start until the end of the cue's transition window (or the pin, for a hard cut), each landing track is removed from every composite (A, B, or the normal single composite) and drawn once, above everything else. Without this, Push and Slide transitions would split the track, and crossfades would dim it.
7. **Order of operations is unchanged.** A landing only replaces the cell's home rect. Roam, Lens, the visual effect chain and flip all apply after it, as today. With Roam bounds `Clip`, the scissor is the in-flight rect.
8. **Determinism.** Landing progress is a pure function of the frame's absolute project sample, converted from ticks the same way the transition path does. There is one resolver, used by both the live preview and the export path, so they match frame for frame. Seeking into a lead-in lands mid-move.
9. **No landings means today's path, byte-identical, with zero added per-frame cost.** Every new branch is gated on a non-empty resolved landing set.
10. **Undo matches today's cue edits.** `setCueTransition` mutates the Timeline under `syncEventsMutex` and is not on the UndoManager. Landings use the same path. Making cue edits undoable is out of scope.
11. **Missing references are skipped, never fatal.** If the track was deleted, the track has no grid slot in B, or the cue's snapshot is gone, the resolver skips that landing silently and leaves the stored data untouched.

## 4. Data model

In `engine/src/model/TimelineTypes.h`, next to `SnapshotTransition`:

```cpp
struct TrackLanding {
    static constexpr int64_t kDefaultLeadInTicks = 960;        // 1 beat @ 960 PPQ
    static constexpr int64_t kMaxLeadInTicks     = 960 * 16;   // 4 bars of 4/4

    enum class From : uint8_t { Edge = 0, Grow = 1, WhereItWas = 2, Custom = 3 };

    int      trackId      = -1;
    int64_t  leadInTicks  = kDefaultLeadInTicks;
    From     from         = From::Edge;
    float    edgeAngleDeg = 270.0f;     // side it enters from: 0=left, 90=top, 180=right, 270=bottom
                                        // (same convention as SnapshotTransition::geomAngleDeg)
    float    customX = 0.0f, customY = 0.0f, customW = 0.0f, customH = 0.0f;  // canvas-normalized
    float    fromOpacity  = 1.0f;       // 0..1, eases to 1.0 at the pin; 1.0 = no fade (default)
    SnapshotTransitionEasingCurve easing{0.22f, 1.0f, 0.36f, 1.0f};  // "Land" (strong ease-out)

    void normalize() noexcept;  // leadIn clamped to [0, kMaxLeadInTicks]; angle wrapped to [0,360);
                                // non-finite floats reset to defaults; custom rect clamped to
                                // [0,1] with w,h >= 0; fromOpacity clamped to [0,1]; easing.normalize().
};

struct GridCue {
    TickTime                  tick;
    std::string               snapshotId;
    SnapshotTransition        transition{};
    std::vector<TrackLanding> landings;   // NEW. Empty = today's behaviour. At most one per trackId.
};
```

- `static constexpr int kMaxLandingsPerCue = 16;`. Setters reject extra entries. When a `trackId` appears more than once, the later entry wins.
- `Timeline::moveGridCue` must carry `landings`, like it carries `transition`. `addGridCue` at an existing tick keeps the landings; ruling 11 handles any that no longer resolve.

### JSON (`Timeline::toJSON` / `fromJSON`)

Additive, with no file-version bump. This mirrors how `transition` was added. `landings` is written **only when non-empty**, so a project without landings serializes byte-identically to today.

```json
"landings": [
  { "trackId": 7, "leadInTicks": 960, "from": "whereItWas",
    "edgeAngleDeg": 270, "custom": { "x": 0, "y": 0, "w": 0, "h": 0 },
    "fromOpacity": 0.7,
    "easing": { "x1": 0.22, "y1": 1, "x2": 0.36, "y2": 1 } }
]
```

`from` strings: `edge`, `grow`, `whereItWas`, `custom`. An unknown string loads as `edge`. Every field is optional on load and falls back to the default. Call `normalize()` after parsing.

## 5. Resolution (render path)

Add to `Timeline` (render path only, `const`):

```cpp
struct ResolvedLanding {
    int    trackId;
    float  fromX, fromY, fromW, fromH;   // canvas-normalized
    float  toX,   toY,   toW,   toH;     // == B's drawn rect for this track's slot
    float  fromOpacity;
    TickTime startTick;                   // pin - clampedLeadIn
    SnapshotTransitionEasingCurve easing;
};

struct ResolvedLandings {
    int      count = 0;                   // 0 => caller takes today's path untouched
    TickTime pinTick{};
    TickTime carryEndTick{};              // pin + transition.endOffsetTicks if the transition
                                          // is enabled, else pin
    ResolvedLanding items[TrackLanding::kMaxLandingsPerCue];
};

ResolvedLandings landingsAt(TickTime t) const;
```

Rules:

- **Active window per cue:** `[pin - maxClampedLeadIn, carryEndTick)`. When several cues' windows contain `t`, the **latest pin wins**, consistent with `transitionAt`.
- **Lead-in clamp:** `startTick = max(pin - leadInTicks, previousCuePin)`. Use 0 when there is no previous cue. A landing can't start before snapshot A exists. Clamp at resolve time; never rewrite stored data.
- **No heap allocation and no copying of `GridLayout`/`GridSnapshot`.** Read the snapshots and slots in place, by id, under the caller's lock (preview: `syncEventsMutex`; export: the timeline the offline renderer already reads). The output is POD.
- **Destination:** the track's `GridSlot` in B, run through §6.1's function with B's columns, rows, gapScale and the track's gap override. If the track has no `GridSlot` in B (no slot, or only a fullscreen layer), skip the landing.
- **From rects:**
  - `Edge`: let `e = (-cos θ, -sin θ)` in UV with y pointing down (θ=0 → left, 90 → top, 180 → right, 270 → bottom). Translate the destination rect by `k·e`, where `k` is the smallest distance that puts the rect fully outside `[0,1]²`. Per axis with a non-zero component: `e.x<0 → (x+w)/(-e.x)`, `e.x>0 → (1-x)/e.x`, the same for y; take the minimum over the axes that have a non-zero component.
  - `Grow`: a zero-size rect at the destination center.
  - `WhereItWas`: the track's rect in A (gridLayout at `pin - 1`). If its `GridSlot` is in A, use §6.1 with A's geometry. If the track is a fullscreen layer in A, use the full canvas `(0,0,1,1)`. If the track isn't in A, fall back to `Grow`.
  - `Custom`: the stored rect.
- **Per frame:** `p = clamp((S - startS) / (pinS - startS), 0, 1)` in samples, where `S` is the frame's absolute project sample. Use `p = 1` when `pinS == startS`, and for every `S >= pinS` (the carry phase). Then `e = evaluateSnapshotTransitionBezier(p, easing)`. Lerp the rect `from → to` by `e`, and opacity `fromOpacity → 1` by `e`. A landing whose `startS > S` hasn't started yet: it is still carried (drawn at its from rect), because the track must not pop between A and its landing. With `From: Edge` it is off-canvas, so nothing visible changes.

## 6. Rendering

### 6.1 One rect function

Promote `GridCompositor::gridCellToUV` plus the gap inset that `compositeFrame` applies (including `CellFrameRequest::gapScaleOverride`) into a pure, header-only `engine/src/render/GridRectMath.h`:

```cpp
void slotCanvasRect(int cellCol, int cellRow, int spanX, int spanY,
                    int gridCols, int gridRows, float gapScale,
                    float& x, float& y, float& w, float& h);
```

`GridCompositor` must call it for every grid cell, so the compositor and the resolver can't diverge. Byte-identical output for existing projects is mandatory. Add a unit test that compares this function with the compositor's old math across every grid size from 1×1 to 8×8, every half-grid placement, and gaps 0, 0.1 and 0.5.

### 6.2 Request override

Add to `CellFrameRequest` (`render/FrameCollector.h`):

```cpp
bool  hasCanvasRect = false;   // true => draw at canvasRect, ignore cellCol/cellRow/span/grid size/gap
float canvasRect[4] = {0,0,0,0};
```

In `GridCompositor`, when `hasCanvasRect` is set, that rect *is* the cell's home rect. Roam's math and its Bounds-Clip scissor use it as home. Skip the draw when `w <= 0 || h <= 0`, so `Grow` at p=0 is safe.

### 6.3 Per-frame flow (both seams: `XlethEngineService.cpp` live preview near the `transitionAt` call, and `render/OfflineRenderer.cpp`)

Put this in **one shared helper**, for example `render/LandingRenderer.{h,cpp}`, next to `SnapshotTransitionRenderer`, so the preview and export paths can't drift.

1. `L = timeline.landingsAt(frameTick)`. If `L.count == 0`, run today's code unchanged.
2. Build a **carry layout**: a `GridLayout` with snapshot B's geometry containing only the landing tracks' B `GridSlot`s. `collectRequests(..., layoutOverride = &carry)`. **Copy the result**: `collectRequests` returns an internal buffer that the next call overwrites. Match each request to its `ResolvedLanding` by `trackId`, then set `hasCanvasRect`, `canvasRect`, `opacity *= lerped`, and give it a `zOrder` above every other request (keep the landing list order among landing tracks).
3. **Non-transition frame:** take the tick-resolved layout, remove every slot and fullscreen layer whose `trackId` is a landing track, collect with that as `layoutOverride`, append the carry requests, and call `compositeFrame` once.
4. **Transition frame** (`transitionAt(t).active`): before `renderSnapshotTransition` composites A and B, strip the landing tracks from `rt.layoutA` and `rt.layoutB` (`rt` is by value). After the transition pass, draw the carry requests **onto the transition's readback target without clearing it**. Add a no-clear overlay entry point to `GridCompositor` if `compositeFrame` clears. Then `readback()` as usual.

Fixed-capacity scratch: reuse member vectors (the same pattern as `collectRequests`' internal buffer) so steady-state frames don't allocate.

## 7. Bridge and IPC

Mirror the `setCueTransition` chain exactly:

- Engine: `Timeline::setCueLandings(TickTime cueTick, const std::vector<TrackLanding>&)` (no-op if there's no cue at that tick; normalize, de-duplicate by trackId, cap at 16). `Timeline::reflowCueLandings(TickTime cueTick, int64_t leadInTicks)`: for every track with a `GridSlot` in B that is also in A (a slot or a fullscreen layer) with a **different** canvas rect, add or replace a `WhereItWas` landing with that lead-in. Tracks in B but not in A are left alone, and existing landings for other tracks are kept.
- `XlethEngineService.cpp`: `Timeline_SetCueLandings` → `timeline_setCueLandings(tick, landings[]) → GridCue[]` and `Timeline_ReflowCueLandings` → `timeline_reflowCueLandings(tick, leadInTicks) → GridCue[]`, each under `syncEventsMutex`, plus dispatch entries next to `timeline_setCueTransition`. `gridCuesToJs` must include `landings`, only when non-empty.
- `bridge/src/XlethAddon.cpp`: named exports. `ui/rpc-manifest.js`: register both RPCs. `ui/electron-main/grid-layout.js`: `xleth:timeline:setCueLandings` and `xleth:timeline:reflowCueLandings`. `ui/preload.js`: `setCueLandings`, `reflowCueLandings`.
- No IPC during drags: preview locally and commit once on mouseup.

## 8. UI

Follow the anti-daw-ui-slop rules. Lanes are drawn on canvas, never as DOM overlays on canvases. No animation on edit-loop actions. Color is earned.

- **Cue inspector** (where the transition controls live in `SnapshotCueLane.jsx`): a new **Landings** section.
  - One row per landing:
    - track name
    - **From** dropdown (Edge / Grow / Where it was / Custom). "Where it was" is disabled when the track isn't in A.
    - Edge angle (reuse `LineSweepDirectionControl`)
    - **Lead-in** NumberBox in beats (snaps to the grid)
    - **From opacity** NumberBox in %
    - easing presets **Land** `(0.22,1,0.36,1)`, **Glide** `(0.65,0,0.35,1)`, **Linear** `(0,0,1,1)`, plus the existing `SnapshotTransitionBezierEditor` for custom curves
    - Custom rect as four NumberBoxes (x, y, w, h in %)
    - remove button
  - An **Add landing** menu listing tracks that have a `GridSlot` in B and no landing yet.
  - A **Reflow** button (calls `reflowCueLandings` with the default 1-beat lead-in).
  - Pure helper `buildCueLandings(current, patch)`, exported and unit-tested like `buildCueTransition`.
- **Lead-in tails on the cue lane:** for a cue with landings, draw one thin bar per landing to the left of the pin, from `startTick` to the pin, stacked in up to 4 rows (a "+N" label for overflow). Dragging a tail's left end edits that landing's `leadInTicks`, snapped. It previews locally and commits one `setCueLandings` on mouseup. Tails sit visually under the transition handles and never steal their hit area.

## 9. Tests and acceptance

C++ (`test/`, alongside the existing timeline and transition tests):

- `TrackLanding::normalize` clamping and defaults; JSON round-trip; a project without landings serializes byte-identically to before.
- `landingsAt`: empty set; the window edges (`startTick`, `pin-1`, `pin`, `carryEndTick-1`, `carryEndTick`); latest-pin-wins; lead-in clamped at the previous cue; skips for a deleted track, no B slot, or a B fullscreen-only track.
- From rects: Edge at 0/90/180/270 and 45 lands exactly off-canvas (touching the edge, not overlapping); Grow; WhereItWas from a slot, from a fullscreen layer (full canvas), and the fallback to Grow; Custom.
- §6.1 rect-parity test.
- **Seam test:** at `p = 1`, the landing track's resolved rect equals B's drawn rect exactly (bitwise float equality), so the hard cut at the pin is pixel-continuous for that track.
- **Determinism:** extend the existing snapshot-transition determinism test (solid textures, no decoder). Frames at `startTick`, mid-lead-in, `pin-1`, `pin`, and inside a crossfade and a Push window must be identical between the preview helper path and the export path.
- **Perf floor:** a project with cues but no landings produces byte-identical frames to the pre-feature build.

Bridge: `bridge/test_snapshot_landing_contract.js` (modeled on `test_snapshot_transition_preview_contract.js`). Set, reflow, the read-back shape, the cap at 16, de-duplication, and an omitted field round-tripping as its default. Update the RPC manifest test.

UI (vitest): `buildCueLandings` payloads; Reflow button wiring; a tail drag emits exactly one `setCueLandings` on mouseup with the snapped lead-in.

**Manual acceptance:** build the §1 reference scenario. Chords and bass `WhereItWas`, lead-in 1 beat, fromOpacity 70%. Lead `Edge` 270, lead-in ½ beat, so it starts after chords and bass have begun clearing the center. Percussion has no landing. Hard cut at the pin. Then switch the cue's transition to Push, 1 beat each side. Expected: the lead never splits or dims across the Push; chords, bass and lead never pop at the pin; scrubbing into the lead-in shows the mid-move frame; preview and export match.

## 10. Phases (commit after each one; run its tests first)

- **P0 audit:** write `docs/XLETH_LANDING_AUDIT.md`. Answer:
  - where the gap inset lives and whether `compositeFrame` clears its target;
  - what state `collectRequests` mutates per call (Visual Echo history, AnimationManager, hold-last-frame, flip counters), and whether a second call per frame (the carry collect) double-advances anything (`renderSnapshotTransition` already calls it twice per frame; confirm how that is tolerated);
  - whether `moveGridCue`/`addGridCue` copy the whole cue;
  - exactly where both seams call `transitionAt`.

  If a finding contradicts this spec, pick the option that keeps old projects byte-identical and preview == export, record the decision in the audit, and continue.
- **P1** model, `normalize`, JSON, cue CRUD carrying landings, `landingsAt` (no rendering yet), with unit tests.
- **P2** `GridRectMath.h` promotion and the rect-parity test (no behavior change).
- **P3** `CellFrameRequest` override, compositor support, the shared `LandingRenderer` helper, both seams, the no-clear overlay; seam, determinism and perf-floor tests.
- **P4** engine RPCs, bridge exports, manifest, IPC, preload; contract test.
- **P5** cue-inspector Landings section, Reflow, lead-in tails on the cue lane; vitest.
- **P6** verification: the full test suite, the manual acceptance scenario, `graphify update .`, and `docs/XLETH_LANDING_VERIFY.md` listing what passed and anything left open.

## 11. Out of scope

- Liftoff (tracks leaving after the pin).
- A motion-path overlay or drag handles in the viewer.
- Multi-key landing curves.
- Landings into fullscreen layers.
- Undo for cue edits.
- The modulation graph, the compositing graph, and the open visual-effect-chain data race.
