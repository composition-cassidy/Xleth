# LMMS Architecture Analysis — For XLETH Bug Fixes

Deep dive into five LMMS subsystems, with line-number references and concrete patterns we can copy into XLETH.

---

## 1. Piano Roll Note Dragging

**Files:** `lmms/src/gui/editors/PianoRoll.cpp`, `lmms/include/PianoRoll.h`, `lmms/include/Note.h`

### Key findings

- **Action enum** (`PianoRoll.h:261-271`) gates all drag behavior:
  ```cpp
  enum class Action { None, MoveNote, ResizeNote, SelectNotes,
                      ChangeNoteProperty, ResizeNoteEditArea, Knife, Strum };
  ```
  `m_action` is a single-state machine: what the mouse is currently doing. `Action::None` means "no drag active."

- **Drag anchor stored on `m_currentNote` + "old" snapshot on EACH selected note** (`PianoRoll.cpp:1875, 1899-1910`):
  - `m_currentNote` is the clicked note (the anchor for the drag).
  - On mousePressEvent, LMMS iterates *all selected notes* and stores their original state via `note->setOldKey(note->key())`, `note->setOldPos(note->pos())`, `note->setOldLength(note->length())`.
  - Note stores these snapshot fields as `m_oldKey`, `m_oldPos`, `m_oldLength` (`Note.h:136-142, 177-190`).
  - **The anchor is the snapshot itself, not the live note's current position.** Every move event recomputes `newPos = oldPos + offset`, so drift cannot accumulate.

- **Hit-testing happens ONCE, on mousePressEvent** (`PianoRoll.cpp:1770-1799`):
  - Iterates `notes.rbegin() → notes.rend()` (reverse = topmost note first) and breaks on the first note whose bounds contain the click point.
  - Stores the hit note as `m_currentNote`. **No re-hit-testing happens during drag.**

- **Delta computed from stored mouse-down position** (`PianoRoll.cpp:3060-3071`):
  ```cpp
  int off_x = x - m_moveStartX;                          // pixel delta
  int off_ticks = off_x * TimePos::ticksPerBar() / m_ppb; // tick delta
  int off_key = getKey(y) - getKey(m_moveStartY);        // semitone delta
  off_ticks -= m_mouseDownTick - m_currentPosition;      // correct for scroll
  off_key  -= m_mouseDownKey - m_startKey;               // correct for scroll
  ```
  `m_moveStartX`/`m_moveStartY` are set in mousePressEvent (`:1734-1735`). `m_mouseDownTick`/`m_mouseDownKey` capture the scroll state at press time so that scrolling during drag is compensated for.

- **New position is computed from snapshot** (`PianoRoll.cpp:3146-3150`):
  ```cpp
  TimePos posTicks(note->oldPos().getTicks() + noteOffset);
  int key_num = note->oldKey() + off_key;
  note->setPos(posTicks);
  note->setKey(key_num);
  ```
  This is the **crucial pattern**: never accumulate, always `old + delta`.

- **Resize detection: click within `RESIZE_AREA_WIDTH` of the right edge** (`PianoRoll.cpp:1913-1919`):
  ```cpp
  if (pos_ticks * m_ppb / ticksPerBar > m_currentNote->endPos() * m_ppb / ticksPerBar - RESIZE_AREA_WIDTH
      && m_currentNote->length() > 0) {
      m_midiClip->addJournalCheckPoint();
      m_action = Action::ResizeNote;
      setCursor(Qt::SizeHorCursor);
  } else {
      m_action = Action::MoveNote;
      setCursor(Qt::SizeAllCursor);
  }
  ```

- **Resize uses the same snapshot pattern** (`PianoRoll.cpp:3265-3271`):
  ```cpp
  for (Note *note : selectedNotes) {
      int newLength = qMax(minLength, note->oldLength() + off_ticks);
      note->setLength(TimePos(newLength));
  }
  ```

- **mouseMoveEvent gates by `m_action`** (`PianoRoll.cpp:2540-2542`):
  ```cpp
  if (me->buttons() & Qt::LeftButton && m_editMode == EditMode::Draw
      && (m_action == Action::MoveNote || m_action == Action::ResizeNote)) {
      dragNotes(pos.x(), pos.y(), alt, shift, ctrl);
  }
  ```
  `dragNotes()` is only called when `m_action` explicitly indicates a drag is in progress.

- **mouseReleaseEvent commits and resets** (`PianoRoll.cpp:2370-2443`):
  - If MoveNote: calls `m_midiClip->rearrangeAllNotes()` (re-sorts note vector by start time).
  - Stops all playing preview notes.
  - Sets `m_currentNote = nullptr` and `m_action = Action::None`.
  - Undo history was already pushed *at drag start* via `addJournalCheckPoint()`, not at release.

- **Journal checkpoint at drag START, not at release** (`PianoRoll.cpp:1917, 1945`): This means any drag is captured in undo history the moment the user begins moving, before any modification occurs.

### Summary of LMMS drag flow

```
mousePressEvent:
  1. reverse-iterate notes → hit test → m_currentNote = hit
  2. store m_moveStartX/Y (mouse pixels), m_mouseDownTick/Key (scroll)
  3. for each selected note: note->setOldPos/Key/Length(current values)
  4. detect tail hit → m_action = ResizeNote, else m_action = MoveNote
  5. addJournalCheckPoint()

mouseMoveEvent:
  if (m_action == MoveNote || ResizeNote):
    off_ticks = (x - m_moveStartX) * ticksPerBar / m_ppb  — corrected for scroll
    off_key   = getKey(y) - getKey(m_moveStartY)          — corrected for scroll
    for each selected note:
       note.pos = note.oldPos + off_ticks  (NEVER note.pos + delta)
       note.key = note.oldKey + off_key

mouseReleaseEvent:
  rearrangeAllNotes()  (re-sort by pos)
  m_currentNote = nullptr
  m_action = None
```

---

## 2. Sampler / Instrument Architecture

**Files:** `lmms/include/InstrumentTrack.h`, `lmms/src/tracks/InstrumentTrack.cpp`, `lmms/plugins/AudioFileProcessor/AudioFileProcessor.{h,cpp}`

### Key findings

- **Settings live on the TRACK, not on clips/patterns.** There is one `Instrument*` per `InstrumentTrack` (`InstrumentTrack.h:302`). Clips reference their parent track (`MidiClip::m_instrumentTrack`).

- **ADSR is on the track via `InstrumentSoundShaping m_soundShaping`** (`InstrumentTrack.h:303`). The envelope is queried at voice level: `m_instrumentTrack->m_soundShaping.releaseFrames()` (`NotePlayHandle.cpp:416`).

- **Root note is on the track via `IntModel m_baseNoteModel`** (`InstrumentTrack.h:283`). Default 69 = A4. `masterKey()` adds the base note as a transposition offset (`InstrumentTrack.h:110`).

- **Key range is on the track** (`InstrumentTrack.h:284-285`): `m_firstKeyModel` and `m_lastKeyModel`. MIDI input events outside this range are silently dropped (`InstrumentTrack.cpp:337`).

- **AudioFileProcessor (the sampler plugin)** stores all sample-playback settings as per-track `FloatModel`/`BoolModel`/`IntModel` members:
  - `m_ampModel`, `m_startPointModel`, `m_endPointModel`, `m_loopPointModel` (`AudioFileProcessor.h:99-102`)
  - `m_reverseModel`, `m_loopModel`, `m_stutterModel`, `m_interpolationModel` (`AudioFileProcessor.h:103-106`)
  - `m_sample` is the sample data itself.
  - **One sample per instrument.** If you want a different sample on the same track, you replace `m_sample`.

- **noteOn → NotePlayHandle flow:**
  - Song playback: `InstrumentTrack::play()` iterates clips, finds notes whose `pos()` matches the current playhead, and calls `NotePlayHandleManager::acquire(...)` to create a NotePlayHandle per note (`InstrumentTrack.cpp:789-799`).
  - MIDI input: `processInEvent(MidiNoteOn)` creates a NotePlayHandle with `frames = INT_MAX/2` so it plays until explicit noteOff (`InstrumentTrack.cpp:339-347`).
  - **`m_notes[NumKeys]` array** (`InstrumentTrack.h:271`) is indexed by key and tracks currently-playing live MIDI notes — enforces one voice per key for live input (not for clip playback).

- **noteOff flow** (`InstrumentTrack.cpp:357-374`):
  ```cpp
  case MidiNoteOff:
      if (m_notes[event.key()] != nullptr) {
          Engine::audioEngine()->requestChangeInModel();
          m_notes[event.key()]->noteOff(offset);   // ← starts release envelope
          m_notes[event.key()] = nullptr;
          Engine::audioEngine()->doneChangeInModel();
      }
  ```
  `NotePlayHandle::noteOff()` sets `m_released = true` and `m_releaseFramesToDo = soundShaping.releaseFrames()` (`NotePlayHandle.cpp:369-409`). **The note is NOT killed** — it continues playing for the release-envelope duration.

- **Sample playback state is per-voice via `m_pluginData`** (`AudioFileProcessor.cpp:147-149`):
  ```cpp
  _n->m_pluginData = new Sample::PlaybackState(interpolationMode);
  static_cast<Sample::PlaybackState*>(_n->m_pluginData)->setFrameIndex(m_nextPlayStartPoint);
  ```
  Each NotePlayHandle carries its own sample playback cursor, independent of other voices.

- **Per-voice frame counter drives the sampler's pitch shift** (`AudioFileProcessor.cpp:159-162`):
  ```cpp
  m_sample.play(_working_buffer + offset, ..., DefaultBaseFreq / _n->frequency())
  ```
  Rate is `DefaultBaseFreq / note.frequency` — so a note at the base frequency plays at 1.0x, higher notes at >1.0x (shorter), lower notes at <1.0x (longer).

- **Transport stop bypasses release entirely.** See section 4.

### Instrument architecture summary

```
InstrumentTrack (per track)
├── m_instrument: Instrument*           ← ONE plugin instance per track
│   └── (AudioFileProcessor)
│       ├── m_sample                     ← ONE loaded sample per track
│       ├── m_startPointModel, m_endPointModel, m_loopPointModel
│       ├── m_reverseModel, m_loopModel, m_ampModel
│       └── m_interpolationModel
├── m_soundShaping: InstrumentSoundShaping ← ADSR
├── m_baseNoteModel                       ← root note (per-TRACK)
├── m_firstKeyModel, m_lastKeyModel       ← key range (per-TRACK)
├── m_piano: Piano                        ← piano UI model
└── m_notes[NumKeys]: NotePlayHandle*     ← active live-input voices
```

**None of these settings are per-clip.** Every MidiClip on a track uses the same sampler settings.

---

## 3. Pattern / MidiClip Architecture

**Files:** `lmms/include/MidiClip.h`, `lmms/src/tracks/MidiClip.cpp`, `lmms/include/PatternStore.h`, `lmms/include/Clip.h`

### Key findings

- **Clips auto-resize BY DEFAULT.** `Clip::m_autoResize = true` on construction (`Clip.h:176`). Every operation that changes notes calls `updateLength()`.

- **Pattern length is recomputed every time notes change** (`MidiClip.cpp:126-151`):
  ```cpp
  void MidiClip::updateLength() {
      if (getAutoResize()) {
          tick_t max_length = TimePos::ticksPerBar();  // minimum = 1 bar
          for (const auto& note : m_notes) {
              if (note->length() > 0) {
                  max_length = std::max<tick_t>(max_length, note->endPos());
              }
          }
          changeLength(TimePos(max_length).nextFullBar() * TimePos::ticksPerBar());
          setStartTimeOffset(TimePos(0));
          updatePatternTrack();
      }
  }
  ```
  - **Minimum 1 bar enforced.** `max_length` starts at `ticksPerBar()`.
  - **Rounds UP to next full bar.** `nextFullBar()` always extends, never trims mid-bar.
  - **Notes past pattern end → pattern grows.** Because `updateLength()` is called from `addNote()`.
  - **Delete a note → pattern may shrink.** `removeNote()` also calls `updateLength()` (`MidiClip.cpp:210, 230`). So deleting the last note in a bar causes the clip to shrink back to 1 bar.

- **Whenever notes change, `updateLength()` fires** — called from `addNote()`, `removeNote()`, `clearNotes()`, and the piano roll's `dragNotes()` (`PianoRoll.cpp:3275`).

- **If user manually resized clip, auto-resize is disabled.** Code elsewhere sets `setAutoResize(false)` when the user drags the clip edge in the Song Editor. That lets users lock pattern length.

- **Notes are stored in a sorted `NoteVector`** (`MidiClip.h:155`). `addNote()` does an in-order insertion via `std::upper_bound` with `Note::lessThan` (sort by pos then descending key) (`MidiClip.cpp:188`). **After drag, `rearrangeAllNotes()` re-sorts the whole vector** (`MidiClip.cpp:253-257`).

- **PatternStore is a SEPARATE TrackContainer for beat/pattern editor** (`PatternStore.h:39-63`). It is not the same as Song Editor clips:
  - PatternStore owns its own Tracks × PatternClips grid.
  - Song Editor's "PatternTracks" hold "PatternClips" that are **just empty placeholders referencing a pattern in PatternStore**.
  - This is LMMS's dual-mode: traditional beat/pattern workflow vs. linear song arrangement.

- **Placing patterns on the song timeline:** `InstrumentTrack::createClip(pos)` creates a `MidiClip` whose `startPosition` is `pos`. When the playhead crosses a clip's `startPosition`, its notes get played by `InstrumentTrack::play()` (`InstrumentTrack.cpp:697-806`).

### Pattern architecture summary

```
MidiClip
├── m_notes: NoteVector (sorted by pos)
├── m_steps: int                  ← step sequencer support
├── m_autoResize: bool (default TRUE)
└── updateLength() {
       max = max(ticksPerBar, all note endPos)
       length = nextFullBar(max) * ticksPerBar
    }
    called from: addNote, removeNote, clearNotes, dragNotes, rearrangeAllNotes
```

---

## 4. Transport Stop Behavior

**Files:** `lmms/src/core/Song.cpp`, `lmms/src/core/AudioEngine.cpp`, `lmms/src/core/NotePlayHandle.cpp`, `lmms/include/NotePlayHandle.h`

### Key findings

- **Transport stop kills ALL active voices IMMEDIATELY** — it does NOT respect release envelopes.

- **`Song::stop()` calls `Engine::audioEngine()->clear()`** (`Song.cpp:694`).

- **`AudioEngine::clear()` sets a flag picked up on the audio thread** (`AudioEngine.cpp:347-350`):
  ```cpp
  void AudioEngine::clear() { m_clearSignal = true; }
  ```

- **On the next audio frame, `clearInternal()` runs and pushes ALL non-InstrumentPlayHandles to the removal list** (`AudioEngine.cpp:371-381`):
  ```cpp
  void AudioEngine::clearInternal() {
      for (auto ph : m_playHandles) {
          if (ph->type() != PlayHandle::Type::InstrumentPlayHandle) {
              m_playHandlesToRemove.push_back(ph);
          }
      }
  }
  ```
  The comment on line 369 says it all: *"removes all play-handles. this is necessary, when the song is stopped → all remaining notes etc. would be played until their end"*.

- **Compare to `NotePlayHandle::noteOff()`** (`NotePlayHandle.cpp:369-409`): this sets `m_released = true` and schedules `m_releaseFramesToDo` — the note continues to play for the release envelope duration. This is **NOT** what stop does. Stop is more aggressive: it just yanks play handles out of the engine.

- **There IS a softer path: `InstrumentTrack::silenceAllNotes(bool removeIPH)`** (`InstrumentTrack.cpp:525-546`): clears `m_notes[]` array, clears `m_processHandles`, then calls `removePlayHandlesOfTypes(this, NotePlayHandle | PresetPreviewHandle)`. Still hard removal — just scoped to one track.

- **NotePlayHandle's `isFinished()` normally depends on release envelope** (`NotePlayHandle.h:116-119`):
  ```cpp
  bool isFinished() const override { return m_released && framesLeft() <= 0; }
  ```
  Under normal noteOff, the engine keeps calling `play()` on the handle until `isFinished()` returns true. But under transport stop, the engine skips this entirely and removes the handle.

### Transport stop summary

```
User hits stop
→ Song::stop()
  → Engine::audioEngine()->clear() sets m_clearSignal=true
    → Next audio frame: clearInternal() moves every NPH to removal queue
      → Play handles are deleted, voices are cut
→ emit stopped(); emit playbackStateChanged();

This is a HARD CUT. Release envelopes are bypassed.
noteOff() is only used for note END during playback or live MIDI release.
```

---

## 5. Keyboard Focus / Shortcut Scoping

**Files:** `lmms/src/gui/editors/PianoRoll.cpp`, `lmms/include/PianoRoll.h`

### Key findings

- **LMMS uses Qt's standard widget focus system — no manual scoping.**

- **PianoRoll sets `Qt::StrongFocus`** (`PianoRoll.cpp:416`):
  ```cpp
  setFocusPolicy(Qt::StrongFocus);
  ```
  This means the widget accepts focus from tab AND from mouse click. Qt then routes `keyPressEvent` to whichever widget has focus.

- **PianoRollWindow forwards focus to its editor** (`PianoRoll.cpp:5832-5836`):
  ```cpp
  void PianoRollWindow::focusInEvent(QFocusEvent* event) {
      m_editor->setFocus(event->reason());
  }
  ```
  Clicking the window title bar → window gets focus → it delegates to the inner PianoRoll widget.

- **`keyPressEvent(QKeyEvent* ke)` is a standard QWidget override** (`PianoRoll.cpp:1293`). Qt only calls it when the PianoRoll widget has keyboard focus. There is NO "am I the active window?" check at the top of the function.

- **One exception: entering Selection mode checks `isActiveWindow()`** (`PianoRoll.cpp:1522`):
  ```cpp
  case Qt::Key_Control:
      if (!(ke->modifiers() & Qt::ShiftModifier) && isActiveWindow()) {
          m_editMode = EditMode::Select;
      }
  ```
  This is a safety check — if the PianoRoll is somehow getting Ctrl events while its window isn't active, don't enter selection mode.

- **`focusOutEvent` kills all playing keys** (`PianoRoll.cpp:4207-4216`): when focus leaves the PianoRoll, every key's noteOff is sent. This is critical to prevent stuck notes when the user clicks into another editor mid-performance.

- **Song Editor and PianoRoll live in separate `Editor` subwindows** (likely `QMdiSubWindow` children). Each has its own focus scope. Qt's event routing handles the separation automatically.

### Focus summary

```
Qt Focus System:
- Each editor widget sets Qt::StrongFocus
- Clicking in an editor → Qt moves focus to that widget
- keyPressEvent only fires on the focused widget
- PianoRollWindow forwards focus down to its inner PianoRoll
- focusOutEvent releases all pressed keys (no stuck notes)

LMMS does almost NO manual focus checking. It trusts Qt.
```

---

## What LMMS Does Differently From XLETH (Potential Bug Fixes)

### Drag snapshot pattern
LMMS's crucial insight: **every selected note stores its own `oldPos/oldKey/oldLength` snapshot on mousePressEvent**, and mouseMoveEvent always computes `newPos = oldPos + delta`. If XLETH is storing the drag anchor once (e.g., "original click position") and then doing `note.pos += frame_delta` accumulatively, drift and off-by-one errors will accumulate. **Copy LMMS's snapshot-on-press pattern.**

### Single Action enum governs all mouse states
LMMS has one `m_action` enum and one `m_currentNote` pointer. If XLETH has multiple boolean flags (`is_dragging`, `is_resizing`, `has_clicked_note`, etc.), state can desync. **Collapse to one enum.** Reset both `m_currentNote = nullptr` and `m_action = None` in mouseReleaseEvent.

### Never re-hit-test during drag
LMMS hit-tests once on press, stores the reference, and never looks at the note vector again during drag. If XLETH re-hit-tests during drag, the note under the cursor may change (because the dragged note has moved), causing the drag target to "switch" mid-drag.

### Resize area is a pixel zone, not just "on the edge"
`RESIZE_AREA_WIDTH` pixels from the right edge of the note triggers resize. Not "pixel-perfect on the edge". This gives users a forgiving tail grab zone.

### Journal checkpoint at drag START
LMMS calls `addJournalCheckPoint()` on mousePressEvent before any modification. If XLETH pushes undo on mouseReleaseEvent, users who abort a drag with Esc may have stuck modifications or empty undo entries.

### Pattern auto-resize pattern
LMMS recomputes pattern length every time notes change, in a single function (`updateLength()`) that is called from everywhere: `addNote()`, `removeNote()`, `clearNotes()`, drag end. If XLETH has pattern-growing logic scattered across multiple places, it will miss cases. **Have ONE `updateLength()` call site and invoke it from every mutation.**

### Minimum clip length of 1 bar, rounded to next bar
LMMS never lets a clip be shorter than 1 bar, and rounds the computed length up to the next bar boundary. This prevents visual clipping issues and weird half-bar clips.

### Sampler state is per-voice via opaque pointer
Per-voice playback state goes in `NotePlayHandle::m_pluginData`. The instrument doesn't carry per-voice state. If XLETH's sampler has sample state directly on the Instrument (not per-voice), you'll get phase cancellation when two voices play at once.

### Transport stop uses hard cut, not noteOff
LMMS's `Song::stop()` removes all play handles from the engine on the next audio frame — it does NOT allow release envelopes to play out. This is intentional: otherwise users would hear reverb/release tails after pressing Stop. If XLETH is sending noteOff to active voices on transport stop and hearing "lingering" notes, **switch to hard removal**.

### Qt focus policy does the work
LMMS sets `Qt::StrongFocus` on each editor widget and trusts Qt. It does NOT check "which editor is active" in keyPressEvent. If XLETH is manually routing keyboard events between editors (e.g., a global event filter that dispatches based on a `currentEditor` variable), **delete that code and use widget focus instead**.

### focusOutEvent clears playing notes
When PianoRoll loses focus, LMMS sends noteOff for every key. This prevents stuck notes from mid-performance clicks into other editors. If XLETH has "stuck note" bugs, add a focusOut handler.

---

## Patterns to Copy From LMMS

1. **Snapshot-on-press for drag anchors** — store `oldPos/oldKey/oldLength` on each selected note at mousePressEvent; compute `new = old + delta` every frame; never mutate the running state from itself.

2. **Single `Action` enum state machine** — collapse multiple drag flags into one enum. Reset on mouseReleaseEvent.

3. **Scroll-compensated delta math** — `off_ticks -= m_mouseDownTick - m_currentPosition` so dragging while the user also scrolls stays consistent.

4. **`updateLength()` called from every mutation** — pattern length updates live at the clip's edge in ONE function.

5. **Per-voice sampler state via `m_pluginData`** — don't let Instrument carry playback state; put it on the NotePlayHandle.

6. **Transport stop = hard cut via `AudioEngine::clear()`** — use a signal flag and remove play handles from the audio thread.

7. **Let Qt's focus system handle keyboard scoping** — `setFocusPolicy(Qt::StrongFocus)` on each editor, nothing more.

8. **focusOutEvent releases all live notes** — prevents stuck keys on focus changes.

9. **Forgiving hit zones** — `RESIZE_AREA_WIDTH` pixels of tolerance for resize-vs-move decisions.

10. **Undo checkpoint at action START, not end** — ensures aborted actions are still tracked correctly.

---

## What LMMS Gets Wrong (Avoid These)

1. **`m_currentNote` is a raw pointer with no lifetime guarantees.** If another thread deletes the note between mousePress and mouseRelease, the pointer dangles. LMMS papers over this with `instrumentTrack()->lock()` in `addNote/removeNote` but the piano roll itself doesn't hold the lock during drag. **In XLETH, use a stable note ID (UUID or index into a stable container) instead of a raw pointer.**

2. **The Action enum is large and has grown organically** (Knife, Strum were added later). Detection logic for these is scattered through mousePressEvent/Move/Release via `if (m_editMode == EditMode::Knife && ...)`. **Prefer a visitor-pattern or per-action handler object.**

3. **`m_notes[NumKeys]` hard-coded array for live-input voices** enforces mono-per-key. If a user presses a key twice quickly (before release), the second press is silently ignored. **For XLETH, consider allowing voice stacking per key** (retrigger the previous voice's release, start a new voice).

4. **`rearrangeAllNotes()` re-sorts the ENTIRE vector on every mouse release** even if only one note moved. O(n log n) per drag. **Could be O(log n) with a proper sorted container or by moving only the changed elements.**

5. **`isActiveWindow()` check on Ctrl key is a symptom of event leakage.** The fact that they had to add this check suggests their focus system IS occasionally wrong. If XLETH can use pure Qt focus correctly from day one, that's cleaner.

6. **Pattern length rounds UP to next bar, always.** A user with a 3-beat phrase in 4/4 gets a 1-bar pattern (fine), but a user with a 5-beat phrase gets a 2-bar pattern with a 3-beat empty tail. No mechanism for odd-length clips. **XLETH could support more granular clip lengths if needed.**

7. **Journal checkpoints are coarse.** Every drag pushes one checkpoint at start. There's no "undo the last semitone of movement" — only "undo the whole drag". Generally fine, but LMMS has no drag-granularity undo.

8. **Transport stop is globally hard.** There's no fade-out on stop. Users get a click/thump if notes were loud when stopped. **XLETH could optionally crossfade to silence on stop** (but this is a feature, not a bug).

9. **MIDI clip `addNote()` does in-order insertion with `upper_bound` but drag breaks sort order, requiring `rearrangeAllNotes()`.** The data structure's invariant (sorted) is violated temporarily during drag. **XLETH could maintain the invariant by moving notes one-at-a-time within the sorted structure, though this may be over-engineering.**

---

# Part 2 — Deeper Dive (Effects, Export, Automation, Clipboard, MIDI Import)

Five more LMMS subsystems, same format.

---

## 6. Effects / Mixer Routing

**Files:** `lmms/include/EffectChain.h`, `lmms/src/core/EffectChain.cpp`, `lmms/include/Effect.h`, `lmms/src/core/Effect.cpp`, `lmms/include/Mixer.h`, `lmms/src/core/Mixer.cpp`

### Key findings

- **EffectChain is a flat `std::vector<Effect*>`** (`EffectChain.h:75`). No tree, no DAG inside the chain — effects process strict left-to-right. The owning chain calls each effect in order:
  ```cpp
  // EffectChain.cpp:188-204
  bool EffectChain::processAudioBuffer(AudioBuffer& buffer) {
      if (m_enabledModel.value() == false) return false;
      buffer.sanitizeAll();
      bool moreEffects = false;
      for (Effect* effect : m_effects)
          moreEffects |= effect->processAudioBuffer(buffer);
      return moreEffects;
  }
  ```

- **Every track and every Mixer channel owns its own EffectChain** (`Mixer.h:132` MixerChannel::m_fxChain, plus InstrumentTrack's per-track chain). Master is a MixerChannel too, and has its own chain.

- **Chain-level `m_enabledModel` is a cheap bypass.** One branch skips the entire chain. This is separate from per-effect enabled.

- **EffectChain returns "more work" boolean.** If all effects in the chain returned false (nothing running, no tails), the caller can mark the chain as sleeping for next period. Scheduler-friendly.

- **Each Effect owns its own wet/dry/gate/auto-quit models** (`Effect.h:98-106`):
  ```cpp
  FloatModel m_wetDryModel;       // -1=dry, 0=50/50, 1=wet
  FloatModel m_gateModel;
  TempoSyncKnobModel m_autoQuitModel;
  ```
  Wet/dry mixing is done by the host (Effect base class's processAudioBuffer wrapper), NOT by each plugin.

- **`ProcessStatus` enum drives the auto-quit system** (`Effect.h:146-156`):
  ```cpp
  enum class ProcessStatus {
      Continue,             // MUST run next period
      ContinueIfNotQuiet,   // run until input+output silent for N ms
      Sleep                 // skip — nothing happening
  };
  ```
  EQs return Sleep (no tail). Reverbs return ContinueIfNotQuiet (decay tail). This is the key to low idle CPU.

- **Auto-quit tail counter** (`Effect.cpp:173-200`, `handleAutoQuit`):
  ```cpp
  if (outSum <= 1e-10f) m_silentBuffers++;
  else                  m_silentBuffers = 0;
  if (m_silentBuffers >= m_autoQuitModel.value() * samplesPerMs)
      stopRunning();  // m_running = false, chain skips this effect
  ```
  A reverb whose input has been silent for N ms turns itself off. Wakes on first non-silent input.

- **MixerChannel is a `ThreadableJob`** (`Mixer.h:45-140`) — every mix channel is a unit of parallel work:
  ```cpp
  class MixerChannel : public ThreadableJob {
      EffectChain m_fxChain;
      QVector<MixerRoute*> m_receives;   // channels that feed me
      QVector<MixerRoute*> m_sends;      // channels I feed (incl. master)
      AtomicInt m_dependenciesMet;       // counted down by upstream
      FloatModel m_volumeModel;
      BoolModel m_muteModel, m_soloModel;
  };
  ```

- **`MixerChannel::doProcessing()` runs on a worker thread** (`Mixer.cpp:162-230`):
  ```cpp
  // zero own buffer
  // for each receive: buffer += source.buffer * route.sendAmount
  // m_fxChain.processAudioBuffer(buffer)
  // update m_peakLeft/m_peakRight for VU
  // for each sink in m_sends: if (--sink.m_dependenciesMet == 0) queue(sink)
  ```
  Dependency counting IS the scheduler: when a channel's last upstream finishes, that channel becomes runnable.

- **`masterMix()` at period start sets up the DAG** (`Mixer.cpp:666`):
  ```cpp
  // 1. reset m_dependenciesMet to (num_receives) on every channel
  // 2. queue all leaf channels (zero receives) to AudioEngineWorkerThread
  // 3. workers pop jobs, doProcessing(), signal sinks
  // 4. master is reached last, its output → engine output buffer
  ```
  Pure topological execution. No explicit "process this, then that" code. The graph shape drives execution order.

### Effects / Mixer summary

```
Track output
  └→ EffectChain (per-track)          ← flat vector<Effect*>
       └→ send to MixerChannel
            ├─ EffectChain (per-channel FX)
            ├─ receives sum from upstream channels
            └─ sends out (w/ per-send gain) → other channels → master

MixerChannel scheduling:
  - leaf channels queue first
  - each channel's doProcessing() decrements every sink's dep counter
  - sinks become runnable when their counter hits zero
  - master is the final sink → final buffer → hardware/file

Per-effect:
  ProcessStatus::Sleep → skip
  ProcessStatus::ContinueIfNotQuiet → count silent buffers, auto-stop
  auto-quit timeout = user-tunable (ms)
```

### Patterns to copy

1. **Flat vector of effects per track + per mix channel.** Simple, mutable, easy to UI (drag-reorder). Don't nest.

2. **Auto-quit / sleep for idle effects.** A reverb with no input should be free. Count silent buffers; sleep past threshold; wake on non-silent input. Huge CPU win on large sessions.

3. **Wet/dry mixing at the HOST level (EffectChain base), not per-plugin.** Every effect gets crossfade for free. One knob semantics across all plugins.

4. **Chain enable + effect enable** = two-level bypass. User can A/B a rack OR solo one effect.

5. **Mixer as DAG, not linked list.** Parallelism falls out of the dependency graph. One `ThreadableJob` interface, scheduler doesn't care what the job does.

6. **Dependency counting with atomics.** Branch-free: `if (--counter == 0) queue()`. Lockless worker pool.

7. **`ProcessStatus` enum signals scheduler intent.** Plugins declare "I'm done" / "I might still run" / "I'll keep running". Scheduler decides what to do.

### What LMMS gets wrong

1. **Effects stored as raw `Effect*` in `std::vector`.** No IDs, no stable handles. UI stores indices; if user deletes an effect, other UIs' indices shift silently. **Use stable IDs (UUIDs or monotonic int) in XLETH.**

2. **No parallel routing inside a chain.** You cannot split → process two paths → merge within one chain. Users fake it with Mixer sends (heavy overhead).

3. **Auto-quit timeout is per-plugin, user-set.** No impulse-probing to auto-determine tail length. Plugin authors forget to set it; some plugins run forever.

4. **No cycle detection at route-assignment time.** User can wire A→B→A and hang the scheduler. `checkValidRoute` exists but isn't consistently used at the UI layer.

5. **Master is special-cased in Mixer.cpp.** It's not "just another MixerChannel at index 0" — code assumes index 0, assumes it always exists, can't be deleted. Complicates refactoring.

6. **`m_peakLeft/m_peakRight` are atomics written by audio thread, read by GUI.** No clear memory ordering semantics — on some platforms GUI may see stale peaks or torn values.

---

## 7. Audio Export / Offline Rendering

**Files:** `lmms/include/ProjectRenderer.h`, `lmms/src/core/ProjectRenderer.cpp`, `lmms/include/AudioFileWave.h`, `lmms/src/core/Song.cpp` (export methods)

### Key findings

- **ProjectRenderer is a `QThread` subclass** (`ProjectRenderer.h:40`). Export runs on a background thread; GUI polls progress via `Engine::getSong()->getExportProgress()`. No callbacks-per-buffer.

- **THE CRITICAL PATTERN: export reuses `AudioEngine::renderNextPeriod()` — the SAME call used in realtime playback.** There are NOT two rendering paths. See `ProjectRenderer.cpp:154`:
  ```cpp
  Engine::getSong()->startExport();
  Engine::audioEngine()->renderNextPeriod();   // skip initial empty buffer
  while (!Engine::getSong()->isExportDone() && !m_abort) {
      const auto buffer = Engine::audioEngine()->renderNextPeriod();
      m_fileDev->writeBuffer(buffer.data(), buffer.size());
      // update progress counter
  }
  Engine::audioEngine()->stopProcessing();
  Engine::getSong()->stopExport();
  ```

- **`renderNextPeriod()` is stage-based** (`AudioEngine.cpp:318`):
  ```cpp
  renderStageNoteSetup();    // 0: activate clip notes, spawn NotePlayHandles
  renderStageInstruments();  // 1: instruments fill their buffers
  renderStageEffects();      // 2: per-track effects
  renderStageMix();          // 3: mixer DAG runs
  ```
  Same code path for realtime AND export. **Export correctness = realtime correctness by construction.** Bugs can't diverge.

- **Export is NOT realtime** — it runs as fast as the CPU allows. The output "device" is a file, not audio hardware. No sleep, no ADC/DAC.

- **Export completion** (`Song.cpp:464`):
  ```cpp
  bool Song::isExportDone() const { return m_exporting && m_playPos >= m_exportEndPos; }
  float Song::getExportProgress() const {
      return (m_playPos - m_exportStartPos) / (m_exportEndPos - m_exportStartPos);
  }
  ```

- **`Song::startExport()` / `stopExport()` are the switches** (`Song.cpp:768` stopExport):
  - startExport(): `m_exporting = true`, seek to export start, processAutomations to init at t=0, disable GUI updates.
  - stopExport(): flush, stop transport, re-enable GUI.

- **Per-period streaming write.** Every `FRAMES_PER_PERIOD` samples are handed directly to the encoder. Memory stays flat — a 2-hour export takes the same RAM as a 2-second one.

- **File format via AudioFileDevice subclasses** (`AudioFileWave.h:40-62`):
  ```cpp
  class AudioFileWave : public AudioFileDevice {
      SF_INFO m_si;       // libsndfile info struct
      SNDFILE* m_sf;      // libsndfile file handle
  };
  ```
  WAVE + FLAC use libsndfile. OGG uses libvorbis. MP3 uses lame. Each is a thin AudioFileDevice wrapper.

- **`ExportFileFormat` enum** (`ProjectRenderer.h:45`):
  ```cpp
  enum class ExportFileFormat { Wave, Flac, Ogg, MP3, Count };
  ```

### Export summary

```
User clicks Export:
  → Song::startExport()  — seek to start, set flag
  → ProjectRenderer::run() (QThread):
      loop:
          buf = AudioEngine::renderNextPeriod()
             ↳ SAME stages as realtime
          fileDev->writeBuffer(buf)
      until isExportDone() or abort
  → Song::stopExport()
  → fileDev closes encoder

GUI:
  - progress = getExportProgress() polled every ~100ms
  - remains responsive (separate thread)
```

### Patterns to copy

1. **ONE render pipeline for realtime AND export.** Never write two. Eliminates "mix sounds different exported" bugs by construction.

2. **Export = run pipeline on background thread, write to file.** No special offline-only code path.

3. **Per-period streaming write.** Flat memory footprint. Export 10 hours or 10 seconds — same RAM.

4. **Progress via polling, not per-buffer callbacks.** Avoids cross-thread signal spam. GUI reads `progress` atomic every 100ms.

5. **Dummy audio output during export.** Replace speakers with file encoder; rest of engine doesn't know the difference.

6. **Seek-to-export-start on startExport** + init all automation at t=0. Guarantees deterministic start state.

7. **Start/end are set once at startExport().** Export window is immutable during render.

### What LMMS gets wrong

1. **No metadata (ID3/BWAV) embedding.** Track name, artist, BPM, comments don't carry over to the exported file. User must add tags post-hoc.

2. **No live monitoring during export.** Audio device is replaced; user stares at a progress bar.

3. **No stem / per-track export.** Master only. Users solo + export 20 times for stems. Manual, error-prone, inconsistent.

4. **Export sample rate/buffer = GUI sample rate/buffer.** Can't temporarily push to 96k for mastering while running GUI at 44.1k.

5. **Abort is not atomic.** m_abort set mid-period → partial period dropped → file may have N complete periods already on disk → truncated/invalid file.

6. **No offline render of selected range (other than loop).** If you want just bars 40-48, you either set the loop markers or render the whole song.

---

## 8. Automation System

**Files:** `lmms/include/AutomationClip.h`, `lmms/src/core/AutomationClip.cpp`, `lmms/include/AutomatableModel.h`

### Key findings

- **`AutomationClip` owns a time→value map keyed by tick** (`AutomationClip.h:95`):
  ```cpp
  using timeMap = QMap<int, AutomationNode>;   // key = tick position
  ```
  QMap is a red-black tree: O(log n) lookup, sorted iteration, easy neighbor access.

- **Each node has `inValue` + `outValue` + tangents** (AutomationNode class):
  ```cpp
  float m_inValue;      // value approaching from left
  float m_outValue;     // value leaving to right
  float m_inTangent, m_outTangent;  // for cubic hermite
  ```
  Discontinuous (step) values: in ≠ out at the same node. Continuous: in == out.

- **Three progression types** (ProgressionType enum):
  - `Discrete` — hold outValue of prev node until next node (step function).
  - `Linear` — linear interp from outValue(prev) to inValue(next).
  - `CubicHermite` — cubic spline using tangents.

- **`valueAt(tick)` is the interpolator** (`AutomationClip.cpp:554`):
  ```cpp
  auto v = m_timeMap.lowerBound(tick);
  if (v == begin())  return OUTVAL(v);
  if (v == end())    return INVAL(v-1);   // extrapolate flat past last
  auto prev = v - 1;
  float offset = tick - POS(prev);
  float range  = POS(v) - POS(prev);
  if (Discrete)       return OUTVAL(prev);
  else if (Linear)    return OUTVAL(prev) + offset * ((INVAL(v) - OUTVAL(prev)) / range);
  else /*CubicH*/     /* cubic hermite with tangents */;
  ```

- **Automation is BLOCK-RATE (per-period), not sample-rate.** `valueAt()` called once per `FRAMES_PER_PERIOD`. At 44.1k/256 that's ~5.8ms granularity. Massive CPU savings; occasional zippering on fast automation.

- **`Song::processAutomations()` runs once per period** (`Song.cpp:355`). Iterates active AutomationClips, computes valueAt(currentTick), calls `target->setValue(v)` on each.

- **`AutomatableModel` is the universal base** (`AutomatableModel.h`) for every user-facing knob/slider/dropdown:
  ```cpp
  QVector<AutomationClip*> m_trackedBy;  // who automates me
  ScaleType m_scaleType;                  // display curve
  T m_value, m_minValue, m_maxValue, m_step;
  ```
  If a parameter inherits AutomatableModel, it's automatable. No boilerplate per-parameter.

- **`ScaleType` affects UI only, not storage** (`AutomatableModel.h:80-85`):
  ```cpp
  enum class ScaleType { Linear, Logarithmic, Decibel };
  ```
  Log-scale knobs store linear values; the scale is applied only when mapping mouse-delta → model-delta. Automation curves draw linearly too.

- **ValueBuffer for sample-exact automation.** When zipper-free sweeps matter (filter cutoffs), the model fills a float[frames] buffer, and the consumer reads per-sample. Opt-in; most models don't use it.

- **AutomationClips live on AutomationTracks.** Same clip-on-track abstraction as MidiClips. Multiple clips can automate the same model at different timeline regions.

### Automation summary

```
AutomationTrack
  └─ AutomationClip  (pos=bar4, len=8bars, targets synth.cutoffModel)
       ├─ progression: Linear
       └─ timeMap: QMap<tick, node>
              0:              node(in=0.5, out=0.5)
              ticksPerBar:    node(in=1.0, out=1.0)
              ticksPerBar*2:  node(in=0.2, out=0.2)

Per audio period, Song::processAutomations():
   for each active clip:
       v = clip->valueAt(currentTick)
       clip->target->setValue(v)      ← updates model
           ↳ any instrument reading model sees new value next buffer
```

### Patterns to copy

1. **QMap<int tick, Node> for time-indexed data.** Sorted + O(log n) ops + easy neighbor access. Simpler than a hand-rolled sorted array.

2. **in-value + out-value per node.** One data structure handles step functions AND smooth curves. No branching "is this a step clip?".

3. **Discrete / Linear / CubicHermite = plenty.** Don't over-engineer with 10 curve types. 99% of users pick Linear.

4. **Block-rate by default, sample-rate via opt-in ValueBuffer.** Save CPU for things that need it.

5. **Scale is a display/input concern only.** Store linear, display via scale mapping. Keeps interp math simple.

6. **Universal `AutomatableModel` base class.** Every parameter → automatable, no per-knob wiring. UI can render any AutomatableModel as automation target.

7. **Clips own their automation data.** Same clip UI as notes — users already understand it.

### What LMMS gets wrong

1. **`int` tick key.** No sub-tick resolution. If you ever need fractional positions (micro-timing), the data structure can't represent them without a full rewrite.

2. **CubicHermite tangents are not user-editable in the basic UI.** Users set points; tangents are auto-computed. Curves feel "arbitrary", advanced users hit a wall.

3. **No automation inheritance / copy-link.** Want the same LFO on 5 tracks? Copy the clip 5 times; edits don't propagate.

4. **Block-rate creates stair-stepping on fast sweeps.** A 10ms sweep is a 2-step staircase at 256-frame periods. Zippering on filter cutoff, pan, pitch.

5. **Clip length and timeMap extent are independent.** Nodes past clip end are ignored; last node before clip end extrapolates flat to clip end. No auto "length = max node position".

6. **Automation runs even for silent tracks.** Muted track? Still burns `valueAt()` calls every period. No "skip if track inactive".

7. **No randomization / LFO as first-class automation generators.** You hand-draw an LFO by clicking many nodes. Other DAWs ship LFO/random generators as automation sources.

---

## 9. Copy/Paste + Clipboard

**Files:** `lmms/include/Clipboard.h`, `lmms/src/core/Clipboard.cpp`, `lmms/src/gui/editors/PianoRoll.cpp` (copyToClipboard, pasteNotes)

### Key findings

- **LMMS uses Qt's SYSTEM clipboard** (`Clipboard.cpp:51-68`), not an in-process buffer:
  ```cpp
  void copyString(const QString& str, MimeType mt) {
      auto content = new QMimeData;
      content->setData(mimeType(mt), str.toUtf8());
      QApplication::clipboard()->setMimeData(content);
  }
  QString getString(MimeType mt) {
      return QApplication::clipboard()->mimeData()->data(mimeType(mt));
  }
  ```
  **Copy/paste works across LMMS instances and survives app restarts within the session.** Two LMMS windows? Copy from one, paste in the other.

- **Custom MIME types avoid foreign-app collisions** (`Clipboard.h`):
  ```cpp
  enum class MimeType {
      StringPair,   // "application/x-lmms-stringpair" — drag-drop metadata
      Default       // "application/x-lmms-clipboard"   — editor copy content
  };
  ```
  Other apps won't accidentally paste LMMS blobs; LMMS won't accidentally paste text-editor content.

- **Copy serializes to XML via DataFile** (`PianoRoll.cpp:4676`):
  ```cpp
  void PianoRoll::copyToClipboard(const NoteVector& notes) const {
      DataFile dataFile(DataFile::Type::ClipboardData);
      QDomElement note_list = dataFile.createElement("note-list");
      dataFile.content().appendChild(note_list);
      TimePos start_pos(notes.front()->pos().getBar(), 0);   // REBASE to bar start
      for (const Note* note : notes) {
          Note clip_note(*note);
          clip_note.setPos(clip_note.pos(start_pos));         // subtract start_pos
          clip_note.saveState(dataFile, note_list);
      }
      Clipboard::copyString(dataFile.toString(), Clipboard::MimeType::Default);
  }
  ```
  **Key: rebase positions to the first note's BAR, not its exact position.** Preserves beat-alignment on paste.

- **Paste at timeline cursor, quantized** (`PianoRoll.cpp:4744` pasteNotes):
  ```cpp
  for (each <note> in clipboard xml) {
      Note cur_note;
      cur_note.restoreState(clip_node.toElement());
      cur_note.setPos(cur_note.pos() + Note::quantized(
          m_timeLine->timeline()->pos(), quantization()));
      cur_note.setSelected(true);                // auto-select for drag
      m_midiClip->addNote(cur_note, false);
  }
  ```
  Paste lands at **current playhead**, snapped to quantization. Pasted notes auto-select so user can immediately adjust.

- **`DataFile::Type::ClipboardData`** distinguishes clipboard XML from project-save XML. Different validation, different required-field handling.

- **Serialization is `saveState`/`restoreState`** — the same pair used for saving/loading projects. One serializer, two uses. Clipboard is ~30 extra lines on top of save/load.

### Clipboard summary

```
Copy:
  1. Build DataFile(ClipboardData) — XML document
  2. Rebase positions to first item's bar (not exact tick)
  3. Serialize to UTF-8
  4. QApplication::clipboard()->setMimeData(QMimeData with "x-lmms-clipboard")

Paste:
  1. Read clipboard MIME data
  2. Parse XML via DataFile
  3. For each item: restoreState, shift by (timeline_cursor quantized), select, addNote
  → survives restart, crosses LMMS instances
```

### Patterns to copy

1. **Use the system clipboard via Qt.** Don't roll your own in-process buffer. Cross-instance, cross-session, cross-platform — all free.

2. **Custom MIME type per app** (`application/x-xleth-clipboard`). Isolates from other audio apps.

3. **Reuse your project save/load serializer for clipboard.** ~30 lines of code. Don't write a separate clipboard format.

4. **Rebase on copy (to first item's bar), re-offset on paste (to timeline cursor, quantized).** Users intuitively expect "paste at cursor, respecting internal structure".

5. **Auto-select pasted items.** Immediate drag/nudge after paste.

6. **Snap paste position to current quantization.** Respects user's current grid, not the grid at copy time.

### What LMMS gets wrong

1. **XML text format is fat and slow.** 10k notes round-trip is measurable. Binary would be leaner — but the XML format reuses existing save code (legitimate tradeoff).

2. **One MIME type for ALL editors.** Piano Roll notes, Song Editor clips, Automation nodes share `x-lmms-clipboard`. Pasting wrong-editor content into Song Editor can silently no-op or misbehave. **XLETH should use per-editor MIME subtypes:** `x-xleth-notes`, `x-xleth-clips`, `x-xleth-automation`.

3. **No clipboard history.** One copy replaces the last. Accidentally copied something else? Previous is gone.

4. **No "paste special" dialog.** Paste always goes at cursor. No "paste at original position", "paste at measure N", "paste as new clip".

5. **No "cut" semantics distinct from copy+delete.** Cut is literally `copy(); deleteSelection();`. If delete mid-throws, clipboard is updated but original is half-dead.

6. **Rebase is per-operation, not per-item.** If selection has gaps (e.g., notes at bar 4 AND bar 8), paste preserves the gap. That's correct, but UI never shows the user "your paste will land from bar X to bar X+4".

---

## 10. MIDI Import

**Files:** `lmms/plugins/MidiImport/MidiImport.cpp`, `lmms/plugins/MidiImport/MidiImport.h`

### Key findings

- **Uses the Allegro library** (`Alg_seq`) for MIDI parsing. LMMS does NOT write its own SMF parser. Allegro handles format 0/1, SMPTE vs PPQ timing, running status, meta events.

- **`readSMF()` is the conversion entry point** (`MidiImport.cpp:264`). Walks the Allegro sequence and produces LMMS tracks + clips.

- **Tempo & TimeSignature become AUTOMATION TRACKS, not project properties.** A dedicated AutomationTrack is created; for every tempo event in the MIDI file, a node is added:
  ```cpp
  AutomationTrack* tempoTrack = ...;
  AutomationClip*  tempoPat = new AutomationClip(tempoTrack);
  tempoPat->addObject(&Engine::getSong()->tempoModel());
  // for each TempoEvent at time t: tempoPat->putValue(t, tempo)
  ```
  Tempo changes mid-song are preserved exactly. Same pattern for time-signature changes.

- **One InstrumentTrack per MIDI CHANNEL, NOT per MIDI track.** A MIDI file with 4 tracks all on channel 1 produces ONE LMMS track.

- **`smfMidiChannel` is the intermediate bucket:**
  ```cpp
  struct smfMidiChannel {
      InstrumentTrack* it;        // LMMS track we'll create
      MidiClip*        p;         // one long clip covering the song
      Instrument*      it_inst;   // typically SF2 player
      QString          name;
  };
  smfMidiChannel chs[256];        // lazily populated
  ```
  First note on channel N → create chs[N] on demand. Channels never used stay empty.

- **CC events become AutomationClips.** Volume (CC 7), pan (CC 10), pitch bend → automation on the corresponding InstrumentTrack models:
  ```cpp
  case CC_MSG:
      if (cc_num == 7)          createAutomation(ch.it->volumeModel(), t, value/127.0);
      else if (cc_num == 10)    createAutomation(ch.it->panningModel(), t, (value-64)/63.0);
      else if (cc_num == PITCH) createAutomation(ch.it->pitchModel(), t, value);
  ```
  The imported track *sounds* like the original — volume swells, pan rides, pitch bends are all preserved as editable automation.

- **Note length** = `noteEvt->get_duration() * ticksPerBeat`. Allegro stores durations in beats (floats); LMMS stores in ticks (ints). One multiply → int cast. Some drift on repeated conversions.

- **SF2 program changes are handled specially.** LMMS ships with a built-in SF2 player; importer sets the SF2 program on each channel's instrument so playback matches the source.

- **Channel 10 hard-coded to SF2 drum bank.** Standard GM MIDI convention. Non-GM MIDI files with drums elsewhere import wrong.

- **No auto-merging or auto-splitting.** Each channel → one MidiClip spanning the entire song length. User manually slices in the DAW if needed.

### MIDI Import summary

```
Import song.mid:
  → Alg_seq loads SMF
  → walk events chronologically:
      - TempoEvent     → add node to tempo AutomationClip
      - TimeSigEvent   → add node to timeSig AutomationClip
      - NoteOn+NoteOff → Note(pos, len, key, vel) added to chs[channel].p
      - ProgramChange  → set SF2 program on chs[channel].it_inst
      - CC 7           → add node to volume AutomationClip
      - CC 10          → add node to pan AutomationClip
      - PitchBend      → add node to pitch AutomationClip
  → Channel 10 → SF2 drum kit special path

Result: one InstrumentTrack per used channel,
        one long MidiClip per track,
        plus tempo/timesig/CC automation tracks.
```

### Patterns to copy

1. **Use an existing MIDI parser** (Allegro, midifile, libsmf). SMF is a tar pit — running status, meta events, format variations. Don't roll your own.

2. **Import tempo as automation, not project tempo.** Preserves mid-song tempo changes; user can edit the tempo map visually.

3. **One track per MIDI channel, not per MIDI track.** Matches "piano, bass, drums" user mental model better than file-level grouping.

4. **Import CC data as automation.** User expects imported file to sound the same as source. Volume/pan/pitch all matter.

5. **One long clip per channel by default.** Don't guess phrase boundaries. User slices later in the DAW.

6. **Lazy track creation per channel.** 16-channel array, populated on demand. File using 3 channels → 3 tracks, not 16.

7. **Always set a program change.** Even if instrument mapping is imperfect, something plays. Silent tracks after import confuse users.

### What LMMS gets wrong

1. **Allegro dependency is heavy** (~6k lines of old C++). Its float-beat time representation roundtrips through LMMS int-ticks and drifts.

2. **Drum channel hard-coded to SF2.** No SF2 installed → silent drums on import.

3. **No import-options dialog.** Can't "skip CC", "quantize to 16th", "split by MIDI track index", "ignore channel 10". One-click, take-what-you-get.

4. **Tempo automation added even for constant-tempo files.** A 120-BPM file gets an AutomationClip with one node. Clutters arrangement.

5. **SMPTE-timed MIDI files produce garbage.** LMMS assumes tick-based timing. No SMPTE detection/handling.

6. **Channel 10 assumption breaks non-GM files.** Modern DAWs export drums on arbitrary channels. LMMS always assumes drums on 10.

7. **Pitch bend range not imported.** Hard-coded ±2 semitones (GM default). Guitar-bend MIDI at ±12 imports wrong.

8. **No velocity scaling.** Source MIDI with weird velocity curves imports as-is. No normalize/rescale option.

9. **No pre-import preview.** User imports blind; if wrong, must delete tracks and re-import.
