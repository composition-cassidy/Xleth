// test_slot_prep.cpp — Per-slot PREP bake + sampler loop modes.
// Build: see engine/CMakeLists.txt target "test_slot_prep"
// Run:   test_slot_prep.exe
// Pass:  prints "ALL TESTS PASSED" and exits 0
// Fail:  prints "FAILED: ..." and exits 1
//
// Covers, in order:
//   1. bake determinism — every algorithm renders identically for identical
//      inputs, and the cache serves the second call without re-running DSP
//   2. passthrough bit-identity — a bypassed PREP leaves the slot's audio
//      untouched sample-for-sample
//   3. disk tier + rebuild on a missing cache file (the "someone deleted the
//      cache folder" path)
//   4. ping-pong and reverse loop boundary behaviour
//   5. exit-loop-on-release voice lifecycle

#include "audio/Sampler.h"
#include "audio/SlotBakeCache.h"
#include "model/TimelineTypes.h"

#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_core/juce_core.h>

#include <cmath>
#include <cstring>
#include <iostream>
#include <memory>
#include <string>
#include <vector>

using xleth::audio::BakeKey;
using xleth::audio::SlotBakeCache;

// ─── Test harness ────────────────────────────────────────────────────────────

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

// ─── Utilities ───────────────────────────────────────────────────────────────

static constexpr double kEngineSR = 48000.0;

static juce::AudioBuffer<float> makeSine(double sampleRate, double freqHz,
                                         int numSamples, float amplitude = 0.5f)
{
    juce::AudioBuffer<float> buf(2, numSamples);
    const double w = 2.0 * juce::MathConstants<double>::pi * freqHz / sampleRate;
    for (int i = 0; i < numSamples; ++i) {
        const float s = static_cast<float>(amplitude * std::sin(w * i));
        buf.setSample(0, i, s);
        buf.setSample(1, i, s);
    }
    return buf;
}

// A ramp is the right probe for loop-direction tests: every sample value maps
// back to exactly one position, so the rendered output states where the read
// head was without any spectral guesswork.
static juce::AudioBuffer<float> makeRamp(int numSamples)
{
    juce::AudioBuffer<float> buf(1, numSamples);
    for (int i = 0; i < numSamples; ++i)
        buf.setSample(0, i, static_cast<float>(i) / static_cast<float>(numSamples));
    return buf;
}

static bool buffersBitIdentical(const juce::AudioBuffer<float>& a,
                                const juce::AudioBuffer<float>& b)
{
    if (a.getNumChannels() != b.getNumChannels()) return false;
    if (a.getNumSamples()  != b.getNumSamples())  return false;
    for (int ch = 0; ch < a.getNumChannels(); ++ch)
        if (std::memcmp(a.getReadPointer(ch), b.getReadPointer(ch),
                        sizeof(float) * static_cast<size_t>(a.getNumSamples())) != 0)
            return false;
    return true;
}

static BakeKey keyFor(const juce::AudioBuffer<float>& src, int algorithm,
                      float stretch, float cents)
{
    BakeKey k;
    k.sourceHash   = SlotBakeCache::hashPCM(src);
    k.algorithm    = algorithm;
    k.stretchMilli = static_cast<int32_t>(std::lround(stretch * 1000.0f));
    k.shiftCents   = static_cast<int32_t>(std::lround(cents));
    k.sampleRateHz = static_cast<int32_t>(kEngineSR);
    k.numChannels  = src.getNumChannels();
    return k;
}

// A temp directory that removes itself, so a failing assertion can't leave
// bake files behind for the next run to accidentally hit.
struct ScopedTempDir {
    juce::File dir;
    explicit ScopedTempDir(const juce::String& name)
        : dir(juce::File::getSpecialLocation(juce::File::tempDirectory)
                  .getChildFile("xleth_slot_prep_" + name
                                + juce::String(juce::Random::getSystemRandom().nextInt(1 << 30))))
    { dir.deleteRecursively(); dir.createDirectory(); }
    ~ScopedTempDir() { dir.deleteRecursively(); }
    std::string path() const { return dir.getFullPathName().toStdString(); }
};

// ─── 1. Bake determinism, per algorithm ──────────────────────────────────────

static void testBakeDeterminismPerAlgorithm()
{
    std::cout << "\n[bake determinism per algorithm]\n";

    // Short enough that WORLD (the slowest by far) stays inside a sane runtime,
    // long enough that every algorithm has real frames to work with.
    const auto src = makeSine(kEngineSR, 220.0, static_cast<int>(kEngineSR * 0.25));

    struct Algo { int id; const char* name; };
    const Algo algos[] = {
        { static_cast<int>(StretchMethod::PSOLA),        "TD-PSOLA"      },
        { static_cast<int>(StretchMethod::Rubber),       "Rubber Band"   },
        { static_cast<int>(StretchMethod::WSOLA),        "WSOLA"         },
        { static_cast<int>(StretchMethod::PhaseVocoder), "Phase Vocoder" },
        { static_cast<int>(StretchMethod::WORLD),        "WORLD"         },
    };

    for (const auto& a : algos) {
        // Memory-only cache (no dir), so this measures the algorithm, not I/O.
        SlotBakeCache cacheA;
        SlotBakeCache cacheB;
        const auto key = keyFor(src, a.id, 1.5f, 0.0f);

        auto first  = cacheA.getOrCompute(key, src);
        auto second = cacheB.getOrCompute(key, src);

        CHECK(first != nullptr && second != nullptr,
              std::string(a.name) + ": bake produced a buffer");
        if (!first || !second) continue;

        CHECK(first->getNumSamples() > 0,
              std::string(a.name) + ": bake is non-empty");
        CHECK(buffersBitIdentical(*first, *second),
              std::string(a.name) + ": two independent bakes are bit-identical");

        // Stretch actually stretched: 1.5x on a 0.25 s source. The algorithms
        // round their output length differently, so this is a band, not an
        // equality — the point is that the length MOVED, and in proportion.
        const double ratio = static_cast<double>(first->getNumSamples())
                           / static_cast<double>(src.getNumSamples());
        CHECK(ratio > 1.4 && ratio < 1.6,
              std::string(a.name) + ": 1.5x stretch lands within 1.4..1.6 (got "
              + std::to_string(ratio) + ")");

        // Second call on the SAME cache is a hit: no additional DSP run.
        const uint64_t before = cacheA.computeCount();
        auto again = cacheA.getOrCompute(key, src);
        CHECK(cacheA.computeCount() == before,
              std::string(a.name) + ": repeat call is a cache hit, no recompute");
        CHECK(again == first,
              std::string(a.name) + ": cache hit returns the same buffer");
    }

    // A different parameter is a different key — both variants stay resident,
    // which is what makes flipping a value back and forth cheap.
    SlotBakeCache cache;
    const auto k100 = keyFor(src, static_cast<int>(StretchMethod::Rubber), 1.0f, 300.0f);
    const auto k200 = keyFor(src, static_cast<int>(StretchMethod::Rubber), 1.0f, 700.0f);
    cache.getOrCompute(k100, src);
    cache.getOrCompute(k200, src);
    CHECK(cache.computeCount() == 2, "distinct shifts each bake once");
    CHECK(cache.entryCount() == 2,   "distinct shifts stay resident together");
    CHECK(cache.lookup(k100) != nullptr && cache.lookup(k200) != nullptr,
          "both variants are retrievable after the other was baked");
}

// ─── 2. Passthrough bit-identity when PREP is bypassed ───────────────────────

static void testBypassIsBitIdentical()
{
    std::cout << "\n[passthrough bit-identity]\n";

    // The model's own bypass predicate is what the engine consults, so test it
    // directly: if this drifts, buildSamplerForRegion silently starts baking.
    SampleSlot slot;
    CHECK(slot.prepIsBypassed(), "a default slot bypasses PREP");

    slot.prepStretch = 1.0f; slot.prepShiftCents = 0.0f;
    CHECK(slot.prepIsBypassed(), "unity stretch + zero shift bypasses");

    slot.prepStretch = 1.5f;
    CHECK(!slot.prepIsBypassed(), "non-unity stretch does NOT bypass");

    slot.prepStretch = 1.0f; slot.prepShiftCents = 1.0f;
    CHECK(!slot.prepIsBypassed(), "non-zero shift does NOT bypass");

    // And the audible consequence: a bypassed slot renders exactly what a slot
    // with no PREP fields at all renders. Rendering both through a real Sampler
    // is the only check that covers the whole load path, not just the flag.
    const auto src = makeSine(kEngineSR, 440.0, 4096);

    auto render = [&](bool touchPrepFields) {
        Sampler s;
        s.loadSample(src, kEngineSR, 60);
        s.setADSR(0.0f, 0.0f, 1.0f, 10.0f);
        s.setCrossfadeMode(false);
        if (touchPrepFields) {
            // Bypassed PREP must publish NO prepared buffer — nullptr restores
            // the raw sample, which is the passthrough contract.
            s.setSlotPreparedBuffer(0, nullptr);
        }
        juce::AudioBuffer<float> out(2, 2048);
        out.clear();
        s.noteOn(60, 1.0f, 0);
        s.processBlock(out, 2048, kEngineSR);
        return out;
    };

    const auto plain   = render(false);
    const auto bypassed = render(true);
    CHECK(buffersBitIdentical(plain, bypassed),
          "a bypassed slot renders bit-identically to an untouched slot");
}

// ─── 3. Disk tier: persistence, and rebuild when the file is gone ────────────

static void testDiskCacheAndRebuildOnMissingFile()
{
    std::cout << "\n[disk cache + rebuild on missing file]\n";

    ScopedTempDir tmp("cache");
    const auto src = makeSine(kEngineSR, 330.0, static_cast<int>(kEngineSR * 0.1));
    // Rubber Band: fast enough to bake three times inside a test.
    const auto key = keyFor(src, static_cast<int>(StretchMethod::Rubber), 1.25f, 0.0f);

    juce::AudioBuffer<float> firstCopy;

    {
        SlotBakeCache cache;
        cache.setCacheDir(tmp.path());
        auto baked = cache.getOrCompute(key, src);
        CHECK(baked != nullptr, "first bake produced a buffer");
        CHECK(cache.computeCount() == 1,  "first bake ran the algorithm once");
        CHECK(cache.diskWriteCount() == 1, "first bake wrote a disk entry");
        if (baked) firstCopy.makeCopyOf(*baked, true);

        const std::string path = cache.filePathForKey(key);
        CHECK(!path.empty(), "a configured cache dir yields a file path");
        CHECK(juce::File(juce::String(path)).existsAsFile(),
              "the bake file exists on disk");

        // Drop the memory tier: a fresh session's view of the same folder.
        cache.clearMemory();
        CHECK(cache.lookup(key) == nullptr, "memory tier cleared");

        auto fromDisk = cache.getOrCompute(key, src);
        CHECK(cache.computeCount() == 1,
              "a disk hit does NOT re-run the algorithm");
        CHECK(cache.diskHitCount() == 1, "the disk tier reported a hit");
        CHECK(fromDisk != nullptr && buffersBitIdentical(*fromDisk, firstCopy),
              "the disk round-trip is bit-identical to the original bake");
    }

    // ── The cache folder was deleted underneath us ────────────────────────────
    {
        SlotBakeCache cache;
        cache.setCacheDir(tmp.path());

        // Simulate "user deleted the project's cache folder": remove the entry
        // AND clear memory, so nothing can mask the missing file.
        juce::File(juce::String(cache.filePathForKey(key))).deleteFile();
        cache.clearMemory();
        CHECK(!juce::File(juce::String(cache.filePathForKey(key))).existsAsFile(),
              "bake file removed");

        auto rebuilt = cache.getOrCompute(key, src);
        CHECK(cache.computeCount() == 1, "a missing file rebakes rather than failing");
        CHECK(rebuilt != nullptr && buffersBitIdentical(*rebuilt, firstCopy),
              "the rebake reproduces the original bake exactly");
        CHECK(juce::File(juce::String(cache.filePathForKey(key))).existsAsFile(),
              "the rebake rewrote the disk entry");
    }

    // ── A corrupt / truncated file must read as a MISS, never as wrong audio ──
    {
        SlotBakeCache cache;
        cache.setCacheDir(tmp.path());
        const juce::File f{ juce::String(cache.filePathForKey(key)) };
        f.replaceWithData("not a bake file", 15);
        cache.clearMemory();

        auto rebuilt = cache.getOrCompute(key, src);
        CHECK(cache.computeCount() == 1, "a corrupt file rebakes");
        CHECK(rebuilt != nullptr && buffersBitIdentical(*rebuilt, firstCopy),
              "the rebake after corruption is still the correct audio");
    }

    // ── No cache dir → memory-only, and no files written anywhere ────────────
    {
        SlotBakeCache cache;
        CHECK(cache.filePathForKey(key).empty(),
              "no cache dir yields no file path");
        auto baked = cache.getOrCompute(key, src);
        CHECK(baked != nullptr, "a memory-only cache still bakes");
        CHECK(cache.diskWriteCount() == 0, "a memory-only cache writes nothing");
    }
}

// ─── Loop-mode probe ─────────────────────────────────────────────────────────
// Renders one note through a Sampler configured with a ramp sample and a loop,
// and returns the read-head position implied by each output sample.
//
// The sampler is set up so the rendered value IS the position: root note equals
// the played note (unity stride), no envelope shaping, no declick, no fades.

struct LoopProbe {
    std::vector<double> positions;   // recovered read-head position per sample
};

static LoopProbe probeLoop(int loopMode, int rampLen, int loopStart, int loopEnd,
                           int renderSamples, bool exitOnRelease = false,
                           int noteOffAt = -1)
{
    const auto ramp = makeRamp(rampLen);

    Sampler s;
    s.loadSample(ramp, kEngineSR, 60);
    // Full sustain, instant attack, no release shaping: envGain is exactly 1
    // for the whole render, so out == sample value.
    s.setEnvelope(0.0f, 0.0f, 0.0f, 0.0f, 1.0f, 100000.0f, 0.0f, 0.0f, 0.0f);
    s.setCrossfadeMode(true);              // sustained — required for looping
    s.setSlotTrim(0, 0, 0, /*declickMs=*/0.0f, 0.0f, 0.0f);
    s.setSlotLoop(0, /*loopEnabled=*/true, loopStart, loopEnd,
                  /*crossfadeSamples=*/0, loopMode, exitOnRelease);

    juce::AudioBuffer<float> out(2, renderSamples);
    out.clear();
    s.noteOn(60, 1.0f, 0);
    if (noteOffAt >= 0 && noteOffAt < renderSamples) {
        // Render up to the note-off, release, then render the rest — the
        // Sampler releases at sub-buffer resolution, but splitting the render
        // keeps the probe's indexing trivial.
        juce::AudioBuffer<float> head(2, noteOffAt);
        head.clear();
        s.processBlock(head, noteOffAt, kEngineSR);
        s.noteOff(60, 0, false);
        juce::AudioBuffer<float> tail(2, renderSamples - noteOffAt);
        tail.clear();
        s.processBlock(tail, renderSamples - noteOffAt, kEngineSR);
        for (int i = 0; i < noteOffAt; ++i) out.setSample(0, i, head.getSample(0, i));
        for (int i = 0; i < renderSamples - noteOffAt; ++i)
            out.setSample(0, noteOffAt + i, tail.getSample(0, i));
    } else {
        s.processBlock(out, renderSamples, kEngineSR);
    }

    LoopProbe p;
    p.positions.reserve(static_cast<size_t>(renderSamples));
    for (int i = 0; i < renderSamples; ++i)
        p.positions.push_back(static_cast<double>(out.getSample(0, i))
                              * static_cast<double>(rampLen));
    return p;
}

// ─── 4. Ping-pong and reverse boundaries ─────────────────────────────────────

static void testLoopModeBoundaries()
{
    std::cout << "\n[ping-pong / reverse boundaries]\n";

    constexpr int kLen   = 512;
    constexpr int kStart = 100;
    constexpr int kEnd   = 200;
    constexpr int kRender = 900;   // several passes through a 100-sample loop

    // ── FORWARD: strictly ascending, wrapping back to loopStart ──────────────
    {
        const auto p = probeLoop(static_cast<int>(SampleLoopMode::Forward),
                                 kLen, kStart, kEnd, kRender);
        bool everWrapped = false, everBackward = false, outOfRange = false;
        for (size_t i = 1; i < p.positions.size(); ++i) {
            const double d = p.positions[i] - p.positions[i - 1];
            if (d < -0.5) everWrapped = true;               // the loop wrap
            else if (d < 0.0) everBackward = true;          // a genuine reversal
            if (p.positions[i] > kEnd + 1.0) outOfRange = true;
        }
        CHECK(everWrapped,    "forward: the head wraps at loopEnd");
        CHECK(!everBackward,  "forward: the head never reads backwards");
        CHECK(!outOfRange,    "forward: the head stays at or below loopEnd");
    }

    // ── PING-PONG: reflects at BOTH ends, never jumps ────────────────────────
    {
        const auto p = probeLoop(static_cast<int>(SampleLoopMode::PingPong),
                                 kLen, kStart, kEnd, kRender);
        // Skip the pre-loop run-in (smpStart → loopEnd): it legitimately reads
        // below loopStart, since the head only enters the loop on first
        // reaching loopEnd. Same skip the Reverse case makes.
        size_t firstInLoop = 0;
        while (firstInLoop < p.positions.size() && p.positions[firstInLoop] < kEnd - 1.0)
            ++firstInLoop;
        CHECK(firstInLoop < p.positions.size(),
              "ping-pong: the head reaches loopEnd before the loop starts");

        int reversals = 0;
        double maxJump = 0.0, minPos = 1e9, maxPos = -1e9;
        int lastDir = 1;
        for (size_t i = firstInLoop + 1; i < p.positions.size(); ++i) {
            const double d = p.positions[i] - p.positions[i - 1];
            maxJump = std::max(maxJump, std::abs(d));
            minPos  = std::min(minPos, p.positions[i]);
            maxPos  = std::max(maxPos, p.positions[i]);
            const int dir = (d >= 0.0) ? 1 : -1;
            if (dir != lastDir) { ++reversals; lastDir = dir; }
        }
        CHECK(reversals >= 6,
              "ping-pong: the head turns around repeatedly (got "
              + std::to_string(reversals) + " reversals)");
        // The defining property: a reflection moves ONE sample per step, so
        // there is never a jump. A wrapping loop would show a ~100 jump here.
        CHECK(maxJump < 2.0,
              "ping-pong: no positional jump — the seam is a reflection (max step "
              + std::to_string(maxJump) + ")");
        CHECK(minPos >= kStart - 1.5 && maxPos <= kEnd + 1.5,
              "ping-pong: the head stays inside the loop region");
    }

    // ── REVERSE: descends, then jumps back up to the top ─────────────────────
    {
        const auto p = probeLoop(static_cast<int>(SampleLoopMode::Reverse),
                                 kLen, kStart, kEnd, kRender);
        int descendingSteps = 0, upwardJumps = 0;
        double minPos = 1e9, maxPos = -1e9;
        // Skip the pre-loop run-in (0 → loopEnd), which is forward by design.
        size_t firstInLoop = 0;
        while (firstInLoop < p.positions.size() && p.positions[firstInLoop] < kEnd - 1.0)
            ++firstInLoop;
        CHECK(firstInLoop < p.positions.size(),
              "reverse: the head reaches loopEnd before the loop starts");

        for (size_t i = firstInLoop + 2; i < p.positions.size(); ++i) {
            const double d = p.positions[i] - p.positions[i - 1];
            if (d < -0.5)      ++descendingSteps;
            else if (d > 1.5)  ++upwardJumps;      // the wrap back to the top
            minPos = std::min(minPos, p.positions[i]);
            maxPos = std::max(maxPos, p.positions[i]);
        }
        CHECK(descendingSteps > 400,
              "reverse: the head spends its time descending (got "
              + std::to_string(descendingSteps) + " backward steps)");
        CHECK(upwardJumps >= 3,
              "reverse: the head wraps back up to loopEnd repeatedly (got "
              + std::to_string(upwardJumps) + " wraps)");
        CHECK(minPos >= kStart - 1.5 && maxPos <= kEnd + 1.5,
              "reverse: the head stays inside the loop region");
    }
}

// ─── 5. Exit-loop-on-release voice lifecycle ─────────────────────────────────

static void testExitLoopOnRelease()
{
    std::cout << "\n[exit-loop-on-release lifecycle]\n";

    constexpr int kLen    = 512;
    constexpr int kStart  = 100;
    constexpr int kEnd    = 200;
    constexpr int kRender = 1200;
    constexpr int kOffAt  = 400;    // well inside the loop

    // ── Control: WITHOUT the option, release ends the note in the loop ───────
    {
        Sampler s;
        const auto ramp = makeRamp(kLen);
        s.loadSample(ramp, kEngineSR, 60);
        s.setEnvelope(0.0f, 0.0f, 0.0f, 0.0f, 1.0f, 5.0f, 0.0f, 0.0f, 0.0f);
        s.setCrossfadeMode(true);
        s.setSlotTrim(0, 0, 0, 0.0f, 0.0f, 0.0f);
        s.setSlotLoop(0, true, kStart, kEnd, 0,
                      static_cast<int>(SampleLoopMode::Forward), /*exitOnRel=*/false);

        juce::AudioBuffer<float> out(2, kOffAt);
        out.clear();
        s.noteOn(60, 1.0f, 0);
        s.processBlock(out, kOffAt, kEngineSR);
        CHECK(s.countHeldVoices() == 1, "control: the note is held before release");

        s.noteOff(60, 0, false);
        CHECK(s.countHeldVoices() == 0, "control: release clears the held flag");

        // A 5 ms release at 48 kHz is 240 samples; 2048 is comfortably past it.
        juce::AudioBuffer<float> tail(2, 2048);
        tail.clear();
        s.processBlock(tail, 2048, kEngineSR);
        CHECK(s.activeVoiceCount() == 0,
              "control: without the option the note dies inside the loop");
    }

    // ── WITH the option: the note survives release and leaves the loop ───────
    {
        const auto p = probeLoop(static_cast<int>(SampleLoopMode::Forward),
                                 kLen, kStart, kEnd, kRender,
                                 /*exitOnRelease=*/true, /*noteOffAt=*/kOffAt);

        // Before release: confined to the loop.
        double preMax = -1e9;
        for (int i = 0; i < kOffAt; ++i) preMax = std::max(preMax, p.positions[static_cast<size_t>(i)]);
        CHECK(preMax <= kEnd + 1.5,
              "exit-loop: the head is inside the loop before release");

        // After release: it finishes the pass and then runs PAST loopEnd,
        // which is the whole point — the rest of the sample gets heard.
        double postMax = -1e9;
        for (int i = kOffAt; i < kRender; ++i)
            postMax = std::max(postMax, p.positions[static_cast<size_t>(i)]);
        CHECK(postMax > kEnd + 20.0,
              "exit-loop: after release the head runs past loopEnd (reached "
              + std::to_string(postMax) + ")");

        // And it never wraps again — once left, the loop is left for good.
        int wrapsAfterRelease = 0;
        for (int i = kOffAt + 2; i < kRender; ++i) {
            const double d = p.positions[static_cast<size_t>(i)]
                           - p.positions[static_cast<size_t>(i - 1)];
            if (d < -0.5) ++wrapsAfterRelease;
        }
        // One wrap is allowed: the pass in flight at the moment of release
        // completes before the head leaves.
        CHECK(wrapsAfterRelease <= 1,
              "exit-loop: at most the in-flight pass completes, then no more wraps (got "
              + std::to_string(wrapsAfterRelease) + ")");
    }

    // ── The tail is finite: the note ends when the sample does ───────────────
    {
        Sampler s;
        const auto ramp = makeRamp(kLen);
        s.loadSample(ramp, kEngineSR, 60);
        s.setEnvelope(0.0f, 0.0f, 0.0f, 0.0f, 1.0f, 1.0f, 0.0f, 0.0f, 0.0f);
        s.setCrossfadeMode(true);
        s.setSlotTrim(0, 0, 0, 0.0f, 0.0f, 0.0f);
        s.setSlotLoop(0, true, kStart, kEnd, 0,
                      static_cast<int>(SampleLoopMode::Forward), /*exitOnRel=*/true);

        juce::AudioBuffer<float> head(2, 400);
        head.clear();
        s.noteOn(60, 1.0f, 0);
        s.processBlock(head, 400, kEngineSR);
        s.noteOff(60, 0, false);

        CHECK(s.activeVoiceCount() == 1,
              "exit-loop: the voice is still sounding immediately after release");

        // Long enough for the head to leave the loop, cross the remaining ~312
        // samples of the ramp, and run the release envelope out.
        juce::AudioBuffer<float> tail(2, 4096);
        tail.clear();
        s.processBlock(tail, 4096, kEngineSR);
        CHECK(s.activeVoiceCount() == 0,
              "exit-loop: the voice ends once the sample runs out — the tail is finite");
    }

    // ── Stealing and allNotesOff must NOT grant a tail ───────────────────────
    {
        Sampler s;
        const auto ramp = makeRamp(kLen);
        s.loadSample(ramp, kEngineSR, 60);
        s.setEnvelope(0.0f, 0.0f, 0.0f, 0.0f, 1.0f, 1.0f, 0.0f, 0.0f, 0.0f);
        s.setCrossfadeMode(true);
        s.setSlotTrim(0, 0, 0, 0.0f, 0.0f, 0.0f);
        s.setSlotLoop(0, true, kStart, kEnd, 0,
                      static_cast<int>(SampleLoopMode::Forward), /*exitOnRel=*/true);

        juce::AudioBuffer<float> head(2, 400);
        head.clear();
        s.noteOn(60, 1.0f, 0);
        s.processBlock(head, 400, kEngineSR);

        s.allNotesOff();
        juce::AudioBuffer<float> tail(2, 1024);
        tail.clear();
        s.processBlock(tail, 1024, kEngineSR);
        CHECK(s.activeVoiceCount() == 0,
              "allNotesOff hard-releases even with exit-on-release armed");
    }
}

// ─── main ────────────────────────────────────────────────────────────────────

int main()
{
    std::cout << "=== test_slot_prep ===\n";

    testBakeDeterminismPerAlgorithm();
    testBypassIsBitIdentical();
    testDiskCacheAndRebuildOnMissingFile();
    testLoopModeBoundaries();
    testExitLoopOnRelease();

    std::cout << "\n";
    if (g_failed == 0) {
        std::cout << "ALL TESTS PASSED (" << g_passed << " checks)\n";
        return 0;
    }
    std::cerr << "FAILED: " << g_failed << " / " << (g_passed + g_failed)
              << " checks\n";
    return 1;
}
