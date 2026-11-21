#include "RenderClock.h"

#include <algorithm>
#include <cassert>
#include <cmath>
#include <cstdio>   // fprintf for validate() — always available, not just debug

// ===========================================================================
// sample <-> video frame
// ===========================================================================

int64_t RenderClock::sampleToVideoFrame(int64_t samplePos, int sampleRate,
                                        AVRational fps)
{
    //  src time base: {1, sampleRate}      — each tick = 1 sample
    //  dst time base: {fps.den, fps.num}   — each tick = 1 frame
    //
    //  av_rescale_q(a, bq, cq) = a * bq / cq  (with 128-bit intermediate)
    //
    //  result = samplePos * (1/sampleRate) / (fps.den/fps.num)
    //         = samplePos * fps.num / (sampleRate * fps.den)
    //  which is the 0-based frame index.

    AVRational sampleTB = { 1, sampleRate };
    AVRational frameTB  = { fps.den, fps.num };

    int64_t frame = av_rescale_q(samplePos, sampleTB, frameTB);

    RCLOCK_LOG("sampleToVideoFrame: samplePos=%lld sampleRate=%d fps=%d/%d -> frame=%lld",
               (long long)samplePos, sampleRate, fps.num, fps.den, (long long)frame);

    return frame;
}

int64_t RenderClock::videoFrameToSample(int64_t frame, int sampleRate,
                                        AVRational fps)
{
    //  Inverse: frame * (fps.den / fps.num) / (1 / sampleRate)
    //         = frame * fps.den * sampleRate / fps.num

    AVRational frameTB  = { fps.den, fps.num };
    AVRational sampleTB = { 1, sampleRate };

    return av_rescale_q(frame, frameTB, sampleTB);
}

// ===========================================================================
// sample <-> PPQ
//
// NO RCLOCK_LOG in this section. Unlike the frame helpers, these two run on
// the AUDIO THREAD (MixEngine's pattern-note scheduler and
// AutomationPlan::tickAtSamplePosition call them per block, per active block),
// and XLETH_DEBUG is defined for the libraries that ship them — an fprintf per
// call would be both a real-time violation and megabytes of stderr.
// ===========================================================================

namespace {

//  Integer timing domain shared by sampleToPPQ / ppqToSample.
//
//  bpm arrives as a double (the RPC layer accepts any JS number), so it is
//  pinned to a fixed-point grid to get into the integer domain. Micro-BPM is
//  fine enough that the quantization is invisible: 1e-6 / 140 BPM is a 7e-9
//  relative error, i.e. under 0.01 tick across a ten-minute timeline, while
//  leaving bpm headroom to ~9.6e9 before bpmMicro * PPQ can overflow int64.
constexpr int64_t kBpmScale = 1000000LL;            // bpm  -> micro-BPM
constexpr int64_t kMinScale = 60LL * kBpmScale;     // 60 s  * micro-BPM

inline int64_t toBpmMicro(double bpm)
{
    if (!std::isfinite(bpm) || bpm <= 0.0) return 0;
    return static_cast<int64_t>(std::llround(bpm * static_cast<double>(kBpmScale)));
}

} // namespace

int64_t RenderClock::sampleToPPQ(int64_t samplePos, int sampleRate, double bpm,
                                 AVRounding rnd)
{
    //  ppq = samplePos * bpm * 960 / (60 * sampleRate)
    //      = samplePos * bpm_micro * 960 / (60e6 * sampleRate)
    //
    //  av_rescale_rnd(a, b, c, rnd) = a * b / c   (128-bit intermediate),
    //  so the samplePos * bpm_micro product cannot overflow.

    if (sampleRate <= 0) return 0;
    const int64_t bpmMicro = toBpmMicro(bpm);
    if (bpmMicro <= 0) return 0;

    return av_rescale_rnd(samplePos,
                          bpmMicro * static_cast<int64_t>(PPQ),
                          kMinScale * static_cast<int64_t>(sampleRate),
                          rnd);
}

int64_t RenderClock::ppqToSample(int64_t ppq, int sampleRate, double bpm,
                                 AVRounding rnd)
{
    if (sampleRate <= 0) return 0;
    const int64_t bpmMicro = toBpmMicro(bpm);
    if (bpmMicro <= 0) return 0;

    return av_rescale_rnd(
        ppq,
        kMinScale * static_cast<int64_t>(sampleRate),
        bpmMicro * static_cast<int64_t>(PPQ),
        rnd);
}

// ===========================================================================
// PPQ <-> beats  (double domain — see the header for why)
// ===========================================================================

double RenderClock::ppqToBeats(int64_t ppq)
{
    return static_cast<double>(ppq) / static_cast<double>(PPQ);
}

int64_t RenderClock::beatsToPPQ(double beats)
{
    if (!std::isfinite(beats)) return 0;
    return static_cast<int64_t>(std::llround(beats * static_cast<double>(PPQ)));
}

// ===========================================================================
// sample <-> beats  (double domain)
// ===========================================================================

double RenderClock::sampleToBeats(int64_t samples, int sampleRate, double bpm)
{
    if (sampleRate <= 0 || !(bpm > 0.0)) return 0.0;
    return static_cast<double>(samples)
         / (static_cast<double>(sampleRate) * 60.0 / bpm);
}

int64_t RenderClock::beatToSample(double beat, int sampleRate, double bpm)
{
    if (sampleRate <= 0 || bpm <= 0.0 || !std::isfinite(beat)) return 0;
    const double clampedBeat = std::max(0.0, beat);
    return static_cast<int64_t>(
        clampedBeat * (static_cast<double>(sampleRate) * 60.0 / bpm));
}

// ===========================================================================
// sample <-> seconds
// ===========================================================================

double RenderClock::sampleToSeconds(int64_t samplePos, int sampleRate)
{
    return static_cast<double>(samplePos) / static_cast<double>(sampleRate);
}

int64_t RenderClock::secondsToSample(double seconds, int sampleRate)
{
    return static_cast<int64_t>(std::round(seconds * sampleRate));
}

// ===========================================================================
// frame boundary helpers
// ===========================================================================

int64_t RenderClock::nextFrameBoundary(int64_t currentSample, int sampleRate,
                                       AVRational fps)
{
    int64_t currentFrame = sampleToVideoFrame(currentSample, sampleRate, fps);
    return videoFrameToSample(currentFrame + 1, sampleRate, fps);
}

namespace {

//  First frame f with videoFrameToSample(f) >= sample.
//
//  videoFrameToSample() is the ONE definition of where a frame starts, and it
//  is monotonic in f, so the answer is found by estimating with a floor and
//  correcting. The estimate must NOT come from sampleToVideoFrame(): that
//  rounds to the NEAREST frame, and treating a rounded-up index as "the frame
//  this sample is in" is what used to drop frames (see frameBoundsForBuffer).
int64_t firstFrameStartingAtOrAfter(int64_t sample, int sampleRate, AVRational fps)
{
    if (sample <= 0) return 0;
    const AVRational sampleTB = { 1, sampleRate };
    const AVRational frameTB  = { fps.den, fps.num };
    int64_t f = av_rescale_q_rnd(sample, sampleTB, frameTB, AV_ROUND_DOWN);
    if (f < 0) f = 0;
    while (f > 0 && RenderClock::videoFrameToSample(f - 1, sampleRate, fps) >= sample) --f;
    while (RenderClock::videoFrameToSample(f, sampleRate, fps) < sample) ++f;
    return f;
}

} // namespace

std::pair<int64_t, int64_t> RenderClock::frameBoundsForBuffer(
    int64_t bufferStart, int bufferSize, int sampleRate, AVRational fps)
{
    //  Frames whose first sample lies in [bufferStart, bufferStart+bufferSize).
    //
    //  first = first frame starting at/after bufferStart
    //  last  = (first frame starting at/after bufferEnd) - 1
    //
    //  Both ends come from the same monotonic search, so consecutive buffers
    //  tile the frame sequence exactly: every frame is reported by exactly one
    //  buffer, none twice, none never.
    //
    //  The previous version derived both ends from sampleToVideoFrame(), which
    //  rounds to nearest. Whenever the buffer's last sample sat past the
    //  midpoint of a frame, "the frame at the end" came out as the NEXT frame,
    //  whose start is outside the buffer, and the code concluded the buffer
    //  held no boundary at all — silently dropping the frame that did start in
    //  it. That needs the buffer to be longer than half a frame, i.e. it bit
    //  every frame rate above ~47 fps at 48 kHz/512 and never 30 fps: a 60 fps
    //  export lost one frame in four (811 expected, 609 written).
    if (bufferSize <= 0 || sampleRate <= 0 || fps.num <= 0 || fps.den <= 0) {
        const int64_t f = firstFrameStartingAtOrAfter(bufferStart, sampleRate > 0 ? sampleRate : 1,
                                                      (fps.num > 0 && fps.den > 0) ? fps : AVRational{30, 1});
        return { f, f - 1 };
    }

    const int64_t bufferEnd  = bufferStart + bufferSize;  // exclusive
    const int64_t firstFrame = firstFrameStartingAtOrAfter(bufferStart, sampleRate, fps);
    const int64_t lastFrame  = firstFrameStartingAtOrAfter(bufferEnd,   sampleRate, fps) - 1;

    RCLOCK_LOG("frameBoundsForBuffer: bufStart=%lld bufSize=%d -> frames [%lld, %lld]",
               (long long)bufferStart, bufferSize, (long long)firstFrame, (long long)lastFrame);

    return { firstFrame, lastFrame };
}

int64_t RenderClock::frameCountForSamples(int64_t numSamples, int sampleRate, AVRational fps)
{
    if (numSamples <= 0 || sampleRate <= 0 || fps.num <= 0 || fps.den <= 0) return 0;
    return firstFrameStartingAtOrAfter(numSamples, sampleRate, fps);
}

// ===========================================================================
// validation
// ===========================================================================

bool RenderClock::validate()
{
    bool allPassed = true;
    constexpr int SR = 48000;

    auto check = [&](const char* label, int64_t actual, int64_t expected) {
        bool ok = (actual == expected);
        if (!ok) allPassed = false;
        std::fprintf(stderr, "[RenderClock] VALIDATION: %s -> %lld (expected %lld) %s\n",
                     label, (long long)actual, (long long)expected,
                     ok ? "OK" : "FAIL");
    };

    // --- 48 kHz / 30 fps: exactly 1600 samples per frame ---
    {
        int64_t samplesPerFrame = videoFrameToSample(1, SR, FPS::FPS_30);
        check("48kHz/30fps samples/frame", samplesPerFrame, 1600);

        // round-trip: frame 0 -> sample 0
        check("48kHz/30fps frame(0)->sample", videoFrameToSample(0, SR, FPS::FPS_30), 0);

        // round-trip: sample 1600 -> frame 1
        check("48kHz/30fps sample(1600)->frame",
              sampleToVideoFrame(1600, SR, FPS::FPS_30), 1);
    }

    // --- 48 kHz / 60 fps: exactly 800 samples per frame ---
    {
        int64_t samplesPerFrame = videoFrameToSample(1, SR, FPS::FPS_60);
        check("48kHz/60fps samples/frame", samplesPerFrame, 800);
    }

    // --- 48 kHz / 29.97 fps (30000/1001): NOT evenly spaced ---
    {
        //  Exact: 48000 * 1001 / 30000 = 1601.6 samples per frame
        //  So frame 0 starts at sample 0, frame 1 at sample 1601 or 1602
        //  depending on rounding mode. The key test: frames are NOT all 1600.
        int64_t s0 = videoFrameToSample(0, SR, FPS::FPS_29_97);
        int64_t s1 = videoFrameToSample(1, SR, FPS::FPS_29_97);
        int64_t s2 = videoFrameToSample(2, SR, FPS::FPS_29_97);

        int64_t gap1 = s1 - s0;
        int64_t gap2 = s2 - s1;

        // At least one gap must differ from 1600 (proving non-uniform spacing)
        bool nonUniform = (gap1 != 1600) || (gap2 != 1600);
        std::fprintf(stderr, "[RenderClock] VALIDATION: 48kHz/29.97fps gaps: %lld, %lld "
                     "(non-uniform=%s) %s\n",
                     (long long)gap1, (long long)gap2,
                     nonUniform ? "yes" : "no",
                     nonUniform ? "OK" : "FAIL");
        if (!nonUniform) allPassed = false;

        // Verify the exact rational: 48000 * 1001 / 30000 = 48048000/30000 = 1601.6
        // Over 30000 frames (1001 seconds), total samples must be exactly 48048000
        int64_t total = videoFrameToSample(30000, SR, FPS::FPS_29_97);
        check("48kHz/29.97fps 30000 frames total samples", total, 48048000LL);
    }

    // --- PPQ validation: 1 beat at 140 BPM, 48 kHz ---
    {
        //  1 beat = 60/140 seconds = 3/7 seconds
        //  samples per beat = 48000 * 3/7 = 144000/7 ~ 20571.43
        //  PPQ for 1 beat = 960
        //  So sampleToPPQ(20571, 48000, 140.0) should be close to 960
        //  Exact: 20571 * 140 * 960 / (60 * 48000) = 20571 * 134400 / 2880000
        //       = 2764742400 / 2880000 = 959.98
        //  With micro-bpm and the default AV_ROUND_NEAR_INF this lands on 960.

        // Use exact sample count for 1 beat: round(48000 * 60 / 140) = 20571
        int64_t ppq = sampleToPPQ(20571, SR, 140.0);
        // Should be 959 or 960 depending on rounding — both acceptable
        bool ppqOk = (ppq == 959 || ppq == 960);
        std::fprintf(stderr, "[RenderClock] VALIDATION: PPQ at 1 beat (20571 samples, "
                     "140 BPM) -> %lld (expect ~960) %s\n",
                     (long long)ppq, ppqOk ? "OK" : "FAIL");
        if (!ppqOk) allPassed = false;
    }

    // --- nextFrameBoundary ---
    {
        // At 48kHz/30fps, if we're at sample 100, next boundary is sample 1600
        int64_t nb = nextFrameBoundary(100, SR, FPS::FPS_30);
        check("nextFrameBoundary(100, 48k, 30fps)", nb, 1600);

        // At sample 1600 exactly (frame 1 start), next boundary is 3200
        nb = nextFrameBoundary(1600, SR, FPS::FPS_30);
        check("nextFrameBoundary(1600, 48k, 30fps)", nb, 3200);
    }

    // --- frameBoundsForBuffer ---
    {
        // Buffer [0, 512) at 30fps/48kHz: frame 0 starts at sample 0 -> in range
        // No other frame starts before 512. So (0, 0).
        auto [f, l] = frameBoundsForBuffer(0, 512, SR, FPS::FPS_30);
        check("frameBounds [0,512) first", f, 0);
        check("frameBounds [0,512) last",  l, 0);

        // Buffer [1500, 512) = [1500, 2012): frame 1 at sample 1600 is in range.
        // Frame 2 at 3200 is NOT in range. So (1, 1).
        auto [f2, l2] = frameBoundsForBuffer(1500, 512, SR, FPS::FPS_30);
        check("frameBounds [1500,2012) first", f2, 1);
        check("frameBounds [1500,2012) last",  l2, 1);

        // Buffer [1601, 512) = [1601, 2113): no frame boundary here (next is 3200).
        auto [f3, l3] = frameBoundsForBuffer(1601, 512, SR, FPS::FPS_30);
        bool empty = (f3 > l3);
        std::fprintf(stderr, "[RenderClock] VALIDATION: frameBounds [1601,2113) empty=%s %s\n",
                     empty ? "yes" : "no", empty ? "OK" : "FAIL");
        if (!empty) allPassed = false;
    }

    std::fprintf(stderr, "[RenderClock] VALIDATION: %s\n",
                 allPassed ? "ALL PASSED" : "SOME TESTS FAILED");
    return allPassed;
}
