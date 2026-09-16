// test_pattern_fx_transpose.cpp — Pitch Shifter Clip mode (mode 4) on PATTERN
// tracks: a per-track transpose applied at the Sampler voice spawn, driven by
// the published SourceTransform table.
//
// Build: see engine/CMakeLists.txt target "test_pattern_fx_transpose"
// Run:   ctest --test-dir build -C Release -R "^test_pattern_fx_transpose$" -V
// Pass:  prints "ALL TESTS PASSED" and exits 0
//
// WHAT THIS GUARDS
//
//   [1] Pitch: a sustained sine pattern rendered through MixEngine with a
//       Clip-mode shifter on the track measures (zero-crossing fundamental) at
//       note + semis + cents/100 to well within 1 Hz, for -12/-5/+7/+24 st,
//       ±33/±100 c and a mixed +7 st -33 c. Mix / clip_method / clip_formant
//       are inert: Mix 0, another method and formant on all measure the same.
//   [2] Pairing: voice count returns to 0 after every phrase — poly chord,
//       mono overlap + group slide, poly slide — and across a table change
//       landing mid-phrase (activate, retune, deactivate).
//   [3] VIDEO GATE: OfflineRenderer::buildVideoEvents (flip resolver included)
//       is hash-identical with the transform active vs inactive, before/after a
//       full audio render.
//   [4] Pattern.notes byte-identical and the UndoManager stack unchanged across
//       a full mode-4 add / change / remove cycle.
//   [5] Zero allocations attributable to the transpose on the pattern audio
//       path (differential: same chain active vs inactive).
//   [6] Deactivate mid-phrase: the ringing voice keeps the transposed pitch,
//       the next voice sounds dry (asserted on the audio AND on voice state).

#include "audio/MixEngine.h"
#include "audio/ClipRenderCache.h"
#include "audio/Sampler.h"
#include "commands/TimelineCommands.h"
#include "commands/UndoManager.h"
#include "model/Timeline.h"
#include "model/TimelineTypes.h"
#include "render/OfflineRenderer.h"
#include "SampleBank.h"
#include "SyncManager.h"   // VideoEvent
#include "Transport.h"

#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_core/juce_core.h>
#include <juce_events/juce_events.h>
#include <juce_gui_basics/juce_gui_basics.h>

#include <atomic>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <iomanip>
#include <iostream>
#include <memory>
#include <new>
#include <string>
#include <vector>

// ─── Counting allocator (this thread only, only while armed) ────────────────

namespace {
thread_local bool      t_countAllocs = false;
std::atomic<long long> g_allocCount { 0 };

inline void countAlloc() noexcept
{
    if (t_countAllocs) g_allocCount.fetch_add(1, std::memory_order_relaxed);
}
} // namespace

void* operator new(std::size_t n)                 { countAlloc(); void* p = std::malloc(n ? n : 1); if (!p) std::abort(); return p; }
void* operator new[](std::size_t n)               { countAlloc(); void* p = std::malloc(n ? n : 1); if (!p) std::abort(); return p; }
void* operator new(std::size_t n, const std::nothrow_t&) noexcept   { countAlloc(); return std::malloc(n ? n : 1); }
void* operator new[](std::size_t n, const std::nothrow_t&) noexcept { countAlloc(); return std::malloc(n ? n : 1); }
void  operator delete(void* p) noexcept                    { std::free(p); }
void  operator delete[](void* p) noexcept                  { std::free(p); }
void  operator delete(void* p, std::size_t) noexcept       { std::free(p); }
void  operator delete[](void* p, std::size_t) noexcept     { std::free(p); }
void  operator delete(void* p, const std::nothrow_t&) noexcept   { std::free(p); }
void  operator delete[](void* p, const std::nothrow_t&) noexcept { std::free(p); }

// ─── Harness ─────────────────────────────────────────────────────────────────

static int g_passed = 0;
static int g_failed = 0;

#define CHECK(cond, msg)                                                 \
    do {                                                                 \
        if (cond) {                                                      \
            ++g_passed;                                                  \
        } else {                                                         \
            std::cerr << "  FAIL [" << __LINE__ << "] " << msg << "\n";  \
            ++g_failed;                                                  \
        }                                                                \
    } while (0)

namespace {

constexpr double kRate  = 48000.0;
constexpr double kBpm   = 120.0;          // 1 beat = 0.5 s = 24000 samples
constexpr int    kBlock = 512;
constexpr int    kRoot  = 69;             // the sample is an A4 sine
constexpr double kToneHz = 440.0;

double noteHz(double semis) { return kToneHz * std::pow(2.0, (semis - kRoot) / 12.0); }
int64_t beatSample(double beats) { return static_cast<int64_t>(std::llround(beats * 60.0 / kBpm * kRate)); }

struct NoteSpec { double pos; double dur; int pitch; bool slide = false; };

struct Rig
{
    std::unique_ptr<Timeline>   timeline;
    std::unique_ptr<SampleBank> bank;
    std::unique_ptr<MixEngine>  engine;
    Transport transport;
    int trackId = -1, regionId = -1, patternId = -1, nodeId = -1;
    int64_t pos = 0;

    Sampler* sampler() { return engine->getSamplerPtr(trackId, regionId); }

    void poll() { engine->pollSourceTransformTableAt(ClipRenderCache::nowMs(), /*blocking=*/true); }

    void setFx(const char* id, float v) { engine->setEffectParameter(trackId, nodeId, id, v); }

    // Render until `endSample` (absolute), appending into `out` when given.
    void renderTo(int64_t endSample, juce::AudioBuffer<float>* out = nullptr)
    {
        juce::AudioBuffer<float> block(2, kBlock);
        while (pos < endSample)
        {
            const int n = static_cast<int>(std::min<int64_t>(kBlock, endSample - pos));
            block.clear();
            engine->processBlock(block, n, transport);
            if (out != nullptr)
                out->copyFrom(0, static_cast<int>(pos), block, 0, 0, n);
            transport.advance(n);
            pos += n;
        }
    }
};

// Fake video source so the timeline also yields real pattern VideoEvents.
int addRegion(Timeline& tl, bool mono)
{
    SourceMedia src{};
    src.filePath = "/fake/pattern_fx.mp4"; src.fileName = "pattern_fx.mp4";
    src.width = 1920; src.height = 1080; src.fps = 30.0; src.duration = 10.0;
    src.totalFrames = 300; src.hasVideo = true; src.proxyReady = false;
    const int srcId = tl.addSource(src);

    SampleRegion region{};
    region.sourceId = srcId;
    region.name = "sine"; region.label = SampleLabel::Pitch;
    region.startTime = 0.0; region.endTime = 1.0; region.startFrame = 0; region.endFrame = 30;
    region.slot(0).rootNote = kRoot;
    region.crossfadeEnabled = true;                      // sustained
    region.monoEnabled = mono;
    region.modulation.envs[0].release.ms = 5.0f;         // voices end promptly
    return tl.addRegion(region);
}

std::unique_ptr<Rig> buildRig(const std::vector<NoteSpec>& notes, double blockBeats,
                              bool shifter, int semis, int cents, bool mono = false,
                              float mix = 1.0f, int methodChoice = 1, bool formant = false)
{
    auto r = std::make_unique<Rig>();
    r->timeline = std::make_unique<Timeline>(kBpm, kRate, 4, 4);

    r->regionId = addRegion(*r->timeline, mono);

    TrackInfo t{}; t.name = "pat"; t.type = TrackInfo::Type::Pattern;
    t.volume = 1.0f; t.pan = 0.0f; t.videoOpacity = 1.0f;
    VideoFlipConfig cfg; cfg.enabled = true;
    cfg.modifier.type = VideoFlipModifier::Type::NewNote;   // pitch-dependent resolver
    cfg.states.push_back({ "a", Orientation::None, "" });
    cfg.states.push_back({ "b", Orientation::Horizontal, "" });
    cfg.states.push_back({ "c", Orientation::Vertical, "" });
    t.videoFlipConfig = cfg;
    r->trackId = r->timeline->addTrack(t);

    Pattern p{}; p.name = "p"; p.regionId = r->regionId; p.length = TickTime::fromBeats(blockBeats);
    int id = 1;
    for (const auto& ns : notes)
    {
        PatternNote n{};
        n.id = id++; n.position = TickTime::fromBeats(ns.pos); n.duration = TickTime::fromBeats(ns.dur);
        n.pitch = ns.pitch; n.velocity = 1.0f; n.isSlide = ns.slide;
        p.notes.push_back(n);
    }
    p.nextNoteId = id;
    r->patternId = r->timeline->addPattern(p);

    PatternBlock b{}; b.trackId = r->trackId; b.patternId = r->patternId;
    b.position = TickTime{0}; b.duration = TickTime::fromBeats(blockBeats);
    r->timeline->addPatternBlock(b);

    // 8 s A4 sine: +24 st reads it 4x, still 2 s of material.
    const int n = static_cast<int>(kRate * 8.0);
    juce::AudioBuffer<float> sine(1, n);
    for (int i = 0; i < n; ++i)
        sine.setSample(0, i, static_cast<float>(0.5 * std::sin(2.0 * juce::MathConstants<double>::pi * kToneHz * i / kRate)));

    r->bank = std::make_unique<SampleBank>();
    const int sampleId = r->bank->addSampleFromBuffer(sine, kRate, "sine");

    r->engine = std::make_unique<MixEngine>();
    r->engine->setTimeline(r->timeline.get());
    r->engine->setSampleBank(r->bank.get());
    r->engine->mapRegionToSample(r->regionId, sampleId);
    r->engine->rebuildAllSamplers();
    r->engine->prepare(kRate, kBlock);

    if (shifter)
    {
        r->nodeId = r->engine->addEffect(r->trackId, "pitchshifter", 0);
        r->setFx("mode", 3.0f);
        r->setFx("clip_semitones", static_cast<float>(semis));
        r->setFx("clip_cents", static_cast<float>(cents));
        r->setFx("clip_method", static_cast<float>(methodChoice));
        r->setFx("clip_formant", formant ? 1.0f : 0.0f);
        r->setFx("mix", mix);
        r->poll();
        r->engine->prepare(kRate, kBlock);
    }

    r->transport.setSampleRate(kRate);
    r->transport.setBPM(kBpm);
    r->transport.seekToSample(0);
    r->transport.play();
    return r;
}

// Fundamental from rising zero crossings (linear interpolation) over [a, b).
double measureHz(const juce::AudioBuffer<float>& buf, int64_t a, int64_t b)
{
    const float* x = buf.getReadPointer(0);
    double first = -1.0, last = -1.0;
    long long count = 0;
    for (int64_t i = a + 1; i < b; ++i)
    {
        const float y0 = x[i - 1], y1 = x[i];
        if (y0 < 0.0f && y1 >= 0.0f)
        {
            const double t = static_cast<double>(i - 1) + static_cast<double>(y0) / static_cast<double>(y0 - y1);
            if (first < 0.0) first = t;
            last = t;
            ++count;
        }
    }
    if (count < 2) return 0.0;
    return static_cast<double>(count - 1) * kRate / (last - first);
}

// Middle 60 % of [startBeat, endBeat).
double measureNote(const juce::AudioBuffer<float>& buf, double startBeat, double endBeat)
{
    const int64_t a = beatSample(startBeat), b = beatSample(endBeat);
    const int64_t pad = (b - a) / 5;
    return measureHz(buf, a + pad, b - pad);
}

std::uint64_t fnv(std::uint64_t h, const void* p, std::size_t n)
{
    const auto* c = static_cast<const unsigned char*>(p);
    for (std::size_t i = 0; i < n; ++i) { h ^= c[i]; h *= 1099511628211ULL; }
    return h;
}

std::uint64_t hashNotes(const Pattern& p)
{
    std::uint64_t h = 1469598103934665603ULL;
    h = fnv(h, &p.nextNoteId, sizeof p.nextNoteId);
    h = fnv(h, &p.length.ticks, sizeof p.length.ticks);
    for (const auto& n : p.notes)
    {
        h = fnv(h, &n.id, sizeof n.id);
        h = fnv(h, &n.position.ticks, sizeof n.position.ticks);
        h = fnv(h, &n.duration.ticks, sizeof n.duration.ticks);
        h = fnv(h, &n.pitch, sizeof n.pitch);
        h = fnv(h, &n.velocity, sizeof n.velocity);
        h = fnv(h, &n.isSlide, sizeof n.isSlide);
        h = fnv(h, &n.slideCurveCx, sizeof n.slideCurveCx);
        h = fnv(h, &n.slideCurveCy, sizeof n.slideCurveCy);
    }
    return h;
}

std::uint64_t hashVideoEvents(const Timeline& tl, std::size_t* countOut = nullptr)
{
    std::vector<SlideAnimationEvent> slides;
    const auto events = OfflineRenderer::buildVideoEvents(tl, &slides, kRate);
    if (countOut) *countOut = events.size();
    std::uint64_t h = 1469598103934665603ULL;
    for (const auto& e : events)
    {
        h = fnv(h, &e.startBeat, sizeof e.startBeat);
        h = fnv(h, &e.durationBeats, sizeof e.durationBeats);
        h = fnv(h, &e.sourceId, sizeof e.sourceId);
        h = fnv(h, &e.trackId, sizeof e.trackId);
        h = fnv(h, &e.sourceStartTime, sizeof e.sourceStartTime);
        h = fnv(h, &e.layerIndex, sizeof e.layerIndex);
        h = fnv(h, &e.opacity, sizeof e.opacity);
        h = fnv(h, &e.globalNoteIndex, sizeof e.globalNoteIndex);
        h = fnv(h, &e.sourceTriggerOrder, sizeof e.sourceTriggerOrder);
        h = fnv(h, &e.originalEmissionOrder, sizeof e.originalEmissionOrder);
        h = fnv(h, &e.sourceEndTime, sizeof e.sourceEndTime);
        h = fnv(h, &e.regionId, sizeof e.regionId);
        h = fnv(h, &e.pitch, sizeof e.pitch);
        h = fnv(h, &e.monoOrdinal, sizeof e.monoOrdinal);
        h = fnv(h, &e.stateIndex, sizeof e.stateIndex);
        h = fnv(h, &e.orientation, sizeof e.orientation);
    }
    const std::size_t nSlides = slides.size();
    return fnv(h, &nSlides, sizeof nSlides);
}

} // namespace

// ─── [1] Measured fundamental == note + semis + cents/100 ──────────────────

static void testMeasuredPitch()
{
    std::cout << "\n[1] measured fundamental == note + semis + cents/100 (to the Hz)\n";

    // Two sustained notes, separated so each is measured alone.
    const std::vector<NoteSpec> notes = { { 0.0, 1.0, 57 }, { 1.5, 1.0, 69 } };
    struct Case { int semis; int cents; };
    const Case cases[] = { {0,0}, {-12,0}, {-5,0}, {7,0}, {24,0}, {0,33}, {0,-33}, {0,100}, {0,-100}, {7,-33} };

    std::cout << "    semis cents  note  expected Hz   measured Hz   err Hz\n";
    double worst = 0.0;
    for (const auto& c : cases)
    {
        auto r = buildRig(notes, 3.0, /*shifter=*/true, c.semis, c.cents);
        juce::AudioBuffer<float> out(2, static_cast<int>(beatSample(3.0)));
        out.clear();
        r->renderTo(beatSample(3.0), &out);

        CHECK(std::abs(r->sampler()->transposeOffsetSemis() - (c.semis + c.cents / 100.0)) < 1e-12,
              "sampler offset == semis + cents/100 exactly (double)");

        const double spans[2][2] = { { 0.0, 1.0 }, { 1.5, 2.5 } };
        for (int k = 0; k < 2; ++k)
        {
            const double expected = noteHz(notes[static_cast<size_t>(k)].pitch + c.semis + c.cents / 100.0);
            const double measured = measureNote(out, spans[k][0], spans[k][1]);
            const double err = measured - expected;
            worst = std::max(worst, std::abs(err));
            std::cout << "    " << std::setw(5) << c.semis << std::setw(6) << c.cents
                      << std::setw(6) << notes[static_cast<size_t>(k)].pitch
                      << std::fixed << std::setprecision(4)
                      << std::setw(13) << expected << std::setw(14) << measured
                      << std::setw(9) << err << "\n" << std::defaultfloat;
            CHECK(std::abs(err) < 1.0, "fundamental within 1 Hz of note+semis+cents/100 ("
                  << c.semis << " st " << c.cents << " c, note " << notes[static_cast<size_t>(k)].pitch << ")");
        }
    }
    std::cout << "    worst |err| = " << worst << " Hz\n";

    // Inert controls: Mix 0, a different method and formant on must sound
    // exactly like the plain transpose.
    auto renderWith = [&](float mix, int method, bool formant)
    {
        auto r = buildRig(notes, 3.0, true, 7, 0, false, mix, method, formant);
        juce::AudioBuffer<float> out(2, static_cast<int>(beatSample(3.0)));
        out.clear();
        r->renderTo(beatSample(3.0), &out);
        return out;
    };
    const auto ref   = renderWith(1.0f, 1, false);
    const auto mix0  = renderWith(0.0f, 1, false);
    const auto meth  = renderWith(1.0f, 4, false);
    const auto form  = renderWith(1.0f, 1, true);
    auto same = [](const juce::AudioBuffer<float>& a, const juce::AudioBuffer<float>& b)
    {
        return a.getNumSamples() == b.getNumSamples()
            && std::memcmp(a.getReadPointer(0), b.getReadPointer(0),
                           sizeof(float) * static_cast<size_t>(a.getNumSamples())) == 0;
    };
    CHECK(same(ref, mix0), "Mix is inert on a pattern track (Mix 0 == Mix 1, bit-exact)");
    CHECK(same(ref, meth), "clip_method is inert on a pattern track (bit-exact)");
    CHECK(same(ref, form), "clip_formant is inert on a pattern track (bit-exact)");
    std::cout << "    Mix 0 / method WORLD / formant on: bit-identical to the plain +7 st render\n";
}

// ─── [2] noteOn/noteOff pairing ────────────────────────────────────────────

static void testPairing()
{
    std::cout << "\n[2] voice pairing: count returns to 0 after every phrase\n";

    struct Phrase { const char* name; std::vector<NoteSpec> notes; bool mono; };
    const Phrase phrases[] = {
        { "poly chord",         { {0.0,1.0,60}, {0.0,1.0,64}, {0.0,1.0,67}, {0.5,1.0,72} }, false },
        { "poly chord + slide", { {0.0,1.5,60}, {0.0,1.5,64}, {0.5,0.5,67,true} }, false },
        { "mono overlap+slide", { {0.0,1.0,60}, {0.5,1.0,64}, {0.75,0.25,70,true}, {1.25,0.5,62} }, true },
    };

    for (const auto& ph : phrases)
    {
        for (int semis : { 0, 7, -12 })
        {
            auto r = buildRig(ph.notes, 2.0, true, semis, semis == 7 ? 33 : 0, ph.mono);
            int peak = 0;
            while (r->pos < beatSample(2.0))
            {
                r->renderTo(r->pos + kBlock);
                peak = std::max(peak, r->sampler()->activeVoiceCount());
            }
            r->renderTo(beatSample(2.5));    // release tail
            const int left = r->sampler()->activeVoiceCount();
            std::cout << "    " << std::left << std::setw(20) << ph.name << std::right
                      << " semis " << std::setw(3) << semis << "  peak voices " << peak
                      << "  after " << left << "\n";
            CHECK(peak > 0, ph.name << ": voices sounded");
            CHECK(left == 0, ph.name << ": voice count back to 0 (semis " << semis << ")");
        }
    }

    // Table changes landing MID-phrase: activate, retune, deactivate, remove.
    {
        const std::vector<NoteSpec> notes = {
            {0.0,1.0,60}, {0.0,2.0,64}, {0.5,1.0,67}, {1.0,0.5,69,true}, {1.5,1.0,71}, {2.0,1.5,55}
        };
        auto r = buildRig(notes, 4.0, true, 0, 0);     // shifter present, inactive
        CHECK(r->engine->currentSourceTransformTable()->findEntry(r->trackId) == nullptr, "starts inactive");
        r->renderTo(beatSample(0.25));
        r->setFx("clip_semitones", 5.0f); r->poll();
        r->renderTo(beatSample(0.75));
        CHECK(r->sampler()->transposeOffsetSemis() == 5.0, "activated mid-phrase");
        r->setFx("clip_semitones", -7.0f); r->poll();
        r->renderTo(beatSample(1.25));
        CHECK(r->sampler()->transposeOffsetSemis() == -7.0, "retuned mid-phrase");
        r->setFx("clip_semitones", 0.0f); r->poll();
        r->renderTo(beatSample(1.75));
        CHECK(r->sampler()->transposeOffsetSemis() == 0.0, "deactivated mid-phrase clears the offset");
        r->setFx("clip_semitones", 12.0f); r->poll();
        r->renderTo(beatSample(2.25));
        CHECK(r->sampler()->transposeOffsetSemis() == 12.0, "re-activated");
        CHECK(r->engine->removeEffect(r->trackId, r->nodeId), "remove shifter");
        r->poll();
        r->renderTo(beatSample(4.0));
        CHECK(r->sampler()->transposeOffsetSemis() == 0.0, "removed shifter clears the offset");
        r->renderTo(beatSample(4.5));
        const int left = r->sampler()->activeVoiceCount();
        std::cout << "    table changes mid-phrase (0 -> +5 -> -7 -> 0 -> +12 -> removed): after " << left << "\n";
        CHECK(left == 0, "no stranded voices across mid-phrase table changes");
    }
}

// ─── [3] VIDEO GATE ────────────────────────────────────────────────────────

static void testVideoGate()
{
    std::cout << "\n[3] VIDEO GATE: video events hash-identical, transform active vs inactive\n";

    const std::vector<NoteSpec> notes = {
        {0.0,0.5,60}, {0.5,0.5,60}, {1.0,0.5,64}, {1.5,0.5,67}, {2.0,1.0,60}, {2.0,1.0,64}, {2.5,0.5,69,true}
    };
    auto r = buildRig(notes, 4.0, true, 0, 0);
    std::size_t count = 0;
    const std::uint64_t inactive = hashVideoEvents(*r->timeline, &count);

    r->setFx("clip_semitones", 7.0f); r->setFx("clip_cents", -33.0f); r->poll();
    CHECK(r->engine->currentSourceTransformTable()->findEntry(r->trackId) != nullptr, "transform active");
    const std::uint64_t activeBefore = hashVideoEvents(*r->timeline);
    r->renderTo(beatSample(4.5));
    CHECK(r->sampler()->transposeOffsetSemis() != 0.0, "audio really was transposed");
    const std::uint64_t activeAfter = hashVideoEvents(*r->timeline);

    std::cout << std::hex << "    events " << std::dec << count << std::hex
              << "  inactive 0x" << inactive << "  active 0x" << activeBefore
              << "  active+rendered 0x" << activeAfter << std::dec << "\n";
    CHECK(count >= 6, "the fixture produces pattern video events");
    CHECK(inactive == activeBefore, "video events identical, transform active vs inactive");
    CHECK(inactive == activeAfter, "video events identical after a transposed render");
}

// ─── [4] Pattern.notes + UndoManager ───────────────────────────────────────

static void testModelUntouched()
{
    std::cout << "\n[4] Pattern.notes byte-identical, UndoManager stack unchanged\n";

    const std::vector<NoteSpec> notes = { {0.0,1.0,60}, {0.0,1.0,64}, {1.0,0.5,67,true}, {2.0,1.0,57} };
    auto r = buildRig(notes, 3.0, false, 0, 0);
    UndoManager undo(100);

    // A real history entry so "unchanged" is not trivially "empty".
    PatternNote extra{}; extra.position = TickTime::fromBeats(2.5); extra.duration = TickTime::fromBeats(0.25);
    extra.pitch = 72;
    undo.execute(std::make_unique<AddNoteCommand>(r->patternId, extra), *r->timeline);

    const auto undoBefore = undo.getUndoHistory();
    const auto redoBefore = undo.getRedoHistory();
    const std::uint64_t notesBefore = hashNotes(*r->timeline->getPattern(r->patternId));
    const std::size_t   countBefore = r->timeline->getPattern(r->patternId)->notes.size();

    auto& e = *r->engine;
    r->nodeId = e.addEffect(r->trackId, "pitchshifter", 0);
    r->setFx("mode", 3.0f); r->setFx("clip_semitones", 9.0f); r->poll();
    r->renderTo(beatSample(1.5));
    r->setFx("clip_semitones", -4.0f); r->setFx("clip_cents", 50.0f); r->poll();
    r->renderTo(beatSample(2.5));
    CHECK(e.removeEffect(r->trackId, r->nodeId), "remove");
    r->poll();
    r->renderTo(beatSample(3.5));

    const std::uint64_t notesAfter = hashNotes(*r->timeline->getPattern(r->patternId));
    std::cout << std::hex << "    notes hash 0x" << notesBefore << " -> 0x" << notesAfter << std::dec
              << "  (" << countBefore << " notes)\n";
    CHECK(notesAfter == notesBefore, "Pattern.notes byte-identical after a full mode-4 cycle");
    CHECK(r->timeline->getPattern(r->patternId)->notes.size() == countBefore, "note count unchanged");

    const auto undoAfter = undo.getUndoHistory();
    const auto redoAfter = undo.getRedoHistory();
    bool same = undoAfter.size() == undoBefore.size() && redoAfter.size() == redoBefore.size();
    for (std::size_t i = 0; same && i < undoAfter.size(); ++i)
        same = undoAfter[i].description == undoBefore[i].description
            && undoAfter[i].domain == undoBefore[i].domain;
    std::cout << "    undo " << undoBefore.size() << " -> " << undoAfter.size()
              << ", redo " << redoBefore.size() << " -> " << redoAfter.size() << "\n";
    CHECK(same, "undo/redo history identical");
    CHECK(undo.getUndoCount() == 1 && undo.getRedoCount() == 0, "stack depth unchanged");
}

// ─── [5] Allocations ───────────────────────────────────────────────────────

static long long countPatternAllocs(bool shifter, int semis, double* offsetSeen = nullptr)
{
    const std::vector<NoteSpec> notes = {
        {0.0,0.5,60}, {0.0,0.5,64}, {0.5,0.5,67}, {1.0,0.25,69,true}, {1.0,1.0,55}, {2.0,0.5,72}
    };
    auto r = buildRig(notes, 3.0, shifter, semis, semis != 0 ? 25 : 0);
    // Warm pass so first-block lazy setup is outside the count, then rewind.
    r->renderTo(beatSample(3.5));
    r->transport.seekToSample(0);
    r->pos = 0;

    juce::AudioBuffer<float> block(2, kBlock);
    long long allocs = 0;
    while (r->pos < beatSample(3.5))
    {
        block.clear();
        g_allocCount.store(0);
        t_countAllocs = true;
        r->engine->processBlock(block, kBlock, r->transport);
        t_countAllocs = false;
        allocs += g_allocCount.load();
        r->transport.advance(kBlock);
        r->pos += kBlock;
    }
    if (offsetSeen) *offsetSeen = r->sampler()->transposeOffsetSemis();
    return allocs;
}

static void testAllocations()
{
    std::cout << "\n[5] zero allocations on the pattern audio path from the transpose\n";

    // processBlock already allocates on this thread at the f639c45 baseline, so
    // the transpose is proven allocation-free differentially: the SAME chain and
    // pattern with the transform inactive (Clip mode at 0 st → no table entry)
    // versus active. Any allocation the transpose adds shows up as a difference.
    const long long plain = countPatternAllocs(false, 0);
    double offOffset = 1.0, onOffset = 0.0;
    const long long off = countPatternAllocs(true, 0, &offOffset);
    const long long on  = countPatternAllocs(true, 7, &onOffset);
    std::cout << "    allocs over 3.5 beats: no shifter " << plain << ", inactive " << off
              << ", active (+7 st 25 c) " << on << "\n";
    CHECK(offOffset == 0.0 && std::abs(onOffset - 7.25) < 1e-12, "inactive run untransposed, active run transposed");
    CHECK(on == off, "transpose adds zero allocations (active == inactive)");
}

// ─── [6] Deactivate mid-phrase ─────────────────────────────────────────────

static void testDeactivateMidPhrase()
{
    std::cout << "\n[6] deactivate mid-phrase: ringing voice keeps old pitch, new voice is dry\n";

    // A (57) sounds beats 0..2.5; the table deactivates at beat 1; B (69)
    // starts at beat 2, overlaps A briefly, and is measured alone after A ends.
    const std::vector<NoteSpec> notes = { { 0.0, 2.5, 57 }, { 2.0, 2.0, 69 } };
    auto r = buildRig(notes, 4.5, true, 7, 0);
    juce::AudioBuffer<float> out(2, static_cast<int>(beatSample(4.5)));
    out.clear();

    r->renderTo(beatSample(1.0), &out);
    r->setFx("clip_semitones", 0.0f); r->poll();
    CHECK(r->engine->currentSourceTransformTable()->findEntry(r->trackId) == nullptr, "table entry gone");
    r->renderTo(beatSample(2.25), &out);

    // Voice state in the overlap: A latched +7, B latched 0.
    int withSeven = 0, withZero = 0;
    for (int v = 0; v < 32; ++v)
    {
        if (r->sampler()->debugVoiceStreamCount(v) <= 0) continue;
        const double t = r->sampler()->debugVoiceTranspose(v);
        if (t == 7.0) ++withSeven;
        else if (t == 0.0) ++withZero;
    }
    std::cout << "    overlap @2.25 beats: voices latched +7 = " << withSeven << ", latched 0 = " << withZero << "\n";
    CHECK(withSeven == 1 && withZero == 1, "ringing voice kept +7, new voice latched 0");

    r->renderTo(beatSample(4.5), &out);

    const double aBefore = measureNote(out, 0.0, 1.0);
    const double aAfter  = measureNote(out, 1.05, 1.95);   // after deactivation, alone
    const double bDry    = measureNote(out, 2.6, 4.0);     // alone, after A ended
    std::cout << std::fixed << std::setprecision(4)
              << "    A before deactivate " << aBefore << " Hz (expect " << noteHz(64) << ")\n"
              << "    A after  deactivate " << aAfter  << " Hz (expect " << noteHz(64) << ")\n"
              << "    B spawned after     " << bDry    << " Hz (expect " << noteHz(69) << ")\n"
              << std::defaultfloat;
    CHECK(std::abs(aBefore - noteHz(64)) < 1.0, "A transposed before deactivation");
    CHECK(std::abs(aAfter  - noteHz(64)) < 1.0, "ringing A keeps the old (+7) pitch after deactivation");
    CHECK(std::abs(bDry    - noteHz(69)) < 1.0, "new voice B takes the dry pitch");
    r->renderTo(beatSample(4.5));
}

int main()
{
    juce::ScopedJuceInitialiser_GUI juceInit;
    std::cout << std::unitbuf;
    std::cout << "=== test_pattern_fx_transpose ===\n";

    testMeasuredPitch();
    testPairing();
    testVideoGate();
    testModelUntouched();
    testAllocations();
    testDeactivateMidPhrase();

    std::cout << "\n" << g_passed << " passed, " << g_failed << " failed\n";
    if (g_failed == 0)
    {
        std::cout << "ALL TESTS PASSED\n";
        return 0;
    }
    return 1;
}
