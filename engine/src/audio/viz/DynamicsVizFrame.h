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
    // Reserved for future plugins (do NOT instantiate yet — Compressor only):
    //   kVizTypeLimiter    = 2,
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

}} // namespace xleth::viz
