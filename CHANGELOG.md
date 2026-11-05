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

- **Video preview and export decode use more than one core.** Software video
  decode (every DNxHR/intra proxy, any file hardware decode declines, and every
  export on a machine without D3D11VA) ran on FFmpeg's default of ONE thread.
  `RenderVideoDecoder` now opens software codecs with frame + slice threading on
  half the machine's threads (capped at 4, so audio, UI and the renderer keep
  theirs); hardware-decoded files are unchanged. The end-of-file drain was made
  threading-safe at the same time: it used to accept the first buffered frame
  regardless of its timestamp, which with a pipeline of frames would have
  delivered an earlier frame than asked for near the end of a file. The
  hardware path also stops allocating a fresh CPU-side frame for every decoded
  frame — the ~1.4 MB NV12 transfer target is kept per stream and reused.
- **The preview tick does less work per frame on big projects.** Four
  per-tick costs that scale with project size, not with what is on screen:
  (1) every placement scanned the whole event list for its active event — ~17
  full passes over 3133 events on a 4x4 grid plus backdrop; the collector now
  makes one pass per frame and each placement looks its track up. (2) The
  proxy/poster self-heal sweeps walked every event every tick; they now run
  right after an event rebuild (when a new clip can first appear), when poster
  mode flips, and otherwise twice a second — they are idempotent and
  once-per-key, so nothing is lost. (3) The tick copied the active
  `GridLayout` only to overwrite it with the frame's own, then had the
  collector resolve that same layout again; one resolve now feeds both.
  (4) Three unconditional stderr writes were still on the per-frame path — the
  compositor's "texture is null" line (which the playback decode budget now
  makes routine, not an error), the frame cache's every-100-gets STATS line and
  its per-eviction CAPACITY line (one per decoded frame once the cache is
  full); all follow `XLETH_RENDER_LOG`.
- **Under the playback decode budget, new cells get their frame first.** When
  several cells start on the same beat and the budget defers some decodes, the
  order used to be plain (file, frame) order, so a cell that could hold its
  previous frame might be decoded before a cell with nothing to show. Misses
  for cells that have no held frame now go first, each group keeping file order
  so forward decoding still chains.

- **Zooming the Timeline all the way out now shows the whole song.** The
  zoom-out limit used to be a fixed 8 px/beat, about 22 bars in a typical panel,
  whatever the song's length. It is now the zoom at which the entire song (plus
  a small tail) fills the panel, in both the Audio timeline and the Video tab's
  mirror. Fully zoomed out, the view stays fitted when you resize the panel or
  the song grows, and the scrollbar keeps its place instead of disappearing and
  shifting the tracks. Zooming out from anywhere now glides back to the song's
  start. Far out, the ruler numbers every 2nd, 4th, 8th… bar instead of
  printing overlapping labels. Touchpad pinch and precision-wheel zoom now move
  in proportion to the gesture, where every tiny event used to count as a full
  mouse-wheel notch.

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

- **Optionally delete regenerable files when a project closes.** A new setting,
  **Delete regenerable files when closing a project** (Settings, Graphics,
  Regenerable Files; off by default), removes a project's preview proxies,
  thumbnails and waveform caches when you close it — by opening or starting
  another project, or by quitting — and tells you how much space that freed. Your
  source media and `project.json` are never touched. Whatever was removed is
  rebuilt in the background the next time you open the project: it opens
  immediately, stays fully usable, and a **Rebuilding previews** badge on the
  video panel shows progress (a waveform cache returns the first time that
  waveform is drawn). Proxies whose source media is offline are kept, because
  they cannot be rebuilt and are the only copy left of those frames. A project
  reopened from the folder it already has open, and an open that fails, delete
  nothing.

- **File, Clean up project.** Shows exactly what would be freed — proxies and
  waveform caches nothing in the project can read any more (for example those of
  a source you removed) plus the half-written leftovers of interrupted jobs —
  and deletes them only after you confirm. Files the project is using are left
  alone, and offline-media proxies are listed as kept, with the reason.

- **Interrupted-job leftovers are swept every time a project opens.** Proxy,
  poster and waveform-cache writers all write `<name>.tmp` and rename on
  success, so a `.tmp` from a crash or a killed app is never referenced; those
  are now deleted silently on open (previously only proxy leftovers were, and
  only in the proxies folder).

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

### Fixed

- **The engine no longer crashes at exit after an audio export.** The audio
  export ran on a global thread that nothing ever joined, so once the export
  had finished the handle was still joinable when the process shut down and its
  destructor called `std::terminate` (0xC0000409). Every bridge test that ran
  `audio_exportStart` — the FET and Vari-Mu compressor suites among them — died
  this way after printing a clean verdict, which the test runner counted as a
  failure. `shutdown` now cancels a still-running export and joins the thread
  before the audio engine it renders through is torn down.
- **Timeline zoom no longer stammers back and forth when zoomed far out.** The
  view animator's spring used a numeric step that was only stable while frames
  took under ~30 ms. Zoomed out is the heaviest redraw and so the slowest frame
  rate, and there the zoom swung past its target and back on every frame (and
  the scroll with it) until something else moved. The spring now uses its
  exact closed-form step, which holds at any frame rate. The Piano Roll shares
  the same animator and gets the same fix. Separately, the Video tab's timeline
  clamped a zoom-out against the previous zoom's scroll limit, which let the
  view run past the end of the song and snap back on the next wheel notch.

- **A failed Open Project no longer leaves the app pointed at the wrong
  folder.** Opening a folder without a `project.json` (or with a corrupt one)
  used to fail *after* the project manager had already switched to that folder
  and created its subfolders, so the project you were still working in would
  save, clean up and resolve media against the wrong place. A failed open now
  changes nothing and creates nothing.
