# XLETH Piano Roll & Pattern Playlist (PatternBlocks) Architecture

## Executive Summary

XLETH implements a three-layer architecture for piano roll and pattern playlist functionality:

1. **C++ Engine Layer** (`engine/src/`): Timeline data model, commands with undo/redo, pattern playback via Sampler
2. **Node-API Bridge Layer** (`bridge/src/XlethAddon.cpp`): IPC bindings exposing engine to Electron
3. **React UI Layer** (`ui/src/`): Interactive components, canvas drawing, tool handling, event-driven updates

**Key Data Structures:**
- `Pattern`: MIDI-like sequence (notes + sampler settings) for one sample region
- `PatternBlock`: timeline placement of a pattern (allows looping/trimming)
- `PatternNote`: single note within a pattern (position, duration, pitch, velocity)
- `TrackInfo::Type { Clip, Pattern }`: tracks can be either clip-based or pattern-based

---

## Layer 1: C++ Engine

### Core Data Model (`engine/src/model/TimelineTypes.h`)

#### TickTime (Musical Time)
- **Base unit:** MIDI ticks at 960 PPQ (pulses per quarter note)
- **Conversion methods:**
  - `fromBeats(double)` → TickTime
  - `toBeats()` → double
  - `toSeconds(double bpm)` → double
  - `toSamples(double bpm, double sampleRate)` → int64_t
- **Operators:** `<`, `==`, `<=`, `>`, `>=`, `+`, `-`

#### VideoFlipMode (`TimelineTypes.h` lines 150-175)
```cpp
enum class VideoFlipMode {
    None,              // No flipping
    HorizontalEven,    // Every even-numbered note flips horizontally
    Clockwise,         // Cycle: normal → flipY → flipXY → flipX → repeat
    CounterClockwise   // Cycle: normal → flipX → flipXY → flipY → repeat
};
```
- Applies per-note video transformation in pattern tracks
- Set via `TrackInfo::videoFlipMode`

#### PatternNote (`TimelineTypes.h` lines 177-186)
```cpp
struct PatternNote {
    int      id;              // unique within pattern
    TickTime position;        // within the pattern (0 = pattern start)
    TickTime duration;        // note length
    int      pitch;           // MIDI note (0-127, 60 = C4)
    float    velocity;        // 0..1; also maps to video opacity
};
```

#### Pattern (`TimelineTypes.h` lines 188-216)
```cpp
struct Pattern {
    int         id;
    std::string name;
    int         regionId;           // which SampleRegion this pattern uses
    TickTime    length;             // user-set pattern length (for loop boundary)
    std::vector<PatternNote> notes;
    int         nextNoteId;         // counter for ID generation
    
    // Sampler settings (per-pattern because each pattern = one sample)
    int   rootNote;                 // MIDI root (C4 = 60 default)
    float attackMs, decayMs, sustain, releaseMs;  // ADSR envelope
    bool  loopEnabled;              // false = one-shot, true = loops
    int64_t loopStart, loopEnd;     // in samples, relative to region audio start
    bool  crossfadeEnabled;         // false = one-shot, true = sustained (follows note duration)
};
```

#### PatternBlock (`TimelineTypes.h` lines 218-228)
```cpp
struct PatternBlock {
    int      id;
    int      trackId;
    int      patternId;        // which pattern to play
    TickTime position;         // timeline position (absolute)
    TickTime duration;         // block length on timeline
    TickTime offset;           // trimmed left edge within the pattern
};
```
- If `duration > pattern.length`: pattern loops; notes repeat
- If `duration < pattern.length`: pattern trimmed right
- `offset` allows trimming left (scrolls pattern content)

#### TrackInfo (`TimelineTypes.h` lines 230-255)
```cpp
struct TrackInfo {
    int type;  // Type::Clip or Type::Pattern
    
    // For Clip tracks:
    // (no pattern-specific fields used)
    
    // For Pattern tracks:
    int assignedRegionId;   // which sample to use for all pattern blocks on this track
    int assignedPatternId;  // default pattern (client-side UI state hint, not enforced)
    VideoFlipMode videoFlipMode;  // per-note flip cycling during playback
};
```

### Timeline Model (`engine/src/model/Timeline.h`)

Central container holding all project data:

```cpp
class Timeline {
public:
    // Patterns
    int addPattern(Pattern pattern);
    const Pattern* getPattern(int id) const;
    Pattern* getPatternMutable(int id);
    const std::map<int, Pattern>& getAllPatterns() const;
    bool removePattern(int id);
    
    // PatternBlocks
    int addPatternBlock(PatternBlock block);
    const PatternBlock* getPatternBlock(int id) const;
    std::vector<const PatternBlock*> getAllPatternBlocks() const;
    std::vector<const PatternBlock*> getPatternBlocksOnTrack(int trackId) const;
    std::vector<const PatternBlock*> getPatternBlocksInRange(TickTime start, TickTime end) const;
    bool removePatternBlock(int id);
    bool movePatternBlock(int id, int newTrackId, TickTime newPosition);
    bool resizePatternBlock(int id, TickTime newDuration);
    
    // Pattern notes
    int addNoteToPattern(int patternId, PatternNote note);
    bool removeNoteFromPattern(int patternId, int noteId);
    bool moveNote(int patternId, int noteId, TickTime newPosition, int newPitch);
    bool resizeNote(int patternId, int noteId, TickTime newDuration);
    bool setNoteVelocity(int patternId, int noteId, float velocity);
    
    // Track type conversion
    bool convertToPatternTrack(int trackId, int regionId);
    bool convertToClipTrack(int trackId);
    bool setTrackVideoFlipMode(int trackId, VideoFlipMode mode);
    
    // Restore (for undo/redo)
    bool restorePattern(const Pattern& pattern);
    bool restorePatternBlock(const PatternBlock& block);
    bool restoreNoteInPattern(int patternId, const PatternNote& note);

private:
    std::map<int, Pattern>      m_patterns;
    std::map<int, PatternBlock> m_patternBlocks;
};
```

### Commands (`engine/src/commands/TimelineCommands.h`)

All mutations go through Command objects for undo/redo support. Each command:
- Captures state in constructor (main thread)
- `execute(Timeline&)` performs the action and captures IDs if first-time
- `undo(Timeline&)` reverts via `Timeline::restore*()`

#### Pattern Commands

**AddPatternCommand**
- Constructor: `AddPatternCommand(Pattern pattern)`
- `execute()`: calls `timeline.addPattern()`, saves assigned ID
- `undo()`: calls `timeline.removePattern()`

**RemovePatternCommand**
- Constructor: `RemovePatternCommand(int patternId, const Timeline&)`
- Snapshots: the pattern + all PatternBlocks referencing it + track `assignedPatternId` fields
- `execute()`: removes blocks, then pattern, updating affected tracks
- `undo()`: restores pattern, then blocks, then resets track fields

**SetSamplerSettingsCommand**
- Constructor: `SetSamplerSettingsCommand(int patternId, SamplerSettings newSettings, const Timeline&)`
- Snapshots old settings from pattern
- `execute()`: applies new ADSR, root note, loop points, crossfade mode
- `undo()`: restores old settings

#### PatternBlock Commands

**AddPatternBlockCommand**
- Constructor: `AddPatternBlockCommand(PatternBlock block)`
- `execute()`: calls `timeline.addPatternBlock()`
- `undo()`: calls `timeline.removePatternBlock()`

**RemovePatternBlockCommand**
- Constructor: `RemovePatternBlockCommand(int blockId, const Timeline&)`
- Snapshots the block at construction
- `execute()`: removes it
- `undo()`: restores via `restorePatternBlock()`

**MovePatternBlockCommand**
- Constructor: `MovePatternBlockCommand(int blockId, int newTrackId, TickTime newPosition, const Timeline&)`
- Snapshots old trackId + position
- `execute()`: calls `timeline.movePatternBlock()`
- `undo()`: moves back to old position/track

**ResizePatternBlockCommand**
- Constructor: `ResizePatternBlockCommand(int blockId, TickTime newDuration, const Timeline&)`
- Snapshots old duration
- `execute()`: calls `timeline.resizePatternBlock()`
- `undo()`: restores old duration

#### Pattern Note Commands

**AddNoteCommand**
- Constructor: `AddNoteCommand(int patternId, PatternNote note)`
- `execute()`: calls `timeline.addNoteToPattern()`, saves ID from `Pattern::nextNoteId`
- `undo()`: calls `timeline.removeNoteFromPattern()`

**RemoveNoteCommand**
- Constructor: `RemoveNoteCommand(int patternId, int noteId, const Timeline&)`
- Snapshots the note
- `execute()`: removes it
- `undo()`: restores via `restoreNoteInPattern()`

**MoveNoteCommand**
- Constructor: `MoveNoteCommand(int patternId, int noteId, TickTime newPosition, int newPitch, const Timeline&)`
- Snapshots old position + pitch
- `execute()`: calls `timeline.moveNote()`
- `undo()`: moves back

**ResizeNoteCommand**
- Constructor: `ResizeNoteCommand(int patternId, int noteId, TickTime newDuration, const Timeline&)`
- Snapshots old duration
- `execute()`: calls `timeline.resizeNote()`
- `undo()`: restores

**SetNoteVelocityCommand**
- Constructor: `SetNoteVelocityCommand(int patternId, int noteId, float newVelocity, const Timeline&)`
- Snapshots old velocity
- `execute()`: updates note.velocity
- `undo()`: restores old velocity

#### Track Conversion Commands

**ConvertTrackTypeCommand**
- Constructor: `ConvertTrackTypeCommand(int trackId, TrackInfo::Type newType, int regionIdIfPattern, const Timeline&)`
- Snapshots old type fields + cascade-deletes PatternBlocks if converting Pattern→Clip
- `execute()`: sets new type and region; removes blocks if converting to Clip
- `undo()`: restores old type fields and blocks

**SetVideoFlipModeCommand**
- Constructor: `SetVideoFlipModeCommand(int trackId, VideoFlipMode newMode, const Timeline&)`
- Snapshots old mode
- `execute()`: sets new mode
- `undo()`: restores old mode

### Audio Engine Integration

#### Sampler (`engine/src/audio/Sampler.h`)
Polyphonic pitched sample player, one instance per Pattern.

```cpp
class Sampler {
public:
    // Main-thread config
    void loadSample(const juce::AudioBuffer<float>& audioData,
                    double sourceSampleRate, int rootNote);
    void setADSR(float attackMs, float decayMs, float sustain, float releaseMs);
    void setLoopPoints(bool enabled, int64_t loopStart, int64_t loopEnd);
    void setCrossfadeMode(bool enabled);  // false = one-shot, true = sustained
    void setRootNote(int note);
    
    // Audio-thread triggering
    void noteOn(int midiNote, float velocity);   // velocity → amplitude envelope floor + video opacity
    void noteOff(int midiNote);
    void processBlock(juce::AudioBuffer<float>& outputBuffer, int numSamples, double engineSampleRate);

private:
    struct Voice {
        bool   active;
        int    midiNote;
        float  velocity;
        double playPosition;     // fractional sample index
        double pitchRatio;       // 2^((midiNote - rootNote) / 12)
        
        enum class EnvStage { Attack, Decay, Sustain, Release, Off };
        EnvStage envStage;
        float    envLevel;
        double   envPosition;
        bool     noteHeld;
    };
    
    static constexpr int MAX_VOICES = 32;
    std::array<Voice, MAX_VOICES> voices_;
    
    // Per-voice playback: pitch interpolation, envelope advancement, output generation
};
```

**Playback Flow:**
1. Pattern note triggers `noteOn(midiNote, velocity)` → free voice allocation
2. Voice calculates `pitchRatio = 2^((midiNote - rootNote) / 12)`
3. `processBlock()` advances playback position with pitch interpolation (sample rate conversion)
4. ADSR envelope modulates amplitude: Attack → Decay → Sustain → Release (on noteOff)
5. Loop points: after playback reaches `loopEnd`, jump to `loopStart`; oneshot mode disables loop
6. Crossfade mode (sustained): note holds at sustain level until `noteOff` is called; one-shot mode plays to completion regardless of note duration

#### AudioScheduler (`engine/src/AudioScheduler.h`)
Triggers sample events at exact sample positions during playback.

```cpp
struct AudioEvent {
    double beatPosition;  // When to trigger (in beats)
    int    sampleId;      // Which sample to play
    float  velocity;      // 0.0–1.0
};

class AudioScheduler {
public:
    AudioScheduler(Transport& transport, AudioEngine& engine);
    void addEvent(const AudioEvent& event);   // main thread
    void clearEvents();
    void processBlock(int numSamples);        // audio thread
};
```

#### Pattern Block Scheduling (Bridge: `XlethAddon.cpp` lines 457-557)

The bridge's `scheduleAudioEvents()` function converts PatternBlocks into individual sample triggers:

**Algorithm:**
1. Iterate all pattern-type tracks in ascending trackId order (deterministic)
2. For each track, collect all PatternBlocks sorted by position
3. For each PatternBlock:
   - Determine visible window: `[offset, offset + duration)` ticks
   - Calculate how many times pattern loops within window: `firstLoopIdx = floor(windowStart / patternLen)`, `lastLoopIdx = floor((windowEnd-1) / patternLen)`
   - For each note in pattern and each loop iteration:
     - Calculate absolute timeline position: `tapePos = L * patternLen + note.position`
     - If `tapePos` falls in window, emit `VideoEvent(trackId, pitch, velocity, beat, frameRange)`
4. Rebuild audio schedulers with precise sample-accurate timing

**Video Flip Cycling:**
- `Clockwise`: note instance `N` applies flip mode `N % 4`: 0→None, 1→FlipY, 2→FlipXY, 3→FlipX
- `CounterClockwise`: reverses order
- `HorizontalEven`: even note index → horizontal flip
- Per-note video opacity derived from `note.velocity`

### Serialization (`engine/src/model/Pattern.cpp` & `PatternBlock.cpp`)

Uses nlohmann/json for human-readable save/load:

```cpp
void to_json(nlohmann::json& j, const PatternNote& n) {
    j = nlohmann::json{
        {"id", n.id},
        {"positionTicks", n.position.ticks},
        {"durationTicks", n.duration.ticks},
        {"pitch", n.pitch},
        {"velocity", n.velocity}
    };
}

void to_json(nlohmann::json& j, const Pattern& p) {
    j = nlohmann::json{
        {"id", p.id},
        {"name", p.name},
        {"regionId", p.regionId},
        {"lengthTicks", p.length.ticks},
        {"notes", p.notes},
        {"nextNoteId", p.nextNoteId},
        {"rootNote", p.rootNote},
        {"attackMs", p.attackMs},
        {"decayMs", p.decayMs},
        {"sustain", p.sustain},
        {"releaseMs", p.releaseMs},
        {"loopEnabled", p.loopEnabled},
        {"loopStart", p.loopStart},
        {"loopEnd", p.loopEnd},
        {"crossfadeEnabled", p.crossfadeEnabled}
    };
}

void to_json(nlohmann::json& j, const PatternBlock& b) {
    j = nlohmann::json{
        {"id", b.id},
        {"trackId", b.trackId},
        {"patternId", b.patternId},
        {"positionTicks", b.position.ticks},
        {"durationTicks", b.duration.ticks},
        {"offsetTicks", b.offset.ticks}
    };
}
```

---

## Layer 2: Node-API Bridge

### Global State (`XlethAddon.cpp` lines 62-99)

```cpp
std::unique_ptr<Timeline>       g_timeline;
std::unique_ptr<UndoManager>    g_undoManager;
std::unique_ptr<ProjectManager> g_projectManager;
std::unique_ptr<FrameServer>    g_frameServer;
std::deque<std::unique_ptr<VideoDecoder>> decoderOwner;
std::vector<VideoDecoder*> decoderPtrs;
std::unique_ptr<SyncManager> syncManager;
```

### Exported C++ ↔ JavaScript Bindings

All functions exported via N-API (Node-addon-api). Threading model:
- **Main thread:** all N-API calls
- **Audio RT thread:** AudioEngine callback (no N-API)
- **Video thread:** SyncManager::videoTick (no N-API)

#### Pattern Commands

**timeline_addPattern(obj)** → patternId
- Input: `{ name, regionId, lengthTicks }`
- Executes: `AddPatternCommand`
- Returns: newly assigned pattern ID
- Triggers: Engine sampler creation (if audio is active)

**timeline_removePattern(patternId)**
- Executes: `RemovePatternCommand`
- Cascade: removes all PatternBlocks + track `assignedPatternId` references

**timeline_getPattern(patternId)** → Pattern
- Returns serialized Pattern or null

**timeline_getAllPatterns()** → [Pattern]
- Returns all patterns in project

**timeline_updateSamplerSettings(patternId, { rootNote?, attackMs?, ... })**
- Executes: `SetSamplerSettingsCommand`
- Refreshes Sampler for pattern

#### PatternBlock Commands

**timeline_addPatternBlock(obj)** → blockId
- Input: `{ trackId, patternId, positionTicks, durationTicks, offsetTicks? }`
- Executes: `AddPatternBlockCommand`
- Returns: block ID

**timeline_getPatternBlocks()** → [PatternBlock]

**timeline_removePatternBlock(blockId)**
- Executes: `RemovePatternBlockCommand`

**timeline_movePatternBlock(blockId, newTrackId, newPosTicks)**
- Executes: `MovePatternBlockCommand`

**timeline_resizePatternBlock(blockId, durTicks)**
- Executes: `ResizePatternBlockCommand`

#### Pattern Note Commands

**timeline_addNote(patternId, { positionTicks, durationTicks, pitch, velocity? })** → noteId
- Executes: `AddNoteCommand`
- Returns: note ID

**timeline_removeNote(patternId, noteId)**
- Executes: `RemoveNoteCommand`

**timeline_moveNote(patternId, noteId, posTicks, pitch)**
- Executes: `MoveNoteCommand`

**timeline_resizeNote(patternId, noteId, durTicks)**
- Executes: `ResizeNoteCommand`

**timeline_setNoteVelocity(patternId, noteId, velocity)**
- Executes: `SetNoteVelocityCommand`

**timeline_previewNote(patternId, pitch, velocity=0.8)**
- Triggers a single note on pattern's sampler for UI preview

#### Track Type Conversion

**timeline_convertToPatternTrack(trackId, regionId)**
- Executes: `ConvertTrackTypeCommand` with `Type::Pattern`
- Sets `assignedRegionId` for the track
- Triggers: sampler creation for any patterns on this track

**timeline_convertToClipTrack(trackId)**
- Executes: `ConvertTrackTypeCommand` with `Type::Clip`
- Cascade: removes all PatternBlocks on this track

**timeline_setVideoFlipMode(trackId, mode)**
- Executes: `SetVideoFlipModeCommand`
- Mode: "None" | "HorizontalEven" | "Clockwise" | "CounterClockwise"

### Helper Functions

**refreshSampler(int patternId)** (`XlethAddon.cpp` lines 279-286)
```cpp
static void refreshSampler(int patternId) {
    const Pattern* p = g_timeline->getPattern(patternId);
    if (p) audioEngine->getMixEngine().loadSamplerForPattern(patternId, *p);
    else   audioEngine->getMixEngine().unloadSampler(patternId);
}
```
- Called after pattern creation, modification, or deletion
- Loads sample audio into pattern's Sampler instance
- Updates ADSR, loop points, root note, crossfade mode

**scheduleAudioEvents()** (`XlethAddon.cpp` lines 457-557)
- Rebuilds AudioScheduler with all active PatternBlock note triggers
- Calculates looping window math: which pattern note-instances fall in each block's time range
- Emits VideoEvents with pitch, velocity, timeline position, frame range for video compositor
- Called before playback and after any timeline mutation

---

## Layer 3: React UI

### Event Bus (`ui/src/timelineEvents.js`)

```javascript
export const timelineEvents = new EventTarget()
```

**Events:**
- `timeline-regions-changed` — region CRUD
- `timeline-sources-changed` — source import
- `timeline-patterns-changed` — pattern added/removed/reordered
- `timeline-pattern-blocks-changed` — PatternBlock CRUD
- `timeline-pattern-changed` → `{ detail: { patternId } }` — individual pattern notes/settings mutated
- `open-piano-roll` → `{ detail: { patternId, blockId? } }` — request to open PianoRoll tab
- `close-piano-roll` — request to switch back to timeline
- `open-sampler-settings` → `{ detail: { patternId } }` — request to open sampler panel
- `close-sampler-settings`
- `piano-roll-detach` — float piano roll into separate panel
- `piano-roll-dock` — dock floating panel back into tab

### App.jsx (Main Container)

**Props:** None

**State:**
```javascript
const [activeSampleId, setActiveSampleId] = useState(null)    // selected sample in SampleSelector
const [pianoRollPatternId, setPianoRollPatternId] = useState(null)  // currently editing pattern
const [samplerPanelPatternId, setSamplerPanelPatternId] = useState(null)
const [activeCenterTab, setActiveCenterTab] = useState('timeline')  // 'timeline' | 'piano-roll'
const [pianoRollDetached, setPianoRollDetached] = useState(false)    // floating panel?
const [floatPos, setFloatPos] = useState({x:120, y:80})
const [currentPatternIdByTrack, setCurrentPatternIdByTrack] = useState({})  // client-side: which pattern per track in TL
const [allPatterns, setAllPatterns] = useState({})  // { [id]: pattern }
```

**Key Functions:**
- `fetchAllPatterns()` — calls `window.xleth.timeline.getAllPatterns()`, caches in state
- `handleSwitchPattern(newPatternId)` — sets `pianoRollPatternId`
- `handleNewPatternFromPianoRoll()` — creates new pattern in same region as current, opens it
- `handleDetachPianoRoll()` — sets `pianoRollDetached = true`, switches to timeline tab
- `handleDockPianoRoll()` — sets `pianoRollDetached = false`, switches to piano-roll tab
- `handleBackToTimeline()` — switches to timeline tab, keeps pattern loaded

**Event Listeners:**
- `timeline-patterns-changed` → refetch patterns
- `open-piano-roll` → set pattern ID and switch tab
- `close-piano-roll` → switch back to timeline
- `piano-roll-detach` / `piano-roll-dock` → manage float state

**Lifecycle:**
- Mount: fetch all patterns, listen to timeline events
- Pattern dropdown in PianoRollToolbar: map `allPatterns` to options, allow quick switch or create new

### PianoRoll.jsx (Container)

**Props:**
```javascript
{
  patternId,
  onClose,
  onDetach, onDock, floating = false, onTitleMouseDown,
  availablePatterns,
  currentPatternId,
  onSwitchPattern,
  onNewPattern,
}
```

**State:**
```javascript
const [pattern, setPattern] = useState(null)
const [activeTool, setActiveTool] = useState('pencil')  // 'select' | 'pencil' | 'split' | 'delete'
const [stickyNoteLength, setStickyNoteLength] = useState(240)  // 1/16 = PPQ/4
const [selectedNoteIds, setSelectedNoteIds] = useState(new Set())
const [pixelsPerBeat, setPixelsPerBeat] = useState(80)
const [pixelsPerSemitone] = useState(14)
const [scrollX, setScrollX] = useState(0)
const [scrollY, setScrollY] = useState(0)
const [size, setSize] = useState({w:800, h:500})
```

**Key Functions:**
- `fetchPattern()` — calls `window.xleth.timeline.getPattern(patternId)`
- `handleAddNote(note)` → `window.xleth.timeline.addNote(patternId, note)` → dispatch `timeline-pattern-changed`
- `handleRemoveNote(noteId)` → `window.xleth.timeline.removeNote(patternId, noteId)`
- `handleMoveNote(noteId, posTicks, pitch)` → `window.xleth.timeline.moveNote(...)`
- `handleResizeNote(noteId, durTicks)` → `window.xleth.timeline.resizeNote(...)`
- `handleSetVelocity(noteId, velocity)` → `window.xleth.timeline.setNoteVelocity(...)`
- `handleZoomIn() / handleZoomOut()` — scale `pixelsPerBeat` ±20% with clamp [20, 320]
- `notifyChanged()` — dispatch `timeline-pattern-changed` event after mutations

**Sub-Components:**
- `<PianoRollToolbar>` — tool selector, note length, zoom, pattern dropdown, detach/dock button
- `<PianoRollKeyboard>` — vertical keyboard sidebar, note labels
- `<PianoRollCanvas>` — main drawing surface (grid, notes, tools)
- `<VelocityLane>` — horizontal lane below canvas showing note velocities
- `<ResizablePanel>` — if floating, draggable frame with title

### PianoRollToolbar.jsx

**Props:**
```javascript
{
  patternName,
  activeTool, onToolChange,
  stickyNoteLength, onStickyNoteLengthChange,
  onZoomIn, onZoomOut,
  onOpenSamplerSettings,
  onClose,
  floating = false, onDetach, onDock, onTitleMouseDown,
  availablePatterns, currentPatternId, onSwitchPattern, onNewPattern,
}
```

**Elements:**
- **Title + Pattern Dropdown**: Shows current pattern name, dropdown to select other patterns or create new
  - On "New Pattern" selection: calls `onNewPattern()` → App creates new pattern in same region, opens it
  - On pattern select: calls `onSwitchPattern(id)` → App sets `pianoRollPatternId`
- **Tool Buttons**: Select, Pencil, Split, Delete (click to activate, visual highlight)
- **Note Length Selector**: Dropdown [1/4, 1/8, 1/16, 1/32] (in ticks: 960, 480, 240, 120)
- **Sampler Settings Button**: Opens sampler panel via `open-sampler-settings` event
- **Zoom Buttons**: In/Out
- **Detach/Dock Button**: Toggles floating mode
- **Close Button**: Back to timeline or close floating panel

### PianoRollKeyboard.jsx

**Props:**
```javascript
{
  scrollY,
  pixelsPerSemitone,
}
```

**Constants:**
```javascript
const PITCH_MIN = 24  // C1
const PITCH_MAX = 84  // C6
const isBlackKey = (pitch) => {
    const noteName = pitch % 12
    return noteName in [1, 3, 6, 8, 10]  // C#, D#, F#, G#, A#
}
```

**Rendering:**
- Vertical labels for each semitone (C, C#, D, etc.)
- Dark background for black keys (visual aid)
- Octave numbers (C1, C2, C3, etc.)
- Scroll synchronized with canvas

### PianoRollCanvas.jsx

**Props:**
```javascript
{
  patternId,
  notes, patternLengthTicks,
  activeTool, stickyNoteLength, selectedNoteIds, setSelectedNoteIds,
  pixelsPerBeat, pixelsPerSemitone, scrollX, scrollY,
  width, height,
  onAddNote, onRemoveNote, onMoveNote, onResizeNote, onPreviewNote,
}
```

**Canvas Layers:**
1. **Background Canvas** — grid lines, octave markers, pattern-length boundary (vertical line)
2. **Content Canvas** — notes drawn as rectangles
3. **Overlay Canvas** — selection rubber-band, playhead, tool previews

**Drawing Functions:**
- `drawBackground()` — grid, black-key shading, octave lines, pattern boundary
- `drawNotes()` — rectangles colored by selection and velocity (darker = lower velocity)
- Selected notes: white outline; unselected: colored outline

**Tool Handlers:**
- **Pencil Tool**: Click to add note at grid-snapped position with sticky length; drag to extend
- **Select Tool**: Click to select/deselect; drag to move; drag right-edge to resize; rubber-band
- **Split Tool**: Click to split note at cursor
- **Delete Tool**: Click to remove note

**Hit Testing:**
```javascript
function hitTestNote(notes, localX, localY, pixelsPerBeat, pixelsPerSemitone, scrollX, scrollY) {
    for (let i = notes.length - 1; i >= 0; i--) {
        const note = notes[i]
        const beat = note.positionTicks / PPQ
        const durBeats = note.durationTicks / PPQ
        const x = beat * pixelsPerBeat - scrollX
        const w = Math.max(2, durBeats * pixelsPerBeat)
        const y = (PITCH_MAX - note.pitch) * pixelsPerSemitone - scrollY
        if (localX >= x && localX < x + w && localY >= y && localY < y + pixelsPerSemitone) {
            const nearRight = localX >= x + w - RESIZE_HANDLE_PX
            return { note, index: i, nearRight }
        }
    }
    return null
}
```

### VelocityLane.jsx

**Props:**
```javascript
{
  notes, selectedNoteIds,
  pixelsPerBeat, scrollX,
  width, height,
  onSetVelocity,
}
```

**Rendering:**
- Horizontal lanes below piano roll showing each note's velocity as a vertical bar
- Click to set velocity; drag to adjust
- Velocity range [0, 1] maps to bar height [0%, 100%]

### Timeline Components

#### TimelineView.jsx (Container)

**Props:**
```javascript
{
  activeSampleId,
  currentPatternIdByTrack = {},  // { [trackId]: patternId }
  setCurrentPatternIdByTrack = () => {},
}
```

**State:**
```javascript
const [tracks, setTracks] = useState([])
const [clips, setClips] = useState([])
const [regions, setRegions] = useState({})
const [selectedClipIds, setSelectedClipIds] = useState(new Set())
const [patternBlocks, setPatternBlocks] = useState([])
const [patterns, setPatterns] = useState({})
const [selectedBlockIds, setSelectedBlockIds] = useState(new Set())
const [isPlaying, setIsPlaying] = useState(false)
const [playheadBeatRef, setPlayheadBeatRef] = useState(0)
const [bpmRef, setBpmRef] = useState(140)
const [pixelsPerBeat, setPixelsPerBeat] = useState(...)
const [scrollOffset, setScrollOffset] = useState(0)
const [activeTool, setActiveTool] = useState('select')  // select | pencil | split | delete
```

**Key Functions:**
- `fetchTracks()` — `window.xleth.timeline.getTracks()`
- `fetchClips()` — `window.xleth.timeline.getClips()`
- `fetchPatterns()` — `window.xleth.timeline.getAllPatterns()`
- `fetchPatternBlocks()` — `window.xleth.timeline.getPatternBlocks()`
- `fetchRegions()` — `window.xleth.timeline.getRegions()`
- `handleAddTrack()` — creates Clip track by default; user can convert to Pattern
- `handleAddClip(clip)` → `window.xleth.timeline.addClip(clip)` → dispatch `timeline-regions-changed`
- `handleAddPatternBlock(block)` → `window.xleth.timeline.addPatternBlock(block)`
- `handleMoveClip(clipId, trackId, posTicks)` → `window.xleth.timeline.moveClip(...)`
- `handleMovePatternBlock(blockId, trackId, posTicks)` → `window.xleth.timeline.movePatternBlock(...)`
- `handleResizeClip/Block()` → corresponding API calls
- `handleConvertToPatternTrack(trackId, regionId)` → `window.xleth.timeline.convertToPatternTrack(trackId, regionId)` → dialog "This will delete pattern blocks if converting Pattern→Clip"
- `handleSetVideoFlipMode(trackId, mode)` → `window.xleth.timeline.setVideoFlipMode(...)`

**Event Listeners:**
- `timeline-regions-changed` → `fetchRegions()`
- `timeline-patterns-changed` → `fetchPatterns()`
- `timeline-pattern-blocks-changed` → `fetchPatternBlocks()`
- Transport (playhead) → `playheadClock` subscription → update playhead position in canvas

**Sub-Components:**
- `<TrackHeaderList>` — list of track headers (mute, solo, delete, convert buttons)
- `<TimelineCanvas>` — main editing canvas with clips/blocks, grid, tools
- `<TimelineRuler>` — beat/bar numbering
- `<TimelineToolbar>` — tool selector, zoom, snap mode
- `<ContextMenu>` — right-click menu for clips/blocks
- `<TrackContextMenu>` — right-click menu for track headers
- `<ConfirmConvertDialog>` — confirm conversion before deleting pattern blocks

#### timelineDrawing.js (Pure Canvas Functions)

**Key Functions:**

**drawPatternBlocks(ctx, w, h, scrollOffset, ppb, blocks, trackIdToIndex, patterns, regions, selectedBlockIds, mutedTrackIds)** (`lines 332-441`)

Renders all PatternBlocks on the timeline:

```javascript
for each block {
    // Calculate screen position
    const beatPos = block.positionTicks / PPQ
    const beatDur = block.durationTicks / PPQ
    const x = beatToPixel(beatPos, scrollOffset, ppb)
    const blockW = beatDur * ppb
    const trackIdx = trackIdToIndex[block.trackId]
    const y = trackIdx * TRACK_HEIGHT + CLIP_PAD
    
    // Fetch pattern + region for color
    const pattern = patterns[block.patternId]
    const region = pattern ? regions[pattern.regionId] : null
    const hex = labelHexColor(region?.label)  // color based on sample label
    
    // Draw rectangle
    ctx.fillStyle = hexToRgba(hex, selected ? 0.75 : 0.55)
    ctx.fillRect(x, y, blockW, clipH)
    
    // Dashed top border (distinguishes from Clips)
    ctx.setLineDash([4, 3])
    ctx.strokeRect(x, y, blockW, clipH)
    ctx.setLineDash([])
    
    // Note markers (mini piano roll view)
    if (pattern && pattern.notes.length > 0 && blockW > 30) {
        const patLen = pattern.lengthTicks
        const windowStart = block.offset
        const windowEnd = block.offset + block.duration
        const firstLoop = floor(windowStart / patLen)
        const lastLoop = floor((windowEnd-1) / patLen)
        
        for (L = firstLoop to lastLoop) {
            for each note {
                const tapePos = L * patLen + note.position
                if (tapePos in [windowStart, windowEnd)) {
                    // Draw tiny dot proportional to pitch
                    const noteBeat = beatPos + (tapePos - windowStart) / PPQ
                    const nx = beatToPixel(noteBeat, scrollOffset, ppb)
                    const nw = (note.duration / PPQ) * ppb
                    const ny = y + 2 + (innerH - noteH) - ((note.pitch - minPitch) / range) * innerH
                    ctx.fillRect(nx, ny, nw, 2)  // 2px dots
                }
            }
        }
    }
    
    // Loop indicator (↻ symbol if duration > pattern.length)
    if (block.duration > pattern.length) {
        ctx.fillText('↻', x + blockW - 10, y + 2)
    }
    
    // Pattern name text
    ctx.fillText(pattern?.name || '?', x + CLIP_TEXT_PAD, y + 3)
}
```

**Result:** PatternBlocks rendered with:
- Colored fill based on region label (same color system as clips)
- **Dashed top border** to visually distinguish from clips
- Mini piano roll showing note pitch positions looping within block
- Loop indicator symbol if block is longer than pattern
- Pattern name text
- Resize handle (right edge) on selected blocks

#### TimelineCanvas.jsx

**Props:** All state from TimelineView (clips, blocks, patterns, regions, tracks, etc.)

**State:**
```javascript
const [dragState, setDragState] = useState(null)  // { kind: 'clip'|'block', mode: 'pending'|'move'|'resize'|'rubberband', ... }
const [dropPreview, setDropPreview] = useState(null)  // { beat, trackIndex, durationBeats, color, name }
```

**Canvas Layers:**
1. **Grid canvas** — background grid, track separators, beat/bar lines
2. **Content canvas** — clips + pattern blocks
3. **Overlay canvas** — selection, playhead, drag previews, tool overlays

**Mouse Interaction:**
- **onMouseDown**: Determine if clicked on clip or pattern block → set drag state
  - If on right edge of selected item: set mode = 'resize'
  - If on item: set mode = 'pending' (drag threshold required)
  - If on empty: set mode = 'rubberband'
- **onMouseMove**: 
  - If drag mode = 'move': show ghost preview; snap to grid
  - If drag mode = 'resize': extend/shrink right edge; snap to grid
  - If drag mode = 'rubberband': show rubber-band rectangle
- **onMouseUp**:
  - If mode = 'move': call `onMoveClip()` or `onMovePatternBlock()`
  - If mode = 'resize': call `onResizeClip()` or `onResizePatternBlock()`
  - If mode = 'rubberband': select all clips/blocks in rectangle
  - If mode = null (simple click): toggle selection

**Drag Threshold:** 3px before dragging starts (avoids accidental movement on click)

**Pattern Block Tool Integration:**
- **Select Tool**: click/drag/resize blocks same as clips
- **Pencil Tool**: click + drag to draw new pattern block (auto-snap duration to grid)
- **Split Tool**: click to split block at cursor position (calls `resizePatternBlock` twice to split)
- **Delete Tool**: click to remove block (calls `removePatternBlock()`)

#### TrackHeader.jsx

**Props:**
```javascript
{
  track, index, region, currentPattern,
  onMute, onSolo, onRename, onRemove, onRequestContextMenu,
  onDragStart, onDragOver, onDrop,
}
```

**Elements:**
- **Color bar**: Label-colored for pattern tracks; index-colored for clip tracks
- **Name**: Double-click to edit; displays "(Pattern)" indicator if pattern track
- **Sub-name** (Pattern tracks only): Region name for the track's assigned region
- **Sampler button** (Pattern tracks only): Opens sampler settings → dispatches `open-sampler-settings`
- **Mute / Solo buttons**
- **Delete button**

**Drag & Drop:**
- Draggable: reorder tracks
- Drop target: receive samples to create clips or convert track type

#### TrackContextMenu.jsx

**Props:**
```javascript
{
  x, y,           // page position
  items,          // tree: { label, onClick, submenu?, danger?, disabled?, checked? } | { type: 'separator' }
  onClose,
}
```

**Menu Items** (typical for a Pattern track):
- `Mute`
- `Solo`
- `Rename...`
- `Convert to Clip Track` (submenu: "Deletes all pattern blocks - are you sure?")
- `Convert to Pattern Track` (submenu: choose region)
- `Video Flip Mode` (submenu: None, HorizontalEven, Clockwise, CounterClockwise)
- `Remove Track`

#### ConfirmConvertDialog.jsx

**Props:**
```javascript
{
  title, message, confirmLabel, cancelLabel,
  onConfirm, onCancel,
  danger = true,
}
```

**Usage:**
- Conversion to Clip Track: "Deletes all PatternBlocks on this track"
- Conversion to Pattern Track: "Choose a region to bind to this track"

### Timeline Tools (`ui/src/components/timeline/tools/`)

#### selectTool.js

**Exports:** `createSelectTool(deps)` → `{ onMouseDown, onMouseMove, onMouseUp, onDragLeave }`

**Dependencies:**
```javascript
{
  clipsRef, tracksRef, regionsRef, selectedRef,
  patternBlocksRef, patternsRef, selectedBlockIdsRef,
  pixelsPerBeatRef, scrollOffsetRef, bpmRef,
  onMoveClip, onResizeClip, onResizeClipLeft, setSelectedClipIds,
  onMovePatternBlock, onResizePatternBlock, setSelectedBlockIds,
  onRequestClipContextMenu,
  redrawOverlay, containerRef,
}
```

**State Tracking:**
- `dragKind`: 'clip' | 'block' | null
- `dragMode`: 'pending' | 'move' | 'resize' | 'resize-left' | 'rubberband' | null
- `dragOriginX`, `dragOriginY`, `dragCurrentX`, `dragCurrentY`
- `dragClip`, `dragBlock`: snapshots of dragged item
- `dragClipOrigBeat`, `dragClipOrigTrackIdx`, `dragClipOrigDuration`
- `dragBlockOrigBeat`, `dragBlockOrigTrackIdx`, `dragBlockOrigDuration`

**Hit Testing:**
```javascript
function hitTestClip(beat, trackIndex) {
    for (clip of clips) {
        if (clip.position <= beat < clip.position + clip.duration && clip.trackIndex == trackIndex) return clip
    }
}

function hitTestPatternBlock(beat, trackIndex) {
    for (block of patternBlocks) {
        if (block.position <= beat < block.position + block.duration && block.trackIndex == trackIndex) return block
    }
}
```

**Edge Detection:**
```javascript
function isOnRightEdgeOf(localX, startTicks, durTicks) {
    const endBeat = (startTicks + durTicks) / PPQ
    const rightEdgePx = beatToPixel(endBeat, scrollOffset, ppb)
    return Math.abs(localX - rightEdgePx) <= HANDLE_W  // HANDLE_W = 6px
}

function isOnLeftEdgeOf(localX, startTicks) {
    const startBeat = startTicks / PPQ
    const leftEdgePx = beatToPixel(startBeat, scrollOffset, ppb)
    return Math.abs(localX - leftEdgePx) <= HANDLE_W
}
```

**Drag Modes:**
1. **pending**: Initial state after mouse-down; waits for DRAG_THRESHOLD (3px) before committing to move/resize
2. **move**: Dragging item; snaps position to grid (snap functions from constants/timeline.js)
3. **resize**: Right-edge drag (clips allow left-edge resize too)
4. **rubberband**: Drag from empty space to select multiple items

**Snap to Grid:** Uses `snapBeatToGrid(beat, snapDivisor = 4)` to align to 1/16 notes by default

**Selection Update:**
- On click: toggle selection (Shift adds to selection, Ctrl clears before adding)
- On rubberband: select all items in rectangle
- Right-click: context menu via `onRequestClipContextMenu(clip/block, x, y)`

#### pencilTool.js

**Exports:** `createPencilTool(deps)` → `{ onMouseDown, onMouseMove, onMouseUp }`

**Dependencies:** clipsRef, tracksRef, regionsRef, selectedRef, patternBlocksRef, patternsRef, pixelsPerBeatRef, scrollOffsetRef, bpmRef, onAddClip, onAddPatternBlock, setStickyNoteLength, etc.

**Behavior:**
- **Clip track:** Click to add new clip at snapped position with sticky duration
  - Uses `pencilTemplateRef` (regionId, durationTicks, velocity, etc.)
  - Input prompt if no template selected
- **Pattern track:** Click to add new PatternBlock at snapped position
  - Defaults to first pattern on track or allows user selection

#### splitTool.js

**Behavior:**
- **Clip:** Click to split clip at cursor, creating two clips with adjusted durations
- **PatternBlock:** Click to split block, creating two blocks with adjusted durations and offsets

#### deleteTool.js

**Behavior:**
- **Clip:** Click to delete; call `onRemoveClip()`
- **PatternBlock:** Click to delete; call `onRemovePatternBlock()`
- **Sweep drag:** Create rectangle, delete all items in rectangle

---

## Data Flow Scenarios

### Scenario 1: User Draws a Note in Piano Roll → Engine & Back

**Starting State:** PianoRoll is open for Pattern ID 5, pattern has no notes yet

**User Action:** Click pencil tool, click at beat 2, pitch C4 (60), sticky length 1/16

**UI Flow:**
1. PianoRollCanvas detects click → `hitTestNote()` returns null (no note at that position)
2. Calls `onAddNote({ positionTicks: 1920, durationTicks: 240, pitch: 60, velocity: 1.0 })`
   - 1920 ticks = 2 beats × 960 PPQ
   - 240 ticks = 1/16 note × 960 PPQ
3. PianoRoll.handleAddNote → `window.xleth.timeline.addNote(5, {...})`

**Bridge Flow:**
1. N-API function `timeline_addNote(patternId=5, noteObj)` called
2. Creates `PatternNote` with default ID=0
3. Executes: `AddNoteCommand(5, note)` via `g_undoManager->execute()`
4. Command snapshots pattern; calls `g_timeline->addNoteToPattern(5, note)`
5. Timeline finds Pattern 5, assigns ID from `nextNoteId` counter, adds to `notes` vector
6. Command completes, returns
7. Bridge recovers new ID from `Pattern::nextNoteId - 1`
8. Returns noteId to JavaScript

**Engine Side:**
- No immediate audio effect (pattern not playing yet)

**UI Update:**
1. N-API returns noteId (e.g., 1)
2. PianoRoll.handleAddNote calls `notifyChanged()`
3. Dispatches event: `timeline-pattern-changed` with `detail: { patternId: 5 }`
4. PianoRoll listens → calls `fetchPattern(5)` → calls `window.xleth.timeline.getPattern(5)`
5. N-API returns Pattern object with updated notes array (includes new note with ID 1)
6. React state updates: `setPattern(...)` with new note in array
7. Canvas re-renders: `drawNotes()` now shows green rectangle at beat 2, pitch 60
8. Note is visible immediately in piano roll

**Undo/Redo:**
- User presses Ctrl+Z
- Calls `window.xleth.undo.undo()`
- Bridge executes AddNoteCommand's undo() → calls `timeline->removeNoteFromPattern(5, 1)`
- Pattern's notes vector shrinks
- UI refetches and re-renders

---

### Scenario 2: Drop Pitch Sample on Clip Track → Auto-Convert to Pattern

**Starting State:** Timeline has Clip Track ID 3, user has selected a pitch sample (region ID 7)

**User Action:** Drag sample from SamplePicker onto Track 3 header (which is a Clip track)

**UI Flow:**
1. Track Header has `onDrop` handler
2. Detects drop of sample type (data type = 'region')
3. Shows ConfirmConvertDialog: "Convert Track 3 to Pattern Track? Any clips will be deleted."
4. User clicks "Convert"
5. TimelineView.handleConvertToPatternTrack(3, 7) called
6. Calls `window.xleth.timeline.convertToPatternTrack(3, 7)`

**Bridge Flow:**
1. N-API function `timeline_convertToPatternTrack(trackId=3, regionId=7)` called
2. Finds Track 3 in timeline
3. Executes: `ConvertTrackTypeCommand(3, Type::Pattern, 7, timeline)`
   - Snapshots: old type (Clip), clips on track
4. Command executes:
   - First removes all Clip objects on Track 3 via `removeClip()`
   - Sets Track 3: `type = Pattern`, `assignedRegionId = 7`
5. Bridge calls `refreshSampler()` → but no patterns on this track yet, so no samplers created
6. Returns success

**UI Update:**
1. Dispatches event: `timeline-pattern-blocks-changed` (or generic timeline change)
2. TimelineView.fetchTracks() refetches
3. Track 3 now shows `type: 'Pattern'`
4. TrackHeader displays "(Pattern)" indicator, shows Region 7's name as sub-label
5. Sampler button now visible on header
6. User can now drag PatternBlocks onto this track or use menu to add patterns

---

### Scenario 3: Drag PatternBlock on Timeline with Select Tool

**Starting State:** Timeline has PatternBlock ID 12 (Pattern 5, Track 3, position 10 beats, duration 4 beats)

**User Action:** Select tool active, click PatternBlock 12, drag right to beat 15

**UI Flow:**
1. TimelineCanvas.onMouseDown at beat 10, Track 3
2. hitTestPatternBlock(10, 2) returns Block 12 (assuming track index 2)
3. Sets dragState: `{ kind: 'block', mode: 'pending', dragBlock: block12, dragBlockOrigBeat: 10, ... }`
4. **Waiting for DRAG_THRESHOLD (3px)**

5. onMouseMove to pixel position (beat 10.1)
6. Still within threshold → mode stays 'pending'

7. onMouseMove to pixel position (beat 10.5)
8. Exceeded threshold → mode = 'move'
9. Calculate snap: `snapBeatToGrid(10.5, 4) = 10.5` (1/4 grid)
10. Draw ghost preview showing Block 12 at beat 10.5

11. onMouseMove to pixel position (beat 15)
12. Calculate snap: `snapBeatToGrid(15, 4) = 15`
13. Update ghost preview to beat 15

14. onMouseUp at beat 15
15. mode = 'move' → call `onMovePatternBlock(12, 3, 14400)`
    - 14400 ticks = 15 beats × 960 PPQ
16. TimelineView.onMovePatternBlock → `window.xleth.timeline.movePatternBlock(12, 3, 14400)`

**Bridge Flow:**
1. N-API function `timeline_movePatternBlock(blockId=12, trackId=3, posTicks=14400)` called
2. Executes: `MovePatternBlockCommand(12, 3, 14400, timeline)`
   - Snapshots: old trackId=3, old position=9600 ticks
3. Command executes: `timeline->movePatternBlock(12, 3, 14400)`
4. Timeline finds Block 12, updates: `position = {14400}`
5. Returns success
6. Calls `scheduleAudioEvents()` to rebuild event schedule

**Engine Side:**
- If audio is playing and playhead passes beat 15, PatternBlock 12 will now trigger notes
- Video events recalculated: note instances in Block 12's window recomputed with new timeline position

**UI Update:**
1. Returns from API
2. TimelineView.handleMovePatternBlock listens to undo, refetches pattern blocks
3. Block 12's position is now 14400 ticks (beat 15)
4. Canvas re-renders: Block 12 appears 5 beats to the right visually

---

### Scenario 4: Open Piano Roll Tab, Switch Patterns via Dropdown

**Starting State:** App open, TimelineView showing timeline, no piano roll open

**User Action:** Right-click PatternBlock 12 (Pattern 5) → "Open in Piano Roll"

**UI Flow:**
1. Context menu handler triggered
2. Dispatches event: `open-piano-roll` with `detail: { patternId: 5, blockId: 12 }`
3. App.jsx listens → `onOpen` handler:
   - `setPianoRollPatternId(5)`
   - `setActiveCenterTab('piano-roll')`
4. React re-renders: center tab switches to PianoRoll component
5. PianoRoll mounts with `patternId={5}`
6. Calls `fetchPattern(5)` → `window.xleth.timeline.getPattern(5)`
7. Bridge returns Pattern 5 object with notes array
8. `setPattern(...)` → canvas renders all notes in Pattern 5
9. Piano roll dropdown shows `currentPatternId={5}`
10. `availablePatterns` prop includes all patterns (passed from App.jsx's `allPatterns` state)

**User Action:** Click pattern dropdown, select Pattern 7

**UI Flow:**
1. `handlePatternChange()` → `onSwitchPattern(7)` called
2. App.handleSwitchPattern → `setPianoRollPatternId(7)`
3. PianoRoll re-mounts with `patternId={7}`
4. `fetchPattern(7)` → new pattern loaded
5. Canvas re-renders with Pattern 7's notes
6. Dropdown now shows Pattern 7

**Alternative: Click "+ New Pattern"**

1. `handlePatternChange()` detects special value `__new__`
2. Calls `onNewPattern()` (from App)
3. App.handleNewPatternFromPianoRoll:
   - Gets current pattern 5
   - Finds its region (7) and all patterns in that region
   - Generates unique name "Pattern 1"
   - Calls `window.xleth.timeline.addPattern({ name: 'Pattern 1', regionId: 7, lengthTicks: 3840 })`
4. Bridge executes AddPatternCommand
5. Returns new pattern ID (e.g., 9)
6. App calls `fetchAllPatterns()` to update dropdown
7. App sets `setPianoRollPatternId(9)`
8. Piano roll opens Pattern 9 (empty)
9. User can now draw notes in new pattern

---

### Scenario 5: Detach Piano Roll into Floating Panel

**Starting State:** Piano roll open in tab, `pianoRollDetached === false`

**User Action:** Click "Detach" button (external link icon) in toolbar

**UI Flow:**
1. PianoRollToolbar.onDetach() called
2. Dispatches event: `piano-roll-detach`
3. App.jsx listens → handler:
   - `setPianoRollDetached(true)`
   - `setActiveCenterTab('timeline')` (switch back to timeline view)
4. React re-renders:
   - Center tab now shows TimelineView
   - App renders both TimelineView AND floating PianoRoll panel
5. Floating PianoRoll component:
   - Props: `floating={true}`, `onTitleMouseDown={dragHandler}`
   - Renders ResizablePanel wrapper with title bar
   - Title bar is draggable (registered drag listener)
   - User can drag panel around, resize it
   - "Dock" button visible instead of "Detach"

**User Action:** Click "Dock" button on floating panel

**UI Flow:**
1. PianoRollToolbar.onDock() called
2. Dispatches event: `piano-roll-dock`
3. App.jsx listens → handler:
   - `setPianoRollDetached(false)`
   - `setActiveCenterTab('piano-roll')` (switch to piano roll tab)
4. React re-renders:
   - Floating panel disappears
   - Center tab switches to PianoRoll component (no longer floating)
   - Component now takes full tab space

---

### Scenario 6: User Plays Pattern While PatternBlock Loops Beyond Pattern Length

**Starting State:** 
- Pattern 5 has 4 notes at positions 0, 1, 2, 3 beats (each 1 beat)
- Pattern 5 length = 4 beats (1 bar)
- PatternBlock 12: position 0, duration 8 beats (loops pattern twice), offset 0, patternId 5
- Track 3 is a Pattern track with region 7 (a pitch sample)

**Transport State:** BPM = 140, Transport starts playback

**Engine Flow:**

1. **scheduleAudioEvents() called before playback:**
   - Examines PatternBlock 12
   - Window: `[offset=0, offset+duration=8 beats)` in ticks = `[0, 7680)`
   - Pattern length = 4 beats = 3840 ticks
   - Loop calculations:
     - `firstLoopIdx = floor(0 / 3840) = 0`
     - `lastLoopIdx = floor((7680-1) / 3840) = 1`
   - Iteration L=0:
     - Note 0: `tapePos = 0*3840 + 0 = 0` ticks → in window → emit event at timeline beat 0
     - Note 1: `tapePos = 0*3840 + 960 = 960` → emit at beat 1
     - Note 2: `tapePos = 0*3840 + 1920 = 1920` → emit at beat 2
     - Note 3: `tapePos = 0*3840 + 2880 = 2880` → emit at beat 3
   - Iteration L=1:
     - Note 0: `tapePos = 1*3840 + 0 = 3840` → emit at beat 4
     - Note 1: `tapePos = 1*3840 + 960 = 4800` → emit at beat 5
     - Note 2: `tapePos = 1*3840 + 1920 = 5760` → emit at beat 6
     - Note 3: `tapePos = 1*3840 + 2880 = 6720` → emit at beat 7

2. **Audio playback at beat 0:**
   - AudioScheduler fires event for Pattern 5 note 0 (pitch 60, velocity 1.0)
   - MixEngine's Sampler 5 receives noteOn(60, 1.0)
   - Voice allocated, playback begins for region 7's sample, pitched to C4

3. **Audio playback at beat 1:**
   - Sampler 5 receives noteOff(60) from previous note
   - Envelope enters Release stage
   - New noteOn(60, 1.0) fires → another voice for next iteration of same pitch

4. **Audio playback at beat 4:**
   - Note 0 triggers again (second loop iteration)
   - Same pitch, same sample, plays again

**Video Rendering Flow:**

1. **scheduleAudioEvents() also emits VideoEvents:**
   - For each note instance, calculates:
     - Pitch → frame range in video (if pitch sample)
     - Velocity → video opacity
     - Timeline beat → timeline position
     - Track ID + note pitch → applies video flip mode cycling
   
2. **SyncManager::videoTick() at ~60 Hz:**
   - Checks current playhead beat
   - For each video event in range, renders corresponding frame
   - For Pattern track with `videoFlipMode = Clockwise`:
     - Note 0 (instance 0): flip mode index 0 % 4 = 0 → None
     - Note 1 (instance 1): flip mode index 1 % 4 = 1 → FlipY
     - Note 2 (instance 2): flip mode index 2 % 4 = 2 → FlipXY
     - Note 3 (instance 3): flip mode index 3 % 4 = 3 → FlipX
     - Note 0 (instance 4, second loop): flip mode index 4 % 4 = 0 → None (cycles again)

3. **Result:** Video shows cycling flips, audio plays pitched sample 8 times

---

## Timeline Constants & Helpers (`ui/src/constants/timeline.js`)

```javascript
const PPQ = 960                    // pulses per quarter note
const TRACK_HEIGHT = 72            // pixels
const BEATS_PER_BAR = 4
const CLIP_MIN_WIDTH_PX = 8
const MIN_DURATION_TICKS = 120     // 1/32 note

function beatToPixel(beat, scrollOffset, pixelsPerBeat) {
    return (beat - scrollOffset) * pixelsPerBeat
}

function pixelToBeat(x, scrollOffset, pixelsPerBeat) {
    return scrollOffset + x / pixelsPerBeat
}

function beatsToTicks(beats) {
    return Math.round(beats * PPQ)
}

function snapBeatToGrid(beat, gridDivisor = 4) {
    const beatSnap = 1 / gridDivisor  // 1/4 = 0.25 beats
    return Math.round(beat / beatSnap) * beatSnap
}
```

---

## Summary: Key Architectural Insights

### Unidirectional Data Flow
```
User Action (React UI)
    ↓
window.xleth.timeline.* API call (IPC)
    ↓
Bridge N-API → Execute Command
    ↓
Command modifies Timeline (engine)
    ↓
Bridge returns result to UI
    ↓
React state update + dispatch timelineEvents
    ↓
Listeners refetch data
    ↓
Canvas/components re-render
```

### Three Layers Handle Separate Concerns
1. **Engine (C++)**: Data model, undo/redo commands, audio synthesis, serialization
2. **Bridge (Node-API)**: IPC marshalling, command execution, sampler refresh, event scheduling
3. **UI (React)**: Interaction, drawing, tool state, event dispatch, async data fetching

### Pattern Playback Uniqueness
- Pattern is bound to ONE region (1:1 mapping)
- PatternBlock can loop pattern multiple times on timeline
- Looping is calculated at schedule time: which note-instances fall in the block's time window?
- Sampler (per-pattern) handles pitch interpolation and ADSR envelope
- Video flip mode cycles per note-instance (not per pattern)

### Undo/Redo Coverage
- ALL mutations go through Command classes
- Each command snapshots state at construction, restores via `Timeline::restore*()` methods
- UndoManager maintains stack of executed commands
- Automatic for user, transparent to UI (just call API, engine handles undo setup)

---

This architecture allows XLETH to manage complex pattern-based sequencing with full undo/redo, precise audio/video sync, and a responsive interactive UI across three isolated, well-defined layers.