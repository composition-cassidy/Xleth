#pragma once

#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_audio_formats/juce_audio_formats.h>

#include <atomic>
#include <cstdint>
#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>
#include <vector>

// ─────────────────────────────────────────────────────────────────────────────
// Multi-resolution waveform mipmap.
//
// Pre-computes min/max/RMS summary data at 6 reduction levels for fast
// waveform display at any zoom.  Two construction modes:
//   Mode 1 — from a juce::AudioBuffer<float> already in memory (SampleBank)
//   Mode 2 — from an audio file on disk (WAV/AIFF/FLAC/OGG/MP3 via JUCE)
//
// Persisted as .xlpeak binary files alongside the source audio for fast reload.
// ─────────────────────────────────────────────────────────────────────────────
class WaveformMipmap
{
public:
    static constexpr int kNumLevels = 6;
    static constexpr int kReductionFactors[6] = { 4, 16, 64, 256, 1024, 4096 };
    static constexpr int kValuesPerPoint = 3; // min, max, rms

    struct LevelInfo
    {
        int  samplesPerPoint = 0;
        int  numPoints       = 0;
        // Flat float array.  Layout per channel is contiguous:
        //   [ch0: (min,max,rms) × numPoints | ch1: (min,max,rms) × numPoints | …]
        std::vector<float> data;
    };

    WaveformMipmap() = default;

    // ── Generation ──────────────────────────────────────────────────────────

    // Mode 1: from an in-memory AudioBuffer (e.g. SampleBank).
    // The buffer must remain valid for getRawSamples() to work later.
    bool generate(const juce::AudioBuffer<float>& buffer, int sampleRate);

    // Mode 2: from an audio file on disk.
    // Tries JUCE AudioFormatManager (WAV/AIFF/FLAC/OGG/MP3) first, then falls
    // back to FFmpeg C API for containers JUCE can't read (MP4/MKV/MOV/WebM/AVI).
    // getRawSamples() will not work (no persistent source buffer).
    bool generateFromFile(const juce::File& audioFile);

    // ── .xlpeak persistence ─────────────────────────────────────────────────

    bool saveToFile(const juce::File& peakFile) const;
    bool loadFromFile(const juce::File& peakFile, uint64_t expectedHash);

    // ── Queries ─────────────────────────────────────────────────────────────

    // Fill outBuffer with [min,max,rms] triples, one per pixel column.
    // Returns the number of columns actually written.
    // needsRawSamples is set true when zoom is finer than level 0 (< 4 spp).
    int getPeaks(int channel, int64_t startSample, int64_t endSample,
                 int targetPixels, float* outBuffer, int outBufferSize,
                 bool& needsRawSamples) const;

    // Return raw sample values for sample-level zoom (mode 1 only).
    // Returns 0 if no source buffer is available (mode 2 or not set).
    int getRawSamples(int channel, int64_t startSample, int64_t endSample,
                      float* outBuffer, int outBufferSize) const;

    // ── Accessors ───────────────────────────────────────────────────────────

    int      getNumChannels()  const { return numChannels_; }
    int      getSampleRate()   const { return sampleRate_; }
    int64_t  getTotalSamples() const { return totalSamples_; }
    bool     isReady()         const { return ready_.load(std::memory_order_acquire); }
    bool     hasFailed()      const { return generationFailed_.load(std::memory_order_acquire); }

    void     setSourceBuffer(const juce::AudioBuffer<float>* buf) { sourceBuffer_ = buf; }
    void     setSourceHash(uint64_t hash) { sourceHash_ = hash; }
    uint64_t getSourceHash() const { return sourceHash_; }

    // ── Hashing ─────────────────────────────────────────────────────────────

    // FNV-1a hash of first 64 KB + file size + last-modified time.
    static uint64_t computeSourceHash(const juce::File& sourceFile);

private:
    int      numChannels_  = 0;
    int      sampleRate_   = 0;
    int64_t  totalSamples_ = 0;
    uint64_t sourceHash_   = 0;

    LevelInfo levels_[kNumLevels];

    // Mode 1: pointer to the source buffer for getRawSamples().
    // SampleBank buffers are append-only and immutable — pointer is stable.
    const juce::AudioBuffer<float>* sourceBuffer_ = nullptr;

    std::atomic<bool> ready_{ false };
    std::atomic<bool> generationFailed_{ false };

    void computeLevel(const juce::AudioBuffer<float>& buffer, int levelIdx);
    int  selectLevel(double samplesPerPixel) const;
};


// ─────────────────────────────────────────────────────────────────────────────
// Cache of WaveformMipmaps with background generation.
//
// Keys are strings — typically std::to_string(sampleBankId) for mode-1
// mipmaps, or a file path for mode-2 mipmaps.
// ─────────────────────────────────────────────────────────────────────────────
class WaveformMipmapCache
{
public:
    // Returns the ready mipmap for key, or nullptr if not yet available.
    WaveformMipmap* get(const std::string& key) const;

    // Generate from an in-memory buffer on a background thread.
    // If saveXlpeak is true, also save/load a .xlpeak file alongside sourceFile.
    void generateFromBuffer(const std::string& key,
                            const juce::AudioBuffer<float>* buffer,
                            int sampleRate,
                            const juce::File& sourceFile,
                            bool saveXlpeak);

    // Generate from an audio file on disk on a background thread.
    void generateFromFile(const std::string& key, const juce::File& audioFile);

    void remove(const std::string& key);
    void clear();

private:
    mutable std::mutex mutex_;
    std::unordered_map<std::string, std::unique_ptr<WaveformMipmap>> cache_;
};
