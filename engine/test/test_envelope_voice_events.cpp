// test_envelope_voice_events.cpp
// Unit tests for the pure per-voice Envelope Controller trigger/voice
// occurrence contract (EVC.4).
//
// Audit: docs/dev/fxgraph-envelope-controller-architecture-audit.md
// Contract: engine/src/model/EnvelopeVoiceEvents.h
//
// These tests are pure and fast — they build minimal Clip / Pattern /
// PatternBlock model structs directly and assert deterministic occurrence
// enumeration. No audio rendering, no transport, no graphState.
//
// Build target: test_envelope_voice_events (engine/CMakeLists.txt)
// Pure C++, model-only — links solely against XlethEngineModel.
// Pass: prints "ALL TESTS PASSED" and exits 0.

#include "model/EnvelopeVoiceEvents.h"

#include <cstdint>
#include <iostream>
#include <string>
#include <vector>

// ─── Minimal harness ──────────────────────────────────────────────────────────

static int g_passed = 0;
static int g_failed = 0;

#define CHECK(cond, msg)                                                  \
    do {                                                                  \
        if (cond) {                                                       \
            ++g_passed;                                                   \
        } else {                                                          \
            std::cerr << "  FAIL [" << __LINE__ << "] " << msg << "\n";   \
            ++g_failed;                                                   \
        }                                                                 \
    } while (0)

// ─── Fixtures ─────────────────────────────────────────────────────────────────

static constexpr double kBpm = 120.0;
static constexpr double kSr  = 48000.0;

static TickTime tt(int64_t ticks) { return TickTime{ticks}; }

static Clip makeClip(int id, int trackId, int regionId,
                     int64_t posTicks, int64_t durTicks,
                     int pitchOffset = 0, float velocity = 1.0f) {
    Clip c;
    c.id          = id;
    c.trackId     = trackId;
    c.regionId    = regionId;
    c.position    = tt(posTicks);
    c.duration    = tt(durTicks);
    c.pitchOffset = pitchOffset;
    c.velocity    = velocity;
    return c;
}

static PatternNote makeNote(int id, int64_t posTicks, int64_t durTicks,
                            int pitch = 60, float velocity = 1.0f,
                            bool isSlide = false) {
    PatternNote n;
    n.id       = id;
    n.position = tt(posTicks);
    n.duration = tt(durTicks);
    n.pitch    = pitch;
    n.velocity = velocity;
    n.isSlide  = isSlide;
    return n;
}

static Pattern makePattern(int id, int regionId, int64_t lenTicks,
                           std::vector<PatternNote> notes) {
    Pattern p;
    p.id       = id;
    p.regionId = regionId;
    p.length   = tt(lenTicks);
    p.notes    = std::move(notes);
    return p;
}

static PatternBlock makeBlock(int id, int trackId, int patternId,
                              int64_t posTicks, int64_t durTicks,
                              int64_t offsetTicks = 0, bool loopEnabled = false) {
    PatternBlock b;
    b.id          = id;
    b.trackId     = trackId;
    b.patternId   = patternId;
    b.position    = tt(posTicks);
    b.duration    = tt(durTicks);
    b.offset      = tt(offsetTicks);
    b.loopEnabled = loopEnabled;
    return b;
}

static EnvelopeQueryWindow win(int64_t start, int64_t end) {
    return EnvelopeQueryWindow{start, end};
}

// Verify a list is sorted by the contract comparator (deterministic ordering).
static bool isSorted(const std::vector<EnvelopeVoiceEvent>& v) {
    for (std::size_t i = 1; i < v.size(); ++i)
        if (envelopeVoiceEventLess(v[i], v[i - 1])) return false;
    return true;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

static void testSingleClipOccurrence() {
    std::vector<Clip> clips = { makeClip(1, 7, 3, 960, 480, /*pitch*/2, /*vel*/0.5f) };
    auto out = enumerateEnvelopeClipOccurrences(clips, 7, win(0, 4000), kBpm, kSr);

    CHECK(out.size() == 1, "single clip → 1 occurrence");
    if (out.size() == 1) {
        const auto& e = out[0];
        CHECK(e.sourceKind == EnvelopeVoiceSourceKind::TimelineClip, "clip source kind");
        CHECK(e.onsetTick == 960, "clip onset tick");
        CHECK(e.gateEndTick == 1440, "clip gate end tick = pos + duration");
        CHECK(e.sourceId == 1, "clip source id = clip id");
        CHECK(e.trackId == 7, "clip track id");
        CHECK(e.regionId == 3, "clip region id");
        CHECK(e.pitch == 2, "clip pitch = pitchOffset");
        CHECK(e.velocity == 0.5f, "clip velocity");
        CHECK(e.patternBlockId == -1, "clip has no pattern block");
        CHECK(e.patternId == -1, "clip has no pattern id");
        CHECK(e.loopIteration == 0, "clip loop iteration 0");
        CHECK(e.onsetSample >= 0 && e.gateEndSample > e.onsetSample, "clip sample gate positive");
        CHECK(e.gateLengthTicks() == 480, "clip gate length");
    }
}

static void testTwoOverlappingClips() {
    std::vector<Clip> clips = {
        makeClip(10, 1, 0, 0,   1920),   // [0, 1920)
        makeClip(11, 1, 0, 480, 1920),   // [480, 2400) — overlaps clip 10
    };
    auto out = enumerateEnvelopeClipOccurrences(clips, 1, win(0, 4000), kBpm, kSr);

    CHECK(out.size() == 2, "two overlapping clips → 2 occurrences");
    if (out.size() == 2) {
        CHECK(out[0].key != out[1].key, "overlapping clip keys distinct");
        CHECK(out[0].sourceId != out[1].sourceId, "overlapping clips have distinct ids");
        // Deterministic order: clip 10 (onset 0) before clip 11 (onset 480).
        CHECK(out[0].sourceId == 10 && out[1].sourceId == 11, "overlapping clips sorted by onset");
    }
}

static void testQueryMidClip() {
    // A window strictly inside a clip's body must still return the clip — needed
    // for future seek reconstruction (clip activity is position-pure overlap).
    std::vector<Clip> clips = { makeClip(5, 2, 0, 0, 1920) };  // [0, 1920)
    auto out = enumerateEnvelopeClipOccurrences(clips, 2, win(960, 1000), kBpm, kSr);

    CHECK(out.size() == 1, "mid-clip query returns the overlapping clip");
    if (out.size() == 1) {
        CHECK(out[0].onsetTick == 0 && out[0].gateEndTick == 1920,
              "mid-clip occurrence carries full gate for reconstruction");
    }
}

static void testSinglePatternNote() {
    auto pat = makePattern(100, 9, 1920, { makeNote(1, 480, 240, 64, 0.8f) });
    std::vector<Pattern> patterns = { pat };
    std::vector<PatternBlock> blocks = { makeBlock(50, 4, 100, 0, 1920) };

    auto out = enumerateEnvelopePatternNoteOccurrences(blocks, patterns, 4, win(0, 1920), kBpm, kSr);

    CHECK(out.size() == 1, "single note → 1 occurrence");
    if (out.size() == 1) {
        const auto& e = out[0];
        CHECK(e.sourceKind == EnvelopeVoiceSourceKind::PatternNote, "note source kind");
        CHECK(e.onsetTick == 480, "note onset tick = block pos + note pos");
        CHECK(e.gateEndTick == 720, "note gate end = onset + duration");
        CHECK(e.pitch == 64, "note pitch");
        CHECK(e.velocity == 0.8f, "note velocity");
        CHECK(e.regionId == 9, "note region id from pattern");
        CHECK(e.patternId == 100, "note pattern id");
        CHECK(e.patternBlockId == 50, "note pattern block id");
        CHECK(e.sourceId == 1, "note source id = note id");
        CHECK(e.loopIteration == 0, "note loop iteration 0");
    }
}

static void testSameTickChord() {
    // Three notes at the same position (a chord). Each must remain a separate
    // occurrence — never averaged/collapsed.
    auto pat = makePattern(101, 9, 1920, {
        makeNote(1, 0, 480, 60),
        makeNote(2, 0, 480, 64),
        makeNote(3, 0, 480, 67),
    });
    std::vector<Pattern> patterns = { pat };
    std::vector<PatternBlock> blocks = { makeBlock(60, 4, 101, 0, 1920) };

    auto out = enumerateEnvelopePatternNoteOccurrences(blocks, patterns, 4, win(0, 1920), kBpm, kSr);

    CHECK(out.size() == 3, "chord → 3 separate occurrences (not collapsed)");
    if (out.size() == 3) {
        CHECK(out[0].onsetTick == 0 && out[1].onsetTick == 0 && out[2].onsetTick == 0,
              "chord notes share onset tick");
        // Distinct keys, and deterministic pitch-ascending order at the same tick.
        CHECK(out[0].key != out[1].key && out[1].key != out[2].key && out[0].key != out[2].key,
              "chord note keys all distinct");
        CHECK(out[0].pitch == 60 && out[1].pitch == 64 && out[2].pitch == 67,
              "chord notes sorted by pitch deterministically");
    }
}

static void testLoopIterations() {
    // loopEnabled block spanning two pattern lengths → two occurrences of the
    // same note with distinct loopIteration keys.
    auto pat = makePattern(102, 9, 1920, { makeNote(1, 0, 240, 60) });
    std::vector<Pattern> patterns = { pat };
    std::vector<PatternBlock> blocks = {
        makeBlock(70, 4, 102, 0, 3840, /*offset*/0, /*loop*/true),
    };

    auto out = enumerateEnvelopePatternNoteOccurrences(blocks, patterns, 4, win(0, 3840), kBpm, kSr);

    CHECK(out.size() == 2, "looped note over 2 iterations → 2 occurrences");
    if (out.size() == 2) {
        CHECK(out[0].onsetTick == 0 && out[1].onsetTick == 1920,
              "loop iterations onset one pattern length apart");
        CHECK(out[0].loopIteration == 0 && out[1].loopIteration == 1,
              "distinct loop iteration values");
        CHECK(out[0].key != out[1].key, "loop iteration keys distinct");
        CHECK(out[0].key.sourceId == out[1].key.sourceId, "same note id across iterations");
    }
}

static void testNonLoopingBlockClampsToFirstIteration() {
    // loopEnabled == false → only iteration 0 plays even though the block is
    // longer than the pattern.
    auto pat = makePattern(103, 9, 1920, { makeNote(1, 0, 240, 60) });
    std::vector<Pattern> patterns = { pat };
    std::vector<PatternBlock> blocks = {
        makeBlock(80, 4, 103, 0, 3840, /*offset*/0, /*loop*/false),
    };
    auto out = enumerateEnvelopePatternNoteOccurrences(blocks, patterns, 4, win(0, 3840), kBpm, kSr);
    CHECK(out.size() == 1, "non-looping block plays only iteration 0");
    if (out.size() == 1)
        CHECK(out[0].loopIteration == 0, "non-loop occurrence is iteration 0");
}

static void testNoteOffClampedToBlockEnd() {
    // A note whose duration overshoots the block boundary must release at the
    // block end (gate clamp), matching triggerPatternNotes.
    auto pat = makePattern(104, 9, 1920, { makeNote(1, 1440, 1920, 60) });  // would end at 3360
    std::vector<Pattern> patterns = { pat };
    std::vector<PatternBlock> blocks = { makeBlock(90, 4, 104, 0, 1920) };  // block ends at 1920
    auto out = enumerateEnvelopePatternNoteOccurrences(blocks, patterns, 4, win(0, 1920), kBpm, kSr);
    CHECK(out.size() == 1, "overshooting note still produces an occurrence");
    if (out.size() == 1) {
        CHECK(out[0].onsetTick == 1440, "overshoot onset");
        CHECK(out[0].gateEndTick == 1920, "overshoot gate clamped to block end");
    }
}

static void testBlockOffsetShiftsNotes() {
    // Block offset trims the left edge of the pattern: effective note onset is
    // blockPos - offset + notePos.
    auto pat = makePattern(105, 9, 1920, { makeNote(1, 960, 240, 60) });
    std::vector<Pattern> patterns = { pat };
    // offset 480 → note at pattern-pos 960 lands at block tick 960 - 480 = 480.
    std::vector<PatternBlock> blocks = { makeBlock(95, 4, 105, 0, 1920, /*offset*/480) };
    auto out = enumerateEnvelopePatternNoteOccurrences(blocks, patterns, 4, win(0, 1920), kBpm, kSr);
    CHECK(out.size() == 1, "offset block → note present");
    if (out.size() == 1)
        CHECK(out[0].onsetTick == 480, "block offset shifts note onset");
}

static void testTriggerSourceFiltering() {
    std::vector<Clip> clips = { makeClip(1, 4, 0, 0, 960) };
    auto pat = makePattern(110, 9, 1920, { makeNote(1, 0, 240, 60) });
    std::vector<Pattern> patterns = { pat };
    std::vector<PatternBlock> blocks = { makeBlock(120, 4, 110, 0, 1920) };
    auto w = win(0, 4000);

    auto both = enumerateEnvelopeVoiceOccurrences(
        clips, blocks, patterns, 4, EnvelopeTriggerEvents::NotesAndClips, w, kBpm, kSr);
    CHECK(both.size() == 2, "notesAndClips → note + clip");
    bool hasNote = false, hasClip = false;
    for (const auto& e : both) {
        if (e.sourceKind == EnvelopeVoiceSourceKind::PatternNote) hasNote = true;
        if (e.sourceKind == EnvelopeVoiceSourceKind::TimelineClip) hasClip = true;
    }
    CHECK(hasNote && hasClip, "notesAndClips returns both kinds");

    auto onlyNotes = enumerateEnvelopeVoiceOccurrences(
        clips, blocks, patterns, 4, EnvelopeTriggerEvents::Notes, w, kBpm, kSr);
    CHECK(onlyNotes.size() == 1 && onlyNotes[0].sourceKind == EnvelopeVoiceSourceKind::PatternNote,
          "notes → only note events");

    auto onlyClips = enumerateEnvelopeVoiceOccurrences(
        clips, blocks, patterns, 4, EnvelopeTriggerEvents::Clips, w, kBpm, kSr);
    CHECK(onlyClips.size() == 1 && onlyClips[0].sourceKind == EnvelopeVoiceSourceKind::TimelineClip,
          "clips → only clip events");
}

static void testDeterministicOrdering() {
    // Mixed notes (chord) + clips + loops; enumerate twice and require identical
    // output, plus globally sorted order.
    std::vector<Clip> clips = {
        makeClip(2, 4, 0, 0, 1920),
        makeClip(1, 4, 0, 960, 480),
    };
    auto pat = makePattern(130, 9, 1920, {
        makeNote(3, 0, 240, 67),
        makeNote(1, 0, 240, 60),
        makeNote(2, 0, 240, 64),
        makeNote(4, 960, 240, 72),
    });
    std::vector<Pattern> patterns = { pat };
    std::vector<PatternBlock> blocks = {
        makeBlock(140, 4, 130, 0, 3840, 0, /*loop*/true),
    };
    auto w = win(0, 3840);

    auto a = enumerateEnvelopeVoiceOccurrences(
        clips, blocks, patterns, 4, EnvelopeTriggerEvents::NotesAndClips, w, kBpm, kSr);
    auto b = enumerateEnvelopeVoiceOccurrences(
        clips, blocks, patterns, 4, EnvelopeTriggerEvents::NotesAndClips, w, kBpm, kSr);

    CHECK(a.size() == b.size(), "deterministic: same count across runs");
    CHECK(isSorted(a), "combined output is deterministically sorted");
    bool identical = a.size() == b.size();
    for (std::size_t i = 0; identical && i < a.size(); ++i)
        identical = (a[i].key == b[i].key);
    CHECK(identical, "deterministic: identical key order across runs");
    // Onset is the primary sort key — must be non-decreasing.
    bool nonDecreasingOnset = true;
    for (std::size_t i = 1; i < a.size(); ++i)
        if (a[i].onsetTick < a[i - 1].onsetTick) nonDecreasingOnset = false;
    CHECK(nonDecreasingOnset, "occurrences ordered by ascending onset");
}

static void testEmptyAndNoMatch() {
    std::vector<Clip> clips = { makeClip(1, 4, 0, 0, 960) };
    auto pat = makePattern(150, 9, 1920, { makeNote(1, 0, 240, 60) });
    std::vector<Pattern> patterns = { pat };
    std::vector<PatternBlock> blocks = { makeBlock(160, 4, 150, 0, 1920) };

    // Window entirely after all content.
    auto late = enumerateEnvelopeVoiceOccurrences(
        clips, blocks, patterns, 4, EnvelopeTriggerEvents::NotesAndClips, win(5000, 6000), kBpm, kSr);
    CHECK(late.empty(), "window past all content → empty");

    // Empty window (end <= start).
    auto empty = enumerateEnvelopeVoiceOccurrences(
        clips, blocks, patterns, 4, EnvelopeTriggerEvents::NotesAndClips, win(1000, 1000), kBpm, kSr);
    CHECK(empty.empty(), "empty window → empty");

    // Wrong parent track filters everything out.
    auto wrongTrack = enumerateEnvelopeVoiceOccurrences(
        clips, blocks, patterns, 999, EnvelopeTriggerEvents::NotesAndClips, win(0, 4000), kBpm, kSr);
    CHECK(wrongTrack.empty(), "non-matching parent track → empty");
}

static void testZeroLengthSafety() {
    // Zero-length clip and zero-length note must not crash and are handled per
    // the model rules (degenerate gate; admitted only when onset is in-window).
    std::vector<Clip> clips = { makeClip(1, 4, 0, 480, 0) };  // zero-length clip
    auto pat = makePattern(170, 9, 1920, { makeNote(1, 480, 0, 60) });  // zero-length note
    std::vector<Pattern> patterns = { pat };
    std::vector<PatternBlock> blocks = { makeBlock(180, 4, 170, 0, 1920) };

    auto out = enumerateEnvelopeVoiceOccurrences(
        clips, blocks, patterns, 4, EnvelopeTriggerEvents::NotesAndClips, win(0, 1920), kBpm, kSr);
    // Both are admitted (onset 480 in window); gate end equals onset; no crash.
    CHECK(out.size() == 2, "zero-length clip + note both admitted by onset");
    for (const auto& e : out) {
        CHECK(e.gateEndTick == e.onsetTick, "zero-length gate end equals onset");
        CHECK(e.gateLengthTicks() == 0, "zero-length gate length is 0");
    }

    // Zero-length pattern is skipped safely.
    auto badPat = makePattern(171, 9, 0, { makeNote(1, 0, 240, 60) });
    std::vector<Pattern> badPatterns = { badPat };
    std::vector<PatternBlock> badBlocks = { makeBlock(190, 4, 171, 0, 1920) };
    auto bad = enumerateEnvelopePatternNoteOccurrences(badBlocks, badPatterns, 4, win(0, 1920), kBpm, kSr);
    CHECK(bad.empty(), "zero-length pattern produces no occurrences (no crash)");
}

static void testSlideNotesExcluded() {
    // Slide notes are silent markers — no audible voice, so no occurrence.
    auto pat = makePattern(200, 9, 1920, {
        makeNote(1, 0, 240, 60, 1.0f, /*isSlide*/true),
        makeNote(2, 240, 240, 64),
    });
    std::vector<Pattern> patterns = { pat };
    std::vector<PatternBlock> blocks = { makeBlock(210, 4, 200, 0, 1920) };
    auto out = enumerateEnvelopePatternNoteOccurrences(blocks, patterns, 4, win(0, 1920), kBpm, kSr);
    CHECK(out.size() == 1, "slide note excluded; only the real note remains");
    if (out.size() == 1)
        CHECK(out[0].sourceId == 2, "remaining occurrence is the non-slide note");
}

static void testUnresolvedPatternSkipped() {
    // Block references a pattern id that does not exist → skipped, no crash.
    std::vector<Pattern> patterns = {};  // none
    std::vector<PatternBlock> blocks = { makeBlock(220, 4, 9999, 0, 1920) };
    auto out = enumerateEnvelopePatternNoteOccurrences(blocks, patterns, 4, win(0, 1920), kBpm, kSr);
    CHECK(out.empty(), "block with unresolved pattern → empty (no crash)");
}

// ─── Main ──────────────────────────────────────────────────────────────────

int main() {
    std::cout << "Running EVC.4 envelope voice event contract tests...\n";

    testSingleClipOccurrence();
    testTwoOverlappingClips();
    testQueryMidClip();
    testSinglePatternNote();
    testSameTickChord();
    testLoopIterations();
    testNonLoopingBlockClampsToFirstIteration();
    testNoteOffClampedToBlockEnd();
    testBlockOffsetShiftsNotes();
    testTriggerSourceFiltering();
    testDeterministicOrdering();
    testEmptyAndNoMatch();
    testZeroLengthSafety();
    testSlideNotesExcluded();
    testUnresolvedPatternSkipped();

    std::cout << "\nPassed: " << g_passed << "   Failed: " << g_failed << "\n";
    if (g_failed == 0) {
        std::cout << "ALL TESTS PASSED\n";
        return 0;
    }
    std::cerr << "TESTS FAILED\n";
    return 1;
}
