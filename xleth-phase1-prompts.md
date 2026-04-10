# Xleth — Phase 1 Prompt Sequence for Claude Code
### Build Prompts 1–24 | Core Engine + Sample Picker + Timeline
### Phase 1A (Foundation) → Phase 1B (Source Pool + Sample Picker) → Phase 1C (Timeline + Pencil Tool)

---

## How to Use This Document

Same rules as Phase 0:
1. Copy-paste each prompt into Claude Code **one at a time**
2. Each prompt includes **mandatory debug logging** — Claude Code must add these logs
3. Each prompt includes a **self-verification script** that Claude Code runs before declaring done
4. Each prompt includes **documentation references** for Claude Code to read if unsure
5. Do NOT proceed to the next prompt until verification passes

**New rule for Phase 1:** Every prompt ends with a verification script that Claude Code
runs itself. If any check fails, Claude Code must fix it before telling you it's done.

---

# ═══════════════════════════════════════════════════
# PHASE 1A — FOUNDATION
# The data model, project persistence, and engine rewrite
# ═══════════════════════════════════════════════════

## PROMPT 1 — Timeline Data Model: Core Types

```
We are starting Phase 1 of Xleth — the Sparta Remix DAW. Phase 0 proved the 
tech works. Phase 1 builds the real foundation. This prompt creates the core 
data model that EVERYTHING else depends on.

CONTEXT: Xleth combines FL Studio-style sequencing with Vegas-style video 
compositing for the Sparta Remix community. The data model must support:
- Audio samples with video frames (every sample has both audio and video)
- Labels/categories (Kick, Snare, HiHat, Crash, Pitch, Quote, custom)
- Quote samples that can be subdivided into numbered syllables
- Dual time: musical ticks (960 PPQ) + absolute samples
- BPM-locked grid at typically 140 BPM

Create these files in engine/src/model/:
- TimelineTypes.h      (all type definitions, enums, structs)
- Timeline.h/.cpp      (the timeline container)
- Track.h/.cpp         (individual track)
- Clip.h/.cpp          (a placed sample on a track)
- SampleRegion.h/.cpp  (a marked region from a source video)

══════════════════════════════════════════════════════
DOCUMENTATION REFERENCES — Read these before coding:
══════════════════════════════════════════════════════
- JUCE ValueTree docs: https://docs.juce.com/master/classValueTree.html
  (We're NOT using ValueTree yet, but understand the pattern — tree of 
  named properties that can serialize to XML/JSON. We'll use plain structs 
  + JSON for now.)
- nlohmann/json: https://github.com/nlohmann/json
  (Add to vcpkg.json: "nlohmann-json". This is our serialization library.)
- WAV smpl chunk spec: http://www.piclist.com/techref/io/serial/midi/wave.html
  (For root note detection from the smpl chunk — MIDI Unity Note field)

══════════════════════════════════════════════════════
TYPE DEFINITIONS (TimelineTypes.h):
══════════════════════════════════════════════════════

// Time representation — all positions use this
struct TickTime {
    int64_t ticks;  // Musical time at 960 PPQ (pulses per quarter note)
    
    static TickTime fromBeats(double beats) { 
        return {static_cast<int64_t>(beats * 960.0)}; 
    }
    static TickTime fromBars(int bars, int beatsPerBar = 4) { 
        return fromBeats(bars * beatsPerBar); 
    }
    static TickTime from16th(int sixteenths) { 
        return {static_cast<int64_t>(sixteenths * 240)}; 
    }
    double toBeats() const { return ticks / 960.0; }
    double toSeconds(double bpm) const { 
        return (ticks / 960.0) * (60.0 / bpm); 
    }
    int64_t toSamples(double bpm, double sampleRate) const {
        return static_cast<int64_t>(toSeconds(bpm) * sampleRate);
    }
    
    bool operator<(const TickTime& o) const { return ticks < o.ticks; }
    bool operator==(const TickTime& o) const { return ticks == o.ticks; }
    bool operator<=(const TickTime& o) const { return ticks <= o.ticks; }
    TickTime operator+(const TickTime& o) const { return {ticks + o.ticks}; }
    TickTime operator-(const TickTime& o) const { return {ticks - o.ticks}; }
};

// Sample labels — the categories used in Sparta Remixes
enum class SampleLabel {
    Kick,
    Snare,
    HiHat,
    Crash,
    Pitch,
    Quote,
    Custom  // User-defined label, name stored separately
};

// Convert SampleLabel to/from string for serialization
std::string sampleLabelToString(SampleLabel label);
SampleLabel stringToSampleLabel(const std::string& str);

// A source media file in the project
struct SourceMedia {
    int id;                     // Unique ID within project
    std::string filePath;       // Original file path
    std::string proxyPath;      // DNxHR proxy path (empty if not transcoded yet)
    std::string fileName;       // Display name
    int width, height;          // Video resolution
    double fps;                 // Frame rate
    double duration;            // Duration in seconds
    int totalFrames;            // Total frame count
    bool hasVideo;              // Some sources might be audio-only
    bool proxyReady;            // Is proxy transcoding complete?
};

// A marked region within a source video — this is what the Sample Picker creates
struct SampleRegion {
    int id;                     // Unique ID within project
    int sourceId;               // Which SourceMedia this comes from
    std::string name;           // User-given name or auto-generated
    SampleLabel label;          // Category (Kick, Snare, Pitch, Quote, etc.)
    std::string customLabelName;// Only used when label == Custom
    
    // Time range within the source video
    double startTime;           // Start time in source (seconds)
    double endTime;             // End time in source (seconds)
    int startFrame;             // Start frame number
    int endFrame;               // End frame number
    
    // Audio properties
    std::string audioFilePath;  // Path to exported audio (empty if not exported)
    std::string swappedAudioPath; // Path to swapped/processed audio (empty if not swapped)
    int rootNote;               // MIDI note number (60 = C4), -1 if unknown
    bool hasSwappedAudio;       // Using processed audio instead of original
    
    // Quote-specific: syllable markers (only used when label == Quote)
    struct Syllable {
        double startTime;       // Start time within the region (relative to startTime)
        double endTime;         // End time within the region
        int number;             // 1-indexed syllable number
        std::string text;       // Optional text label ("That", "is", "not", "true")
    };
    std::vector<Syllable> syllables;
    
    // Computed
    double getDuration() const { return endTime - startTime; }
    int getFrameCount() const { return endFrame - startFrame + 1; }
    bool isQuote() const { return label == SampleLabel::Quote; }
    bool hasSyllables() const { return !syllables.empty(); }
};

// A clip placed on the timeline — references a SampleRegion
struct Clip {
    int id;                     // Unique ID within project
    int trackId;                // Which track this clip is on
    int regionId;               // Which SampleRegion this references
    
    TickTime position;          // Start position on timeline (in ticks)
    TickTime duration;          // Duration on timeline (in ticks)
    
    // For Quote syllable clips: which syllable (-1 = whole region)
    int syllableIndex;          // -1 = full region, 0+ = specific syllable
    
    // Playback modifiers
    float velocity;             // 0.0–1.0 amplitude
    int pitchOffset;            // Semitones from root (0 = root, 12 = octave up)
    
    // Computed helpers
    bool isSyllableClip() const { return syllableIndex >= 0; }
};

// A track on the timeline
struct TrackInfo {
    int id;                     // Unique ID
    std::string name;           // "Kick", "Pitch 1", "Chorus", etc.
    float volume;               // 0.0–1.0
    float pan;                  // -1.0 (left) to 1.0 (right)
    bool muted;
    bool solo;
    int order;                  // Display order (0 = top)
    
    // Video layout properties (for the Sparta grid)
    float videoX, videoY;       // Position in compositor (-1 to 1)
    float videoW, videoH;       // Size in compositor
    float videoOpacity;         // 0.0–1.0
    int videoZOrder;            // Compositing order
};

══════════════════════════════════════════════════════
Timeline CLASS:
══════════════════════════════════════════════════════

class Timeline {
public:
    Timeline();
    
    // Project properties
    void setBPM(double bpm);
    double getBPM() const;
    void setSampleRate(double sr);
    double getSampleRate() const;
    void setTimeSignature(int numerator, int denominator);
    
    // Source media management
    int addSource(const SourceMedia& source);
    const SourceMedia* getSource(int id) const;
    std::vector<const SourceMedia*> getAllSources() const;
    void removeSource(int id);
    
    // Sample region management
    int addRegion(const SampleRegion& region);
    const SampleRegion* getRegion(int id) const;
    SampleRegion* getRegionMutable(int id);
    std::vector<const SampleRegion*> getRegionsByLabel(SampleLabel label) const;
    std::vector<const SampleRegion*> getAllRegions() const;
    void removeRegion(int id);
    
    // Track management
    int addTrack(const TrackInfo& track);
    const TrackInfo* getTrack(int id) const;
    TrackInfo* getTrackMutable(int id);
    std::vector<const TrackInfo*> getAllTracks() const;
    void removeTrack(int id);
    void reorderTrack(int trackId, int newOrder);
    
    // Clip management
    int addClip(const Clip& clip);
    const Clip* getClip(int id) const;
    Clip* getClipMutable(int id);
    std::vector<const Clip*> getClipsOnTrack(int trackId) const;
    std::vector<const Clip*> getClipsInRange(TickTime start, TickTime end) const;
    void removeClip(int id);
    void moveClip(int clipId, int newTrackId, TickTime newPosition);
    void resizeClip(int clipId, TickTime newDuration);
    
    // Serialization
    nlohmann::json toJSON() const;
    static Timeline fromJSON(const nlohmann::json& j);
    
    // Utility
    TickTime getEndTime() const;  // End of last clip
    int getNextId();              // Thread-safe auto-increment ID generator

private:
    double bpm_ = 140.0;
    double sampleRate_ = 48000.0;
    int timeSignatureNum_ = 4;
    int timeSignatureDen_ = 4;
    
    std::map<int, SourceMedia> sources_;
    std::map<int, SampleRegion> regions_;
    std::map<int, TrackInfo> tracks_;
    std::map<int, Clip> clips_;
    
    std::atomic<int> nextId_{1};
};

══════════════════════════════════════════════════════
MANDATORY DEBUG LOGGING:
══════════════════════════════════════════════════════
Add these logs using juce::Logger or a custom log macro:
- [Timeline] Created new timeline: BPM={}, SR={}, TimeSig={}/{}
- [Timeline] Added source #{}: "{}" ({}x{}, {}fps, {}s)
- [Timeline] Added region #{}: "{}" label={} source={} [{:.3f}s - {:.3f}s]
- [Timeline] Added track #{}: "{}" order={}
- [Timeline] Added clip #{}: region={} track={} pos={} dur={} syl={}
- [Timeline] Removed clip #{} from track #{}
- [Timeline] Moved clip #{} to track #{} pos={}
- [Timeline] Serialized to JSON: {} sources, {} regions, {} tracks, {} clips
- [Timeline] Deserialized from JSON: {} sources, {} regions, {} tracks, {} clips
- [Timeline] ERROR: Region #{} references non-existent source #{}
- [Timeline] ERROR: Clip #{} references non-existent region #{}

══════════════════════════════════════════════════════
SELF-VERIFICATION SCRIPT (add to engine/test/):
══════════════════════════════════════════════════════
Create engine/test/test_timeline.cpp — a standalone test that:

1. Create a Timeline with BPM=140, SR=48000
2. Add 2 SourceMedia entries (fake data, no actual files needed)
3. Add 5 SampleRegions:
   - 1 Kick region, 1 Snare, 1 HiHat, 1 Pitch, 1 Quote with 4 syllables
4. Add 3 Tracks: "Kick", "Pitch 1", "Chorus"
5. Add 10 Clips across the tracks at various positions
6. Verify:
   - getClipsOnTrack() returns correct clips per track
   - getClipsInRange() returns clips within a beat range
   - getRegionsByLabel(Kick) returns exactly 1 region
   - TickTime::fromBeats(4).toSeconds(140) ≈ 1.714s (within 0.001)
   - TickTime::from16th(1).ticks == 240
   - TickTime::fromBars(1).toBeats() == 4.0
7. Serialize to JSON, deserialize back, verify all data matches:
   - Same number of sources, regions, tracks, clips
   - All clip positions match
   - All region syllables preserved
   - All track properties preserved
8. Test removeClip(), moveClip(), resizeClip()
9. Print: "ALL TESTS PASSED" or "FAILED: {reason}"

Add a build target for this test in CMakeLists.txt.
Run it automatically after building.

══════════════════════════════════════════════════════
DO NOT:
- Create any UI code
- Modify the Phase 0 audio engine yet
- Create the Sample Picker
- Create any file I/O beyond JSON serialization
- Use JUCE ValueTree (we're using plain structs + nlohmann/json)
- Make Timeline thread-safe with mutexes yet (single-thread for now)

VERIFY: test_timeline.exe runs and prints "ALL TESTS PASSED"
```

---

## PROMPT 2 — Project Save/Load + Media References

```
We are adding project persistence to Xleth. Users must be able to save their 
project, close Xleth, reopen it, and have everything restored.

CONTEXT: A Xleth project is a directory containing:
  MyRemix/
  ├── project.json         (Timeline serialized to JSON)
  ├── proxies/             (DNxHR proxy files, generated on import)
  ├── exports/             (Exported sample audio files)
  └── swapped/             (Swapped/processed audio files)

Source media files are NOT copied into the project — they are referenced by 
absolute path. If a source file moves, Xleth will warn the user (like Vegas 
and FL do).

Create these files in engine/src/project/:
- ProjectManager.h/.cpp

══════════════════════════════════════════════════════
DOCUMENTATION REFERENCES:
══════════════════════════════════════════════════════
- nlohmann/json serialization: https://github.com/nlohmann/json#serialization--deserialization
- std::filesystem (C++17): https://en.cppreference.com/w/cpp/filesystem
- JUCE File class: https://docs.juce.com/master/classFile.html

══════════════════════════════════════════════════════
REQUIREMENTS FOR ProjectManager:
══════════════════════════════════════════════════════

class ProjectManager {
public:
    // Create a new empty project at the given directory path
    bool createProject(const std::string& projectDir, const std::string& projectName);
    
    // Save current timeline state to project.json
    bool saveProject(const Timeline& timeline);
    
    // Load project from directory, returns populated Timeline
    std::optional<Timeline> loadProject(const std::string& projectDir);
    
    // Check if all source media files are still accessible
    struct MediaStatus {
        int sourceId;
        std::string filePath;
        bool found;
        std::string error;  // "File not found", "File modified since import", etc.
    };
    std::vector<MediaStatus> validateMedia(const Timeline& timeline);
    
    // Import a source video into the project
    // 1. Adds to Timeline as SourceMedia
    // 2. Kicks off proxy transcoding into proxies/ subfolder
    // Returns source ID, or -1 on failure
    int importSource(Timeline& timeline, const std::string& filePath,
                     std::function<void(float)> progressCallback = nullptr);
    
    // Get project paths
    std::string getProjectDir() const;
    std::string getProxiesDir() const;
    std::string getExportsDir() const;
    std::string getSwappedDir() const;

private:
    std::string projectDir_;
    std::string projectName_;
    
    void ensureDirectories();  // Create proxies/, exports/, swapped/ if missing
};

SAVE FORMAT (project.json):
{
    "xleth_version": "0.1.0",
    "project_name": "My Remix",
    "created_at": "2026-04-03T12:00:00Z",
    "modified_at": "2026-04-03T14:30:00Z",
    "bpm": 140.0,
    "sample_rate": 48000.0,
    "time_signature": [4, 4],
    "sources": [ ... ],
    "regions": [ ... ],
    "tracks": [ ... ],
    "clips": [ ... ],
    "custom_labels": ["Arp", "Pad"]
}

IMPORT LOGIC:
1. Validate the file exists and is a supported format (mp4, avi, mov, mkv, wav, mp3)
2. Open with VideoDecoder to get metadata (resolution, fps, duration)
3. If video file → kick off proxy transcode to proxies/ directory
   Use ProxyTranscoder from Phase 0. Non-blocking: run in a std::thread
4. Create SourceMedia entry in Timeline
5. Log everything

MEDIA VALIDATION on load:
1. For each source in the loaded timeline:
   a. Check if original file exists at stored path
   b. Check if proxy exists in proxies/ directory
   c. If original missing: add to warning list
   d. If proxy missing but original exists: re-transcode
   e. If both missing: error

══════════════════════════════════════════════════════
MANDATORY DEBUG LOGGING:
══════════════════════════════════════════════════════
- [Project] Creating new project: "{}" at "{}"
- [Project] Directories created: proxies/, exports/, swapped/
- [Project] Saved project: {} sources, {} regions, {} tracks, {} clips ({} bytes)
- [Project] Loaded project: "{}" (v{}) — {} sources, {} regions, {} tracks, {} clips
- [Project] Importing source: "{}" ({})
- [Project] Proxy transcode started: "{}" → "{}"
- [Project] Proxy transcode complete: "{}" ({:.1f}s, {:.1f}MB)
- [Project] Media validation: {}/{} sources found
- [Project] WARNING: Source #{} missing: "{}"
- [Project] WARNING: Proxy missing for source #{}, re-transcoding
- [Project] ERROR: Failed to save: {}
- [Project] ERROR: Failed to load: {}
- [Project] ERROR: Invalid JSON: {}

══════════════════════════════════════════════════════
SELF-VERIFICATION SCRIPT (engine/test/test_project.cpp):
══════════════════════════════════════════════════════
1. Create a temp directory for test project
2. Create ProjectManager, call createProject()
3. Verify directory structure exists (proxies/, exports/, swapped/)
4. Create a Timeline with test data (2 sources, 3 regions, 2 tracks, 5 clips)
5. Save project
6. Verify project.json exists and is valid JSON
7. Load project into a NEW Timeline instance
8. Compare: all sources, regions, tracks, clips match originals
   - Compare BPM, sample rate, time signature
   - Compare all clip positions, durations, labels
   - Compare all region syllable data
9. Test media validation with a fake missing source path
   - Verify it reports the source as missing
10. Clean up temp directory
11. Print "ALL TESTS PASSED" or "FAILED: {reason}"

══════════════════════════════════════════════════════
DO NOT:
- Create any UI code
- Implement auto-save yet
- Copy source media into the project directory
- Use binary project format (JSON only for now)
- Compress the project directory (no .zip packaging)

VERIFY: test_project.exe prints "ALL TESTS PASSED"
```

---

## PROMPT 3 — Undo/Redo System

```
We are adding undo/redo to Xleth. Every edit to the timeline must be 
reversible with Ctrl+Z and re-doable with Ctrl+Y.

══════════════════════════════════════════════════════
DOCUMENTATION REFERENCES:
══════════════════════════════════════════════════════
- Command Pattern: https://refactoring.guru/design-patterns/command
- JUCE UndoManager: https://docs.juce.com/master/classUndoManager.html
  (Reference only — we're implementing our own)

══════════════════════════════════════════════════════
DESIGN: We use the Command Pattern, not state snapshots.
══════════════════════════════════════════════════════

Create these files in engine/src/commands/:
- UndoManager.h/.cpp
- Command.h            (base class)
- TimelineCommands.h/.cpp (all concrete commands)

BASE CLASS:
class Command {
public:
    virtual ~Command() = default;
    virtual void execute(Timeline& timeline) = 0;
    virtual void undo(Timeline& timeline) = 0;
    virtual std::string describe() const = 0;  // "Add Clip", "Move Clip", etc.
};

CONCRETE COMMANDS (implement all of these):
- AddClipCommand(Clip clip)
    execute: timeline.addClip(clip)
    undo: timeline.removeClip(clip.id)

- RemoveClipCommand(int clipId)
    execute: store clip data, then timeline.removeClip(clipId)
    undo: timeline.addClip(storedClip)

- MoveClipCommand(int clipId, int newTrackId, TickTime newPosition)
    execute: store old track+position, then timeline.moveClip(...)
    undo: timeline.moveClip(clipId, oldTrackId, oldPosition)

- ResizeClipCommand(int clipId, TickTime newDuration)
    execute: store old duration, then timeline.resizeClip(...)
    undo: timeline.resizeClip(clipId, oldDuration)

- AddTrackCommand(TrackInfo track)
    execute/undo: add/remove track

- RemoveTrackCommand(int trackId)
    execute: store track + all clips on it, remove track and clips
    undo: restore track and all clips

- AddRegionCommand(SampleRegion region)
    execute/undo: add/remove region

- ModifyRegionCommand(int regionId, SampleRegion newState)
    execute: store old state, apply new state
    undo: restore old state

- SetBPMCommand(double newBPM)
    execute: store old BPM, set new
    undo: restore old BPM

UNDO MANAGER:
class UndoManager {
public:
    UndoManager(int maxHistory = 100);
    
    // Execute a command and push to undo stack
    void execute(std::unique_ptr<Command> cmd, Timeline& timeline);
    
    // Undo the last command
    bool undo(Timeline& timeline);
    
    // Redo the last undone command
    bool redo(Timeline& timeline);
    
    // State queries
    bool canUndo() const;
    bool canRedo() const;
    std::string getUndoDescription() const;  // "Undo: Move Clip"
    std::string getRedoDescription() const;  // "Redo: Move Clip"
    int getUndoCount() const;
    int getRedoCount() const;
    
    // Clear all history (e.g., on project load)
    void clear();

private:
    std::vector<std::unique_ptr<Command>> undoStack_;
    std::vector<std::unique_ptr<Command>> redoStack_;
    int maxHistory_;
};

KEY RULES:
- When a new command is executed, the redo stack is CLEARED
  (you can't redo after making a new edit — standard behavior)
- When undo stack exceeds maxHistory, remove the oldest command
- RemoveTrackCommand must store ALL clips on that track so they can be 
  restored on undo (cascade delete + cascade restore)

══════════════════════════════════════════════════════
MANDATORY DEBUG LOGGING:
══════════════════════════════════════════════════════
- [Undo] Execute: {} (stack: {} undo, {} redo)
- [Undo] Undo: {} (stack: {} undo, {} redo)
- [Undo] Redo: {} (stack: {} undo, {} redo)
- [Undo] Stack overflow — dropping oldest: {}
- [Undo] Cleared history ({} commands discarded)
- [Undo] WARNING: Nothing to undo
- [Undo] WARNING: Nothing to redo

══════════════════════════════════════════════════════
SELF-VERIFICATION (engine/test/test_undo.cpp):
══════════════════════════════════════════════════════
1. Create Timeline + UndoManager
2. Add a track via command
3. Add 5 clips via commands
4. Verify timeline has 5 clips
5. Undo 3 times → verify 2 clips remain
6. Redo 2 times → verify 4 clips
7. Execute a new command → verify redo stack is cleared
8. Move a clip via command, undo → verify clip returned to original position
9. Resize a clip via command, undo → verify original duration restored
10. Remove track via command → verify all clips on it also removed
11. Undo remove track → verify track AND all clips restored
12. Set BPM via command, undo → verify original BPM
13. Execute 150 commands (over maxHistory=100) → verify stack is capped at 100
14. Print "ALL TESTS PASSED" or "FAILED: {reason}"

DO NOT:
- Make UndoManager thread-safe (single-thread access only)
- Implement compound/batch commands yet
- Create any UI code

VERIFY: test_undo.exe prints "ALL TESTS PASSED"
```

---

## PROMPT 4 — Audio Mixing Engine Rewrite

```
We are rewriting the audio engine for Phase 1. Phase 0's engine was a simple 
voice manager. Phase 1 needs proper multi-track mixing: per-track volume/pan, 
master bus, correct gain staging, and timeline-driven playback from the data model.

══════════════════════════════════════════════════════
DOCUMENTATION REFERENCES:
══════════════════════════════════════════════════════
- JUCE AudioBuffer: https://docs.juce.com/master/classAudioBuffer.html
- JUCE dsp module: https://docs.juce.com/master/group__juce__dsp.html
- Gain staging best practices: Google "DAW gain staging implementation"
- Pan laws: https://www.cs.cmu.edu/~music/icm-online/readings/panning/
  (We'll use constant-power pan law: L = cos(angle), R = sin(angle))

══════════════════════════════════════════════════════
REFACTOR PLAN:
══════════════════════════════════════════════════════

The Phase 0 AudioEngine stays mostly intact but we add a MixEngine layer 
on top of it. The audio callback now:
1. Asks MixEngine for the mixed output at the current transport position
2. MixEngine iterates all tracks, sums clips that fall in the current buffer window
3. Applies per-track volume + pan
4. Sums to master bus
5. Master bus output goes to the audio callback buffer

Create these files in engine/src/audio/:
- MixEngine.h/.cpp
- TrackMixer.h/.cpp

DO NOT delete or heavily modify Phase 0 code — build on top of it.

══════════════════════════════════════════════════════
MixEngine:
══════════════════════════════════════════════════════

class MixEngine {
public:
    MixEngine();
    
    // Set the timeline to read from (called once on project load)
    void setTimeline(const Timeline* timeline);
    
    // Set the sample bank (holds loaded audio data)
    void setSampleBank(const SampleBank* bank);
    
    // Process one buffer of audio. Called from the audio thread.
    // Reads transport position, finds active clips, mixes them.
    // AUDIO THREAD RULES APPLY: no alloc, no lock, no I/O
    void processBlock(juce::AudioBuffer<float>& outputBuffer,
                      int numSamples,
                      const Transport& transport);
    
    // Map a SampleRegion ID to a loaded sample ID in SampleBank
    // Called from the main thread during project setup
    void mapRegionToSample(int regionId, int sampleBankId);

    // Master bus levels (for meters)
    float getMasterPeakL() const;
    float getMasterPeakR() const;
    
    // Per-track levels (for meters)
    float getTrackPeakL(int trackId) const;
    float getTrackPeakR(int trackId) const;

private:
    const Timeline* timeline_ = nullptr;
    const SampleBank* sampleBank_ = nullptr;
    
    // Region ID → SampleBank ID mapping
    std::unordered_map<int, int> regionToSampleMap_;
    
    // Per-track intermediate buffers (pre-allocated, avoid allocating in audio thread)
    // Use a fixed pool of buffers, one per track
    std::vector<juce::AudioBuffer<float>> trackBuffers_;
    int maxTracks_ = 64;  // Pre-allocate for up to 64 tracks
    
    // Peak metering
    std::atomic<float> masterPeakL_{0.f}, masterPeakR_{0.f};
    struct TrackPeak { std::atomic<float> left{0.f}, right{0.f}; };
    std::vector<TrackPeak> trackPeaks_;
    
    // Pan law: constant-power
    void applyPan(juce::AudioBuffer<float>& buffer, float pan);
    
    // Find which clips are active at the given sample range
    // Returns via pre-allocated vector to avoid audio-thread allocation
    struct ActiveClip {
        const Clip* clip;
        int sampleBankId;
        int64_t clipStartSample;   // Absolute sample position of clip start
        int64_t clipEndSample;     // Absolute sample position of clip end
        int64_t regionOffsetSamples; // Where in the sample to start playing
    };
    std::vector<ActiveClip> activeClips_;  // Pre-allocated
    void findActiveClips(int64_t bufferStartSample, int64_t bufferEndSample);
};

processBlock() ALGORITHM:
1. If no timeline or not playing → clear output buffer, return
2. Get transport position in samples
3. Convert buffer range: [positionSamples, positionSamples + numSamples)
4. Call findActiveClips() to populate activeClips_ vector
5. Clear all track buffers
6. For each active clip:
   a. Determine which track it's on → get track buffer index
   b. Get the audio data from sampleBank via regionToSampleMap_
   c. Calculate read position within the sample:
      readPos = (bufferStart - clipStartSample) + regionOffsetSamples
   d. Copy/add sample data to the track buffer
   e. Apply velocity scaling
7. For each track with content:
   a. Apply track volume
   b. Apply constant-power pan
   c. Update track peak meters
   d. Add to output buffer (master sum)
8. Apply master volume (1.0 for now — no master fader yet)
9. Update master peak meters
10. Clamp output to [-1.0, 1.0] (soft clip or hard clip)

CONSTANT-POWER PAN LAW:
pan = 0.0 (center) → L = cos(π/4), R = sin(π/4) → both ≈ 0.707 (−3dB)
pan = -1.0 (full left) → L = 1.0, R = 0.0
pan = 1.0 (full right) → L = 0.0, R = 1.0
Formula: angle = (pan + 1.0) * π/4
          L = cos(angle), R = sin(angle)

MODIFY AudioEngine:
1. AudioEngine now owns a MixEngine
2. In getNextAudioBlock():
   a. Clear output buffer
   b. Drain manual trigger queue (keyboard triggers still work)
   c. Call voiceManager.processBlock() for manual triggers
   d. Call mixEngine.processBlock() for timeline playback
   e. Sum both into output (manual triggers overlay timeline playback)

══════════════════════════════════════════════════════
MANDATORY DEBUG LOGGING:
══════════════════════════════════════════════════════
IMPORTANT: These logs must NOT fire from the audio thread.
Use a lock-free log queue that the main thread drains periodically.

- [MixEngine] Timeline set: {} tracks, {} clips
- [MixEngine] Region #{} mapped to sample #{}
- [MixEngine] Active clips at beat {:.2f}: {} clips on {} tracks
  (Log this ONCE per second, not every buffer — use a frame counter)
- [MixEngine] WARNING: Clip #{} references unmapped region #{}
- [MixEngine] WARNING: Track buffer overflow — more than {} active tracks
- [MixEngine] Master peak: L={:.3f} R={:.3f}
  (Log once per second)

══════════════════════════════════════════════════════
SELF-VERIFICATION (engine/test/test_mix.cpp):
══════════════════════════════════════════════════════
1. Create a Timeline with BPM=140
2. Add 3 tracks: Kick (vol=1.0, pan=0), Snare (vol=0.8, pan=-0.5), HiHat (vol=0.6, pan=0.5)
3. Add regions + clips: kick on beats 1,2,3,4; snare on beats 2,4; hihat on every 8th note
4. Load actual WAV samples into SampleBank
5. Map regions to samples
6. Create an offline render: process 4 bars (= 4*4 beats = 16 beats at 140 BPM)
   into an AudioBuffer
7. Verify:
   - Output buffer is not silent (RMS > 0.01)
   - Output buffer does not clip (no samples > 1.0)
   - Peak occurs around beats 2 and 4 (where kick + snare overlap)
   - Panned tracks: left channel has more snare energy, right has more hihat
8. Test with muted track: mute the kick track, verify kick beats are silent
9. Test with solo track: solo the snare track, verify only snare is audible
10. Print "ALL TESTS PASSED" or "FAILED: {reason}"

DO NOT:
- Add effects processing (Phase 3)
- Add automation
- Add audio recording
- Modify Transport class
- Use juce::AudioProcessorGraph (we're doing manual mixing)

VERIFY: test_mix.exe prints "ALL TESTS PASSED"
```

---

## PROMPT 5 — Video Frame Delivery to Electron (SharedArrayBuffer)

```
We are upgrading video frame delivery from Phase 0's empty-buffer stub to 
real frame data using SharedArrayBuffer for zero-copy transfer between the 
C++ engine and Electron's renderer process.

══════════════════════════════════════════════════════
DOCUMENTATION REFERENCES:
══════════════════════════════════════════════════════
- SharedArrayBuffer: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/SharedArrayBuffer
- Node-API SharedArrayBuffer: https://nodejs.org/api/n-api.html#napi_create_arraybuffer
- Electron security: SharedArrayBuffer requires COOP/COEP headers OR 
  the --enable-features=SharedArrayBuffer flag. In Electron main process 
  for BrowserWindow, set:
  webPreferences: {
    nodeIntegration: false,
    contextIsolation: true,
    crossOriginIsolatorEnabled: true
  }
  OR set the response headers via session.defaultSession.webRequest

══════════════════════════════════════════════════════
ARCHITECTURE:
══════════════════════════════════════════════════════

The C++ engine writes composited RGBA frames into a shared memory buffer.
The Electron renderer reads from this buffer and draws to a WebGL canvas.

Flow:
1. Engine allocates a shared memory region (double-buffered)
2. Node-API addon creates a SharedArrayBuffer pointing to this memory
3. Renderer process receives the SharedArrayBuffer via IPC
4. Engine's video thread: decode frame → composite → write RGBA to shared buffer
5. Renderer's requestAnimationFrame: read from shared buffer → upload to WebGL texture → draw

Double-buffer scheme:
- Buffer A and Buffer B (each = width * height * 4 bytes for RGBA)
- Engine writes to the "back" buffer while renderer reads from the "front"
- Atomic flag indicates which buffer is current
- No mutex needed — just an atomic swap

Create/modify these files:
- engine/src/video/FrameOutput.h/.cpp  (shared buffer manager)
- bridge/src/XlethAddon.cpp            (add SharedArrayBuffer creation)
- ui/src/components/VideoPreview.jsx    (WebGL rendering)

══════════════════════════════════════════════════════
FrameOutput (C++ side):
══════════════════════════════════════════════════════

class FrameOutput {
public:
    FrameOutput();
    ~FrameOutput();
    
    // Allocate shared buffers for given resolution
    void initialize(int width, int height);
    
    // Write an RGBA frame to the back buffer, then swap
    // Called from the video thread
    void writeFrame(const uint8_t* rgbaData, int width, int height);
    
    // Write from YUV planes (converts to RGBA internally)
    void writeFrameYUV(const uint8_t* yPlane, const uint8_t* uPlane, const uint8_t* vPlane,
                       int width, int height, int yStride, int uStride, int vStride);
    
    // Get pointer to the current "front" buffer (for reading)
    // Called from whatever thread serves frame data to JS
    const uint8_t* getCurrentFrame() const;
    
    // Get the raw buffer pointers (for SharedArrayBuffer creation)
    uint8_t* getBufferA();
    uint8_t* getBufferB();
    size_t getBufferSize() const;  // width * height * 4
    
    // Which buffer is current (0=A, 1=B)
    int getCurrentBufferIndex() const;
    
    int getWidth() const;
    int getHeight() const;
    bool hasFrame() const;

private:
    std::vector<uint8_t> bufferA_;
    std::vector<uint8_t> bufferB_;
    std::atomic<int> currentBuffer_{0};  // 0=A is front, 1=B is front
    int width_ = 0, height_ = 0;
    std::atomic<bool> hasFrame_{false};
    
    // YUV→RGBA conversion (CPU-based, runs on video thread)
    void yuvToRGBA(const uint8_t* y, const uint8_t* u, const uint8_t* v,
                   uint8_t* rgba, int w, int h, int yStride, int uStride, int vStride);
};

══════════════════════════════════════════════════════
Bridge additions (XlethAddon.cpp):
══════════════════════════════════════════════════════

Add these new exports:

// Returns a SharedArrayBuffer backed by the engine's frame output buffer
// The JS side reads from this without any copy
Napi::Value GetFrameBuffer(const Napi::CallbackInfo& info);
  // Creates a SharedArrayBuffer wrapping FrameOutput's buffer
  // Returns: { buffer: SharedArrayBuffer, width: int, height: int, 
  //            currentIndexPtr: SharedArrayBuffer(4 bytes for atomic int) }

// Get current frame as a regular Buffer (fallback if SAB not available)
Napi::Buffer<uint8_t> GetCurrentFrameRGBA(const Napi::CallbackInfo& info);

// Set video output resolution
Napi::Undefined SetVideoResolution(const Napi::CallbackInfo& info);
  // Args: (int width, int height)

══════════════════════════════════════════════════════
VideoPreview.jsx (WebGL rendering):
══════════════════════════════════════════════════════

The renderer component:
1. On mount: request SharedArrayBuffer from main process via IPC
2. Create WebGL context on canvas
3. Create a single RGBA texture
4. requestAnimationFrame loop:
   a. Read currentBufferIndex from shared atomic
   b. Create Uint8Array view into the correct half of SharedArrayBuffer
   c. Upload to WebGL texture via texSubImage2D
   d. Draw fullscreen quad
   e. Display FPS counter

If SharedArrayBuffer is not available (security restrictions):
- Fall back to IPC-based frame polling (call getFrameRGBA via IPC)
- Log warning about reduced performance

══════════════════════════════════════════════════════
MANDATORY DEBUG LOGGING:
══════════════════════════════════════════════════════
- [FrameOutput] Initialized: {}x{} (buffer size: {} bytes, total: {} MB)
- [FrameOutput] Frame written to buffer {} ({:.2f}ms conversion time)
- [FrameOutput] Buffer swap: {} → {}
- [Bridge] SharedArrayBuffer created: {} bytes
- [Bridge] FALLBACK: SharedArrayBuffer not available, using Buffer copy
- [VideoPreview] WebGL context created: {} renderer
- [VideoPreview] SharedArrayBuffer mode: {} bytes
- [VideoPreview] FPS: {} (target: 30)
- [VideoPreview] WARNING: Frame upload > 5ms ({:.2f}ms)
- [VideoPreview] ERROR: WebGL context lost

══════════════════════════════════════════════════════
SELF-VERIFICATION:
══════════════════════════════════════════════════════
Add to bridge/test.js:
1. Initialize engine
2. Load a video source
3. Set video resolution to 640x360
4. Start playback
5. Call getFrameBuffer() — verify it returns a SharedArrayBuffer
6. Wait 1 second, read buffer — verify it's not all zeros
7. Call getFrameRGBA() — verify it returns a Buffer of correct size (640*360*4)
8. Verify buffer contains non-zero pixel data
9. Shutdown cleanly

In the Electron app:
- VideoPreview should show video frames during playback
- FPS counter should show ≥24fps
- Console should show "SharedArrayBuffer mode" (not fallback)

DO NOT:
- Use the OpenGL compositor in Electron (that stays standalone-only)
- Add video effects or transitions
- Handle window resize yet (fixed resolution for now)
- Implement multi-layer compositing in the renderer yet (single frame for now)

VERIFY: bridge test passes + Electron shows video frames at ≥24fps
```

---

## PROMPT 6 — Bridge + IPC Rewrite for Phase 1 Architecture

```
We need to update the Electron bridge and IPC layer to support the full 
Phase 1 architecture: project management, timeline operations, undo/redo, 
and the new mix engine. Phase 0's bridge was minimal — Phase 1's bridge 
must expose the complete engine API.

══════════════════════════════════════════════════════
DOCUMENTATION REFERENCES:
══════════════════════════════════════════════════════
- Electron IPC: https://www.electronjs.org/docs/latest/tutorial/ipc
- Electron contextBridge: https://www.electronjs.org/docs/latest/api/context-bridge
- node-addon-api: https://github.com/nodejs/node-addon-api/blob/main/doc/object.md

══════════════════════════════════════════════════════
BRIDGE API — Organized by domain:
══════════════════════════════════════════════════════

The addon exports a single object with nested namespaces:

xleth.project.create(dir, name) → bool
xleth.project.save() → bool
xleth.project.load(dir) → { success, warnings[] }
xleth.project.importSource(filePath) → { sourceId, transcoding }
xleth.project.validateMedia() → MediaStatus[]
xleth.project.getInfo() → { name, dir, modified }

xleth.timeline.getBPM() → number
xleth.timeline.setBPM(bpm) → void
xleth.timeline.getSources() → SourceMedia[]
xleth.timeline.getRegions() → SampleRegion[]
xleth.timeline.getRegionsByLabel(label) → SampleRegion[]
xleth.timeline.getTracks() → TrackInfo[]
xleth.timeline.getClips() → Clip[]
xleth.timeline.getClipsOnTrack(trackId) → Clip[]
xleth.timeline.getClipsInRange(startBeat, endBeat) → Clip[]

xleth.timeline.addTrack(trackInfo) → trackId
xleth.timeline.removeTrack(trackId) → void
xleth.timeline.addClip(clip) → clipId
xleth.timeline.removeClip(clipId) → void
xleth.timeline.moveClip(clipId, trackId, positionTicks) → void
xleth.timeline.resizeClip(clipId, durationTicks) → void

xleth.timeline.addRegion(region) → regionId
xleth.timeline.modifyRegion(regionId, region) → void
xleth.timeline.removeRegion(regionId) → void

xleth.undo.undo() → { success, description }
xleth.undo.redo() → { success, description }
xleth.undo.canUndo() → bool
xleth.undo.canRedo() → bool
xleth.undo.getUndoDescription() → string
xleth.undo.getRedoDescription() → string

xleth.transport.play() → void
xleth.transport.stop() → void
xleth.transport.pause() → void
xleth.transport.seek(beatPosition) → void
xleth.transport.getState() → { positionMs, positionBeats, positionBars, isPlaying, bpm }

xleth.audio.loadSample(filePath) → sampleId
xleth.audio.triggerSample(sampleId, velocity?) → void
xleth.audio.mapRegionToSample(regionId, sampleId) → void
xleth.audio.getMasterPeak() → { left, right }
xleth.audio.getTrackPeak(trackId) → { left, right }

xleth.video.setResolution(width, height) → void
xleth.video.getFrameBuffer() → { buffer, width, height, indexBuffer }
xleth.video.getFrameRGBA() → Buffer

xleth.sync.getStats() → { avgDriftMs, maxDriftMs, frameDrops, cacheHitRate }

IMPORTANT: All timeline mutation operations (addClip, removeClip, moveClip, 
resizeClip, addTrack, removeTrack, addRegion, modifyRegion, removeRegion, 
setBPM) MUST go through the UndoManager. The bridge calls UndoManager.execute() 
with the appropriate command, not Timeline directly.

UPDATE preload.js and main.js IPC handlers to match this full API.

══════════════════════════════════════════════════════
MANDATORY DEBUG LOGGING:
══════════════════════════════════════════════════════
- [Bridge] API call: {namespace}.{method}({args summary})
- [Bridge] API response: {namespace}.{method} → {result summary} ({:.2f}ms)
- [Bridge] ERROR: {namespace}.{method} — {}
- [Bridge] IPC handler registered: {}
- [IPC] Main→Renderer: {} ({} bytes)
- [IPC] Renderer→Main: {} 

══════════════════════════════════════════════════════
SELF-VERIFICATION (bridge/test_phase1.js):
══════════════════════════════════════════════════════
Write a comprehensive Node.js test:
1. Initialize engine
2. Create project in temp dir
3. Set BPM to 140
4. Add 3 tracks
5. Load 3 audio samples
6. Create 3 regions (fake metadata — no actual video needed)
7. Map regions to samples
8. Add 10 clips across tracks
9. Verify getClips() returns 10
10. Move a clip, verify new position
11. Undo, verify clip returned
12. Redo, verify clip moved again
13. Remove a clip, verify 9 remain
14. Undo, verify 10 again
15. Save project
16. Verify project.json exists
17. Shutdown
18. Re-initialize, load project
19. Verify all data matches (10 clips, 3 tracks, 3 regions)
20. Shutdown
21. Print: "PASSED: X/X tests"

DO NOT:
- Create any new UI components in this prompt
- Add Sample Picker functionality
- Add pencil tool logic

VERIFY: bridge/test_phase1.js prints all tests passed
```

---

# ═══════════════════════════════════════════════════
# PHASE 1B — SOURCE POOL + SAMPLE PICKER
# The core workflow innovation of Xleth
# ═══════════════════════════════════════════════════

## PROMPT 7 — Electron App Shell: Layout + Navigation

```
We are building the Phase 1 Electron app shell — the main window layout with 
panel areas, navigation, and the overall look and feel. No functionality yet, 
just the visual skeleton.

══════════════════════════════════════════════════════
DOCUMENTATION REFERENCES:
══════════════════════════════════════════════════════
- React 18: https://react.dev/reference/react
- CSS Grid/Flexbox for app layouts: https://css-tricks.com/snippets/css/complete-guide-grid/
- Lucide React icons: https://lucide.dev/guide/packages/lucide-react
  Install: npm install lucide-react
- Hanken Grotesk font: https://fonts.google.com/specimen/Hanken+Grotesk
  Install: npm install @fontsource/hanken-grotesk

══════════════════════════════════════════════════════
THEME (consistent across all of Xleth):
══════════════════════════════════════════════════════
CSS variables (define in a root stylesheet):

--bg-primary: #0A0A0F;        /* Main background */
--bg-secondary: #111118;      /* Panel backgrounds */
--bg-tertiary: #1A1A24;       /* Input fields, hover states */
--bg-elevated: #222230;       /* Dropdowns, tooltips */
--border: #2A2A38;             /* Panel borders */
--border-focused: #33CED6;     /* Focused/active borders */
--text-primary: #E8E8ED;      /* Primary text */
--text-secondary: #8888A0;    /* Secondary/dimmed text */
--text-tertiary: #555566;     /* Disabled/hint text */
--accent: #33CED6;            /* Teal accent (Xleth brand) */
--accent-hover: #2BB8BF;      /* Accent hover state */
--accent-dim: rgba(51,206,214,0.15);
--danger: #FF4757;            /* Delete, error */
--warning: #FFAA33;           /* Warnings */
--success: #22C55E;           /* Success, pass */

/* Sample label colors */
--label-kick: #FF6B6B;
--label-snare: #FFA94D;
--label-hihat: #FFD93D;
--label-crash: #FF6B9D;
--label-pitch: #69DB7C;
--label-quote: #748FFC;
--label-custom: #B197FC;

Font: 'Hanken Grotesk', system-ui, sans-serif
Icons: Lucide React (consistent with SlamShaper)

══════════════════════════════════════════════════════
MAIN WINDOW LAYOUT:
══════════════════════════════════════════════════════

┌─── Title Bar (custom, frameless) ────────────────────────────────────┐
│  ◉ Xleth    File  Edit  View     [project name]          _ □ X     │
├──────────────────────────────────────────────────────────────────────┤
│  ┌─── Left Panel (resizable) ───┐  ┌─── Center Area ─────────────┐ │
│  │                              │  │                              │ │
│  │   Tab: Project Media         │  │  ┌── Video Preview ───────┐ │ │
│  │   Tab: Sample Selector       │  │  │                        │ │ │
│  │                              │  │  │    (16:9 aspect)       │ │ │
│  │   [content depends on tab]   │  │  │                        │ │ │
│  │                              │  │  └────────────────────────┘ │ │
│  │                              │  │                              │ │
│  │                              │  │  ┌── Timeline ────────────┐ │ │
│  │                              │  │  │                        │ │ │
│  │                              │  │  │  [tracks + clips area] │ │ │
│  │                              │  │  │                        │ │ │
│  │                              │  │  │                        │ │ │
│  │                              │  │  └────────────────────────┘ │ │
│  └──────────────────────────────┘  └──────────────────────────────┘ │
├──────────────────────────────────────────────────────────────────────┤
│  ┌─── Transport Bar ────────────────────────────────────────────────┤
│  │ ⏮ ▶ ⏹ ⏭ │ 00:04.231 │ Beat: 12.5 │ Bar: 4 │ BPM: [140] │    │
│  └──────────────────────────────────────────────────────────────────┘
└──────────────────────────────────────────────────────────────────────┘

PANELS:
1. Left Panel (250–400px, resizable):
   - Two tabs: "Project Media" and "Sample Selector"
   - Project Media: shows imported source files as thumbnails
   - Sample Selector: shows marked sample regions grouped by label
   
2. Center Area (flexible width):
   - Top: Video Preview (16:9 aspect ratio, resizable height)
   - Bottom: Timeline (takes remaining space)
   
3. Transport Bar (fixed height, 48px, bottom):
   - Transport controls (rewind, play, stop, forward)
   - Position display (time, beats, bars)
   - BPM input (editable number)

Create these components:
- ui/src/App.jsx              (root layout)
- ui/src/components/TitleBar.jsx
- ui/src/components/LeftPanel.jsx
- ui/src/components/ProjectMediaTab.jsx    (placeholder content)
- ui/src/components/SampleSelectorTab.jsx  (placeholder content)
- ui/src/components/VideoPreview.jsx       (from Phase 0, upgraded)
- ui/src/components/TimelineView.jsx       (placeholder — empty track area)
- ui/src/components/TransportBar.jsx       (from Phase 0, upgraded)
- ui/src/components/ResizablePanel.jsx     (draggable divider)
- ui/src/styles/theme.css                  (CSS variables)
- ui/src/styles/app.css                    (layout styles)

TITLE BAR:
- Custom frameless title bar (Electron: frame: false in BrowserWindow)
- Window controls (minimize, maximize, close) — use Electron's IPC:
  ipcRenderer.send('window:minimize'), etc.
- Menu items: File (New, Open, Save, Save As, Import Source, Exit),
  Edit (Undo, Redo), View (placeholder)
- Show project name in center

TRANSPORT BAR upgrades from Phase 0:
- BPM field is editable (click to type, Enter to confirm)
- Position shows both MM:SS.mmm and Beat/Bar
- Keyboard: SPACE = play/pause, Home = rewind to start

RESIZABLE PANELS:
- Left panel has a draggable right edge
- Video preview has a draggable bottom edge
- Store panel sizes in localStorage so they persist

══════════════════════════════════════════════════════
MANDATORY DEBUG LOGGING:
══════════════════════════════════════════════════════
- [UI] App mounted, engine initialized
- [UI] Panel resized: left={}px, videoPreview={}px
- [UI] Tab switched: {}
- [UI] Theme loaded: {} CSS variables
- [UI] Window control: {}

══════════════════════════════════════════════════════
SELF-VERIFICATION:
══════════════════════════════════════════════════════
Visual check — after running the app:
- [ ] Window opens with custom title bar (no native frame)
- [ ] Minimize/maximize/close buttons work
- [ ] Left panel shows two tab buttons (Project Media, Sample Selector)
- [ ] Left panel is resizable (drag right edge)
- [ ] Video preview area maintains 16:9 aspect ratio
- [ ] Timeline area shows placeholder "Timeline" text
- [ ] Transport bar shows play/stop buttons
- [ ] BPM field is editable
- [ ] SPACE key toggles play/pause
- [ ] Dark theme renders correctly (check all CSS variables applied)
- [ ] Font is Hanken Grotesk
- [ ] Panel sizes persist after restart (localStorage)
- [ ] Console has no React warnings or errors

DO NOT:
- Implement any timeline drawing (just placeholder)
- Implement sample picker functionality
- Add file dialogs yet
- Connect to the video frame pipeline yet (placeholder image is fine)

VERIFY: Electron app launches, all panels render, keyboard shortcuts work
```

---

## PROMPT 8 — Project Media Tab: Import + Source Pool

```
We are building the Project Media tab — where users import source video files 
and see their media library for the current project.

══════════════════════════════════════════════════════
DOCUMENTATION REFERENCES:
══════════════════════════════════════════════════════
- Electron dialog.showOpenDialog: https://www.electronjs.org/docs/latest/api/dialog
- Electron drag-and-drop: https://www.electronjs.org/docs/latest/tutorial/native-file-drag-drop
- React DnD: https://developer.mozilla.org/en-US/docs/Web/API/HTML_Drag_and_Drop_API

══════════════════════════════════════════════════════
FEATURES:
══════════════════════════════════════════════════════

The Project Media tab shows:
1. An "Import" button (+ icon) at the top
2. A drop zone ("Drop video files here")
3. A list of imported source videos as cards

IMPORT FLOW:
1. User clicks Import → native file dialog opens
   Filters: Video (*.mp4, *.avi, *.mov, *.mkv), Audio (*.wav, *.mp3, *.flac)
2. OR user drags files onto the panel
3. For each dropped/selected file:
   a. Call xleth.project.importSource(filePath)
   b. Show progress bar for proxy transcoding
   c. On complete: add source card to the list
4. Multiple files can be imported at once

SOURCE CARD shows:
- Video thumbnail (first frame, generated from proxy)
- File name
- Resolution + FPS badge
- Duration
- Proxy status (transcoding spinner → green checkmark)
- Right-click context menu: Remove, Re-transcode, Reveal in Explorer

Create/modify these components:
- ui/src/components/ProjectMediaTab.jsx    (main component)
- ui/src/components/SourceCard.jsx         (individual source display)
- ui/src/components/ImportDropZone.jsx     (drag-and-drop area)
- ui/src/components/ProgressBar.jsx        (reusable progress bar)
- ui/src/components/ContextMenu.jsx        (reusable right-click menu)

ADD TO main.js IPC handlers:
- 'dialog:importSource' → opens file dialog, returns selected paths
- 'project:importSource' → calls xleth.project.importSource()
- 'project:getSourceThumbnail' → returns first-frame RGBA for a source
  (decode frame 0, convert to RGBA, return as base64 data URL)

ADD TO bridge:
- xleth.video.getSourceThumbnail(sourceId) → Buffer (RGBA of first frame)
  The addon decodes frame 0 of the source, converts to RGBA, returns it.
  Used for thumbnails only — called once per source on import.

══════════════════════════════════════════════════════
MANDATORY DEBUG LOGGING:
══════════════════════════════════════════════════════
- [ProjectMedia] Import requested via {} (dialog/drop)
- [ProjectMedia] Importing: "{}" ({:.1f} MB)
- [ProjectMedia] Proxy transcoding: {} → {}%
- [ProjectMedia] Import complete: source #{} "{}" ({}x{}, {}fps, {}s)
- [ProjectMedia] Source removed: #{}
- [ProjectMedia] Thumbnail generated: source #{} ({}x{})
- [ProjectMedia] ERROR: Import failed: {} — {}
- [ProjectMedia] ERROR: Unsupported format: {}

══════════════════════════════════════════════════════
SELF-VERIFICATION:
══════════════════════════════════════════════════════
1. Launch app
2. Click Import → file dialog opens, select a .mp4 file
3. [ ] Progress bar appears showing proxy transcode progress
4. [ ] On complete, source card appears with thumbnail
5. [ ] Card shows correct filename, resolution, FPS, duration
6. [ ] Green checkmark indicates proxy is ready
7. Drag another video file onto the panel
8. [ ] Drop zone highlights on hover
9. [ ] Second source imports and appears in list
10. Right-click a source → context menu appears
11. [ ] "Remove" removes the source from the list
12. [ ] Console shows all debug logs for each step
13. Save project, reload → sources are still listed

DO NOT:
- Open the Sample Picker yet (that's the next prompt)
- Play video from the source card
- Create sample regions yet

VERIFY: Import via dialog and drag-and-drop both work. Sources persist after save/reload.
```

---

## PROMPT 9 — Sample Picker: Scrubbing + Region Marking

```
We are building the Sample Picker — Xleth's core workflow innovation. This is 
where users scrub through source video, mark in/out regions, and tag them with 
labels to create their sample vocabulary.

══════════════════════════════════════════════════════
CONTEXT — HOW SPARTA REMIXERS PICK SAMPLES:
══════════════════════════════════════════════════════
Read the Sparta Remix knowledge file carefully. The three sample types are:
1. Chorus samples — syllable-chopped dialogue for rhythmic patterns
2. Pitch samples — clean vocal moments to be tuned as melodic instruments
3. Percussion — SFX hits, comedic sounds, drum-like moments from source

The Sample Picker mimics Vegas Pro's loop region selection but with labels.
Users scrub through a source video watching + listening, then mark regions 
they want to use and tag them with what they'll be used for.

══════════════════════════════════════════════════════
DOCUMENTATION REFERENCES:
══════════════════════════════════════════════════════
- HTML5 Canvas for waveform: https://developer.mozilla.org/en-US/docs/Web/API/Canvas_API
- Web Audio API for audio scrubbing: https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API
- Vegas Pro loop region: The user marks I (in) and O (out) points on a 
  timeline. The blue highlighted region between them is the selected area.
  (See IMAGE 1 from the user's uploads — the blue bar at top of timeline)

══════════════════════════════════════════════════════
SAMPLE PICKER UI — opens as a TAB in the left panel or a dedicated panel:
══════════════════════════════════════════════════════

When user double-clicks a source in the Project Media tab, the Sample Picker 
activates for that source.

┌─── Sample Picker ──────────────────────────────────────────────┐
│                                                                │
│  Source: "BFDI 23 a.mp4"                   [← Back to Media]  │
│                                                                │
│  ┌─── Video Preview ────────────────────────────────────────┐  │
│  │                                                          │  │
│  │         (shows current scrub position)                   │  │
│  │                                                          │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                │
│  ┌─── Waveform + Scrubber ─────────────────────────────────┐  │
│  │  [|=====[███SELECTED████]=======|]                       │  │
│  │  ▲ in                     out ▲                          │  │
│  │  00:23.450                   00:24.120                   │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                │
│  ┌─── Controls ────────────────────────────────────────────┐  │
│  │  ▶ Play Selection  │  [I] Set In  │  [O] Set Out       │  │
│  │                                                          │  │
│  │  Label: [Kick ▼]  Name: [auto]   [✓ Add Sample]        │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                │
│  ┌─── Marked Samples (this source) ────────────────────────┐  │
│  │  🔴 Kick 1    │ 00:05.200 - 00:05.450 │ 0.250s │ [x]  │  │
│  │  🟡 HiHat 1   │ 00:12.100 - 00:12.280 │ 0.180s │ [x]  │  │
│  │  🟢 Pitch 1   │ 00:23.450 - 00:24.120 │ 0.670s │ [x]  │  │
│  │  🔵 Quote 1   │ 01:05.300 - 01:06.800 │ 1.500s │ [x]  │  │
│  └──────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────┘

WAVEFORM DISPLAY:
- Generate waveform overview from the source audio track
- ADD TO bridge: xleth.audio.getWaveformData(sourceId, width) → Float32Array
  Returns downsampled min/max peaks for the entire source at the requested 
  pixel width. Generated once on import, cached.
- Display as a standard waveform (vertical bars, positive/negative)
- Current playback position shown as a thin vertical line (playhead)
- User can click anywhere on the waveform to seek
- Mouse drag on waveform = scrub (audio + video follow)

REGION SELECTION (Vegas-style):
- User presses I or clicks [Set In] → marks the in-point
- User presses O or clicks [Set Out] → marks the out-point
- Selected region shown as highlighted area on waveform (like Vegas blue bar)
- In/out points are draggable handles
- Time display shows in-point time, out-point time, and duration

PLAYBACK:
- SPACE = play/pause the source from current position
- Play Selection button = loop-play just the selected region
- Audio comes from decoding the source video's audio track
- Video preview shows the frame at the current scrub/playback position

LABEL SELECTION:
- Dropdown with: Kick, Snare, HiHat, Crash, Pitch, Quote, + (Add Custom)
- Each label has its color (from CSS variables)
- "+ Add Custom" opens a small input field to type a label name
- Custom labels are saved globally (persist across projects)

ADD SAMPLE BUTTON:
- Takes the current in/out selection + label + name
- Creates a SampleRegion in the Timeline data model
- Appears in the "Marked Samples" list below
- Auto-names: "{Label} {N}" where N increments per label type
  (Kick 1, Kick 2, Pitch 1, Pitch 2, etc.)

MARKED SAMPLES LIST:
- Shows all SampleRegions from this source
- Color-coded by label
- Shows time range and duration
- Click to highlight the region on the waveform
- [x] button to delete
- Double-click a Quote sample → opens syllable splitter (FUTURE — Phase 2)

══════════════════════════════════════════════════════
ADD TO BRIDGE:
══════════════════════════════════════════════════════

xleth.audio.getWaveformData(sourceId, pixelWidth) → Float32Array
  Engine decodes audio from the source, downsamples to min/max peaks.

xleth.video.getFrameAtTime(sourceId, timeSeconds) → Buffer
  Decodes a single frame at the given time, returns RGBA buffer.
  Used for scrub preview.

xleth.audio.playSource(sourceId, startTime, endTime?) → void
  Plays audio from the source file. If endTime specified, loops that region.

xleth.audio.stopSource() → void
  Stops source playback.

xleth.audio.seekSource(sourceId, timeSeconds) → void
  Seeks the source playback position.

══════════════════════════════════════════════════════
MANDATORY DEBUG LOGGING:
══════════════════════════════════════════════════════
- [SamplePicker] Opened for source #{}: "{}"
- [SamplePicker] Waveform generated: {} peaks for {} pixels
- [SamplePicker] In point set: {:.3f}s
- [SamplePicker] Out point set: {:.3f}s
- [SamplePicker] Selection: {:.3f}s - {:.3f}s ({:.3f}s duration)
- [SamplePicker] Sample added: "{}" (label={}, {:.3f}s - {:.3f}s)
- [SamplePicker] Sample removed: "{}"
- [SamplePicker] Scrub to {:.3f}s (frame {})
- [SamplePicker] Play selection: {:.3f}s - {:.3f}s (loop={})
- [SamplePicker] Custom label added: "{}"
- [SamplePicker] ERROR: No selection — set In and Out points first

══════════════════════════════════════════════════════
SELF-VERIFICATION:
══════════════════════════════════════════════════════
1. Import a source video in Project Media
2. Double-click it to open Sample Picker
3. [ ] Waveform displays for the source
4. [ ] Click on waveform → playhead moves, video preview updates
5. [ ] Drag on waveform → audio + video scrub together
6. Press I at one position, O at another
7. [ ] Blue highlight appears between in/out points
8. [ ] In/out handles are draggable
9. [ ] Time display shows correct in/out times
10. Click "Play Selection"
11. [ ] Audio loops just the selected region
12. Select label "Kick", click Add Sample
13. [ ] "Kick 1" appears in marked samples list with correct color
14. Mark another region, label as "Pitch"
15. [ ] "Pitch 1" appears in list
16. Click a sample in the list
17. [ ] Waveform highlights that region
18. Add a custom label via "+"
19. [ ] Custom label appears in dropdown and persists

DO NOT:
- Implement syllable splitting (that's Phase 2A)
- Implement audio export/swap (that's Phase 2B)
- Implement pitch shifting
- Add the pencil tool
- Connect samples to the timeline yet

VERIFY: Full sample picking workflow from scrub to labeled region creation
```

---

## PROMPT 10 — Sample Selector Tab: Browse + Organize Samples

```
We are building the Sample Selector tab — the panel where all marked samples 
are displayed organized by label, and from which users drag or place samples 
onto the timeline.

This is the "palette" of samples the remixer works with after picking them.

══════════════════════════════════════════════════════
SAMPLE SELECTOR UI:
══════════════════════════════════════════════════════

┌─── Sample Selector ─────────────────────────────┐
│                                                  │
│  🔴 Kick (3)                               [▾]  │
│  ├── Kick 1  │ 0.250s │ BFDI 23          [▶]  │
│  ├── Kick 2  │ 0.180s │ BFDI 23          [▶]  │
│  └── Kick 3  │ 0.310s │ SpongeBob        [▶]  │
│                                                  │
│  🟠 Snare (2)                              [▾]  │
│  ├── Snare 1 │ 0.200s │ BFDI 23          [▶]  │
│  └── Snare 2 │ 0.220s │ SpongeBob        [▶]  │
│                                                  │
│  🟡 HiHat (1)                              [▾]  │
│  └── HiHat 1 │ 0.150s │ BFDI 23          [▶]  │
│                                                  │
│  🟢 Pitch (4)                              [▾]  │
│  ├── Pitch 1 │ 0.670s │ ♪ C4  │ BFDI 23 [▶]  │
│  ├── Pitch 2 │ 0.520s │ ♪ --  │ BFDI 23 [▶]  │
│  ├── Pitch 3 │ 0.890s │ ♪ D4  │ SpongeBob[▶] │
│  └── Pitch 4 │ 0.410s │ ♪ --  │ SpongeBob[▶] │
│                                                  │
│  🔵 Quote (2)                              [▾]  │
│  ├── Quote 1 │ 1.500s │ 4 syl │ BFDI 23 [▶]  │
│  └── Quote 2 │ 2.100s │ 0 syl │ SpongeBob[▶] │
│                                                  │
└──────────────────────────────────────────────────┘

FEATURES:
- Grouped by label, collapsible sections
- Each section shows count in header
- Each sample row shows: name, duration, source file, preview button
- Pitch samples also show root note (from smpl chunk) or "--" if unknown
- Quote samples show syllable count (0 if not yet marked)
- [▶] button plays the sample audio on click
- Click a sample to SELECT it (highlighted border). The selected sample 
  is what the pencil tool will draw on the timeline.
- Right-click context menu:
  - Edit in Sample Picker (jumps to that region in the picker)
  - Rename
  - Change Label
  - Export Audio (FUTURE — Phase 2B stub, show "Coming soon")
  - Swap Audio (FUTURE — Phase 2B stub)
  - Delete

DRAG FROM SELECTOR:
- User can drag a sample from this panel onto the timeline
- Drag preview shows a small colored rectangle with the sample name
- On drop: creates a Clip on the target track at the drop position

SELECT FOR PENCIL:
- Single-click a sample → it becomes the "active sample"
- Active sample shown with a bright border glow in its label color
- The pencil tool on the timeline uses the active sample
- Active sample indicator also appears in the transport bar or toolbar

MULTIPLE SOURCES:
- If user imported individual sample videos (one clip per file) instead 
  of picking from a big source, they can right-click the source in 
  Project Media and choose "Import as Sample Video"
- This creates a SampleRegion covering the entire video with a label 
  the user selects from a popup
- The sample appears in the Sample Selector automatically

ROOT NOTE DETECTION (for Pitch samples):
When a sample is first added or when swapped audio is loaded:
1. Check for WAV smpl chunk → read MIDI Unity Note field
2. If present: display as note name (C4, D#3, etc.)
3. If not present: display "--"
4. ADD TO bridge: xleth.audio.detectRootNote(filePath) → { note, confidence }
   Read the smpl chunk from the WAV. MIDI note 60 = C4.
   note = -1 if no smpl chunk found.

══════════════════════════════════════════════════════
MANDATORY DEBUG LOGGING:
══════════════════════════════════════════════════════
- [SampleSelector] Loaded {} samples across {} labels
- [SampleSelector] Selected: "{}" (region #{}, label={})
- [SampleSelector] Preview: "{}" playing
- [SampleSelector] Drag started: "{}"
- [SampleSelector] Root note detected: "{}" → {} ({})
- [SampleSelector] Label changed: "{}" {} → {}
- [SampleSelector] Sample renamed: "{}" → "{}"
- [SampleSelector] Import as Sample Video: source #{} → label={}

══════════════════════════════════════════════════════
SELF-VERIFICATION:
══════════════════════════════════════════════════════
1. Import a source video
2. Open Sample Picker, mark 3 samples with different labels
3. Switch to Sample Selector tab
4. [ ] All 3 samples appear, grouped by label
5. [ ] Correct colors per label
6. [ ] Click [▶] → sample audio plays
7. [ ] Click a sample → highlighted as active (border glow)
8. [ ] Sections are collapsible
9. [ ] Right-click shows context menu
10. [ ] Rename works
11. [ ] Change Label moves sample to correct group
12. [ ] Delete removes sample
13. [ ] Sample count in section headers updates correctly
14. Drag a sample toward the timeline area
15. [ ] Drag preview shows colored rectangle with name
    (Drop doesn't need to work yet — timeline isn't ready)

DO NOT:
- Implement timeline drop zone (next prompts)
- Implement audio export or swap
- Implement syllable splitter
- Implement pitch shifting

VERIFY: Sample Selector displays all picked samples, grouped by label, 
with preview, selection, drag, and context menu working
```

---

# ═══════════════════════════════════════════════════
# PHASE 1C — TIMELINE + PENCIL TOOL
# The editing surface where remixes take shape
# ═══════════════════════════════════════════════════

## PROMPT 11 — Timeline Canvas: Tracks + Grid + Playhead

```
We are building the timeline canvas — the main editing surface where tracks 
and clips are displayed. This prompt creates the visual structure: track 
headers, beat grid, playhead, and scrolling. No clips yet.

══════════════════════════════════════════════════════
DOCUMENTATION REFERENCES:
══════════════════════════════════════════════════════
- HTML Canvas 2D: https://developer.mozilla.org/en-US/docs/Web/API/CanvasRenderingContext2D
- Canvas performance: https://developer.mozilla.org/en-US/docs/Web/API/Canvas_API/Tutorial/Optimizing_canvas
  KEY: Only redraw dirty regions. Use offscreen canvas for static elements.
- requestAnimationFrame: https://developer.mozilla.org/en-US/docs/Web/API/window/requestAnimationFrame
- FL Studio piano roll reference: The grid shows beats as vertical lines, 
  with stronger lines on beat 1 of each bar. Zoom changes how many beats 
  are visible. The playhead is a thin vertical line that moves during playback.

══════════════════════════════════════════════════════
TIMELINE LAYOUT:
══════════════════════════════════════════════════════

┌─── Track Headers ──┬─── Canvas Area ──────────────────────────┐
│                    │  1       2       3       4       │ bar #  │
│  [🔴 Kick    MS]  │  |   .   |   .   |   .   |   .  │        │
│  [🟢 Pitch 1 MS]  │  |   .   |   .   |   .   |   .  │        │
│  [🔵 Chorus  MS]  │  |   .   |   .   |   .   |   .  │        │
│  [🟠 Snare   MS]  │  |   .   |   .   |   .   |   .  │        │
│  [🟡 HiHat   MS]  │  |   .   |   .   |   .   |   .  │        │
│                    │          ▼ (playhead)             │        │
│  [+ Add Track]     │                                   │        │
└────────────────────┴───────────────────────────────────┘
                     │◄─────── scroll ──────────►│
                     zoom: Ctrl+Scroll

TRACK HEADERS (fixed left column, 180px):
- Track name (editable on double-click)
- Track color (from its primary sample label)
- M button (mute, toggles, dims when muted)
- S button (solo, toggles, glows when soloed)
- Click header to select track
- Drag header to reorder tracks
- Right-click: Rename, Delete, Change Color

CANVAS AREA (scrollable, zoomable):
- Horizontal axis = time (beats)
- Vertical axis = tracks (one row per track)
- Grid lines:
  - Major lines (solid, brighter) on beat 1 of each bar
  - Minor lines (dotted, dimmer) on each beat
  - Sub-lines (very faint) on each 16th note (visible at high zoom)
- Bar numbers displayed at top
- Beat numbers displayed at top (at higher zoom)

PLAYHEAD:
- Thin vertical line (accent color #33CED6) spanning all tracks
- Moves in real-time during playback
- Position synced to transport via polling (30fps)
- Click on the ruler (top area) to seek
- During playback, canvas auto-scrolls to keep playhead visible

SCROLLING + ZOOMING:
- Horizontal scroll: scroll wheel or scroll bar
- Vertical scroll: if tracks exceed visible area
- Zoom: Ctrl + scroll wheel (horizontal zoom only)
- Zoom levels: from "4 bars visible" to "1 beat fills the screen"
- Current zoom stored as pixels-per-beat

IMPLEMENTATION:
- Use <canvas> for the grid and clips (performance)
- Use React components for track headers (interactivity)
- Separate canvas layers:
  1. Background canvas (grid lines — only redraws on zoom/scroll)
  2. Content canvas (clips — redraws on edit)
  3. Overlay canvas (playhead, selection — redraws at 30fps)
- Coordinate system: 
  beatToPixel(beat) = (beat - scrollOffset) * pixelsPerBeat
  pixelToBeat(px) = (px / pixelsPerBeat) + scrollOffset

Create these components:
- ui/src/components/timeline/TimelineView.jsx     (container)
- ui/src/components/timeline/TrackHeader.jsx       (single track header)
- ui/src/components/timeline/TrackHeaderList.jsx   (all headers + add button)
- ui/src/components/timeline/TimelineCanvas.jsx    (the canvas area)
- ui/src/components/timeline/TimelineRuler.jsx     (bar/beat numbers at top)
- ui/src/components/timeline/Playhead.jsx          (playhead line)
- ui/src/hooks/useTimelineZoom.js                  (zoom state + handlers)
- ui/src/hooks/useTimelineScroll.js                (scroll state + handlers)

══════════════════════════════════════════════════════
MANDATORY DEBUG LOGGING:
══════════════════════════════════════════════════════
- [Timeline] Canvas initialized: {}x{} pixels
- [Timeline] Zoom: {} px/beat (showing {:.1f} bars)
- [Timeline] Scroll: beat offset={:.2f}
- [Timeline] Track added: "{}" (order={})
- [Timeline] Track reordered: #{} → order {}
- [Timeline] Playhead position: beat {:.2f} (pixel {})
- [Timeline] Seek via ruler click: beat {:.2f}
- [Timeline] Canvas redraw: grid={}, content={}, overlay={} 
  (log which layers were redrawn and why)
- [Timeline] WARNING: Canvas redraw > 16ms ({:.2f}ms)

══════════════════════════════════════════════════════
SELF-VERIFICATION:
══════════════════════════════════════════════════════
1. Launch app, create a project
2. Add 3 tracks
3. [ ] Track headers appear with names, M/S buttons
4. [ ] Grid renders with beat and bar lines
5. [ ] Bar numbers visible at top
6. Scroll horizontally
7. [ ] Grid scrolls smoothly
8. Ctrl + scroll to zoom
9. [ ] Grid zoom changes (more/fewer beats visible)
10. [ ] At high zoom, 16th note grid lines become visible
11. Press Play
12. [ ] Playhead moves across canvas in sync with transport
13. [ ] Canvas auto-scrolls to follow playhead
14. Click on ruler
15. [ ] Transport seeks to clicked position
16. Double-click track name
17. [ ] Name becomes editable
18. Click M button
19. [ ] Track header dims (muted state)
20. Drag a track header up/down
21. [ ] Track reorders visually

DO NOT:
- Draw any clips on the canvas (next prompt)
- Implement the pencil tool
- Implement clip selection/editing
- Add any audio waveform rendering to clips

VERIFY: Timeline renders with grid, tracks, playhead, scrolling, and zooming
```

---

## PROMPT 12 — Clip Rendering + Drop from Sample Selector

```
We are adding clip visualization on the timeline and the ability to drop 
samples from the Sample Selector onto tracks.

══════════════════════════════════════════════════════
CLIP RENDERING ON CANVAS:
══════════════════════════════════════════════════════

Each clip is a colored rectangle on its track row:
- Width = clip duration in pixels (using beatToPixel conversion)
- Height = track row height minus 4px padding
- Color = label color (from CSS variables) at 60% opacity
- Border = label color at 100% opacity, 1px
- Text inside: sample name (truncated if too small)
- If zoomed in enough: show duration text

Selected clips have:
- Brighter fill (80% opacity)
- Thicker border (2px)
- Resize handles visible at left and right edges (4px wide bars)

CLIP INTERACTION:
- Click a clip → select it (deselect others unless Shift held)
- Ctrl+Click → toggle selection (multi-select)
- Selected clips can be deleted with Delete key
- Click empty space → deselect all

DROP FROM SAMPLE SELECTOR:
1. User drags a sample from the Sample Selector panel
2. As they drag over the timeline, show a preview rectangle:
   - Colored by label
   - Snapped to the nearest grid position (beat or 16th, depending on zoom)
   - On the track row the mouse is hovering over
3. On drop:
   - Create a Clip via the bridge (goes through UndoManager)
   - Clip duration = sample region duration converted to ticks at current BPM
   - Clip snaps to grid
4. If dropped on empty area (no track) → do nothing, show no-drop cursor

GRID SNAPPING:
- Default snap: 16th note (TickTime::from16th(1) = 240 ticks)
- Holding Alt while dragging → snap to 32nd note (120 ticks)
- Holding Shift while dragging → free positioning (no snap)
- Snap resolution indicator in toolbar (future — hardcode 16th for now)

══════════════════════════════════════════════════════
MANDATORY DEBUG LOGGING:
══════════════════════════════════════════════════════
- [TimelineClips] Rendering {} clips ({} visible in viewport)
- [TimelineClips] Clip #{} rendered at beat {:.2f}, duration {:.2f} beats, track #{}
- [TimelineClips] Clip selected: #{} "{}"
- [TimelineClips] Clip deselected: #{}
- [TimelineClips] Drop preview: track #{}, beat {:.2f} (snapped from {:.2f})
- [TimelineClips] Clip created via drop: #{} region="{}" track=#{} pos=beat {:.2f}
- [TimelineClips] Clip deleted: #{}
- [TimelineClips] Snap: {} ticks (16th note)
- [TimelineClips] WARNING: Drop on invalid area (no track)

══════════════════════════════════════════════════════
SELF-VERIFICATION:
══════════════════════════════════════════════════════
1. Import source, pick 3 samples (Kick, Snare, Pitch)
2. Add 3 tracks to timeline
3. Drag "Kick 1" from Sample Selector onto the Kick track
4. [ ] Preview rectangle appears while dragging, snaps to grid
5. [ ] On drop, clip appears on track with correct color and label
6. Drag "Pitch 1" onto Pitch track at a different beat
7. [ ] Second clip appears
8. Click the Kick clip
9. [ ] Clip highlights (selected state)
10. [ ] Resize handles appear at edges
11. Press Delete
12. [ ] Clip removed from timeline
13. Press Ctrl+Z
14. [ ] Clip restored (undo works)
15. Press Play
16. [ ] Audio plays at correct beat positions
17. [ ] Clips that overlap the playhead position trigger audio

DO NOT:
- Implement the pencil tool (next prompt)
- Implement clip moving/resizing by drag
- Implement audio waveform inside clips
- Implement video preview integration

VERIFY: Clips render on timeline, drop from selector works, 
selection and deletion work, undo/redo works, audio plays from timeline
```

---

## PROMPT 13 — Pencil Tool: Draw Clips Like FL Piano Roll

```
We are implementing the pencil tool — the primary method for placing samples 
on the timeline in Xleth. This mimics FL Studio's piano roll behavior where 
clicking draws a note, and the note length matches the last edited note.

══════════════════════════════════════════════════════
CONTEXT — FL STUDIO BEHAVIOR WE'RE COPYING:
══════════════════════════════════════════════════════
In FL's piano roll:
1. Select the pencil tool (or just right-click to draw)
2. Click on the grid → a note appears at that position
3. The note's length = the length of the last note you edited
4. To change length: drag the right edge of any note
5. The NEXT note you draw will have that new length
6. This "sticky note length" persists until you edit another note

We're adapting this:
- The "note" is a Clip (a sample placement)
- The "pitch" is which sample is active in the Sample Selector
- The "length" is the clip duration
- Drawing = click on empty timeline space with pencil active

══════════════════════════════════════════════════════
TOOLBAR — Add a tool selector:
══════════════════════════════════════════════════════

Add a toolbar above the timeline (or integrated into it):

┌─── Toolbar ─────────────────────────────────────────┐
│  [↖ Select] [✏ Pencil] [✂ Split] [🗑 Delete]      │
│  Active Sample: [🟢 Pitch 1 ▾]  │  Snap: [1/16 ▾]  │
└─────────────────────────────────────────────────────┘

Tools:
- Select (S key): Click to select clips, drag to move them
- Pencil (P key): Click to draw clips, right-click to delete
- Split (C key): Click on a clip to split it at that position
- Delete (D key): Click on a clip to delete it

Active Sample Indicator:
- Shows the currently selected sample from the Sample Selector
- Dropdown to quickly switch (mirrors Sample Selector selection)
- Colored by label

Snap dropdown:
- 1/4 (beat), 1/8, 1/16 (default), 1/32, None
- Changes grid snap resolution for all operations

══════════════════════════════════════════════════════
PENCIL TOOL BEHAVIOR:
══════════════════════════════════════════════════════

When Pencil tool is active:
1. Cursor changes to crosshair
2. Moving mouse over timeline shows a GHOST PREVIEW:
   - Faded rectangle at the current snap position
   - Color matches active sample's label
   - Width = current sticky note length
   - Follows mouse position (snapped to grid)
3. LEFT CLICK on empty space:
   - Creates a Clip at the snapped position
   - Uses the active sample from Sample Selector
   - Duration = stickyNoteLength (persisted)
   - Goes through UndoManager
4. LEFT CLICK on existing clip:
   - Selects the clip
   - Updates stickyNoteLength to that clip's duration
5. RIGHT CLICK on existing clip:
   - Deletes the clip (through UndoManager)
6. RIGHT CLICK on empty space:
   - Does nothing

STICKY NOTE LENGTH BEHAVIOR:
- Default: 1/16 note (240 ticks)
- When ANY clip is resized (by dragging its edge), stickyNoteLength 
  updates to the new duration
- When ANY clip is clicked/selected in pencil mode, stickyNoteLength 
  updates to that clip's duration
- stickyNoteLength displayed in toolbar: "Length: 1/16" or "Length: 0.25 beats"
- This value persists across tool switches and sample changes

══════════════════════════════════════════════════════
SELECT TOOL BEHAVIOR:
══════════════════════════════════════════════════════

When Select tool is active:
1. LEFT CLICK on clip → select it
2. Shift+Click → add to selection
3. Click empty → deselect all
4. DRAG on empty → rubber-band selection box
5. DRAG on selected clip → move it:
   - Horizontal: snap to grid
   - Vertical: snap to tracks (move between tracks)
   - Show ghost preview while dragging
   - On release: execute MoveClipCommand
6. DRAG on clip's right edge → resize:
   - Horizontal resize, snapped to grid
   - Minimum size: 1/32 note
   - On release: execute ResizeClipCommand
   - Updates stickyNoteLength

SPLIT TOOL BEHAVIOR:
When Split tool is active:
1. Cursor shows scissors icon
2. Vertical line follows mouse position (snapped to grid)
3. Click on a clip → split it into two clips at that position
   - Creates two new clips with same sample but split durations
   - Done as a compound undo (remove original + add two new)

DELETE TOOL BEHAVIOR:
When Delete tool is active:
1. Cursor shows X icon
2. Click on a clip → delete it (through UndoManager)
3. Drag across clips → delete all touched clips

══════════════════════════════════════════════════════
KEYBOARD SHORTCUTS:
══════════════════════════════════════════════════════
S → Select tool
P → Pencil tool
C → Split tool
D → Delete tool
Delete → Delete selected clips
Ctrl+A → Select all clips
Ctrl+Z → Undo
Ctrl+Y / Ctrl+Shift+Z → Redo
Ctrl+S → Save project

══════════════════════════════════════════════════════
MANDATORY DEBUG LOGGING:
══════════════════════════════════════════════════════
- [PencilTool] Tool switched: {} (shortcut: {})
- [PencilTool] Active sample: "{}" (region #{})
- [PencilTool] Ghost preview at beat {:.2f}, track #{}
- [PencilTool] Draw clip: region=#{} track=#{} beat={:.2f} dur={} ticks
- [PencilTool] Sticky length updated: {} ticks ({:.2f} beats) — reason: {}
- [SelectTool] Clip #{} selected
- [SelectTool] Move clip #{}: beat {:.2f} → {:.2f}, track #{} → #{}
- [SelectTool] Resize clip #{}: {} → {} ticks
- [SplitTool] Split clip #{} at beat {:.2f} → clips #{} + #{}
- [DeleteTool] Delete clip #{} at beat {:.2f}
- [Toolbar] Snap changed: {} ticks
- [Keyboard] Shortcut: {} → {}

══════════════════════════════════════════════════════
SELF-VERIFICATION:
══════════════════════════════════════════════════════
1. Import source, pick Kick, Snare, Pitch samples
2. Add 3 tracks, select Kick in Sample Selector
3. Press P for pencil tool
4. [ ] Cursor changes to crosshair
5. [ ] Ghost preview follows mouse on timeline, snapped to 16th note grid
6. Click on Kick track at beat 1
7. [ ] Kick clip appears at beat 1 with default length (1/16)
8. Click at beats 2, 3, 4
9. [ ] 3 more clips appear, all same length
10. Switch to Select tool (S), drag the right edge of one clip to make it longer
11. [ ] Clip resizes
12. Switch back to Pencil (P), draw a new clip
13. [ ] New clip has the SAME length as the clip you just resized (sticky length)
14. Switch active sample to Pitch, draw on Pitch track
15. [ ] Pitch clip appears in Pitch color, same sticky length
16. Press C for split tool, click in the middle of a clip
17. [ ] Clip splits into two shorter clips
18. Press D for delete tool, click on a clip
19. [ ] Clip deleted
20. Ctrl+Z repeatedly
21. [ ] All operations undo correctly in reverse order
22. Ctrl+Y repeatedly
23. [ ] All operations redo correctly
24. Press Play
25. [ ] All placed clips trigger audio at correct positions

DO NOT:
- Implement video preview integration with timeline (next prompt)
- Implement clip copy/paste
- Implement pattern blocks / FL-style playlist
- Implement automation lanes

VERIFY: Pencil tool draws clips with sticky length, select tool moves/resizes,
split tool works, delete tool works, all undoable, audio plays back correctly
```

---

## PROMPT 14 — Video Preview: Timeline-Driven Compositing

```
We are connecting the video preview to the timeline. When clips play back, 
the video preview shows the correct video frames for each active clip, 
composited together based on track order.

This is where Xleth becomes a visual tool, not just an audio sequencer.

══════════════════════════════════════════════════════
ARCHITECTURE:
══════════════════════════════════════════════════════

The engine's SyncManager (from Phase 0, upgraded) now reads from the 
Timeline data model instead of hardcoded events:

1. Transport advances (audio thread)
2. Video thread polls transport position
3. Reads Timeline to find active clips at current beat
4. For each active clip:
   a. Get its SampleRegion → get source video + time range
   b. Calculate which source frame to show based on playback progress
   c. Fetch from FrameCache (or decode on miss)
   d. Get the clip's track → get video layout properties
5. Composite all active frames via CPU (YUV→RGBA)
6. Write to FrameOutput (SharedArrayBuffer)
7. Electron renderer displays it

TRACK VIDEO LAYOUT:
Each track has video position/size properties (set in Phase 2 with the 
grid layout system). For Phase 1, use a simple auto-layout:
- If 1 active clip: full screen
- If 2: side by side (50% each)
- If 3: top half / bottom-left / bottom-right
- If 4+: grid (2xN)
This is temporary — the proper Sparta grid layout comes in a later phase.

SCRUB PREVIEW:
When the user is NOT playing but clicks/scrubs on the timeline:
- Show the video frame at the cursor position for any clips under the cursor
- This must be responsive (< 50ms to show a frame)
- Use the frame cache — scrubbing the same region repeatedly should be instant

UPDATE SyncManager:
- SyncManager now takes a Timeline reference instead of a vector of VideoEvents
- On each videoTick(), it reads active clips from Timeline::getClipsInRange()
- For each clip, it resolves the SampleRegion and computes the source frame

UPDATE FrameOutput:
- Support multi-layer composition on CPU:
  - For each active clip, get its RGBA frame
  - Composite them in track Z-order (simple alpha blend)
  - Write final composite to the shared buffer

══════════════════════════════════════════════════════
MANDATORY DEBUG LOGGING:
══════════════════════════════════════════════════════
- [VideoSync] Tick at beat {:.2f}: {} active clips
- [VideoSync] Clip #{} → source #{} frame {} (cache {})
- [VideoSync] Composite: {} layers, {:.2f}ms
- [VideoSync] Scrub preview at beat {:.2f}: {} clips visible
- [VideoSync] Frame cache hit rate: {:.1f}% ({} hits / {} total)
  (Log once per second)
- [VideoSync] WARNING: Frame decode > 16ms ({:.2f}ms) — dropped
- [VideoSync] WARNING: Composite > 16ms ({:.2f}ms)

══════════════════════════════════════════════════════
SELF-VERIFICATION:
══════════════════════════════════════════════════════
1. Import a source video, pick samples, place clips on timeline
2. Press Play
3. [ ] Video preview shows frames changing in sync with audio
4. [ ] When a clip starts, its video appears in the preview
5. [ ] When a clip ends, its video disappears
6. [ ] Multiple simultaneous clips show as a grid composite
7. Stop playback, click on different timeline positions
8. [ ] Video preview updates to show frames at clicked position (scrub)
9. [ ] Scrub response < 100ms (visually instant)
10. [ ] Frame cache hit rate > 80% during playback (check console)
11. [ ] No audio glitches during video-heavy playback

DO NOT:
- Implement the Sparta grid layout system (future phase)
- Add video transitions or effects
- Add video export

VERIFY: Video preview shows correct frames during playback and scrubbing,
composited when multiple clips are active, in sync with audio
```

---

## PROMPT 15 — Integration Test + Polish

```
This is the final prompt of Phase 1. We're doing integration testing, 
fixing edge cases, and ensuring the complete workflow works end-to-end.

══════════════════════════════════════════════════════
END-TO-END WORKFLOW TEST:
══════════════════════════════════════════════════════

Perform this complete workflow and verify each step:

1. LAUNCH
   [ ] Xleth opens to empty state
   [ ] No console errors

2. CREATE PROJECT
   [ ] File → New Project → choose directory + name
   [ ] Project directory created with proxies/, exports/, swapped/

3. SET BPM
   [ ] Click BPM field in transport bar, type 140, press Enter
   [ ] BPM updates across all systems

4. IMPORT SOURCE VIDEO
   [ ] File → Import Source (or drag onto Project Media)
   [ ] Progress bar shows proxy transcoding
   [ ] Source appears in Project Media with thumbnail

5. PICK SAMPLES
   [ ] Double-click source → Sample Picker opens
   [ ] Scrub through video — waveform + video preview update
   [ ] Mark a Kick region (I + O + label + Add)
   [ ] Mark a Snare region
   [ ] Mark a Pitch region
   [ ] Mark a Quote region
   [ ] All appear in Marked Samples list

6. BROWSE SAMPLES
   [ ] Switch to Sample Selector tab
   [ ] All 4 samples grouped by label
   [ ] Preview buttons play audio
   [ ] Click Kick 1 → highlighted as active

7. ADD TRACKS
   [ ] Click "Add Track" 4 times → Kick, Snare, Pitch, Chorus tracks
   [ ] Tracks appear in timeline with headers

8. PLACE CLIPS — PENCIL TOOL
   [ ] Press P for pencil
   [ ] Click on Kick track at beats 1, 2, 3, 4 → four kick clips
   [ ] Switch active sample to Snare, draw on Snare track at beats 2, 4
   [ ] Switch to Pitch, draw a longer note on Pitch track
   [ ] Sticky note length works correctly

9. PLACE CLIPS — DRAG AND DROP
   [ ] Drag a sample from Sample Selector onto timeline
   [ ] Clip appears at drop position

10. EDIT CLIPS
    [ ] Select tool: click clip → selected
    [ ] Move clip by dragging → snaps to grid
    [ ] Resize clip by dragging edge → snaps to grid
    [ ] Split clip with split tool
    [ ] Delete clip with delete key
    [ ] All operations undoable with Ctrl+Z

11. PLAYBACK
    [ ] Press Space → audio plays
    [ ] Kicks fire on beats 1,2,3,4
    [ ] Snares fire on beats 2, 4
    [ ] Pitch plays at placed position
    [ ] Video preview shows correct frames
    [ ] Playhead moves across timeline
    [ ] Timeline auto-scrolls during playback

12. SAVE + RELOAD
    [ ] Ctrl+S → project saved
    [ ] Close Xleth
    [ ] Reopen Xleth → File → Open → select project
    [ ] ALL data restored: tracks, clips, samples, regions
    [ ] Play → same result as before save

13. EDGE CASES
    [ ] Undo past project start → nothing happens (no crash)
    [ ] Place clip at very end of timeline → works
    [ ] Zoom all the way in → 16th note grid visible
    [ ] Zoom all the way out → many bars visible
    [ ] Rapid pencil clicking → clips created without lag
    [ ] 50+ clips on screen → canvas still renders at 30fps+

══════════════════════════════════════════════════════
FIX LIST:
══════════════════════════════════════════════════════
After running the workflow, fix any issues found:
- List each bug with steps to reproduce
- Fix each one, verify the fix
- Run the full workflow again to check for regressions

══════════════════════════════════════════════════════
PERFORMANCE BENCHMARKS:
══════════════════════════════════════════════════════
Log these metrics and verify:
- [ ] App startup time < 3 seconds
- [ ] Project load time < 2 seconds (for a project with 5 sources, 20 regions, 50 clips)
- [ ] Timeline canvas frame rate ≥ 30fps with 100 visible clips
- [ ] Audio playback: zero glitches over 2 minutes of continuous playback
- [ ] Video preview: ≥ 24fps during playback
- [ ] A/V sync drift < 20ms average
- [ ] Memory usage < 1GB (excluding video cache)
- [ ] Save time < 1 second

══════════════════════════════════════════════════════
DO NOT:
- Add new features
- Restructure the architecture
- This prompt is ONLY for testing, fixing, and polishing

VERIFY: Complete end-to-end workflow passes all checkboxes.

═══════════════════════════════════════════════════════
IF ALL CHECKS PASS → PHASE 1 IS COMPLETE.
You can import sources, pick samples, label them, place them on a timeline 
with the pencil tool, hear them play back with synced video, save your 
project, and reopen it. That's a working Sparta Remix workstation.
═══════════════════════════════════════════════════════
```

---

## Post-Phase 1 Notes

Phase 1 delivers a functional tool. Phase 2 adds the power features:

**Phase 2A — Quote Syllable Splitter**
The secondary window for subdividing quotes. Number-key selection. 
Syllable-level placement on timeline.

**Phase 2B — Audio Export + Swap**
Right-click export, naming conventions (Pitch 1.wav, Kick 2.wav), 
swap audio with processed files, root note detection from smpl chunk.

**Phase 2C — Sparta Video Grid Layout**
The proper grid system: assign tracks to screen positions, snap to edges, 
chorus full-screen behind, crash as overlay. Per your existing grid spec.

**Phase 3 — Stock Effects**
Parametric EQ, compressor, limiter, reverb, delay, flanger (UniFlange port).

**Phase 4 — Export + Ship**
Audio export (WAV/MP3), video export (MP4 via FFmpeg), installer, alpha release.
