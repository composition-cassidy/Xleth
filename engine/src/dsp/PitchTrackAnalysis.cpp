#include "dsp/PitchTrackAnalysis.h"
#include "dsp/LoopAnalysis.h"
#include "dsp/LoopOptimizer.h"  // kMinPitchHz / kMaxPitchHz / kAnalysisFrame

#include <juce_dsp/juce_dsp.h>

#include <algorithm>
#include <cmath>

namespace xleth::dsp {

namespace {

// Hop for the per-frame f0 curve, in seconds. Deliberately denser than
// LoopOptimizer's kAnalysisHop (512 samples, ~11-12 ms) — that hop serves
// loop-length policy, which only needs the fundamental's median; a pitch
// curve meant for note display and correction needs finer time resolution,
// and the FFT-accelerated NSDF (computeNSDFFft) keeps this affordable (a
// whole 5 s sample tracks in well under a second — see AutoLoopPolicy's own
// perf note for the 512-hop case, which this is only ~2.3x denser than).
constexpr double kHopSec = 0.005;

// A pitch jump bigger than this, from a segment's running median, starts a
// new note segment. 100 cents == 1 semitone, the brief's own cut.
constexpr double kNoteSplitCents = 100.0;

// ─── Monophonic gate thresholds ───────────────────────────────────────────────
//
// These were originally LoopOptimizer.h's kMinVoicedFrac (0.5) and
// kMinMedianClarity (0.7), borrowed on the reasoning that "pitched and
// monophonic" is one question with one answer. Measuring real material against
// them showed it is not: that pair is calibrated for SUSTAINED MUSICAL SAMPLES
// being screened for loopability, and speech fails both for reasons that have
// nothing to do with polyphony.
//
// Measured (see engine/test/test_autotune_render.cpp's WAV pass, which prints
// both numbers for any file):
//
//   material                              voicedFrac   medianClarity   verdict
//   real speech (WORLD's vaiueo2d.wav)      0.645          0.665        accept
//   one voice over a -12 dB noise bed       0.554          0.657        accept
//   one voice with 23% consonant bursts     0.346          0.760        accept
//   two sustained voices a 5th apart        0.287          0.609        REFUSE
//   three sustained voices (A major triad)  0.359          0.519        REFUSE
//
// Two things fall out of that table:
//
//  • voicedFrac does not discriminate monophonic from polyphonic AT ALL — the
//    triad scores HIGHER than a legitimate take with ordinary consonant
//    density. It answers a different question ("is there enough pitched
//    material here to be worth correcting"), which is still worth asking, so
//    it stays — with a floor set for that question rather than borrowed from
//    one it cannot answer.
//
//  • medianClarity IS the discriminator, but the two populations sit closer
//    together than 0.7 assumes: monophonic 0.657-0.760 against polyphonic
//    0.519-0.609. The floor goes between them.
//
// The margins on both sides are thin (~0.05 above, ~0.01 below), so this gate
// WILL misjudge borderline material in both directions. The floor is placed
// nearer the polyphonic side deliberately: a false refusal leaves the user with
// a feature that does not work and no way around it, while a false accept
// produces an obviously bad render that is one undo away. LoopOptimizer's own
// constants are left untouched — the Loop Lab's screening question is a
// different one and its thresholds are corpus-referenced for it.
constexpr float kMinVoicedFracAutotune    = 0.20f;
constexpr float kMinMedianClarityAutotune = 0.62f;

double medianD(std::vector<double> v)
{
    if (v.empty()) return 0.0;
    std::sort(v.begin(), v.end());
    const size_t n = v.size();
    return (n % 2 == 1) ? v[n / 2] : 0.5 * (v[n / 2 - 1] + v[n / 2]);
}

// Nearest equal-tempered note name for a frequency, e.g. 440 -> "A4". No
// existing C++ equivalent in the engine (the only midiToNoteName() in the
// repo is UI-side JS), so this is a small fresh helper rather than a reuse.
std::string hzToNoteName(double hz)
{
    static constexpr const char* kNames[12] = {
        "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"
    };
    if (!(hz > 0.0)) return {};
    const double midi = 69.0 + 12.0 * std::log2(hz / 440.0);
    const int m = (int)std::lround(midi);
    const int pitchClass = ((m % 12) + 12) % 12;
    const int octave = m / 12 - 1;  // MIDI 60 == C4
    return std::string(kNames[pitchClass]) + std::to_string(octave);
}

// Groups contiguous voiced frames into notes, splitting on an unvoiced gap
// or a >kNoteSplitCents jump from the run's own running median (so a slow
// vibrato does not fragment a single held note, but a real pitch change
// does start a new one).
std::vector<NoteSegment> segmentNotes(const std::vector<PitchFrame>& frames, int64_t hop)
{
    std::vector<NoteSegment> notes;
    size_t i = 0;
    while (i < frames.size()) {
        if (!frames[i].voiced) { ++i; continue; }

        std::vector<double> runF0{ (double)frames[i].f0Hz };
        double runningMedian = frames[i].f0Hz;
        size_t j = i + 1;
        for (; j < frames.size(); ++j) {
            if (!frames[j].voiced) break;
            const double cents = 1200.0 * std::log2((double)frames[j].f0Hz / runningMedian);
            if (std::abs(cents) > kNoteSplitCents) break;
            runF0.push_back(frames[j].f0Hz);
            runningMedian = medianD(runF0);
        }

        NoteSegment seg;
        seg.startSample = frames[i].posSample;
        seg.endSample   = frames[j - 1].posSample + hop;
        seg.medianF0Hz  = medianD(runF0);
        seg.noteName    = hzToNoteName(seg.medianF0Hz);
        notes.push_back(std::move(seg));

        i = j;
    }
    return notes;
}

} // namespace

PitchTrackResult analyzePitchTrack(const float* x, int N, double sampleRate)
{
    PitchTrackResult result;
    if (x == nullptr || N <= 0 || sampleRate <= 0.0) return result;  // valid() == false

    result.sampleRate = sampleRate;

    const int tauMin = std::max(1, (int)(sampleRate / kMaxPitchHz));
    const int tauMax = (int)(sampleRate / kMinPitchHz);
    const int64_t hop = std::max<int64_t>(1, std::lround(sampleRate * kHopSec));
    result.hopSamples = (double)hop;

    if (tauMax <= tauMin || N < kAnalysisFrame) {
        result.monophonic = false;
        result.reason = "buffer too short to analyze";
        return result;
    }

    int order = 1;
    while ((1 << order) < 2 * kAnalysisFrame) ++order;
    juce::dsp::FFT fft(order);
    std::vector<float> scratch((size_t)(1u << order) * 2u, 0.0f);

    for (int64_t s = 0; s + kAnalysisFrame <= N; s += hop) {
        const std::vector<float> nsdf =
            computeNSDFFft(x + s, kAnalysisFrame, tauMin, tauMax, fft, order, scratch);
        const int lag = detectPeriod(nsdf, tauMin);  // 0 == unvoiced

        PitchFrame f;
        f.posSample = s;
        if (lag > 0) {
            const double period = refinePeriodNSDF(nsdf, tauMin, lag);
            f.f0Hz       = (float)(sampleRate / period);
            f.confidence = nsdf[(size_t)(lag - tauMin)];
            f.voiced     = true;
        }
        result.frames.push_back(f);
    }

    // ── Monophonic gate — see kMinVoicedFracAutotune/kMinMedianClarityAutotune
    // above for why these are AUTOTUNE's own thresholds and not the Loop
    // Optimizer's, and for the measurements that placed them.
    int voicedCount = 0;
    std::vector<double> voicedClarity;
    for (const auto& f : result.frames) {
        if (f.voiced) { ++voicedCount; voicedClarity.push_back((double)f.confidence); }
    }
    const double voicedFrac =
        result.frames.empty() ? 0.0 : (double)voicedCount / (double)result.frames.size();
    const double medianClarity = medianD(voicedClarity);

    if (voicedFrac < (double)kMinVoicedFracAutotune) {
        result.monophonic = false;
        result.reason = "insufficient pitched content to analyze";
    } else if (medianClarity < (double)kMinMedianClarityAutotune) {
        // Plenty of frames clear detectPeriod's per-frame 0.5 bar, but the
        // median is weak — a muddled, competing-periodicities track, the
        // signature of simultaneous voices rather than one clean pitch.
        result.monophonic = false;
        result.reason = "pitch track too unstable to be monophonic — content may be polyphonic";
    }

    result.notes = segmentNotes(result.frames, hop);
    return result;
}

// ─── Serialization ────────────────────────────────────────────────────────

nlohmann::json PitchTrackResult::toJson() const
{
    nlohmann::json j = nlohmann::json::object();
    j["sampleRate"] = sampleRate;
    j["hopSamples"] = hopSamples;
    j["monophonic"] = monophonic;
    j["reason"]     = reason;

    nlohmann::json fr = nlohmann::json::array();
    for (const auto& f : frames) {
        nlohmann::json fj = nlohmann::json::object();
        fj["posSample"]  = f.posSample;
        fj["f0Hz"]       = f.f0Hz;
        fj["confidence"] = f.confidence;
        fj["voiced"]     = f.voiced;
        fr.push_back(std::move(fj));
    }
    j["frames"] = std::move(fr);

    nlohmann::json no = nlohmann::json::array();
    for (const auto& n : notes) {
        nlohmann::json nj = nlohmann::json::object();
        nj["startSample"] = n.startSample;
        nj["endSample"]   = n.endSample;
        nj["medianF0Hz"]  = n.medianF0Hz;
        nj["noteName"]    = n.noteName;
        no.push_back(std::move(nj));
    }
    j["notes"] = std::move(no);
    return j;
}

PitchTrackResult PitchTrackResult::fromJson(const nlohmann::json& j)
{
    PitchTrackResult r;
    if (!j.is_object()) return r;

    r.sampleRate = j.value("sampleRate", 0.0);
    r.hopSamples = j.value("hopSamples", 0.0);
    r.monophonic = j.value("monophonic", true);
    r.reason     = j.value("reason", std::string{});

    if (auto it = j.find("frames"); it != j.end() && it->is_array()) {
        for (const auto& fj : *it) {
            PitchFrame f;
            f.posSample  = fj.value("posSample", (int64_t)0);
            f.f0Hz       = fj.value("f0Hz", 0.0f);
            f.confidence = fj.value("confidence", 0.0f);
            f.voiced     = fj.value("voiced", false);
            r.frames.push_back(f);
        }
    }
    if (auto it = j.find("notes"); it != j.end() && it->is_array()) {
        for (const auto& nj : *it) {
            NoteSegment n;
            n.startSample = nj.value("startSample", (int64_t)0);
            n.endSample   = nj.value("endSample", (int64_t)0);
            n.medianF0Hz  = nj.value("medianF0Hz", 0.0);
            n.noteName    = nj.value("noteName", std::string{});
            r.notes.push_back(n);
        }
    }
    return r;
}

} // namespace xleth::dsp
