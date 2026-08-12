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
inline constexpr uint32_t kDynamicsVizSchemaVersion = 3;

// ── Visualization type tag (used by the bridge to label payload) ────────────
enum VisualizationType : uint32_t
{
    kVizTypeUnknown    = 0,
    kVizTypeCompressor = 1,
    kVizTypeLimiter    = 2,
    kVizTypeTransient  = 3,
    kVizTypeMultiband  = 4,   // 3-band dynamics (Overdone / OTT)
    kVizTypeResonance  = 5,   // Resonance Suppressor spectral buckets
    kVizTypeUniFlange  = 6,   // UniFlange dry/wet waveform envelope
    kVizTypeApex       = 7,   // APEX multiband maximizer (4 bands + FFT spectrum)
};

inline constexpr uint32_t kResonanceVizBucketCount = 128;

// APEX: positive-frequency magnitude bins of a 2048-point real FFT.
// 2048/2 = 1024 bins spanning DC .. (Nyquist - binWidth).
inline constexpr uint32_t kApexVizFftSize      = 2048;
inline constexpr uint32_t kApexVizSpectrumBins = kApexVizFftSize / 2;
inline constexpr uint32_t kApexVizNumBands     = 4;   // LOW, MID, HIGH, MASTER

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

// ── Transient payload ────────────────────────────────────────────────────────
// 16 bytes header + 10 floats (40 bytes) = 56 bytes total. 8-byte aligned.
//
// inLevelDb / outLevelDb: peak abs over the bucket on input / output.
// fastEnvDb / slowEnvDb : last-sample of the fast (transient) and slow
//   (sustain) envelope followers, in dB. NaN when the effect is in MIDI mode
//   (the envelope followers are not run there) — the parser MUST tolerate NaN.
// gainDb                : dominant signed gain seen in the bucket (positive =
//   boost, negative = cut). Maps directly to the transient processor's
//   signed-gain meter slot 2.
// attackAmount          : current 'attack'  param, normalised to [-1, 1].
// sustainAmount         : current 'sustain' param, normalised to [-1, 1].
// speedMs               : current 'attack_speed' param (ms).
// thresholdDb           : current 'threshold' param (dB; envelope mode only).
// mix                   : current 'mix' param normalised to [0, 1].
struct alignas(8) TransientBucket
{
    BucketHeader hdr;
    float inLevelDb;     // peak |x| over bucket, pre-process
    float outLevelDb;    // peak |y| over bucket, post-process
    float fastEnvDb;     // last-sample fast envelope (transient detector)
    float slowEnvDb;     // last-sample slow envelope (sustain follower)
    float gainDb;        // dominant signed gain in bucket (positive = boost, negative = cut)
    float attackAmount;  // attack param normalised to [-1, 1]
    float sustainAmount; // sustain param normalised to [-1, 1]
    float speedMs;       // smoothed attack_speed param at bucket end
    float thresholdDb;   // smoothed threshold param at bucket end (envelope mode)
    float mix;           // mix param normalised to [0, 1]
};

static_assert(sizeof(TransientBucket) == 56, "TransientBucket expected 56 bytes");
static_assert(alignof(TransientBucket) == 8, "TransientBucket expected 8-byte alignment");
static_assert(std::is_trivially_copyable<TransientBucket>::value,
              "TransientBucket must be trivially copyable");
static_assert(std::is_standard_layout<TransientBucket>::value,
              "TransientBucket must be standard layout");

// ── Multiband payload (Overdone / 3-band OTT) ────────────────────────────────
// 16 bytes header + 15 floats (60 bytes) + 4 bytes pad = 80 bytes total.
// 8-byte aligned. Fields are dB unless noted.
//
// All values are computed cheaply on the audio thread (peak |x| trackers,
// envelope-follower state already in flight, smoothed parameter snapshots).
// Per-band gain reduction is reported as a POSITIVE dB amount to match the
// existing CompressorBucket / LimiterBucket convention (positive = more
// reduction). The audio path NEVER fakes a value: if a field is not measured
// this bucket, it carries the previous-bucket sentinel (-120 dB for levels,
// 0 dB for GR).
//
// inputPeakDb / outputPeakDb are the global pre-process / post-process peak
// abs levels over the bucket window. depth / time are smoothed param snapshots
// at bucket end (stored in the SAME percent-units as the engine APVTS layout —
// 0..100). lowCrossoverHz / highCrossoverHz are the smoothed crossover params
// in Hz at bucket end.
//
// Per-band input is the peak abs of the band signal AFTER crossover but
// BEFORE the OTT gain stage. Per-band output is the peak abs AFTER the OTT
// gain stage. Together they let the painter display the band's own activity
// AND the band's gain change as separate visual layers without re-running DSP
// on the UI side.
struct alignas(8) MultibandBucket
{
    BucketHeader hdr;
    // Global
    float inputPeakDb;          // peak |x| pre-process (all bands combined input)
    float outputPeakDb;         // peak |y| post-process (master output)
    float depth;                // smoothed depth param (percent, 0..100)
    float time;                 // smoothed time  param (percent, 0..100)
    float lowCrossoverHz;       // smoothed xover_low param (Hz)
    float highCrossoverHz;      // smoothed xover_high param (Hz)
    // Low band
    float lowInputDb;           // peak abs band input (post-crossover, pre-gain)
    float lowOutputDb;          // peak abs band output (post-gain)
    float lowGainReductionDb;   // max GR dB this bucket (positive = reduction)
    // Mid band
    float midInputDb;
    float midOutputDb;
    float midGainReductionDb;
    // High band
    float highInputDb;
    float highOutputDb;
    float highGainReductionDb;
    float reserved0;            // pad to 8-byte alignment / 80 bytes total
};

static_assert(sizeof(MultibandBucket) == 80, "MultibandBucket expected 80 bytes");
static_assert(alignof(MultibandBucket) == 8, "MultibandBucket expected 8-byte alignment");
static_assert(std::is_trivially_copyable<MultibandBucket>::value,
              "MultibandBucket must be trivially copyable");
static_assert(std::is_standard_layout<MultibandBucket>::value,
              "MultibandBucket must be standard layout");

// Resonance Suppressor payload
// 16 bytes header + 8 metadata floats (32 bytes) + 3 * 128 float arrays
// (1536 bytes) = 1584 bytes total. 8-byte aligned.
//
// spectrum[i] is a dB-mapped magnitude normalised to [0, 1], where 0 is
// approximately -120 dB and 1 is 0 dB or hotter. reduction[i] is the current
// smoothed gain reduction normalised to [0, 1] against the 24 dB hard-mode
// ceiling. weighting[i] is the raw suppression sensitivity scalar in [0, 2.5].
//
// The arrays are log-frequency buckets over positive-frequency FFT bins. They
// are visualization data only and do not feed back into DSP.
struct alignas(8) ResonanceBucket
{
    BucketHeader hdr;
    float sampleRate;
    float fftSize;
    float qualityIndex;
    float stereoMode;
    float activity;
    float bucketCount;
    float maxReductionDb;
    float reserved0;
    float spectrum[kResonanceVizBucketCount];
    float reduction[kResonanceVizBucketCount];
    float weighting[kResonanceVizBucketCount];
};

static_assert(sizeof(ResonanceBucket) == 1584, "ResonanceBucket expected 1584 bytes");
static_assert(alignof(ResonanceBucket) == 8, "ResonanceBucket expected 8-byte alignment");
static_assert(std::is_trivially_copyable<ResonanceBucket>::value,
              "ResonanceBucket must be trivially copyable");
static_assert(std::is_standard_layout<ResonanceBucket>::value,
              "ResonanceBucket must be standard layout");

// ── UniFlange payload ────────────────────────────────────────────────────────
// 16 bytes header + 4 floats (16 bytes) = 32 bytes total. 8-byte aligned.
//
// Unlike the other bucket types (which track peak |x| and report dB), this
// bucket tracks SIGNED linear min/max excursion over the bucket for two taps:
// the dry (pre-effect, mono-summed input) signal and the wet (post cross-mix,
// pre dry/wet-gain-blend ensemble) signal. Linear + signed so the UI can draw
// a real above/below-center waveform shape instead of a rectified level
// trace. NOT dB, NOT abs — do not reuse the *ToDb() helpers from the other
// accumulators against these fields.
struct alignas(8) UniFlangeBucket
{
    BucketHeader hdr;
    float dryMin;   // min sample value over bucket, pre-effect mono input
    float dryMax;   // max sample value over bucket, pre-effect mono input
    float wetMin;   // min sample value over bucket, post cross-mix ensemble
    float wetMax;   // max sample value over bucket, post cross-mix ensemble
};

static_assert(sizeof(UniFlangeBucket) == 32, "UniFlangeBucket expected 32 bytes");
static_assert(alignof(UniFlangeBucket) == 8, "UniFlangeBucket expected 8-byte alignment");
static_assert(std::is_trivially_copyable<UniFlangeBucket>::value,
              "UniFlangeBucket must be trivially copyable");
static_assert(std::is_standard_layout<UniFlangeBucket>::value,
              "UniFlangeBucket must be standard layout");

// ── APEX payload (multiband maximizer) ───────────────────────────────────────
// 16 bytes header + 20 metadata floats (80 bytes) + 1024 spectrum floats
// (4096 bytes) = 4192 bytes total. 8-byte aligned. The spectrum array
// therefore starts at byte 96.
//
// This bucket is DELIBERATELY much larger and much rarer than every other
// bucket type in this file. The others emit one bucket per
// kDynamicsVizBucketSize (64) samples — ~700/s — because they carry a handful
// of scalars each. APEX carries a whole 2048-point FFT magnitude spectrum, so
// it emits one bucket per kApexVizBucketSize samples instead (~30-43/s at
// 44.1-48 kHz), which is exactly the ~30 Hz cadence the UI drains at. Emitting
// it at the default 64-sample cadence would be ~3 MB/s of IPC for data no
// display can use. Ring depth is scaled down to match (see kApexVizRingDepth).
//
// bandGrDb[b] is the MAXIMUM gain reduction over the bucket for band b as a
// POSITIVE dB amount, matching the CompressorBucket / LimiterBucket convention
// (positive = more reduction). Band order is LOW, MID, HIGH, MASTER — the same
// order as xleth_apex::BandIndex, so index b here is band b there.
//
// bandInDb[b] is the level the band's transfer curve was actually READ at over
// the bucket, in dB: the maximum of band b's detector envelope (post PRE GAIN,
// pre curve gain), i.e. the X coordinate of the moving dot on the curve editor.
// It is a DETECTOR level, not a raw peak, so it carries the band's ATT/REL/
// SUSTAIN ballistics and PEAK/RMS mode — which is the whole point: the number
// drawn on the curve is the number the curve was evaluated with. A band whose
// dynamics are bypassed (COMP OFF) reports its plain post-PRE-GAIN peak, and a
// band that is OFF or MUTED reports -120 dB.
//
// bandOutDb[b] is the peak abs OUTPUT level of band b over the bucket, in dB.
// For LOW/MID/HIGH this is measured after the band's full chain (curve gain,
// saturation, post gain, stereo separation) and before the band sum; for
// MASTER it is the effect's final stereo output. A band that is OFF or MUTED
// reports its real (possibly silent) level — the audio path never fakes a
// value.
//
// inputPeakDb is the peak abs input AFTER LOW CUT (the same signal the
// spectrum is measured from, so the analysis display and the input meter
// always agree). outputPeakDb is the final output peak.
//
// lookaheadSamples / latencySamples mirror the effect's published lookahead
// and its TOTAL reported latency (lookahead + saturation oversampling) at
// bucket end. They are carried here purely so the UI can label the analysis
// display without a separate poll; audio_getEffectLatency is the authoritative
// query.
//
// splitLoHz / splitHiHz are the crossover frequencies at bucket end, so the UI
// can tint the spectrum's band regions without re-reading parameters.
//
// spectrum[i] is 20*log10(|X[i]|) of a Hann-windowed 2048-point real FFT of
// the mono-summed post-LOW-CUT input, normalised so a full-scale sine reads
// 0 dB, and floored at -120 dB. spectrumBins states how many entries are
// valid (always kApexVizSpectrumBins today; a float so the whole struct stays
// a uniform float block after the header).
struct alignas(8) ApexBucket
{
    BucketHeader hdr;
    float inputPeakDb;                    // peak |x| over bucket, post LOW CUT
    float outputPeakDb;                   // peak |y| over bucket, final output
    float bandGrDb  [kApexVizNumBands];   // max GR dB (positive = reduction)
    float bandOutDb [kApexVizNumBands];   // peak band output level, dB
    float bandInDb  [kApexVizNumBands];   // max band detector level, dB
    float lookaheadSamples;               // published LOOKAHEAD, in samples
    float latencySamples;                 // total reported latency, in samples
    float splitLoHz;                      // LOW|MID crossover at bucket end
    float splitHiHz;                      // MID|HIGH crossover at bucket end
    float sampleRate;                     // engine sample rate (Hz)
    float spectrumBins;                   // valid entries in spectrum[]
    float spectrum[kApexVizSpectrumBins]; // input magnitude spectrum, dB
};

static_assert(sizeof(ApexBucket) == 4192, "ApexBucket expected 4192 bytes");
static_assert(alignof(ApexBucket) == 8, "ApexBucket expected 8-byte alignment");
static_assert(std::is_trivially_copyable<ApexBucket>::value,
              "ApexBucket must be trivially copyable");
static_assert(std::is_standard_layout<ApexBucket>::value,
              "ApexBucket must be standard layout");

// APEX cadence. This is a MINIMUM, not an exact period: the accumulator flushes
// at the first BLOCK boundary at or past kApexVizBucketSize samples, so a bucket
// actually spans 1024..(1024 + blockSize - 1) samples and reports its true span
// in hdr.bucketSamples. The realistic range is ~31-47 Hz (e.g. 441-sample blocks
// at 44.1 kHz flush every 3 blocks = 1323 samples ≈ 33 Hz) — comfortably at or
// above the UI's 30 Hz drain so no tick comes up empty, and low enough that the
// FFT cost is negligible. Consumers must read hdr.bucketSamples rather than
// assume 1024.
//
// Ring depth 16 ≈ 400 ms of headroom, which is > 10 drain intervals; the full
// 1024-deep default would be a 4 MB allocation for buckets nothing would read.
inline constexpr uint32_t kApexVizBucketSize = 1024;
inline constexpr uint32_t kApexVizRingDepth  = 16;

}} // namespace xleth::viz
