#pragma once

// ─── StereoizeCore — mono-safe pseudo-stereo side generator ─────────────────
// Shared DSP for XLETH's stereoizers (spec: xleth-spread-spec.md, sections 3 and 4). The Fedda stock
// effect is its single-band, one-knob face (audio/XlethFeddaEffect.h). A frequency-dependent
// stereoizer is meant to run one Core per band. No juce::AudioProcessor / APVTS dependency: it is
// driven with raw channel pointers and a POD Params block, so it can be tested headless.
//
// Signal path (per sample, zero latency):
//
//   L, R ─► M = (L + R) / 2 ─► mid history ─► D (decorrelator) ─► HF damp ─► Low bypass HP ─► x duck ─► x g ─► G
//
//   Lout = L + G      Rout = R - G
//
// That is the spec's  Lout = M + (S + G),  Rout = M - (S + G)  with S = (L - R) / 2 passed through
// untouched, rearranged so that G = 0 is a bit-exact passthrough. Lout + Rout = L + R for ANY D,
// filter, gain or duck: everything creative lives in G, and G cancels in the mono sum. The mid is
// never processed, so there is no latency and no transient smear in mono. The two exceptions are
// opt-in and documented on their Params fields: loudnessMatch (scales the mono sum too) and the two
// monitor switches (monoCheck, compareDry), which a host must force off when rendering.
//
// Decorrelators (Character), all reading one shared mid history:
//   Comb     D = the mid delayed by tau (the Size), plus feedback echoes at 2 tau, 3 tau, ... above
//            100 % width. The feedback is a truncated FIR on the history (6 taps, gains fb^k,
//            normalised to unit energy), not a recursive loop, so a new comb starts warm. Then two
//            seeded first-order all-passes soften the teeth.
//   Diffuse  D = a pre-delay and a 5-stage Schroeder all-pass cascade (Maher 1997, WASPAA, plus five
//            sibling sets). Magnitude exactly flat. Stage lengths scale with Size / 8 ms and the
//            sample rate; every stage's |a| is capped so that stage rings no longer than 60 ms.
//   Velvet   D = a sparse FIR of up to 30 signed impulses over Size x 3.75 (2..60 ms), denser near
//            the start, exponentially decaying, unit energy (Alary/Politis/Valimaki DAFx-17,
//            Schlecht et al. DAFx-18). The seed draws 6 candidate sequences; in each, the signs are
//            balanced against a 1/f autocorrelation so the sequence passes pink material at the same
//            unit power as white and stays uncorrelated with the mid (no image lean); the best wins.
//
// Variation seed: every structural choice (comb tau offset and all-pass coefficients, Diffuse set and
// stage jitter, Velvet positions and signs) is a pure function of (variation, size, sample rate), so
// two renders of the same settings are identical and two instances with different seeds have
// decorrelated sides.
//
// Structural changes (Character, Size, Variation) never move a read head. The core keeps two engine
// slots: the new configuration is built in the idle slot, runs silently for its pre-roll (long enough
// for an all-pass cascade started from zero state to settle below -90 dB; zero for Velvet, which only
// reads the history), and then the slots crossfade over 30 ms (raised cosine). A change that arrives
// while a switch is running waits for it to finish, so a Size drag is heard in steps rather than not
// at all. Building a configuration is allocation-free and bounded (the Velvet search is about 20 k
// table reads), and
// each slot is owned by the processing thread only: nothing is published across threads, so there is
// no table to race on.
//
// Block-size independence: the core processes in chunks that never cross a multiple of kGrid samples
// (counted from reset), switch events happen only on that grid, filter coefficients update on a
// 16-sample grid, and every smoother is per sample. With constant parameters the output does not
// depend on how the caller splits the stream (test_stereoize_core T4).
//
// Realtime contract: prepare() allocates and runs on a non-audio thread while the core is not
// processing. process() and reset() never allocate, lock or log. Not thread-safe; owns no thread.

#include <cstdint>
#include <memory>

namespace xleth::dsp::stereoize
{

enum class Character : int { Comb = 0, Diffuse = 1, Velvet = 2 };
enum class LowSlope : int { Db12 = 0, Db24 = 1 };

constexpr float kMinWidthPct     = 0.0f;
constexpr float kMaxWidthPct     = 200.0f;
constexpr float kMinSizeMs       = 0.5f;
constexpr float kMaxSizeMs       = 30.0f;
constexpr float kDefaultSizeMs   = 8.0f;
constexpr float kMinLowBypassHz  = 20.0f;
constexpr float kMaxLowBypassHz  = 2000.0f;
constexpr float kMinHfDampHz     = 2000.0f;
constexpr float kHfDampOffHz     = 20000.0f;   // at or above this, HF damp is off (bypassed, not filtered)
constexpr int   kMaxVariation    = 999;

constexpr int   kGrid            = 64;         // switch / chunk grid, samples
constexpr float kSwitchFadeMs    = 30.0f;      // engine crossfade
constexpr float kParamRampMs     = 20.0f;      // width, cutoffs, HF damp on/off, slope, loudness match, guard
constexpr float kMonitorRampMs   = 10.0f;      // mono check, dry compare

// Parameter block, passed by value to every process() call. process() sanitises a copy (non-finite
// fields take the default, everything is clamped to its range).
struct Params
{
    float     widthPct       = 50.0f;            // 0..200. 100 = output L/R correlation 0 on broadband input
    Character character      = Character::Diffuse;
    float     sizeMs         = kDefaultSizeMs;   // 0.5..30. Comb: tau. Diffuse / Velvet: scales lengths
    float     lowBypassHz    = 150.0f;           // 20..2000. High-pass on G: lows stay mono
    LowSlope  lowSlope       = LowSlope::Db12;   // Butterworth 2nd or 4th order
    float     hfDampHz       = kHfDampOffHz;     // 2000..20000, >= 20000 = off. One-pole low-pass on G
    float     guard          = 0.0f;             // 0..1. Transient Guard: ducks G on onsets
    int       variation      = 0;                // 0..999. Seed of every structural choice
    // Scales L and R by 1/sqrt(1+g^2) so the stereo loudness stays constant. The mono sum drops by the
    // same factor (-3 dB at 100 %, -7 dB at 200 %): the one setting that is not mono-exact.
    bool      loudnessMatch  = false;
    // Monitor switches. NOT part of a render: a host forces both off when rendering offline.
    bool      monoCheck      = false;            // output (Lout + Rout) / 2 on both sides
    bool      compareDry     = false;            // output the dry input, level-matched to the processed output
};

// Width curve (spec 3.5). g scales G; combFeedback is the Comb echo ratio. Linear interpolation
// between points; the table is data so measured values can replace it without touching the code.
struct WidthPoint
{
    float widthPct;
    float gain;
    float combFeedback;
};

inline constexpr WidthPoint kWidthCurve[] = {
    {   0.0f, 0.00f, 0.000f },
    {  25.0f, 0.25f, 0.000f },
    {  50.0f, 0.50f, 0.000f },
    {  75.0f, 0.75f, 0.000f },
    { 100.0f, 1.00f, 0.000f },
    { 125.0f, 1.25f, 0.125f },
    { 150.0f, 1.50f, 0.250f },
    { 175.0f, 1.75f, 0.375f },
    { 200.0f, 2.00f, 0.500f },
};

float widthToGain(float widthPct) noexcept;
float widthToCombFeedback(float widthPct) noexcept;

// Output L/R correlation for a side gain g when D is decorrelated from M at equal power (spec 3.4).
inline float targetCorrelation(float g) noexcept { return (1.0f - g * g) / (1.0f + g * g); }

namespace detail
{
// Cosine integral Ci(x), x > 0 (|error| < 5e-7). Exposed for the tests.
double cosineIntegral(double x) noexcept;
// Normalised autocorrelation of 1/f noise band-limited to [loHz, hiHz] at lag tau. The Velvet
// sign balancing is done against this.
double pinkAutocorrelation(double tauSeconds, double loHz, double hiHz) noexcept;
} // namespace detail

// Read on the processing thread after process(); refreshed once per call.
struct Meters
{
    float correlation       = 1.0f;     // measured L/R correlation of the processed output (300 ms), 1 when silent
    float midRmsDb          = -120.0f;  // processed output mid RMS (300 ms)
    float sideRmsDb         = -120.0f;  // processed output side RMS (300 ms)
    float msCorrelation     = 0.0f;     // normalised E[M S] of the processed output: the tilt of the stereo field
    float guardDepth        = 0.0f;     // 0..1: the deepest Transient Guard duck during the last call
    float targetCorrelation = 1.0f;     // targetCorrelation(g) for the current (smoothed) width
    float dryMatchGainDb    = 0.0f;     // the gain compareDry applies to the dry signal
};
// "Processed output" = after loudness match, before the monitor switches: what a render contains.

class Core
{
public:
    Core();
    ~Core();
    Core(const Core&) = delete;
    Core& operator=(const Core&) = delete;

    // Allocates the mid history and both engine slots for the worst case at this rate.
    void prepare(double sampleRate, int maxBlockSize);
    // Clears every signal state. The next process() call starts from its Params with no ramps or
    // crossfades (as a freshly prepared core does). RT-safe.
    void reset() noexcept;

    // In place. right == nullptr means a mono stream: the mono sum of the output is the input itself,
    // so left is returned unchanged. Before prepare() the buffers are left untouched.
    void process(float* left, float* right, int numSamples, const Params& params) noexcept;

    const Meters& meters() const noexcept;

    // ── Introspection (processing thread / tests) ──
    struct EngineInfo
    {
        Character character        = Character::Diffuse;
        float     sizeMs           = kDefaultSizeMs;
        int       variation        = 0;
        int       combTauSamples   = 0;
        float     combAllpass[2]   = {};
        int       diffusePredelay  = 0;
        int       diffuseLength[5] = {};
        float     diffuseCoeff[5]  = {};
        int       velvetTaps       = 0;
        int       velvetLengthSamples = 0;
        int       preRollSamples   = 0;
    };
    EngineInfo activeEngineInfo() const noexcept;
    bool       switchInProgress() const noexcept;
    long long  engineSwitchCount() const noexcept;   // completed crossfades since prepare()
    double     sampleRate() const noexcept;
    int        fadeSamples() const noexcept;

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

} // namespace xleth::dsp::stereoize
