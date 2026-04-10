# Xleth Architecture Audit — P3 Mixing System Pre-Work

**Date:** 2026-04-06
**Purpose:** Complete read-only analysis of the existing codebase before building the P3 mixing and effects system. Documents every relevant module, the audio signal chain, threading model, and exact integration points for channel strips, per-clip effects, send buses, and the master bus.

---

## Table of Contents

1. [Project Structure](#1-project-structure)
2. [Data Model](#2-data-model)
3. [Audio Signal Chain](#3-audio-signal-chain)
4. [C++ Engine Modules](#4-c-engine-modules)
5. [Node-API Bridge](#5-node-api-bridge)
6. [IPC Architecture](#6-ipc-architecture)
7. [Video Pipeline](#7-video-pipeline)
8. [UI Layer — Playback & Display](#8-ui-layer)
9. [Existing Mixer Infrastructure](#9-existing-mixer-infrastructure)
10. [P3 Integration Points](#10-p3-integration-points)
11. [Architectural Concerns](#11-architectural-concerns)

---

## 1. Project Structure

Xleth is a three-layer application. The layers are physically isolated: the C++ engine never imports Node/Electron headers; the bridge never imports OpenGL headers; the renderer never calls C++ directly.

```
┌─────────────────────────────────────────────────────────────────┐
│  ELECTRON / REACT  (ui/)                                        │
│  Electron 41 · React 18 · Vite 6                               │
│  Timeline editor, piano roll, sampler UI, video preview         │
│  Process: Electron renderer                                     │
└──────────────────────┬──────────────────────────────────────────┘
                       │  IPC (child_process.fork + ipcMain/ipcRenderer)
                       │  Video frames: Windows named file mapping (zero-copy)
                       ▼
┌─────────────────────────────────────────────────────────────────┐
│  NODE-API BRIDGE  (bridge/src/XlethAddon.cpp)                   │
│  N-API v8 · cmake-js · node-addon-api                           │
│  Runs in: forked Node.js child process (addon-worker.js)        │
│  Reason for fork: JUCE/FFmpeg crash inside Electron's Chromium  │
└──────────────────────┬──────────────────────────────────────────┘
                       │  Direct C++ function calls (same process as worker)
                       ▼
┌─────────────────────────────────────────────────────────────────┐
│  C++ ENGINE  (engine/)                                          │
│  C++20 · JUCE 8 · FFmpeg 7 · nlohmann/json                     │
│                                                                  │
│  XlethEngineModel (static lib) — pure data model, no JUCE       │
│  XlethEngineCore  (static lib) — audio/video engine, no OpenGL  │
│  XlethEngine      (executable) — adds VideoCompositor (OpenGL)  │
└─────────────────────────────────────────────────────────────────┘
```

### Build Outputs

| Artifact | Linked from | Purpose |
|----------|-------------|---------|
| `bridge/build/Release/xleth_native.node` | XlethEngineCore | Node-API addon |
| `shm_helper/build/Release/shm_helper.node` | Windows API | Zero-copy video frames |
| `engine/build/Release/XlethEngine.exe` | XlethEngineCore + VideoCompositor | Standalone preview |
| `engine/build/Release/test_*.exe` | Model or Core | Unit tests |

---

## 2. Data Model

All structs live in `engine/src/model/TimelineTypes.h`. The `Timeline` class (`engine/src/model/Timeline.h/.cpp`) is the single source of truth and stores everything in `std::map<int, T>` keyed by integer ID.

### TickTime — Musical Time

```
960 PPQ (pulses per quarter note)

Helpers:
  TickTime::fromBeats(n)   fromBars(n)   from16th(n)
  .toBeats()   .toSeconds(bpm)   .toSamples(bpm, sampleRate)
  Operators: <  <=  ==  >  >=  +  -
```

### SourceMedia — Imported File

```
id, filePath, proxyPath, fileName
width, height, fps, duration, totalFrames
hasVideo (bool), proxyReady (bool)
```

### SampleRegion — Marked Segment of a Source

Full parameter set for the sampler:

```
id, sourceId, name, label (Kick|Snare|HiHat|Crash|Pitch|Quote|Custom)
startTime, endTime (seconds)
startFrame, endFrame (video frames)
audioFilePath, swappedAudioPath
rootNote (MIDI, default 60)

// ADSR amplitude envelope
attackMs, decayMs, sustain (0..1), releaseMs
delayMs, holdMs
attackTension, decayTension, releaseTension (-1..+1, 0=linear)

// Pitch envelope (modulates playback rate)
pitchEnvEnabled, pitchEnvAmount (-48..+48 semitones)
pitchEnvDelayMs, pitchEnvAttackMs, pitchEnvHoldMs
pitchEnvDecayMs, pitchEnvSustain, pitchEnvReleaseMs
pitchEnvAttackTension, pitchEnvDecayTension, pitchEnvReleaseTension

// Sample trim & click removal
smpStart, smpLength (source samples)
declickSamples (Hann fade at trim edges, default 64)
fadeInMs, fadeOutMs (linear user fades)

// Loop & crossfade
loopEnabled, loopStart, loopEnd (source samples)
crossfadeEnabled, crossfadeSamples

// Precomputed destructive effects (apply order: DC → normalize → polarity → reverse)
dcOffsetRemoved, normalized, polarityReversed, reversed

// Playback modes
monoEnabled
portamentoEnabled, portamentoTimeMs

// Arpeggiator
arpEnabled, arpTempoSync, arpDivision (4|8|16)
arpFreeTimeMs, arpGate (0..1), arpRange, arpDirection (Up|Down|UpDown|UpDownSticky)

// Three independent LFOs (targets: Volume, Panning, Pitch)
lfoVolEnabled, lfoVolAmount, lfoVolSpeedHz
lfoVolTempoSync, lfoVolTempoDivision
lfoVolAttackMs, lfoVolDelayMs
lfoVolWaveform  (breakpoint list: [{time 0..1, value -1..1}])
// same fields for lfoPan* and lfoPitch*

// Syllable segmentation (for Quote regions)
syllables: [{startTime, endTime, number, text}]
```

### TrackInfo — Sequencer Channel

```
id, name
volume (float, 0..1+)    ← read by audio thread
pan    (float, -1..+1)   ← read by audio thread
muted  (bool)            ← read by audio thread
solo   (bool)            ← read by audio thread
order
type (Clip | Pattern)
videoX, videoY, videoW, videoH, videoOpacity, videoZOrder
videoFlipMode (None | HorizontalEven | Clockwise | CounterClockwise)
```

### Clip — Region Instance on a Track

```
id, trackId, regionId
position, duration  (TickTime)
regionOffset        (ticks into region where clip starts, 0 = beginning)
syllableIndex       (-1 = whole region, ≥0 = specific syllable)
velocity  (0..1)
pitchOffset (semitones)
```

### Pattern — Named Note Sequence

```
id, name
regionId (-1 = unbound)
length   (TickTime, user-set)
notes    (vector<PatternNote>)
nextNoteId (per-pattern counter)
```

### PatternNote — Note Within a Pattern

```
id
position, duration (TickTime, relative to pattern start)
pitch    (MIDI 0-127, 60 = C4)
velocity (0..1)
```

### PatternBlock — Pattern Instance on a Track

```
id, trackId, patternId
position, duration (TickTime)
offset      (trim left edge within pattern)
loopEnabled (bool)
```

### GridLayout / GridSlot — Video Grid

```
GridLayout: columns (1-8), rows (1-8), slots[], chorusTrackId, crashEnabled, crashTrackId, crashOpacity, previewFps
GridSlot:   trackId, gridX, gridY, spanX, spanY, opacity, zOrder
```

---

## 3. Audio Signal Chain

### Call Graph (Current — No Effects)

```
AudioEngine::audioDeviceIOCallbackWithContext()   [JUCE audio RT thread, ~5ms period]
│
│  outputBuffer.clear()
│
├─ [1] TriggerQueue::drain()  →  VoiceManager::processBlock(output, sampleBank)
│       └─ Simple linear read from SampleBank slot, no pitch shift, no envelope
│          Used only for keyboard-preview triggers from UI
│
├─ [2] MixEngine::processBlock(output, numSamples, transport)
│   │
│   │  // Seek detection — if playhead jumped, silence all voices
│   │  if (bufStart != lastBufferEnd_) → allNotesOff() all samplers
│   │
│   │  // Gather active entities in this buffer window
│   │  Find active Clips   in [bufStart, bufStart+numSamples)
│   │  Find active Pattern Blocks in [bufStart, bufStart+numSamples)
│   │
│   │  // Pattern note scheduling (tick-accurate within buffer)
│   │  For each active PatternBlock:
│   │    Convert buffer sample boundaries to ticks (960 PPQ @ current BPM)
│   │    Iterate PatternNotes, fire noteOn/noteOff at exact sample offset
│   │    Target: Sampler keyed by {trackId, regionId}
│   │
│   │  // Render into per-track scratch buffers
│   │  For each track:
│   │    trackBuffer[trackId].clear()
│   │    ├─ Clip-type track: linear sample read from SampleBank → trackBuffer
│   │    └─ Pattern-type track: Sampler::processBlock() → trackBuffer (additive)
│   │         └─ Cubic Hermite interpolation, DAHDSR, pitch env, 3x LFO, portamento
│   │
│   │  // Per-track processing & sum               ← CHANNEL STRIP HOOK GOES HERE
│   │  For each track:
│   │    if (muted || (anySoloed && !soloed)) skip
│   │    TrackMixer::process(trackBuffer, volume, pan, peakL, peakR)
│   │      └─ applyVolume → applyConstantPowerPan → measurePeaks
│   │    output += trackBuffer
│   │
│   │  // Preview samplers (piano roll audition, bypasses track routing)
│   │  For each previewSampler: render into output directly
│   │
│   └─ output.clamp(-1, +1)    ← MASTER BUS HOOK GOES HERE
│      Update masterPeakL/R (atomic)
│
├─ [3] SourcePlayer::processBlock(output, numSamples)
│       └─ Decoded PCM from sample picker → additive mix into output
│
├─ [4] Optional ThreadedWriter::writeFromAudioThread(output)  (WAV capture)
│
└─ [5] Transport::advance(numSamples)
```

### Key Timing Properties

| Property | Value | Where set |
|----------|-------|-----------|
| Default sample rate | 44 100 Hz (ASIO) / 48 000 Hz (fallback) | `AudioEngine::initialize()` |
| Default buffer size | 256 samples (ASIO) / 512 (fallback) | `AudioEngine::initialize()` |
| Tick resolution | 960 PPQ | `TimelineTypes.h` |
| Samples per tick @ 140 BPM / 44100 Hz | ≈ 18.9 | `Transport::advance()` |
| Max concurrent voices | 32 per Sampler instance | `Sampler.h` |
| Max tracks | 64 (trackBuffers_ array) | `MixEngine.h` |

---

## 4. C++ Engine Modules

### AudioEngine (`engine/src/AudioEngine.h/.cpp`)

Owns the JUCE `AudioDeviceManager`. Wires all subsystems together.

**Owns:**
- `TriggerQueue` (256-slot lock-free ring) — keyboard triggers
- `VoiceManager` — simple sample playback
- `Transport` — atomic playback position
- `MixEngine` — timeline mixer
- `SourcePlayer` — sample picker preview
- Optional `juce::TimeSliceThread` + `juce::AudioFormatWriter::ThreadedWriter` — WAV capture

**Init sequence (`initialize()`):**
1. Try ASIO → Windows Audio → fallback
2. Negotiate 44100/256 or 48000/512
3. MMCSS Pro Audio priority boost (runtime DLL)
4. Start audio stream

**Callback order** (see §3 above).

---

### MixEngine (`engine/src/audio/MixEngine.h/.cpp`)

The core runtime mixer. Manages sampler lifetimes and drives per-track rendering.

**Configuration API (main thread):**
```cpp
setTimeline(Timeline*)
setSampleBank(SampleBank*)
mapRegionToSample(regionId, sampleBankSlot)

loadSamplerForTrackRegion(trackId, regionId)   // creates Sampler, applies full region config
unloadSamplerForTrackRegion(trackId, regionId)
unloadSamplersForTrack(trackId)
unloadSamplersForRegion(regionId)
rebuildAllSamplers()                            // called after project load, undo, redo

getSamplerPtr(trackId, regionId) → Sampler*    // returns nullptr if not loaded
ensurePreviewSampler(regionId)                 // piano-roll audition (no trackId)
getPreviewSamplerPtr(regionId) → Sampler*
```

**Audio thread:**
```cpp
processBlock(juce::AudioBuffer<float>& output, int numSamples, Transport&)
```

**Peak meters (thread-safe atomic reads):**
```cpp
getMasterPeakL() / getMasterPeakR() → float
getTrackPeakL(trackId) / getTrackPeakR(trackId) → float
```

**Internal storage:**
```
samplers_         unordered_map<{trackId,regionId}, unique_ptr<Sampler>>
previewSamplers_  unordered_map<regionId, unique_ptr<Sampler>>
trackBuffers_[64] pre-allocated stereo scratch (JUCE AudioBuffer, 1024 samples each)
activeClips_      pre-allocated vector, reused every block (no alloc on RT thread)
activeBlocks_     pre-allocated vector, reused every block
prevActiveKeys_   set of {trackId,regionId} active last block — fires allNotesOff on block exit
```

---

### TrackMixer (`engine/src/audio/TrackMixer.h/.cpp`)

All static methods. No state. Audio-thread safe.

```cpp
static void applyVolume(buffer, gain)
    buffer.applyGain(gain)

static void applyPan(buffer, pan)
    angle = (pan + 1) * π/4
    L *= cos(angle)   R *= sin(angle)   // constant-power pan law

static void measurePeaks(buffer, &peakL, &peakR)

static void process(buffer, volume, pan, &peakL, &peakR)
    // volume → pan → peaks in one pass
```

Pan endpoints: `-1` → L=1 R=0; `0` → L=R=0.707 (-3 dB); `+1` → L=0 R=1.

---

### Sampler (`engine/src/audio/Sampler.h/.cpp`)

Polyphonic pitched sample player. 32 voices max per instance.

**Voice state:**
```
active, midiNote, velocity
playPosition (fractional sample index)
pitchRatio   (2^((note - root) / 12))
currentPitchF (fractional MIDI note, smoothed for portamento)
portamentoRemaining (samples of glide remaining)
envStage / envLevel / envPosition      (DAHDSR)
pitchEnvStage / pitchEnvLevel / ...    (pitch envelope)
lfoVolState / lfoPanState / lfoPitchState  (per-voice LFO phase/delay/attack)
noteHeld (bool, for sustain/crossfade logic)
```

**Per-sample processing (`processVoice()`):**
1. Declick: Hann-window at trim edges (`declickSamples`)
2. User fade: linear fadeInMs / fadeOutMs
3. Loop logic: wrap at loopEnd → loopStart; crossfade if enabled (cosine/sine blend)
4. Advance DAHDSR envelope (tension-shaped power curve per stage)
5. Advance pitch envelope (same FSM)
6. Advance 3x LFO (breakpoint waveform, tempo-sync option, delay+attack ramp)
7. Update portamento glide (`currentPitchF → targetPitch`)
8. Compute stride: `pitchRatio * pitchEnvRatio * lfoRatio * (srcSR / engSR)`
9. **4-point cubic Hermite interpolation** at `playPosition`
10. Apply gain: `envGain * velocity * declickGain * fadeGain * volLfoGain * panGain`
11. Advance `playPosition` by stride

**Voice allocation:**
- Free voice first; steal lowest-envelope voice if all busy
- Mono mode: held-note stack (max 16), glide to next held note on noteOff

---

### SampleProcessor (`engine/src/audio/SampleProcessor.h/.cpp`)

Destructive preprocessing only (not real-time). Applied once when loading a sample.

```cpp
static void removeDCOffset(buffer)       // per-channel mean subtraction
static void normalize(buffer, target=1)  // scale to target peak
static void reversePolarity(buffer)      // *= -1
static void reverse(buffer)              // std::reverse per channel
static void applyFlags(buffer, flags)    // canonical order: DC→norm→polarity→reverse
```

`SampleProcessor` is **not** an insert effect. It mutates the PCM stored in SampleBank. Toggling a flag triggers `rebuildAllSamplers()` to re-apply from pristine source.

---

### SourcePlayer (`engine/src/audio/SourcePlayer.h/.cpp`)

Decodes an entire source file into RAM (FFmpeg → stereo float @ engine sample rate), then does simple linear PCM playback. Used exclusively by the sample picker preview — not the timeline.

```cpp
loadSource(filePath, engineSampleRate)   // blocking FFmpeg decode
play(startTimeSeconds)
pause() / resume() / seek(t) / stop()
isPlaying() / getPosition() / getDuration()
processBlock(output, numSamples)         // additive mix into output (RT thread)
```

---

### Transport (`engine/src/Transport.h/.cpp`)

All state is atomic. Safe to read from audio thread and write from main thread simultaneously.

```cpp
setSampleRate(double)
setBPM(double)                  // default 140.0
play()                          // memory_order_release
stop()                          // resets position to 0
pause()                         // keeps position
advance(int numSamples)         // audio thread only

getPositionSamples() → int64_t  // memory_order_acquire
getPositionSeconds() → double
getPositionBeats()  → double    // samples / (sampleRate * 60 / bpm)
getPositionBars()   → int       // 1-indexed, 4/4 assumed
isPlaying()         → bool
getBPM()            → double    // memory_order_relaxed
seekToSample(int64_t)
seekToBeat(double)
seekToBar(int)
```

---

### VoiceManager (`engine/src/VoiceManager.h/.cpp`)

Simple triggered playback for UI keyboard preview. No pitch shifting, no envelopes.

```cpp
triggerSample(sampleId, velocity)   // voice stealing: steals furthest-played voice
processBlock(output, sampleBank)    // linear read, velocity as gain only
```

---

### SampleBank (`engine/src/SampleBank.h/.cpp`)

Owns the PCM data for all loaded samples. Indexed by integer slot.

- Main thread: load, decode, store
- Audio thread: read-only pointer access (no alloc, no lock)
- `SampleProcessor::applyFlags()` run on load

---

### AudioExporter (`engine/src/export/AudioExporter.h/.cpp`)

Offline render to WAV. Calls `MixEngine::processBlock()` in a loop with a fake transport stepping through the project.

⚠️ **Currently has no effect chain** — renders pre-effects signal. Must be updated for P3.

---

### UndoManager + Commands (`engine/src/commands/`)

Standard command pattern. `TimelineCommands.cpp` covers clip add/remove/move/resize, region add/remove/modify, track add/remove, pattern/block mutations.

```cpp
UndoManager::execute(Command*)  // do + push
UndoManager::undo()             // pop + undoStep()
UndoManager::redo()
```

After undo/redo, `XlethAddon.cpp:rebuildAllSamplers()` is called to resync the audio engine with the new timeline state.

---

### ProjectManager (`engine/src/project/ProjectManager.h/.cpp`)

Creates, saves, and loads projects as JSON files. Delegates to `Timeline::toJSON()` / `fromJSON()`. Manages media import (copies files, generates proxy paths).

---

## 5. Node-API Bridge

`bridge/src/XlethAddon.cpp` — N-API v8, ~1000+ lines. All exported functions run on the Node.js main thread (the forked child process). Never called from the audio RT thread.

### Global Engine State

```cpp
unique_ptr<AudioEngine>     audioEngine
unique_ptr<SampleBank>      sampleBank
unique_ptr<Timeline>        g_timeline
unique_ptr<UndoManager>     g_undoManager
unique_ptr<ProjectManager>  g_projectManager
unique_ptr<FrameCache>      frameCache
unique_ptr<FrameServer>     g_frameServer
unique_ptr<SyncManager>     syncManager
FrameOutput                 frameOutput          // double-buffered, lock-free
thread                      videoThread          // ~60 Hz video tick
atomic<bool>                videoRunning
```

### Key Internal Helpers

| Function | Purpose |
|----------|---------|
| `refreshSamplerForRegion(regionId)` | Reload all {trackId, regionId} sampler pairs + preview sampler after region config change |
| `refreshSamplerForTrack(trackId)` | Rebuild all sampler pairs for one track |
| `refreshSamplerForPattern(patternId)` | Look up pattern's regionId, call refreshSamplerForRegion |
| `unloadSamplersForRegion(regionId)` | Unload all pairs + preview |
| `rebuildAllSamplers()` | Full resync after project load, undo, redo |
| `rebuildVideoEventsFromClips()` | Reconstruct SyncManager's VideoEvent list from current timeline clips and pattern blocks |
| `ensureSourceDecoder(sourceId)` | Open VideoDecoder for source (proxy if ready), spawn proxy watchdog |
| `blitYuvToCanvas(...)` | CPU YUV420P → RGBA with flip/opacity for composite canvas |

### Exposed N-API Surface (grouped)

**Project:**
```
project.create(dir, name)   save()   saveAs(dir, name)   load(dir)
project.importSource(filePath)   validateMedia()   getInfo()
project.getSourceThumbnail(filePath)
project.openNewProjectDialog()   openProjectDialog()   openSaveAsDialog()   openImportDialog()
```

**Timeline — Tracks:**
```
timeline.getTracks()   addTrack(info)   removeTrack(id)
timeline.setTrackMuted(id, bool)   setTrackSolo(id, bool)   setTrackName(id, name)
timeline.setVideoFlipMode(id, mode)
timeline.convertToPatternTrack(id)   convertToClipTrack(id)
```

**Timeline — Clips:**
```
timeline.getClips()   getClipsOnTrack(id)   getClipsInRange(start, end)
timeline.addClip(clip)   removeClip(id)
timeline.moveClip(id, trackId, pos)   resizeClip(id, dur)
timeline.autoTrimClip(id, thresholdDb=-54)
```

**Timeline — Regions:**
```
timeline.getRegions()   getRegionsByLabel(label)
timeline.addRegion(region)   modifyRegion(id, region)   removeRegion(id)
timeline.setSyllables(id, syllables)   getSyllables(id)
```

**Timeline — Patterns & Blocks:**
```
timeline.getAllPatterns()   addPattern(info)   getPattern(id)   removePattern(id)
timeline.setPatternName(id, name)   setPatternRegion(id, regionId)
timeline.addPatternBlock(block)   getPatternBlocks()
timeline.removePatternBlock(id)
timeline.movePatternBlock(id, trackId, ticks)   resizePatternBlock(id, ticks)
timeline.resizePatternBlockLeft(id, pos, dur, off)
timeline.setPatternBlockLoop(id, bool)
```

**Timeline — Notes:**
```
timeline.addNote(patternId, note)   removeNote(patternId, noteId)
timeline.moveNote(patternId, noteId, ticks, pitch)
timeline.moveNotesBatch(patternId, moves[])
timeline.resizeNote(patternId, noteId, ticks)
timeline.setNoteVelocity(patternId, noteId, vel)
timeline.previewNote(patternId, pitch, vel)   previewNoteOff(patternId, pitch)
timeline.previewAllNotesOff(regionId)
```

**Timeline — BPM / Grid:**
```
timeline.getBPM()   setBPM(bpm)
timeline.getGridLayout()   setGridLayout(layout)
timeline.assignTrackToGrid(...)   removeTrackFromGrid(id)
timeline.setChorusTrack(id)   setCrashOverlay(enabled, id, opacity)
timeline.setPreviewFps(fps)
```

**Timeline — Sampler Settings:**
```
timeline.updateSamplerSettings(regionId, settings)   // writes region fields, calls refreshSamplerForRegion
timeline.getPatternAudioInfo(id)   getRegionAudioInfo(regionId)
timeline.getRegionWaveformPeaks(regionId, pixelWidth)
```

**Audio:**
```
audio.loadSample(path)   triggerSample(id, vel)   mapRegionToSample(regionId, sampleId)
audio.loadSourceRegion(filePath, startTime, endTime)
audio.getMasterPeak()   getTrackPeak(trackId)
audio.getWaveformData(filePath, px)   getWaveformRegion(filePath, t0, t1, px)
audio.detectRootNote(filePath)
audio.loadSource(path)   playSource(t)   pauseSource()   resumeSource()
audio.seekSource(t)   stopSource()   getSourcePosition()   isSourcePlaying()   unloadSource()
audio.exportStart(cfg)   exportGetProgress()   exportCancel()   exportSaveAsDialog(name, fmt)
audio.exportRegion(regionId)
audio.openSwapAudioDialog()   swapRegionAudio(regionId, data)   revertRegionAudio(regionId)   loadRegionAudio(regionId)
audio.probeAudioDuration(filePath)
```

**Transport:**
```
transport.play()   stop()   pause()
transport.seek(beatPos)
transport.getState() → { playing, bpm, positionBeats, positionSeconds, positionSamples }
```

**Undo:**
```
undo.undo()   redo()   canUndo()   canRedo()
undo.getUndoDescription()   getRedoDescription()
```

**Video / Sync:**
```
video.setResolution(w, h)   getFrameBuffer()   getFrameRGBA()   openFrameShm()
video.openSource(id)   closeSource(id)   getFrameAtTime(id, t, maxW, maxH)
sync.getStats()
```

### N-API Surface — What Is Missing for P3

The following functions do not exist yet and will need to be added:

```
audio.setTrackVolume(trackId, vol)          // volume currently set only via timeline model
audio.setTrackPan(trackId, pan)             // same
audio.getChannelStrip(trackId)              // no mixer strip state query
audio.setChannelStrip(trackId, strip)       // no write path for strip params

audio.addEffect(trackId, effectType)        // no effect chain API
audio.removeEffect(trackId, slotIndex)
audio.setEffectParam(trackId, slot, param, value)
audio.getEffectParam(trackId, slot, param)
audio.setEffectBypassed(trackId, slot, bool)

audio.getMasterBusState()
audio.setMasterBusParam(param, value)

audio.getSendLevel(trackId, busIndex)
audio.setSendLevel(trackId, busIndex, level)
audio.getSendReturn(busIndex)
```

---

## 6. IPC Architecture

```
React Component
    │  window.xleth.timeline.addClip(clip)
    ▼
preload.js  (Electron renderer process)
    │  ipcRenderer.invoke('addon:call', { method: 'timeline.addClip', args: [clip] })
    ▼
main.js  (Electron main process)
    │  Receives ipcMain.handle('addon:call', ...)
    │  Sends { id, method, args } via child.send()
    ▼
addon-worker.js  (forked Node.js child process)
    │  Calls xleth[method](...args) on the native addon
    │  xleth_native.node (XlethAddon.cpp) runs on Node main thread of the child
    │  Returns { id, result } via process.send()
    ▼
main.js resolves the Promise
    ▼
preload.js resolves the ipcRenderer.invoke()
    ▼
React Component receives result
```

**High-frequency paths:**
- `transport.getState()` — polled every 33–200 ms by `transportStore.js`; result cached and distributed to React subscribers
- `video.getFrameBuffer()` — **bypassed** by shared memory: renderer reads directly from the Windows named file mapping (`XlethFrameBuffer`) opened by `shm_helper.node`

**Latency budget:** Each IPC round-trip (ipcRenderer.invoke → child process → native addon → back) is ~1–5 ms. Acceptable for UI responses; unacceptable for audio parameter automation (must use direct atomic writes in C++ instead).

---

## 7. Video Pipeline

```
ProjectManager::importSource(filePath)
    │
    ├─ ProxyTranscoder: generate low-res proxy MP4 in background
    └─ ensureSourceDecoder(sourceId)
          └─ VideoDecoder (FFmpeg): open file (or proxy when ready)

rebuildVideoEventsFromClips()   [called after any timeline edit]
    └─ SyncManager: build VideoEvent list from clips + pattern blocks

videoThread (~60 Hz):
    SyncManager::videoTick(beatPos)
        └─ For each active VideoEvent:
             VideoDecoder::seekToTime(t)  →  FrameCache::store(frame)
             blitYuvToCanvas(frame, track scale/opacity/flip)
             FrameOutput::writeFrame(compositeBuffer)   → Windows named file mapping

shm_helper.node (Electron renderer preload):
    MapViewOfFile("XlethFrameBuffer")  →  Uint8Array view (zero-copy)

VideoPreview.jsx:
    Read Uint8Array, blit to <canvas>  (requestAnimationFrame, 60 fps)
```

---

## 8. UI Layer

### Transport & Timing

| File | Role |
|------|------|
| `ui/src/transportStore.js` | Polls `transport.getState()` at 33–200 ms; caches; notifies subscribers |
| `ui/src/services/PlayheadClock.js` | Interpolates between polls at 60 fps for smooth scrubber |
| `ui/src/components/TransportBar.jsx` | Play/pause/stop buttons, BPM display, position display |

### Timeline Editor

| File | Role |
|------|------|
| `TimelineView.jsx` | Container, layout |
| `timeline/TimelineCanvas.jsx` | Canvas rendering of clips and pattern blocks |
| `timeline/timelineDrawing.js` | Low-level canvas draw calls (clips, grids, playhead) |
| `timeline/TrackHeader.jsx` | Per-track header (name, mute, solo buttons) |
| `timeline/tools/` | selectTool, pencilTool, deleteTool, splitTool |

TrackHeader renders the mute/solo toggle buttons that call `window.xleth.timeline.setTrackMuted()`. There are currently **no volume or pan controls** in the track header — those are missing UI for P3.

### Piano Roll

| File | Role |
|------|------|
| `PianoRoll.jsx` | Container, keyboard events |
| `PianoRollCanvas.jsx` | Canvas rendering of notes |
| `PianoRollKeyboard.jsx` | Piano keyboard display |
| `VelocityLane.jsx` | Per-note velocity editing |
| `PianoRollToolbar.jsx` | Edit mode toolbar |

### Sampler UI

| File | Role |
|------|------|
| `SamplerPanel.jsx` | Top-level sampler control panel |
| `EnvelopeEditor.jsx` | ADSR envelope draggable editor |
| `LfoSection.jsx` | LFO rate/amount/waveform controls |
| `SamplerWaveform.jsx` | Waveform display with trim/loop markers |
| `MiniKeyboard.jsx` | Preview keyboard |

---

## 9. Existing Mixer Infrastructure

### What Already Exists

| Feature | Location | Status |
|---------|----------|--------|
| Per-track volume | `TrackInfo.volume` (model) + `TrackMixer::applyVolume()` | ✅ Working |
| Per-track pan (constant-power) | `TrackInfo.pan` + `TrackMixer::applyPan()` | ✅ Working |
| Per-track mute | `TrackInfo.muted` + MixEngine skip logic | ✅ Working |
| Per-track solo | `TrackInfo.solo` + MixEngine any-solo logic | ✅ Working |
| Per-track peak meters (L+R, atomic) | `MixEngine::getTrackPeakL/R()` | ✅ Working |
| Master peak meters (L+R, atomic) | `MixEngine::getMasterPeakL/R()` | ✅ Working |
| Pre-allocated track scratch buffers | `trackBuffers_[64]` | ✅ Working |
| Seek-triggered all-notes-off | `MixEngine::processBlock()` seek detection | ✅ Working |

### What Does Not Exist

| Feature | Notes |
|---------|-------|
| Insert effect chain (per track) | No abstraction, no slots, no processBlock interface |
| Send buses | No send buffers, no per-track send levels |
| Master bus processing | Bare sum → hard clamp at ±1 |
| Real-time limiter | Only a hard clamp (digital clipping on sum overflow) |
| Channel strip UI | No volume/pan faders in TrackHeader |
| Mixer panel / mixing view | No dedicated mixer page in the UI |
| Volume/pan write path via audio API | Only settable through Timeline model mutation |

---

## 10. P3 Integration Points

### 10.1 Channel Strip — Replace `TrackMixer::process()`

**Current path:**
```cpp
// MixEngine::processBlock(), per-track loop
TrackMixer::process(trackBuffer, trackInfo.volume, trackInfo.pan, peakL, peakR);
output.addFrom(trackBuffer);
```

**P3 path:**
```
trackBuffer (raw Sampler/clip output)
    → PreGain (trim before EQ)
    → EQ inserts
    → Compressor/Dynamics
    → PostGain (fader)
    → Pan (constant-power)
    → Send taps (pre or post fader, into sendBuffers_[N])
    → PeakMeter update
output.addFrom(trackBuffer)
```

`TrackMixer` becomes a `ChannelStrip` class that holds the effect chain and is instantiated per track in `MixEngine`.

### 10.2 Per-Clip Effects — Insert Before Channel Strip

**Current path:**
```
Sampler::processBlock() → trackBuffer
```

**P3 path:**
```
Sampler::processBlock() → clipEffectChain.process(trackBuffer) → trackBuffer
```

This requires a `ClipEffectChain` abstraction associated with each `{trackId, regionId}` pair (same key as `samplers_` map). Per-clip effects would be things like pitch correction, clip-level EQ, or saturation.

### 10.3 Send Buses — New Pre-Allocated Buffers in MixEngine

**MixEngine additions needed:**
```cpp
juce::AudioBuffer<float> sendBuffers_[MAX_SENDS];  // e.g. 4 aux buses
float sendLevels_[64][MAX_SENDS];                  // per-track per-send
bool  sendPreFader_[64][MAX_SENDS];                // pre or post fader tap
```

After the main mix loop, each send buffer is processed by its return chain (e.g., reverb, delay) and summed back into the master output.

### 10.4 Master Bus — Insert After Final Sum

**Current path:**
```cpp
output.applyGain(/* clamp simulation */);
output.clamp(-1.0f, 1.0f);
```

**P3 path:**
```
masterSumBuffer
    → MasterBus::process()
        → Master EQ
        → Master Compressor / Limiter (soft-knee, true-peak)
        → Master Gain
        → Master Peak Meter
    → output
```

The hard clamp at ±1 should be replaced with a proper limiter (at minimum, a lookahead peak limiter with 1–2 ms attack).

### 10.5 Effect Plugin Abstraction

P3 needs a real-time effect interface. The simplest design that mirrors LMMS's `Plugin` base:

```cpp
class AudioEffect {
public:
    virtual ~AudioEffect() = default;
    virtual void prepare(double sampleRate, int maxBlockSize) = 0;
    virtual void processBlock(juce::AudioBuffer<float>& buffer) = 0;
    virtual void reset() = 0;
    virtual std::string getType() const = 0;
    // Parameter get/set (keyed by string name)
    virtual float getParam(const std::string& name) const = 0;
    virtual void  setParam(const std::string& name, float value) = 0;
};
```

An `EffectChain` holds `vector<unique_ptr<AudioEffect>>` and loops `processBlock()` in order.

### 10.6 Effect State Data — Where to Store

**Option A: Add `effectChain` vector to `TrackInfo`**
- Pro: effect state lives in the model, serialized naturally with JSON
- Con: TrackInfo is currently a plain struct read by the audio thread; adding vectors/strings is unsafe without careful locking

**Option B: Parallel `EffectChainMap` in Timeline (or MixEngine)**
- Pro: keeps TrackInfo as a lightweight POD-like struct; effect objects live in the engine layer where they belong
- Con: serialization requires a separate code path

**Recommendation: Option B.** Keep `TrackInfo` as-is. Add `EffectChainMap` to `MixEngine` (audio state) with a separate JSON serialization pass in `ProjectManager`. Mirror the pattern of `samplers_` (keyed by trackId, owned by MixEngine, synced from model via helper functions).

---

## 11. Architectural Concerns

### ⚠️ C1 — TrackInfo Stores Audio Params in the Data Model (No Explicit Sync)

`volume`, `pan`, `muted`, `solo` live in `Timeline::m_tracks` (a `std::map`). The audio thread reads these on every `processBlock()` call by looking up `getTrack(trackId)`. The main thread can call `timeline.addTrack()` / `removeTrack()` at any time, which mutates the map.

Currently tolerable because scalar writes to `float`/`bool` are effectively atomic on x86 and timeline mutations are infrequent. **This will become dangerous if** P3 adds complex effect state (vectors, strings, heap allocations) to `TrackInfo`. Design principle: effect chain objects should live in `MixEngine`, not in `TrackInfo`.

### ⚠️ C2 — Sampler Lifecycle Races (Main Thread Config vs. Audio Thread Read)

`MixEngine::loadSamplerForTrackRegion()` (main thread) allocates a `unique_ptr<Sampler>` and inserts it into `samplers_`. The audio thread iterates `samplers_` on every block. There is no explicit mutex. Currently safe because map reads are not concurrent with map writes in practice (main thread config happens before playback or during brief pauses), but not formally protected. Adding a lock would break real-time guarantees; the correct fix is a double-buffered sampler map with atomic pointer swap, or a message queue pattern.

### ⚠️ C3 — No Real-Time Effect Plugin Interface

`SampleProcessor` provides only destructive (apply-once) operations. There is no `processBlock()`-based plugin abstraction anywhere in the engine. P3 must introduce `AudioEffect` as described in §10.5.

### ⚠️ C4 — Hard Clamp Instead of Limiter

`MixEngine::processBlock()` ends with a hard clip to ±1. Multiple tracks summing at full volume will digitally clip. A proper soft-knee limiter (or at minimum an inter-sample peak-aware hard limiter with lookahead) must replace this for the master bus.

### ⚠️ C5 — AudioExporter Has No Effect Chain

`AudioExporter` renders the project offline by calling `MixEngine::processBlock()` in a loop. It currently bypasses any future effect chain. The exporter must be updated alongside P3 to process inserts, sends, and master bus in the offline render path.

### ⚠️ C6 — Volume/Pan Have No Direct Audio API Write Path

`TrackInfo.volume` and `TrackInfo.pan` are written via `timeline.setTrackVolume()` (or equivalent Timeline mutation). There is no `audio.setTrackVolume()` shortcut that bypasses the full IPC round-trip. For automation playback (writing automation lanes that change volume at audio-thread rate), a direct atomic write path in C++ will be needed — similar to how `Transport` state uses atomics.

### ⚠️ C7 — No Mixer UI

The current `TrackHeader` shows name + mute + solo. There are no volume faders, pan knobs, or send level controls. P3 requires a dedicated mixer panel (vertical channel strips) similar to LMMS's `FxMixerView` or a DAW's mixer window.

---

## Appendix A — LMMS Comparison Notes

| Xleth | LMMS equivalent | Notes |
|-------|----------------|-------|
| `MixEngine` | `MixerWorkerThread` + `InstrumentTrack::processAudioBuffer()` | LMMS uses worker threads per track; Xleth single-threaded per block |
| `TrackMixer` | `EffectChain::processAudio()` inline | LMMS runs effect chain after each track's buffer is ready |
| `Sampler` | `AudioFileProcessor` + `sf2Player` | LMMS instruments are plugin objects; Xleth Sampler is monolithic |
| `SampleProcessor` (destructive) | LMMS has no equivalent — effects are always real-time | Xleth's destructive ops are a legacy from the original design |
| Missing: `FxMixer` | `FxMixer` (16 channels, sends, per-channel plugin chains) | Xleth has no equivalent yet — this is P3 |
| Missing: `AudioEffect` base class | `Effect` base with `processAudioBuffer()` | P3 must add this abstraction |
| Hard clamp | LMMS uses `FxMixer`'s master gain + clamp | Replace with proper limiter |

LMMS source reference: `src/core/audio/AudioEngine.cpp`, `src/core/FxMixer.cpp`, `include/AudioEffect.h`.

---

*End of Architecture Audit — Xleth P3 Pre-Work*
