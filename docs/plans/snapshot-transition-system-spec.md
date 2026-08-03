# Snapshot Transition System — Build Spec

Status: design locked, ready for phased implementation.
Owner: Krasen. Target: Xleth (Windows-only; C++ engine / Node-API bridge / Electron+React UI).

---

## 1. What we're building (plain terms)

When the show moves from one **snapshot** (the entire grid layout + fullscreen layers, treated
as one picture) to the next, it currently **hard-cuts**. This feature adds an optional
**transition** in that gap — a crossfade, sweep, push, zoom, etc. between the two complete
looks — the same idea as crossfading two clips in an NLE, except the "clip" is a whole snapshot.

Hard cut is NOT replaced. A hard cut is simply a zero-length transition window and remains the
default. Transitions are strictly opt-in.

---

## 2. The locked interaction model

- **Pin** = fixed anchor at the snapshot boundary (the beat where the cut happens). The user does
  NOT drag the pin during transition editing; it lives at the boundary. It is the **50% blend
  point** — the two snapshots are an even mix here, landing on the beat.
- **Start** and **End** = the only draggable handles. The user drags them outward from the pin.
  Distances can be **asymmetric** (Start far left, End close in, or vice versa). Asymmetry
  time-warps the single progress curve so the approach and the exit have different real durations,
  but 50% always lands on the pin.
- Handles **snap to the musical grid** by default; holding **Alt** frees them from the grid (but
  they still quantize to whole samples internally — see determinism).
- **Easing** = two bounded cubic Bézier curves shape the transition independently from Start→Pin
  and Pin→End. Both default to linear. The split keeps the pin fixed at exactly 50% even when the
  two halves use completely different curves.
- **Style** = an "Animation Type" dropdown: crossfade, line sweep, push, slide, zoom, dissolve,
  and **out-then-in** (A animates out, then B animates in — a distinct style, NOT a different
  meaning for the handles).
- **Hard cut** = Start and End collapsed onto the pin (zero-length window). Always available,
  still the default.
- **Preview must match render exactly**, frame for frame.

### Progress model (the one we chose — "Option 1")

One progress value `t` goes 0→1 across Start→End. The pin is pinned to `t = 0.5`. Because Start
and End sit at independent distances from the pin, the mapping from time→`t` is piecewise: the
left tail spans `t` 0→0.5 over its own duration, the right tail spans 0.5→1 over its own duration.
Both snapshots are rendered across the WHOLE window, which is what lets crossfade (and every other
style) work uniformly.

After the piecewise time mapping, each half is normalized to 0→1, shaped with its own CSS-style
cubic Bézier, then scaled back into 0→0.5 or 0.5→1. Control coordinates are clamped to [0,1].

---

## 3. Engine architecture (the real design)

A whole-snapshot transition cannot use the existing per-cell crossfade
(`CellFrameRequest.pingPongSecondaryFrame`) — that blends two frames of the SAME cell, but
snapshot A and B have different cells and different fullscreen layers, so nothing corresponds.
The correct unit is the **fully composited frame of each snapshot**:

1. Collect + composite snapshot **A**'s entire request list (grid + fullscreen) into render target **RT_A**.
2. Collect + composite snapshot **B**'s entire list into **RT_B**.
3. A new **Transition Pass** samples RT_A and RT_B and combines them by `(mode, t, geometry)`.
4. Output → preview and export.

This reuses infrastructure that already exists:
- **RTPool** (`GridCompositor.h`) already hands out paired offscreen targets with SRV/RTV.
- The composite-to-RT path already exists (effect chain ping-pong).
- **RenderClock** already provides the deterministic sample position that must drive `t`.
- The **EffectShaderCache** pattern (mode enum + per-effect cbuffer) is the template for a single
  **parametric transition shader** (crossfade / wipe / push / slide / zoom from one shader + param
  bag; dissolve and any noise-mask styles can branch).

The only genuinely new code: per-snapshot collection during the window, the transition pixel
shader + its cbuffer, and the time→`t` mapping.

### Non-negotiable constraints

- **Determinism**: `t` is computed from RenderClock sample position, never wall-clock. Preview and
  export share one path — if they diverge, this is why. Alt-free handles still quantize to whole
  samples.
- **Thread discipline**: follow the existing "value snapshots under lock, no pointers to live
  mutable state" rule (the recent `Track::visualEffectChain` data-race fix). The transition path
  must not alias mutable snapshot/track state across the video thread.
- **Cost bound**: inside the window both snapshots render (roughly double the work of a hard cut).
  Keep **both outgoing and incoming snapshots live** at the same absolute project time throughout
  the transition window. Respect the Phase 0 perf floor (~0.25 ms GPU composite); the transition
  adds one additional snapshot composite plus one pass, so keep both paths allocation-free.
- Do NOT conflate engine and renderer layers. Windows-only assumptions are fine.

---

## 4. Data model

The transition belongs to the **incoming** snapshot as its "in" transition (PowerPoint-style),
which matches the "EDITING: New Snapshot" UI:

```
transition: {
  enabled:      bool,     // false = hard cut (also true when startOffset==endOffset==0)
  startOffset:  samples,  // distance of Start handle BEFORE the pin (>= 0)
  endOffset:    samples,  // distance of End handle AFTER the pin (>= 0)
  type:         enum,     // crossfade | lineSweep | push | slide | zoom | dissolve | outThenIn
  typeGeometry: {...},    // per-type params (e.g. sweep angle) — fixed defaults for v1
  easing: {
    startToPin: {x1, y1, x2, y2}, // default 0,0,1,1 (linear)
    pinToEnd:   {x1, y1, x2, y2}, // default 0,0,1,1 (linear)
  },
}
```

Pin position = the snapshot's placement on the timeline (moving the snapshot moves the pin;
editing the transition never moves the pin).

---

## 5. Phased implementation (four Claude Code prompts, in order)

**Prompt 1 — Recon + plan (NO code changes).** Locate the snapshot data model, the current
hard-cut/boundary logic, and the snapshot-transition timeline UI. Confirm the two-RT approach
against the real RTPool / GridCompositor / FrameCollector code. Produce a concrete phased plan
with exact file paths. *(Full text below.)*

**Prompt 2 — Data model + deterministic progress.** Add the `transition` struct to the incoming
snapshot; compute `t` from RenderClock sample position with the piecewise Start→pin→End mapping;
unit-test the mapping (asymmetric windows, zero-length = hard cut, sample quantization). No visual
output yet.

**Prompt 3 — Engine two-RT transition pass.** Render A and B to separate RTs; add the parametric
transition pixel shader + cbuffer (start with **crossfade + one directional line sweep**);
keep A and B live at the same project time; wire `t` in. Verify preview==export with a
deterministic pixel-hash test.

**Prompt 4 — Timeline UI.** Draggable Start/End handles around the fixed pin in a dedicated thin
transition strip; grid-snap with Alt-free; Animation Type dropdown; zero-length window = hard cut
default. Preview reflects the engine result.

Prompts 2–4 get their exact file targets from Prompt 1's findings.

---

## 6. Prompt 1 (paste-ready)

Recommended run: **Opus — Xhigh** (planning-heavy recon over a large C++/JS codebase with subtle
threading + determinism concerns). Implementation prompts 2–4: **Opus — High**.

```
Recon and plan a new "snapshot transition" feature for Xleth. DO NOT write or change any
implementation code in this pass — produce findings + a plan only.

Background:
- A "snapshot" = an entire visual state: the full grid layout PLUS fullscreen layers, treated
  as one composited picture. The show currently HARD-CUTS from one snapshot to the next.
- We want optional transitions (crossfade, line sweep, push, zoom, out-then-in) between two
  snapshots. Hard cut stays the default and is NOT replaced.
- Locked design (already decided — validate feasibility, do not redesign):
  * Two-render-target model: composite snapshot A into RT_A, snapshot B into RT_B, then a new
    parametric "transition pass" pixel shader blends them by (mode, progress t, geometry).
  * progress t is one value 0..1 across a Start..End window; the boundary "pin" is fixed at
    t=0.5; Start/End are user-dragged and may be asymmetric (piecewise time->t mapping).
  * t MUST come from RenderClock sample position (deterministic; preview must equal export).
  * Transition data is owned by the INCOMING snapshot as its "in" transition
    { enabled, startOffset, endOffset, type, typeGeometry }.
  * Composite both outgoing A and incoming B at the same absolute project time for every frame
    in the transition window; only the incoming snapshot remains after the window ends.

Your tasks:
1. LOCATE and report exact file paths + key structs/functions for:
   a. The snapshot data model — where a snapshot's grid layout + fullscreen layers are stored,
      and how snapshots are sequenced/placed on the timeline.
   b. The current hard-cut / snapshot-boundary logic — where the render switches from one
      snapshot to the next, in the engine render path.
   c. The snapshot-transition timeline UI already in progress (the "EDITING: New Snapshot"
      header, the pin/Start/End handles, the "Animation Type" dropdown) — which React files.
2. CONFIRM the two-RT approach against the real engine code: RTPool, GridCompositor (the
   composite-to-RT and readback paths), FrameCollector (collectRequests/dedup/resolveFrames),
   RenderClock. Note exactly where RT_A/RT_B would be acquired, where the transition pass would
   run in the frame, and how FrameCollector would produce requests for BOTH snapshots during the
   window (tagged by snapshot).
3. FLAG risks against existing constraints: the Track::visualEffectChain data-race fix pattern
   (value snapshots under lock, no pointers to mutable state) and whether the snapshot/transition
   path can follow it; the Phase 0 GPU-composite perf floor; any Windows-only assumptions.
4. OUTPUT a phased plan matching these four slices, each with exact target files:
   (2) data model + deterministic t mapping, (3) engine two-RT pass + parametric shader
   (crossfade + one line sweep first), (4) timeline UI. Call out anything in the locked design
   that the real code makes impractical, with a specific alternative.

Deliverable: a written recon report + phased plan with concrete file paths. No code edits.
```
