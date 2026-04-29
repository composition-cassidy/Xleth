# Xleth MIDI Import V1 — Spec & Audit Brief

**Version:** 1.0 (pre-audit)
**Status:** Spec drafted, awaiting Claude Code audit
**Owner:** Krasen
**Scope:** First-pass MIDI import system for Xleth. Sparta Remix-focused, visual-grid-aware, audio-optional per track.
**Depends on:** Existing pattern/sampler system (Phase 2.5), grid compositor (Phase 2/4), mixer (Phase 3)

---

## 0. Purpose of this document

This is **not** an implementation spec. This is a **brief for Claude Code to audit the existing Xleth codebase against**, then report back on what it found. After Claude Code's audit report comes back, the final prompt sequence will be written against confirmed architecture — not assumed architecture.

**Claude Code's job when reading this document:**
1. Read every section below.
2. For every behavior, data structure, IPC path, and UI integration described, find the corresponding existing code in Xleth and report on it.
3. Where the spec assumes infrastructure that may or may not exist, **explicitly answer the open questions in Section 9**.
4. Where the spec describes behavior that conflicts with existing code, flag the conflict.
5. **Do not write any implementation code.** This is a read-only audit pass.
6. Output a structured report (format defined in Section 10).

---

## 1. Feature summary

Xleth needs to import standard MIDI files (`.mid`, `.midi`) and translate them into the existing pattern/track architecture. V1 covers:

- File picker → MIDI parse → preview dialog → user configuration → commit to project
- Multi-track MIDI files: one MIDI track → one Xleth pattern track (with optional drum splitting)
- Tempo handling: stretch (default) or override project tempo
- Drum track detection (channel 10) with optional split-by-note
- Per-track visual-only flag (skip audio processing, keep grid triggers)
- Sample auto-matching by filename, with manual override and "None — assign later" state
- Pitch bend data: detected and warned, **not converted in V1** (slide notes deferred)
- Mid-file tempo changes: detected and warned, **first tempo only used in V1** (tempo automation deferred)

---

## 2. Out of scope for V1 (deferred)

These are explicitly **not** part of V1. Do not design for them, do not leave hooks for them unless the hook is trivial.

- Pitch bend → slide note conversion
- Tempo automation / mid-file tempo change preservation
- CC automation import (mod wheel, expression, sustain, etc.)
- Program change handling
- SMPTE-timed MIDI files (only ticks-per-quarter-note time format supported in V1)
- Type 2 SMF files (Type 0 and Type 1 only)
- MPE (MIDI Polyphonic Expression)
- SysEx data
- MIDI export (this spec is import-only)

If a Type 2 file or SMPTE-timed file is loaded, the dialog shows a clear error: "This MIDI format is not supported in V1." No partial parse.

---

## 3. User flow

1. User invokes "Import MIDI..." (location TBD per audit — File menu? Drag-drop on timeline? Both?)
2. File picker opens, user selects `.mid` / `.midi` file
3. C++ engine performs **fast summary parse** (Phase 1 of two-phase import — see Section 6.2)
4. Import dialog opens, populated with track list, tempo info, warnings
5. User configures per-track options (enable/disable, visual-only, sample assignment, drum split)
6. User clicks **Import** → C++ performs **full parse**, returns binary note data
7. Frontend creates pattern tracks, populates piano roll, assigns samplers
8. Dialog closes, new tracks appear in timeline at playhead position (or position 0 — see open questions)
9. Operation goes through `UndoManager` as a single atomic transaction

**Cancel flow:** User clicks Cancel at any point → dialog closes, zero project changes, no IPC churn.

---

## 4. Import dialog contents

### 4.1 Header section

- File name (read-only display)
- Source tempo (from first tempo event, or 120 BPM default if absent)
- Project tempo (current Xleth project tempo)
- **Tempo override checkbox**, on by default: "Override project tempo to match source"
  - When on: project tempo will change to source tempo on import; existing tracks will shift accordingly (this is expected behavior, not a footgun — confirmed)
  - When off: MIDI notes are stretched to fit project tempo; project tempo unchanged
- **Mid-file tempo warning** (conditional, only shown when source has >1 tempo event):
  - "⚠ MIDI contains tempo changes — only first tempo will be used"

### 4.2 Track list

One row per MIDI track. Tracks with zero notes are filtered out entirely (not displayed).

Each row contains:
- **Enable checkbox** (default: checked) — unchecked tracks are skipped on import
- **Track label**: Track name from MIDI meta event (FF 03), falls back to "Track N" / "Channel N"
- **Note count**: total notes in track
- **Sample picker**: dropdown showing matched sample, or "None — assign later"
  - Auto-match: case-insensitive exact filename match between MIDI track name and sample library filename
  - Manual override: user can pick any sample from existing library
  - "None — assign later" is a valid final state; track imports without a sampler assigned
- **Visual-only toggle**: per-track checkbox, default off
- **Pitch bend warning** (conditional, only shown when track has pitch bend events):
  - "⚠ Pitch bend will be discarded (slide note conversion planned)"
- **Drum track UI** (only for tracks detected as drum, see 4.3)

### 4.3 Drum track UI

Detected via `channel == 10` (1-indexed, JUCE convention).

- **Drum detection indicator**: "⚠ Detected as drum track"
- **Split by note checkbox**, default on: "Split into separate tracks per drum hit"
  - When on: each unique note number becomes its own pattern track, named with GM drum name (C1 → "Kick", D1 → "Snare", etc.)
  - When off: imported as a single pattern track containing all drum notes (FL Studio default behavior)
- **Per-sub-track rows** (when split is on): nested under parent drum track row
  - Each sub-track has: enable checkbox, GM name label, sample picker, visual-only toggle
  - Sub-track sample auto-match: GM drum name → filename (e.g., "Kick" → "kick.wav")

### 4.4 Footer

- **Cancel** button: closes dialog, no changes
- **Import** button: triggers full parse and project mutation

---

## 5. Behavioral spec

### 5.1 Tempo handling

**Source tempo extraction:** First `FF 51 03` (Set Tempo) meta event encountered. Convert microseconds-per-quarter-note to BPM via `60_000_000 / µspqn`. If no tempo event exists, default 120 BPM.

**Override mode (default, checkbox on):**
- Project tempo is set to source tempo via existing project tempo mutation path
- Notes are placed at their original beat positions (no stretching needed)
- Existing tracks in the project shift accordingly — this is the standard DAW behavior and confirmed expected

**Stretch mode (checkbox off):**
- Project tempo remains unchanged
- Notes are stretched: `new_tick = old_tick × (project_BPM / source_BPM)`
- TPQ rescale: `new_tick = old_tick × (project_TPQ / source_TPQ)` if resolutions differ

**Mid-file tempo changes:** Detected during parse. First tempo event used for entire file. Warning shown in dialog. Subsequent tempo events ignored. Document this limitation in user-facing copy.

### 5.2 Note positioning

- Work in ticks throughout the C++ pipeline. Convert to Xleth's 960 PPQ tick resolution at the binary packing step.
- **Never call `convertTimestampTicksToSeconds()`** on the working `MidiFile` — that conversion is destructive and tempo-dependent. Beat positions are tempo-independent (`beat = tick / TPQ`); use them throughout.
- Orphaned note-ons (no matching note-off): default duration of 1 quarter note, log warning.

### 5.3 Velocity

- MIDI velocity (0–127) maps directly to Xleth note velocity (whatever range Xleth uses internally — confirm in audit).
- Velocity-0 note-ons treated as note-offs (JUCE handles this automatically; no special logic needed).

### 5.4 Drum detection and splitting

- **Detection**: `msg.getChannel() == 10` (JUCE 1-indexed).
- **Splitting**: when enabled, each unique note number in the drum track becomes its own pattern track. All notes of that pitch on the parent track move to the new sub-track at velocity 127 (or original velocity — TBD per audit of Xleth's drum sample convention).
- **GM drum naming**: lookup table for notes 35–81. Notes outside this range fall back to "Note <number>".
- **Pre-V1 behavior**: drum split off → single track with all drum notes on the piano roll. This is FL Studio's default behavior and is fine.

### 5.5 Pitch bend

- **Detected per track**: presence flag set if any `0xEn` event found in the track.
- **Discarded during import**: notes are imported without bend information.
- **Warning shown** in dialog row only when bends are detected.
- **No data preservation**: do not pack pitch bend events into the binary buffer or intermediate representation. Cleanly discard.

### 5.6 Visual-only flag

- New field on `TrackInfo` (or equivalent track state object — confirm in audit): `visualOnly: boolean`.
- **When `visualOnly === true`**:
  - `processBlock` for that track's sampler exits immediately, returning silence
  - Grid trigger dispatch fires normally (note-on events still hit the compositor)
  - Mixer strip is visually distinguished (greyed-out, badge, label — exact treatment TBD per audit of mixer strip component)
  - Post-import: user can toggle the flag from the track header
- **Defaults**:
  - On import: respects per-track checkbox state from dialog
  - On manual track creation: false (audio enabled by default for new tracks)

### 5.7 Sample auto-matching

- **Match rule**: case-insensitive exact match on MIDI track name vs. sample filename (without extension)
- **Match domain**: all samples currently loaded in Xleth's sample library/browser (confirm scope per audit)
- **No fuzzy matching, no Levenshtein, no GM-name-to-tag-inference in V1** — keep it dumb and predictable
- **Drum sub-track matching**: GM drum name (e.g., "Kick") matched against sample filenames same way
- **No match**: dropdown shows "None — assign later" placeholder, sampler slot stays empty post-import
- **User can override**: clicking the dropdown shows full sample browser; user selection wins

### 5.8 Undo

- Entire import is one atomic `UndoManager` transaction.
- Undo restores: deleted pattern tracks, restored project tempo (if override was on), restored sample library state if any new samples were referenced.
- **Single undo step** undoes the entire import. No per-track granularity.

---

## 6. Architecture

### 6.1 C++ engine layer

- New module: `MidiImporter` (suggested name, audit existing naming conventions)
- Uses JUCE's `juce::MidiFile` for parsing (already a JUCE project, no new dependency)
- **Two methods exposed via Node-API:**
  - `parseSummary(filePath: string) → JSON string` — fast scan, returns track list, note counts, tempo info, drum/bend detection flags
  - `importFull(filePath: string, options: JSON) → { metadata: JSON, noteData: ArrayBuffer }` — full parse with user options applied, returns binary-packed note data

- **No threading concerns for V1**: parse on the calling thread synchronously. MIDI files are small (typically < 1 MB, < 100K notes). If a user imports a 1M-note file, they can wait. Add `ThreadSafeFunction` async path post-V1 if anyone complains.

### 6.2 Two-phase parse

**Phase 1 — Summary parse (fast, < 50ms even for large files):**
- Read file via `juce::MidiFile::readFrom`
- Extract: time format (TPQ), file type (0/1/2 — reject 2), tempo events (count + first value), time signatures, track count
- Per track: name, channel(s) used, note count, drum flag, pitch bend flag, unique note numbers (for drum split UI)
- Return JSON, no note data yet
- **Failure modes**: file unreadable, unsupported format (Type 2, SMPTE) → return error JSON with `{ ok: false, reason: "..." }`

**Phase 2 — Full parse (only after user clicks Import):**
- Re-parse the file with user options
- Apply tempo override or stretch
- Apply drum splitting per user config
- Skip disabled tracks
- Pack notes into binary buffer (12-byte `PackedNote` struct, little-endian, see Section 7)
- Return `{ metadata, noteData }`

### 6.3 Frontend layer

- New React component: `MidiImportDialog` (modal)
- New Zustand store slice or transient state for import session (TBD per audit of how Xleth handles modal state)
- Dialog opens from menu action / drag-drop event
- Two IPC calls: one on dialog open (summary), one on Import click (full)
- After full parse: hydrate `PackedNote` buffer → call existing pattern-track creation API → existing piano-roll-population code → existing sampler-assignment API
- **Critical**: import path should reuse existing track creation, pattern creation, and sampler assignment APIs. Do not bypass them. If those APIs don't exist as clean entry points, surface that in the audit.

### 6.4 Node-API serialization

Hybrid format:
- **Metadata**: JSON string (track names, tempo info, time signatures, count totals)
- **Note data**: `ArrayBuffer` containing packed 12-byte note structs

Why hybrid: per the research (uploaded PDF), JSON for thousands of notes is ~10x slower than packed binary, and structured N-API objects are unusable at scale. JSON for the small metadata, binary for the bulk.

**`PackedNote` layout (12 bytes, little-endian):**
```
offset 0  (4 bytes): tick               (uint32)
offset 4  (4 bytes): duration in ticks  (uint32)
offset 8  (1 byte):  noteNumber         (uint8, 0-127)
offset 9  (1 byte):  velocity           (uint8, 0-127)
offset 10 (1 byte):  trackIndex         (uint8, refers back to metadata.tracks[i])
offset 11 (1 byte):  flags              (uint8: bit 0 = isDrum, bits 1-7 reserved)
```

**Why `trackIndex` not `channel`**: post-split, drum sub-tracks need their own track identity. The metadata JSON contains the full track list with all drum sub-tracks expanded. `trackIndex` is the index into that final list, computed C++-side after splitting.

**Allocation**: use `napi_create_arraybuffer` (V8-heap-allocated), `memcpy` from C++ buffer. Do not use `napi_create_external_arraybuffer` (crashes in Electron 21+).

---

## 7. File structure proposal

Subject to audit confirmation against existing Xleth conventions:

```
src/
├── engine/
│   └── midi/
│       ├── MidiImporter.cpp          # JUCE-side parse + binary pack
│       ├── MidiImporter.h
│       └── GMDrumMap.h               # Note number → GM drum name lookup
├── bridge/
│   └── XlethAddon.cpp                # New exposed methods: parseMidiSummary, importMidiFull
└── frontend/
    └── components/
        └── MidiImport/
            ├── MidiImportDialog.tsx
            ├── MidiTrackRow.tsx
            ├── MidiDrumSubTrackRow.tsx
            ├── importStore.ts        # Zustand or local state for dialog session
            └── filenameMatch.ts      # Auto-match logic
```

If Xleth's existing structure differs (e.g., engine code lives elsewhere, frontend uses different folder organization), propose corrections in the audit report.

---

## 8. Acceptance criteria for V1

A V1 release of MIDI import is complete when:

1. **Type 0 and Type 1 MIDI files parse correctly.** Type 2 and SMPTE files show clean error message, no partial state.
2. **Multi-track files create one Xleth pattern track per MIDI track** (or per drum sub-track when split is on).
3. **Tempo override works**: project tempo changes correctly, existing tracks shift, undo restores prior tempo.
4. **Tempo stretch works**: notes land at correct positions in the existing project tempo, no project tempo change.
5. **Mid-file tempo changes show warning** in dialog and only first tempo is used; no crash, no silent ignore.
6. **Drum tracks are detected** on channel 10 and the split UI appears.
7. **Drum split creates per-note tracks** named with GM drum names (35–81 range) or "Note N" outside that range.
8. **Visual-only flag works**: ticked tracks produce silence on `processBlock` but their grid triggers fire correctly during playback.
9. **Sample auto-match works**: MIDI track named "Kick" + sample file "Kick.wav" in library = pre-selected in dropdown.
10. **"None — assign later" is a valid import state**: tracks import without samples, can be assigned later via existing track UI.
11. **Pitch bend warning shows** when bend events exist in source; data is cleanly discarded with no leak into note data.
12. **Tracks with zero notes are filtered** out of the dialog entirely.
13. **Cancel button at any point** results in zero project mutation.
14. **Single undo undoes entire import** as one atomic operation.
15. **Performance**: 10K-note file imports in < 500ms wall-clock from Import click to dialog close. 100K-note file in < 3s.

---

## 9. Open questions (Claude Code: please answer in audit)

These are the architecture-dependent unknowns that block prompt-writing. Each needs a concrete answer from the codebase before final prompts are drafted.

### 9.1 Track and pattern infrastructure
- Does `TrackInfo` (or equivalent) exist? Where? What fields does it currently have?
- How are pattern tracks created programmatically? Is there a clean API like `createPatternTrack(opts)` or is creation scattered across UI handlers?
- How are notes added to a pattern's piano roll programmatically? Bulk insert API or per-note add?
- Does the piano roll support 960 PPQ tick resolution everywhere, or are there places that assume different resolution?

### 9.2 Sampler assignment
- How is a sample assigned to a pattern track's sampler programmatically? What's the entry point?
- What's the data model for an "unassigned sampler" — empty slot, null reference, placeholder?
- Where does the sample library live in state? How are samples enumerated?

### 9.3 Project tempo
- Where is project tempo stored? Zustand store? Engine state? Both?
- Is there a `setProjectTempo(bpm)` mutation that goes through `UndoManager` correctly?
- What happens to existing clip/pattern positions when project tempo changes mid-project? (Confirm this is the standard "everything shifts in time" behavior, not "everything stays put and re-stretches".)

### 9.4 Visual-only support
- Does any track-level boolean flag like `visualOnly` already exist? (Memory hints at it being a new addition, but verify.)
- Where in the audio pipeline would the early-exit hook live? `processBlock` of which class?
- Does the grid compositor read note events from a track that's audio-disabled, or does it read from a separate event bus?
- How is the mixer strip rendered? Is there a clean visual-state API or does each strip render its own state?

### 9.5 Undo
- Confirm `UndoManager` supports nested or batched operations as a single atomic transaction.
- What's the existing pattern for "create N tracks + populate notes + assign samplers" as one undo step? Is there an existing flow this can mirror?

### 9.6 Modal dialogs
- How are modal dialogs currently rendered in Xleth? Portal-based? Top-level state? Existing modal component library?
- Where does the menu action "Import MIDI..." get added? File menu? Custom toolbar? Confirm location.
- Is drag-drop of files onto the timeline already wired up for any other file type? If so, MIDI can piggyback on that path.

### 9.7 Node-API bridge
- Confirm `XlethAddon.cpp` is where new C++ functions are exposed.
- Confirm Electron version is 41 (memory says yes); confirm `napi_create_external_arraybuffer` is *not* used anywhere currently (or if it is, that's a pre-existing bug independent of this work).
- What's the existing convention for error returns from C++ → JS? Throw? `{ ok, reason }` object? Confirm so MIDI follows the same.

### 9.8 Sample library scope for auto-match
- Does Xleth have one global sample library, or per-project sample collections, or both?
- Are samples loaded by file path string, or by ID, or both?
- For auto-match: do we match against all loaded samples, samples in the current project, or samples in the user's full library on disk?

### 9.9 Drum convention
- Does Xleth's existing drum-sample convention preserve velocity, or are drums always triggered at fixed velocity?
- When drums are split into sub-tracks, should each sub-track inherit the parent's MIDI track name as a prefix ("Drums - Kick") or stand alone ("Kick")?

### 9.10 Performance / threading
- Is there an existing pattern for long-running engine operations with progress reporting to the UI?
- For V1 we're going synchronous. Confirm Electron's main thread can survive a < 3s synchronous addon call without showing the OS "not responding" dialog.

---

## 10. Audit report format

Claude Code, when you finish the audit, return a structured report with these sections:

### 10.1 Codebase findings
For each of the open questions in Section 9, give a concrete answer with file paths and line numbers. If the answer is "this doesn't exist," say so explicitly.

### 10.2 Conflicts with spec
List anywhere this spec describes behavior that conflicts with existing code. Example: "Spec says project tempo changes shift existing tracks. In `engine/Project.cpp:142`, `setTempo()` does NOT shift tracks; it leaves them at their tick positions. This needs reconciliation."

### 10.3 Missing infrastructure
List anything the spec assumes exists but doesn't. Example: "Spec assumes a clean `createPatternTrack(opts)` API. Current creation is in `MainWindow.tsx:onAddPatternClicked()` and is UI-coupled. Either refactor first or extract a shared function."

### 10.4 Suggested file structure corrections
If the proposed structure in Section 7 doesn't match Xleth's conventions, propose corrections.

### 10.5 Risk callouts
Anything that smells like it could break existing functionality. Example: "Adding `visualOnly` to `TrackInfo` requires migration of saved projects. Need a migration step." Or: "The mixer strip component re-renders all strips on any track-state change; adding a new flag could cause perf regression."

### 10.6 Recommended prompt sequencing
Given everything you found, what's the right order of prompts? The pre-audit guess is:
1. MIDI parser + binary packing (C++)
2. Import dialog UI (React)
3. Sample auto-match logic
4. Full import pipeline (C++ → React → existing pattern/sampler APIs)
5. Visual-only track mode
6. Drum splitting

Confirm or revise based on what you found. If any prompt has a hard prerequisite not yet built (e.g., "we need a `createPatternTrack` API extracted before Prompt 4 can work"), call that out as a Prompt 0.

### 10.7 Estimated complexity
Per prompt, estimate: small (< 200 lines, single file), medium (200–600 lines, 2–4 files), large (600+ lines, multi-layer). This informs model selection (Sonnet for small/medium, Opus for large or cross-layer).

---

## 11. Constraints (carried from project standards)

- Windows-only
- All timeline mutations must route through `UndoManager`
- No engine/Node-API changes from UI prompts; engine work and UI work stay in separate prompts
- Audio thread: no allocation, no locks, no logging
- Build verification step required at end of every implementation prompt: `XLETH\build.bat`
- `#ifdef XLETH_DEBUG` logging with bracketed prefixes (e.g., `[MidiImport]`)
- Report blockers, do not work around them
- No worktrees

---

## 12. After this audit

Once the audit report is back, the workflow is:
1. Review findings, reconcile conflicts, fill in unknowns
2. Decide on any pre-work prompts (Prompt 0 candidates)
3. Write the final prompt sequence with confirmed model + effort assignments per prompt
4. Begin implementation, one prompt at a time, diagnostic-first per the standard rule

**Do not skip the audit.** Writing prompts against assumed architecture is the failure mode this entire process is designed to avoid.
