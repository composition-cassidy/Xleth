#pragma once

// ─── DynamicsVizFrame.h ────────────────────────────────────────────────────────
// POD bucket structs for streaming dynamics-plugin visualization data from the
// audio thread to the UI process. One bucket holds the values accumulated over
// kBucketSize audio samples; many buckets are pushed into a per-effect SPSC
// ring buffer (DynamicsVizCollector) and drained from the main thread by the
// bridge layer.
//
// All visualization values are dB unless suffixed _lin. NaN means
// "not measured this bucket". POD only — no strings, vectors, virtuals.
//
// Schema is versioned (kDynamicsVizSchemaVersion) and mirrored in the JS
// constants file ui/src/constants/dynamicsViz.js. Bump on any layout change.

#include <cstddef>
#include <cstdint>
#include <type_traits>

namespace xleth { namespace viz {

// ── Schema version (bump on any struct layout change) ───────────────────────
inline constexpr uint32_t kDynamicsVizSchemaVersion = 1;

// ── Visualization type tag (used by the bridge to label payload) ────────────
enum VisualizationType : uint32_t
{
    kVizTypeUnknown    = 0,
    kVizTypeCompressor = 1,
    kVizTypeLimiter    = 2,
    // Reserved for future plugins:
    //   kVizTypeTransient  = 3,
    //   kVizTypeMultiband  = 4,
};

// ── Default cadence ──────────────────────────────────────────────────────────
// Bucket size = 64 samples ≈ 1.45 ms @ 44.1 kHz, ≈ 1.33 ms @ 48 kHz.
// Ring depth = 1024 buckets ≈ 1.4 s of headroom.
inline constexpr uint32_t kDynamicsVizBucketSize = 64;
inline constexpr uint32_t kDynamicsVizRingDepth  = 1024;

// ── Header (shared by all dynamics frame types) ──────────────────────────────
// 16 bytes, 8-byte aligned.
struct alignas(8) BucketHeader
{
    uint64_t sampleClock;    // audio sample index of bucket start
    uint32_t bucketSamples;  // number of samples accumulated in this bucket
    uint32_t flags;          // reserved: bit 0 = clip hit, bit 1 = gate active,
                             //           bit 2 = transient onset, etc.
};

static_assert(sizeof(BucketHeader) == 16, "BucketHeader expected 16 bytes");
static_assert(alignof(BucketHeader) == 8, "BucketHeader expected 8-byte alignment");
static_assert(std::is_trivially_copyable<BucketHeader>::value,
              "BucketHeader must be trivially copyable");
static_assert(std::is_standard_layout<BucketHeader>::value,
              "BucketHeader must be standard layout");

// ── Compressor payload ───────────────────────────────────────────────────────
// 16 bytes header + 6 floats (24 bytes) = 40 bytes total. 8-byte aligned.
struct alignas(8) CompressorBucket
{
    BucketHeader hdr;
    float inLevelDb;    // peak |x| over bucket, pre-process
    float outLevelDb;   // peak |y| over bucket, post-process
    float detectorDb;   // envDB at last sample of bucket
    float grDb;         // max GR over bucket (positive = more reduction)
    float ioInDb;       // input level at last sample of bucket (transfer-curve dot X)
    float ioOutDb;      // matching output level (transfer-curve dot Y)
};

static_assert(sizeof(CompressorBucket) == 40, "CompressorBucket expected 40 bytes");
static_assert(alignof(CompressorBucket) == 8, "CompressorBucket expected 8-byte alignment");
static_assert(std::is_trivially_copyable<CompressorBucket>::value,
              "CompressorBucket must be trivially copyable");
static_assert(std::is_standard_layout<CompressorBucket>::value,
              "CompressorBucket must be standard layout");

// ── Limiter payload ──────────────────────────────────────────────────────────
// 16 bytes header + 9 floats (36 bytes) + 4 bytes pad = 56 bytes total.
// 8-byte aligned. Fields are dB unless noted.
//
// inLevelDb / outLevelDb track the peak abs level over the bucket on the
// pre-limit input and post-limit output. gainReductionDb is the maximum gain
// reduction observed in the bucket as a positive dB value (e.g. 6 means a
// 6 dB reduction was applied at some point this bucket).
//
// inEnergyDb / outEnergyDb are mean-square energy over the bucket converted
// to dB (10*log10), used as a cheap stand-in for an RMS / loudness-like
// trace. NOT calibrated against any LUFS / EBU R128 / ITU-R BS.1770 standard
// and must NOT be labelled as such on the UI side.
//
// ceilingDb / gainDb are the smoothed ceiling and gain parameters at the end
// of the bucket — used to draw the threshold/ceiling line and to label the
// current makeup gain.
//
// releaseMs is the smoothed release parameter (purely informational).
struct alignas(8) LimiterBucket
{
    BucketHeader hdr;
    float inLevelDb;        // peak |x| over bucket, pre-limit (post-gain)
    float outLevelDb;       // peak |y| over bucket, post-limit
    float gainReductionDb;  // max GR over bucket (positive = more reduction)
    float inEnergyDb;       // mean-square dB over bucket (input, post-gain)
    float outEnergyDb;      // mean-square dB over bucket (output)
    float ceilingDb;        // smoothed ceiling param at bucket end
    float gainDb;           // smoothed gain param at bucket end
    float releaseMs;        // smoothed release param at bucket end
    float reserved0;        // reserved / padding to keep 8-byte alignment
};

static_assert(sizeof(LimiterBucket) == 56, "LimiterBucket expected 56 bytes");
static_assert(alignof(LimiterBucket) == 8, "LimiterBucket expected 8-byte alignment");
static_assert(std::is_trivially_copyable<LimiterBucket>::value,
              "LimiterBucket must be trivially copyable");
static_assert(std::is_standard_layout<LimiterBucket>::value,
              "LimiterBucket must be standard layout");

}} // namespace xleth::viz
