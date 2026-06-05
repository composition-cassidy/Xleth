#pragma once

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

namespace xleth::import {

// One imported note from a FL Studio Score (.fsc) file.
//
// The source (FL) timing is preserved alongside the converted Xleth timing so
// callers can diagnose conversion issues.  Source PPQ varies per file; Xleth is
// always 960 PPQ.  Per-note articulation fields (pan/mod/release/finePitch) are
// decoded for completeness and diagnostics; this pass does not consume them.
struct ImportedFscNote
{
    std::uint32_t sourcePositionTicks = 0;
    std::uint32_t sourceLengthTicks   = 0;
    std::int64_t  xlethStartTick       = 0;
    std::int64_t  xlethLengthTick      = 0;
    int           key                  = 0;     // raw u16; notes with key > 127 are dropped
    std::uint16_t group                = 0;     // FL note group id; preserved for diagnostics
    float         velocity             = 0.0f;  // normalized 0..1
    std::uint16_t flags                = 0;
    bool          isSlide              = false; // (flags & 0x0008) != 0
    std::uint8_t  markerByte           = 0;     // byte at offset 19; FL portamento marker is 16
    std::uint8_t  pan                  = 64;
    std::uint8_t  modX                 = 128;
    std::uint8_t  modY                 = 128;
    std::uint8_t  release              = 64;
    std::uint8_t  finePitch            = 120;
};

// Parse result.  On success ok == true and notes contains the decoded score.
// On a structural error ok == false and error carries a human-readable reason.
// droppedCount counts individual note records rejected by the untrusted-input
// guards (key out of range, non-positive converted length, overflowed ticks);
// dropped notes do not fail the overall parse.
struct FscParseResult
{
    bool        ok           = false;
    std::string error;
    int         sourcePpq    = 0;
    int         xlethPpq     = 960;
    int         droppedCount = 0;
    std::vector<ImportedFscNote> notes;
};

// Pure FL Studio Score (.fsc) parser for Piano Roll note data.
//
// Reads only the 0xE0 (decimal 224) note event from the FLdt event stream and
// converts note timing from the file's source PPQ to Xleth's 960 PPQ.  Treats
// the input as untrusted binary: never throws, validates structure, and drops
// individual out-of-range notes rather than aborting.
class FscScoreParser
{
public:
    // Reads filePath in binary mode and delegates to parseBytes.
    static FscParseResult parseFile(const std::string& filePath);

    // Pure byte parsing — no filesystem, no JUCE dependency.
    static FscParseResult parseBytes(const std::uint8_t* data, std::size_t size);
};

} // namespace xleth::import
