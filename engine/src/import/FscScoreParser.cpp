#include "import/FscScoreParser.h"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <fstream>
#include <ios>
#include <iterator>
#include <limits>
#include <string>
#include <vector>

namespace xleth::import {

namespace {

constexpr int          kXlethPpq        = 960;
constexpr std::uint8_t kEventNote       = 0xE0u;   // decimal 224 — piano-roll note record
constexpr std::size_t  kNoteRecordSize  = 24u;
constexpr std::uint16_t kSlideFlag      = 0x0008u; // FL "slide" note flag bit

// A tiny cursor over the byte buffer.  Every read is bounds-checked so the
// parser can treat the input as untrusted without ever reading out of range.
struct Reader
{
    const std::uint8_t* data;
    std::size_t         size;
    std::size_t         pos;

    bool remaining(std::size_t n) const { return n <= size && pos <= size - n; }

    bool readU8(std::uint8_t& out)
    {
        if (!remaining(1)) return false;
        out = data[pos++];
        return true;
    }

    bool readU16LE(std::uint16_t& out)
    {
        if (!remaining(2)) return false;
        out = static_cast<std::uint16_t>(data[pos])
            | static_cast<std::uint16_t>(static_cast<std::uint16_t>(data[pos + 1]) << 8);
        pos += 2;
        return true;
    }

    bool readU32LE(std::uint32_t& out)
    {
        if (!remaining(4)) return false;
        out = static_cast<std::uint32_t>(data[pos])
            | static_cast<std::uint32_t>(data[pos + 1]) <<  8
            | static_cast<std::uint32_t>(data[pos + 2]) << 16
            | static_cast<std::uint32_t>(data[pos + 3]) << 24;
        pos += 4;
        return true;
    }

    bool matchMagic(const char (&magic)[5])  // 4 chars + null terminator
    {
        if (!remaining(4)) return false;
        if (std::memcmp(data + pos, magic, 4) != 0) return false;
        pos += 4;
        return true;
    }

    // FL Studio variable-length quantity: low 7 bits of each byte are payload,
    // MSB is the continuation flag.  At most 5 bytes for a 32-bit value.
    bool readVLQ(std::uint32_t& out)
    {
        out = 0;
        for (int i = 0; i < 5; ++i)
        {
            std::uint8_t b;
            if (!readU8(b)) return false;
            out |= static_cast<std::uint32_t>(b & 0x7Fu) << (7 * i);
            if ((b & 0x80u) == 0) return true;
        }
        return false;  // VLQ longer than 5 bytes — malformed
    }
};

void setError(FscParseResult& r, std::string msg)
{
    r.ok = false;
    r.error = std::move(msg);
    r.notes.clear();
}

// Little-endian field readers over a fixed 24-byte record buffer.
std::uint32_t readU32(const std::uint8_t* p)
{
    return  static_cast<std::uint32_t>(p[0])
         | (static_cast<std::uint32_t>(p[1]) <<  8)
         | (static_cast<std::uint32_t>(p[2]) << 16)
         | (static_cast<std::uint32_t>(p[3]) << 24);
}

std::uint16_t readU16(const std::uint8_t* p)
{
    return static_cast<std::uint16_t>(
        static_cast<std::uint16_t>(p[0])
        | static_cast<std::uint16_t>(static_cast<std::uint16_t>(p[1]) << 8));
}

// Decode the 24-byte 0xE0 note record using the verified FL Studio layout.
// Key and group are SEPARATE u16 fields — they must not be fused into one u32
// (the historical decode bug this parser was rewritten to fix).
ImportedFscNote decodeNoteRecord(const std::uint8_t* p)
{
    ImportedFscNote n;
    n.sourcePositionTicks = readU32(p + 0);      // offset 0..3
    n.flags               = readU16(p + 4);      // offset 4..5
    // offset 6..7 = rackChannel (unused this pass)
    n.sourceLengthTicks   = readU32(p + 8);      // offset 8..11
    n.key                 = static_cast<int>(readU16(p + 12)); // offset 12..13
    n.group               = readU16(p + 14);     // offset 14..15
    n.finePitch           = p[16];               // offset 16
    // offset 17 = reserved
    n.release             = p[18];               // offset 18
    n.markerByte          = p[19];               // offset 19 (FL portamento marker == 16)
    n.pan                 = p[20];               // offset 20
    const std::uint8_t velocityByte = p[21];     // offset 21
    n.modX                = p[22];               // offset 22
    n.modY                = p[23];               // offset 23

    n.velocity = std::clamp(static_cast<float>(velocityByte) / 127.0f, 0.0f, 1.0f);
    // The slide flag wins: a marker-16 (portamento) note with the slide bit set
    // is still a slide.  Marker 16 alone never implies slide.
    n.isSlide  = (n.flags & kSlideFlag) != 0u;
    return n;
}

// xlethTick = round(sourceTick * 960 / sourcePpq), computed in double then
// validated to be finite and in int64 range.  Returns false on overflow/NaN so
// the caller can drop the note instead of storing a garbage tick value.
bool convertTicks(std::uint32_t sourceTicks, int sourcePpq, std::int64_t& out)
{
    const double scaled = static_cast<double>(sourceTicks)
                        * static_cast<double>(kXlethPpq)
                        / static_cast<double>(sourcePpq);
    if (!(scaled == scaled)) return false;  // NaN (NaN never equals itself)

    const double r = std::round(scaled);
    if (r < static_cast<double>(std::numeric_limits<std::int64_t>::min())) return false;
    if (r > static_cast<double>(std::numeric_limits<std::int64_t>::max())) return false;

    out = static_cast<std::int64_t>(std::llround(scaled));
    return true;
}

} // namespace

FscParseResult FscScoreParser::parseFile(const std::string& filePath)
{
    FscParseResult r;
    r.xlethPpq = kXlethPpq;

    std::ifstream in(filePath, std::ios::binary);
    if (!in.is_open()) { setError(r, "could not open file: " + filePath); return r; }

    std::vector<std::uint8_t> bytes((std::istreambuf_iterator<char>(in)),
                                     std::istreambuf_iterator<char>());
    if (bytes.empty()) { setError(r, "empty file: " + filePath); return r; }

    return parseBytes(bytes.data(), bytes.size());
}

FscParseResult FscScoreParser::parseBytes(const std::uint8_t* data, std::size_t size)
{
    FscParseResult r;
    r.xlethPpq = kXlethPpq;

    if (data == nullptr || size == 0u) { setError(r, "empty input"); return r; }

    Reader rd{ data, size, 0 };

    // ── FLhd chunk ───────────────────────────────────────────────────────────
    if (!rd.matchMagic("FLhd")) { setError(r, "missing FLhd magic (not an FL Studio score file)"); return r; }

    std::uint32_t hdrLen = 0;
    if (!rd.readU32LE(hdrLen)) { setError(r, "truncated FLhd chunk size"); return r; }
    if (hdrLen != 6u)          { setError(r, "unexpected FLhd chunk size (expected 6)"); return r; }
    if (!rd.remaining(hdrLen)) { setError(r, "truncated FLhd payload"); return r; }

    std::uint16_t format = 0, channels = 0, ppq = 0;
    if (!rd.readU16LE(format) || !rd.readU16LE(channels) || !rd.readU16LE(ppq))
    {
        setError(r, "truncated FLhd payload");
        return r;
    }
    if (ppq == 0u) { setError(r, "invalid source PPQ (zero) in FLhd"); return r; }
    r.sourcePpq = static_cast<int>(ppq);
    (void)format; (void)channels;

    // ── FLdt chunk ───────────────────────────────────────────────────────────
    if (!rd.matchMagic("FLdt")) { setError(r, "missing FLdt magic"); return r; }

    std::uint32_t dataLen = 0;
    if (!rd.readU32LE(dataLen)) { setError(r, "truncated FLdt chunk size"); return r; }
    if (!rd.remaining(dataLen)) { setError(r, "truncated FLdt payload"); return r; }
    const std::size_t dataEnd = rd.pos + dataLen;

    // ── Event stream ─────────────────────────────────────────────────────────
    // FL event tag classes:
    //   0..63    byte event   (1-byte payload)
    //   64..127  word event   (2-byte payload)
    //   128..191 dword event  (4-byte payload)
    //   192..255 variable     (VLQ size prefix, then payload)
    while (rd.pos < dataEnd)
    {
        std::uint8_t tag = 0;
        if (!rd.readU8(tag)) { setError(r, "truncated event tag"); return r; }

        if (tag < 0x40u)        // byte event
        {
            if (!rd.remaining(1)) { setError(r, "truncated byte event"); return r; }
            rd.pos += 1;
        }
        else if (tag < 0x80u)   // word event
        {
            if (!rd.remaining(2)) { setError(r, "truncated word event"); return r; }
            rd.pos += 2;
        }
        else if (tag < 0xC0u)   // dword event
        {
            if (!rd.remaining(4)) { setError(r, "truncated dword event"); return r; }
            rd.pos += 4;
        }
        else                    // variable event (incl. 0xE0 note records)
        {
            std::uint32_t payloadLen = 0;
            if (!rd.readVLQ(payloadLen))
            {
                setError(r, "malformed variable-event length prefix");
                return r;
            }
            if (!rd.remaining(payloadLen))
            {
                setError(r, "truncated variable-event payload");
                return r;
            }

            if (tag == kEventNote)
            {
                if ((payloadLen % kNoteRecordSize) != 0u)
                {
                    setError(r, "0xE0 note payload size " + std::to_string(payloadLen)
                                + " is not a multiple of the 24-byte note record");
                    return r;
                }

                const std::size_t noteCount = payloadLen / kNoteRecordSize;
                for (std::size_t i = 0; i < noteCount; ++i)
                {
                    ImportedFscNote note = decodeNoteRecord(data + rd.pos + i * kNoteRecordSize);

                    // Untrusted-input guards: drop, don't abort.
                    if (note.key > 127)            { ++r.droppedCount; continue; }

                    std::int64_t startTick = 0, lengthTick = 0;
                    if (!convertTicks(note.sourcePositionTicks, r.sourcePpq, startTick)
                        || !convertTicks(note.sourceLengthTicks, r.sourcePpq, lengthTick))
                    {
                        ++r.droppedCount; continue;  // overflow / NaN
                    }
                    if (lengthTick <= 0)           { ++r.droppedCount; continue; }

                    note.xlethStartTick  = startTick;
                    note.xlethLengthTick = lengthTick;
                    r.notes.push_back(note);
                }
            }

            rd.pos += payloadLen;
        }
    }

    r.ok = true;
    return r;
}

} // namespace xleth::import
