// XlethSvcEqWs.cpp — EQ / Waveshaper / SmartBalance host bridge bindings
// domain handlers (S2 Stage 6).
//
// Verbatim move of the audio_eq{AddBand,RemoveBand,SetBandParam,
// GetResponseCurve,GetSpectrumData,SetPreSpectrum,GetBands,GetBandGR,
// SetGlobalParam,GetGlobalParams,GetSampleRate}, audio_ws{GetCurvePoints,
// SetCurvePoints,SetPreset}, and audio_smartBalanceGetDebug handlers (plus
// their file-scope static getEQ/getWS/getSmartBalance helpers) out of
// XlethEngineService.cpp (was lines 13493-13944 at branch base 30afb14). No
// behavior change — see docs/S2_SPLIT_PLAN.md §4 Stage 6. dispatch() (still
// in XlethEngineService.cpp) resolves these via XlethSvcEqWs.h.
//
// The effect headers (juce_dsp) are included before XlethSvcGlobals.h to
// match the include order XlethEngineService.cpp already used successfully
// (XlethEQEffect/XlethWaveshaperEffect/SmartBalanceEffect at its lines
// 51-53, all before PluginRegistry.h/GridCompositor.h) — see the Stage 5
// XlethSvcVst3.cpp note on juce_audio_processors vs juce_gui_extra ordering;
// the same caution applies here for juce_dsp.
#include "audio/XlethEQEffect.h"
#include "audio/XlethWaveshaperEffect.h"
#include "audio/SmartBalanceEffect.h"

#include "service/XlethSvcGlobals.h"
using namespace xleth::svc;
#include "service/XlethSvcShared.h"
#include "service/XlethSvcEqWs.h"

#include <cstring>
#include <string>
#include <utility>
#include <vector>

#include <nlohmann/json.hpp>

// ── EQ-specific host bridge functions ─────────────────────────────────────────────

// Helper: retrieve the EQ effect from a track chain by trackId + nodeId.
static XlethParametricEQ* getEQ(JsonApi::Env env, int trackId, int nodeId)
{
    auto* base = (trackId < 0)
        ? audioEngine->getMixEngine().getMasterEffectPtr(nodeId)
        : audioEngine->getMixEngine().getEffectPtr(trackId, nodeId);
    if (!base) return nullptr;
    return dynamic_cast<XlethParametricEQ*>(base);
}

// audio_eqAddBand(trackId, nodeId) → number (band index or -1)
JsonApi::Value Audio_EQ_AddBand(const JsonApi::CallbackInfo& info)
{
    JsonApi::Env env = info.Env();
    if (!isInitialised()) {
        JsonApi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsNumber()) {
        JsonApi::TypeError::New(env, "audio_eqAddBand(trackId: number, nodeId: number)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }
    const int trackId = info[0].As<JsonApi::Number>().Int32Value();
    const int nodeId  = info[1].As<JsonApi::Number>().Int32Value();
    BridgeCallLog log("audio.eqAddBand");

    auto* eq = getEQ(env, trackId, nodeId);
    if (!eq) return JsonApi::Number::New(env, -1);
    return JsonApi::Number::New(env, eq->addBand());
}

// audio_eqRemoveBand(trackId, nodeId, bandIndex) → boolean
JsonApi::Value Audio_EQ_RemoveBand(const JsonApi::CallbackInfo& info)
{
    JsonApi::Env env = info.Env();
    if (!isInitialised()) {
        JsonApi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    if (info.Length() < 3 || !info[0].IsNumber() || !info[1].IsNumber() || !info[2].IsNumber()) {
        JsonApi::TypeError::New(env, "audio_eqRemoveBand(trackId: number, nodeId: number, bandIndex: number)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }
    const int trackId   = info[0].As<JsonApi::Number>().Int32Value();
    const int nodeId    = info[1].As<JsonApi::Number>().Int32Value();
    const int bandIndex = info[2].As<JsonApi::Number>().Int32Value();
    BridgeCallLog log("audio.eqRemoveBand");

    auto* eq = getEQ(env, trackId, nodeId);
    if (!eq) return JsonApi::Boolean::New(env, false);
    return JsonApi::Boolean::New(env, eq->removeBand(bandIndex));
}

// audio_eqSetBandParam(trackId, nodeId, bandIndex, paramName, value) → boolean
JsonApi::Value Audio_EQ_SetBandParam(const JsonApi::CallbackInfo& info)
{
    JsonApi::Env env = info.Env();
    if (!isInitialised()) {
        JsonApi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    if (info.Length() < 5 || !info[0].IsNumber() || !info[1].IsNumber()
        || !info[2].IsNumber() || !info[3].IsString() || !info[4].IsNumber()) {
        JsonApi::TypeError::New(env, "audio_eqSetBandParam(trackId, nodeId, bandIndex, paramName, value)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }
    const int trackId        = info[0].As<JsonApi::Number>().Int32Value();
    const int nodeId         = info[1].As<JsonApi::Number>().Int32Value();
    const int bandIndex      = info[2].As<JsonApi::Number>().Int32Value();
    const std::string pName  = info[3].As<JsonApi::String>().Utf8Value();
    const float value        = info[4].As<JsonApi::Number>().FloatValue();
    BridgeCallLog log("audio.eqSetBandParam");

    auto* eq = getEQ(env, trackId, nodeId);
    if (!eq) return JsonApi::Boolean::New(env, false);
    return JsonApi::Boolean::New(env, eq->setBandParam(bandIndex, pName, value));
}

// audio_eqGetResponseCurve(trackId, nodeId) → Float32Array (512 floats, dB)
JsonApi::Value Audio_EQ_GetResponseCurve(const JsonApi::CallbackInfo& info)
{
    JsonApi::Env env = info.Env();
    if (!isInitialised()) {
        JsonApi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsNumber()) {
        JsonApi::TypeError::New(env, "audio_eqGetResponseCurve(trackId: number, nodeId: number)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }
    const int trackId = info[0].As<JsonApi::Number>().Int32Value();
    const int nodeId  = info[1].As<JsonApi::Number>().Int32Value();

    auto* eq = getEQ(env, trackId, nodeId);
    if (!eq) {
        auto ab = JsonApi::ArrayBuffer::New(env, sizeof(float) * XlethParametricEQ::kResponseSize);
        std::memset(ab.Data(), 0, ab.ByteLength());
        return JsonApi::Float32Array::New(env, XlethParametricEQ::kResponseSize, ab, 0);
    }
    auto ab = JsonApi::ArrayBuffer::New(env, sizeof(float) * XlethParametricEQ::kResponseSize);
    eq->getResponseCurve(static_cast<float*>(ab.Data()), XlethParametricEQ::kResponseSize);
    return JsonApi::Float32Array::New(env, XlethParametricEQ::kResponseSize, ab, 0);
}

// audio_eqGetSpectrumData(trackId, nodeId) → { post: Float32Array, pre: Float32Array | null }
JsonApi::Value Audio_EQ_GetSpectrumData(const JsonApi::CallbackInfo& info)
{
    JsonApi::Env env = info.Env();
    if (!isInitialised()) {
        JsonApi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsNumber()) {
        JsonApi::TypeError::New(env, "audio_eqGetSpectrumData(trackId: number, nodeId: number)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }
    const int trackId = info[0].As<JsonApi::Number>().Int32Value();
    const int nodeId  = info[1].As<JsonApi::Number>().Int32Value();

    constexpr int bins = XlethParametricEQ::kSpecBins;

    JsonApi::Object result = JsonApi::Object::New(env);

    auto* eq = getEQ(env, trackId, nodeId);
    if (!eq) {
        auto postAb = JsonApi::ArrayBuffer::New(env, sizeof(float) * bins);
        std::memset(postAb.Data(), 0, postAb.ByteLength());
        result.Set("post", JsonApi::Float32Array::New(env, bins, postAb, 0));
        result.Set("pre", env.Null());
        return result;
    }

    // Post-EQ spectrum (always present)
    auto postAb = JsonApi::ArrayBuffer::New(env, sizeof(float) * bins);
    eq->getPostSpectrum(static_cast<float*>(postAb.Data()), bins);
    result.Set("post", JsonApi::Float32Array::New(env, bins, postAb, 0));

    // Pre-EQ spectrum (only if toggled on)
    if (eq->isPreSpectrumEnabled()) {
        auto preAb = JsonApi::ArrayBuffer::New(env, sizeof(float) * bins);
        eq->getPreSpectrum(static_cast<float*>(preAb.Data()), bins);
        result.Set("pre", JsonApi::Float32Array::New(env, bins, preAb, 0));
    } else {
        result.Set("pre", env.Null());
    }

    return result;
}

// audio_eqSetPreSpectrum(trackId, nodeId, enabled) → boolean
JsonApi::Value Audio_EQ_SetPreSpectrum(const JsonApi::CallbackInfo& info)
{
    JsonApi::Env env = info.Env();
    if (!isInitialised()) {
        JsonApi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    if (info.Length() < 3 || !info[0].IsNumber() || !info[1].IsNumber() || !info[2].IsNumber()) {
        JsonApi::TypeError::New(env, "audio_eqSetPreSpectrum(trackId: number, nodeId: number, enabled: number)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }
    const int trackId  = info[0].As<JsonApi::Number>().Int32Value();
    const int nodeId   = info[1].As<JsonApi::Number>().Int32Value();
    const bool enabled = info[2].As<JsonApi::Number>().Int32Value() != 0;

    auto* eq = getEQ(env, trackId, nodeId);
    if (!eq) return JsonApi::Boolean::New(env, false);
    eq->setPreSpectrumEnabled(enabled);
    return JsonApi::Boolean::New(env, true);
}

// audio_eqGetBands(trackId, nodeId) → JSON string [{index, freq, gain, q, type, enabled}, ...]
JsonApi::Value Audio_EQ_GetBands(const JsonApi::CallbackInfo& info)
{
    JsonApi::Env env = info.Env();
    if (!isInitialised()) {
        JsonApi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsNumber()) {
        JsonApi::TypeError::New(env, "audio_eqGetBands(trackId: number, nodeId: number)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }
    const int trackId = info[0].As<JsonApi::Number>().Int32Value();
    const int nodeId  = info[1].As<JsonApi::Number>().Int32Value();

    auto* eq = getEQ(env, trackId, nodeId);
    if (!eq) return JsonApi::String::New(env, "[]");
    return JsonApi::String::New(env, eq->getBandsAsJSON());
}

// audio_eqGetBandGR(trackId, nodeId) → Float32Array[16] (per-band GR in dB)
JsonApi::Value Audio_EQ_GetBandGR(const JsonApi::CallbackInfo& info)
{
    JsonApi::Env env = info.Env();
    if (!isInitialised()) {
        JsonApi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsNumber()) {
        JsonApi::TypeError::New(env, "audio_eqGetBandGR(trackId: number, nodeId: number)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }
    const int trackId = info[0].As<JsonApi::Number>().Int32Value();
    const int nodeId  = info[1].As<JsonApi::Number>().Int32Value();

    constexpr int kMax = XlethParametricEQ::kMaxBands;
    auto ab = JsonApi::ArrayBuffer::New(env, sizeof(float) * kMax);
    auto* data = static_cast<float*>(ab.Data());

    auto* eq = getEQ(env, trackId, nodeId);
    if (eq) {
        for (int i = 0; i < kMax; ++i)
            data[i] = eq->getBandGR(i);
    } else {
        std::memset(data, 0, sizeof(float) * kMax);
    }
    return JsonApi::Float32Array::New(env, kMax, ab, 0);
}

// audio_eqSetGlobalParam(trackId, nodeId, paramName, value) → boolean
JsonApi::Value Audio_EQ_SetGlobalParam(const JsonApi::CallbackInfo& info)
{
    JsonApi::Env env = info.Env();
    if (!isInitialised()) {
        JsonApi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    if (info.Length() < 4 || !info[0].IsNumber() || !info[1].IsNumber()
        || !info[2].IsString() || !info[3].IsNumber()) {
        JsonApi::TypeError::New(env, "audio_eqSetGlobalParam(trackId, nodeId, paramName, value)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }
    const int trackId       = info[0].As<JsonApi::Number>().Int32Value();
    const int nodeId        = info[1].As<JsonApi::Number>().Int32Value();
    const std::string pName = info[2].As<JsonApi::String>().Utf8Value();
    const float value       = info[3].As<JsonApi::Number>().FloatValue();

    auto* eq = getEQ(env, trackId, nodeId);
    if (!eq) return JsonApi::Boolean::New(env, false);
    return JsonApi::Boolean::New(env, eq->setParameterValue(pName, value));
}

// audio_eqGetGlobalParams(trackId, nodeId) → JSON string {linphase, oversample}
JsonApi::Value Audio_EQ_GetGlobalParams(const JsonApi::CallbackInfo& info)
{
    JsonApi::Env env = info.Env();
    if (!isInitialised()) {
        JsonApi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsNumber()) {
        JsonApi::TypeError::New(env, "audio_eqGetGlobalParams(trackId: number, nodeId: number)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }
    const int trackId = info[0].As<JsonApi::Number>().Int32Value();
    const int nodeId  = info[1].As<JsonApi::Number>().Int32Value();

    auto* eq = getEQ(env, trackId, nodeId);
    if (!eq) return JsonApi::String::New(env, R"({"linphase":false,"oversample":0})");
    return JsonApi::String::New(env, eq->getGlobalParamsAsJSON());
}

// audio_eqGetSampleRate(trackId, nodeId) → number (sample rate in Hz)
JsonApi::Value Audio_EQ_GetSampleRate(const JsonApi::CallbackInfo& info)
{
    JsonApi::Env env = info.Env();
    if (!isInitialised()) {
        JsonApi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsNumber()) {
        JsonApi::TypeError::New(env, "audio_eqGetSampleRate(trackId: number, nodeId: number)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }
    const int trackId = info[0].As<JsonApi::Number>().Int32Value();
    const int nodeId  = info[1].As<JsonApi::Number>().Int32Value();

    auto* eq = getEQ(env, trackId, nodeId);
    if (!eq) return JsonApi::Number::New(env, 44100.0);
    return JsonApi::Number::New(env, eq->getSampleRate());
}

// ── Waveshaper-specific host bridge functions ─────────────────────────────────────

// Helper: retrieve the Waveshaper effect from a track chain by trackId + nodeId.
static XlethWaveshaperEffect* getWS(JsonApi::Env env, int trackId, int nodeId)
{
    auto* base = (trackId < 0)
        ? audioEngine->getMixEngine().getMasterEffectPtr(nodeId)
        : audioEngine->getMixEngine().getEffectPtr(trackId, nodeId);
    if (!base) return nullptr;
    return dynamic_cast<XlethWaveshaperEffect*>(base);
}

// audio_wsGetCurvePoints(trackId, nodeId) → JSON string [[x,y], ...]
JsonApi::Value Audio_WS_GetCurvePoints(const JsonApi::CallbackInfo& info)
{
    JsonApi::Env env = info.Env();
    if (!isInitialised()) {
        JsonApi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsNumber()) {
        JsonApi::TypeError::New(env, "audio_wsGetCurvePoints(trackId, nodeId)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }
    const int trackId = info[0].As<JsonApi::Number>().Int32Value();
    const int nodeId  = info[1].As<JsonApi::Number>().Int32Value();
    BridgeCallLog log("audio.wsGetCurvePoints");

    auto* ws = getWS(env, trackId, nodeId);
    if (!ws) return JsonApi::String::New(env, "[]");

    auto pts = ws->getControlPoints();
    nlohmann::json arr = nlohmann::json::array();
    for (const auto& [x, y] : pts)
        arr.push_back({x, y});
    return JsonApi::String::New(env, arr.dump());
}

// audio_wsSetCurvePoints(trackId, nodeId, pointsJSON) → boolean
JsonApi::Value Audio_WS_SetCurvePoints(const JsonApi::CallbackInfo& info)
{
    JsonApi::Env env = info.Env();
    if (!isInitialised()) {
        JsonApi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    if (info.Length() < 3 || !info[0].IsNumber() || !info[1].IsNumber() || !info[2].IsString()) {
        JsonApi::TypeError::New(env, "audio_wsSetCurvePoints(trackId, nodeId, pointsJSON)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }
    const int trackId = info[0].As<JsonApi::Number>().Int32Value();
    const int nodeId  = info[1].As<JsonApi::Number>().Int32Value();
    const std::string json = info[2].As<JsonApi::String>().Utf8Value();
    BridgeCallLog log("audio.wsSetCurvePoints");

    auto* ws = getWS(env, trackId, nodeId);
    if (!ws) return JsonApi::Boolean::New(env, false);

    try {
        auto parsed = nlohmann::json::parse(json);
        if (!parsed.is_array()) return JsonApi::Boolean::New(env, false);

        std::vector<std::pair<float,float>> pts;
        for (const auto& p : parsed) {
            if (!p.is_array() || p.size() < 2) continue;
            pts.push_back({p[0].get<float>(), p[1].get<float>()});
        }
        return JsonApi::Boolean::New(env, ws->setControlPoints(pts));
    } catch (...) {
        return JsonApi::Boolean::New(env, false);
    }
}

// audio_wsSetPreset(trackId, nodeId, presetIndex) → boolean
JsonApi::Value Audio_WS_SetPreset(const JsonApi::CallbackInfo& info)
{
    JsonApi::Env env = info.Env();
    if (!isInitialised()) {
        JsonApi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    if (info.Length() < 3 || !info[0].IsNumber() || !info[1].IsNumber() || !info[2].IsNumber()) {
        JsonApi::TypeError::New(env, "audio_wsSetPreset(trackId, nodeId, presetIndex)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }
    const int trackId     = info[0].As<JsonApi::Number>().Int32Value();
    const int nodeId      = info[1].As<JsonApi::Number>().Int32Value();
    const int presetIndex = info[2].As<JsonApi::Number>().Int32Value();
    BridgeCallLog log("audio.wsSetPreset");

    auto* ws = getWS(env, trackId, nodeId);
    if (!ws) return JsonApi::Boolean::New(env, false);

    ws->setPreset(presetIndex);
    // If switching to Custom (0), the audio thread sets lutDirty_ instead of
    // calling regenerateLUT(). Trigger the real regeneration here on the
    // message thread.
    if (presetIndex == 0)
        ws->checkAndRegenerateLUT();
    return JsonApi::Boolean::New(env, true);
}

// ── SmartBalance-specific host bridge functions ────────────────────────────────────

// Helper: retrieve SmartBalanceEffect from a track or master chain.
static SmartBalanceEffect* getSmartBalance(JsonApi::Env env, int trackId, int nodeId)
{
    auto* base = (trackId < 0)
        ? audioEngine->getMixEngine().getMasterEffectPtr(nodeId)
        : audioEngine->getMixEngine().getEffectPtr(trackId, nodeId);
    if (!base) return nullptr;
    return dynamic_cast<SmartBalanceEffect*>(base);
}

// audio_smartBalanceGetDebug(trackId, nodeId)
// → { dryRms: [f,f,f,f], dynDelta: [f,f,f,f], transient: [b,b,b,b], overallRms: f }
// Polled at ~30 fps from React — only atomic reads, no locks.
JsonApi::Value Audio_SmartBalance_GetDebug(const JsonApi::CallbackInfo& info)
{
    JsonApi::Env env = info.Env();
    if (!isInitialised()) {
        JsonApi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsNumber()) {
        JsonApi::TypeError::New(env, "audio_smartBalanceGetDebug(trackId: number, nodeId: number)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }
    const int trackId = info[0].As<JsonApi::Number>().Int32Value();
    const int nodeId  = info[1].As<JsonApi::Number>().Int32Value();

    auto* sb = getSmartBalance(env, trackId, nodeId);
    if (!sb) return env.Null();

    JsonApi::Array dryRms    = JsonApi::Array::New(env, 4);
    JsonApi::Array dynDelta  = JsonApi::Array::New(env, 4);
    JsonApi::Array transient = JsonApi::Array::New(env, 4);

    for (uint32_t b = 0; b < 4; ++b)
    {
        dryRms.Set(b,    JsonApi::Number::New(env, sb->debugDryRms_[b].load(std::memory_order_relaxed)));
        dynDelta.Set(b,  JsonApi::Number::New(env, sb->debugDynDelta_[b].load(std::memory_order_relaxed)));
        transient.Set(b, JsonApi::Boolean::New(env, sb->debugTransient_[b].load(std::memory_order_relaxed) > 0.5f));
    }

    JsonApi::Object result = JsonApi::Object::New(env);
    result.Set("dryRms",    dryRms);
    result.Set("dynDelta",  dynDelta);
    result.Set("transient", transient);
    result.Set("overallRms", JsonApi::Number::New(env, sb->debugOverallRms_.load(std::memory_order_relaxed)));
    return result;
}
