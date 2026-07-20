// XlethSvcSampler.cpp — Sampler / Auto Loop Optimizer domain handlers.
//
// New TU (not a Stage split) following the same shape as the S2 Stage 2-6
// domain TUs: engine headers first, then service/XlethSvcGlobals.h,
// `using namespace xleth::svc;`, then service/XlethSvcShared.h.

#include "service/XlethSvcGlobals.h"
using namespace xleth::svc;
#include "service/XlethSvcShared.h"
#include "service/XlethSvcSampler.h"

#include "dsp/LoopOptimizer.h"
#include "model/TimelineTypes.h"

#include <algorithm>
#include <cstdint>
#include <vector>

// sampler_analyzeLoop(regionId)
// Runs the Auto Loop Optimizer's candidate generation (dsp/LoopOptimizer.h)
// over a region's TRIMMED audio and returns loop candidates so the sampler
// LOOP panel can auto-fill LOOP START / LOOP END / XFADE.
//
// Coordinate space: LoopOptimizer's functions return indices relative to
// whatever buffer pointer they're handed. This handler points that pointer at
// smpStart (so analysis never sees material outside the trim), which means
// every index LoopOptimizer returns must be offset by +smpStart before it
// reaches JS — SampleRegion::loopStart/loopEnd are indices into the FULL
// underlying decoded buffer, not trim-relative (see Sampler::processVoice,
// which indexes sampleData_ directly with loopStart_/loopEnd_, independent of
// smpStart_).
//
// Returns { ok, candidates: [{loopStart, loopEnd, crossfadeSamples,
// periodSamples, periodMultiple, seamNcc}], window: {start, end} } on
// success, or { ok: false, candidates: [], error } on any refusal. Never
// throws for a normal "can't loop this" case — only malformed call args raise
// a JS exception, matching the other service handlers.
JsonApi::Value Sampler_AnalyzeLoop(const JsonApi::CallbackInfo& info)
{
    JsonApi::Env env = info.Env();

    auto fail = [&](const char* msg) {
        auto obj = JsonApi::Object::New(env);
        obj.Set("ok", JsonApi::Boolean::New(env, false));
        obj.Set("candidates", JsonApi::Array::New(env, 0));
        obj.Set("error", JsonApi::String::New(env, msg));
        return obj;
    };

    if (info.Length() < 1 || !info[0].IsNumber()) {
        JsonApi::TypeError::New(env, "sampler_analyzeLoop(regionId: number)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }

    if (!isInitialised() || !g_timeline || !sampleBank) {
        return fail("Engine not initialised.");
    }

    const int regionId = info[0].As<JsonApi::Number>().Int32Value();
    const SampleRegion* region = g_timeline->getRegion(regionId);
    if (!region) return fail("Region not found.");

    const int sampleBankId = audioEngine->getMixEngine().getSampleIdForRegion(regionId);
    if (sampleBankId < 0) return fail("Region has no loaded sample.");

    const juce::AudioBuffer<float>* buf = sampleBank->getSample(sampleBankId);
    if (!buf || buf->getNumChannels() <= 0 || buf->getNumSamples() <= 0) {
        return fail("Sample data unavailable.");
    }

    const double sampleRate = sampleBank->getSampleBufferRate(sampleBankId);
    if (sampleRate <= 0.0) return fail("Sample rate unavailable.");

    const int64_t nFrames = buf->getNumSamples();
    const int64_t smpStart = std::max<int64_t>(0, std::min(region->smpStart, nFrames));
    const int64_t smpLength = region->smpLength > 0
        ? std::min<int64_t>(region->smpLength, nFrames - smpStart)
        : (nFrames - smpStart);
    if (smpLength <= 0) return fail("Trimmed region is empty.");

    // Downmix to mono for analysis: LoopOptimizer's period/voicing detection
    // wants one representative signal, and the loop points it proposes are
    // single scalars applied across all channels (see SampleRegion::loopStart/
    // loopEnd — there is no per-channel variant), so a per-channel analysis
    // would have no way to reconcile disagreeing channels anyway.
    const int numCh = buf->getNumChannels();
    const int N = static_cast<int>(smpLength);
    std::vector<float> mono(static_cast<size_t>(N));
    for (int i = 0; i < N; ++i) {
        float sum = 0.0f;
        for (int ch = 0; ch < numCh; ++ch)
            sum += buf->getSample(ch, static_cast<int>(smpStart) + i);
        mono[static_cast<size_t>(i)] = sum / static_cast<float>(numCh);
    }

    const xleth::dsp::LoopWindow window =
        xleth::dsp::detectSteadyStateWindow(mono.data(), N, sampleRate);
    if (window.start == 0 && window.end == 0) {
        return fail("No loopable steady-state region found (unpitched or too short).");
    }

    const std::vector<xleth::dsp::LoopCandidate> candidates =
        xleth::dsp::generateLoopCandidates(mono.data(), N, sampleRate, window);
    if (candidates.empty()) {
        return fail("No viable loop candidates found.");
    }

    auto arr = JsonApi::Array::New(env, candidates.size());
    for (size_t i = 0; i < candidates.size(); ++i) {
        const auto& c = candidates[i];
        auto o = JsonApi::Object::New(env);
        o.Set("loopStart", JsonApi::Number::New(env, static_cast<double>(c.loopStart + smpStart)));
        o.Set("loopEnd", JsonApi::Number::New(env, static_cast<double>(c.loopEnd + smpStart)));
        o.Set("crossfadeSamples", JsonApi::Number::New(env, static_cast<double>(c.crossfadeSamples)));
        o.Set("periodSamples", JsonApi::Number::New(env, c.periodSamples));
        o.Set("periodMultiple", JsonApi::Number::New(env, c.periodMultiple));
        o.Set("seamNcc", JsonApi::Number::New(env, c.seamNcc));
        arr.Set(static_cast<std::uint32_t>(i), o);
    }

    auto winObj = JsonApi::Object::New(env);
    winObj.Set("start", JsonApi::Number::New(env, static_cast<double>(window.start + smpStart)));
    winObj.Set("end", JsonApi::Number::New(env, static_cast<double>(window.end + smpStart)));

    auto result = JsonApi::Object::New(env);
    result.Set("ok", JsonApi::Boolean::New(env, true));
    result.Set("candidates", arr);
    result.Set("window", winObj);
    return result;
}
