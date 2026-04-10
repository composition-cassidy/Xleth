# MIDI Buffer Flow Diagnostic — XLETH Engine

**Purpose:** Understand where `juce::MidiBuffer` exists and where it is absent in the
effect-chain pipeline, so the Transient Processor can receive note-on events and
clip-start boundaries for sample-accurate transient detection.

---

## 1. Full Call Chain — MidiBuffer Presence / Absence

```
MixEngine::processBlock(AudioBuffer<float>& out, int numSamples, const Transport&)
│   ← NO MidiBuffer parameter at all
│
├── triggerPatternNotes(apb, bufStart, bufEnd, bpm, sampleRate)
│       ← Note events collected into a stack NoteEvent[512] array
│       ← Dispatched DIRECTLY to Sampler::noteOn / noteOff
│       ← No MidiBuffer is created or populated here
│
├── chainIt->second->processBlock(trackBuffer, numSamples)         [per-track]
│   EffectChainManager::processBlock(AudioBuffer<float>&, int)
│       ← NO MidiBuffer parameter
│       │
│       └── graph_->processBlock(buffer, numSamples)
│           AudioGraph::processBlock(AudioBuffer<float>&, int)
│               ← NO MidiBuffer parameter
│               │
│               └── graph_->processBlock(view, emptyMidi_)         ← JUCE APG call
│                   juce::AudioProcessorGraph::processBlock(AudioBuffer<float>&, MidiBuffer&)
│                       ← emptyMidi_ is a private member of AudioGraph
│                       ← Always empty — declared: `juce::MidiBuffer emptyMidi_` (AudioGraph.h:206)
│                       │
│                       └── XlethEffectBase::processBlock(AudioBuffer<float>&, MidiBuffer& /*midi*/)
│                               ← MidiBuffer ARRIVES HERE from JUCE graph machinery
│                               ← Parameter is named /*midi*/ — intentionally ignored
│                               │
│                               └── processEffect(buffer)          ← subclass override
│                                       ← Audio-only; NO MidiBuffer forwarded
│
└── masterEffectChain_->processBlock(outputBuffer, numSamples)     [master bus]
    ← Same chain as above; same emptyMidi_ problem
```

**Summary of the gap:**

| Layer | Has MidiBuffer? | Notes |
|---|---|---|
| `MixEngine::processBlock` | No | Top-level entry point; no MIDI parameter |
| `triggerPatternNotes` | No (internal struct) | Collects `NoteEvent[]` but never builds a `MidiBuffer` |
| `EffectChainManager::processBlock` | No | Audio-only signature |
| `AudioGraph::processBlock` | No | Audio-only signature; holds `emptyMidi_` private |
| `juce::AudioProcessorGraph::processBlock` | Yes | Standard JUCE call, receives `emptyMidi_` |
| `XlethEffectBase::processBlock` | Yes (ignored) | `/*midi*/` parameter — discarded |
| `processEffect(buffer)` | No | Subclass API is audio-only |

---

## 2. Data Structures

### 2a. PatternNote — `engine/src/model/TimelineTypes.h` (lines ~277-283)

```cpp
struct PatternNote {
    int      id       = 0;
    TickTime position;          // tick offset within the pattern (0 = pattern start)
    TickTime duration;          // sustain length in ticks
    int      pitch    = 60;     // MIDI note number (0-127; 60 = C4)
    float    velocity = 1.0f;   // amplitude 0..1  (maps to noteOn strength)
};
```

`TickTime` is `int64_t` ticks at **960 PPQ**. Convert to samples:
```cpp
int64_t toSamples(double bpm, double sampleRate) const {
    return static_cast<int64_t>((ticks / 960.0) * (60.0 / bpm) * sampleRate);
}
```

### 2b. Pattern — same file (lines ~288-295)

```cpp
struct Pattern {
    int         id        = 0;
    std::string name;
    int         regionId  = -1;              // SampleRegion used by all blocks that reference this pattern
    TickTime    length;                      // loop unit (ticks)
    std::vector<PatternNote> notes;
    int         nextNoteId = 1;
};
```

### 2c. PatternBlock — same file (lines ~300-308)

```cpp
struct PatternBlock {
    int      id        = 0;
    int      trackId   = 0;
    int      patternId = 0;
    TickTime position;           // absolute timeline start (ticks)
    TickTime duration;           // block length on timeline (ticks)
    TickTime offset;             // left-edge trim (ticks skipped at block start)
    bool     loopEnabled = false;
};
```

### 2d. Clip — `engine/src/model/TimelineTypes.h` (lines ~233-245)

```cpp
struct Clip {
    int      id             = 0;
    int      trackId        = 0;
    int      regionId       = 0;
    TickTime position;                      // absolute timeline start (ticks)
    TickTime duration;                      // clip length (ticks)
    TickTime regionOffset;                  // skip into the audio region (ticks)
    int      syllableIndex  = -1;           // -1 = whole region; >=0 = syllable
    float    velocity       = 1.0f;         // gain multiplier 0..1+
    int      pitchOffset    = 0;            // semitone transposition
};
```

No dedicated "per-clip velocity as MIDI" — `velocity` is a float gain multiplier.
For MidiBuffer injection, map `velocity` → MIDI byte: `juce::uint8(clip->velocity * 127.0f)`.

### 2e. ActiveClip — `engine/src/audio/MixEngine.h` (lines ~321-328)

```cpp
struct ActiveClip {
    const Clip* clip;
    int         sampleBankId;
    int64_t     clipStartSample;      // absolute sample where clip audio starts
    int64_t     clipEndSample;        // absolute sample where clip audio ends
    int64_t     regionOffsetSamples;  // read-head offset into SampleBank data
};
```

`clipStartSample` and `clipEndSample` are already computed in samples — no conversion
needed when building a MidiBuffer for clip-start events.

### 2f. ActivePatternBlock — `engine/src/audio/MixEngine.h` (lines ~373-380)

```cpp
struct ActivePatternBlock {
    const PatternBlock* block;
    const Pattern*      pattern;
    Sampler*            sampler;
    int64_t             blockStartSample;
    int64_t             blockEndSample;
};
```

---

## 3. How Note Timing Maps to Sample Offsets Within a Buffer Window

`triggerPatternNotes` (MixEngine.cpp lines ~876-973) computes everything in ticks, then
converts back. For building a MidiBuffer we need the **sample offset within the buffer**
(0 … numSamples-1), not the absolute tick or absolute sample.

### Current tick → absolute sample conversion

```cpp
auto sampleToTick = [&](int64_t sample) -> int64_t {
    const double seconds = static_cast<double>(sample) / sampleRate;
    return static_cast<int64_t>(seconds * (bpm / 60.0) * 960.0);
};
```

Inverse (tick → absolute sample):
```cpp
auto tickToAbsSample = [&](int64_t tick) -> int64_t {
    const double seconds = (tick / 960.0) * (60.0 / bpm);
    return static_cast<int64_t>(seconds * sampleRate);
};
```

### Absolute sample → buffer-relative offset

```cpp
// absNoteOnSample  = tickToAbsSample(absNoteOn)
// bufferStart      = first absolute sample of this processBlock call

int bufOffset = static_cast<int>(absNoteOnSample - bufferStart);
// bufOffset is in [0, numSamples) for events that fire in this block
```

### Full note-on mapping example

Given one `PatternNote`:
```
note.position.ticks = 480          // beat 1 subdivision
note.pitch          = 60
note.velocity       = 0.8f         // → MIDI byte 102
loopIdx             = 0
blockPosTicks       = 1920
blockOffsetTicks    = 0
```

```
absNoteOn (ticks) = 1920 - 0 + 0*960 + 480 = 2400
absNoteOnSample   = tickToAbsSample(2400)
                  = (2400/960) * (60/120) * 44100
                  = 2.5 * 0.5 * 44100
                  = 55125

bufOffset         = 55125 - bufferStart
                  → if bufferStart=55000, bufOffset=125 (within a 512-sample block)

MidiBuffer entry  = { sampleOffset=125, noteOnMessage(60, 102) }
```

---

## 4. Exact Signatures That Need to Change

To thread a populated `MidiBuffer` from `MixEngine` down to `processEffect()`, the
following three signatures must change (everything else in JUCE machinery already handles
`MidiBuffer` correctly):

### 4a. `EffectChainManager::processBlock` — `engine/src/audio/EffectChainManager.h:97`

**Current:**
```cpp
void processBlock(juce::AudioBuffer<float>& buffer, int numSamples);
```

**Must become:**
```cpp
void processBlock(juce::AudioBuffer<float>& buffer, int numSamples,
                  juce::MidiBuffer& midi);
```

### 4b. `AudioGraph::processBlock` — `engine/src/audio/AudioGraph.h:123`

**Current:**
```cpp
void processBlock(juce::AudioBuffer<float>& buffer, int numSamples);
```

**Must become:**
```cpp
void processBlock(juce::AudioBuffer<float>& buffer, int numSamples,
                  juce::MidiBuffer& midi);
```

The implementation (AudioGraph.cpp line 841) currently passes `emptyMidi_` to
`graph_->processBlock`. Replace that with the forwarded `midi` parameter:

```cpp
// Before:
graph_->processBlock(view, emptyMidi_);

// After:
graph_->processBlock(view, midi);
```

### 4c. `XlethEffectBase::processEffect` — `engine/src/audio/XlethEffectBase.h`

**Current (pure virtual):**
```cpp
virtual void processEffect(juce::AudioBuffer<float>& buffer) = 0;
```

**Must become:**
```cpp
virtual void processEffect(juce::AudioBuffer<float>& buffer,
                           juce::MidiBuffer& midi) = 0;
```

And the call site in `XlethEffectBase::processBlock` must forward `midi`:

```cpp
// Before:
processEffect(buffer);

// After:
processEffect(buffer, midi);
```

---

## 5. Where MidiBuffer Gets Populated (Proposed — Not Yet Implemented)

The MidiBuffer should be built inside `MixEngine::processBlock`, in **two passes**,
before the per-track effect-chain calls:

### Pass A — Note-on events from pattern notes

Inside or immediately after `triggerPatternNotes`, for each emitted `NoteEvent`:

```cpp
int bufOffset = static_cast<int>(tickToAbsSample(event.tick) - bufStart);
bufOffset = juce::jlimit(0, numSamples - 1, bufOffset);

if (event.isNoteOn) {
    trackMidiBuffer.addEvent(
        juce::MidiMessage::noteOn(1, event.pitch,
                                  juce::uint8(event.velocity * 127.0f)),
        bufOffset);
} else {
    trackMidiBuffer.addEvent(
        juce::MidiMessage::noteOff(1, event.pitch),
        bufOffset);
}
```

### Pass B — Clip-start boundaries from activeClips_

After `findActiveClips()`, for each `ActiveClip` whose `clipStartSample` falls within
the current buffer window:

```cpp
for (const auto& ac : activeClips_) {
    if (ac.clipStartSample >= bufStart && ac.clipStartSample < bufEnd) {
        const int bufOffset = static_cast<int>(ac.clipStartSample - bufStart);
        const juce::uint8 vel = juce::uint8(ac.clip->velocity * 127.0f);
        trackMidiBuffer.addEvent(
            juce::MidiMessage::noteOn(2, 60, vel),   // channel 2 = clip marker
            bufOffset);
    }
}
```

Using channel 2 vs channel 1 lets `TransientProcessor` distinguish pattern-note
triggers from clip-start triggers without a separate flag.

---

## 6. Files to Modify (Ordered by Dependency)

1. **`engine/src/audio/XlethEffectBase.h`** — Add `midi` parameter to `processEffect()`
   pure virtual and all call sites. All effect subclasses will need to update their
   `processEffect` override signature (can be `MidiBuffer& /*midi*/` in most).

2. **`engine/src/audio/AudioGraph.h` / `AudioGraph.cpp`** — Add `midi` parameter to
   `processBlock`; forward to `graph_->processBlock` instead of `emptyMidi_`.
   `emptyMidi_` can be removed or kept as a fallback.

3. **`engine/src/audio/EffectChainManager.h` / `EffectChainManager.cpp`** — Add `midi`
   parameter to `processBlock`; forward to `AudioGraph::processBlock`.

4. **`engine/src/audio/MixEngine.cpp`** — Build per-track `MidiBuffer` before each
   `chainIt->second->processBlock(...)` call. Master bus chain likely stays with
   `emptyMidi_` unless transient detection is also needed on the master.

5. **`TransientProcessor::processEffect`** — New effect; receives populated `MidiBuffer`
   and uses note-on sample offsets to anchor transient detection windows.
