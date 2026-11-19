#include "dsp/szkrezh/SzkrezhCore.h"

#include <algorithm>
#include <cmath>
#include <initializer_list>

namespace xleth::dsp::szkrezh
{
namespace
{
constexpr double kPi            = 3.14159265358979323846;
constexpr int    kGuard         = 128;    // mirrored samples each side of the ring (>= max sinc half-width)
constexpr int    kHermiteHalf   = 2;      // Hermite taps: ip-1 .. ip+2
constexpr int    kHermiteMargin = 4;      // samples kept between a fresh head and the writer
constexpr int    kSincZ         = 6;      // zero crossings each side of the (stretched) kernel
constexpr int    kSincRes       = 512;    // table points per zero crossing
constexpr double kSincRho       = 0.92;   // cutoff as a fraction of the output Nyquist
constexpr double kKaiserBeta    = 7.0;
constexpr int    kCoeffGrid     = 32;     // tone coefficients update on this transport grid
constexpr double kMaxStretch    = 8.0;    // 2^(3600 / 1200)
constexpr float  kRecycleCap    = 0.98f;
constexpr float  kStateSnap     = 1e-25f; // FTZ parks SVF integrators near 1e-37; snap well above
// Tape writes quieter than -120 dBFS are stored as exact zero. A recycle loop otherwise decays
// geometrically for minutes before reaching the float floor; with the floor it falls silent after
// a dozen or so passes, the effect goes idle, and the mixer may stop the chain.
constexpr float  kTapeFloor     = 1e-6f;
constexpr float  kDetectorSnap  = 1e-9f;
constexpr double kSmoothSec     = 0.020;
constexpr float  kHysteresis    = 0.79432823f;   // -2 dB

struct Division { double beats; const char* label; };
constexpr Division kDivisions[kNumDivisions] = {
    { 0.0,        "0"     },
    { 1.0 / 16.0, "1/64"  },
    { 1.0 / 8.0,  "1/32"  },
    { 1.0 / 6.0,  "1/16T" },
    { 0.25,       "1/16"  },
    { 1.0 / 3.0,  "1/8T"  },
    { 0.375,      "1/16D" },
    { 0.5,        "1/8"   },
    { 2.0 / 3.0,  "1/4T"  },
    { 0.75,       "1/8D"  },
    { 1.0,        "1/4"   },
    { 4.0 / 3.0,  "1/2T"  },
    { 1.5,        "1/4D"  },
    { 2.0,        "1/2"   },
    { 3.0,        "1/2D"  },
    { 4.0,        "1/1"   },
};

struct ScaleDef { const char* name; int size; int steps[12]; };
constexpr ScaleDef kScales[kNumScales] = {
    { "Major",            7,  { 0, 2, 4, 5, 7, 9, 11 } },
    { "Minor",            7,  { 0, 2, 3, 5, 7, 8, 10 } },
    { "Harmonic minor",   7,  { 0, 2, 3, 5, 7, 8, 11 } },
    { "Dorian",           7,  { 0, 2, 3, 5, 7, 9, 10 } },
    { "Phrygian",         7,  { 0, 1, 3, 5, 7, 8, 10 } },
    { "Mixolydian",       7,  { 0, 2, 4, 5, 7, 9, 10 } },
    { "Major pentatonic", 5,  { 0, 2, 4, 7, 9 } },
    { "Minor pentatonic", 5,  { 0, 3, 5, 7, 10 } },
    { "Chromatic",        12, { 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11 } },
};

inline int floorDiv(int a, int b) noexcept
{
    int q = a / b;
    if ((a % b != 0) && ((a < 0) != (b < 0))) --q;
    return q;
}

inline float dbToGain(float db) noexcept
{
    return static_cast<float>(std::pow(10.0, static_cast<double>(db) / 20.0));
}

// Pade tanh: slope exactly 1 at 0, saturates to +-1 at |x| = 3 (continuous there).
inline float softClip(float x) noexcept
{
    if (x > 3.0f) return 1.0f;
    if (x < -3.0f) return -1.0f;
    const float x2 = x * x;
    return x * (27.0f + x2) / (27.0f + 9.0f * x2);
}

double besselI0(double x) noexcept
{
    double sum = 1.0, term = 1.0;
    const double h = 0.5 * x;
    for (int k = 1; k < 64; ++k)
    {
        const double f = h / static_cast<double>(k);
        term *= f * f;
        sum += term;
        if (term < sum * 1e-15) break;
    }
    return sum;
}

std::int64_t freeBoundaryFrom(std::int64_t target, double hop) noexcept
{
    // Boundary j sits at ceil(j * hop) (minus a hair of float slack); the set is fixed by `hop`
    // alone, so this returns the same sample whatever position it is asked from.
    std::int64_t j = static_cast<std::int64_t>(std::floor(static_cast<double>(target) / hop)) - 1;
    for (int iter = 0; iter < 64; ++iter, ++j)
    {
        const auto s = static_cast<std::int64_t>(std::ceil(static_cast<double>(j) * hop - 1e-6));
        if (s >= target) return s;
    }
    return target;
}

std::int64_t syncBoundaryFrom(std::int64_t target, double lenBeats, double spb, double barBeats) noexcept
{
    // Boundaries every lenBeats inside each bar, plus every downbeat; the last splice of a bar is
    // cut at the downbeat. Same fixed-set property as the free grid.
    const double beat = static_cast<double>(target) / spb;
    auto bar = static_cast<std::int64_t>(std::floor(beat / barBeats));
    const double r = beat - static_cast<double>(bar) * barBeats;
    auto j = static_cast<std::int64_t>(std::floor(r / lenBeats)) - 1;
    if (j < 0) j = 0;
    for (int iter = 0; iter < 4096; ++iter)
    {
        const double cand  = static_cast<double>(j) * lenBeats;
        const bool  barEnd = cand > barBeats - 1e-9;
        const double b = static_cast<double>(bar) * barBeats + (barEnd ? barBeats : cand);
        const auto s = static_cast<std::int64_t>(std::ceil(b * spb - 1e-6));
        if (s >= target) return s;
        if (barEnd) { ++bar; j = 0; }
        else        { ++j; }
    }
    return target;
}
} // namespace

// ── Public helpers ──────────────────────────────────────────────────────────

double divisionBeats(int index) noexcept
{
    return kDivisions[std::clamp(index, 0, kNumDivisions - 1)].beats;
}

const char* divisionLabel(int index) noexcept
{
    return kDivisions[std::clamp(index, 0, kNumDivisions - 1)].label;
}

const char* scaleName(int index) noexcept
{
    return kScales[std::clamp(index, 0, kNumScales - 1)].name;
}

int harmonyShiftSemitones(int note, int key, int scale, int steps) noexcept
{
    const ScaleDef& sc = kScales[std::clamp(scale, 0, kNumScales - 1)];
    key = ((key % 12) + 12) % 12;
    const int rel = note - key;
    const int oct = floorDiv(rel, 12);
    const int pc  = rel - oct * 12;

    // Scale degree at or below the note; an out-of-scale note keeps its chromatic offset.
    int degree = 0;
    for (int i = 0; i < sc.size; ++i)
        if (sc.steps[i] <= pc) degree = i;
    const int chroma = pc - sc.steps[degree];

    const int j        = degree + steps;
    const int octShift = floorDiv(j, sc.size);
    const int dj       = j - octShift * sc.size;
    const int target   = key + 12 * (oct + octShift) + sc.steps[dj] + chroma;
    return target - note;
}

// ── Small parts ─────────────────────────────────────────────────────────────

void Core::Svf::set(double fc, double sr) noexcept
{
    fc = std::clamp(fc, 1.0, 0.49 * sr);
    const double g  = std::tan(kPi * fc / sr);
    const double kk = 1.4142135623730951;   // Butterworth, Q = 1/sqrt(2)
    const double d  = 1.0 / (1.0 + g * (g + kk));
    a1 = static_cast<float>(d);
    a2 = static_cast<float>(g * d);
    a3 = static_cast<float>(g * g * d);
    k  = static_cast<float>(kk);
}

float Core::Svf::lp(float x) noexcept
{
    const float v3 = x - ic2;
    const float v1 = a1 * ic1 + a2 * v3;
    const float v2 = ic2 + a2 * ic1 + a3 * v3;
    ic1 = 2.0f * v1 - ic1;
    ic2 = 2.0f * v2 - ic2;
    return v2;
}

float Core::Svf::hp(float x) noexcept
{
    const float v3 = x - ic2;
    const float v1 = a1 * ic1 + a2 * v3;
    const float v2 = ic2 + a2 * ic1 + a3 * v3;
    ic1 = 2.0f * v1 - ic1;
    ic2 = 2.0f * v2 - ic2;
    return x - k * v1 - v2;
}

void Core::Svf::snap() noexcept
{
    if (std::fabs(ic1) < kStateSnap) ic1 = 0.0f;
    if (std::fabs(ic2) < kStateSnap) ic2 = 0.0f;
}

float Core::Smooth::next() noexcept
{
    if (v != target)
    {
        // A one-pole step in float stalls once c * (target - v) drops under half an ULP of v,
        // short of the target: snap when the step stops moving v, as well as when it is close.
        const float before = v;
        v += c * (target - v);
        if (v == before || std::fabs(target - v) <= 1e-6f * std::max(1.0f, std::fabs(target)))
            v = target;
    }
    return v;
}

bool Core::NoteHistory::push(std::int64_t pos, int note, std::int64_t chordWindow) noexcept
{
    if (count > 0)
    {
        Frame& f = frames[head];
        if (pos >= f.pos && pos - f.pos <= chordWindow)
        {
            f.lo = std::min(f.lo, note);
            f.hi = std::max(f.hi, note);
            return false;
        }
    }
    head = (head + 1) % kNoteHistory;
    frames[head] = Frame{ pos, note, note };
    count = std::min(count + 1, kNoteHistory);
    return true;
}

const Core::Frame* Core::NoteHistory::at(std::int64_t q) const noexcept
{
    for (int k = 0; k < count; ++k)
    {
        const Frame& f = frames[(head - k + kNoteHistory) % kNoteHistory];
        if (f.pos <= q) return &f;
    }
    // Older than everything kept: a full history has dropped the answer, so the oldest kept
    // frame is the best estimate; a partial one means no note had played yet.
    if (count == kNoteHistory)
        return &frames[(head + 1) % kNoteHistory];
    return nullptr;
}

// ── Lifecycle ───────────────────────────────────────────────────────────────

Core::Core() = default;

void Core::prepare(double sampleRate)
{
    sr_ = (sampleRate > 0.0 && std::isfinite(sampleRate)) ? sampleRate : 48000.0;

    // Longest read: a reverse grain at +36 st, the longest splice and smoothing, the longest delay.
    const double reachSec = kMaxDelaySec + (1.0 + kMaxStretch) * (kMaxSpliceSec + kMaxSmoothSec);
    N_ = static_cast<int>(std::ceil(reachSec * sr_)) + 4 * kGuard;

    for (auto& c : ch_)
        c.ring.assign(static_cast<std::size_t>(N_ + 2 * kGuard), 0.0f);

    sinc_.assign(static_cast<std::size_t>(kSincZ * kSincRes + 2), 0.0f);
    const double i0b = besselI0(kKaiserBeta);
    for (int i = 0; i <= kSincZ * kSincRes; ++i)
    {
        const double x  = static_cast<double>(i) / kSincRes;
        const double px = kPi * kSincRho * x;
        const double s  = (i == 0) ? 1.0 : std::sin(px) / px;
        const double r  = x / kSincZ;
        const double w  = r < 1.0 ? besselI0(kKaiserBeta * std::sqrt(1.0 - r * r)) / i0b : 0.0;
        sinc_[static_cast<std::size_t>(i)] = static_cast<float>(s * w);
    }

    chordWindow_ = static_cast<std::int64_t>(std::llround(kChordWindowSec * sr_));

    const float c = static_cast<float>(1.0 - std::exp(-1.0 / (kSmoothSec * sr_)));
    for (Smooth* s : { &recycle_, &lowCut_, &highCut_, &inGain_, &outGain_, &mix_, &dynAmount_ })
        s->c = c;

    dynAttackMsFor_ = dynReleaseMsFor_ = -1.0f;
    written_ = 0;
    ringPos_ = 0;
    if (!paramsInitialised_) setParams(p_);
    updateDynamicsCoefficients();
    reset();
}

void Core::reset() noexcept
{
    for (auto& c : ch_)
    {
        for (auto& g : c.grains) g.active = false;
        c.hp.clear();
        c.lp.clear();
        c.nextBoundary = 0;
        c.lastSpawnPos = 0;
        c.lastHop      = 1;
        c.latchedCents = 0.0f;
    }
    // The tape is not cleared: everything already on it simply becomes unreadable. O(1) on the
    // audio thread, where a seek or loop wrap resets the chain.
    validFrom_   = written_;
    lastNonZero_ = written_ - 1;

    for (Smooth* s : { &recycle_, &lowCut_, &highCut_, &inGain_, &outGain_, &mix_, &dynAmount_ })
        s->snapToTarget();
    mixForGains_ = -1.0f;

    detEnv_   = 0.0f;
    dynAbove_ = false;
    dynG_     = dynSilenceTarget();

    clockValid_    = false;
    retrigPending_ = false;
    host_.clear();
    keys_.clear();

    idle_            = true;
    wetPeak_[0]      = wetPeak_[1] = 0.0f;
    blockMinDynGain_ = 1.0f;
    updateToneCoefficients();
}

void Core::setParams(const Params& in) noexcept
{
    Params p = in;
    p.pitchCents       = std::clamp(p.pitchCents, -static_cast<float>(kMaxCents), static_cast<float>(kMaxCents));
    p.pitchOffsetCents = std::clamp(p.pitchOffsetCents, -2400.0f, 2400.0f);
    p.harmonySteps     = std::clamp(p.harmonySteps, -14, 14);
    p.key              = std::clamp(p.key, 0, 11);
    p.scale            = std::clamp(p.scale, 0, kNumScales - 1);
    p.rootNote         = std::clamp(p.rootNote, 0, 127);
    p.spliceMs         = std::clamp(p.spliceMs, static_cast<float>(kMinSpliceSec * 1000.0),
                                    static_cast<float>(kMaxSpliceSec * 1000.0));
    p.spliceDiv        = std::clamp(p.spliceDiv, 1, kNumDivisions - 1);
    p.smoothingMs      = std::clamp(p.smoothingMs, 0.5f, static_cast<float>(kMaxSmoothSec * 1000.0));
    p.delayMs          = std::clamp(p.delayMs, 0.0f, static_cast<float>(kMaxDelaySec * 1000.0));
    p.delayDiv         = std::clamp(p.delayDiv, 0, kNumDivisions - 1);
    p.spliceOffset     = std::clamp(p.spliceOffset, 0.0f, 0.5f);
    p.delayOffset      = std::clamp(p.delayOffset, 0.0f, 0.5f);
    p.recycle          = std::clamp(p.recycle, 0.0f, 1.0f);
    p.dynAmount        = std::clamp(p.dynAmount, -1.0f, 1.0f);
    p.dynAttackMs      = std::clamp(p.dynAttackMs, 0.1f, 2000.0f);
    p.dynReleaseMs     = std::clamp(p.dynReleaseMs, 1.0f, 5000.0f);
    p.mix              = std::clamp(p.mix, 0.0f, 1.0f);
    p_ = p;

    recycle_.target   = p.recycle * kRecycleCap;
    lowCut_.target    = std::max(0.0f, p.lowCutHz);
    highCut_.target   = p.highCutHz;
    inGain_.target    = dbToGain(p.inputGainDb);
    outGain_.target   = dbToGain(p.outputGainDb);
    mix_.target       = p.mix;
    dynAmount_.target = p.dynAmount;

    if (!paramsInitialised_)
    {
        for (Smooth* s : { &recycle_, &lowCut_, &highCut_, &inGain_, &outGain_, &mix_, &dynAmount_ })
            s->snapToTarget();
        paramsInitialised_ = true;
        updateToneCoefficients();
    }
    if (p.dynAttackMs != dynAttackMsFor_ || p.dynReleaseMs != dynReleaseMsFor_)
        updateDynamicsCoefficients();
}

// ── Coefficients ────────────────────────────────────────────────────────────

void Core::updateToneCoefficients() noexcept
{
    hpOn_ = lowCut_.v >= 1.0f;
    lpOn_ = static_cast<double>(highCut_.v) < 0.49 * sr_;
    for (auto& c : ch_)
    {
        if (hpOn_) c.hp.set(lowCut_.v, sr_);
        else       c.hp.clear();
        if (lpOn_) c.lp.set(highCut_.v, sr_);
        else       c.lp.clear();
    }
}

void Core::updateDynamicsCoefficients() noexcept
{
    auto coeff = [this](double sec) {
        return static_cast<float>(1.0 - std::exp(-1.0 / (std::max(sec, 1e-5) * sr_)));
    };
    detAtk_ = coeff(0.0005);
    detRel_ = coeff(0.030);
    gAtk_   = coeff(static_cast<double>(p_.dynAttackMs) * 1e-3);
    gRel_   = coeff(static_cast<double>(p_.dynReleaseMs) * 1e-3);
    dynAttackMsFor_  = p_.dynAttackMs;
    dynReleaseMsFor_ = p_.dynReleaseMs;
}

float Core::dynSilenceTarget() const noexcept
{
    // With the input below threshold a gate sits at 1 - depth and a duck at 1.
    const float a = dynAmount_.v;
    return a < 0.0f ? 1.0f - std::fabs(a) : 1.0f;
}

// ── Scheduling ──────────────────────────────────────────────────────────────

double Core::spliceBeats(int ch, double spb) const noexcept
{
    double beats = divisionBeats(p_.spliceDiv);
    if (ch == 1) beats *= 1.0 - static_cast<double>(p_.spliceOffset);
    return std::max(beats, kMinSpliceSec * sr_ / spb);
}

double Core::hopSamples(int ch, double spb) const noexcept
{
    double h;
    if (p_.sync)
        h = spliceBeats(ch, spb) * spb;
    else
    {
        h = static_cast<double>(p_.spliceMs) * 1e-3 * sr_;
        if (ch == 1) h *= 1.0 - static_cast<double>(p_.spliceOffset);
    }
    return std::max(h, kMinSpliceSec * sr_);
}

std::int64_t Core::boundaryFrom(int ch, std::int64_t target, double spb) const noexcept
{
    if (p_.sync)
        return syncBoundaryFrom(target, spliceBeats(ch, spb), spb, barBeats_);
    return freeBoundaryFrom(target, hopSamples(ch, spb));
}

void Core::restartSchedule(std::int64_t pos) noexcept
{
    for (int c = 0; c < 2; ++c)
    {
        ch_[c].nextBoundary = boundaryFrom(c, pos, spb_);   // inclusive: a boundary ON pos spawns
        ch_[c].lastSpawnPos = pos;
        ch_[c].lastHop      = std::max<std::int64_t>(1, ch_[c].nextBoundary - pos);
    }
}

double Core::pitchFor(int ch, std::int64_t pos, double D, double G) noexcept
{
    switch (p_.pitchSource)
    {
        case PitchSource::Knob:
            return static_cast<double>(p_.pitchCents);

        case PitchSource::Harmony:
        {
            // The note playing where this grain starts reading.
            const std::int64_t q = pos - static_cast<std::int64_t>(std::llround(D))
                                 - (p_.reverse ? 0 : static_cast<std::int64_t>(std::llround(G)));
            const Frame* f = host_.at(q);
            if (f == nullptr) return 0.0;
            return 100.0 * harmonyShiftSemitones(f->hi, p_.key, p_.scale, p_.harmonySteps);
        }

        case PitchSource::Keys:
        {
            const NoteHistory& keys = keysFromHost_ ? host_ : keys_;
            const Frame* k = keys.at(pos);
            if (k == nullptr) return 0.0;
            const int keyNote = (ch == 0) ? k->lo : k->hi;
            int ref = p_.rootNote;
            if (!keysFromHost_)
            {
                const std::int64_t q = pos - static_cast<std::int64_t>(std::llround(D))
                                     - (p_.reverse ? 0 : static_cast<std::int64_t>(std::llround(G)));
                if (const Frame* h = host_.at(q)) ref = h->hi;
            }
            return 100.0 * static_cast<double>(keyNote - ref);
        }
    }
    return 0.0;
}

void Core::spawnGrain(int c, std::int64_t pos, double spb, bool retrigger) noexcept
{
    Channel& chn = ch_[c];
    const double sr = sr_;

    const double hop       = hopSamples(c, spb);
    const double hopCapped = std::min(hop, kMaxSpliceSec * sr);
    double X = std::clamp(static_cast<double>(p_.smoothingMs) * 1e-3 * sr, 1.0, kMaxSmoothSec * sr);
    X = std::min(X, hopCapped);

    std::int64_t next = boundaryFrom(c, pos + 1, spb);
    if (retrigger && static_cast<double>(next - pos) < X)
        next = boundaryFrom(c, next + 1, spb);   // a Keys retrigger this close replaces the boundary
    const std::int64_t hopToNext = std::max<std::int64_t>(1, next - pos);

    double D = p_.sync ? divisionBeats(p_.delayDiv) * spb
                       : static_cast<double>(p_.delayMs) * 1e-3 * sr;
    if (c == 1) D *= 1.0 - static_cast<double>(p_.delayOffset);
    D = std::clamp(D, 0.0, kMaxDelaySec * sr);

    const double G = hopCapped + X;
    double cents = pitchFor(c, pos, D, G);
    cents += (c == 0 ? -0.5 : 0.5) * static_cast<double>(p_.pitchOffsetCents);
    cents = std::clamp(cents, -kMaxCents, kMaxCents);
    const double t = std::pow(2.0, cents / 1200.0);

    const bool   clean   = p_.quality == Quality::Clean;
    const double stretch = std::max(1.0, t);
    const int    K = clean ? static_cast<int>(std::ceil(kSincZ * stretch)) : kHermiteHalf;
    const int    m = clean ? K + 3 : kHermiteMargin;

    const int C = static_cast<int>(std::clamp(std::floor(X), 1.0, static_cast<double>(hopToNext)));

    // Outgoing grains fade over this boundary's crossfade (or their own smoothing, if shorter).
    for (auto& g : chn.grains)
    {
        if (g.active && !g.fadingOut)
        {
            g.level0    = envelopeNow(g);
            g.fadingOut = true;
            g.fadeStart = g.tau;
            g.cOut      = std::max(1, std::min(C, g.xPlan));
        }
    }

    Grain* slot = nullptr;
    for (auto& g : chn.grains)
        if (!g.active) { slot = &g; break; }
    if (slot == nullptr)
    {
        slot = &chn.grains[0];
        for (auto& g : chn.grains)
            if (g.serial < slot->serial) slot = &g;
    }

    Grain& g = *slot;
    g = Grain{};
    g.active     = true;
    g.w0         = written_;
    g.tau        = 0;
    g.v          = p_.reverse ? -t : t;
    g.o0         = p_.reverse ? -(D + m) : -(D + m) - t * G;
    g.cIn        = C;
    g.xPlan      = static_cast<int>(std::max(1.0, std::floor(X)));
    g.law        = p_.reverse ? 0.0f
                              : static_cast<float>(std::clamp(1.0 - std::fabs(cents) / 100.0, 0.0, 1.0));
    g.sustainCap = std::min<std::int64_t>(hopToNext + 2,
                                          static_cast<std::int64_t>(std::floor(kMaxSpliceSec * sr)));
    g.clean      = clean;
    g.invStretch = static_cast<float>(1.0 / stretch);
    g.K          = K;
    g.aa         = !clean && t > 1.0001;
    if (g.aa) g.aaLp.set(0.45 * sr / t, sr);
    g.serial     = ++serial_;

    chn.nextBoundary = next;
    chn.lastSpawnPos = pos;
    chn.lastHop      = hopToNext;
    chn.latchedCents = static_cast<float>(cents);

    spawnLog_[spawnTotal_ % kSpawnLogSize] = SpawnRecord{ pos, c, static_cast<float>(cents), retrigger };
    ++spawnTotal_;
}

// ── Clock ───────────────────────────────────────────────────────────────────

std::int64_t Core::resolveClock(std::int64_t published, int n) noexcept
{
    std::int64_t pos = published;
    if (!clockValid_)
    {
        restartSchedule(pos);
    }
    else if (published == expectedPos_)
    {
        // contiguous playback
    }
    else if (published == lastPublished_)
    {
        // The transport stopped publishing (a pattern audition runs the chain while stopped):
        // free-run from where the last block ended.
        pos = expectedPos_;
    }
    else if (published > expectedPos_)
    {
        // Skipped blocks: the mixer stops an idle track's chain. Advance the tape over the gap.
        jumpForward(published - expectedPos_, published);
        restartSchedule(pos);
    }
    else
    {
        // Backwards with no reset from the host: start clean.
        reset();
        restartSchedule(pos);
    }
    lastPublished_ = published;
    expectedPos_   = pos + n;
    clockValid_    = true;
    return pos;
}

void Core::jumpForward(std::int64_t gap, std::int64_t newPos) noexcept
{
    written_ += gap;
    ringPos_ = static_cast<int>((static_cast<std::int64_t>(ringPos_) + gap % N_) % N_);
    validFrom_ = written_;   // the skipped span (and anything older) reads as silence

    for (auto& c : ch_)
    {
        for (auto& g : c.grains) g.active = false;
        c.hp.clear();
        c.lp.clear();
    }
    for (Smooth* s : { &recycle_, &lowCut_, &highCut_, &inGain_, &outGain_, &mix_, &dynAmount_ })
        s->snapToTarget();
    mixForGains_ = -1.0f;
    detEnv_   = 0.0f;
    dynAbove_ = false;
    dynG_     = dynSilenceTarget();
    if (retrigPending_ && retrigAt_ < newPos) retrigPending_ = false;
    updateToneCoefficients();
}

// ── Rendering ───────────────────────────────────────────────────────────────

float Core::envelopeNow(const Grain& g) const noexcept
{
    if (g.fadingOut)
    {
        const std::int64_t k = g.tau - g.fadeStart;
        if (k >= g.cOut) return 0.0f;
        const double x = static_cast<double>(k) / static_cast<double>(g.cOut);
        const double law = static_cast<double>(g.law);
        return g.level0 * static_cast<float>((1.0 - law) * std::cos(0.5 * kPi * x) + law * (1.0 - x));
    }
    if (g.tau < g.cIn)
    {
        const double x = static_cast<double>(g.tau) / static_cast<double>(g.cIn);
        const double law = static_cast<double>(g.law);
        return static_cast<float>((1.0 - law) * std::sin(0.5 * kPi * x) + law * x);
    }
    return 1.0f;
}

float Core::tapeAt(const float* ring, std::int64_t abs) const noexcept
{
    if (abs < validFrom_ || abs >= written_ || abs < written_ - N_) return 0.0f;
    const auto delta = static_cast<int>(written_ - abs);
    int idx = ringPos_ - delta;
    if (idx < 0) idx += N_;
    return ring[kGuard + idx];
}

float Core::readHermite(const float* ring, std::int64_t ip, float frac) const noexcept
{
    float ym1, y0, y1, y2;
    const std::int64_t lo = ip - 1, hi = ip + 2;
    if (lo >= validFrom_ && lo >= written_ - N_ && hi < written_)
    {
        const auto delta = static_cast<int>(written_ - ip);
        int idx = ringPos_ - delta;
        if (idx < 0) idx += N_;
        const float* b = ring + kGuard + idx;
        ym1 = b[-1]; y0 = b[0]; y1 = b[1]; y2 = b[2];
    }
    else
    {
        if (hi < validFrom_ || lo >= written_ || hi < written_ - N_) return 0.0f;
        ym1 = tapeAt(ring, ip - 1);
        y0  = tapeAt(ring, ip);
        y1  = tapeAt(ring, ip + 1);
        y2  = tapeAt(ring, ip + 2);
    }
    const float c1 = 0.5f * (y1 - ym1);
    const float c2 = ym1 - 2.5f * y0 + 2.0f * y1 - 0.5f * y2;
    const float c3 = 0.5f * (y2 - ym1) + 1.5f * (y0 - y1);
    return ((c3 * frac + c2) * frac + c1) * frac + y0;
}

float Core::readSinc(const float* ring, std::int64_t ip, float frac, const Grain& g) const noexcept
{
    const int K = g.K;
    const std::int64_t lo = ip - K + 1, hi = ip + K;
    const float scale    = static_cast<float>(kSincRes) * g.invStretch;
    const int   tableMax = kSincZ * kSincRes;
    const float* T = sinc_.data();
    float acc = 0.0f, wsum = 0.0f;

    if (lo >= validFrom_ && lo >= written_ - N_ && hi < written_)
    {
        const auto delta = static_cast<int>(written_ - ip);
        int idx = ringPos_ - delta;
        if (idx < 0) idx += N_;
        const float* b = ring + kGuard + idx;
        for (int k = -K + 1; k <= K; ++k)
        {
            const float u = std::fabs(static_cast<float>(k) - frac) * scale;
            const int   i = static_cast<int>(u);
            if (i >= tableMax) continue;
            const float f = u - static_cast<float>(i);
            const float w = T[i] + f * (T[i + 1] - T[i]);
            acc  += w * b[k];
            wsum += w;
        }
    }
    else
    {
        if (hi < validFrom_ || lo >= written_ || hi < written_ - N_) return 0.0f;
        for (int k = -K + 1; k <= K; ++k)
        {
            const float u = std::fabs(static_cast<float>(k) - frac) * scale;
            const int   i = static_cast<int>(u);
            if (i >= tableMax) continue;
            const float f = u - static_cast<float>(i);
            const float w = T[i] + f * (T[i + 1] - T[i]);
            acc  += w * tapeAt(ring, ip + k);
            wsum += w;
        }
    }
    return wsum > 0.0f ? acc / wsum : 0.0f;
}

float Core::renderGrain(Grain& g, const float* ring) noexcept
{
    if (!g.fadingOut && g.tau >= g.sustainCap)
    {
        // No boundary came (a long Sync splice past the 2 s cap): fade out on its own.
        g.level0    = envelopeNow(g);
        g.fadingOut = true;
        g.fadeStart = g.tau;
        g.cOut      = g.xPlan;
    }
    if (g.fadingOut && g.tau - g.fadeStart >= g.cOut)
    {
        g.active = false;
        return 0.0f;
    }

    const float  env = envelopeNow(g);
    const double o   = g.o0 + g.v * static_cast<double>(g.tau);
    const double fl  = std::floor(o);
    const std::int64_t ip = g.w0 + static_cast<std::int64_t>(fl);
    const float frac = static_cast<float>(o - fl);

    float s = g.clean ? readSinc(ring, ip, frac, g) : readHermite(ring, ip, frac);
    if (g.aa) s = g.aaLp.lp(s);
    ++g.tau;
    return s * env;
}

void Core::writeTape(int c, float x) noexcept
{
    float* r = ch_[c].ring.data() + kGuard;
    r[ringPos_] = x;
    if (ringPos_ < kGuard)       r[N_ + ringPos_] = x;
    if (ringPos_ >= N_ - kGuard) r[ringPos_ - N_] = x;
}

double Core::reachSamples() const noexcept
{
    const double spb = spb_ > 0.0 ? spb_ : 60.0 * sr_ / 140.0;
    const double H = std::min(std::max(hopSamples(0, spb), hopSamples(1, spb)), kMaxSpliceSec * sr_);
    const double X = std::min(static_cast<double>(p_.smoothingMs) * 1e-3 * sr_, kMaxSmoothSec * sr_);
    const double D = std::min(p_.sync ? divisionBeats(p_.delayDiv) * spb
                                      : static_cast<double>(p_.delayMs) * 1e-3 * sr_,
                              kMaxDelaySec * sr_);
    const double t = (p_.pitchSource == PitchSource::Knob)
        ? std::pow(2.0, std::min(kMaxCents, std::fabs(static_cast<double>(p_.pitchCents))
                                            + 0.5 * std::fabs(static_cast<double>(p_.pitchOffsetCents))) / 1200.0)
        : kMaxStretch;
    return D + (1.0 + t) * (H + X) + 4.0 * kGuard;
}

void Core::process(float* left, float* right, int n, const BlockContext& ctx) noexcept
{
    if (N_ <= 0 || n <= 0 || left == nullptr || right == nullptr) return;

    const double bpm = (ctx.bpm > 1.0 && std::isfinite(ctx.bpm)) ? ctx.bpm : 140.0;
    spb_          = 60.0 * sr_ / bpm;
    barBeats_     = ctx.barBeats > 0.0 ? ctx.barBeats : 4.0;
    keysFromHost_ = ctx.keysFromHost;

    const std::int64_t pos0 = resolveClock(ctx.transportPos, n);

    const bool  keysMode = p_.pitchSource == PitchSource::Keys;
    const float thrHi    = dbToGain(p_.dynThresholdDb);
    const float thrLo    = thrHi * kHysteresis;
    const bool  fbGated  = p_.dynTarget != DynTarget::Output;
    const bool  outGated = p_.dynTarget != DynTarget::Feedback;

    float* ring0 = ch_[0].ring.data();
    float* ring1 = ch_[1].ring.data();

    int hostIdx = 0, keyIdx = 0;
    float peak0 = 0.0f, peak1 = 0.0f, minG = 1.0f;

    for (int i = 0; i < n; ++i)
    {
        const std::int64_t pos = pos0 + i;

        // ── Notes (before any splice on this sample, so a note ON a boundary counts) ──
        while (hostIdx < ctx.numHostNotes && ctx.hostNotes[hostIdx].offset <= i)
        {
            const bool opened = host_.push(pos, ctx.hostNotes[hostIdx].note, chordWindow_);
            if (opened && keysMode && keysFromHost_)
            {
                retrigPending_ = true;
                retrigAt_      = pos + chordWindow_;
            }
            ++hostIdx;
        }
        if (!keysFromHost_)
        {
            while (keyIdx < ctx.numKeyNotes && ctx.keyNotes[keyIdx].offset <= i)
            {
                const bool opened = keys_.push(pos, ctx.keyNotes[keyIdx].note, chordWindow_);
                if (opened && keysMode)
                {
                    retrigPending_ = true;
                    retrigAt_      = pos + chordWindow_;
                }
                ++keyIdx;
            }
        }

        // ── Smoothed controls ───────────────────────────────────────────────
        const float rec  = recycle_.next();
        lowCut_.next();
        highCut_.next();
        const float inG  = inGain_.next();
        const float outG = outGain_.next();
        const float mixV = mix_.next();
        const float dynA = dynAmount_.next();
        if ((pos & (kCoeffGrid - 1)) == 0)
        {
            updateToneCoefficients();
            for (auto& c : ch_) { c.hp.snap(); c.lp.snap(); }
        }
        if (mixV != mixForGains_)
        {
            if (mixV <= 0.0f)      { dryGain_ = 1.0f; wetGain_ = 0.0f; }
            else if (mixV >= 1.0f) { dryGain_ = 0.0f; wetGain_ = 1.0f; }
            else
            {
                const double a = 0.5 * kPi * static_cast<double>(mixV);
                dryGain_ = static_cast<float>(std::cos(a));
                wetGain_ = static_cast<float>(std::sin(a));
            }
            mixForGains_ = mixV;
        }

        // ── Splices ─────────────────────────────────────────────────────────
        bool retrig = false;
        if (retrigPending_ && pos >= retrigAt_)
        {
            retrig = true;
            retrigPending_ = false;
        }
        for (int c = 0; c < 2; ++c)
            if (retrig || pos >= ch_[c].nextBoundary)
                spawnGrain(c, pos, spb_, retrig);

        // ── Gate / Duck (keyed by the dry input) ────────────────────────────
        const float xl = left[i];
        const float xr = right[i];
        const float det = std::max(std::fabs(xl), std::fabs(xr));
        detEnv_ += (det > detEnv_ ? detAtk_ : detRel_) * (det - detEnv_);
        if (detEnv_ < kDetectorSnap) detEnv_ = 0.0f;
        if (dynAbove_) { if (detEnv_ < thrLo) dynAbove_ = false; }
        else if (detEnv_ > thrHi) dynAbove_ = true;
        const float depth = std::fabs(dynA);
        float target = 1.0f;
        if (dynA < 0.0f)      target = dynAbove_ ? 1.0f : 1.0f - depth;   // gate
        else if (dynA > 0.0f) target = dynAbove_ ? 1.0f - depth : 1.0f;   // duck
        const float gBefore = dynG_;
        dynG_ += (dynAbove_ ? gAtk_ : gRel_) * (target - dynG_);
        if (dynG_ == gBefore || std::fabs(target - dynG_) <= 1e-6f) dynG_ = target;   // see Smooth::next
        minG = std::min(minG, dynG_);
        const float gOut = outGated ? dynG_ : 1.0f;
        const float gFb  = fbGated  ? dynG_ : 1.0f;

        // ── Grains ──────────────────────────────────────────────────────────
        float w0 = 0.0f, w1 = 0.0f;
        for (auto& g : ch_[0].grains) if (g.active) w0 += renderGrain(g, ring0);
        for (auto& g : ch_[1].grains) if (g.active) w1 += renderGrain(g, ring1);

        // ── Tone (in the loop) ──────────────────────────────────────────────
        if (hpOn_) { w0 = ch_[0].hp.hp(w0); w1 = ch_[1].hp.hp(w1); }
        if (lpOn_) { w0 = ch_[0].lp.lp(w0); w1 = ch_[1].lp.lp(w1); }

        // ── Recycle ─────────────────────────────────────────────────────────
        const float fb0 = softClip(w0) * rec * gFb;
        const float fb1 = softClip(w1) * rec * gFb;
        float in0 = fb0, in1 = fb1;
        if (p_.fbMode == FeedbackMode::PingPong) { in0 = fb1; in1 = fb0; }
        else if (p_.fbMode == FeedbackMode::Mixed) { in0 = in1 = 0.5f * (fb0 + fb1); }

        // ── Tape (written after every read of this sample) ──────────────────
        if (!p_.freeze)
        {
            float t0 = xl * inG + in0;
            float t1 = xr * inG + in1;
            if (std::fabs(t0) < kTapeFloor) t0 = 0.0f;
            if (std::fabs(t1) < kTapeFloor) t1 = 0.0f;
            writeTape(0, t0);
            writeTape(1, t1);
            if (t0 != 0.0f || t1 != 0.0f) lastNonZero_ = written_;
            ++written_;
            if (++ringPos_ == N_) ringPos_ = 0;
        }

        // ── Out ─────────────────────────────────────────────────────────────
        const float y0 = w0 * outG * gOut;
        const float y1 = w1 * outG * gOut;
        peak0 = std::max(peak0, std::fabs(y0));
        peak1 = std::max(peak1, std::fabs(y1));
        left[i]  = xl * dryGain_ + y0 * wetGain_;
        right[i] = xr * dryGain_ + y1 * wetGain_;
    }

    wetPeak_[0]      = peak0;
    wetPeak_[1]      = peak1;
    blockMinDynGain_ = minG;
    blockEndPos_     = pos0 + n;

    // ── Idle: nothing left that could ever sound without new input ──────────
    bool idle = peak0 == 0.0f && peak1 == 0.0f && detEnv_ == 0.0f && dynG_ == dynSilenceTarget()
             && ch_[0].hp.settled() && ch_[1].hp.settled() && ch_[0].lp.settled() && ch_[1].lp.settled();
    if (idle && lastNonZero_ >= validFrom_
        && static_cast<double>(written_ - 1 - lastNonZero_) < reachSamples())
        idle = false;
    if (idle)
        for (const auto& c : ch_)
            for (const auto& g : c.grains)
                if (g.active && g.aa && !g.aaLp.settled()) idle = false;
    idle_ = idle;
}

// ── Telemetry ───────────────────────────────────────────────────────────────

float Core::splicePhase(int ch) const noexcept
{
    const Channel& c = ch_[ch & 1];
    const double ph = static_cast<double>(blockEndPos_ - c.lastSpawnPos) / static_cast<double>(std::max<std::int64_t>(1, c.lastHop));
    return static_cast<float>(std::clamp(ph, 0.0, 1.0));
}

int Core::lastHostNote() const noexcept
{
    const Frame* f = host_.newest();
    return f ? f->hi : -1;
}

int Core::lastKeyNote() const noexcept
{
    const Frame* f = keysFromHost_ ? host_.newest() : keys_.newest();
    return f ? f->hi : -1;
}

int Core::activeGrains(int ch) const noexcept
{
    int n = 0;
    for (const auto& g : ch_[ch & 1].grains)
        if (g.active) ++n;
    return n;
}

} // namespace xleth::dsp::szkrezh
