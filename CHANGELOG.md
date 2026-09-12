# Changelog

## 1.2.2-beta

### Changed

- **The pencil's draw length now sticks to the last clip you touched.** By
  default the pencil still draws exactly one snap division — SNAP 1/16 draws a
  1/16 clip, and changing SNAP changes what it draws. But the moment you touch
  an existing clip whose length differs from that division — select it, move it,
  trim it, stretch it, or middle-click it as a template — that clip's exact
  length becomes the global draw length, and SNAP changes no longer move it. It
  stays for the rest of the session no matter which sample or syllable you draw
  next; loading a project (or touching a clip that is exactly one snap division
  long again) puts the pencil back on SNAP. Alt (free, unsnapped) trims now
  publish their length too — previously they were skipped.

### Fixed

- **The packaged app no longer hangs forever on the splash screen.** 1.2.1-beta
  froze at "Starting…" on both the installer and portable builds, and a
  reinstall did not help. `addon-worker.js` runs outside `app.asar` and is
  shipped by a per-file electron-builder entry; it had grown a
  `require('./worker-dispatch-priority.js')` that was never added to that list,
  so the packaged engine worker threw at load. The throw by itself would have
  been survivable — what produced a dead splash is that the worker's
  `uncaughtException` handler did not exit, and its open IPC channel kept the
  process alive, so the main process saw neither a ready signal nor an exit and
  waited on a Promise that could never settle. The missing module is now
  shipped, the worker exits on a fatal startup error so the failure surfaces as
  a real message, engine startup is bounded by a timeout
  (`XLETH_WORKER_READY_TIMEOUT_MS`, default 90s), and a test now fails the build
  if a new worker-side `require` is left unshipped.

## Unreleased

### Changed

- **The XLETH Filter panel now moves with its own modulators.** A slot's LFO,
  Envelope or Dynamics follower changed the sound but nothing on screen: the
  response curve sat at the parked knob positions, so a two-octave sweep looked
  exactly like a filter doing nothing. The engine now reports the EFFECTIVE
  position of all six modulatable knobs (cutoff, Q, gain, morph, drive, mix)
  plus every lane's current output, and serves them with a response curve drawn
  from those same values through one new polled door
  (`audio_filterGetLiveState`). The panel animates on that: the bold curve is
  where the filter actually is, the parked curve stays behind it as a dashed
  ghost so the sweep reads against its own rest position, a marker rides the
  selected slot's live corner frequency, each modulator lane gets an OUT meter
  that swings with it (bipolar for an LFO, unipolar for an envelope or
  follower) and a brightness-tracking activity dot, and every knob a lane is
  aimed at prints its live value under the parked one. Nothing animates unless
  the slot actually has a modulator, and a filter that has none renders and
  polls exactly as it did before.
- **Timeline edits no longer refetch the whole project.** Every clip mutation
  used to end in `timeline_getClips()`, which returns every clip in the project
  — 26 scalar fields plus a nested modulation object each — structured-cloned
  across worker → main → renderer and then rebuilt into fresh JS objects on
  arrival, so a three-clip drag paid for a five-thousand-clip project and
  invalidated every clips-keyed memo whether or not anything changed. The batch
  and single-clip mutation RPCs now answer with the post-state of the clips they
  touched (`moveClipsBatch` returns the moved clips, `pasteClipsBatch` adds
  `clips` and `removedIds`, `removeClipsBatch` returns the removed ids, and
  `moveClip` / `resizeClip` / `resizeClipLeft` / `stretchClip` /
  `stretchClipLeft` / `quantizeClipsBatch` return the clip instead of nothing),
  and the renderer splices that bounded set in, keeping the existing object for
  any clip whose fields did not change. A 200-clip drag is now two round trips
  and no `getClips`. The full refetch survives where the change set is genuinely
  unbounded: undo/redo, project load, and the engine's clips-changed broadcast.
- **Pasting or duplicating pattern blocks and automation clips is one round trip
  and one undo entry.** Ctrl+V and Ctrl+D ran a serial loop of awaited
  `addPatternBlock` calls plus a second awaited `setPatternBlockLoop` for every
  looped block, so a 64-block paste was 64+ stacked round trips and 64+ undo
  entries that Ctrl+Z had to pop one at a time. New batch RPCs
  (`timeline_addPatternBlocksBatch`, `timeline_pastePatternBlocksBatch`,
  `automation_addClipsBatch`) do the whole group as one undoable command, with
  `loopEnabled` carried on the block itself. Automation placements are resolved
  engine-side: same-lane overlap is rejected outright, so each landing tick
  depends on the ones before it in the same group — the dependency that kept
  this a serial await-per-clip with a running occupancy map in the renderer.
  A drag-duplicate of several automation clips is also one undo entry now; it
  used to push one per clip and Ctrl+Z removed exactly one of them.
- **Splitting a clip is one undo entry, not three.** The split was
  `removeClip` + two `addClip` calls, so Ctrl+Z could stop halfway and leave the
  clip deleted with only its left half restored — the renderer compensated with
  a hardcoded step count. It is now a single `pasteClipsBatch`, and both halves
  inherit every clip field through the shared payload builder instead of a
  hand-copied list that could go stale.

- **Sample Selection window: Space is preview, always.** The picker used to hand
  Space back to the browser whenever the focused element was a `<button>`, so
  the moment you clicked Set In / Set Out / Add Sample, Space stopped playing
  and started re-firing that button instead. Space now reaches preview from
  anywhere in the window except real text entry (the sample-name field and the
  custom-label field), and holding it no longer machine-guns play/pause.
- **Double-clicking the waveform no longer resets the zoom.** Reset to full view
  moved onto the zoom scrollbar (double-click it), which only exists while
  zoomed in the first place.
- **Zoom/Pan/Rot now interpolates zoom in log2 space (project schema v6).** The
  animation is stored as four keyframe tracks (`panX`, `panY`, `zoomLog2`,
  `rotationDeg`) and evaluated with CSS `cubic-bezier` easing. Projects saved by
  earlier builds migrate automatically: **endpoints and the post-animation hold
  state are bit-exact**, and the named easings map to their exact bezier
  equivalents, but the **interior of a zoom sweep renders differently** — a
  1×→8× sweep now reads 2.83× at its midpoint instead of 4.5×. This is
  intentional: linear zoom interpolation is perceptually non-uniform and made
  long sweeps appear to decelerate. There is no legacy linear mode.
- Animation timing on the live preview now runs off the audio-master transport
  clock instead of an accumulated `steady_clock` delta, so preview and exported
  output match frame-for-frame and frame hitches no longer drop animation time.

### Added

- **Note Fade: every note's video can fade itself in and out.** A new
  Pattern-track-only section (Grid Settings track card, and Track Video
  Properties) applies an automatic fade to the video of every note on the
  track, with the fade-in and fade-out configured independently. Each side
  picks how its length is measured: **Follow Note Length** (the default — a
  percentage of whatever the note's own length is, so it stays musical across a
  whole pattern), a fixed **Note Division** from 1/64 up to one beat, or a fixed
  time in **Milliseconds**. Four curve shapes — Linear, Smooth, Snappy and
  Gentle — are shared by both sides and named for what they do near silence, so
  one name means one shape whichever end it is on. A fade longer than the note
  it lands on is clamped to that note rather than bleeding past it, and two
  over-long fades split the note evenly. Off by default, so existing projects
  are untouched.

- **Middle-drag on the picker waveform sweeps an in/out region.** Press the
  middle button, drag across the span, release: in/out land on the swept range
  and the label dropdown opens focused, so the only thing left is picking a
  label. A middle-click with no drag leaves the existing points untouched.
