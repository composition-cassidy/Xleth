# XLETH vs LMMS Audit Report

Diagnostic-only comparison of the current XLETH codebase against the findings in
`LMMS_ANALYSIS.md`. No code changes made.

Legend: **MATCHES** / **PARTIALLY MATCHES** / **DIVERGES**

---

## 1. TRANSPORT STOP — HARD CUT vs NOTEOFF

### (A) Current XLETH behavior
- **`bridge/src/XlethAddon.cpp:1268-1280`** — `Stop()` handler calls
  `audioEngine->getTransport().stop()` then
  `audioEngine->getMixEngine().silenceAllSamplers()` as a main-thread safety net.
- **`bridge/src/XlethAddon.cpp:1282-1293`** — `Pause()` handler mirrors
  `Stop()`: `transport.pause()` + `silenceAllSamplers()`.
- **`engine/src/audio/MixEngine.cpp:110-114`** — `silenceAllSamplers()` iterates
  every loaded Sampler and calls `sampler->allNotesOff()`.
- **`engine/src/audio/MixEngine.cpp:351-362`** — `processBlock()` detects the
  `wasPlaying_ && !isPlaying` transition on the audio thread and fires
  `allNotesOff()` on every sampler, then clears `prevActiveRegionIds_`.
- **`engine/src/audio/Sampler.cpp:41-52`** — `allNotesOff()` hard-resets every
  voice: `v.active = false`, `v.envStage = Off`, `v.envLevel = 0.0f`,
  `v.envPosition = 0.0`, `v.playPosition = 0.0`, `v.noteHeld = false`. **No
  release envelope runs** — voices are zeroed immediately.

### (B) How LMMS does it
Per analysis §4: `Song::stop()` → `AudioEngine::clear()` sets `m_clearSignal`
→ `clearInternal()` pushes every NotePlayHandle onto the removal queue on the
next audio frame. Release envelopes are bypassed entirely.

### (C) Verdict: **MATCHES**
Both Stop and Pause hard-cut all sampler voices via `allNotesOff()`, which
zeros voice state without running the release envelope. This is the same
philosophy as LMMS's hard cut.

### (D) What needs to change
Nothing functional. **Minor cosmetic issue**: the comment at
`MixEngine.cpp:352-353` is misleading — it says *"release any held notes so
sustained envelopes begin their release tail immediately"* but the actual code
path (`allNotesOff()`) does a hard cut, not a release. Consider updating the
comment to reflect the actual behavior: *"Hard-cut all voices on transport
stop — LMMS-style; release tails are intentionally bypassed to prevent
post-stop ringing."*

---

## 2. PIANO ROLL DRAG — SNAPSHOT PATTERN

### (A) Current XLETH behavior
- **`ui/src/components/pianoRoll/PianoRollCanvas.jsx:7-12`** — single
  `ACTION` enum governs all drag state:
  ```js
  const ACTION = { NONE: 'none', MOVE_NOTES: 'move-notes',
                   RESIZE_NOTE: 'resize-note', LASSO: 'lasso' }
  ```
- **`PianoRollCanvas.jsx:244-271`** — `beginDrag()` captures per-note
  snapshots at mousedown:
  ```js
  const originals = new Map()
  if (isMultiMove) {
    for (const n of notesRef.current) {
      if (selectedNoteIds.has(n.id)) {
        originals.set(n.id, { positionTicks, pitch, durationTicks })
      }
    }
  }
  dragStateRef.current = { action, startX, startY, anchorNoteId,
                           originals, previewDeltaTicks, previewDeltaPitch,
                           origDurationTicks, previewDurationTicks }
  ```
  Each selected note's `positionTicks`, `pitch`, `durationTicks` are frozen at
  mousedown into an immutable `Map`.
- **`PianoRollCanvas.jsx:349-369`** — mousemove for MOVE_NOTES reads the anchor
  snapshot, computes the snapped delta from it, and applies that delta to every
  note in `originals`:
  ```js
  const anchorNewBeat = snapBeatToGrid(
    Math.max(0, anchorOrig.positionTicks / PPQ + deltaBeats), modifiers)
  const snappedDeltaTicks = beatsToTicks(anchorNewBeat) - anchorOrig.positionTicks
  ```
- **`PianoRollCanvas.jsx:385-396`** — mouseup commits `newPos = orig.positionTicks
  + ds.previewDeltaTicks` and `newPitch = orig.pitch + ds.previewDeltaPitch`
  per-note. The running state of notes is **never** read during drag.

### (B) How LMMS does it
Per analysis §1: `mousePressEvent` iterates all selected notes and calls
`note->setOldPos/OldKey/OldLength(current_value)` on each. `dragNotes()`
computes `TimePos posTicks(note->oldPos().getTicks() + noteOffset)` and
`key_num = note->oldKey() + off_key` — always `old + delta`, never
accumulating.

### (C) Verdict: **MATCHES**
XLETH implements the exact LMMS snapshot-on-press pattern:
- Single `Action` enum gates drag state.
- Per-note `originals` snapshot captured in `beginDrag()`.
- Every mousemove computes `new = old + delta` from the immutable snapshot.
- No accumulation — drift cannot happen.

### (D) What needs to change
Nothing. Pattern is already correct.

---

## 3. PIANO ROLL — NO RE-HIT-TEST DURING DRAG

### (A) Current XLETH behavior
- **`PianoRollCanvas.jsx:22-36`** — `hitTestNote()` is a standalone function.
- **`PianoRollCanvas.jsx:210` and `:219`** — called only in `handleMouseDown`
  (right-click delete path + left-click pickup path). Stores the result in
  `dragStateRef.current.anchorNoteId`.
- **`PianoRollCanvas.jsx:332-381`** — `onMove` handler (mousemove) reads
  `dragStateRef.current` exclusively; it **never** calls `hitTestNote()`. All
  drag updates come from `ds.anchorNoteId` and `ds.originals.get(ds.anchorNoteId)`.

### (B) How LMMS does it
Per analysis §1: "Hit-testing happens ONCE, on mousePressEvent" — iterates
notes in reverse, breaks on first containing the click, stores in
`m_currentNote`. **No re-hit-testing happens during drag.**

### (C) Verdict: **MATCHES**
XLETH hit-tests once on mousedown, stores the anchor ID + snapshots, and
references only those stored values during drag.

### (D) What needs to change
Nothing.

---

## 4. PIANO ROLL — SCROLL COMPENSATION DURING DRAG

### (A) Current XLETH behavior
- **`PianoRollCanvas.jsx:262-269`** — `dragStateRef.current` is initialized
  with only `startX, startY` (pixel coords relative to container). It **does
  not** store `scrollX` or `scrollY` at drag start.
- **`PianoRollCanvas.jsx:349-369`** — for `MOVE_NOTES`:
  ```js
  const dx = localX - ds.startX
  const dy = localY - ds.startY
  const deltaBeats = dx / pixelsPerBeat
  const deltaPitch = -Math.round(dy / pixelsPerSemitone)
  const anchorNewBeat = snapBeatToGrid(
    anchorOrig.positionTicks / PPQ + deltaBeats, modifiers)
  ```
  The delta is pure container-local pixel difference. If the user scrolls
  while dragging, `localX`/`localY` don't change (they are container-relative
  and the container doesn't move), but the world position under the cursor
  shifts. The code has no term to compensate.
- **`PianoRollCanvas.jsx:371-379`** — for `RESIZE_NOTE`:
  ```js
  const beatAtCursor = (localX + scrollX) / pixelsPerBeat
  ```
  Resize uses `scrollX` live, so it naturally tracks the cursor's world
  position. But this uses *current* `scrollX`, not `scrollX at drag start` —
  the behavior still differs from LMMS's explicit delta compensation.

### (B) How LMMS does it
Per analysis §1:
```cpp
int off_x = x - m_moveStartX;
int off_ticks = off_x * TimePos::ticksPerBar() / m_ppb;
int off_key   = getKey(y) - getKey(m_moveStartY);
off_ticks -= m_mouseDownTick - m_currentPosition;   // ← correct for scroll
off_key   -= m_mouseDownKey - m_startKey;           // ← correct for scroll
```
LMMS stores `m_mouseDownTick` / `m_mouseDownKey` (the scroll state captured at
mousePressEvent) and subtracts the drift (`captured - current`) so the delta
remains consistent even if the user scrolls during the drag.

### (C) Verdict: **DIVERGES**
**MOVE_NOTES has no scroll compensation.** If the user scrolls horizontally or
vertically mid-drag, the selected notes stay anchored to their original world
position — the cursor visually "detaches" from the dragged ghost.

**RESIZE_NOTE works correctly** (via the different mechanism of using live
`scrollX` in `beatAtCursor`), but its approach doesn't generalize to MOVE_NOTES
because MOVE uses delta-based math, not absolute-world-position math.

### (D) What needs to change
1. In `beginDrag()` (line 260-269), capture scroll state at drag start:
   ```js
   dragStateRef.current = { ..., scrollXAtStart: scrollX, scrollYAtStart: scrollY }
   ```
2. In `onMove` for `MOVE_NOTES` (line 349-369), include scroll drift in the
   delta:
   ```js
   const dx = (localX - ds.startX) + (scrollX - ds.scrollXAtStart)
   const dy = (localY - ds.startY) + (scrollY - ds.scrollYAtStart)
   ```
3. `scrollX`/`scrollY` need to be available in the `onMove` closure — either
   pass via `dragStateRef` on every scroll change, or via `scrollXRef`.

---

## 5. PATTERN LENGTH — SINGLE updateLength() CALL SITE

### (A) Current XLETH behavior
- **`engine/src/model/Timeline.cpp:449-475`** — `recalcPatternLength(int patternId)`:
  ```cpp
  constexpr int64_t BAR_TICKS = 3840;  // 960 PPQ × 4 beats
  int64_t rightmost = 0;
  for (const auto& n : pat.notes) {
      const int64_t end = n.position.ticks + n.duration.ticks;
      if (end > rightmost) rightmost = end;
  }
  int64_t bars = (rightmost + BAR_TICKS - 1) / BAR_TICKS;
  if (bars < 1) bars = 1;
  pat.length.ticks = bars * BAR_TICKS;
  cascadeBlockDurations(patternId, oldLength, newLength);
  ```
  Rounds up to next full bar; enforces minimum 1 bar.
- Called from **every** note mutation:
  - `addNoteToPattern()` — Timeline.cpp:503
  - `removeNoteFromPattern()` — Timeline.cpp:525
  - `moveNoteInPattern()` — Timeline.cpp:540
  - `resizeNoteInPattern()` — Timeline.cpp:556
  - `restoreNoteInPattern()` — Timeline.cpp:766

### (B) How LMMS does it
Per analysis §3: `MidiClip::updateLength()` is called from `addNote()`,
`removeNote()`, `clearNotes()`, `dragNotes()`, etc. Min 1 bar, rounds up to
next full bar.

### (C) Verdict: **MATCHES**
XLETH has a single `recalcPatternLength()` called from all 5 note mutation
paths. Same rounding (next bar) and same minimum (1 bar, 3840 ticks).

Additionally, XLETH extends the pattern via `cascadeBlockDurations()`, which
grows any in-sync `PatternBlock` (where `block.duration.ticks == oldLength`)
when the pattern grows — a feature LMMS does not have at this level.

### (D) What needs to change
Nothing. The invariant is held at every mutation site.

*Optional observation:* Unlike LMMS, XLETH doesn't expose an "auto-resize off"
escape hatch. Every mutation forces recompute. If a user ever needs a manually
locked pattern length, this would need a per-pattern `autoResize` flag similar
to LMMS's `Clip::m_autoResize`.

---

## 6. SAMPLER SETTINGS — PER-REGION vs PER-PATTERN

### (A) Current XLETH behavior
- **`engine/src/model/TimelineTypes.h:100-146`** — `SampleRegion` struct owns
  **all** sampler settings:
  - Line 115: `int rootNote = 60`
  - Lines 120-123: `float attackMs, decayMs, sustain, releaseMs`
  - Lines 126-128: `bool loopEnabled; int64_t loopStart, loopEnd`
  - Line 131: `bool crossfadeEnabled`
- **`TimelineTypes.h:207-214`** — `Pattern` struct contains only:
  `id, name, regionId, length, notes, nextNoteId`. **Zero sampler fields.**
- **`engine/src/audio/MixEngine.cpp:81-103`** — `loadSamplerForRegion()` pulls
  every sampler parameter from the `SampleRegion&` argument:
  ```cpp
  s->setRootNote(region.rootNote);
  s->setADSR(region.attackMs, region.decayMs, region.sustain, region.releaseMs);
  s->setLoopPoints(region.loopEnabled, region.loopStart, region.loopEnd);
  s->setCrossfadeMode(region.crossfadeEnabled);
  ```
- **`engine/src/model/Pattern.cpp:21-43`** — JSON serialization of `Pattern`
  does NOT include any sampler fields. The comment at lines 39-42 explicitly
  notes: *"Legacy projects may still carry rootNote/attackMs/... here; those
  are migrated onto the matching SampleRegion by Timeline's loader."*

### (B) How LMMS does it
Per analysis §2: settings live on the TRACK (`InstrumentTrack` →
`Instrument*`). One sample per track; one ADSR envelope per track
(`InstrumentSoundShaping m_soundShaping`); one root note per track
(`IntModel m_baseNoteModel`). **None of these are per-clip.**

### (C) Verdict: **MATCHES**
Sampler settings have been fully moved to `SampleRegion`. The `Pattern` struct
carries zero remnants. This is XLETH's equivalent of LMMS's per-track model:
every Pattern that references the same `regionId` shares the same Sampler
instance (keyed by `regionId` in `MixEngine::samplers_`).

The legacy-migration path in the Timeline loader gracefully upgrades any
previously-saved projects where settings lived on Pattern.

### (D) What needs to change
Nothing.

---

## 7. SAMPLER — PER-VOICE STATE vs PER-INSTRUMENT STATE

### (A) Current XLETH behavior
- **`engine/src/audio/Sampler.h:62-79`** — `Voice` struct owns all per-voice
  playback state:
  ```cpp
  struct Voice {
      bool   active       = false;
      int    midiNote     = 60;
      float  velocity     = 1.0f;
      double playPosition = 0.0;        // fractional sample index
      double pitchRatio   = 1.0;
      enum class EnvStage { Attack, Decay, Sustain, Release, Off };
      EnvStage envStage         = EnvStage::Off;
      float    envLevel         = 0.0f;
      float    releaseStartLevel = 0.0f;
      double   envPosition      = 0.0;
      bool     noteHeld         = false;
  };
  static constexpr int MAX_VOICES = 32;
  std::array<Voice, MAX_VOICES> voices_{};
  ```
- **`Sampler.h:47-60`** — instrument-level state (shared by all voices) is
  separately stored on the Sampler: `sampleData_, sourceSampleRate_, rootNote_,
  attackMs_, decayMs_, sustain_, releaseMs_, loopEnabled_, loopStart_,
  loopEnd_, crossfadeEnabled_`.
- **`engine/src/audio/Sampler.cpp:195-270`** — `processVoice()` reads/writes
  only the passed-in `Voice& v`; the instrument-level fields are read-only
  config.

### (B) How LMMS does it
Per analysis §2: per-voice playback state lives in
`NotePlayHandle::m_pluginData`, which `AudioFileProcessor` casts to
`Sample::PlaybackState*`. Each voice carries its own sample cursor.

### (C) Verdict: **MATCHES**
Playback state (`playPosition`, `envLevel`, `envStage`, `envPosition`,
`releaseStartLevel`) is stored per-voice on the `Voice` struct inside the
`voices_[32]` array. The Sampler class itself holds only the shared instrument
configuration. Two voices of the same pitch would have independent
`playPosition` cursors — no phase cancellation risk.

### (D) What needs to change
Nothing.

---

## 8. COPY/PASTE IN PIANO ROLL

### (A) Current XLETH behavior
- **`ui/src/components/pianoRoll/PianoRoll.jsx:137-224`** — the keydown handler
  handles: tool shortcuts (S/P/C/D — note that **`C` is bound to the Split
  tool here**, not Copy), Ctrl+Z/Y/A, Delete/Backspace, Arrow transposition,
  velocity digits 0-9. **Copy/Paste (Ctrl+C, Ctrl+V, Ctrl+X) are absent.**
- No clipboard API calls anywhere in `PianoRoll.jsx` / `PianoRollCanvas.jsx`.
- No serialization-of-notes logic exists.
- Grep for `clipboard` / `copy` / `paste` in `ui/src/components/pianoRoll/`
  returns no copy/paste handlers.
- `TimelineView.jsx:1250-1345` DOES implement Ctrl+C/V **for clips**, but uses
  `clipboardRef.current` (in-process ref) — NOT the system clipboard, and it's
  clips-only, not notes.

### (B) How LMMS does it
Per analysis §9: Qt system clipboard via `QMimeData` with custom MIME type
`application/x-lmms-clipboard`. Serialization via `DataFile::Type::ClipboardData`
(reuses `saveState`/`restoreState`). On copy, positions are rebased to the
first note's bar. On paste, items land at timeline cursor, quantized, and
auto-selected.

### (C) Verdict: **DIVERGES** (feature missing)
Copy/paste does not exist in the piano roll at all. This is a significant
missing feature. The tool-shortcut `C → split` on the current keymap would
need to be moved (likely `B` or `X`) to free up Ctrl+C.

### (D) What needs to change
1. **Remap the split-tool shortcut** from `C` to something else (e.g. `K` for
   knife, matching LMMS) so `Ctrl+C` is free.
2. **Implement Ctrl+C in `PianoRoll.jsx` onKey:**
   - Collect selected notes from `pattern.notes` filtered by
     `selectedNoteIdsRef.current`.
   - Rebase each note's `positionTicks` relative to the earliest selected
     note's bar start: `rebased = note.positionTicks - firstNoteBarStart`.
   - Serialize as JSON `{ notes: [{positionTicks, durationTicks, pitch,
     velocity}], version: 1 }`.
   - Write to system clipboard via the Clipboard API with a custom MIME type,
     e.g. `application/x-xleth-notes` (fallback: plain-text JSON under
     `text/plain` for cross-app portability).
3. **Implement Ctrl+V in `PianoRoll.jsx` onKey:**
   - Read clipboard, try `application/x-xleth-notes` first, else parse
     `text/plain` as JSON.
   - Compute paste origin = current edit cursor / playhead, snapped to
     current quantization (use existing `snapBeatToGrid`).
   - For each clipboard note: call `window.xleth.timeline.addNote(patternId,
     { positionTicks: origin + rebased, ... })`.
   - Collect returned note IDs, set `selectedNoteIds` to that set (auto-select
     pasted notes, matching LMMS).
4. **Implement Ctrl+X**: copy + delete selected (as in LMMS).
5. **Note**: Electron's renderer process has `navigator.clipboard` (async),
   which supports custom MIME types via `ClipboardItem`. Browsers that lack
   `ClipboardItem` will need a fallback to plain-text JSON.

---

## 9. FOCUS / KEYBOARD SCOPING

### (A) Current XLETH behavior
- **Piano Roll:** `PianoRoll.jsx:142` — guard:
  ```js
  if (activeCenterTab !== 'piano-roll' && !floating) return
  ```
  Also skips INPUT/TEXTAREA targets (line 141). Handlers call
  `e.stopPropagation()` after handling (lines 146-149, 155, 162, 171,
  181-182, 196-197, 213).
- **Timeline:** `TimelineView.jsx:1184-1186` — guard:
  ```js
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return
  if (activeCenterTab !== 'timeline') return
  ```
  Same `stopPropagation()` pattern after handling (e.g. lines 1192, 1207,
  1218, 1227, 1253, 1282, 1349, 1384).
- Both handlers attach via `window.addEventListener('keydown', ...)` — **global
  listeners**, scoped at runtime by the `activeCenterTab` prop.
- **Focus-out / preview-note cleanup:** `handlePreviewNote` in
  `PianoRoll.jsx:124-135` attaches release handlers only for `mouseup` and
  `mouseleave`. There is **no** `blur`/`focusout` handler. Grep confirms:
  `focusout`/`focusOut`/`blur` produce zero matches in the piano roll files
  (and only a `SamplerPanel.jsx` mention of "blur" for a numeric-input commit).

### (B) How LMMS does it
Per analysis §5: `setFocusPolicy(Qt::StrongFocus)` on each editor widget. Qt's
event routing delivers `keyPressEvent` only to the focused widget. Plus
`focusOutEvent` kills all playing keys to prevent stuck notes.

### (C) Verdict: **PARTIALLY MATCHES**
- `activeCenterTab` guard: **PRESENT** — matches LMMS's per-editor-focus
  philosophy in spirit (different mechanism — runtime prop check vs. Qt's
  widget focus).
- `stopPropagation()` after handling: **PRESENT**.
- `focusOut`-style release of playing preview notes: **MISSING** — diverges
  from LMMS.

### (D) What needs to change
Add a stuck-note safety mechanism in `PianoRoll.jsx`:

1. Track currently-held preview pitches in a ref
   (`heldPreviewPitchesRef: Set<number>`), updated in `handlePreviewNote`
   when a note is triggered and when its `release` fires.
2. Attach a `blur` listener to `window` (or `visibilitychange` on
   `document`, or a focusout on the piano roll container):
   ```js
   const onBlur = () => {
     for (const pitch of heldPreviewPitchesRef.current) {
       window.xleth?.timeline?.previewNoteOff?.(regionId, pitch)
     }
     heldPreviewPitchesRef.current.clear()
   }
   window.addEventListener('blur', onBlur)
   ```
3. Consider a similar cleanup when `activeCenterTab` changes away from
   `piano-roll` (in a useEffect cleanup).
4. Check `MiniKeyboard.jsx` and `PianoRollKeyboard.jsx` for the same pattern
   — any UI that fires `previewNote` without a corresponding `previewNoteOff`
   on focus loss should be patched.

---

## 10. UNDO CHECKPOINT TIMING

### (A) Current XLETH behavior
- **`PianoRollCanvas.jsx:244-271`** — `beginDrag()` at mousedown: captures
  snapshots into `dragStateRef.current.originals`. **Does not** call any
  bridge mutation or undo function. No journal checkpoint.
- **`PianoRollCanvas.jsx:382-419`** — `onUp` (mouseup) commits the drag by
  calling `onMoveNote(noteId, newPos, newPitch)` per-note (line 388-391) or
  `onResizeNote(anchorNoteId, previewDurationTicks)` (line 395).
- **`PianoRoll.jsx:102-114`** — those callbacks invoke
  `window.xleth.timeline.moveNote()` / `resizeNote()`, which (in the bridge)
  push undo commands at commit time.
- **Net effect**: one undo entry is created per individual note mutation
  call, at **mouseup** (drag END).

### (B) How LMMS does it
Per analysis §1: `addJournalCheckPoint()` is called at mousePressEvent
(`PianoRoll.cpp:1917, 1945`), BEFORE any modification. A single checkpoint
captures the pre-drag state; mouseRelease just calls `rearrangeAllNotes()`
without another checkpoint.

### (C) Verdict: **DIVERGES**
XLETH pushes undo state at drag **END** (mouseup). LMMS pushes at drag
**START** (mousedown).

Additional consequence: since XLETH emits one bridge call per moved note,
multi-note drags create N undo entries (one per note), not a single batched
"move N notes" entry. A single Ctrl+Z undoes only the last note's move.

### (D) What needs to change
Two options, in order of invasiveness:

**Option A — Minimal (batch mouseup commit):** Add a bridge method
`timeline.moveNotesBatch(patternId, [{id, posTicks, pitch}, ...])` that
packages all moves into a single undo command. Call it once at mouseup
instead of looping `onMoveNote`. This keeps the current mouseup timing but
makes multi-note drags a single undo entry.

**Option B — LMMS-style (checkpoint at drag start):** Add
`timeline.beginUndoGroup()` / `timeline.endUndoGroup()` bridge methods that
wrap a drag with a single "compound action" in the undo stack. Call
`beginUndoGroup()` in `beginDrag()` on mousedown, `endUndoGroup()` in `onUp`.
Individual `moveNote`/`resizeNote` calls during the drag would be captured
as one compound action. This matches LMMS exactly and also handles the
aborted-drag case (Escape key) properly.

Option A is simpler and addresses the multi-note undo-entry bloat. Option B
is the more faithful LMMS port.

---

## 11. EFFECT CHAIN READINESS

### (A) Current XLETH behavior
- **No effect infrastructure exists.**
- **`engine/src/audio/MixEngine.h`** — no `EffectChain`, `Effect`, `FX`,
  `wetDry`, or `bypass` symbols. `grep -i "effect\|EffectChain\|FX"` returns
  no relevant matches.
- **`engine/src/audio/TrackMixer.h:54-63`** — the per-track processing
  pipeline is:
  ```cpp
  static void process(buffer, volume, pan, peakL, peakR) {
      applyVolume(buffer, volume);
      applyPan(buffer, pan);
      measurePeaks(buffer, peakL, peakR);
  }
  ```
  Volume → pan → peak metering. **No effect slots.**
- **`engine/src/model/TimelineTypes.h`** — no effect-related fields on any
  struct (`TrackInfo`, `Pattern`, `SampleRegion`, etc.).
- **Routing**: track buffers are mixed directly into master output via
  `MixEngine::processBlock()`. No sends, no auxiliary busses, no FX channels,
  no MixerChannel DAG.

### (B) How LMMS does it
Per analysis §6: every track and every MixerChannel owns its own
`EffectChain` (a flat `std::vector<Effect*>`). Each effect has
wet/dry/gate/auto-quit. `ProcessStatus` drives sleep/continue decisions.
MixerChannels are scheduled via dependency-counted atomic `ThreadableJob`s.
Two-level bypass (chain enable + effect enable).

### (C) Verdict: **DIVERGES** (feature absent)
No effect infrastructure of any kind. The signal path is purely
track → volume/pan → peak metering → master sum.

### (D) What needs to change
If effects are on the roadmap, the minimal LMMS-inspired structure would be:

1. **`engine/src/audio/Effect.h`** — abstract base:
   ```cpp
   class Effect {
   public:
     virtual ~Effect() = default;
     virtual bool processAudioBuffer(juce::AudioBuffer<float>&, int numSamples) = 0;
     enum class ProcessStatus { Continue, ContinueIfNotQuiet, Sleep };
     virtual ProcessStatus status() const { return ProcessStatus::Continue; }
     std::atomic<bool>  enabled_{true};
     std::atomic<float> wetDry_{1.0f};
   };
   ```
2. **`engine/src/audio/EffectChain.h`** — flat vector of effects with
   per-chain `enabled_` flag and `processAudioBuffer()` that runs the chain
   and applies per-effect wet/dry mixing at the host level.
3. **Add `EffectChain fxChain_` to each track** — inject into `MixEngine`'s
   per-track processing between `applyVolume` and `applyPan` (or after pan,
   depending on routing preference).
4. **UI**: a per-track FX panel with insert/remove/reorder, drag-to-reorder,
   effect enable checkbox, wet/dry knob.
5. **Bridge methods**: `track_addEffect`, `track_removeEffect`,
   `track_reorderEffects`, `track_setEffectParam`, `track_setEffectEnabled`.
6. **Stable effect IDs** (avoid LMMS's index-based pitfall per analysis §6's
   "What LMMS gets wrong").
7. **First built-in effects**: EQ, compressor, delay, reverb.

The auto-quit / `ProcessStatus::Sleep` optimization can be deferred to a
later pass — not needed for initial effect support.

---

## 12. BLOCK EXIT VOICE CUTTING

### (A) Current XLETH behavior
- **`engine/src/audio/MixEngine.h:171-176`** — `prevActiveRegionIds_`
  tracking exists:
  ```cpp
  // Block-exit voice cutting: tracks which regionIds had active blocks on
  // the previous processBlock call. When a regionId drops out (no longer
  // referenced by any active block — block deleted, moved, or playhead
  // jumped away), fire allNotesOff() on that sampler. Shared-sampler safe:
  // only cuts when NO current block references the region.
  std::unordered_set<int> prevActiveRegionIds_;
  ```
- **`engine/src/audio/MixEngine.cpp:219-267`** — `findActivePatternBlocks()`:
  - Builds `activeBlocks_` from the current playhead range (lines 222-247).
  - Computes `currentRegions` from `activeBlocks_` (lines 254-256).
  - For each `rid` in `prevActiveRegionIds_`: if it's NOT in
    `currentRegions`, call `samplers_[rid]->allNotesOff()` (lines 258-265).
  - Replaces `prevActiveRegionIds_` with `currentRegions` (line 266).
- This handles: block deleted, block moved away from playhead, playhead
  seeked to a region with no matching block. Shared-sampler safety: the cut
  only fires when **no** current active block references the region.

### (B) How LMMS does it
LMMS doesn't have the exact "pattern block" abstraction. Per analysis §3-4,
LMMS's per-note lifecycle (NotePlayHandle auto-death on release-complete or
transport stop) handles this naturally at the note level. The moral
equivalent is "when a clip is deleted or moved past the playhead, its still-
ringing notes get cut" — which LMMS handles via `AudioEngine::clear()` on
transport stop but doesn't have a mid-playback block-exit mechanism at all.

### (C) Verdict: **MATCHES** (via a different but cleaner mechanism)
XLETH has explicit and correct `prevActiveRegionIds_` tracking. It's a
stronger invariant than LMMS's — XLETH handles the mid-playback cases that
LMMS cannot (block deleted during playback, playhead jumped to empty region,
etc.) precisely because it has the block abstraction.

The shared-sampler safety check (cut only if no current block references the
region) is the correct design for XLETH's `regionId → Sampler` mapping —
this prevents a pattern move/resize from cutting notes that another pattern
is still using on the same sampler.

### (D) What needs to change
Nothing. The mechanism is already correctly implemented and commented.

---

## Summary Table

| # | Audit Item                              | Verdict            |
|---|-----------------------------------------|--------------------|
| 1 | Transport stop — hard cut               | MATCHES (comment minor) |
| 2 | Piano roll drag snapshot pattern        | MATCHES            |
| 3 | Piano roll no re-hit-test during drag   | MATCHES            |
| 4 | Piano roll scroll compensation          | **DIVERGES**       |
| 5 | Pattern length single call site         | MATCHES            |
| 6 | Sampler settings per-region             | MATCHES            |
| 7 | Sampler per-voice state                 | MATCHES            |
| 8 | Copy/paste in piano roll                | **DIVERGES** (missing) |
| 9 | Focus/keyboard scoping                  | PARTIAL (focusOut missing) |
| 10| Undo checkpoint timing                  | **DIVERGES**       |
| 11| Effect chain infrastructure             | **DIVERGES** (missing) |
| 12| Block-exit voice cutting                | MATCHES            |

---

## Priority Changes

**High** — user-visible correctness bugs:
- **#4 Scroll compensation during drag.** Users who scroll mid-drag will see
  the dragged ghost detach from the cursor. Small fix in `PianoRollCanvas.jsx`.
- **#10 Undo checkpoint timing.** Multi-note drags produce N undo entries
  instead of 1. Single `moveNotesBatch` bridge method solves this.

**Medium** — missing features:
- **#8 Copy/paste in piano roll.** Core DAW workflow. ~80 lines in PianoRoll.jsx
  + a MIME-type strategy.
- **#9 Focus-out preview-note release.** Prevents stuck notes when the user
  clicks away mid-keyboard-play. Small fix.

**Low / roadmap:**
- **#1 Misleading comment** in `MixEngine.cpp:352-353`. One-line fix.
- **#11 Effect chain infrastructure.** Significant new subsystem — schedule
  for a dedicated phase.

**No action needed:** items #2, #3, #5, #6, #7, #12 — all already match
LMMS's intended patterns.
