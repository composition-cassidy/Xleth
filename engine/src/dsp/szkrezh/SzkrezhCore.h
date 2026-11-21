#pragma once

// ─── SzkrezhCore — transport-locked granular reverse pitch echo ─────────────
// The DSP behind the Szkrezh stock effect (audio/XlethSzkrezhEffect.h). Research and design:
// xleth-crystal-shift-research.md. It is the H910 two-head splice shifter fused with a reverse delay,
// with long splices and feedback, rebuilt as a synchronous granular scheduler:
//
//   in ─► x input ─► (+) ─► tape (one ring per channel) ─► grains ─► Low cut ─► High cut ─► wet
//                     ▲                                                              │
//                     └────── matrix (Dual / Ping-pong / Mixed) ◄── x recycle ◄── soft clip
//
// Grains. Every splice a new read head (grain) starts. It reads recent tape forward or backward at
// speed t = 2^(cents / 1200), so its pitch is shifted by `cents`. Neighbouring grains crossfade over
// the Smoothing time (equal power; blended toward equal gain for Forward grains near unity, where
// neighbours are correlated). A grain latches pitch, splice, smoothing, delay and direction when it
// starts and never changes them, so parameter moves land on splice boundaries, never mid-grain.
//
//   Reverse  head index a(tau) = w0 - D - m - t * tau     (always moves away from the writer)
//   Forward  head index a(tau) = w0 - D - m - t * G + t * tau,  G = H + X
//
// w0 is the writer position at spawn, D the Delay, m a few samples of interpolation margin, H the
// nominal splice and X the smoothing. At t = 1 a Forward grain is a plain delay of D + m + H + X.
//
// Transport lock (XLETH-only). Splice boundaries are a pure function of the transport position:
//   Free  boundary j at ceil(j * H) samples, counted from timeline zero
//   Sync  boundaries every note value inside each 4/4 bar; a splice never crosses a downbeat (the
//         last splice in the bar is cut short at it), as Crystallizer does under MIDI sync
// Playing from anywhere, looping, or exporting therefore puts every splice on the same sample. With
// constant parameters the output is also independent of the host's block size (test_szkrezh_core),
// and a run of skipped blocks while the effect is idle (the mixer stops a silent track's chain)
// renders the same samples as processing them: the tape is advanced and the skipped span reads as
// silence.
//
// MIDI pitch (XLETH-only). Pitch Source picks where a grain's pitch comes from:
//   Knob     the Pitch control (cents)
//   Harmony  the host track's notes: each grain looks up the note that was playing where it starts
//            reading, and shifts by a scale-correct interval (Interval steps in Key / Scale), so a
//            pitch-sample melody gets in-key harmonies. Out-of-scale notes keep their chromatic
//            offset from the scale degree below them.
//   Keys     played notes set the crystal pitch. From another track, the crystals land ON the played
//            note: shift = key note - the host note that was playing where the grain reads (Root when
//            the host has no notes, e.g. an audio clip). From this track, shift = note - Root. A new
//            note or chord starts a fresh grain 10 ms after its first note (the chord window), so
//            the crystals follow the keys instead of waiting for the next splice.
// The engine sends note-ons only (no note-offs), so a note holds until the next one. Notes within
// 10 ms of each other form one chord: the left channel takes its lowest note, the right its highest.
// Pitch Offset then detunes left down and right up by half of it each.
//
// Quality. Vintage reads with 4-point Hermite and gives every pitch-up grain a 12 dB/oct low-pass at
// 0.45 * fs / t: the H910-style bandwidth loss, and it stops fed-back energy from aliasing again on
// every repeat. Clean reads through a Kaiser-windowed sinc stretched by max(1, t), a proper
// band-limited resampler, so pitch-up does not alias on the first pass either. It costs O(t) taps.
//
// Freeze holds the tape: nothing is written, grains keep cycling over what is there.
//
// Realtime contract: prepare() allocates (about 4.3 MB per channel at 48 kHz) on a non-audio thread
// while the core is idle. reset(), setParams() and process() never allocate, lock or log.

#include <cstddef>
#include <cstdint>
#include <vector>

namespace xleth::dsp::szkrezh
{

// ── Note-value divisions (Sync) ─────────────────────────────────────────────
// Index 0 is "0" (Delay only); 1..15 run from 1/64 to 1/1, in quarter-note beats.
constexpr int kNumDivisions = 16;
constexpr int kDefaultSpliceDivision = 10;   // 1/4
double      divisionBeats(int index) noexcept;
const char* divisionLabel(int index) noexcept;

// ── Scales (Harmony) ────────────────────────────────────────────────────────
constexpr int kNumScales = 9;   // Major, Minor, Harmonic minor, Dorian, Phrygian, Mixolydian,
                                // Major pentatonic, Minor pentatonic, Chromatic
const char* scaleName(int index) noexcept;

// Semitones from `note` to the note `steps` scale degrees away in (key, scale). key 0 = C.
int harmonyShiftSemitones(int note, int key, int scale, int steps) noexcept;

enum class PitchSource : int { Knob = 0, Harmony = 1, Keys = 2 };
enum class FeedbackMode : int { Dual = 0, PingPong = 1, Mixed = 2 };
enum class DynTarget : int { Output = 0, Feedback = 1, Both = 2 };
enum class Quality : int { Vintage = 0, Clean = 1 };

struct Params
{
    // Pitch (latched per grain)
    PitchSource pitchSource      = PitchSource::Knob;
    float       pitchCents       = 1200.0f;   // Knob
    float       pitchOffsetCents = 0.0f;      // left down, right up, by half each
    int         harmonySteps     = 2;         // Harmony: scale degrees (+2 = a third above)
    int         key              = 0;         // Harmony: 0 = C .. 11 = B
    int         scale            = 0;         // Harmony
    int         rootNote         = 60;        // Keys

    // Timing (latched per grain)
    bool  sync         = true;
    float spliceMs     = 500.0f;              // Free
    int   spliceDiv    = kDefaultSpliceDivision;   // Sync, 1..15
    float smoothingMs  = 20.0f;
    float delayMs      = 0.0f;                // Free
    int   delayDiv     = 0;                   // Sync, 0..15
    float spliceOffset = 0.0f;                // 0..0.5, shortens the right channel's splice
    float delayOffset  = 0.0f;                // 0..0.5, shortens the right channel's delay
    bool  reverse      = true;
    Quality quality    = Quality::Vintage;

    // Loop (smoothed per sample)
    float        recycle   = 0.35f;           // 0..1 of the 0.98 cap
    FeedbackMode fbMode    = FeedbackMode::Dual;
    float        lowCutHz  = 80.0f;           // <= 0 bypasses (tests)
    float        highCutHz = 20000.0f;        // >= 0.49 * fs bypasses
    bool         freeze    = false;

    // Gate / Duck on the wet path
    float     dynAmount      = 0.0f;          // -1 gate .. 0 off .. +1 duck
    float     dynThresholdDb = -24.0f;
    float     dynAttackMs    = 5.0f;
    float     dynReleaseMs   = 250.0f;
    DynTarget dynTarget      = DynTarget::Output;

    // Levels
    float inputGainDb  = 0.0f;                // into the tape
    float outputGainDb = 0.0f;                // wet out
    float mix          = 0.5f;                // equal power; 0 and 1 are exact
};

struct NoteEvent
{
    int offset = 0;   // sample offset in the block, ascending
    int note   = 0;   // MIDI note number
};

struct BlockContext
{
    std::int64_t     transportPos = 0;       // absolute sample of the block's first sample
    double           bpm          = 140.0;
    double           barBeats     = 4.0;     // quarter-note beats per bar
    const NoteEvent* hostNotes    = nullptr; // note-ons on the host track
    int              numHostNotes = 0;
    const NoteEvent* keyNotes     = nullptr; // note-ons on the Keys source track
    int              numKeyNotes  = 0;
    bool             keysFromHost = true;    // Keys reads the host notes (keyNotes ignored)
};

struct SpawnRecord
{
    std::int64_t pos       = 0;   // transport sample the grain started on
    int          channel   = 0;
    float        cents     = 0.0f;
    bool         retrigger = false;   // started by a Keys note, not a splice boundary
};

class Core
{
public:
    static constexpr int    kMaxGrains     = 4;     // per channel; X <= H keeps it to two
    static constexpr double kMinSpliceSec  = 0.010;
    static constexpr double kMaxSpliceSec  = 2.0;
    static constexpr double kMaxSmoothSec  = 0.25;
    static constexpr double kMaxDelaySec   = 2.0;
    static constexpr double kMaxCents      = 3600.0;
    static constexpr double kChordWindowSec = 0.010;
    static constexpr int    kSpawnLogSize  = 256;

    Core();

    void prepare(double sampleRate);
    void reset() noexcept;
    void setParams(const Params& p) noexcept;
    void process(float* left, float* right, int numSamples, const BlockContext& ctx) noexcept;

    // ── Telemetry (read after process) ──────────────────────────────────────
    // True while the effect still has audible material it will play (content on the tape within
    // the reach of a grain, a filter or envelope that has not settled, or wet output this block).
    // The mixer keeps a track's chain running while this holds, so crystals that arrive after a
    // short clip are not cut by the silence detector.
    bool  holdsTail() const noexcept { return !idle_; }
    float latchedCents(int ch) const noexcept { return ch_[ch & 1].latchedCents; }
    float splicePhase(int ch) const noexcept;
    int   lastHostNote() const noexcept;
    int   lastKeyNote() const noexcept;
    float dynGain() const noexcept { return blockMinDynGain_; }
    float wetPeak(int ch) const noexcept { return wetPeak_[ch & 1]; }
    double sampleRate() const noexcept { return sr_; }
    std::size_t tapeSamples() const noexcept { return static_cast<std::size_t>(N_); }

    // ── Test hooks ──────────────────────────────────────────────────────────
    std::int64_t spawnCount() const noexcept { return spawnTotal_; }
    SpawnRecord  spawn(std::int64_t i) const noexcept { return spawnLog_[i % kSpawnLogSize]; }
    int          activeGrains(int ch) const noexcept;

private:
    struct Svf
    {
        float a1 = 0.0f, a2 = 0.0f, a3 = 0.0f, k = 1.41421356f;
        float ic1 = 0.0f, ic2 = 0.0f;
        void  set(double fc, double sr) noexcept;
        float lp(float x) noexcept;
        float hp(float x) noexcept;
        void  clear() noexcept { ic1 = ic2 = 0.0f; }
        void  snap() noexcept;
        bool  settled() const noexcept { return ic1 == 0.0f && ic2 == 0.0f; }
    };

    struct Smooth
    {
        float v = 0.0f, target = 0.0f, c = 1.0f;
        void  init(float x) noexcept { v = target = x; }
        float next() noexcept;
        void  snapToTarget() noexcept { v = target; }
    };

    struct Grain
    {
        bool         active     = false;
        std::int64_t w0         = 0;
        double       o0         = 0.0;
        double       v          = 1.0;
        std::int64_t tau        = 0;
        int          cIn        = 1;
        bool         fadingOut  = false;
        std::int64_t fadeStart  = 0;
        int          cOut       = 1;
        float        level0     = 1.0f;
        float        law        = 0.0f;   // 0 = equal power .. 1 = equal gain
        std::int64_t sustainCap = 0;
        int          xPlan      = 1;
        bool         clean      = false;
        float        invStretch = 1.0f;
        int          K          = 2;      // taps each side of the read position
        bool         aa         = false;
        Svf          aaLp;
        std::uint64_t serial    = 0;
    };

    struct Channel
    {
        std::vector<float> ring;          // kGuard + N + kGuard, both guards mirrored
        Grain        grains[kMaxGrains];
        Svf          hp, lp;
        std::int64_t nextBoundary = 0;
        std::int64_t lastSpawnPos = 0;
        std::int64_t lastHop      = 1;
        float        latchedCents = 0.0f;
    };

    struct Frame
    {
        std::int64_t pos = 0;
        int lo = 0, hi = 0;
    };

    static constexpr int kNoteHistory = 1024;

    struct NoteHistory
    {
        Frame frames[kNoteHistory];
        int   head  = 0;    // index of the newest frame
        int   count = 0;
        void  clear() noexcept { head = 0; count = 0; }
        // Returns true when the note opened a new frame (false: merged into the newest chord).
        bool  push(std::int64_t pos, int note, std::int64_t chordWindow) noexcept;
        const Frame* at(std::int64_t q) const noexcept;   // newest frame with pos <= q
        const Frame* newest() const noexcept { return count > 0 ? &frames[head] : nullptr; }
    };

    // Clock
    std::int64_t resolveClock(std::int64_t published, int n) noexcept;
    void         jumpForward(std::int64_t gap, std::int64_t newPos) noexcept;
    void         restartSchedule(std::int64_t pos) noexcept;

    // Scheduling
    double       hopSamples(int ch, double spb) const noexcept;
    double       spliceBeats(int ch, double spb) const noexcept;
    std::int64_t boundaryFrom(int ch, std::int64_t target, double spb) const noexcept;
    void         spawnGrain(int ch, std::int64_t pos, double spb, bool retrigger) noexcept;
    double       pitchFor(int ch, std::int64_t pos, double D, double G) noexcept;

    // Rendering
    float renderGrain(Grain& g, const float* ring) noexcept;
    float readHermite(const float* ring, std::int64_t ip, float frac) const noexcept;
    float readSinc(const float* ring, std::int64_t ip, float frac, const Grain& g) const noexcept;
    float tapeAt(const float* ring, std::int64_t abs) const noexcept;   // slow path, any index
    float envelopeNow(const Grain& g) const noexcept;
    void  writeTape(int ch, float x) noexcept;
    void  updateToneCoefficients() noexcept;
    void  updateDynamicsCoefficients() noexcept;
    float dynSilenceTarget() const noexcept;
    double reachSamples() const noexcept;

    double sr_ = 48000.0;
    int    N_  = 0;
    Channel ch_[2];

    std::int64_t written_       = 0;   // samples written to the tape (the writer position)
    int          ringPos_       = 0;   // written_ mod N_
    std::int64_t validFrom_     = 0;   // tape indices below this read as silence
    std::int64_t lastNonZero_   = -1;  // last writer index that received a non-zero sample

    Params p_;
    bool   paramsInitialised_ = false;
    Smooth recycle_, lowCut_, highCut_, inGain_, outGain_, mix_, dynAmount_;
    float  dryGain_ = 0.7071f, wetGain_ = 0.7071f, mixForGains_ = -1.0f;
    bool   hpOn_ = true, lpOn_ = true;
    bool   keysFromHost_ = true;

    // Dynamics
    float detEnv_ = 0.0f, dynG_ = 1.0f;
    bool  dynAbove_ = false;
    float detAtk_ = 0.0f, detRel_ = 0.0f, gAtk_ = 0.0f, gRel_ = 0.0f;
    float dynAttackMsFor_ = -1.0f, dynReleaseMsFor_ = -1.0f;

    // Clock
    bool         clockValid_    = false;
    std::int64_t expectedPos_   = 0;
    std::int64_t lastPublished_ = 0;
    double       spb_           = 0.0;
    double       barBeats_      = 4.0;

    // Notes
    NoteHistory  host_, keys_;
    bool         retrigPending_ = false;
    std::int64_t retrigAt_      = 0;
    std::int64_t chordWindow_   = 480;

    // Clean-mode kernel
    std::vector<float> sinc_;

    // Telemetry
    std::uint64_t serial_        = 0;
    std::int64_t  spawnTotal_    = 0;
    SpawnRecord   spawnLog_[kSpawnLogSize] {};
    bool          idle_          = true;
    float         wetPeak_[2]    = { 0.0f, 0.0f };
    float         blockMinDynGain_ = 1.0f;
    std::int64_t  blockEndPos_   = 0;
};

} // namespace xleth::dsp::szkrezh
