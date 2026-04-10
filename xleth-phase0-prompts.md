# Xleth — Phase 0 Prompt Sequence for Claude Code
### Build Prompts 1–16 | Proof of Concept

---

## How to Use This Document

Each prompt below is designed to be copy-pasted into Claude Code **one at a time**. After each prompt completes:

1. **Verify the build compiles** (`cmake --build build --config Release`)
2. **Run the test described** in the prompt's verification section
3. **Only proceed to the next prompt** if all checkboxes pass
4. If something breaks, fix it before moving on — do NOT skip ahead

Prompts are numbered with sub-steps (1A, 1B, etc.) where a single Phase 0 step needs to be broken into smaller pieces to avoid overloading Claude Code.

---

## PROMPT 1A — Project Scaffolding + CMake Setup

```
We are building "Xleth" — a Sparta Remix DAW combining FL Studio-style audio 
sequencing with Vegas Pro-style video compositing. This is the Phase 0 proof 
of concept. Today we are ONLY setting up the project structure and CMake build.

Create the following directory structure at the project root:

xleth/
├── CMakeLists.txt              (root CMake)
├── vcpkg.json                  (native dependency manifest)
├── .gitignore
├── engine/
│   ├── CMakeLists.txt
│   └── src/
│       └── Main.cpp            (minimal test harness)
├── bridge/
│   └── (empty, placeholder for later)
└── ui/
    └── (empty, placeholder for later)

REQUIREMENTS FOR CMakeLists.txt (root):
- CMake minimum version 3.28
- Project name: Xleth
- C++20 standard required
- Set VCPKG toolchain file from environment variable VCPKG_ROOT
- Add engine/ as subdirectory

REQUIREMENTS FOR engine/CMakeLists.txt:
- Find and link JUCE (use find_package or add_subdirectory — assume JUCE is 
  at C:/JUCE or use FetchContent to download JUCE 8.x from GitHub)
- Create an executable target "XlethEngine" from src/Main.cpp
- Link against these JUCE modules:
  - juce_core
  - juce_audio_basics
  - juce_audio_devices
  - juce_audio_formats
  - juce_audio_utils
  - juce_events
- Define JUCE_STANDALONE_APPLICATION=1
- Enable ASIO support: set JUCE_ASIO=1 and point to ASIO SDK at 
  C:/ASIOSDK (guard with an option so it's not fatal if missing)

REQUIREMENTS FOR vcpkg.json:
- Dependencies: ffmpeg[avcodec,avformat,swscale,avutil]
- Note: We won't use FFmpeg until Prompt 4, but install it now

REQUIREMENTS FOR Main.cpp:
- Minimal JUCE console app that prints "Xleth Engine v0.0.1 — Phase 0" 
  and exits
- Use juce::ScopedJuceInitialiser_GUI for JUCE initialization
- Print available audio devices using juce::AudioDeviceManager

REQUIREMENTS FOR .gitignore:
- Ignore build/, node_modules/, *.obj, *.exe, .vs/, out/, 
  media/ (test assets), *.dnxhr.mov (proxy files)

DO NOT:
- Create any audio engine code yet (that's the next prompt)
- Create any Electron/UI code yet
- Add FFmpeg includes or linking yet (just the vcpkg dependency)
- Use any JUCE modules beyond what's listed

VERIFY: After this prompt, I should be able to run:
  cmake -B build -S xleth -DCMAKE_TOOLCHAIN_FILE=%VCPKG_ROOT%/scripts/buildsystems/vcpkg.cmake
  cmake --build build --config Release
  build/Release/XlethEngine.exe
And see it print "Xleth Engine v0.0.1" and list audio devices.
```

---

## PROMPT 1B — AudioEngine: Sine Wave Output

```
We are building the Xleth audio engine. In this prompt, create the AudioEngine 
class that outputs a 440Hz sine wave through ASIO or WASAPI to prove real-time 
audio output works.

Create these files in engine/src/:
- AudioEngine.h
- AudioEngine.cpp

Modify Main.cpp to use the AudioEngine.

REQUIREMENTS FOR AudioEngine.h/.cpp:

class AudioEngine : public juce::AudioAppComponent {
public:
    AudioEngine();
    ~AudioEngine();
    
    void prepareToPlay(int samplesPerBlockExpected, double sampleRate) override;
    void getNextAudioBlock(const juce::AudioSourceChannelInfo& bufferToFill) override;
    void releaseResources() override;
    
    bool initialize();  // Opens audio device, returns success
    void shutdown();
    
    double getSampleRate() const;
    int getBufferSize() const;
    double getLatencyMs() const;

private:
    double sampleRate_ = 44100.0;
    int bufferSize_ = 256;
    double phase_ = 0.0;        // Sine wave phase accumulator
    double frequency_ = 440.0;  // Test tone frequency
    bool initialized_ = false;
};

INITIALIZATION LOGIC (in initialize()):
1. Create AudioDeviceManager
2. Try to open ASIO first. If no ASIO devices found, fall back to WASAPI 
   exclusive mode. Log which driver was selected.
3. Target buffer size: 256 samples. Accept up to 512.
4. Target sample rate: 44100 Hz. Accept 48000 Hz as fallback.
5. After opening device, log: device name, driver type, actual sample rate, 
   actual buffer size, and calculated latency in ms.

AUDIO THREAD RULES — CRITICAL:
In getNextAudioBlock():
- Fill output buffer with a 440Hz sine wave at amplitude 0.3
- Use phase accumulator pattern (phase_ += frequency_ / sampleRate_)
- NEVER call new, delete, malloc, free
- NEVER use std::cout, printf, or any logging
- NEVER acquire mutex/lock
- NEVER do file I/O
- NEVER call any JUCE function that allocates (e.g., String concatenation)
- ONLY do: math operations, buffer writes, atomic reads/writes

MMCSS PRIORITY BOOST:
In prepareToPlay(), register the audio thread with MMCSS:
- #include <avrt.h> and link avrt.lib
- DWORD taskIndex = 0;
- HANDLE hTask = AvSetMmThreadCharacteristics(L"Pro Audio", &taskIndex);
- Log success/failure (log from prepareToPlay, NOT from getNextAudioBlock)

MAIN.CPP UPDATE:
1. Create AudioEngine instance
2. Call initialize()
3. Log audio device info
4. Play sine wave for 3 seconds (juce::Thread::sleep(3000))
5. Call shutdown()
6. Exit cleanly

DO NOT:
- Create any sample loading code (next prompt)
- Create any Transport class yet
- Create any video-related code
- Use juce::Synthesiser or AudioProcessorGraph — we're writing raw audio
- Create any UI windows — this is a headless/console test

VERIFY: After this prompt, run XlethEngine.exe and confirm:
- [ ] You hear a clean 440Hz tone for 3 seconds
- [ ] Console shows which audio driver was selected (ASIO or WASAPI)
- [ ] Console shows actual buffer size ≤ 512 samples
- [ ] Console shows latency < 15ms
- [ ] No clicks, pops, or audio dropouts
- [ ] Clean exit with no crashes
```

---

## PROMPT 2A — SampleBank: Load WAV Files Into Memory

```
We are adding sample loading to the Xleth engine. Create a SampleBank class 
that loads WAV files into memory so they can be triggered from the audio thread.

Create these files in engine/src/:
- SampleBank.h
- SampleBank.cpp

REQUIREMENTS FOR SampleBank:

class SampleBank {
public:
    // Load a WAV/AIFF file into memory. Returns a unique sample ID (0, 1, 2...).
    // Resamples to the engine's sample rate if needed.
    // Call ONLY from the main thread (not audio thread).
    int loadSample(const juce::File& file, double engineSampleRate);
    
    // Get sample data. Thread-safe: data is immutable after load.
    // Returns nullptr if ID is invalid.
    const juce::AudioBuffer<float>* getSample(int sampleId) const;
    
    // Get number of loaded samples
    int getNumSamples() const;
    
    // Get sample info for logging
    struct SampleInfo {
        juce::String name;
        int numChannels;
        int numSamples;
        double originalSampleRate;
    };
    SampleInfo getSampleInfo(int sampleId) const;

private:
    struct LoadedSample {
        juce::AudioBuffer<float> buffer;
        SampleInfo info;
    };
    std::vector<std::unique_ptr<LoadedSample>> samples_;
};

LOADING LOGIC:
1. Use juce::AudioFormatManager to register basic formats (WAV, AIFF)
2. Create reader from file
3. Read entire file into AudioBuffer<float>
4. If source sample rate != engineSampleRate, resample using 
   juce::LagrangeInterpolator (or simple linear interpolation for Phase 0)
5. Apply a 2ms fade-in and 2ms fade-out to prevent clicks at sample boundaries:
   - Fade-in: linear ramp from 0.0 to 1.0 over first (sampleRate * 0.002) samples
   - Fade-out: linear ramp from 1.0 to 0.0 over last (sampleRate * 0.002) samples
6. Store the buffer — it is NEVER modified after loading
7. Log: sample name, channels, duration in ms, original sample rate

DO NOT:
- Create any triggering mechanism yet (that's Prompt 2B)
- Modify AudioEngine's getNextAudioBlock yet
- Stream from disk — load entire sample into RAM
- Support any format other than WAV and AIFF for now

UPDATE Main.cpp:
1. After initializing AudioEngine, create SampleBank
2. Load 3 test WAV files from a "media/" subdirectory:
   - media/kick.wav
   - media/snare.wav  
   - media/hihat.wav
3. Log each sample's info (name, channels, duration, sample rate)
4. If files don't exist, log a warning and continue (don't crash)

VERIFY:
- [ ] Compiles with no warnings
- [ ] Loads WAV files and logs their info correctly
- [ ] Handles missing files gracefully (warns, doesn't crash)
- [ ] If you have a 48kHz WAV and engine runs at 44.1kHz, it resamples
- [ ] Memory usage is proportional to loaded samples (check with Task Manager)
```

---

## PROMPT 2B — Sample Triggering: Lock-Free Queue + Voice System

```
We are adding real-time sample triggering to Xleth. When the user presses a 
key, the audio thread must immediately start playing the corresponding sample 
with zero glitches.

Create these files in engine/src/:
- TriggerQueue.h       (lock-free SPSC ring buffer)
- VoiceManager.h
- VoiceManager.cpp

Modify: AudioEngine.h/.cpp, Main.cpp

REQUIREMENTS FOR TriggerQueue.h:

This is a single-producer single-consumer (SPSC) lock-free ring buffer.
The GUI/input thread writes trigger events. The audio thread reads them.

struct TriggerEvent {
    int sampleId;       // Which sample to play
    float velocity;     // 0.0–1.0 amplitude scaling
};

class TriggerQueue {
public:
    explicit TriggerQueue(int capacity = 256);
    
    // Called from ANY thread (producer). Returns false if queue full.
    bool push(const TriggerEvent& event);
    
    // Called ONLY from audio thread (consumer). Returns false if queue empty.
    bool pop(TriggerEvent& event);

private:
    std::vector<TriggerEvent> buffer_;
    std::atomic<int> writePos_{0};
    std::atomic<int> readPos_{0};
    int capacity_;
};

IMPLEMENTATION RULES FOR TriggerQueue:
- Use std::atomic with memory_order_acquire/release for the position indices
- NO mutex, NO lock, NO condition variable
- Ring buffer with power-of-2 capacity and masking (capacity must be power of 2)
- push() and pop() must be wait-free (constant time, no loops that depend on 
  the other thread)

REQUIREMENTS FOR VoiceManager:

Manages polyphonic sample playback. Each "voice" is an active playback instance.

struct Voice {
    int sampleId = -1;          // -1 = inactive
    int playbackPosition = 0;   // Current sample position in the buffer
    float velocity = 1.0f;      // Amplitude multiplier
    bool active = false;
};

class VoiceManager {
public:
    explicit VoiceManager(int maxVoices = 32);
    
    // Start playing a sample. Called from audio thread only.
    void triggerSample(int sampleId, float velocity);
    
    // Mix all active voices into the output buffer. Called from audio thread.
    // sampleBank provides the actual audio data.
    void processBlock(juce::AudioBuffer<float>& outputBuffer, 
                      const SampleBank& sampleBank);
    
    int getActiveVoiceCount() const;

private:
    std::vector<Voice> voices_;
    int maxVoices_;
};

VOICE LOGIC:
- triggerSample() finds an inactive voice (active == false) and activates it
- If all voices are active, steal the OLDEST voice (lowest remaining samples)
- processBlock() iterates all active voices, reads sample data from SampleBank, 
  adds (+=) to the output buffer (mixing), advances playback position
- When a voice reaches the end of its sample, set active = false
- Handle mono samples: copy to both channels
- Handle stereo samples: copy L to L, R to R
- Apply velocity as amplitude multiplier
- ALL of this runs on the audio thread — no allocation, no locking

MODIFY AudioEngine:
1. AudioEngine now owns a TriggerQueue and a VoiceManager
2. AudioEngine gets a pointer/reference to SampleBank (set after loading)
3. In getNextAudioBlock():
   a. Clear the output buffer first (fill with zeros)
   b. Drain all pending events from TriggerQueue → call voiceManager.triggerSample()
   c. Call voiceManager.processBlock() to mix active voices into output
   d. (Remove the old sine wave code)
4. Add a public method: void queueTrigger(int sampleId, float velocity = 1.0f)
   that pushes to the TriggerQueue (callable from any thread)

MODIFY Main.cpp:
1. After loading samples, set up keyboard input using juce::KeyPress listening
   OR use a simple std::thread that reads console input:
   - 'z' or 'Z' → trigger sample 0 (kick)
   - 'x' or 'X' → trigger sample 1 (snare)
   - 'c' or 'C' → trigger sample 2 (hihat)
   - 'q' or 'Q' → quit
2. Use a simple input loop on a separate thread:
   while (running) {
       int ch = _getch(); // Windows conio.h
       // map to sample triggers
   }
3. Keep the engine running until user presses 'q'

DO NOT:
- Use juce::Synthesiser or juce::SamplerVoice — we're rolling our own
- Add any pitch shifting or time stretching
- Add any effects processing
- Create any MIDI input handling yet
- Use std::mutex anywhere in the audio path

VERIFY:
- [ ] Press Z → hear kick immediately (< 10ms perceived latency)
- [ ] Press X → hear snare
- [ ] Press C → hear hihat
- [ ] Press Z+X together → hear both mixed cleanly
- [ ] Rapidly mash Z 20 times fast → every hit plays, no audio glitches
- [ ] Voice count prints correctly (or log active voices periodically)
- [ ] No clicks or pops at sample start/end (fade-in/out from Prompt 2A working)
- [ ] Clean exit when pressing Q
```

---

## PROMPT 3 — Transport: Master Clock

```
We are building the Transport system — the master clock that synchronizes 
everything in Xleth. The audio callback advances the clock, and every other 
system reads it atomically.

Create these files in engine/src/:
- Transport.h
- Transport.cpp

Modify: AudioEngine.h/.cpp, Main.cpp

REQUIREMENTS FOR Transport:

class Transport {
public:
    Transport();
    
    void setSampleRate(double sr);
    void setBPM(double bpm);
    
    void play();
    void stop();     // Stops and resets position to 0
    void pause();    // Stops but keeps position
    
    // Called ONLY from the audio thread at the end of each buffer
    void advance(int numSamples);
    
    // Thread-safe reads (atomic) — callable from ANY thread
    int64_t getPositionSamples() const;
    double getPositionSeconds() const;
    double getPositionBeats() const;  // Beat number (e.g., 4.5 = beat 4, halfway to beat 5)
    int getPositionBars() const;      // Bar number (4/4 time assumed)
    bool isPlaying() const;
    double getBPM() const;
    double getSampleRate() const;

    // Seek
    void seekToSample(int64_t sample);
    void seekToBeat(double beat);
    void seekToBar(int bar);

private:
    std::atomic<int64_t> positionSamples_{0};
    std::atomic<bool> playing_{false};
    std::atomic<double> bpm_{140.0};
    double sampleRate_ = 44100.0;
    
    // Helper: convert between time representations
    double samplesToSeconds(int64_t samples) const;
    double samplesToBeats(int64_t samples) const;
    int64_t beatsToSamples(double beats) const;
};

KEY RULES:
- advance() ONLY increments positionSamples_ when playing_ is true
- advance() uses relaxed or release memory ordering for the store
- All getPosition*() methods use acquire memory ordering for the load
- BPM is fixed at 140 for Phase 0 but stored as atomic for future use
- Time signature is assumed 4/4 (hardcoded, not configurable yet)
- Beat calculation: beats = positionSamples / (sampleRate * 60.0 / bpm)
- Bar calculation: bars = floor(beats / 4) + 1 (1-indexed)

MODIFY AudioEngine:
1. AudioEngine owns a Transport instance
2. In prepareToPlay(): call transport.setSampleRate(sampleRate)
3. At the END of getNextAudioBlock() (after all audio processing):
   call transport.advance(bufferToFill.numSamples)
4. Expose transport via public getter: Transport& getTransport()

MODIFY Main.cpp:
1. Add transport controls to the keyboard input loop:
   - SPACE → toggle play/pause
   - 'r' or 'R' → stop (reset to start)
2. Add a monitoring thread that prints transport state every 500ms while playing:
   "Position: [MM:SS.mmm] | Beat: [X.XX] | Bar: [X] | BPM: 140"
3. Sample triggers from Z/X/C should still work while transport is running

DO NOT:
- Implement tempo automation or tempo changes
- Implement time signature changes
- Create a timeline or event scheduler yet (that comes later)
- Make advance() do anything other than increment the counter
- Use std::mutex in Transport

VERIFY:
- [ ] Press SPACE → "Playing" logged. Press SPACE again → "Paused" logged.
- [ ] While playing, position monitor shows time advancing smoothly
- [ ] After 10 seconds of playback, reported time matches wall-clock within 5ms
- [ ] Press R → position resets to 00:00.000, Beat 0, Bar 1
- [ ] Sample triggers (Z/X/C) work while transport is both playing and stopped
- [ ] Beat counter advances correctly: at 140 BPM, beat 1.0 = ~0.429 seconds
- [ ] Bar counter increments every 4 beats
```

---

## PROMPT 4A — FFmpeg Integration: Video Decoder

```
We are adding video decoding to Xleth using FFmpeg. This prompt creates the 
VideoDecoder class that opens video files and decodes individual frames.

Create these files in engine/src/:
- VideoDecoder.h
- VideoDecoder.cpp

IMPORTANT: Make sure FFmpeg is linked in engine/CMakeLists.txt. 
Use find_package or vcpkg integration to find:
- libavformat
- libavcodec
- libswscale
- libavutil

Wrap all FFmpeg includes in extern "C" {} because FFmpeg is a C library.

REQUIREMENTS FOR VideoDecoder:

class VideoDecoder {
public:
    VideoDecoder();
    ~VideoDecoder();
    
    // Open a video file. Returns true on success.
    bool open(const std::string& filePath);
    void close();
    bool isOpen() const;
    
    // Seek to a specific time and decode that frame.
    // Returns true if a frame was decoded successfully.
    // Decoded pixels go into outFrame.
    bool seekAndDecode(double timeSeconds, DecodedFrame& outFrame);
    
    // Decode the next sequential frame (for benchmarking / sequential reads).
    bool decodeNext(DecodedFrame& outFrame);
    
    // Video info
    int getWidth() const;
    int getHeight() const;
    double getFPS() const;
    double getDuration() const;
    int getTotalFrames() const;
    
    // Convert timestamp to frame number and back
    int timeToFrame(double seconds) const;
    double frameToTime(int frameNumber) const;

    struct DecodedFrame {
        std::vector<uint8_t> yPlane;
        std::vector<uint8_t> uPlane;
        std::vector<uint8_t> vPlane;
        int yStride, uStride, vStride;
        int width, height;
        int frameNumber;
    };

private:
    AVFormatContext* formatCtx_ = nullptr;
    AVCodecContext* codecCtx_ = nullptr;
    AVFrame* frame_ = nullptr;
    AVFrame* yuvFrame_ = nullptr;   // For conversion if source isn't YUV420
    AVPacket* packet_ = nullptr;
    SwsContext* swsCtx_ = nullptr;  // For pixel format conversion
    int videoStreamIdx_ = -1;
    
    double fps_ = 30.0;
    double duration_ = 0.0;
    int width_ = 0, height_ = 0;
    
    // Internal: decode frames until we get one at or past the target PTS
    bool decodeUntilFrame(int64_t targetPTS, DecodedFrame& outFrame);
    void copyFrameToOutput(AVFrame* src, DecodedFrame& outFrame);
};

OPEN LOGIC:
1. avformat_open_input() to open the file
2. avformat_find_stream_info() to read stream headers
3. Find the best video stream (av_find_best_stream)
4. Get the codec, create decoder context, open it
5. Store width, height, fps (from stream r_frame_rate), duration
6. If pixel format is not AV_PIX_FMT_YUV420P, create SwsContext for conversion
7. Allocate frame_ and packet_
8. Log: filename, resolution, fps, duration, codec name, pixel format

SEEK LOGIC (seekAndDecode):
1. Convert timeSeconds to PTS in stream timebase
2. av_seek_frame() with AVSEEK_FLAG_BACKWARD to seek to nearest keyframe before target
3. avcodec_flush_buffers() to clear decoder state after seek
4. Decode frames forward until we reach the target PTS (or closest frame)
5. Copy decoded YUV420 data into outFrame vectors

DO NOT:
- Add hardware-accelerated decoding yet (D3D11VA comes later)
- Add any caching (that's the next prompt)
- Add any OpenGL / display code
- Add any proxy transcoding yet (that's Prompt 4B)
- Modify AudioEngine or Transport

UPDATE Main.cpp:
Add a video decode test mode (triggered by command-line flag or menu option):
1. Open media/source_clip.mp4
2. Log video info (resolution, fps, duration, codec)
3. Seek to 5 random timestamps, decode each, log decode time in milliseconds
4. Decode 30 sequential frames, log average decode time
5. Print benchmark results

VERIFY:
- [ ] Compiles and links against FFmpeg without errors
- [ ] Opens an H.264 MP4 file and logs correct video info
- [ ] seekAndDecode() returns a valid frame with correct dimensions
- [ ] Sequential decode averages < 5ms per frame
- [ ] Seek decode time logged (will be slower — 10-80ms for H.264, this is expected)
- [ ] No memory leaks (frame data properly allocated in vectors)
- [ ] Handles missing/invalid files gracefully (returns false, doesn't crash)
```

---

## PROMPT 4B — Proxy Transcoding + Benchmark

```
We are adding proxy transcoding to Xleth. When a video is imported, we 
transcode it to DNxHR LB (all-intraframe codec) so that seeking to any 
frame is nearly instant. This is THE critical optimization for Sparta Remixes.

Create these files in engine/src/:
- ProxyTranscoder.h
- ProxyTranscoder.cpp

Modify: Main.cpp (add transcoding benchmark)

REQUIREMENTS FOR ProxyTranscoder:

class ProxyTranscoder {
public:
    // Transcode source video to DNxHR LB proxy.
    // Input:  source.mp4 (any codec)
    // Output: source.dnxhr.mov (DNxHR LB, all-intraframe)
    // Returns: path to proxy file on success, empty string on failure.
    // This is a BLOCKING call — runs FFmpeg as a subprocess.
    // progressCallback receives 0.0–1.0 progress updates.
    static std::string transcode(
        const std::string& inputPath,
        const std::string& outputDir,
        std::function<void(float progress)> progressCallback = nullptr
    );
    
    // Check if a proxy already exists for a source file
    static bool proxyExists(const std::string& sourcePath, const std::string& outputDir);
    
    // Get the expected proxy path for a source file
    static std::string getProxyPath(const std::string& sourcePath, const std::string& outputDir);

private:
    // Build the FFmpeg command line
    static std::string buildCommand(const std::string& input, const std::string& output);
};

TRANSCODE IMPLEMENTATION:
1. Generate output filename: take input filename, replace extension with .dnxhr.mov
   Example: "source_clip.mp4" → "source_clip.dnxhr.mov"
2. Build FFmpeg command:
   ffmpeg -y -i "{input}" -c:v dnxhd -profile:v dnxhr_lb -pix_fmt yuv422p -an "{output}"
   Notes:
   - -y overwrites without asking
   - -an strips audio (we handle audio separately)
   - dnxhr_lb = Low Bandwidth profile (~22 Mbps at 1080p)
   - yuv422p is required for DNxHR
3. Execute via CreateProcess() on Windows (NOT system() — we need to capture output)
4. Parse FFmpeg's stderr output for progress (look for "time=" timestamps)
5. Call progressCallback with 0.0–1.0 based on parsed time vs source duration
6. Return output path on success, empty string on failure
7. Log: input file, output file, file sizes, compression ratio, transcode time

PROXY EXISTENCE CHECK:
- Check if proxy file exists AND is newer than the source file
- If source was modified after proxy was created, return false (needs re-transcode)

BENCHMARK IN Main.cpp:
Add a comprehensive benchmark that proves proxy transcoding works:

1. Open media/source_clip.mp4 with VideoDecoder
2. Generate 100 random seek timestamps distributed across the clip duration
3. Benchmark H.264 seeking:
   - For each of the 100 timestamps, call seekAndDecode() and measure time
   - Log: min, max, average, median seek time
4. Transcode to DNxHR proxy (show progress)
5. Open the proxy file with a second VideoDecoder
6. Benchmark DNxHR seeking:
   - Same 100 timestamps, same measurement
   - Log: min, max, average, median seek time
7. Print comparison:
   ┌─────────────────────────────────────────┐
   │ PROXY TRANSCODE BENCHMARK               │
   ├─────────────────────┬─────────┬─────────┤
   │                     │  H.264  │  DNxHR  │
   ├─────────────────────┼─────────┼─────────┤
   │ Avg seek time       │  XXms   │  XXms   │
   │ Max seek time       │  XXms   │  XXms   │
   │ Min seek time       │  XXms   │  XXms   │
   │ Speedup factor      │   1.0x  │  XX.Xx  │
   ├─────────────────────┼─────────┼─────────┤
   │ Source file size     │         XX.X MB   │
   │ Proxy file size      │         XX.X MB   │
   │ Transcode time       │         XX.Xs     │
   └─────────────────────┴─────────┴─────────┘

   Expected results:
   - H.264 avg seek: 20–80ms
   - DNxHR avg seek: 0.5–3ms
   - Speedup: 10x–100x

DO NOT:
- Add hardware-accelerated transcoding (CPU is fine for now)
- Transcode audio (we strip it with -an)
- Add any caching, OpenGL, or display code
- Modify AudioEngine or Transport

VERIFY:
- [ ] FFmpeg subprocess runs and produces a .dnxhr.mov file
- [ ] Proxy file is playable (open with VLC or another player to confirm)
- [ ] DNxHR seek time is at least 10x faster than H.264
- [ ] Progress callback reports reasonable 0.0–1.0 values
- [ ] proxyExists() returns true after transcoding, false before
- [ ] Benchmark results match expected ranges
- [ ] No zombie processes (FFmpeg subprocess exits cleanly)
```

---

## PROMPT 5 — Frame Cache: LRU RAM Cache

```
We are building the LRU frame cache for Xleth. This cache stores decoded 
video frames in RAM so that when the same source frame is referenced by 
multiple timeline events, we only decode it once.

Create these files in engine/src/:
- FrameCache.h
- FrameCache.cpp

Modify: Main.cpp (add cache simulation benchmark)

REQUIREMENTS FOR FrameCache:

struct FrameKey {
    int sourceId;
    int frameNumber;
    
    bool operator==(const FrameKey& other) const {
        return sourceId == other.sourceId && frameNumber == other.frameNumber;
    }
};

// Hash function for FrameKey (needed for unordered_map)
struct FrameKeyHash {
    size_t operator()(const FrameKey& k) const {
        return std::hash<int>()(k.sourceId) ^ (std::hash<int>()(k.frameNumber) << 16);
    }
};

struct CachedFrame {
    std::vector<uint8_t> yPlane;
    std::vector<uint8_t> uPlane;
    std::vector<uint8_t> vPlane;
    int width, height;
    int yStride, uStride, vStride;
    
    size_t sizeBytes() const {
        return yPlane.size() + uPlane.size() + vPlane.size();
    }
};

class FrameCache {
public:
    // maxBytes: maximum RAM budget (default 2GB)
    explicit FrameCache(size_t maxBytes = 2ULL * 1024 * 1024 * 1024);
    
    // Look up a frame. Returns pointer to cached data, or nullptr if not found.
    // Moves the frame to "most recently used" on hit.
    // Thread-safety: protected by mutex (acceptable for Phase 0).
    const CachedFrame* get(const FrameKey& key);
    
    // Insert a frame into the cache. If over budget, evicts LRU entries.
    // Takes ownership of the frame data via move semantics.
    void put(const FrameKey& key, CachedFrame&& frame);
    
    // Clear the entire cache
    void clear();
    
    // Stats
    size_t hitCount() const { return hits_; }
    size_t missCount() const { return misses_; }
    double hitRate() const;
    size_t currentBytes() const { return currentBytes_; }
    size_t maxBytes() const { return maxBytes_; }
    size_t entryCount() const;

private:
    size_t maxBytes_;
    size_t currentBytes_ = 0;
    size_t hits_ = 0;
    size_t misses_ = 0;
    
    // Classic LRU: unordered_map for O(1) lookup + list for O(1) eviction
    // List stores entries in order (front = most recent, back = least recent)
    using EntryList = std::list<std::pair<FrameKey, CachedFrame>>;
    EntryList entries_;
    std::unordered_map<FrameKey, EntryList::iterator, FrameKeyHash> lookup_;
    
    std::mutex mutex_;  // Phase 0: simple mutex. Upgrade to lock-free later.
    
    void evictLRU();
};

LRU LOGIC:
- get(): If found in lookup_, move the entry to the front of the list 
  (splice to begin), increment hits_, return pointer. If not found, 
  increment misses_, return nullptr.
- put(): If key already exists, update it and move to front. 
  If new, push to front. Then evict from back until currentBytes_ <= maxBytes_.
- evictLRU(): Remove entries from the back of the list until under budget.
  Update currentBytes_ and remove from lookup_.
- Thread safety: lock mutex_ at the start of get() and put(). Use 
  std::lock_guard. This is acceptable for Phase 0 — the video thread 
  is the only high-frequency caller, and it's not real-time critical 
  like the audio thread.

BENCHMARK IN Main.cpp — SPARTA REMIX SIMULATION:
Simulate a Sparta Remix timeline to test cache effectiveness:

1. Set up: 3 source videos, each 5 minutes at 30fps = 9000 frames per source
2. Generate a simulated timeline with 500 clip events:
   - Each event has: sourceId (0-2), startFrame (random within source), 
     duration (50-300ms = 2-9 frames)
   - Sort events by timeline position
   - This simulates a typical Sparta Remix: hundreds of short cuts from 
     a few source videos
3. "Play through" the timeline:
   - For each event, for each frame in the event:
     a. Try cache.get(sourceId, frameNumber)
     b. If miss: create a dummy CachedFrame with correct size 
        (1920*1080*1.5 bytes for YUV420), call cache.put()
     c. Track: total frames requested, cache hits, cache misses
4. Log results:
   ┌────────────────────────────────┐
   │ FRAME CACHE SIMULATION         │
   ├────────────────────────────────┤
   │ Total frames requested: XXXX   │
   │ Cache hits:             XXXX   │
   │ Cache misses:           XXXX   │
   │ Hit rate:               XX.X%  │
   │ Cache size:             XXXX MB│
   │ Entries in cache:       XXXX   │
   └────────────────────────────────┘
5. Run the same timeline AGAIN (second pass) and log hit rate 
   (should be much higher — 90%+ if cache is large enough)

DO NOT:
- Make the cache lock-free yet (mutex is fine for Phase 0)
- Add prefetching/lookahead (that's a later optimization)
- Integrate with VideoDecoder yet (this prompt tests cache in isolation)
- Add any OpenGL or display code

VERIFY:
- [ ] First-pass cache hit rate increases as timeline repeats patterns
- [ ] Second-pass cache hit rate > 90% (most frames already cached)
- [ ] Memory stays within budget (2GB default)
- [ ] LRU eviction works: when cache is full, oldest frames are evicted
- [ ] Cache correctly handles multiple source IDs
- [ ] get() returns nullptr for frames never inserted
- [ ] No crashes under stress (500+ events, thousands of frame requests)
```

---

## PROMPT 6A — OpenGL Context + Texture Upload

```
We are adding GPU-accelerated video display to Xleth. This prompt sets up the 
OpenGL context and implements texture upload from decoded YUV frames using 
Pixel Buffer Objects (PBOs) for async double-buffered upload.

FIRST: Add OpenGL as a dependency in engine/CMakeLists.txt.
On Windows, link against opengl32.lib. 
Use GLAD or GLEW for OpenGL function loading (add via vcpkg or bundled).
Also add GLFW for window creation: vcpkg install glfw3:x64-windows

Create these files in engine/src/:
- VideoCompositor.h
- VideoCompositor.cpp

REQUIREMENTS FOR VideoCompositor:

class VideoCompositor {
public:
    VideoCompositor();
    ~VideoCompositor();
    
    // Create OpenGL context and window. Call once at startup.
    bool initialize(int windowWidth, int windowHeight, const std::string& title);
    void shutdown();
    
    // Upload a decoded YUV420 frame to GPU textures.
    // Uses PBO double-buffering for async upload.
    void uploadFrame(const uint8_t* yPlane, const uint8_t* uPlane, const uint8_t* vPlane,
                     int width, int height,
                     int yStride, int uStride, int vStride);
    
    // Render the current frame texture to the window.
    void render();
    
    // Check if window should close
    bool shouldClose() const;
    
    // Poll window events (must call every frame)
    void pollEvents();
    
    // Performance stats
    double getLastUploadTimeMs() const;
    double getLastRenderTimeMs() const;

private:
    GLFWwindow* window_ = nullptr;
    
    // Three textures for Y, U, V planes
    GLuint yTexture_ = 0;
    GLuint uTexture_ = 0;
    GLuint vTexture_ = 0;
    
    // PBO double-buffer for async upload
    GLuint pbo_[2] = {0, 0};
    int currentPBO_ = 0;
    
    // Shader program for YUV→RGB conversion
    GLuint shaderProgram_ = 0;
    
    // Fullscreen quad VAO/VBO
    GLuint vao_ = 0;
    GLuint vbo_ = 0;
    
    int frameWidth_ = 0;
    int frameHeight_ = 0;
    bool hasFrame_ = false;
    
    double lastUploadMs_ = 0.0;
    double lastRenderMs_ = 0.0;
    
    bool createShaders();
    bool createQuad();
    bool createTextures(int width, int height);
    bool createPBOs(int width, int height);
};

VERTEX SHADER:
#version 330 core
layout (location = 0) in vec2 aPos;
layout (location = 1) in vec2 aTexCoord;
out vec2 TexCoord;
void main() {
    gl_Position = vec4(aPos, 0.0, 1.0);
    TexCoord = aTexCoord;
}

FRAGMENT SHADER (YUV BT.709 → RGB):
#version 330 core
in vec2 TexCoord;
out vec4 FragColor;
uniform sampler2D yTex;
uniform sampler2D uTex;
uniform sampler2D vTex;
void main() {
    float y = texture(yTex, TexCoord).r;
    float u = texture(uTex, TexCoord).r - 0.5;
    float v = texture(vTex, TexCoord).r - 0.5;
    float r = y + 1.5748 * v;
    float g = y - 0.1873 * u - 0.4681 * v;
    float b = y + 1.8556 * u;
    FragColor = vec4(clamp(r, 0.0, 1.0), clamp(g, 0.0, 1.0), clamp(b, 0.0, 1.0), 1.0);
}

PBO DOUBLE-BUFFER UPLOAD STRATEGY:
1. On uploadFrame():
   a. Bind PBO[currentPBO_]
   b. Map buffer (GL_WRITE_ONLY)
   c. Copy Y plane data into mapped buffer
   d. Unmap buffer
   e. Bind Y texture, call glTexSubImage2D with PBO as source (async DMA)
   f. Repeat for U and V planes (can share PBOs or use separate ones —
      simplest: upload Y/U/V sequentially with one PBO pair, OR create 
      6 PBOs total for full async. Start with sequential for simplicity.)
   g. Swap currentPBO_ (0 → 1 → 0 → 1...)
2. On render():
   a. Clear to black
   b. Use shader program
   c. Bind Y/U/V textures to texture units 0/1/2
   d. Set uniform samplers
   e. Draw fullscreen quad (VAO)
   f. glfwSwapBuffers

FULLSCREEN QUAD:
Vertices: position (x,y) + texcoord (u,v)
(-1,-1, 0,1), (1,-1, 1,1), (1,1, 1,0), (-1,1, 0,0)
Two triangles: (0,1,2) and (0,2,3) — or use a triangle strip.
Note: OpenGL Y is flipped from video Y — texcoord (0,1) at bottom-left 
maps to video top-left. Flip the V texcoord if image appears upside-down.

UPDATE Main.cpp:
Add a video display test mode:
1. Open a video file with VideoDecoder
2. Create VideoCompositor window (1280x720)
3. Loop: decode next frame → upload → render → poll events
4. Target 30fps (sleep for remaining time in each frame)
5. Log upload time and render time per frame
6. Close when window is closed or after playing through the clip

DO NOT:
- Add multi-layer compositing yet (just one full-screen frame for now)
- Add any audio integration in this prompt
- Integrate with FrameCache yet
- Add any resize/transform logic
- Use compute shaders or Vulkan

VERIFY:
- [ ] A window appears showing the video playing back
- [ ] Colors are correct (compare visually with VLC playing the same file)
- [ ] No visible tearing
- [ ] Upload + render < 5ms per frame at 1080p (check logged times)
- [ ] Window closes cleanly
- [ ] No OpenGL errors logged (check glGetError after major operations)
```

---

## PROMPT 6B — VideoCompositor: Multi-Layer Support

```
We are extending VideoCompositor to support multiple video layers that 
composite on top of each other. This is essential for Sparta Remixes where 
multiple video clips are visible simultaneously in a grid layout.

Modify: VideoCompositor.h/.cpp

ADD TO VideoCompositor:

struct VideoLayer {
    int sourceTextureSet;   // Index into texture array
    float x, y;             // Position in normalized coordinates (-1 to 1)
    float width, height;    // Size in normalized coordinates
    float opacity;          // 0.0–1.0
    int zOrder;             // Higher = drawn later (on top)
    bool visible;
};

class VideoCompositor {
    // ... (keep everything from Prompt 6A, add the following)
public:
    // Register a new texture set for a source. Returns sourceTextureSet ID.
    int createTextureSet(int width, int height);
    
    // Upload a frame to a specific texture set
    void uploadFrameToSet(int textureSetId,
                          const uint8_t* yPlane, const uint8_t* uPlane, const uint8_t* vPlane,
                          int width, int height,
                          int yStride, int uStride, int vStride);
    
    // Set layer properties
    void setLayer(int layerIndex, const VideoLayer& layer);
    
    // Set number of active layers
    void setLayerCount(int count);
    
    // Render all visible layers composited together
    void renderComposite();

private:
    // Multiple texture sets (one per source video)
    struct TextureSet {
        GLuint yTex = 0, uTex = 0, vTex = 0;
        int width = 0, height = 0;
        bool hasData = false;
    };
    std::vector<TextureSet> textureSets_;
    
    // Active layers
    std::vector<VideoLayer> layers_;
    int activeLayerCount_ = 0;
    
    // Updated shader with position/scale/opacity uniforms
    GLuint compositeShaderProgram_ = 0;
    bool createCompositeShader();
};

COMPOSITE FRAGMENT SHADER:
#version 330 core
in vec2 TexCoord;
out vec4 FragColor;
uniform sampler2D yTex;
uniform sampler2D uTex;
uniform sampler2D vTex;
uniform float uOpacity;
void main() {
    float y = texture(yTex, TexCoord).r;
    float u = texture(uTex, TexCoord).r - 0.5;
    float v = texture(vTex, TexCoord).r - 0.5;
    float r = clamp(y + 1.5748 * v, 0.0, 1.0);
    float g = clamp(y - 0.1873 * u - 0.4681 * v, 0.0, 1.0);
    float b = clamp(y + 1.8556 * u, 0.0, 1.0);
    FragColor = vec4(r, g, b, uOpacity);
}

COMPOSITE VERTEX SHADER:
#version 330 core
layout (location = 0) in vec2 aPos;
layout (location = 1) in vec2 aTexCoord;
out vec2 TexCoord;
uniform vec2 uPosition;  // Center position (-1 to 1)
uniform vec2 uScale;     // Size (0 to 1 = fraction of screen)
void main() {
    vec2 pos = aPos * uScale + uPosition;
    gl_Position = vec4(pos, 0.0, 1.0);
    TexCoord = aTexCoord;
}

RENDER COMPOSITE LOGIC:
1. Enable alpha blending: glEnable(GL_BLEND); glBlendFunc(GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA);
2. Clear to black
3. Sort layers by zOrder (ascending — lowest drawn first)
4. For each visible layer:
   a. Bind the layer's texture set (Y/U/V textures)
   b. Set uniforms: uPosition, uScale, uOpacity
   c. Draw the fullscreen quad (scaled by uniforms)
5. Swap buffers

UPDATE Main.cpp:
Add a multi-layer test mode:
1. Open 2 different video files (or the same file at different seek positions)
2. Create 4 layers arranged in a 2x2 grid:
   - Layer 0: top-left, source 0, frame from 0:00
   - Layer 1: top-right, source 1, frame from 0:05
   - Layer 2: bottom-left, source 0, frame from 0:10
   - Layer 3: bottom-right, source 1, frame from 0:15
3. All layers at opacity 1.0
4. Display for 5 seconds, then add a 5th layer as a semi-transparent 
   overlay (opacity 0.5) covering the full screen
5. Log composite render time

DO NOT:
- Add any timeline integration
- Add transitions or effects
- Add the Sparta grid layout system (that's a Phase 2 feature)
- Modify audio engine or transport

VERIFY:
- [ ] 4 video frames displayed simultaneously in a 2x2 grid
- [ ] Each quadrant shows the correct frame from the correct source
- [ ] Overlay layer (opacity 0.5) correctly blends over the grid
- [ ] Colors still correct on all layers
- [ ] Composite render < 8ms for 5 layers at 1080p
- [ ] No visual artifacts at layer boundaries
```

---

## PROMPT 7A — SyncManager: Wire Audio Clock to Video

```
We are building the SyncManager — the component that reads the audio engine's 
transport clock and tells the video compositor which frames to display. This 
is THE critical integration that makes Xleth work.

Create these files in engine/src/:
- SyncManager.h
- SyncManager.cpp

REQUIREMENTS FOR SyncManager:

// Represents a scheduled video event on the timeline
struct VideoEvent {
    double startBeat;       // When this event starts (in beats)
    double durationBeats;   // How long it lasts
    int sourceId;           // Which video source
    double sourceStartTime; // Where in the source video to start (seconds)
    int layerIndex;         // Which compositor layer to use
    
    // Layout properties
    float x, y;             // Position on screen (-1 to 1)
    float width, height;    // Size on screen
    float opacity;          // Transparency
};

class SyncManager {
public:
    SyncManager(Transport& transport, 
                std::vector<VideoDecoder*>& decoders,
                FrameCache& cache, 
                VideoCompositor& compositor);
    
    // Add video events to the timeline
    void addEvent(const VideoEvent& event);
    void clearEvents();
    
    // Called on a dedicated video thread at ~60Hz.
    // Reads transport position → determines which events are active →
    // fetches/decodes frames → uploads to compositor → renders.
    void videoTick();
    
    // Performance stats
    double getLastDriftMs() const;
    double getMaxDriftMs() const;
    double getAvgDriftMs() const;
    double getAvgDecodeTimeMs() const;
    int getFrameDropCount() const;
    double getCacheHitRate() const;

private:
    Transport& transport_;
    std::vector<VideoDecoder*>& decoders_;
    FrameCache& cache_;
    VideoCompositor& compositor_;
    
    std::vector<VideoEvent> events_;
    
    // Drift tracking
    std::vector<double> driftSamples_;
    double maxDrift_ = 0.0;
    int frameDrops_ = 0;
    
    // Frame dedup: don't re-upload if same frame
    std::unordered_map<int, int> lastDisplayedFrame_; // layerIndex → frameNumber
};

videoTick() ALGORITHM — THIS IS THE CORE LOGIC:

1. If transport is not playing, render current state and return early

2. Read audio position atomically:
   double audioTimeSec = transport_.getPositionSeconds();
   double audioTimeBeat = transport_.getPositionBeats();

3. Determine which VideoEvents are currently active:
   For each event in events_:
     if (audioTimeBeat >= event.startBeat && 
         audioTimeBeat < event.startBeat + event.durationBeats)
       → this event is ACTIVE

4. For each active event:
   a. Calculate source video time:
      double eventProgress = (audioTimeBeat - event.startBeat) / event.durationBeats;
      NOT USED FOR TIME — instead:
      double beatsSinceStart = audioTimeBeat - event.startBeat;
      double secsSinceStart = beatsSinceStart * (60.0 / transport_.getBPM());
      double sourceTime = event.sourceStartTime + secsSinceStart;
   
   b. Convert sourceTime to frame number:
      int targetFrame = decoder->timeToFrame(sourceTime);
   
   c. Check if this frame was already displayed on this layer:
      if (lastDisplayedFrame_[event.layerIndex] == targetFrame) → skip upload
   
   d. Try frame cache:
      FrameKey key = {event.sourceId, targetFrame};
      const CachedFrame* cached = cache_.get(key);
   
   e. If cache miss:
      - Start timer
      - Call decoder->seekAndDecode(sourceTime, decodedFrame)
      - Create CachedFrame from decoded data
      - Insert into cache: cache_.put(key, std::move(cachedFrame))
      - End timer. If > 16ms → log as frame drop, skip this frame
   
   f. Upload frame to compositor:
      compositor_.uploadFrameToSet(event.sourceId, yPlane, uPlane, vPlane, ...)
   
   g. Set layer properties:
      VideoLayer layer = {event.sourceId, event.x, event.y, 
                          event.width, event.height, event.opacity, 
                          event.layerIndex, true};
      compositor_.setLayer(event.layerIndex, layer);
   
   h. Update lastDisplayedFrame_

5. Set any non-active layers to visible = false

6. Call compositor_.renderComposite()

7. Measure drift:
   double renderTimeSec = transport_.getPositionSeconds();
   double driftMs = (renderTimeSec - audioTimeSec) * 1000.0;
   Record drift for stats

THREAD ARCHITECTURE:
- The videoTick() method runs on its OWN thread, separate from both 
  the audio thread and the GUI thread
- It should target ~60 ticks per second (use sleep to pace itself)
- It must NEVER touch the audio thread's data except through Transport's 
  atomic reads
- The audio thread must NEVER wait on the video thread

DO NOT:
- Modify the audio engine's getNextAudioBlock in any way
- Add any UI/Electron integration yet
- Add prefetching or lookahead (keep it simple — fetch on demand + cache)
- Make the video thread block the audio thread under any circumstance

MODIFY Main.cpp:
Create a combined A/V sync test:
1. Load audio samples (kick, snare, hihat)
2. Open a video source + proxy transcode it
3. Create hardcoded timeline events:
   At 140 BPM (4/4 time), for 8 bars (32 beats):
   
   VIDEO EVENTS (one per beat, alternating sources/positions):
   - Beat 1: source 0, frame 0:00, full screen
   - Beat 2: source 0, frame 0:02, top-left quadrant
   - Beat 3: source 0, frame 0:04, top-right quadrant
   - Beat 4: source 0, frame 0:06, full screen
   (repeat pattern for 8 bars)
   
   AUDIO TRIGGERS (queued when transport reaches each beat):
   - Every beat 1: trigger kick
   - Every beat 2: trigger hihat  
   - Every beat 3: trigger snare
   - Every beat 4: trigger hihat

4. Set up:
   - Audio engine running with transport
   - SyncManager on its own thread calling videoTick() at 60Hz
   - A "scheduler" thread that watches transport position and queues 
     sample triggers at the right beats
5. Press SPACE to start playback
6. After 8 bars, stop and print sync report:
   ┌────────────────────────────────────┐
   │ A/V SYNC REPORT                    │
   ├────────────────────────────────────┤
   │ Duration:        XX.X seconds      │
   │ Avg drift:       XX.X ms           │
   │ Max drift:       XX.X ms           │
   │ Frame drops:     XX                │
   │ Cache hit rate:  XX.X%             │
   │ Audio glitches:  XX                │
   │ RESULT: [PASS/FAIL]               │
   └────────────────────────────────────┘
   
   PASS criteria:
   - Avg drift < 15ms
   - Max drift < 33ms (1 frame at 30fps)
   - Audio glitches = 0
   - Frame drops < 2%

VERIFY:
- [ ] Video window shows frames changing in sync with audio playback
- [ ] When kick hits, the video frame changes AT THE SAME PERCEIVED MOMENT
- [ ] Avg drift < 15ms in the sync report
- [ ] Max drift < 33ms
- [ ] Zero audio glitches
- [ ] Cache hit rate reported and > 80%
- [ ] Clean shutdown (no hanging threads, no zombie windows)
```

---

## PROMPT 7B — Audio Scheduler: Timeline-Driven Sample Triggers

```
We need to clean up the audio triggering so samples fire from the timeline 
at exact beat positions, not just from keyboard input. This gives us proper 
timeline-driven playback.

Create these files in engine/src/:
- AudioScheduler.h
- AudioScheduler.cpp

REQUIREMENTS FOR AudioScheduler:

// A scheduled audio event on the timeline
struct AudioEvent {
    double beatPosition;    // When to trigger (in beats)
    int sampleId;           // Which sample to play
    float velocity;         // 0.0–1.0
};

class AudioScheduler {
public:
    AudioScheduler(Transport& transport, AudioEngine& engine);
    
    void addEvent(const AudioEvent& event);
    void clearEvents();
    
    // Called from the audio thread inside getNextAudioBlock().
    // Checks if any events fall within the current buffer window 
    // and triggers them with sample-accurate timing.
    void processBlock(int numSamples);

private:
    Transport& transport_;
    AudioEngine& engine_;
    std::vector<AudioEvent> events_;
    
    // Track which events have already been triggered in this playthrough
    // Reset when transport seeks or stops
    std::vector<bool> triggered_;
    int64_t lastKnownPosition_ = -1;
};

processBlock() ALGORITHM:
1. Get current transport position in samples: startSample = transport_.getPositionSamples()
   (This is the position at the START of the current buffer)
2. Calculate end position: endSample = startSample + numSamples
3. Convert both to beats using transport helper methods
4. For each untriggered event:
   - Convert event.beatPosition to samples
   - If event falls within [startSample, endSample):
     a. Calculate sample offset within buffer: 
        offset = eventSamplePos - startSample
     b. Trigger the sample via engine_.queueTrigger(event.sampleId, event.velocity)
     c. Mark as triggered
5. If transport position jumped backward (seek detected: startSample < lastKnownPosition_):
   - Reset all triggered_ flags
6. Update lastKnownPosition_

IMPORTANT: This method is called from the AUDIO THREAD. 
Follow all audio-thread rules: no allocation, no locking, no I/O.
The events_ vector is set up before playback starts and not modified during playback.

MODIFY AudioEngine:
1. AudioEngine now owns an AudioScheduler
2. In getNextAudioBlock(), after draining the manual trigger queue:
   - Call audioScheduler_.processBlock(bufferToFill.numSamples)
3. The manual trigger queue (from keyboard) still works alongside the scheduler

MODIFY Main.cpp:
Update the combined A/V test from Prompt 7A:
- REMOVE the separate "scheduler thread" that watched transport position
- INSTEAD, pre-load AudioEvents into the AudioScheduler before playback
- The AudioScheduler fires them from INSIDE the audio callback with 
  sample-accurate timing
- Keep keyboard triggers working too (Z/X/C) for manual testing

For the 8-bar test pattern:
At 140 BPM, create events like:
- Beat 0.0: kick (sample 0)
- Beat 0.5: hihat (sample 2)
- Beat 1.0: snare (sample 1)
- Beat 1.5: hihat (sample 2)
- ... (basic 4-on-the-floor pattern for 8 bars = 32 beats)

DO NOT:
- Add MIDI file loading
- Add quantization
- Change the Transport class
- Add any UI code

VERIFY:
- [ ] Samples fire at exact beat positions (audibly in time)
- [ ] Audio is tighter than the previous thread-based approach
- [ ] Keyboard triggers still work during timeline playback (both fire)
- [ ] Seek to start (R key) resets scheduler — all events re-arm
- [ ] No double-triggers on any event
- [ ] Zero audio glitches
```

---

## PROMPT 8A — Node-API Bridge: Native Addon

```
We are bridging the C++ engine to Node.js/Electron via a Node-API (N-API) 
native addon. This addon exposes the engine's functionality as JavaScript 
functions.

Create the bridge/ directory structure:
bridge/
├── CMakeLists.txt
├── package.json
└── src/
    └── XlethAddon.cpp

REQUIREMENTS FOR package.json:
{
  "name": "xleth-native",
  "version": "0.0.1",
  "main": "build/Release/xleth_native.node",
  "scripts": {
    "build": "cmake-js compile",
    "rebuild": "cmake-js rebuild"
  },
  "dependencies": {
    "cmake-js": "^7.0.0",
    "node-addon-api": "^8.0.0"
  }
}

Note: We use cmake-js instead of node-gyp because we already have CMake 
for the engine. cmake-js invokes CMake to build the addon.

REQUIREMENTS FOR bridge/CMakeLists.txt:
- Build a shared library (MODULE) target "xleth_native"
- Link against the engine library (compile engine as a static lib that 
  both the standalone exe and the addon can link to)
- Include node-addon-api headers
- Set NODE_ADDON_API_DISABLE_DEPRECATED 
- Output to build/Release/xleth_native.node

REFACTOR engine/CMakeLists.txt:
- Create a STATIC library target "XlethEngineLib" containing all engine 
  source files (AudioEngine, SampleBank, Transport, VideoDecoder, etc.)
- The standalone "XlethEngine" executable links against XlethEngineLib
- The bridge addon also links against XlethEngineLib
- This avoids compiling engine code twice

REQUIREMENTS FOR XlethAddon.cpp:

Use node-addon-api (C++ wrapper around raw N-API) for cleaner code.

Expose these functions to JavaScript:

// Engine lifecycle
Napi::Boolean Initialize(const Napi::CallbackInfo& info);
  // Creates AudioEngine, initializes audio output
  // Returns true on success

Napi::Undefined Shutdown(const Napi::CallbackInfo& info);
  // Shuts down audio, releases resources

// Sample management
Napi::Number LoadSample(const Napi::CallbackInfo& info);
  // Args: (string filePath)
  // Returns: sampleId (int)

Napi::Undefined TriggerSample(const Napi::CallbackInfo& info);
  // Args: (int sampleId, optional float velocity)

// Video management  
Napi::Number LoadVideo(const Napi::CallbackInfo& info);
  // Args: (string filePath)
  // Opens video, triggers proxy transcode if needed
  // Returns: sourceId (int)

// Transport
Napi::Undefined Play(const Napi::CallbackInfo& info);
Napi::Undefined Stop(const Napi::CallbackInfo& info);
Napi::Undefined Pause(const Napi::CallbackInfo& info);
Napi::Undefined SetBPM(const Napi::CallbackInfo& info);
  // Args: (double bpm)

Napi::Object GetTransportState(const Napi::CallbackInfo& info);
  // Returns: { positionMs, positionBeats, positionBars, isPlaying, bpm }

// Video frame
Napi::Buffer<uint8_t> GetCurrentFrame(const Napi::CallbackInfo& info);
  // Returns: RGBA pixel buffer of the current composited frame
  // This is called at ~30-60fps from the renderer process

// Timeline events
Napi::Undefined AddAudioEvent(const Napi::CallbackInfo& info);
  // Args: (double beatPosition, int sampleId, float velocity)

Napi::Undefined AddVideoEvent(const Napi::CallbackInfo& info);
  // Args: (object { startBeat, durationBeats, sourceId, sourceStartTime,
  //                  layerIndex, x, y, width, height, opacity })

Napi::Undefined ClearTimeline(const Napi::CallbackInfo& info);

// Stats
Napi::Object GetSyncStats(const Napi::CallbackInfo& info);
  // Returns: { avgDriftMs, maxDriftMs, frameDrops, cacheHitRate }

MODULE INITIALIZATION:
Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set("initialize", Napi::Function::New(env, Initialize));
    exports.Set("shutdown", Napi::Function::New(env, Shutdown));
    // ... etc for all functions
    return exports;
}
NODE_API_MODULE(xleth_native, Init)

IMPORTANT THREADING NOTE:
- The addon functions are called from Node.js's main thread (or worker threads)
- Audio engine runs on its own real-time thread (managed by JUCE)
- Video compositor runs on its own thread
- GetCurrentFrame() must be efficient — it's called 30-60x per second
- For Phase 0, GetCurrentFrame() can read from a shared buffer that the 
  video compositor writes to after each render (use a mutex — it's not 
  on the audio thread so this is acceptable)

DO NOT:
- Create any Electron code yet (next prompt)
- Use raw N-API — use node-addon-api C++ wrappers
- Put video rendering in the Node.js event loop
- Use SharedArrayBuffer yet (optimization for later)
- Add any functions beyond what's listed above

VERIFY:
Build the native addon:
  cd bridge
  npm install
  npm run build

Then test with a simple Node.js script (bridge/test.js):
  const xleth = require('./build/Release/xleth_native.node');
  console.log(xleth.initialize());  // true
  xleth.loadSample('C:/path/to/kick.wav');
  xleth.triggerSample(0);
  // Wait 1 second
  setTimeout(() => { xleth.shutdown(); }, 1000);

- [ ] Native addon compiles and loads in Node.js without crashes
- [ ] initialize() returns true and audio device opens
- [ ] loadSample() + triggerSample() plays audio from Node.js
- [ ] getTransportState() returns valid object
- [ ] shutdown() cleans up without crashes
- [ ] No memory leaks after multiple load/unload cycles
```

---

## PROMPT 8B — Electron App: Minimal POC UI

```
We are building the minimal Electron app for Xleth Phase 0. This is a 
bare-bones UI with transport controls, a video preview panel, a keyboard 
trigger display, and sync stats. It's intentionally ugly — just functional.

Create the ui/ directory structure:
ui/
├── package.json
├── electron-builder.json      (for future packaging, minimal config)
├── main.js                    (Electron main process)
├── preload.js                 (contextBridge API exposure)
├── src/
│   ├── index.html
│   ├── main.jsx               (React entry point)
│   ├── App.jsx                (Root component)
│   ├── components/
│   │   ├── TransportBar.jsx   (Play/Stop/Reset, BPM, position display)
│   │   ├── VideoPreview.jsx   (Canvas displaying video frames)
│   │   ├── SyncStats.jsx      (Drift, cache rate, frame drops)
│   │   └── KeyTriggers.jsx    (Shows Z/X/C key bindings, lights up on press)
│   └── styles/
│       └── app.css            (Dark theme, minimal styling)
└── vite.config.js

REQUIREMENTS FOR package.json:
- electron: latest stable
- react, react-dom: 18.x
- vite: latest
- @vitejs/plugin-react
- electron-vite or a simple vite config for electron

REQUIREMENTS FOR main.js (Electron main process):
1. Load the native addon:
   const xleth = require('../../bridge/build/Release/xleth_native.node');
   (Adjust path as needed — the addon .node file must be found)
2. Initialize the engine on app.ready:
   xleth.initialize();
3. Load test samples from media/ directory:
   xleth.loadSample(path.join(__dirname, '../../media/kick.wav'));
   xleth.loadSample(path.join(__dirname, '../../media/snare.wav'));
   xleth.loadSample(path.join(__dirname, '../../media/hihat.wav'));
4. Load test video:
   xleth.loadVideo(path.join(__dirname, '../../media/source_clip.mp4'));
5. Pre-populate timeline with the 8-bar test pattern (same as Prompt 7)
6. Create BrowserWindow (1280x800, dark background)
7. On app.before-quit: xleth.shutdown()

REQUIREMENTS FOR preload.js:
Expose the engine API to the renderer via contextBridge:
contextBridge.exposeInMainWorld('xleth', {
    play: () => ipcRenderer.invoke('xleth:play'),
    stop: () => ipcRenderer.invoke('xleth:stop'),
    pause: () => ipcRenderer.invoke('xleth:pause'),
    triggerSample: (id) => ipcRenderer.invoke('xleth:trigger', id),
    getTransportState: () => ipcRenderer.invoke('xleth:transportState'),
    getCurrentFrame: () => ipcRenderer.invoke('xleth:currentFrame'),
    getSyncStats: () => ipcRenderer.invoke('xleth:syncStats'),
});

Handle these IPC calls in main.js by calling the corresponding 
xleth.xxx() native addon functions.

REQUIREMENTS FOR App.jsx:
Layout (simple flexbox, no frills):
┌────────────────────────────────────────────────────┐
│  XLETH v0.0.1 — Phase 0 Proof of Concept          │
├────────────────────────────────────────────────────┤
│                                                    │
│  ┌──────────────────────────────────────────────┐  │
│  │                                              │  │
│  │           VIDEO PREVIEW (Canvas)             │  │
│  │             640 x 360 or 16:9                │  │
│  │                                              │  │
│  └──────────────────────────────────────────────┘  │
│                                                    │
│  ┌──────────────────────────────────────────────┐  │
│  │  ▶ Play  ⏹ Stop  ⟲ Reset     BPM: 140      │  │
│  │  Position: 00:04.231  Beat: 12.5  Bar: 4    │  │
│  └──────────────────────────────────────────────┘  │
│                                                    │
│  ┌──────────────────────────────────────────────┐  │
│  │  [Z] Kick   [X] Snare   [C] HiHat           │  │
│  │  (keys light up green when pressed)           │  │
│  └──────────────────────────────────────────────┘  │
│                                                    │
│  ┌──────────────────────────────────────────────┐  │
│  │  Avg Drift: 8.2ms | Max: 24ms | Drops: 0    │  │
│  │  Cache: 94.2% | Voices: 3 | Status: ✓ SYNC  │  │
│  └──────────────────────────────────────────────┘  │
│                                                    │
└────────────────────────────────────────────────────┘

REQUIREMENTS FOR VideoPreview.jsx:
1. Use a <canvas> element (640x360 or proportional)
2. On mount, start a requestAnimationFrame loop
3. Each frame: call window.xleth.getCurrentFrame()
4. If frame data returned: draw RGBA pixels to canvas using 
   ctx.putImageData(imageData, 0, 0)
5. Target 30fps — skip frames if falling behind
6. Show "No video" placeholder when not playing

REQUIREMENTS FOR TransportBar.jsx:
1. Play button → window.xleth.play()
2. Stop button → window.xleth.stop()  
3. Reset button → window.xleth.stop() (which resets to 0)
4. Keyboard: SPACE toggles play/pause
5. Poll transport state every 50ms: window.xleth.getTransportState()
6. Display: position (MM:SS.mmm), beat number, bar number, BPM

REQUIREMENTS FOR KeyTriggers.jsx:
1. Listen for keydown/keyup events globally
2. Z → window.xleth.triggerSample(0), X → 1, C → 2
3. Show each key as a box that lights up (background color change) 
   while held down
4. Show the sample name next to each key

REQUIREMENTS FOR SyncStats.jsx:
1. Poll sync stats every 500ms: window.xleth.getSyncStats()
2. Display: avg drift, max drift, frame drops, cache hit rate
3. Show green "✓ SYNC" if avg drift < 15ms, yellow "⚠ DRIFT" if 15-33ms, 
   red "✗ DESYNC" if > 33ms

REQUIREMENTS FOR app.css:
- Background: #0A0A0F (nearly black)
- Text: #E0E0E8 (light gray)
- Accent: #33CED6 (teal — matches Xleth brand)
- Buttons: dark gray (#1A1A24) with teal border on hover
- Font: system-ui (keep it simple for Phase 0)
- No unnecessary animations or effects

DO NOT:
- Add any timeline editor, piano roll, or track UI
- Add drag-and-drop file loading
- Add any settings or preferences
- Use any UI framework beyond React (no Tailwind, no component libraries)
- Optimize video frame transfer yet (raw Buffer is fine for Phase 0)
- Add any save/load project functionality

VERIFY — THIS IS THE FINAL PHASE 0 VERIFICATION:
1. Run: cd ui && npm install && npm run dev (or npm start)
2. Electron window opens with dark theme
- [ ] Video preview panel is visible (shows "No video" initially)
- [ ] Click Play → audio starts, video frames appear in preview
- [ ] Position counter advances in real-time
- [ ] Beat and bar counters match the audio
- [ ] Press Z → hear kick, Z key lights up green
- [ ] Press X → hear snare, X key lights up
- [ ] Press C → hear hihat
- [ ] Sync stats show: avg drift < 15ms, max drift < 33ms
- [ ] Cache hit rate displayed and > 80%
- [ ] Frame drops < 2% during 8-bar playback
- [ ] Click Stop → audio stops, video freezes
- [ ] Click Play again → resumes correctly
- [ ] App closes cleanly (no zombie processes, no crash)

IF ALL CHECKS PASS → PHASE 0 IS COMPLETE. XLETH IS VALIDATED.
Proceed to Phase 1 (core engine rewrite with proper architecture).
```

---

## Post-Phase 0 Notes

Once all 16 prompts are complete and verified, you should have:

1. **A working C++ audio engine** that plays samples with sub-10ms latency
2. **A video decode pipeline** with proxy transcoding proving 10-100x seek speedup
3. **An LRU frame cache** with >90% hit rate on Sparta Remix patterns
4. **OpenGL compositing** displaying multiple video layers simultaneously
5. **Audio-video synchronization** within 1 frame of tolerance
6. **An Electron app** controlling everything through a Node-API bridge

**The Phase 0 codebase is intentionally disposable.** Phase 1 will be a 
clean rewrite with proper architecture, but every technical risk has been 
validated. You know the stack works. Now you build it for real.
