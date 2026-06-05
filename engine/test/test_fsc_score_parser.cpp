// test_fsc_score_parser.cpp — neutral parser for FL Studio Score (.fsc) files.
// Build: cmake --build build --target test_fsc_score_parser --config Debug
// Run:   build\engine\Debug\test_fsc_score_parser.exe
//
// Cases 1-8 and 11 drive in-memory synthetic FSC byte streams built by the
// Builder helper below.  Cases 9-10 parse the real FL Studio score fixtures
// under engine/test/fixtures/fsc/ (path supplied at compile time via
// XLETH_FSC_FIXTURE_DIR).

#include "import/FscScoreParser.h"

#include <cmath>
#include <cstdint>
#include <filesystem>
#include <iostream>
#include <string>
#include <vector>

using xleth::import::FscScoreParser;
using xleth::import::FscParseResult;
using xleth::import::ImportedFscNote;

namespace fs = std::filesystem;

static int g_passed = 0;
static int g_failed = 0;

#define CHECK(cond, msg)                                                      \
    do {                                                                      \
        if (cond) {                                                           \
            ++g_passed;                                                       \
        } else {                                                              \
            std::cerr << "  FAIL [" << __LINE__ << "] " << msg << "\n";        \
            ++g_failed;                                                       \
        }                                                                     \
    } while (0)

// ─── Synthetic FSC byte-stream builder ─────────────────────────────────────

struct Builder
{
    std::vector<std::uint8_t> bytes;

    void writeU8(std::uint8_t v) { bytes.push_back(v); }
    void writeU16LE(std::uint16_t v)
    {
        bytes.push_back(static_cast<std::uint8_t>(v & 0xFFu));
        bytes.push_back(static_cast<std::uint8_t>((v >> 8) & 0xFFu));
    }
    void writeU32LE(std::uint32_t v)
    {
        bytes.push_back(static_cast<std::uint8_t>( v        & 0xFFu));
        bytes.push_back(static_cast<std::uint8_t>((v >>  8) & 0xFFu));
        bytes.push_back(static_cast<std::uint8_t>((v >> 16) & 0xFFu));
        bytes.push_back(static_cast<std::uint8_t>((v >> 24) & 0xFFu));
    }
    void writeMagic(const char* m)
    {
        for (int i = 0; i < 4; ++i) bytes.push_back(static_cast<std::uint8_t>(m[i]));
    }
};

static std::vector<std::uint8_t> buildHeaderOnly(std::uint16_t ppq)
{
    Builder b;
    b.writeMagic("FLhd");
    b.writeU32LE(6);                 // FLhd chunk size (always 6)
    b.writeU16LE(0);                 // format/type
    b.writeU16LE(1);                 // channel count
    b.writeU16LE(ppq);               // source PPQ
    return b.bytes;
}

static void appendDataChunk(Builder& b, const std::vector<std::uint8_t>& events)
{
    b.writeMagic("FLdt");
    b.writeU32LE(static_cast<std::uint32_t>(events.size()));
    b.bytes.insert(b.bytes.end(), events.begin(), events.end());
}

// 24-byte note record using the verified FL Studio note layout.
static std::vector<std::uint8_t> makeNoteRecord(std::uint32_t pos,
                                                std::uint32_t len,
                                                std::uint16_t key,
                                                std::uint8_t  velocityByte,
                                                std::uint16_t flags  = 0,
                                                std::uint16_t group  = 0,
                                                std::uint8_t  marker = 0)
{
    std::vector<std::uint8_t> rec(24, 0);
    auto putU32 = [&](std::size_t off, std::uint32_t v)
    {
        rec[off]     = static_cast<std::uint8_t>( v        & 0xFFu);
        rec[off + 1] = static_cast<std::uint8_t>((v >>  8) & 0xFFu);
        rec[off + 2] = static_cast<std::uint8_t>((v >> 16) & 0xFFu);
        rec[off + 3] = static_cast<std::uint8_t>((v >> 24) & 0xFFu);
    };
    auto putU16 = [&](std::size_t off, std::uint16_t v)
    {
        rec[off]     = static_cast<std::uint8_t>( v       & 0xFFu);
        rec[off + 1] = static_cast<std::uint8_t>((v >> 8) & 0xFFu);
    };
    putU32(0,  pos);          // offset 0..3   position
    putU16(4,  flags);        // offset 4..5   flags
    putU16(6,  0);            // offset 6..7   rackChannel
    putU32(8,  len);          // offset 8..11  length
    putU16(12, key);          // offset 12..13 key
    putU16(14, group);        // offset 14..15 group
    rec[16] = 120;            // offset 16     finePitch (default)
    rec[17] = 0;              // offset 17     reserved
    rec[18] = 64;             // offset 18     release (default)
    rec[19] = marker;         // offset 19     marker byte
    rec[20] = 64;             // offset 20     pan (default center)
    rec[21] = velocityByte;   // offset 21     velocity
    rec[22] = 128;            // offset 22     modX (default)
    rec[23] = 128;            // offset 23     modY (default)
    return rec;
}

static void appendNoteEvent(std::vector<std::uint8_t>& events,
                            const std::vector<std::uint8_t>& payload)
{
    events.push_back(0xE0u);
    // VLQ length: payloads in these synthetic tests are < 128 bytes, so one byte
    // each.  For larger payloads we would need multi-byte VLQ encoding.
    events.push_back(static_cast<std::uint8_t>(payload.size()));
    events.insert(events.end(), payload.begin(), payload.end());
}

// ─── Synthetic tests ─────────────────────────────────────────────────────────

// 1. Valid minimal note + base assertions.
static void testValidMinimalNote()
{
    std::cout << "[FSC] 1. valid minimal note\n";
    Builder b;
    b.bytes = buildHeaderOnly(96);
    std::vector<std::uint8_t> events;
    appendNoteEvent(events, makeNoteRecord(/*pos*/ 96, /*len*/ 48, /*key*/ 60, /*vel*/ 100));
    appendDataChunk(b, events);

    const auto r = FscScoreParser::parseBytes(b.bytes.data(), b.bytes.size());
    CHECK(r.ok, "parse should succeed");
    CHECK(r.sourcePpq == 96, "sourcePpq == 96");
    CHECK(r.xlethPpq  == 960, "xlethPpq == 960");
    CHECK(r.notes.size() == 1, "one note");
    if (r.notes.size() == 1)
    {
        const auto& n = r.notes[0];
        CHECK(n.xlethStartTick  == 960, "xlethStartTick == 960");
        CHECK(n.xlethLengthTick == 480, "xlethLengthTick == 480");
        CHECK(n.key == 60, "key == 60");
        CHECK(std::abs(n.velocity - 100.0f / 127.0f) < 0.001f, "velocity ~ 100/127");
        CHECK(!n.isSlide, "isSlide == false");
        CHECK(n.markerByte == 0, "markerByte == 0");
        CHECK(n.group == 0, "group == 0");
    }
}

// 2. Slide flag (0x0008).
static void testSlideFlag()
{
    std::cout << "[FSC] 2. slide flag\n";
    Builder b;
    b.bytes = buildHeaderOnly(96);
    std::vector<std::uint8_t> events;
    appendNoteEvent(events, makeNoteRecord(96, 48, 60, 100, /*flags*/ 0x0008u));
    appendDataChunk(b, events);

    const auto r = FscScoreParser::parseBytes(b.bytes.data(), b.bytes.size());
    CHECK(r.ok && r.notes.size() == 1, "one note parsed");
    if (r.notes.size() == 1)
        CHECK(r.notes[0].isSlide, "isSlide == true");
}

// 3. Marker 16 without slide.
static void testMarker16NoSlide()
{
    std::cout << "[FSC] 3. marker 16 without slide\n";
    Builder b;
    b.bytes = buildHeaderOnly(96);
    std::vector<std::uint8_t> events;
    appendNoteEvent(events, makeNoteRecord(96, 48, 60, 100, /*flags*/ 0, /*group*/ 0, /*marker*/ 16));
    appendDataChunk(b, events);

    const auto r = FscScoreParser::parseBytes(b.bytes.data(), b.bytes.size());
    CHECK(r.ok && r.notes.size() == 1, "one note parsed");
    if (r.notes.size() == 1)
    {
        CHECK(r.notes[0].markerByte == 16, "markerByte == 16");
        CHECK(!r.notes[0].isSlide, "isSlide == false (marker 16 is not slide)");
    }
}

// 4. Slide + marker 16 (flag wins).
static void testSlidePlusMarker16()
{
    std::cout << "[FSC] 4. slide + marker 16\n";
    Builder b;
    b.bytes = buildHeaderOnly(96);
    std::vector<std::uint8_t> events;
    appendNoteEvent(events, makeNoteRecord(96, 48, 60, 100, /*flags*/ 0x0008u, /*group*/ 0, /*marker*/ 16));
    appendDataChunk(b, events);

    const auto r = FscScoreParser::parseBytes(b.bytes.data(), b.bytes.size());
    CHECK(r.ok && r.notes.size() == 1, "one note parsed");
    if (r.notes.size() == 1)
    {
        CHECK(r.notes[0].markerByte == 16, "markerByte == 16");
        CHECK(r.notes[0].isSlide, "isSlide == true (flag wins over marker)");
    }
}

// 5. 96 -> 960 conversion math for several positions.
static void testConversionMath()
{
    std::cout << "[FSC] 5. 96->960 conversion math\n";
    const std::uint32_t inputs[]   = { 0, 24, 48, 96 };
    const std::int64_t  expected[] = { 0, 240, 480, 960 };
    for (int i = 0; i < 4; ++i)
    {
        Builder b;
        b.bytes = buildHeaderOnly(96);
        std::vector<std::uint8_t> events;
        appendNoteEvent(events, makeNoteRecord(inputs[i], /*len*/ 48, 60, 100));
        appendDataChunk(b, events);

        const auto r = FscScoreParser::parseBytes(b.bytes.data(), b.bytes.size());
        CHECK(r.ok && r.notes.size() == 1,
              std::string("pos ") + std::to_string(inputs[i]) + " parses");
        if (r.notes.size() == 1)
            CHECK(r.notes[0].xlethStartTick == expected[i],
                  std::string("pos ") + std::to_string(inputs[i]) + " converts correctly");
    }
}

// 6. Non-zero group field, independent of key.
static void testGroupField()
{
    std::cout << "[FSC] 6. non-zero group field\n";
    Builder b;
    b.bytes = buildHeaderOnly(96);
    std::vector<std::uint8_t> events;
    appendNoteEvent(events, makeNoteRecord(96, 48, /*key*/ 60, 100, 0, /*group*/ 7));
    appendDataChunk(b, events);

    const auto r = FscScoreParser::parseBytes(b.bytes.data(), b.bytes.size());
    CHECK(r.ok && r.notes.size() == 1, "one note parsed");
    if (r.notes.size() == 1)
    {
        CHECK(r.notes[0].group == 7, "group == 7");
        CHECK(r.notes[0].key == 60, "key still 60 (group not fused into key)");
    }
}

// 7. Malformed 0xE0 payload size (not a multiple of 24).
static void testMalformedNotePayloadSize()
{
    std::cout << "[FSC] 7. malformed 0xE0 payload size\n";
    Builder b;
    b.bytes = buildHeaderOnly(96);
    std::vector<std::uint8_t> events;
    events.push_back(0xE0u);
    events.push_back(25u);                       // payload length 25 (not divisible by 24)
    for (int i = 0; i < 25; ++i) events.push_back(0x00);
    appendDataChunk(b, events);

    const auto r = FscScoreParser::parseBytes(b.bytes.data(), b.bytes.size());
    CHECK(!r.ok, "parse should fail on non-24-aligned payload");
    CHECK(r.error.find("24") != std::string::npos || r.error.find("note") != std::string::npos,
          "error mentions note payload size / 24-byte alignment");
}

// 8. Value rejection: key out of range is dropped, parse still succeeds.
static void testValueRejection()
{
    std::cout << "[FSC] 8. value rejection (key=200)\n";
    Builder b;
    b.bytes = buildHeaderOnly(96);
    std::vector<std::uint8_t> events;
    appendNoteEvent(events, makeNoteRecord(96, 48, /*key*/ 200, 100));
    appendDataChunk(b, events);

    const auto r = FscScoreParser::parseBytes(b.bytes.data(), b.bytes.size());
    CHECK(r.ok, "parse stays ok even with an out-of-range note");
    CHECK(r.notes.size() == 0, "out-of-range note is not kept");
    CHECK(r.droppedCount == 1, "droppedCount == 1");
}

// 11. Malformed FLhd (wrong magic).
static void testMalformedHeader()
{
    std::cout << "[FSC] 11. malformed FLhd\n";
    std::vector<std::uint8_t> bytes = { 'X','X','X','X', 6, 0, 0, 0, 0, 0, 1, 0, 96, 0 };
    const auto r = FscScoreParser::parseBytes(bytes.data(), bytes.size());
    CHECK(!r.ok, "wrong magic should fail");
    CHECK(!r.error.empty(), "error is descriptive");

    // Truncated header (magic only).
    std::vector<std::uint8_t> truncated = { 'F','L','h','d' };
    const auto r2 = FscScoreParser::parseBytes(truncated.data(), truncated.size());
    CHECK(!r2.ok, "truncated FLhd should fail");
    CHECK(!r2.error.empty(), "truncated error is descriptive");
}

// ─── Real-fixture tests ───────────────────────────────────────────────────────

static std::string fixturePath(const char* name)
{
#ifdef XLETH_FSC_FIXTURE_DIR
    return (fs::path{ XLETH_FSC_FIXTURE_DIR } / name).string();
#else
    return std::string{ "fixtures/fsc/" } + name;
#endif
}

// 9. Real fixture: FL STUDIO SCORE TEST.fsc
static void testFixtureScoreTest()
{
    std::cout << "[FSC] 9. real fixture: FL STUDIO SCORE TEST.fsc\n";
    const auto path = fixturePath("FL STUDIO SCORE TEST.fsc");
    if (!fs::exists(path))
    {
        std::cerr << "  FAIL missing fixture: " << path << "\n";
        ++g_failed;
        return;
    }

    const auto r = FscScoreParser::parseFile(path);
    CHECK(r.ok, "fixture parses ok");
    CHECK(r.sourcePpq == 96, "sourcePpq == 96");
    CHECK(r.notes.size() > 0, "fixture yields notes");

    bool anySlide = false;
    bool tickMathOk = true;
    bool velocityOk = true;
    for (const auto& n : r.notes)
    {
        if (n.xlethStartTick != std::llround(static_cast<double>(n.sourcePositionTicks) * 10.0))
            tickMathOk = false;
        if (n.velocity < 0.0f || n.velocity > 1.0f)
            velocityOk = false;
        if (n.isSlide) anySlide = true;
    }
    CHECK(tickMathOk, "every note: xlethStartTick == round(sourcePositionTicks * 10)");
    CHECK(velocityOk, "every note velocity in [0,1]");
    // This fixture is authored with slide notes (flag bit 0x0008 set).
    CHECK(anySlide, "fixture contains at least one slide note");

    std::cout << "  parsed " << r.notes.size() << " notes (dropped " << r.droppedCount << ")\n";
}

// 10. Real fixture: kmb_bass.fsc
static void testFixtureKmbBass()
{
    std::cout << "[FSC] 10. real fixture: kmb_bass.fsc\n";
    const auto path = fixturePath("kmb_bass.fsc");
    if (!fs::exists(path))
    {
        std::cerr << "  FAIL missing fixture: " << path << "\n";
        ++g_failed;
        return;
    }

    const auto r = FscScoreParser::parseFile(path);
    CHECK(r.ok, "fixture parses ok");
    CHECK(r.sourcePpq == 96, "sourcePpq == 96");
    CHECK(r.notes.size() == 40, "fixture yields exactly 40 notes");

    bool anySlide = false;
    for (const auto& n : r.notes)
        if (n.isSlide) anySlide = true;
    CHECK(anySlide, "fixture contains at least one slide note");

    std::cout << "  parsed " << r.notes.size() << " notes (dropped " << r.droppedCount << ")\n";
}

int main()
{
    testValidMinimalNote();
    testSlideFlag();
    testMarker16NoSlide();
    testSlidePlusMarker16();
    testConversionMath();
    testGroupField();
    testMalformedNotePayloadSize();
    testValueRejection();
    testFixtureScoreTest();
    testFixtureKmbBass();
    testMalformedHeader();

    std::cout << "\nResults: " << g_passed << " passed, " << g_failed << " failed\n";
    if (g_failed > 0)
    {
        std::cerr << "FAILED\n";
        return 1;
    }
    std::cout << "ALL TESTS PASSED\n";
    return 0;
}
