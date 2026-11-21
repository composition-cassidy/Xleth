// test_metronome.cpp — click-track grid, accent and resampling maths.
// Pure std (Metronome has no JUCE dependency).
// Pass: prints "ALL TESTS PASSED" and exits 0.

#include "audio/Metronome.h"

#include <cmath>
#include <iostream>
#include <vector>

using xleth::Metronome;

static int g_passed = 0;
static int g_failed = 0;

#define CHECK(cond, msg)                                                   \
    do {                                                                   \
        if (cond) { ++g_passed; }                                          \
        else { std::cerr << "  FAIL [" << __LINE__ << "] " << msg << "\n"; \
               ++g_failed; }                                               \
    } while (0)

// Renders `total` samples starting at timeline sample `start`, in chunks of
// `chunk`, the way the audio callback does (each chunk gets its own start).
static std::vector<float> render(Metronome& m, int64_t start, int total, int chunk,
                                 double bpm, bool playing = true)
{
    std::vector<float> out(static_cast<size_t>(total), 0.0f);
    for (int off = 0; off < total; off += chunk)
    {
        const int n = std::min(chunk, total - off);
        float* ch[1] = { out.data() + off };
        m.process(ch, 1, n, start + off, bpm, playing);
    }
    return out;
}

struct ClickStats { int64_t onset = -1; int length = 0; int crossings = 0; };

// Measures the click that begins at/after `from` within [from, from+window).
static ClickStats measure(const std::vector<float>& x, int64_t from, int window)
{
    ClickStats s;
    int64_t last = -1;
    float prev = 0.0f;
    for (int64_t i = from; i < from + window && i < (int64_t)x.size(); ++i)
    {
        if (x[(size_t)i] != 0.0f)
        {
            if (s.onset < 0) s.onset = i;
            last = i;
            if (prev != 0.0f && ((prev < 0) != (x[(size_t)i] < 0))) ++s.crossings;
            prev = x[(size_t)i];
        }
    }
    if (s.onset >= 0) s.length = static_cast<int>(last - s.onset + 1);
    return s;
}

static void testPitchMaths()
{
    std::cout << "[1] accent ratio is exactly +3 semitones\n";
    const double base   = Metronome::playbackRatio(44100, 44100, false);
    const double accent = Metronome::playbackRatio(44100, 44100, true);
    CHECK(std::abs(base - 1.0) < 1e-12, "unaccented ratio at matching rates is 1");
    CHECK(std::abs(accent / base - std::pow(2.0, 3.0 / 12.0)) < 1e-12, "accent = 2^(3/12)");
    CHECK(std::abs(accent / base - 1.189207115) < 1e-8, "accent = 1.189207...");
    CHECK(std::abs(Metronome::playbackRatio(44100, 48000, false) - 44100.0 / 48000.0) < 1e-12,
          "device rate conversion folded into the ratio");
}

static void testGridAndAccent()
{
    std::cout << "[2] beat grid, bar accent, resampled length/pitch\n";
    constexpr double bpm = 120.0, sr = 44100.0;
    constexpr int spb = 22050; // exact at 120 BPM / 44.1 kHz

    Metronome m;
    m.prepare(sr);
    m.setEnabled(true);
    m.setVolume(1.0f);

    const int total = spb * 9;
    const auto x = render(m, 0, total, 512, bpm);

    for (int k = 0; k < 9; ++k)
    {
        const ClickStats s = measure(x, (int64_t)k * spb, spb - 1);
        CHECK(s.onset == (int64_t)k * spb + 1,
              "click " << k << " starts on its beat (the click's own sample 0 is silent)");
    }
    // Beat 1 is unaccented; beats 0, 4 and 8 are the first beat of a bar.
    const ClickStats b0 = measure(x, 0, spb - 1);
    const ClickStats b1 = measure(x, spb, spb - 1);
    const ClickStats b4 = measure(x, 4LL * spb, spb - 1);
    const ClickStats b8 = measure(x, 8LL * spb, spb - 1);
    CHECK(b1.length > 0 && b0.length > 0, "clicks present");

    const double lenRatio = static_cast<double>(b1.length) / b0.length;
    CHECK(std::abs(lenRatio - 1.189207) < 0.01,
          "accent click is 2^(3/12) shorter (resampled): ratio " << lenRatio);
    CHECK(std::abs(b0.crossings - b1.crossings) <= 1,
          "same number of cycles, played faster: " << b0.crossings << " vs " << b1.crossings);
    CHECK(b4.length == b0.length && b8.length == b0.length, "every bar's first beat is accented");
    CHECK(measure(x, 2LL * spb, spb - 1).length == b1.length &&
          measure(x, 3LL * spb, spb - 1).length == b1.length, "beats 2-4 are unaccented");
}

static void testChunkInvariance()
{
    std::cout << "[3] output independent of how the callback chunks the audio\n";
    constexpr double bpm = 137.0;
    Metronome a, b, c;
    for (auto* m : { &a, &b, &c }) { m->prepare(48000.0); m->setEnabled(true); }

    const int total = 48000 * 6;
    const auto ra = render(a, 12345, total, 64,   bpm);
    const auto rb = render(b, 12345, total, 477,  bpm);
    const auto rc = render(c, 12345, total, 4096, bpm);
    CHECK(ra == rb, "64 vs 477 identical");
    CHECK(ra == rc, "64 vs 4096 identical");

    // Exactly one onset per beat over the window (no dropped / doubled clicks).
    const double spb = 48000.0 * 60.0 / bpm;
    int onsets = 0;
    for (int64_t k = 0; ; ++k)
    {
        const int64_t at = Metronome::beatSample(k, spb);
        if (at >= 12345 + total) break;
        if (at >= 12345) ++onsets;
    }
    CHECK(onsets >= 13 && onsets <= 15, "expected ~13.7 beats, got " << onsets);
}

static void testGating()
{
    std::cout << "[4] disabled / stopped / ring-out / volume / sound / beats-per-bar\n";
    constexpr double bpm = 120.0;
    {
        Metronome m; m.prepare(44100.0);
        const auto x = render(m, 0, 44100, 512, bpm);
        bool silent = true; for (float v : x) silent = silent && v == 0.0f;
        CHECK(silent, "disabled = silence");
    }
    {
        Metronome m; m.prepare(44100.0); m.setEnabled(true);
        const auto x = render(m, 0, 44100, 512, bpm, /*playing*/ false);
        bool silent = true; for (float v : x) silent = silent && v == 0.0f;
        CHECK(silent, "stopped transport = silence");
    }
    {
        // A click that is sounding when the transport stops/mutes still rings out.
        Metronome m; m.prepare(44100.0); m.setEnabled(true);
        std::vector<float> a(512, 0.0f), b(512, 0.0f);
        float* ca[1] = { a.data() }; float* cb[1] = { b.data() };
        m.process(ca, 1, 512, 0, bpm, true);
        m.setEnabled(false);
        m.process(cb, 1, 512, 512, bpm, false);
        bool tail = false; for (float v : b) tail = tail || v != 0.0f;
        CHECK(tail && m.activeVoices() == 1, "sounding click rings out after disable");
    }
    {
        Metronome lo, hi;
        for (auto* m : { &lo, &hi }) { m->prepare(44100.0); m->setEnabled(true); }
        lo.setVolume(0.25f); hi.setVolume(0.5f);
        const auto a = render(lo, 0, 4000, 512, bpm), b = render(hi, 0, 4000, 512, bpm);
        double sa = 0, sb = 0; for (size_t i = 0; i < a.size(); ++i) { sa += std::abs(a[i]); sb += std::abs(b[i]); }
        CHECK(std::abs(sb / sa - 2.0) < 1e-3, "volume scales linearly");
    }
    {
        Metronome s0, s1, s2;
        s0.setSound(0); s1.setSound(1); s2.setSound(2);
        for (auto* m : { &s0, &s1, &s2 }) { m->prepare(44100.0); m->setEnabled(true); }
        const auto a = render(s0, 0, 4000, 512, bpm), b = render(s1, 0, 4000, 512, bpm),
                   c = render(s2, 0, 4000, 512, bpm);
        CHECK(a != b && b != c && a != c, "three distinct sounds");
    }
    {
        Metronome m; m.prepare(44100.0); m.setEnabled(true); m.setBeatsPerBar(3);
        const int spb = 22050;
        const auto x = render(m, 0, spb * 7, 512, bpm);
        const int accentLen = measure(x, 0, spb - 1).length;
        CHECK(measure(x, 3LL * spb, spb - 1).length == accentLen &&
              measure(x, 6LL * spb, spb - 1).length == accentLen, "3/4: accent every 3rd beat");
        CHECK(measure(x, 4LL * spb, spb - 1).length > accentLen, "3/4: beat 4 (bar 2, beat 2) is not accented");
    }
    {
        // The click is stored at 44.1 kHz: on a 48 kHz device it must be resampled
        // so it keeps its pitch, i.e. it gets 48000/44100 times longer.
        Metronome m44, m48;
        m44.prepare(44100.0); m48.prepare(48000.0);
        m44.setEnabled(true); m48.setEnabled(true);
        const int l44 = measure(render(m44, 0, 44100, 512, 60.0), 0, 44099).length;
        const int l48 = measure(render(m48, 0, 48000, 512, 60.0), 0, 47999).length;
        CHECK(l44 > 0 && std::abs(static_cast<double>(l48) / l44 - 48000.0 / 44100.0) < 0.01,
              "48 kHz device keeps the click's pitch: " << l48 << " vs " << l44);
    }
}

int main()
{
    testPitchMaths();
    testGridAndAccent();
    testChunkInvariance();
    testGating();
    std::cout << "\n" << g_passed << " checks passed, " << g_failed << " failed\n";
    if (g_failed) { std::cerr << "FAILED\n"; return 1; }
    std::cout << "ALL TESTS PASSED\n";
    return 0;
}
