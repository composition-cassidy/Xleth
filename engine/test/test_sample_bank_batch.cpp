// test_sample_bank_batch — SampleBank::loadSamplesFromSources (the parallel
// loader project load uses) must be indistinguishable from calling
// loadSampleFromSource once per request, in order:
//
//   • same ids, in request order, a failed request taking no id;
//   • the same PCM, bit for bit, for every request — whatever the thread count;
//   • the same SampleInfo.
//
// The batch exists purely to shorten project load. If it ever produced a
// different sample than the sequential path, a project would sound different
// depending on how it was opened — so the comparison here is memcmp, not a
// tolerance.
//
// Media: a WAV synthesized here (always), decoded at its own rate and at a
// different one (so the resampler is in the path). Set XLETH_TEST_MEDIA to a
// real file (e.g. an .mp4 with AAC audio) to run the same checks against a
// compressed, seek-dependent source as well.
//
// Output prefix: [SampleBankBatch].

#include "SampleBank.h"

#include <juce_audio_formats/juce_audio_formats.h>
#include <juce_core/juce_core.h>

#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <memory>
#include <string>
#include <vector>

namespace {

int g_pass = 0, g_fail = 0;

void check(bool ok, const std::string& what)
{
    if (ok) { ++g_pass; std::printf("[SampleBankBatch] PASS %s\n", what.c_str()); }
    else    { ++g_fail; std::printf("[SampleBankBatch] FAIL %s\n", what.c_str()); }
    std::fflush(stdout);
}

// 24 s of stereo: two detuned sines plus LCG noise, so every range of it is
// distinct and a misplaced or shifted decode cannot compare equal by accident.
bool writeTestWav(const juce::File& file, double sampleRate)
{
    const int n = static_cast<int>(24.0 * sampleRate);
    juce::AudioBuffer<float> buf(2, n);
    uint64_t st = 0x9E3779B97F4A7C15ull;
    for (int i = 0; i < n; ++i)
    {
        st = st * 6364136223846793005ull + 1442695040888963407ull;
        const float noise = static_cast<float>(static_cast<double>(st >> 40) / 8388608.0 - 1.0) * 0.1f;
        const double t = i / sampleRate;
        buf.setSample(0, i, 0.4f * static_cast<float>(std::sin(2.0 * juce::MathConstants<double>::pi * (220.0 + 3.0 * t) * t)) + noise);
        buf.setSample(1, i, 0.4f * static_cast<float>(std::sin(2.0 * juce::MathConstants<double>::pi * (331.0 - 2.0 * t) * t)) - noise);
    }
    file.deleteFile();
    juce::WavAudioFormat fmt;
    std::unique_ptr<juce::FileOutputStream> out(file.createOutputStream());
    if (!out) return false;
    std::unique_ptr<juce::AudioFormatWriter> writer(
        fmt.createWriterFor(out.get(), sampleRate, 2, 24, {}, 0));
    if (!writer) return false;
    out.release();   // the writer owns the stream now
    return writer->writeFromAudioSampleBuffer(buf, 0, n);
}

bool sameSample(const SampleBank& a, int idA, const SampleBank& b, int idB, std::string& why)
{
    const auto* x = a.getSample(idA);
    const auto* y = b.getSample(idB);
    if (!x || !y) { why = "missing buffer"; return false; }
    if (x->getNumChannels() != y->getNumChannels() || x->getNumSamples() != y->getNumSamples())
    {
        why = "shape " + std::to_string(x->getNumSamples()) + " vs " + std::to_string(y->getNumSamples());
        return false;
    }
    for (int ch = 0; ch < x->getNumChannels(); ++ch)
        if (std::memcmp(x->getReadPointer(ch), y->getReadPointer(ch),
                        static_cast<size_t>(x->getNumSamples()) * sizeof(float)) != 0)
        { why = "PCM differs on channel " + std::to_string(ch); return false; }
    const auto ia = a.getSampleInfo(idA), ib = b.getSampleInfo(idB);
    if (ia.name != ib.name || ia.numChannels != ib.numChannels || ia.numSamples != ib.numSamples
        || ia.originalSampleRate != ib.originalSampleRate || ia.bufferSampleRate != ib.bufferSampleRate)
    { why = "SampleInfo differs"; return false; }
    return true;
}

void runCase(const std::string& label, const std::string& mediaPath, double mediaDurationSec,
             double engineRate, const std::string& missingPath)
{
    using Req = SampleBank::SourceRequest;
    std::vector<Req> reqs;
    // Region-like ranges all over the file, overlapping, unsorted (a real
    // project's regions are in id order, not time order).
    const double d = mediaDurationSec;
    const double starts[] = { 0.0, 0.731, 0.05, 0.9, 0.33, 0.61, 0.12, 0.47, 0.8, 0.2, 0.55, 0.0101, 0.97, 0.4, 0.66, 0.27 };
    const double lens[]   = { 0.19, 0.4, 1.44, 0.5, 2.9, 0.27, 0.58, 1.08, 0.44, 2.58, 0.36, 4.1, 0.2, 0.7, 1.6, 0.0105 };
    for (int rep = 0; rep < 3; ++rep)
        for (int i = 0; i < 16; ++i)
        {
            const double s = std::min(starts[i] * d + 0.137 * rep, std::max(0.0, d - 0.05));
            reqs.push_back({ mediaPath, s, s + lens[(i + rep) % 16] });
        }
    // The "whole file, stop at EOF" form project load uses for swapped audio.
    reqs.push_back({ mediaPath, 0.0, 3600.0 });
    // Failures, in the middle and at the end: none of them may take an id.
    reqs.insert(reqs.begin() + 7,  { missingPath, 0.0, 1.0 });      // file does not exist
    reqs.insert(reqs.begin() + 20, { mediaPath, 2.0, 2.0 });        // empty range
    reqs.insert(reqs.begin() + 33, { mediaPath, 5.0, 4.0 });        // inverted range
    reqs.push_back({ missingPath, 1.0, 2.0 });
    // An exact duplicate of an earlier request still gets its own sample.
    reqs.push_back(reqs[3]);
    const int n = static_cast<int>(reqs.size());

    // Reference: one at a time, in order.
    SampleBank ref;
    std::vector<int> refIds;
    const auto t0 = std::chrono::steady_clock::now();
    for (const auto& r : reqs)
        refIds.push_back(ref.loadSampleFromSource(r.filePath, r.startTimeSec, r.endTimeSec, engineRate));
    const double seqMs = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();

    int okCount = 0, failCount = 0;
    for (int id : refIds) (id >= 0 ? okCount : failCount)++;
    check(okCount >= 49 && failCount == 4,
          label + ": reference run decoded " + std::to_string(okCount) + " and rejected " + std::to_string(failCount)
          + " of " + std::to_string(n) + " requests (4 are built to fail)");

    for (int threads : { 1, 2, 5, 12, 0 })
    {
        SampleBank bank;
        const auto t1 = std::chrono::steady_clock::now();
        const std::vector<int> ids = bank.loadSamplesFromSources(reqs, engineRate, /*logEachSuccess=*/false, threads);
        const double ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t1).count();

        bool idsSame = ids.size() == refIds.size();
        for (size_t i = 0; idsSame && i < ids.size(); ++i) idsSame = ids[i] == refIds[i];
        bool pcmSame = idsSame;
        std::string why;
        for (size_t i = 0; pcmSame && i < ids.size(); ++i)
            if (ids[i] >= 0 && !sameSample(ref, refIds[i], bank, ids[i], why))
            { pcmSame = false; why = "request " + std::to_string(i) + ": " + why; }
        const bool countSame = bank.getNumSamples() == ref.getNumSamples();

        char buf[256];
        std::snprintf(buf, sizeof buf, "%s, %s thread(s): ids %s, bank size %s, PCM + info of all %d decoded requests %s  [%.0f ms vs %.0f ms sequential]%s%s",
                      label.c_str(), threads == 0 ? "auto" : std::to_string(threads).c_str(),
                      idsSame ? "identical" : "DIFFER", countSame ? "identical" : "DIFFERS", okCount,
                      pcmSame ? "bit-identical" : "DIFFER", ms, seqMs, why.empty() ? "" : " — ", why.c_str());
        check(idsSame && countSame && pcmSame, buf);
    }
}

// The two per-request options project load relies on, against the plain call
// they stand in for. `durationSec` must be the container's exact duration.
void runRequestOptions(const std::string& path, double durationSec)
{
    // toContainerEnd == "probe the duration, then decode [start, duration)".
    {
        SampleBank ref, bank;
        const int a = ref.loadSampleFromSource(path, 0.0, durationSec, 48000.0);
        const int b = ref.loadSampleFromSource(path, 3.25, durationSec, 44100.0);
        SampleBank::SourceRequest whole;  whole.filePath = path; whole.toContainerEnd = true;
        whole.endTimeSec = 1.0;   // must be ignored
        SampleBank::SourceRequest tail;   tail.filePath = path; tail.startTimeSec = 3.25; tail.toContainerEnd = true;
        tail.sampleRate = 44100.0;
        const std::vector<int> ids = bank.loadSamplesFromSources({ whole, tail }, 48000.0, false);
        std::string why;
        const bool ok = a >= 0 && b >= 0 && ids.size() == 2 && ids[0] >= 0 && ids[1] >= 0
                     && sameSample(ref, a, bank, ids[0], why) && sameSample(ref, b, bank, ids[1], why);
        check(ok, "toContainerEnd decodes exactly [start, container duration): whole file and a tail, bit-identical to the explicit range"
                  + (why.empty() ? std::string() : " — " + why));
    }
    // Per-request sampleRate overrides the batch rate, request by request.
    {
        SampleBank ref, bank;
        const int a = ref.loadSampleFromSource(path, 1.0, 2.5, 48000.0);
        const int b = ref.loadSampleFromSource(path, 1.0, 2.5, 44100.0);
        SampleBank::SourceRequest r48; r48.filePath = path; r48.startTimeSec = 1.0; r48.endTimeSec = 2.5; r48.sampleRate = 48000.0;
        SampleBank::SourceRequest rDef = r48; rDef.sampleRate = 0.0;
        const std::vector<int> ids = bank.loadSamplesFromSources({ r48, rDef }, 44100.0, false);
        std::string why;
        const bool ok = a >= 0 && b >= 0 && ids.size() == 2 && ids[0] >= 0 && ids[1] >= 0
                     && sameSample(ref, a, bank, ids[0], why) && sameSample(ref, b, bank, ids[1], why)
                     && bank.getSampleBufferRate(ids[0]) == 48000.0 && bank.getSampleBufferRate(ids[1]) == 44100.0;
        check(ok, "per-request sampleRate: one request at its own rate, one at the batch rate, each bit-identical to the plain call at that rate"
                  + (why.empty() ? std::string() : " — " + why));
    }
    // An empty remainder is rejected, not decoded as an hour of nothing.
    {
        SampleBank bank;
        SampleBank::SourceRequest past; past.filePath = path; past.startTimeSec = durationSec + 5.0; past.toContainerEnd = true;
        const std::vector<int> ids = bank.loadSamplesFromSources({ past }, 48000.0, false);
        check(ids.size() == 1 && ids[0] == -1 && bank.getNumSamples() == 0,
              "toContainerEnd with a start past the end of the file fails cleanly and takes no id");
    }
}

} // namespace

int main()
{
    std::printf("[SampleBankBatch] test_sample_bank_batch\n");
    const juce::File dir = juce::File::getSpecialLocation(juce::File::tempDirectory)
                               .getChildFile("xleth_sample_bank_batch_test");
    dir.createDirectory();
    const juce::File wav = dir.getChildFile("source_44k1.wav");
    const std::string missing = dir.getChildFile("does_not_exist.wav").getFullPathName().toStdString();

    if (!writeTestWav(wav, 44100.0))
    {
        check(false, "could not write the test WAV to " + wav.getFullPathName().toStdString());
    }
    else
    {
        const std::string path = wav.getFullPathName().toStdString();
        runCase("WAV 44.1k decoded at 44.1k", path, 24.0, 44100.0, missing);
        runCase("WAV 44.1k resampled to 48k", path, 24.0, 48000.0, missing);
        runRequestOptions(path, 24.0);
    }

    // Through JUCE rather than getenv: the wide-character environment, so a
    // path with non-ASCII characters survives.
    const juce::String media = juce::SystemStats::getEnvironmentVariable("XLETH_TEST_MEDIA", {});
    if (media.isNotEmpty())
    {
        const double dur = juce::SystemStats::getEnvironmentVariable("XLETH_TEST_MEDIA_SECONDS", "60").getDoubleValue();
        if (juce::File(media).existsAsFile() && dur > 6.0)
        {
            runCase("XLETH_TEST_MEDIA at 44.1k", media.toStdString(), dur, 44100.0, missing);
            runCase("XLETH_TEST_MEDIA at 48k", media.toStdString(), dur, 48000.0, missing);
        }
        else
        {
            std::printf("[SampleBankBatch] INFO XLETH_TEST_MEDIA set but not usable (%s) — skipped\n", media.toRawUTF8());
        }
    }

    wav.deleteFile();
    std::printf("[SampleBankBatch] --- %d passed, %d failed ---\n", g_pass, g_fail);
    return g_fail == 0 ? 0 : 1;
}
