# XLETH Updates

A running, bulleted log of what changed in XLETH: new features, changes and bug
fixes. Newest first. Unreleased work sits in the top section until a build is cut,
then it moves under that build's heading. `CHANGELOG.md` keeps the longer
prose write-ups; this file is the quick list.

**How this file is kept current:** every commit that adds, changes or fixes
something a user or developer would notice gets a bullet under `Unreleased`
(Added / Changed / Fixed) in the same commit. Cutting a build means renaming
`Unreleased` to the build name and starting a new empty `Unreleased`.

Only code changes are listed: new features, updates and bug fixes. Audits,
verification reports, licences, design docs, benches and test-only changes are
left out.

Baseline: the 1.2.3-beta build (commit `e68d738`, 2026-09-20). There is no
`v1.2.3` git tag; the commit was found from the build's file time.

---

## Unreleased

Since the 1.3.0-beta build (last commit in it: `752aa00`, 2026-11-11). 34 commits,
2026-11-11 to 2026-11-14, on `feature/lens-roam`.

### Added

- **Images, GIFs and colour sources.** Import PNG, JPG, BMP, WebP and GIF files,
  or make a solid colour or gradient (with per-colour opacity) from the brush button
  in Media. Transparent pixels show the layers behind them in preview and export.
  Images and colours are stills: drag one onto a clip track for a 1-bar clip that
  holds its frame however long you stretch it; they never become samples. GIFs play
  as video.

- **Faster device reordering.** The Audio Devices chain has a strip of numbered chips
  beside the Audio tab: drag a chip to reorder (bypassed devices are struck through),
  click one to scroll to its device. The device menu gains Move to start / Move to end,
  and Alt+Left / Alt+Right moves the focused device one place.

- **Filter slopes on the stock EQ.** Low Pass and High Pass bands get a Slope
  selector: 6, 12 (the default, exactly the old filter), 18, 24, 36, 48, 72 and 96
  dB/oct, and a Brickwall (Chebyshev II, ~-94 dB by 1.3x the corner). Every slope
  has its -3 dB point on the band frequency, so a steeper slope is the same corner
  with a sharper wall; Q is the resonance at the corner. Old projects load at 12
  dB/oct (new `b{i}_slope` parameters, appended last). Steep slopes run as
  double-precision biquad cascades; design in `engine/src/dsp/EqSlopeDesign.h`.
  Reso (Spectral mode, both engines) on a Low / High Pass band now follows the
  slope instead of a bell, so the region lines up with the drawn curve and the
  Core display matches the engine exactly.

- **New XLETH app icon everywhere.** Window, taskbar, installer and shortcuts use
  the new icon (`ui/assets/icon.ico`, full PNG/SVG set in `ui/assets/icons/`). The
  audio engine worker now runs under a branded copy of Node
  (`vendor/node/xleth-host/node.exe`, made by `ui/scripts/brand-engine-host.cjs`),
  so Volume Mixer and Task Manager show "XLETH" with the XLETH icon instead of
  Node.js.

- **Lens + Roam.** Lens frames the content inside a video cell; Roam moves the
  cell itself. Built in phases P1 to P12 against `docs/XLETH_LENS_ROAM_SPEC.md`.
  - Engine model (schema v8): Lens params (fit, centre, zoom, rotation, flip),
    Roam params (offset, scale, rotation, bounds, layer), identity defaults,
    tolerant JSON, v7 to v8 migration and an immutable render snapshot.
  - Rendered in the compositor from that snapshot.
  - Edit commands with undo, a getter and the four-layer wiring through the bridge.
  - A static Lens panel, a Roam inspector and a viewer overlay canvas.
  - Per-note Lens overrides (Follow / Nudge / Own) with hit curves and presets.
  - A shared keyframe curve engine (`KeyCurve.h`): Hold / Linear / Ease out keys
    on event ticks, timeline ticks or note anchors (Head / Body / Tail zones).
  - Reel lane: a read-only video lane under Pattern tracks.
  - Advanced Lens editor: keyframe lanes, layer stack and hit curve.
  - Roam key lane with motion path and Auto-key. Click adds a key, drag moves it,
    right-click deletes, one commit on mouse-up, Escape cancels.
  - Sweep lane: a timeline-absolute Lens offset per Pattern Track for moves that
    span several notes.
- **Fedda stereo widener.** New stock effect on a shared `StereoizeCore`. Mono
  sum equals the input exactly, width 0 is a bit-exact passthrough, zero latency.
  Comb / Diffuse / Velvet decorrelators, low bypass, HF damp, transient guard,
  loudness match, 11 parameters, five factory presets, and a device with a live
  stereo-field and correlation display.
- **Plugin scan hardening (P1).** Per-format enumeration, a persisted failure
  list (`plugin-scan-failures.json`), incremental scans by file time, cancel that
  merges instead of wiping, atomic cache writes, and engine-owned search paths.
  New RPCs: `audio_cancelPluginScan`, `audio_get/setPluginSearchPaths`,
  `audio_retryFailedPlugins`.
- **Plugin host safety (P2).** A PE file inspector rejects non-64-bit, ARM64 and
  non-plugin binaries before the scanner is ever spawned. A load breadcrumb
  around every third-party load (insert, project load, resolve missing) turns a
  crash into a quarantine entry on the next start. Editor INIT v2.

### Changed

- **Snapshots lane only when it is used.** The Snapshots header and the cue lane above
  the tracks now appear once a project has a second snapshot or any cue, instead of
  always. New snapshot in the Preview's Edit grid brings them back; until then the
  24px goes to the tracks.
- **Changed values stand out.** Knobs and number fields whose value is still at its
  default draw that value in a quieter grey; a value you changed draws in full white.
  This covers device knobs, the Sampler's top row and the mixer's dB readout, so a
  touched fader or knob is easy to spot.
- **Preview notes start at the next audio block.** Piano-roll and keyboard audition
  notes, and the all-notes-off sent on Stop and Pause, are now queued to the audio
  thread instead of changing a sampler's voices from the UI thread in the middle
  of a block. They land at most one buffer later (about 10 ms), and a preview key
  or a Stop can no longer tear a voice or leave a note stuck.
- **Compose is the default layout.** Preview sits at the top of the Browser's 304px
  column, there is no top row, and the Inspector docks right at 280 when opened.
  The old shell stays as "Tiled (preview row)". Arrangement chrome goes from 95
  to 83.
- **Wider dark neutral ramp** (23 to 35 steps): regions read by fill, bar lines
  clear 3:1, the Browser / Patterns / Devices / mixer bodies are g0 wells, and
  ink and accent colours were raised to keep their contrast floors.
- **Mixer strips name their inserts.** A number over a name, a five-row insert
  list naming the chain's devices (struck through when bypassed, "FX graph" for a
  graph track), signed gain (`+3.0 dB`), a ticks-only meter, and the insert list
  as tall as the longest chain on every strip.
- **Arrangement shows structure and content.** Track names get 124px (was 62),
  pattern blocks have no hatch (a title strip in the track colour over the mini
  piano roll), a neutral pattern lane tint, and alternating bar-group shading.
- **Dock tabs never dead-end.** Piano Roll and Sampler open on the last or first
  pattern instead of an empty state. The transport time and bars.beats readouts
  are 16px mono.
- **Brand font is Barlow (OFL)**, replacing Neuzeit for licensing reasons. Fonts
  are vendored in `ui/assets/fonts/Barlow`.
- **Video export reads a frozen timeline copy**, not the live one.
- **Dev-machine paths** are derived from the home directory instead of hardcoded.

### Fixed

- **A seek or Stop during playback is no longer lost.** If it landed while the
  audio thread was moving the playhead on by one block, that write put the old
  position back: the playhead carried on from where it was, or Stop left it
  there instead of at 0. With the loop on, a seek past the loop end could also be
  pulled back to the loop start. Position, playing state and the loop latch are
  now one atomic value, and the audio thread only moves the playhead if
  nothing changed since it read it.
- **Sweep-delete is one undo step.** Dragging the Delete tool over many clips
  removed them one engine call at a time, so Ctrl+Z brought back a single clip.
  The sweep now commits once on mouse-up (one `removeClipsBatch`, plus any swept
  pattern blocks in the same undo group): one Ctrl+Z restores everything swept.
- **Loading a project while playing no longer leaves the output silent.** The
  transport kept running but nothing was heard until Stop + Play. The load
  publishes the new timeline before it decodes the regions, so the first block
  skipped every clip under the playhead and never looked at them again. A
  region being mapped to its audio now makes the next block rescan the clips;
  this also fixes a clip added under the playhead staying silent once its
  audio finished decoding.
- **File → New no longer leaks memory.** Starting a blank project kept the
  closed project's decoded audio and waveform peaks until the next project
  load, so repeated File → New (with work in between) grew without bound. They
  are now released the same way a load releases them.
- **Memory no longer grows on every project load.** Opening a project kept the
  previous project's decoded audio and waveform peaks in memory, so each load
  of a project added its whole audio footprint again (about 220 MB per load
  for a project with ~115 MB of audio; ~12 MB for two 8 s tones). The old
  project's samples and peaks are now released on load, and a sample is only
  freed once nothing still playing or drawing it can read it, so loading
  while the transport runs is safe.
- **Placing a pattern block on top of an identical one no longer reports success.**
  The engine refuses a second block with the same track, pattern and position,
  but `timeline_addPatternBlock` answered with the id of the newest block on the
  timeline, so the timeline believed the add worked and a later move or delete
  could hit the wrong block. It now returns `-1` when the add is refused; the
  drop, pencil and split paths in the timeline check for it (a refused split puts
  the first half back at its old length).
- **Editing automation during playback no longer crashes.** After any effect
  chain change, a background thread rebuilt the automation plan from the live
  timeline while edits, undo/redo and project loads were freeing the lanes,
  clips and envelope points it was reading (a crash or hang in most runs of a
  stress test). It now builds from the timeline copy the audio already plays
  from, which also carries the automation. Publishing that copy costs about
  0.2 ms more (2.3 → 2.5 ms on a 5,000-clip, 50,000-note project with a full
  automation load).
- **Opening or reloading a project with automation clips no longer crashes.**
  For a few milliseconds after a load the audio callback could still run the
  old automation plan against the new effect chains, and when the new effect
  landed at the old one's address it wrote through a freed parameter
  (0xC0000005, about 1 in 9 runs of the automation bridge test). Each chain's
  graph now carries a serial that is never reused, and a plan only writes into
  the graph it was resolved against.
- **Undoing or editing during playback no longer crashes the audio engine.** The
  audio callback read the live timeline (tracks, clips, pattern blocks, notes)
  while undo/redo and edits freed the very nodes and note lists it was walking.
  It now plays from a copy published after every commit and pinned per block;
  old copies are freed off the audio thread. A clip gain/fade drag republishes
  only that clip's track (about 0.05 ms on a 5,000-clip project).
- **Web pages can no longer read files off the PC through the media server.** The
  local server behind `<video>`/`<audio>` previews served any path to anyone who
  found its port, with a wildcard CORS header. It now needs a per-session token,
  serves only files under the open project folder and its sources' folders
  (symlinks and `..` resolved first), sends no CORS header, and answers a bad
  `Range` with 416 instead of throwing.
- **Editing a sampler during playback no longer crashes or glitches the engine.**
  Sampler knobs, slot edits and undo/redo rebuilt the samplers in place while the
  audio callback was playing them, which could corrupt memory, and every edit cut
  every sounding note in the project. Samplers are now swapped in as one snapshot
  and freed only after the callback has let go of them, and a knob on one
  instrument leaves the others playing.
- **Sampler changes made outside the sampler panel reach the sound straight away.**
  Slot settings sent with a region edit, relinked or remapped region audio, and a
  deleted region all kept playing from the old sampler until the next Play (a
  deleted region's until the project was reloaded), and undo left the piano-roll
  preview on the undone settings. Every rebuild now replaces any sampler that no
  longer matches its region.
- **Switching Sample Picker sources while one is previewing no longer reads freed
  audio.** `unloadSource` freed the decoded buffer while the audio callback could
  still be mixing it, so clicking source B during A's preview could burst noise or
  crash the engine. The callback now pins the buffer it reads and the unload waits
  for that pin (at most one block's mix) before freeing; the audio thread never frees.
- **Renaming or relabelling a sample no longer wipes the rest of it.**
  `timeline_modifyRegion` replaced the stored region with a partly-parsed default,
  so a Browser rename dropped the swapped audio/video, proxy state, custom label and
  sampler settings, and the loss was saved into the project. It now patches onto the
  existing region.
- **Edits during a video export no longer leak into the output.** The export read
  the live timeline unlocked on its own thread; 6,324 clip moves plus note edits
  during a 412-frame export changed 83 frames. It now exports a frozen copy.
- **A crashing or hanging plugin is noticed much faster during a scan.** Crash
  detection went from 16.1 s to 4.1 s and a hang from 18.1 s to 10.1 s; a full
  rescan of 223 items still gives 218 ok and 5 failed.
- **Duplicate UniFlange entry in the plugin list.** A `.vst3` bundle is now one
  item.
- **A fresh clone can build.** `build.bat`, `build-portable.bat` and `push.bat`
  were gitignored although `CONTRIBUTING.md` and CI pointed at them. They are
  tracked now and pinned to CRLF so `cmd.exe` parses them.

### Not yet committed

- **Motion view.** A second view of the timeline for keyframing, switched with `` ` `` or Edit | Motion in the toolbar (spec `docs/XLETH_MOTION_VIEW_SPEC.md`, rulings in `docs/XLETH_MOTION_VIEW_DESIGN.md`).
  - Property tree per track (Lens, Roam, Masks, Sweep) with key toggles, the live value at the playhead (drag or type to edit), and previous / add / next key buttons. Collapsed rows summarise their keys; dimmed clips or notes show behind the rows for timing.
  - Key editing: box-select across tracks, drag with snapping to note-ons/offs, clip edges, keys and the grid, interpolation menu, delete, copy / paste, nudge. One undo step per gesture. Hit-curve keys are drawn under every note and editable; Ctrl+Alt writes a Nudge key on one note.
  - Graph editor in place (G): selected properties as curves with Bezier handles.
  - **Masks** on Roam (rectangle, ellipse, bezier path; feather, expansion, opacity, Add / Subtract / Intersect, invert, animated shapes), drawn and edited on the viewer, with a pen tool.
  - **Parent**: a track's cell can follow another track's Roam; Alt while choosing keeps it in place. Deleting a parent detaches its children in the same undo step.
  - The Roam and Sweep lanes left the Edit view; a diamond on a track header marks tracks with motion. View state is saved with the project (schema 9). Old projects render byte-identically.

- **Scale X and Scale Y are independent (Roam).** Roam gains Scale Y and a Link scale switch, in the inspector and as Motion rows (Scale X / Scale Y while unlinked). Linked, which is how every existing project loads, one Scale drives both axes and renders exactly as before; unlinking copies the current scale and its keys to Scale Y in one undo step. A parent passes the geometric mean of its two scales to its children.
- **Border crop (Roam).** Crop left / right / top / bottom trim the cell's edges without scaling the picture, so a video changes shape without squishing. Animatable, shown as Motion rows and in the Roam inspector, and drawn by the mask pass (an Intersect rectangle appended after the cell's own masks, so a track with all eight masks can still crop; the mask shader now has nine slots).
- **Video effect parameters animate in the Motion view.** Under each track, a "Video effects" group lists every chain effect with a stopwatch, keys and value cell per continuous parameter (Chroma key tolerance, Outline thickness, TV simulator, Drop shadow, Desaturation and so on; colours, choices and the Echo tap count stay static). Effects now carry a stable id that survives reorder, remove and undo; keys save with the track and old projects are untouched.

The working tree has about 185 modified files on top of this (Lens + Roam
follow-ups, mixer, sidechain and routing, export normalization, ResonanceCore,
render clock, Settings and others). They are not listed above; they go in
`Unreleased` when committed.

Also uncommitted, a timeline responsiveness pass (2026-11-15). When committed it
becomes these bullets:

- **Changed: drawing a clip no longer refetches the project.** Pencil clicks and
  sample / source drops add through `pasteClipsBatch` and splice in the clips
  the engine hands back. Measured in the app on a 3,133-clip project: about
  110 ms per clip down to about 2 ms.
- **Changed: every engine reply is built about twice as fast.** Reply values
  are moved into place instead of deep-copied at each nesting level, and large
  plain replies reach JavaScript through one `JSON.parse`. `timeline_getClips`
  on that project: 145 ms to 77 ms.
- **Changed: undo and redo read pattern blocks and automation once, not twice.**
- **Changed: the timeline no longer re-renders on every play and stop** (an
  unused piece of state), and unused handlers, imports and two retired canvas
  playhead painters are gone.

And an editing correctness pass (same day), found by driving the real engine
with test projects:

- **Fixed: a bulk edit larger than the undo history could not be undone.**
  Pitch-shifting 150 clips, or deleting more than 100 pattern blocks, pushed one
  history entry per item into a 100-entry history; the rest stayed changed for
  good. The engine now groups a gesture into one entry (`undo.beginGroup` /
  `undo.endGroup`), and the timeline's own step counting is gone.
- **Fixed: Ctrl+Z after a multi-step edit could undo too much, or too little.**
  The same grouping: one press per gesture, always. Converting a track to
  Pattern, splitting a pattern block and dropping a source are one entry too.
- **Fixed: splitting or trimming a reversed clip scrambled it.** A reversed clip
  plays its source window backwards; splits handed each half the other's audio,
  and dragging either edge slid the sound instead of trimming that edge.
- **Fixed: a split changed the fades.** Both pieces kept both fades, which
  shortened the fade-in and put a dip at the cut. The fade-in now stays on the
  left piece and the fade-out on the right, at their old lengths.
- **Fixed: Auto-Trim cut into audio.** It measured silence from the start of the
  sample and added that to the clip's existing trim, so a second Auto-Trim (or
  one on a split or hand-trimmed clip) removed real sound. It now measures the
  clip's own window, and the correct end of it for a reversed clip.
- **Fixed: refused and no-op edits left undo entries.** Dropping a clip back
  where it was, renaming to the same name or re-entering the same tempo each
  added a Ctrl+Z that did nothing and wiped the redo history.
- **Fixed: values no edit should produce are refused.** A tempo of 0 turned
  stretch ratios into NaN and saved them; zero-length and negative-position
  clips were accepted.
- **Fixed: a rejected automation or batch edit read freed memory** when the
  engine reported its result.
- **Fixed: a tempo change moved where trimmed clips start.** Trims are stored in
  ticks, so changing the BPM (or importing MIDI with a tempo override) shifted
  every trimmed, split or auto-trimmed clip to a different point in its audio.
  The trim is now rescaled to the same source time; undo restores it exactly.
- **Fixed: Select All skipped pattern blocks.** Ctrl+A now selects them along
  with clips and automation clips.
- **Changed: one split implementation.** The Split tool and the S key both ask
  the engine (`model/ClipSplit.h`); split and Auto-Trim no longer refetch every
  clip.

And a built-in preset set for the stock effects (2026-11-16):

- **Added: factory presets for every stock effect.** 235 new presets across all
  27 effects (GLOSS lists the APEX set), named by what they are for: pitch
  samples, chorus samples, kick / snare / drum bus, bass, the base, SFX and the
  master. Each one writes the effect's whole state, so it sounds the same
  whatever was loaded before it.
- **Fixed: loading or undoing an EQ or Filter preset lost its on/off switches.**
  Band and slot `enabled` flags were sent as booleans, which the engine rejects.
- **Fixed: a saved Filter preset lost its modulation.** A lane's settings were
  written before its type, and choosing the type reset them.
- **Fixed: a Waveshaper preset could show one curve and play another.** A named
  shape now moves the drawn points with it; a custom curve survives a load over
  a named shape.
- **Fixed: Transient Proc's envelope mode was a flat volume change.** It read
  the raw sample against the threshold, so the gate closed at every zero
  crossing and restarted the attack stage; attack raised the whole sound and
  sustain did nothing. Hits are now found from the envelope (fast follower
  jumping +3 dB over the slow one), so each hit on a loop or bus gets its own
  attack, the body gets the sustain setting, and a steady tone never
  re-triggers. Hits are found within about 1.4 ms at any attack speed, and a hit
  landing during the previous hit's sustain cut gets its attack back at once.
  Measured on a drum loop: Kick Punch's attack on every hit, body at exactly its
  sustain value. Five Transient Proc presets now use envelope mode (two new: Drum
  Bus Punch, Drum Loop Snap); Kick Punch, Snare Crack and Chorus Sample Snap
  stay note-triggered for one-clip-per-hit sample tracks.
- **Changed: `bridge/verify_factory_presets.mjs`** loads every factory preset
  into the real engine and checks it reads back as written; `--levels` also
  renders each one and prints its level change.

And Color Grade (2026-11-16), built against `xleth-color-grade-spec.md`:

- **Added: Color Grade at four levels.** Source, Clip (a clip, or a sample on a
  Pattern Track), Layer (a track's cell) and Master (the finished frame), always
  applied in that order. A source's grade is stored once and shows on every
  clip, sample and pattern placement cut from it.
- **Added: the controls.** Exposure, contrast, saturation, vibrance,
  temperature, tint and hue; lift / gamma / gain wheels with a brightness each;
  a master curve plus red, green and blue curves with the picture's histogram
  behind them. The same panel at every level.
- **Added: Auto.** Looks at the whole footage and sets lift, gain, gamma and
  vibrance or saturation for washed-out, colour-cast or over-saturated video.
  It only moves ordinary controls, has a strength, and leaves balanced footage
  alone.
- **Added: bulk apply.** One source's grade, or Auto on each source separately,
  across any number of sources as one undo step. Sources that already have a
  grade are skipped unless you choose to replace them.
- **Added: LUT import (.cube) and scopes** (histogram, waveform, vectorscope).
- **Added: where a look comes from.** A mark on every graded source, sample,
  clip and track; a stack view of every level a picture passes through, with an
  on/off and a jump to each; hold-to-compare in the Preview header.
- **Changed: a grade drag moves the picture while you drag**, in playback and
  paused, and is one undo step on release. Grades save with the project; a
  project without grades renders bit-identically to before and writes no new
  keys.

---

## 1.3.0-beta

Built 2026-11-11. 202 commits since 1.2.3-beta, 2026-09-22 to 2026-11-11.

### Added

- **Four character compressors on a shared `CompressorCore`:** Glue VCA ("glue",
  SSL-bus style), Opto ("opto", LA-2A lineage), FET ("fet", 1176 lineage) and
  Vari-Mu ("varimu", Fairchild lineage). Each has a device in the Devices tab.
- **Resonance Suppressor "New" HQ engine** on a new shared `ResonanceCore`:
  WOLA core, two-speed detector, three live-switchable frame tiers (Fast 512 /
  Normal 1024 / High 2048), aligned dry output, per-bin cut path below 400 Hz,
  engine selector and latency / reduction readouts on the device.
- **Parametric EQ Spectral bands on the same core**, with new `spectral_engine`
  and `spectral_quality` parameters and selectors on the EQ device.
- **UI kit:** Knob, NumberBox, Fader, Meter, Button, IconButton, Toggle,
  SegmentedControl, Select, Tabs, Toolbar, Dialog, Menu and EmptyState on one
  drag grammar, `formatValue`, a modulation ring on Knob and NumberBox, a 20-glyph
  Xleth icon set, and a dev-only gallery.
- **Shell and arrangement rebuild:** mandatory centre region, tabbed detail dock
  (Ctrl+Shift+D for focus mode), transport in the top bar, a bottom hint bar, a
  real selection-driven Inspector, one arrangement with a pinned Snapshots cue lane.
- **Every stock effect is a device** on one device frame (25 stock effects plus
  GLOSS and the video effects), with an Audio | Video switch on the Devices chain.
- **Themes and UI scale:** dark, light and high-contrast themes from one ramp
  table, a global UI scale of 100 to 200% in 10% steps, and a theme editor in
  Settings > Appearance.

### Changed

- **Audio device layer reports what the driver actually does.** Drivers are probed
  in order (ASIO, Windows Audio, Exclusive Mode), the real device type is
  reported, output latency is no longer double-counted, and telemetry is judged
  against the real deadline, which removes false overruns at small buffers.
- **The realtime audio callback no longer allocates, locks or logs.** Plain clip
  and pattern playback went from about 109 allocations per test run to 0, and
  effect `reset()` moved off the audio thread.
- **Effect latency changes reach chain PDC from any path**, so EQ Spectral mode,
  linear phase and oversampling changes move the chain latency.
- **One owner for sample / tick / beat conversion** (`RenderClock`).
- **Mixer, Browser, Sample Picker, Sampler, Piano Roll, Sample Sandbox, FX Graph,
  Settings, Export, MIDI import and all dialogs and menus** moved onto the kit.
- **Preview** placeholder shows only before the first frame, the picture always
  fits on a neutral surround, and the header keeps timecode, FPS while playing,
  a Poster chip and one View menu.
- **Selected rows are an accent tint**, not a side bar, and the accent stays off
  chrome.
- **Cleanup:** removed the workspace backdrop, the Loop Lab overlay UI, the Overdone,
  Transient and Distortion layouts, the Amp Stack ANALOG / MODERN skins, dozens of
  unreferenced components and thousands of lines of dead legacy CSS. The Plugin UI
  Designer is parked outside `src/`.

### Fixed

- **EQ Spectral rewinds its STFT stream** when it re-activates and on un-bypass.
- **EQ parameter snapshot and band clears run on the audio thread**, fixing an RPC
  locking problem; a writer mutex covers the EQ latency refresh.
- **Resonance Suppressor Low Latency no longer allocates in `processBlock`** (48
  allocations per stereo block before); output is bit-identical.
- **Piano Roll no longer asks the engine for a pattern it cannot have.**
- **FX Graph nodes take pointer events again** (drag, select, double-click, menu).
