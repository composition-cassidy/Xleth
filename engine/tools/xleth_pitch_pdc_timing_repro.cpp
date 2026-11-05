// Live playback timing repro for latent effect chains under PDC.
//
// Loads a project (a scratch copy), renders it once export-style (non-realtime,
// 4096 blocks) and then live-style (realtime, small blocks, paced to wall-clock
// so the envelope-applier worker runs exactly as in the app): three
// play-from-stop passes, a seek while playing, and three laps of a loop with
// the seam split like AudioEngine's callback. Each track is captured post-PDC
// by transport position.
//
// Verdict: every loop lap must be bit-identical to the first. A chain reset
// that lands after the PDC delay lines were cleared (the 34069ad regression)
// leaks the previous lap out of a latent effect's pipeline, or drops the head
// of the new lap. --dump writes every capture as raw float32
// (<dir>/<scenario>_<trackId>.f32) for comparing live renders across builds.
//
// Usage: xleth_pitch_pdc_timing_repro <projectDir> [--block N] [--seconds S]
//            [--unpaced] [--isolate <pluginId>] [--dump outDir]

#include "SampleBank.h"
#include "Transport.h"
#include "audio/MixEngine.h"
#include "model/Timeline.h"
#include "project/ProjectManager.h"

#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_audio_formats/juce_audio_formats.h>
#include <juce_core/juce_core.h>
#include <juce_dsp/juce_dsp.h>

#include <nlohmann/json.hpp>

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <timeapi.h>
#endif

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <filesystem>
#include <map>
#include <string>
#include <thread>
#include <vector>

namespace {

namespace fs = std::filesystem;

struct Options
{
    fs::path projectDir;
    int      liveBlock = 480;
    double   seconds   = 7.0;
    bool     paced     = true;
    fs::path wavDir;             // --dump
    std::string isolatePlugin;   // bypass every other node in every chain
};

void loadMedia(Timeline& timeline, SampleBank& bank, MixEngine& mix, double rate)
{
    mix.clearRegionToSampleMap();
    for (SampleRegion* region : timeline.getAllRegionsMutable())
    {
        if (region == nullptr) continue;
        std::string path;
        double t0 = 0.0, t1 = 0.0;
        if (region->hasSwappedAudio && !region->swappedAudioPath.empty())
        {
            path = region->swappedAudioPath; t0 = 0.0; t1 = 3600.0;
        }
        else
        {
            const SourceMedia* src = timeline.getSource(region->sourceId);
            if (src == nullptr || src->filePath.empty()) continue;
            path = src->filePath; t0 = region->startTime; t1 = region->endTime;
        }
        if (path.empty() || t0 >= t1 || !fs::exists(path))
        {
            std::printf("  region %d (%s): media missing, skipped\n", region->id, region->name.c_str());
            continue;
        }
        const int id = bank.loadSampleFromSource(path, t0, t1, rate);
        if (id >= 0) mix.mapRegionToSample(region->id, id);
    }
    mix.rebuildAllSamplers();
}

// Captures PostPdcTrack for every track and PostMasterOutput (mono sum),
// placed by transport position so skipped (silent) blocks stay aligned.
class Capture final : public MixEngine::DiagnosticTapSink
{
public:
    explicit Capture(int64_t length) : length_(length) {}

    void capture(const MixEngine::DiagnosticTapBlock& b) override
    {
        int key = -1;
        if (b.point == MixEngine::DiagnosticTapPoint::PostPdcTrack)          key = b.trackId;
        else if (b.point == MixEngine::DiagnosticTapPoint::PostMasterOutput) key = kMaster;
        else return;
        if (b.buffer == nullptr) return;

        auto& v = streams_[key];
        if ((int64_t) v.size() != length_) v.assign((size_t) length_, 0.0f);
        const int ch = b.buffer->getNumChannels();
        for (int i = 0; i < b.numSamples; ++i)
        {
            const int64_t pos = b.transportStartSample + i;
            if (pos < 0 || pos >= length_) continue;
            float s = 0.0f;
            for (int c = 0; c < ch; ++c) s += b.buffer->getSample(c, i);
            v[(size_t) pos] = s / (float) std::max(1, ch);
        }
    }

    static constexpr int kMaster = -1000;
    std::map<int, std::vector<float>> streams_;

private:
    int64_t length_;
};

struct Pacer
{
    bool   paced;
    double rate;
    std::chrono::steady_clock::time_point t0 = std::chrono::steady_clock::now();
    int64_t done = 0;
    void tick(int n)
    {
        done += n;
        if (!paced) return;
        const auto due = t0 + std::chrono::duration_cast<std::chrono::steady_clock::duration>(
                                  std::chrono::duration<double>((double) done / rate));
        std::this_thread::sleep_until(due);
    }
};

void runBlocks(MixEngine& mix, Transport& tr, int block, int64_t count, Pacer& pacer)
{
    juce::AudioBuffer<float> buf(2, block);
    for (int64_t done = 0; done < count; done += block)
    {
        buf.clear();
        mix.processBlock(buf, block, tr);
        if (tr.isPlaying()) tr.advance(block);
        pacer.tick(block);
    }
}

// Lag of `live` relative to `ref` over [a, a+w), searched in [-maxLag, maxLag].
// Positive = live is LATE. Returns normalized correlation in `corrOut`.
int estimateLag(const std::vector<float>& ref, const std::vector<float>& live,
                int64_t a, int w, int maxLag, double& corrOut)
{
    const int n = w + 2 * maxLag;
    int order = 1;
    while ((1 << order) < 2 * n) ++order;
    const int N = 1 << order;
    juce::dsp::FFT fft(order);
    std::vector<std::complex<float>> A((size_t) N), B((size_t) N), FA((size_t) N), FB((size_t) N);
    double eRef = 0.0, eLive = 0.0;
    for (int i = 0; i < w; ++i)
    {
        const int64_t p = a + i;
        const float r = (p >= 0 && p < (int64_t) ref.size()) ? ref[(size_t) p] : 0.0f;
        A[(size_t) i] = { r, 0.0f };
        eRef += (double) r * r;
    }
    for (int i = 0; i < n; ++i)
    {
        const int64_t p = a - maxLag + i;
        const float l = (p >= 0 && p < (int64_t) live.size()) ? live[(size_t) p] : 0.0f;
        B[(size_t) i] = { l, 0.0f };
        eLive += (double) l * l;
    }
    fft.perform(A.data(), FA.data(), false);
    fft.perform(B.data(), FB.data(), false);
    for (int i = 0; i < N; ++i) FA[(size_t) i] = std::conj(FA[(size_t) i]) * FB[(size_t) i];
    fft.perform(FA.data(), A.data(), true);   // A = xcorr, index k -> live shifted by k - maxLag
    int best = 0; double bestV = -1e300;
    for (int k = 0; k <= 2 * maxLag; ++k)
    {
        const double v = A[(size_t) k].real();
        if (v > bestV) { bestV = v; best = k; }
    }
    // Energy of the matched live segment for normalization.
    double eSeg = 0.0;
    for (int i = 0; i < w; ++i)
    {
        const int64_t p = a + (best - maxLag) + i;
        const float l = (p >= 0 && p < (int64_t) live.size()) ? live[(size_t) p] : 0.0f;
        eSeg += (double) l * l;
    }
    juce::ignoreUnused(eLive);
    corrOut = (eRef > 0.0 && eSeg > 0.0) ? bestV / std::sqrt(eRef * eSeg) : 0.0;
    return best - maxLag;
}

double rmsDb(const std::vector<float>& v, int64_t a, int64_t b)
{
    double e = 0.0; int64_t n = 0;
    for (int64_t i = std::max<int64_t>(0, a); i < std::min<int64_t>((int64_t) v.size(), b); ++i, ++n)
        e += (double) v[(size_t) i] * v[(size_t) i];
    if (n == 0 || e <= 0.0) return -200.0;
    return 10.0 * std::log10(e / (double) n);
}

struct Report
{
    int windows = 0, nonZero = 0, maxAbsLag = 0;
    double worstNullDb = -999.0;
};

Report compare(const char* scenario, const Capture& ref, const Capture& live,
               const std::map<int, std::string>& names, double rate,
               int64_t from, int64_t to)
{
    Report r;
    const int w = (int) std::lround(rate * 0.5);
    const int maxLag = (int) std::lround(rate * 0.25);
    std::printf("\n== %s  (window 500 ms, samples %lld..%lld)\n", scenario, (long long) from, (long long) to);
    for (const auto& [id, refv] : ref.streams_)
    {
        const auto it = live.streams_.find(id);
        const std::string name = id == Capture::kMaster ? "MASTER" : (names.count(id) ? names.at(id) : std::to_string(id));
        std::printf("  %-12s lags:", name.c_str());
        if (it == live.streams_.end()) { std::printf(" (no live capture)\n"); continue; }
        for (int64_t a = from; a + w <= to; a += w)
        {
            if (rmsDb(refv, a, a + w) < -70.0) { std::printf("   .   "); continue; }
            double c = 0.0;
            const int lag = estimateLag(refv, it->second, a, w, maxLag, c);
            std::printf(" %+5d(%.2f)", lag, c);
            if (id != Capture::kMaster) {
                ++r.windows;
                if (lag != 0) ++r.nonZero;
                r.maxAbsLag = std::max(r.maxAbsLag, std::abs(lag));
            }
        }
        std::printf("\n");
        // First onset (|x| > -60 dBFS) and the null residual at lag 0 over the
        // compared range: bit-level agreement shows up as a very low residual.
        const auto onset = [&](const std::vector<float>& v) -> int64_t {
            for (int64_t i = from; i < std::min<int64_t>(to, (int64_t) v.size()); ++i)
                if (std::abs(v[(size_t) i]) > 1.0e-3f) return i;
            return -1;
        };
        double eRef = 0.0, eDiff = 0.0;
        for (int64_t i = from; i < std::min<int64_t>(to, (int64_t) refv.size()); ++i)
        {
            const double d = (double) it->second[(size_t) i] - refv[(size_t) i];
            eRef += (double) refv[(size_t) i] * refv[(size_t) i];
            eDiff += d * d;
        }
        const double nullDb = (eRef > 0.0 && eDiff > 0.0) ? 10.0 * std::log10(eDiff / eRef) : -999.0;
        std::printf("  %-12s onset export %lld live %lld (%+lld)   null residual %.1f dB\n", "",
                    (long long) onset(refv), (long long) onset(it->second),
                    (long long) (onset(it->second) - onset(refv)), nullDb);
        if (id != Capture::kMaster) r.worstNullDb = std::max(r.worstNullDb, nullDb);
    }
    return r;
}

} // namespace

int main(int argc, char** argv)
{
#ifdef _WIN32
    timeBeginPeriod(1);
#endif
    Options opt;
    for (int i = 1; i < argc; ++i)
    {
        const std::string a = argv[i];
        if (a == "--block" && i + 1 < argc)        opt.liveBlock = std::stoi(argv[++i]);
        else if (a == "--seconds" && i + 1 < argc) opt.seconds = std::stod(argv[++i]);
        else if (a == "--unpaced")                 opt.paced = false;
        else if (a == "--dump" && i + 1 < argc)    opt.wavDir = argv[++i];
        else if (a == "--isolate" && i + 1 < argc) opt.isolatePlugin = argv[++i];
        else                                       opt.projectDir = a;
    }
    if (opt.projectDir.empty()) { std::fprintf(stderr, "usage: %s <projectDir>\n", argv[0]); return 2; }

    ProjectManager pm;
    auto loaded = pm.loadProject(opt.projectDir.string());
    if (!loaded) { std::fprintf(stderr, "failed to load project\n"); return 2; }
    Timeline timeline = std::move(*loaded);
    const double rate = timeline.getSampleRate() > 0.0 ? timeline.getSampleRate() : 48000.0;

    std::map<int, std::string> names;
    for (const TrackInfo* t : timeline.getAllTracks()) if (t) names[t->id] = t->name;

    SampleBank bank;
    auto mixOwner = std::make_unique<MixEngine>();   // heap: MixEngine overflows a test stack
    MixEngine& mix = *mixOwner;
    mix.setTimeline(&timeline);
    mix.setSampleBank(&bank);
    mix.prepare(rate, 4096);
    mix.setGlobalStretchMethod(timeline.getGlobalStretchMethod());
    loadMedia(timeline, bank, mix, rate);

    nlohmann::json chains = pm.getLoadedEffectChains();
    if (chains.is_object())
        for (auto it = chains.begin(); it != chains.end(); ++it)
        {
            if (!opt.isolatePlugin.empty() && it.value().contains("nodes"))
                for (auto& n : it.value()["nodes"])
                    if (n.value("pluginId", "") != opt.isolatePlugin)
                        n["bypassed"] = true;
            mix.loadEffectChainFromJSON(std::stoi(it.key()), it.value());
        }
    const auto& master = pm.getLoadedMasterEffectChain();
    if (master.is_object()) mix.loadMasterEffectChainFromJSON(master);

    const auto snap = mix.getLatencyCompensationSnapshot();
    std::printf("rate %.0f  liveBlock %d  paced %d  maxAudibleTrackLatency %d  maxPathLatency %d\n",
                rate, opt.liveBlock, (int) opt.paced,
                snap.maxAudibleTrackLatencySamples, snap.maxPathLatencySamples);

    const int64_t len = (int64_t) std::llround(rate * opt.seconds);
    const auto roundUp = [](int64_t n, int b) { return ((n + b - 1) / b) * b; };

    // ── Export reference ────────────────────────────────────────────────────
    Capture ref(len);
    {
        Transport tr; tr.setSampleRate(rate); tr.setBPM(timeline.getBPM());
        mix.setNonRealtime(true);
        mix.setDiagnosticTapSink(&ref);
        tr.seekToSample(0); tr.play();
        Pacer p{ false, rate };
        runBlocks(mix, tr, 4096, roundUp(len, 4096), p);
        tr.pause();
        runBlocks(mix, tr, 4096, 4096, p);           // stop transition: posts the reset
        mix.setDiagnosticTapSink(nullptr);
        mix.setNonRealtime(false);
    }

    // Live passes share one transport, like the app: stop -> worker resets ->
    // play again, and a seek while playing.
    Transport tr; tr.setSampleRate(rate); tr.setBPM(timeline.getBPM());
    const int B = opt.liveBlock;
    Report total;
    int lapMismatches = 0;
    const auto add = [&](const Report& r) {
        total.windows += r.windows; total.nonZero += r.nonZero;
        total.maxAbsLag = std::max(total.maxAbsLag, r.maxAbsLag);
    };

    // Raw float32 per track per scenario (<dir>/<scenario>_<trackId>.f32), for
    // comparing live renders across builds sample by sample.
    const auto dump = [&](const std::string& label, const Capture& c)
    {
        if (opt.wavDir.empty()) return;
        for (const auto& [id, v] : c.streams_)
        {
            std::FILE* f = std::fopen((opt.wavDir / (label + "_" + std::to_string(id) + ".f32")).string().c_str(), "wb");
            if (f) { std::fwrite(v.data(), sizeof(float), v.size(), f); std::fclose(f); }
        }
    };

    const auto stopAndSettle = [&]
    {
        Pacer p{ opt.paced, rate };
        tr.pause();
        runBlocks(mix, tr, B, (int64_t) B * 20, p);   // ~200 ms stopped: worker services the reset
        std::this_thread::sleep_for(std::chrono::milliseconds(50));
    };

    for (int pass = 1; pass <= 3; ++pass)
    {
        stopAndSettle();
        Capture live(len);
        mix.setDiagnosticTapSink(&live);
        tr.seekToSample(0); tr.play();
        Pacer p{ opt.paced, rate };
        runBlocks(mix, tr, B, roundUp(len, B), p);
        mix.setDiagnosticTapSink(nullptr);
        char label[64]; std::snprintf(label, sizeof label, "LIVE play-from-stop #%d", pass);
        add(compare(label, ref, live, names, rate, 0, len));
        dump("pass" + std::to_string(pass), live);
    }
    dump("export", ref);

    // Seek while playing: play 0..3 s, jump back to 1 s, play to the end.
    {
        stopAndSettle();
        Capture live(len);
        tr.seekToSample(0); tr.play();
        Pacer p{ opt.paced, rate };
        runBlocks(mix, tr, B, roundUp((int64_t) (rate * 3.0), B), p);
        mix.setDiagnosticTapSink(&live);
        const int64_t seekTo = (int64_t) (rate * 1.0);
        tr.seekToSample(seekTo);
        runBlocks(mix, tr, B, roundUp(len - seekTo, B), p);
        mix.setDiagnosticTapSink(nullptr);
        dump("seek", live);
        // Skip the first 500 ms after the seek: the reset transient lives there.
        add(compare("LIVE seek-while-playing (from seek+500ms)", ref, live, names, rate,
                    seekTo + (int64_t) (rate * 0.5), len));
    }

    // Loop playback: loop [0.5 s, 2.5 s), three laps, split at the seam exactly
    // like AudioEngine's callback. Every wrap is a seek as far as MixEngine is
    // concerned. One capture per lap (placed by transport position), so lap 2
    // and 3 can be compared against lap 1, which started from a clean stop.
    {
        stopAndSettle();
        const int64_t loopStart = (int64_t) (rate * 0.5), loopEnd = (int64_t) (rate * 2.5);
        tr.setLoopBounds(loopStart, loopEnd, true);
        std::vector<std::unique_ptr<Capture>> laps;
        laps.push_back(std::make_unique<Capture>(len));
        mix.setDiagnosticTapSink(laps.back().get());
        tr.seekToSample(loopStart); tr.play();
        Pacer p{ opt.paced, rate };
        juce::AudioBuffer<float> buf(2, B);
        while (laps.size() <= 3)
        {
            buf.clear();
            int offset = 0, remaining = B;
            while (remaining > 0)
            {
                int chunk = std::clamp(tr.samplesUntilLoopWrap(remaining), 1, remaining);
                juce::AudioBuffer<float> view(buf.getArrayOfWritePointers(), 2, offset, chunk);
                mix.processBlock(view, chunk, tr);
                tr.advance(chunk);
                if (tr.getPositionSamples() == loopStart)
                {
                    laps.push_back(std::make_unique<Capture>(len));
                    mix.setDiagnosticTapSink(laps.back().get());
                }
                offset += chunk; remaining -= chunk;
            }
            p.tick(B);
        }
        mix.setDiagnosticTapSink(nullptr);
        tr.setLoopBounds(0, 0, false);
        for (int k = 0; k < 3; ++k) dump("lap" + std::to_string(k + 1), *laps[(size_t) k]);
        for (int k = 1; k < 3; ++k)
        {
            char label[64]; std::snprintf(label, sizeof label, "LIVE loop lap %d vs export", k + 1);
            add(compare(label, ref, *laps[(size_t) k], names, rate, loopStart, loopEnd));
        }

        // The verdict. Every lap after a wrap must render exactly what lap 1
        // (a clean play-from-stop) rendered: a wrap resets the chains and the
        // PDC lines together. A reset that lands late leaks the previous
        // lap's pipeline or drops this lap's head, differently every lap.
        std::printf("\n== LOOP LAP IDENTITY (laps 2..3 vs lap 1, post-PDC, per track)\n");
        for (const auto& [id, first] : laps[0]->streams_)
        {
            const std::string name = id == Capture::kMaster ? "MASTER" : (names.count(id) ? names.at(id) : std::to_string(id));
            for (int k = 1; k < 3; ++k)
            {
                const auto it = laps[(size_t) k]->streams_.find(id);
                int64_t firstDiff = -1;
                for (int64_t i = loopStart; i < loopEnd && firstDiff < 0; ++i)
                {
                    const float a = first[(size_t) i];
                    const float b = it == laps[(size_t) k]->streams_.end() ? 0.0f : it->second[(size_t) i];
                    if (a != b) firstDiff = i - loopStart;
                }
                if (firstDiff >= 0) ++lapMismatches;
                std::printf("  %-12s lap %d: %s", name.c_str(), k + 1, firstDiff < 0 ? "identical\n" : "DIFFERS from ");
                if (firstDiff >= 0) std::printf("%.1f ms into the lap\n", 1000.0 * firstDiff / rate);
            }
        }
    }

    std::printf("\nLive-vs-export lag windows (informational: pattern tracks differ from an\n"
                "export by block size in every build): %d/%d non-zero, max |lag| %d samples\n",
                total.nonZero, total.windows, total.maxAbsLag);
    std::printf("RESULT: %s\n", lapMismatches == 0 ? "LOOP LAPS IDENTICAL" : "LOOP LAPS DIFFER (late chain reset)");
    mixOwner.reset();
#ifdef _WIN32
    timeEndPeriod(1);
#endif
    return lapMismatches == 0 ? 0 : 1;
}
