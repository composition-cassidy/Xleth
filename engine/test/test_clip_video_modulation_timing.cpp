#include "model/ClipVideoModulationTiming.h"

#include <cmath>
#include <cstdlib>
#include <iostream>

namespace {

int g_failed = 0;

void check(bool ok, const char* msg)
{
    if (!ok) {
        ++g_failed;
        std::cerr << "FAIL: " << msg << "\n";
    } else {
        std::cout << "PASS: " << msg << "\n";
    }
}

void checkNear(double actual, double expected, double eps, const char* msg)
{
    check(std::abs(actual - expected) <= eps, msg);
    if (std::abs(actual - expected) > eps)
        std::cerr << "      actual=" << actual << " expected=" << expected << "\n";
}

xleth::clipmod::VideoModulationTimingContext makeCtx(double t = 1.0)
{
    xleth::clipmod::VideoModulationTimingContext ctx;
    ctx.bpm = 120.0;
    ctx.sampleRate = 48000.0;
    ctx.timelineSeconds = t;
    ctx.timelineBeats = t * 2.0;
    ctx.timelineSamples = static_cast<int64_t>(std::llround(t * ctx.sampleRate));
    ctx.clipLocalSeconds = t;
    ctx.clipLocalBeats = t * 2.0;
    ctx.clipLocalSamples = static_cast<int64_t>(std::llround(t * ctx.sampleRate));
    ctx.clipDurationSeconds = 10.0;
    ctx.clipDurationBeats = 20.0;
    ctx.sourceStartTime = 0.0;
    ctx.sourceClampStartTime = 0.0;
    ctx.sourceEndTime = 20.0;
    ctx.sourceFps = 30.0;
    ctx.clipStartTimelineSamples = 0;
    return ctx;
}

ClipModulation makeScratch(float rate)
{
    ClipModulation m;
    m.enabled = true;
    m.scratch.enabled = true;
    m.scratch.timeMode = ClipModulation::Scratch::CurveTimeMode::ClipSeconds;
    m.scratch.edgeMode = ClipModulation::Scratch::EdgeMode::Clamp;
    m.scratch.curve.push_back({0.0f, rate, 0.0f});
    return m;
}

ClipModulation makeVibrato(float depthCents)
{
    ClipModulation m;
    m.enabled = true;
    m.vibrato.enabled = true;
    m.vibrato.depthCents = depthCents;
    m.vibrato.rateHz = 5.0f;
    m.vibrato.shape = ClipModulation::Vibrato::Shape::Sine;
    return m;
}

void disabledIsUnmodified()
{
    ClipModulation m;
    auto ctx = makeCtx(2.0);
    ctx.sourceStartTime = 4.0;
    ctx.sourceClampStartTime = 0.0;
    const auto r = xleth::clipmod::evaluateVideoClipModulationTiming(m, ctx, true);
    check(!r.timingActive, "disabled timing inactive");
    checkNear(r.sourceTimeSeconds, 6.0, 1e-12, "disabled returns sourceStart + local seconds");
}

void scratchRates()
{
    checkNear(xleth::clipmod::evaluateVideoClipModulationTiming(
        makeScratch(1.0f), makeCtx(3.0), true).sourceTimeSeconds,
        3.0, 1e-12, "scratch rate 1 is neutral");

    checkNear(xleth::clipmod::evaluateVideoClipModulationTiming(
        makeScratch(0.0f), makeCtx(3.0), true).sourceTimeSeconds,
        0.0, 1e-12, "scratch rate 0 freezes at source start");

    auto reverseZero = xleth::clipmod::evaluateVideoClipModulationTiming(
        makeScratch(-1.0f), makeCtx(1.0), true);
    checkNear(reverseZero.sourceTimeSeconds, 0.0, 1e-12,
              "scratch reverse from zero offset clamps at source beginning");

    auto ctx = makeCtx(0.5);
    ctx.sourceStartTime = 2.0;
    ctx.sourceClampStartTime = 0.0;
    auto reverseOffset = xleth::clipmod::evaluateVideoClipModulationTiming(
        makeScratch(-1.0f), ctx, true);
    checkNear(reverseOffset.sourceTimeSeconds, 1.5, 1e-12,
              "scratch reverse from nonzero offset reads backward");

    checkNear(xleth::clipmod::evaluateVideoClipModulationTiming(
        makeScratch(2.0f), makeCtx(3.0), true).sourceTimeSeconds,
        6.0, 1e-12, "scratch rate 2 advances twice as fast");
}

void vibratoAndStaticPitch()
{
    auto depthZero = xleth::clipmod::evaluateVideoClipModulationTiming(
        makeVibrato(0.0f), makeCtx(1.0), true);
    checkNear(depthZero.sourceTimeSeconds, 1.0, 1e-12,
              "vibrato depth 0 and static pitch 0 is neutral");

    auto vibrato = xleth::clipmod::evaluateVideoClipModulationTiming(
        makeVibrato(80.0f), makeCtx(0.25), true);
    check(std::isfinite(vibrato.sourceTimeSeconds), "vibrato source time is finite");
    check(std::abs(vibrato.vibratoResidualSeconds) < 0.1,
          "vibrato residual stays bounded");

    auto ctx = makeCtx(1.0);
    ctx.clipPitchOffsetSemis = 12;
    auto staticPitch = xleth::clipmod::evaluateVideoClipModulationTiming(
        makeScratch(1.0f), ctx, true);
    checkNear(staticPitch.sourceTimeSeconds, 2.0, 1e-8,
              "static +1200 cents advances video timing at 2x when active");
}

void compositionAndCompatibility()
{
    ClipModulation m = makeScratch(1.25f);
    m.vibrato.enabled = true;
    m.vibrato.depthCents = 30.0f;
    m.vibrato.rateHz = 4.0f;

    const auto a = xleth::clipmod::evaluateVideoClipModulationTiming(m, makeCtx(0.75), true);
    const auto b = xleth::clipmod::evaluateVideoClipModulationTiming(m, makeCtx(0.75), true);
    check(std::isfinite(a.sourceTimeSeconds), "scratch + vibrato source time is finite");
    checkNear(a.sourceTimeSeconds, b.sourceTimeSeconds, 0.0,
              "scratch + vibrato is deterministic");

    auto incompatible = xleth::clipmod::evaluateVideoClipModulationTiming(
        m, makeCtx(0.75), false);
    check(!incompatible.timingActive, "incompatible clip bypasses modulation");
    checkNear(incompatible.sourceTimeSeconds, 0.75, 1e-12,
              "incompatible clip returns unmodified source time");
}

// Phase F.0: cents-only static pitch path (existing vibratoAndStaticPitch covers
// semis-only). Confirms the cents path through staticCents → staticRatio is
// honored by the video timing helper as well.
void f0_staticPitchCentsAdvancesVideo()
{
    auto ctx = makeCtx(1.0);
    ctx.clipPitchOffsetSemis = 0;
    ctx.clipPitchOffsetCents = 1200;       // equivalent to +12 semis via cents
    auto staticPitch = xleth::clipmod::evaluateVideoClipModulationTiming(
        makeScratch(1.0f), ctx, true);
    checkNear(staticPitch.sourceTimeSeconds, 2.0, 1e-8,
              "F.0: static +1200c via cents advances video timing at 2x");

    ctx.clipPitchOffsetCents = -1200;      // -12 semis via cents → ratio 0.5
    auto downOctave = xleth::clipmod::evaluateVideoClipModulationTiming(
        makeScratch(1.0f), ctx, true);
    checkNear(downOctave.sourceTimeSeconds, 0.5, 1e-8,
              "F.0: static -1200c via cents advances video timing at 0.5x");
}

// Phase F.0: with both vibrato AND scratch enabled but compatible=false, every
// modulation flag must report inactive. This locks in the alignment between
// the video bypass path and the audio bypass path on stretched/reversed/formant
// clips so preview and export can never drift.
void f0_compatibleFalse_neutralizesAllModulation()
{
    ClipModulation m;
    m.enabled = true;
    m.vibrato.enabled = true;
    m.vibrato.depthCents = 80.0f;
    m.vibrato.rateHz = 5.0f;
    m.scratch.enabled = true;
    m.scratch.timeMode = ClipModulation::Scratch::CurveTimeMode::ClipSeconds;
    m.scratch.curve.push_back({0.0f, 2.5f, 0.0f});

    auto ctx = makeCtx(1.5);
    ctx.sourceStartTime = 4.0;
    ctx.clipPitchOffsetSemis = 12;          // even with static pitch on the side

    const auto bypassed = xleth::clipmod::evaluateVideoClipModulationTiming(m, ctx, false);
    check(!bypassed.timingActive, "F.0: compatible=false ⇒ timingActive=false");
    check(!bypassed.scratchActive, "F.0: compatible=false ⇒ scratchActive=false");
    check(!bypassed.vibratoActive, "F.0: compatible=false ⇒ vibratoActive=false");
    checkNear(bypassed.sourceTimeSeconds, 4.0 + 1.5, 1e-12,
              "F.0: compatible=false returns sourceStart + clipLocal (no warp)");

    // And confirm the same modulation with compatible=true *does* warp,
    // so we know the bypass — not the modulation — is what neutralized it.
    const auto active = xleth::clipmod::evaluateVideoClipModulationTiming(m, ctx, true);
    check(active.timingActive, "F.0: compatible=true ⇒ timingActive=true");
}

void f1_stretchedCompatibleTimingUsesPostCachePitchContext()
{
    auto ctx = makeCtx(1.0);
    ctx.clipPitchOffsetSemis = 0; // SyncManager/FrameCollector zero this for stretched post-cache clips.

    auto timing = xleth::clipmod::evaluateVideoClipModulationTiming(
        makeScratch(2.0f), ctx, true);
    check(timing.timingActive, "F.1: stretched-compatible timing is active");
    check(timing.scratchActive, "F.1: stretched-compatible scratch is active");
    checkNear(timing.sourceTimeSeconds, 2.0, 1e-8,
              "F.1: post-cache static pitch context avoids double pitch");

    ctx.clipPitchOffsetSemis = 12;
    auto plainStaticPitch = xleth::clipmod::evaluateVideoClipModulationTiming(
        makeScratch(2.0f), ctx, true);
    checkNear(plainStaticPitch.sourceTimeSeconds, 3.0, 1e-8,
              "F.1: plain non-stretched static pitch timing remains unchanged");

    auto bypassed = xleth::clipmod::evaluateVideoClipModulationTiming(
        makeScratch(2.0f), ctx, false);
    check(!bypassed.timingActive, "F.1: reversed/formant-compatible false still bypasses timing");
}

void clamps()
{
    auto ctx = makeCtx(6.0);
    ctx.sourceEndTime = 10.0;
    ctx.sourceFps = 25.0;
    auto pastEnd = xleth::clipmod::evaluateVideoClipModulationTiming(
        makeScratch(2.0f), ctx, true);
    checkNear(pastEnd.sourceTimeSeconds, 10.0 - 0.5 / 25.0, 1e-12,
              "past-end clamp uses frame-aware epsilon");

    ctx.sourceFps = 0.0;
    auto noFps = xleth::clipmod::evaluateVideoClipModulationTiming(
        makeScratch(2.0f), ctx, true);
    checkNear(noFps.sourceTimeSeconds, 10.0, 1e-12,
              "past-end clamp uses sourceEndTime when fps is unavailable");

    auto negative = xleth::clipmod::evaluateVideoClipModulationTiming(
        makeScratch(-2.0f), makeCtx(2.0), true);
    checkNear(negative.sourceTimeSeconds, 0.0, 1e-12,
              "negative source time clamps at lower bound");
}

} // namespace

int main()
{
    disabledIsUnmodified();
    scratchRates();
    vibratoAndStaticPitch();
    compositionAndCompatibility();
    f0_staticPitchCentsAdvancesVideo();
    f0_compatibleFalse_neutralizesAllModulation();
    f1_stretchedCompatibleTimingUsesPostCachePitchContext();
    clamps();

    if (g_failed != 0) {
        std::cerr << "\n[test_clip_video_modulation_timing] FAILED: "
                  << g_failed << " checks\n";
        return EXIT_FAILURE;
    }

    std::cout << "\n[test_clip_video_modulation_timing] all checks passed\n";
    return EXIT_SUCCESS;
}
