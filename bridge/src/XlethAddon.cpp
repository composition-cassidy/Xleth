// Thin Node-API adapter for XlethEngineService.
#include <napi.h>

#include "XlethEngineService.h"

#include <nlohmann/json.hpp>

#include <cstdint>
#include <cstring>
#include <exception>
#include <string>
#include <vector>

namespace {

constexpr const char* kType = "$xlethType";
constexpr const char* kData = "data";
constexpr const char* kAddress = "address";
constexpr const char* kByteLength = "byteLength";

nlohmann::json makeBinaryValue(const char* type, const void* data, std::size_t size)
{
    std::vector<std::uint8_t> bytes(size);
    if (size > 0 && data != nullptr)
        std::memcpy(bytes.data(), data, size);
    return {
        {kType, type},
        {kAddress, static_cast<std::uint64_t>(reinterpret_cast<std::uintptr_t>(data))},
        {kByteLength, size},
        {kData, nlohmann::json::binary(std::move(bytes))},
    };
}

nlohmann::json napiToJson(const Napi::Value& value)
{
    if (value.IsUndefined())
        return {{kType, "undefined"}};
    if (value.IsNull())
        return nullptr;
    if (value.IsBoolean())
        return value.As<Napi::Boolean>().Value();
    if (value.IsNumber())
        return value.As<Napi::Number>().DoubleValue();
    if (value.IsString())
        return value.As<Napi::String>().Utf8Value();
    if (value.IsArrayBuffer()) {
        auto buffer = value.As<Napi::ArrayBuffer>();
        return makeBinaryValue("ArrayBuffer", buffer.Data(), buffer.ByteLength());
    }
    if (value.IsBuffer()) {
        auto buffer = value.As<Napi::Buffer<std::uint8_t>>();
        return makeBinaryValue("Buffer", buffer.Data(), buffer.Length());
    }
    if (value.IsTypedArray()) {
        auto array = value.As<Napi::TypedArray>();
        auto buffer = array.ArrayBuffer();
        auto* data = static_cast<std::uint8_t*>(buffer.Data()) + array.ByteOffset();
        const char* type = array.TypedArrayType() == napi_float32_array
            ? "Float32Array" : "Uint8Array";
        return makeBinaryValue(type, data, array.ByteLength());
    }
    if (value.IsArray()) {
        auto array = value.As<Napi::Array>();
        auto out = nlohmann::json::array();
        for (std::uint32_t i = 0; i < array.Length(); ++i)
            out.push_back(napiToJson(array.Get(i)));
        return out;
    }
    if (value.IsObject()) {
        auto object = value.As<Napi::Object>();
        auto keys = object.GetPropertyNames();
        auto out = nlohmann::json::object();
        for (std::uint32_t i = 0; i < keys.Length(); ++i) {
            auto keyValue = keys.Get(i);
            if (!keyValue.IsString()) continue;
            const auto key = keyValue.As<Napi::String>().Utf8Value();
            out[key] = napiToJson(object.Get(key));
        }
        return out;
    }
    return nullptr;
}

const std::uint8_t* binaryData(const nlohmann::json& value)
{
    if (value.contains(kAddress)) {
        const auto address = value.at(kAddress).get<std::uint64_t>();
        if (address != 0)
            return reinterpret_cast<const std::uint8_t*>(
                static_cast<std::uintptr_t>(address));
    }
    if (value.contains(kData) && value.at(kData).is_binary()) {
        const auto& bytes = value.at(kData).get_binary();
        return bytes.empty() ? nullptr : bytes.data();
    }
    return nullptr;
}

Napi::Value jsonToNapi(Napi::Env env, const nlohmann::json& value)
{
    if (value.is_object() && value.contains(kType)) {
        const auto type = value.value(kType, std::string{});
        if (type == "undefined")
            return env.Undefined();

        const auto size = value.value(kByteLength, std::size_t{0});
        const auto* data = binaryData(value);
        const bool external = value.contains(kAddress)
            && value.at(kAddress).get<std::uint64_t>() != 0
            && !value.contains(kData);

        if (type == "Buffer")
            return Napi::Buffer<std::uint8_t>::Copy(env, data, size);

        if (type == "ArrayBuffer") {
            if (external)
                return Napi::ArrayBuffer::New(
                    env, const_cast<std::uint8_t*>(data), size);
            auto out = Napi::ArrayBuffer::New(env, size);
            if (size > 0 && data != nullptr) std::memcpy(out.Data(), data, size);
            return out;
        }

        if (type == "Uint8Array") {
            auto buffer = Napi::ArrayBuffer::New(env, size);
            if (size > 0 && data != nullptr) std::memcpy(buffer.Data(), data, size);
            return Napi::Uint8Array::New(env, size, buffer, 0);
        }

        if (type == "Float32Array") {
            auto buffer = Napi::ArrayBuffer::New(env, size);
            if (size > 0 && data != nullptr) std::memcpy(buffer.Data(), data, size);
            return Napi::Float32Array::New(env, size / sizeof(float), buffer, 0);
        }
    }

    if (value.is_null())
        return env.Null();
    if (value.is_boolean())
        return Napi::Boolean::New(env, value.get<bool>());
    if (value.is_number())
        return Napi::Number::New(env, value.get<double>());
    if (value.is_string())
        return Napi::String::New(env, value.get<std::string>());
    if (value.is_array()) {
        auto out = Napi::Array::New(env, value.size());
        for (std::size_t i = 0; i < value.size(); ++i)
            out.Set(static_cast<std::uint32_t>(i), jsonToNapi(env, value[i]));
        return out;
    }

    auto out = Napi::Object::New(env);
    for (auto it = value.begin(); it != value.end(); ++it)
        out.Set(it.key(), jsonToNapi(env, it.value()));
    return out;
}

Napi::Value dispatchToService(const Napi::CallbackInfo& info, const char* method)
{
    try {
        auto args = nlohmann::json::array();
        for (std::size_t i = 0; i < info.Length(); ++i)
            args.push_back(napiToJson(info[i]));
        return jsonToNapi(
            info.Env(), XlethEngineService::getInstance().dispatch(method, args));
    } catch (const std::exception& error) {
        Napi::Error::New(info.Env(), error.what()).ThrowAsJavaScriptException();
        return info.Env().Undefined();
    }
}

} // namespace

Napi::Value Initialize(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "initialize");
}

Napi::Value Shutdown(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "shutdown");
}

Napi::Value LoadSample(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "loadSample");
}

Napi::Value TriggerSample(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "triggerSample");
}

Napi::Value LoadVideo(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "loadVideo");
}

Napi::Value GetVideoDuration(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "getVideoDuration");
}

Napi::Value Play(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "play");
}

Napi::Value Stop(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "stop");
}

Napi::Value Pause(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "pause");
}

Napi::Value SetBPM(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "setBPM");
}

Napi::Value GetTransportState(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "getTransportState");
}

Napi::Value Proxy_GetStatus(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "proxy_getStatus");
}

Napi::Value GetCurrentFrame(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "getCurrentFrame");
}

Napi::Value GetFrameBuffer(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "getFrameBuffer");
}

Napi::Value InitFrameOutput(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "initFrameOutput");
}

Napi::Value InitVideoSharedMemory(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "initVideoSharedMemory");
}

Napi::Value SetVideoResolution(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "setVideoResolution");
}

Napi::Value AddAudioEvent(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "addAudioEvent");
}

Napi::Value AddVideoEvent(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "addVideoEvent");
}

Napi::Value ClearTimeline(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "clearTimeline");
}

Napi::Value GetSyncStats(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "getSyncStats");
}

// project_create / project_save / project_saveAs / project_hasProjectDir /
// project_importSource / project_removeSource / project_validateMedia /
// project_relinkSource / project_relinkRegionAudio / project_getInfo /
// project_isDirty / project_isExportRunning are exported from the manifest
// (XlethRpcExports.inc, AUDIT.md S1 slice 3). project_load / project_newBlank
// keep hand-written wrappers because their electron-main handlers own per-call
// logic (renderer broadcast + autosave restart) — the addon wrapper itself is
// still the mechanical dispatchToService pass-through.
Napi::Value Project_Load(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "project_load");
}

Napi::Value Project_NewBlank(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "project_newBlank");
}

Napi::Value Timeline_AddClipsBatch(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "timeline_addClipsBatch");
}

Napi::Value Timeline_AutoTrimClip(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "timeline_autoTrimClip");
}

Napi::Value Timeline_SpliceClipsAtPlayhead(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "timeline_spliceClipsAtPlayhead");
}

Napi::Value Timeline_AddRegion(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "timeline_addRegion");
}

Napi::Value Timeline_ModifyRegion(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "timeline_modifyRegion");
}

Napi::Value Timeline_SetSyllables(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "timeline_setSyllables");
}

Napi::Value Timeline_GetSyllables(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "timeline_getSyllables");
}

Napi::Value Timeline_RemoveRegion(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "timeline_removeRegion");
}

Napi::Value Timeline_GetGridLayout(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "timeline_getGridLayout");
}

Napi::Value Timeline_SetGridLayout(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "timeline_setGridLayout");
}

Napi::Value Timeline_AssignTrackToGrid(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "timeline_assignTrackToGrid");
}

Napi::Value Timeline_AssignTrackToGridWithZOrder(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "timeline_assignTrackToGridWithZOrder");
}

Napi::Value Timeline_RemoveTrackFromGrid(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "timeline_removeTrackFromGrid");
}

Napi::Value Timeline_SetFullscreenLayers(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "timeline_setFullscreenLayers");
}

Napi::Value Timeline_SetPreviewFps(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "timeline_setPreviewFps");
}

Napi::Value Timeline_AddPattern(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "timeline_addPattern");
}

Napi::Value Timeline_GetPattern(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "timeline_getPattern");
}

Napi::Value Timeline_GetAllPatterns(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "timeline_getAllPatterns");
}

Napi::Value Timeline_RemovePattern(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "timeline_removePattern");
}

Napi::Value Timeline_UpdateSamplerSettings(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "timeline_updateSamplerSettings");
}

Napi::Value Timeline_GetPatternAudioInfo(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "timeline_getPatternAudioInfo");
}

Napi::Value Timeline_GetRegionAudioInfo(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "timeline_getRegionAudioInfo");
}

Napi::Value Timeline_AddPatternBlock(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "timeline_addPatternBlock");
}

Napi::Value Timeline_GetPatternBlocks(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "timeline_getPatternBlocks");
}

Napi::Value Timeline_RemovePatternBlock(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "timeline_removePatternBlock");
}

Napi::Value Timeline_MovePatternBlock(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "timeline_movePatternBlock");
}

Napi::Value Timeline_ResizePatternBlock(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "timeline_resizePatternBlock");
}

Napi::Value Timeline_ResizePatternBlockLeft(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "timeline_resizePatternBlockLeft");
}

Napi::Value Timeline_SetPatternBlockLoop(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "timeline_setPatternBlockLoop");
}

Napi::Value Timeline_AddNote(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "timeline_addNote");
}

Napi::Value Timeline_RemoveNote(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "timeline_removeNote");
}

Napi::Value Timeline_MoveNote(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "timeline_moveNote");
}

Napi::Value Timeline_MoveNotesBatch(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "timeline_moveNotesBatch");
}

Napi::Value Timeline_AddNotesBatch(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "timeline_addNotesBatch");
}

Napi::Value Fsc_Parse(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "fsc_parse");
}

Napi::Value Timeline_QuantizeClipsBatch(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "timeline_quantizeClipsBatch");
}

Napi::Value Timeline_ResizeNotesBatch(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "timeline_resizeNotesBatch");
}

Napi::Value Timeline_ResizeNote(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "timeline_resizeNote");
}

Napi::Value Timeline_SetNoteVelocity(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "timeline_setNoteVelocity");
}

Napi::Value Timeline_PreviewNote(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "timeline_previewNote");
}

Napi::Value Timeline_PreviewNoteOff(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "timeline_previewNoteOff");
}

Napi::Value Timeline_PreviewAllNotesOff(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "timeline_previewAllNotesOff");
}

Napi::Value Preview_SetEnabled(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "preview_setEnabled");
}

Napi::Value Cache_GetWorldActiveJobIds(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "cache_getWorldActiveJobs");
}

Napi::Value Engine_SetGlobalStretchMethod(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "engine_setGlobalStretchMethod");
}

Napi::Value Engine_GetGlobalStretchMethod(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "engine_getGlobalStretchMethod");
}

Napi::Value Engine_SetGlobalFormantPreserve(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "engine_setGlobalFormantPreserve");
}

Napi::Value Engine_GetGlobalFormantPreserve(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "engine_getGlobalFormantPreserve");
}

Napi::Value Audio_MapRegionToSample(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "audio_mapRegionToSample");
}

Napi::Value Audio_LoadSourceRegion(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "audio_loadSourceRegion");
}

Napi::Value Audio_GetOutputDevices(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "audio_getOutputDevices");
}

Napi::Value Audio_GetCurrentOutputDevice(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "audio_getCurrentOutputDevice");
}

Napi::Value Audio_SetOutputDevice(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "audio_setOutputDevice");
}

Napi::Value Audio_GetMasterPeak(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "audio_getMasterPeak");
}

Napi::Value Audio_GetTrackPeak(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "audio_getTrackPeak");
}

Napi::Value Audio_GetAllPeaks(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "audio_getAllPeaks");
}

Napi::Value Audio_SetRealtimeDiagnosticsEnabled(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "audio_setRealtimeDiagnosticsEnabled");
}

Napi::Value Audio_ResetRealtimeDiagnostics(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "audio_resetRealtimeDiagnostics");
}

Napi::Value Audio_GetRealtimeDiagnostics(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "audio_getRealtimeDiagnostics");
}

Napi::Value Audio_GetAudioPerformanceTelemetry(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "getAudioPerformanceTelemetry");
}

Napi::Value Audio_StartAudioPerformanceCapture(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "startAudioPerformanceCapture");
}

Napi::Value Audio_StopAudioPerformanceCapture(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "stopAudioPerformanceCapture");
}

Napi::Value Audio_ExportAudioPerformanceCaptureReport(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "exportAudioPerformanceCaptureReport");
}

Napi::Value Audio_CaptureAudioPerformanceReport(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "captureAudioPerformanceReport");
}

Napi::Value Audio_SetTestDeviceOutputLatencySamplesForDiagnostics(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "audio_setTestDeviceOutputLatencySamplesForDiagnostics");
}

Napi::Value Audio_SetTrackVolume(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "audio_setTrackVolume");
}

Napi::Value Audio_SetTrackPan(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "audio_setTrackPan");
}

Napi::Value Audio_SetTrackSpread(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "audio_setTrackSpread");
}

Napi::Value Audio_SetMasterVolume(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "audio_setMasterVolume");
}

Napi::Value Audio_ExportStart(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "audio_exportStart");
}

Napi::Value Audio_ExportGetProgress(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "audio_exportGetProgress");
}

Napi::Value Audio_ExportCancel(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "audio_exportCancel");
}

Napi::Value Video_ExportStart(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "video_exportStart");
}

Napi::Value Video_ExportGetProgress(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "video_exportGetProgress");
}

Napi::Value Video_ExportCancel(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "video_exportCancel");
}

Napi::Value Video_ComputeDurationSeconds(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "video_computeDurationSeconds");
}

Napi::Value Audio_ExportRegion(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "audio_exportRegion");
}

Napi::Value Audio_SwapRegionAudio(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "audio_swapRegionAudio");
}

Napi::Value Audio_LoadRegionAudio(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "audio_loadRegionAudio");
}

Napi::Value Audio_ProbeAudioDuration(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "audio_probeAudioDuration");
}

Napi::Value Audio_RevertRegionAudio(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "audio_revertRegionAudio");
}

Napi::Value Audio_AddEffect(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "audio_addEffect");
}

Napi::Value Audio_RemoveEffect(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "audio_removeEffect");
}

Napi::Value Audio_MoveEffect(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "audio_moveEffect");
}

Napi::Value Audio_SetEffectBypass(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "audio_setEffectBypass");
}

Napi::Value Audio_GetEffectChain(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "audio_getEffectChain");
}

Napi::Value Audio_GetEffectParameters(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "audio_getEffectParameters");
}

Napi::Value Audio_SetEffectParameter(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "audio_setEffectParameter");
}

Napi::Value Audio_GetEffectMeter(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "audio_getEffectMeter");
}

Napi::Value Audio_SetEffectVisualizationEnabled(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "audio_setEffectVisualizationEnabled");
}

Napi::Value Audio_DrainEffectVizFrames(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "audio_drainEffectVizFrames");
}

Napi::Value Audio_AddMasterEffect(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "audio_addMasterEffect");
}

Napi::Value Audio_RemoveMasterEffect(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "audio_removeMasterEffect");
}

Napi::Value Audio_MoveMasterEffect(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "audio_moveMasterEffect");
}

Napi::Value Audio_SetMasterEffectBypass(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "audio_setMasterEffectBypass");
}

Napi::Value Audio_GetMasterEffectChain(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "audio_getMasterEffectChain");
}

Napi::Value Audio_EQ_AddBand(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "audio_eqAddBand");
}

Napi::Value Audio_EQ_RemoveBand(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "audio_eqRemoveBand");
}

Napi::Value Audio_EQ_SetBandParam(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "audio_eqSetBandParam");
}

Napi::Value Audio_EQ_GetResponseCurve(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "audio_eqGetResponseCurve");
}

Napi::Value Audio_EQ_GetSpectrumData(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "audio_eqGetSpectrumData");
}

Napi::Value Audio_EQ_SetPreSpectrum(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "audio_eqSetPreSpectrum");
}

Napi::Value Audio_EQ_GetBands(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "audio_eqGetBands");
}

Napi::Value Audio_EQ_GetBandGR(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "audio_eqGetBandGR");
}

Napi::Value Audio_EQ_SetGlobalParam(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "audio_eqSetGlobalParam");
}

Napi::Value Audio_EQ_GetGlobalParams(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "audio_eqGetGlobalParams");
}

Napi::Value Audio_EQ_GetSampleRate(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "audio_eqGetSampleRate");
}

Napi::Value Audio_WS_GetCurvePoints(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "audio_wsGetCurvePoints");
}

Napi::Value Audio_WS_SetCurvePoints(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "audio_wsSetCurvePoints");
}

Napi::Value Audio_WS_SetPreset(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "audio_wsSetPreset");
}

Napi::Value Audio_SmartBalance_GetDebug(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "audio_smartBalanceGetDebug");
}

Napi::Value Audio_AddConnection(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "audio_addConnection");
}

Napi::Value Audio_RemoveConnection(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "audio_removeConnection");
}

Napi::Value Audio_SetWireGain(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "audio_setWireGain");
}

Napi::Value Audio_SetWireMute(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "audio_setWireMute");
}

Napi::Value Audio_GetGraphTopology(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "audio_getGraphTopology");
}

Napi::Value Audio_SetNodePosition(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "audio_setNodePosition");
}

Napi::Value Audio_IsGraphLinear(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "audio_isGraphLinear");
}

Napi::Value Audio_AddGraphEffectNode(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "audio_addGraphEffectNode");
}

Napi::Value Audio_RemoveGraphEffectNode(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "audio_removeGraphEffectNode");
}

Napi::Value Audio_GetGraphEffectEngineNodeId(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "audio_getGraphEffectEngineNodeId");
}

Napi::Value Audio_GetGraphEffectParameters(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "audio_getGraphEffectParameters");
}

Napi::Value Audio_GetGraphEffectParameterValue(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "audio_getGraphEffectParameterValue");
}

Napi::Value Audio_SetGraphEffectParameterNormalized(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "audio_setGraphEffectParameterNormalized");
}

Napi::Value Audio_HydrateGraphEffectNodes(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "audio_hydrateGraphEffectNodes");
}

Napi::Value Audio_SyncLinearGraphTopology(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "audio_syncLinearGraphTopology");
}

Napi::Value Audio_SyncGraphTopology(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "audio_syncGraphTopology");
}

Napi::Value Audio_AdoptGraphEffectNodes(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "audio_adoptGraphEffectNodes");
}

Napi::Value Audio_AddMasterConnection(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "audio_addMasterConnection");
}

Napi::Value Audio_RemoveMasterConnection(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "audio_removeMasterConnection");
}

Napi::Value Audio_SetMasterWireGain(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "audio_setMasterWireGain");
}

Napi::Value Audio_SetMasterWireMute(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "audio_setMasterWireMute");
}

Napi::Value Audio_GetMasterGraphTopology(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "audio_getMasterGraphTopology");
}

Napi::Value Audio_SetMasterNodePosition(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "audio_setMasterNodePosition");
}

Napi::Value Audio_IsMasterGraphLinear(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "audio_isMasterGraphLinear");
}

Napi::Value Audio_ScanPlugins(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "audio_scanPlugins");
}

Napi::Value Audio_GetScanProgress(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "audio_getScanProgress");
}

Napi::Value Audio_GetScannedPlugins(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "audio_getScannedPlugins");
}

Napi::Value Audio_GetFailedPlugins(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "audio_getFailedPlugins");
}

Napi::Value Audio_OpenPluginEditor(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "audio_openPluginEditor");
}

Napi::Value Audio_ClosePluginEditor(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "audio_closePluginEditor");
}

Napi::Value Audio_CloseAllPluginEditors(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "audio_closeAllPluginEditors");
}

Napi::Value Audio_IsPluginEditorOpen(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "audio_isPluginEditorOpen");
}

Napi::Value Audio_GetMissingPlugins(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "audio_getMissingPlugins");
}

Napi::Value Audio_RetryMissingPlugin(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "audio_retryMissingPlugin");
}

Napi::Value Audio_RemoveAllMissing(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "audio_removeAllMissing");
}

Napi::Value Audio_ResetCrashedPlugin(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "audio_resetCrashedPlugin");
}

Napi::Value Audio_SetMainWindowHandle(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "audio_setMainWindowHandle");
}

Napi::Value Source_LoadSource(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "source_loadSource");
}

Napi::Value Source_PlaySource(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "source_playSource");
}

Napi::Value Source_PlayRegionPreview(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "source_playRegionPreview");
}

Napi::Value Source_PauseSource(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "source_pauseSource");
}

Napi::Value Source_ResumeSource(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "source_resumeSource");
}

Napi::Value Source_SeekSource(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "source_seekSource");
}

Napi::Value Source_StopSource(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "source_stopSource");
}

Napi::Value Source_GetPosition(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "source_getPosition");
}

Napi::Value Source_IsPlaying(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "source_isPlaying");
}

Napi::Value Source_UnloadSource(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "source_unloadSource");
}

Napi::Value Video_OpenSource(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "video_openSource");
}

Napi::Value Video_CloseSource(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "video_closeSource");
}

Napi::Value Video_GetFrame(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "video_getFrame");
}

Napi::Value Video_RequestPreviewFrameAtTimelinePosition(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "video_requestPreviewFrameAtTimelinePosition");
}

Napi::Value Waveform_GetRegionPeaks(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "waveform_getRegionPeaks");
}

Napi::Value Waveform_GetRawSamples(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "waveform_getRawSamples");
}

Napi::Value Waveform_GetFilePeaks(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "waveform_getFilePeaks");
}

Napi::Value Waveform_GetClipPeaks(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "waveform_getClipPeaks");
}

Napi::Value Gpu_GetAvailableGpus(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "gpu_getAvailableGpus");
}

Napi::Value Gpu_SetAdapter(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "gpu_setAdapter");
}

Napi::Value Diag_GetVisualPreviewDiagnostic(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "diag_getVisualPreviewDiagnostic");
}

Napi::Value HwEnc_GetAvailableEncoders(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "hwenc_getAvailableEncoders");
}

Napi::Value HwEnc_GetDefaultEncoder(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "hwenc_getDefaultEncoder");
}

Napi::Value HwEnc_Refresh(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "hwenc_refresh");
}

Napi::Value Midi_ParseSummary(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "midi_parseSummary");
}

Napi::Value Midi_ImportFull(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "midi_importFull");
}

Napi::Value Midi_ExecuteImport(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "midi_executeImport");
}

Napi::Object Init(Napi::Env env, Napi::Object exports)
{
    // ── Manifest-generated exports (AUDIT.md S1) ─────────────────────────────
    // One export per line of XlethRpcExports.inc, generated from
    // ui/rpc-manifest.js (regenerate: node scripts/generate-rpc-registries.js).
    // Every generated export is the same mechanical wrapper the hand-written
    // functions below are: dispatchToService(info, "<name>"). As methods
    // migrate to the manifest their hand-written wrapper + exports.Set line
    // are deleted here.
#define XLETH_RPC_EXPORT(name)                                                 \
    exports.Set(name, Napi::Function::New(env,                                 \
        [](const Napi::CallbackInfo& info) {                                   \
            return dispatchToService(info, name);                              \
        }));
#include "XlethRpcExports.inc"
#undef XLETH_RPC_EXPORT

    // ── Phase 0 (backward-compatible) ───────────────────────────────────────
    exports.Set("initialize",         Napi::Function::New(env, Initialize));
    exports.Set("shutdown",           Napi::Function::New(env, Shutdown));
    exports.Set("loadSample",         Napi::Function::New(env, LoadSample));
    exports.Set("triggerSample",      Napi::Function::New(env, TriggerSample));
    exports.Set("loadVideo",          Napi::Function::New(env, LoadVideo));
    exports.Set("getVideoDuration",   Napi::Function::New(env, GetVideoDuration));
    exports.Set("play",               Napi::Function::New(env, Play));
    exports.Set("stop",               Napi::Function::New(env, Stop));
    exports.Set("pause",              Napi::Function::New(env, Pause));
    exports.Set("setBPM",             Napi::Function::New(env, SetBPM));
    exports.Set("getTransportState",  Napi::Function::New(env, GetTransportState));
    exports.Set("proxy_getStatus",    Napi::Function::New(env, Proxy_GetStatus));
    exports.Set("getCurrentFrame",    Napi::Function::New(env, GetCurrentFrame));
    exports.Set("getFrameBuffer",     Napi::Function::New(env, GetFrameBuffer));
    exports.Set("initFrameOutput",    Napi::Function::New(env, InitFrameOutput));
    exports.Set("initVideoSharedMemory", Napi::Function::New(env, InitVideoSharedMemory));
    exports.Set("setVideoResolution", Napi::Function::New(env, SetVideoResolution));
    exports.Set("addAudioEvent",      Napi::Function::New(env, AddAudioEvent));
    exports.Set("addVideoEvent",      Napi::Function::New(env, AddVideoEvent));
    exports.Set("clearTimeline",      Napi::Function::New(env, ClearTimeline));
    exports.Set("getSyncStats",       Napi::Function::New(env, GetSyncStats));

    // ── Phase 1 — Project ────────────────────────────────────────────────────
    // Most project exports come from the manifest (XlethRpcExports.inc, S1 slice
    // 3). Only project_load / project_newBlank stay hand-written — their
    // electron-main handlers carry per-call logic (see the wrappers above).
    exports.Set("project_load",            Napi::Function::New(env, Project_Load));
    exports.Set("project_newBlank",        Napi::Function::New(env, Project_NewBlank));

    // ── Phase 1 — Timeline queries ───────────────────────────────────────────

    // ── Phase 1 — Timeline mutations (via UndoManager) ───────────────────────
    exports.Set("timeline_addClipsBatch",    Napi::Function::New(env, Timeline_AddClipsBatch));
    exports.Set("timeline_autoTrimClip",            Napi::Function::New(env, Timeline_AutoTrimClip));
    exports.Set("timeline_spliceClipsAtPlayhead",   Napi::Function::New(env, Timeline_SpliceClipsAtPlayhead));
    exports.Set("timeline_addRegion",    Napi::Function::New(env, Timeline_AddRegion));
    exports.Set("timeline_modifyRegion", Napi::Function::New(env, Timeline_ModifyRegion));
    exports.Set("timeline_setSyllables", Napi::Function::New(env, Timeline_SetSyllables));
    exports.Set("timeline_getSyllables", Napi::Function::New(env, Timeline_GetSyllables));
    exports.Set("timeline_removeRegion", Napi::Function::New(env, Timeline_RemoveRegion));

    // ── Grid Layout ──────────────────────────────────────────────────────────
    exports.Set("timeline_getGridLayout",       Napi::Function::New(env, Timeline_GetGridLayout));
    exports.Set("timeline_setGridLayout",       Napi::Function::New(env, Timeline_SetGridLayout));
    exports.Set("timeline_assignTrackToGrid",            Napi::Function::New(env, Timeline_AssignTrackToGrid));
    exports.Set("timeline_assignTrackToGridWithZOrder",  Napi::Function::New(env, Timeline_AssignTrackToGridWithZOrder));
    exports.Set("timeline_removeTrackFromGrid",          Napi::Function::New(env, Timeline_RemoveTrackFromGrid));
    exports.Set("timeline_setFullscreenLayers", Napi::Function::New(env, Timeline_SetFullscreenLayers));
    exports.Set("timeline_setPreviewFps",       Napi::Function::New(env, Timeline_SetPreviewFps));

    // ── Patterns / PatternBlocks / Notes ─────────────────────────────────────
    exports.Set("timeline_addPattern",             Napi::Function::New(env, Timeline_AddPattern));
    exports.Set("timeline_getPattern",             Napi::Function::New(env, Timeline_GetPattern));
    exports.Set("timeline_getAllPatterns",         Napi::Function::New(env, Timeline_GetAllPatterns));
    exports.Set("timeline_removePattern",          Napi::Function::New(env, Timeline_RemovePattern));
    exports.Set("timeline_updateSamplerSettings",  Napi::Function::New(env, Timeline_UpdateSamplerSettings));
    exports.Set("timeline_getPatternAudioInfo",    Napi::Function::New(env, Timeline_GetPatternAudioInfo));
    exports.Set("timeline_getRegionAudioInfo",      Napi::Function::New(env, Timeline_GetRegionAudioInfo));
    // Pipeline B (timeline_getRegionWaveformPeaks) retired — replaced by waveform_getRegionPeaks
    exports.Set("timeline_addPatternBlock",        Napi::Function::New(env, Timeline_AddPatternBlock));
    exports.Set("timeline_getPatternBlocks",       Napi::Function::New(env, Timeline_GetPatternBlocks));
    exports.Set("timeline_removePatternBlock",     Napi::Function::New(env, Timeline_RemovePatternBlock));
    exports.Set("timeline_movePatternBlock",       Napi::Function::New(env, Timeline_MovePatternBlock));
    exports.Set("timeline_resizePatternBlock",     Napi::Function::New(env, Timeline_ResizePatternBlock));
    exports.Set("timeline_resizePatternBlockLeft", Napi::Function::New(env, Timeline_ResizePatternBlockLeft));
    exports.Set("timeline_setPatternBlockLoop",    Napi::Function::New(env, Timeline_SetPatternBlockLoop));
    exports.Set("timeline_addNote",                Napi::Function::New(env, Timeline_AddNote));
    exports.Set("timeline_removeNote",             Napi::Function::New(env, Timeline_RemoveNote));
    exports.Set("timeline_moveNote",               Napi::Function::New(env, Timeline_MoveNote));
    exports.Set("timeline_moveNotesBatch",         Napi::Function::New(env, Timeline_MoveNotesBatch));
    exports.Set("timeline_addNotesBatch",          Napi::Function::New(env, Timeline_AddNotesBatch));
    exports.Set("fsc_parse",                       Napi::Function::New(env, Fsc_Parse));
    exports.Set("timeline_quantizeClipsBatch",     Napi::Function::New(env, Timeline_QuantizeClipsBatch));
    exports.Set("timeline_resizeNotesBatch",        Napi::Function::New(env, Timeline_ResizeNotesBatch));
    exports.Set("timeline_resizeNote",             Napi::Function::New(env, Timeline_ResizeNote));
    exports.Set("timeline_setNoteVelocity",        Napi::Function::New(env, Timeline_SetNoteVelocity));
    exports.Set("timeline_previewNote",            Napi::Function::New(env, Timeline_PreviewNote));
    exports.Set("timeline_previewNoteOff",         Napi::Function::New(env, Timeline_PreviewNoteOff));
    exports.Set("timeline_previewAllNotesOff",     Napi::Function::New(env, Timeline_PreviewAllNotesOff));

    // ── Phase 7 — Preview visibility ────────────────────────────────────────
    exports.Set("preview_setEnabled", Napi::Function::New(env, Preview_SetEnabled));

    // ── Phase 1 — Undo / Redo ────────────────────────────────────────────────

    // ── Phase 1 — Transport extensions ──────────────────────────────────────
    // transport_getState = getTransportState (same function, aliased)
    exports.Set("transport_getState",  Napi::Function::New(env, GetTransportState));

    // ── WORLD processing indicator ───────────────────────────────────────────
    exports.Set("cache_getWorldActiveJobs", Napi::Function::New(env, Cache_GetWorldActiveJobIds));

    // ── Global clip-processing defaults ─────────────────────────────────────
    exports.Set("engine_setGlobalStretchMethod",   Napi::Function::New(env, Engine_SetGlobalStretchMethod));
    exports.Set("engine_getGlobalStretchMethod",   Napi::Function::New(env, Engine_GetGlobalStretchMethod));
    exports.Set("engine_setGlobalFormantPreserve", Napi::Function::New(env, Engine_SetGlobalFormantPreserve));
    exports.Set("engine_getGlobalFormantPreserve", Napi::Function::New(env, Engine_GetGlobalFormantPreserve));

    // ── Phase 1 — Audio / MixEngine ─────────────────────────────────────────
    exports.Set("audio_mapRegionToSample",  Napi::Function::New(env, Audio_MapRegionToSample));
    exports.Set("audio_loadSourceRegion",   Napi::Function::New(env, Audio_LoadSourceRegion));
    exports.Set("audio_getOutputDevices",       Napi::Function::New(env, Audio_GetOutputDevices));
    exports.Set("audio_getCurrentOutputDevice", Napi::Function::New(env, Audio_GetCurrentOutputDevice));
    exports.Set("audio_setOutputDevice",        Napi::Function::New(env, Audio_SetOutputDevice));
    exports.Set("audio_getMasterPeak",      Napi::Function::New(env, Audio_GetMasterPeak));
    exports.Set("audio_getTrackPeak",      Napi::Function::New(env, Audio_GetTrackPeak));
    exports.Set("audio_getAllPeaks",       Napi::Function::New(env, Audio_GetAllPeaks));
    exports.Set("audio_setRealtimeDiagnosticsEnabled",
                Napi::Function::New(env, Audio_SetRealtimeDiagnosticsEnabled));
    exports.Set("audio_resetRealtimeDiagnostics",
                Napi::Function::New(env, Audio_ResetRealtimeDiagnostics));
    exports.Set("audio_getRealtimeDiagnostics",
                Napi::Function::New(env, Audio_GetRealtimeDiagnostics));
    exports.Set("getAudioPerformanceTelemetry",
                Napi::Function::New(env, Audio_GetAudioPerformanceTelemetry));
    exports.Set("audio_getAudioPerformanceTelemetry",
                Napi::Function::New(env, Audio_GetAudioPerformanceTelemetry));
    exports.Set("startAudioPerformanceCapture",
                Napi::Function::New(env, Audio_StartAudioPerformanceCapture));
    exports.Set("audio_startAudioPerformanceCapture",
                Napi::Function::New(env, Audio_StartAudioPerformanceCapture));
    exports.Set("stopAudioPerformanceCapture",
                Napi::Function::New(env, Audio_StopAudioPerformanceCapture));
    exports.Set("audio_stopAudioPerformanceCapture",
                Napi::Function::New(env, Audio_StopAudioPerformanceCapture));
    exports.Set("exportAudioPerformanceCaptureReport",
                Napi::Function::New(env, Audio_ExportAudioPerformanceCaptureReport));
    exports.Set("audio_exportAudioPerformanceCaptureReport",
                Napi::Function::New(env, Audio_ExportAudioPerformanceCaptureReport));
    exports.Set("captureAudioPerformanceReport",
                Napi::Function::New(env, Audio_CaptureAudioPerformanceReport));
    exports.Set("audio_captureAudioPerformanceReport",
                Napi::Function::New(env, Audio_CaptureAudioPerformanceReport));
    exports.Set("audio_setTestDeviceOutputLatencySamplesForDiagnostics",
                Napi::Function::New(env, Audio_SetTestDeviceOutputLatencySamplesForDiagnostics));
    exports.Set("audio_setTrackVolume",    Napi::Function::New(env, Audio_SetTrackVolume));
    exports.Set("audio_setTrackPan",       Napi::Function::New(env, Audio_SetTrackPan));
    exports.Set("audio_setTrackSpread",    Napi::Function::New(env, Audio_SetTrackSpread));
    exports.Set("audio_setMasterVolume",   Napi::Function::New(env, Audio_SetMasterVolume));
    exports.Set("audio_exportStart",       Napi::Function::New(env, Audio_ExportStart));
    exports.Set("audio_exportGetProgress", Napi::Function::New(env, Audio_ExportGetProgress));
    exports.Set("audio_exportCancel",      Napi::Function::New(env, Audio_ExportCancel));
    exports.Set("video_exportStart",            Napi::Function::New(env, Video_ExportStart));
    exports.Set("video_exportGetProgress",      Napi::Function::New(env, Video_ExportGetProgress));
    exports.Set("video_exportCancel",           Napi::Function::New(env, Video_ExportCancel));
    exports.Set("video_computeDurationSeconds", Napi::Function::New(env, Video_ComputeDurationSeconds));
    exports.Set("audio_exportRegion",       Napi::Function::New(env, Audio_ExportRegion));
    exports.Set("audio_swapRegionAudio",    Napi::Function::New(env, Audio_SwapRegionAudio));
    exports.Set("audio_loadRegionAudio",    Napi::Function::New(env, Audio_LoadRegionAudio));
    exports.Set("audio_probeAudioDuration", Napi::Function::New(env, Audio_ProbeAudioDuration));
    exports.Set("audio_revertRegionAudio", Napi::Function::New(env, Audio_RevertRegionAudio));

    // ── P3 — Effect chain ───────────────────────────────────────────────────
    exports.Set("audio_addEffect",            Napi::Function::New(env, Audio_AddEffect));
    exports.Set("audio_removeEffect",         Napi::Function::New(env, Audio_RemoveEffect));
    exports.Set("audio_moveEffect",           Napi::Function::New(env, Audio_MoveEffect));
    exports.Set("audio_setEffectBypass",      Napi::Function::New(env, Audio_SetEffectBypass));
    exports.Set("audio_getEffectChain",       Napi::Function::New(env, Audio_GetEffectChain));
    exports.Set("audio_getEffectParameters",  Napi::Function::New(env, Audio_GetEffectParameters));
    exports.Set("audio_setEffectParameter",   Napi::Function::New(env, Audio_SetEffectParameter));
    exports.Set("audio_getEffectMeter",       Napi::Function::New(env, Audio_GetEffectMeter));
    exports.Set("audio_setEffectVisualizationEnabled",
                Napi::Function::New(env, Audio_SetEffectVisualizationEnabled));
    exports.Set("audio_drainEffectVizFrames",
                Napi::Function::New(env, Audio_DrainEffectVizFrames));
    exports.Set("audio_addMasterEffect",      Napi::Function::New(env, Audio_AddMasterEffect));
    exports.Set("audio_removeMasterEffect",   Napi::Function::New(env, Audio_RemoveMasterEffect));
    exports.Set("audio_moveMasterEffect",     Napi::Function::New(env, Audio_MoveMasterEffect));
    exports.Set("audio_setMasterEffectBypass", Napi::Function::New(env, Audio_SetMasterEffectBypass));
    exports.Set("audio_getMasterEffectChain", Napi::Function::New(env, Audio_GetMasterEffectChain));

    // ── EQ-specific ────────────────────────────────────────────────────────
    exports.Set("audio_eqAddBand",          Napi::Function::New(env, Audio_EQ_AddBand));
    exports.Set("audio_eqRemoveBand",       Napi::Function::New(env, Audio_EQ_RemoveBand));
    exports.Set("audio_eqSetBandParam",     Napi::Function::New(env, Audio_EQ_SetBandParam));
    exports.Set("audio_eqGetResponseCurve", Napi::Function::New(env, Audio_EQ_GetResponseCurve));
    exports.Set("audio_eqGetSpectrumData",  Napi::Function::New(env, Audio_EQ_GetSpectrumData));
    exports.Set("audio_eqSetPreSpectrum",   Napi::Function::New(env, Audio_EQ_SetPreSpectrum));
    exports.Set("audio_eqGetBands",         Napi::Function::New(env, Audio_EQ_GetBands));
    exports.Set("audio_eqGetBandGR",        Napi::Function::New(env, Audio_EQ_GetBandGR));
    exports.Set("audio_eqSetGlobalParam",   Napi::Function::New(env, Audio_EQ_SetGlobalParam));
    exports.Set("audio_eqGetGlobalParams",  Napi::Function::New(env, Audio_EQ_GetGlobalParams));
    exports.Set("audio_eqGetSampleRate",   Napi::Function::New(env, Audio_EQ_GetSampleRate));

    // ── Waveshaper-specific ────────────────────────────────────────────────
    exports.Set("audio_wsGetCurvePoints", Napi::Function::New(env, Audio_WS_GetCurvePoints));
    exports.Set("audio_wsSetCurvePoints", Napi::Function::New(env, Audio_WS_SetCurvePoints));
    exports.Set("audio_wsSetPreset",      Napi::Function::New(env, Audio_WS_SetPreset));

    // ── SmartBalance-specific ──────────────────────────────────────────────
    exports.Set("audio_smartBalanceGetDebug", Napi::Function::New(env, Audio_SmartBalance_GetDebug));

    // ── Graph-mode routing ──────────────────────────────────────────────────
    exports.Set("audio_addConnection",           Napi::Function::New(env, Audio_AddConnection));
    exports.Set("audio_removeConnection",        Napi::Function::New(env, Audio_RemoveConnection));
    exports.Set("audio_setWireGain",             Napi::Function::New(env, Audio_SetWireGain));
    exports.Set("audio_setWireMute",             Napi::Function::New(env, Audio_SetWireMute));
    exports.Set("audio_getGraphTopology",        Napi::Function::New(env, Audio_GetGraphTopology));
    exports.Set("audio_setNodePosition",         Napi::Function::New(env, Audio_SetNodePosition));
    exports.Set("audio_isGraphLinear",           Napi::Function::New(env, Audio_IsGraphLinear));
    // ── Graph-owned effect instances (FXG.3-b) ───────────────────────────────
    exports.Set("audio_addGraphEffectNode",          Napi::Function::New(env, Audio_AddGraphEffectNode));
    exports.Set("audio_removeGraphEffectNode",       Napi::Function::New(env, Audio_RemoveGraphEffectNode));
    exports.Set("audio_getGraphEffectEngineNodeId",  Napi::Function::New(env, Audio_GetGraphEffectEngineNodeId));
    // ── Graph-owned effect parameter descriptors (FXG.4-a) ───────────────────
    exports.Set("audio_getGraphEffectParameters",        Napi::Function::New(env, Audio_GetGraphEffectParameters));
    exports.Set("audio_getGraphEffectParameterValue",    Napi::Function::New(env, Audio_GetGraphEffectParameterValue));
    exports.Set("audio_setGraphEffectParameterNormalized", Napi::Function::New(env, Audio_SetGraphEffectParameterNormalized));
    exports.Set("audio_hydrateGraphEffectNodes",     Napi::Function::New(env, Audio_HydrateGraphEffectNodes));
    exports.Set("audio_syncLinearGraphTopology",     Napi::Function::New(env, Audio_SyncLinearGraphTopology));
    // ── Graph runtime routing + adoption (FXG.3-d) ───────────────────────────
    exports.Set("audio_syncGraphTopology",           Napi::Function::New(env, Audio_SyncGraphTopology));
    exports.Set("audio_adoptGraphEffectNodes",       Napi::Function::New(env, Audio_AdoptGraphEffectNodes));
    exports.Set("audio_addMasterConnection",     Napi::Function::New(env, Audio_AddMasterConnection));
    exports.Set("audio_removeMasterConnection",  Napi::Function::New(env, Audio_RemoveMasterConnection));
    exports.Set("audio_setMasterWireGain",       Napi::Function::New(env, Audio_SetMasterWireGain));
    exports.Set("audio_setMasterWireMute",       Napi::Function::New(env, Audio_SetMasterWireMute));
    exports.Set("audio_getMasterGraphTopology",  Napi::Function::New(env, Audio_GetMasterGraphTopology));
    exports.Set("audio_setMasterNodePosition",   Napi::Function::New(env, Audio_SetMasterNodePosition));
    exports.Set("audio_isMasterGraphLinear",     Napi::Function::New(env, Audio_IsMasterGraphLinear));

    // ── VST3 plugin scanner ─────────────────────────────────────────────────
    exports.Set("audio_scanPlugins",      Napi::Function::New(env, Audio_ScanPlugins));
    exports.Set("audio_getScanProgress",  Napi::Function::New(env, Audio_GetScanProgress));
    exports.Set("audio_getScannedPlugins", Napi::Function::New(env, Audio_GetScannedPlugins));
    exports.Set("audio_getFailedPlugins", Napi::Function::New(env, Audio_GetFailedPlugins));

    // ── VST3 plugin editor windows ──────────────────────────────────────────
    exports.Set("audio_openPluginEditor",    Napi::Function::New(env, Audio_OpenPluginEditor));
    exports.Set("audio_closePluginEditor",   Napi::Function::New(env, Audio_ClosePluginEditor));
    exports.Set("audio_closeAllPluginEditors", Napi::Function::New(env, Audio_CloseAllPluginEditors));
    exports.Set("audio_isPluginEditorOpen",  Napi::Function::New(env, Audio_IsPluginEditorOpen));

    // ── Missing-plugin helpers ──────────────────────────────────────────────
    exports.Set("audio_getMissingPlugins",   Napi::Function::New(env, Audio_GetMissingPlugins));
    exports.Set("audio_retryMissingPlugin",  Napi::Function::New(env, Audio_RetryMissingPlugin));
    exports.Set("audio_removeAllMissing",    Napi::Function::New(env, Audio_RemoveAllMissing));

    // ── VST3 crash recovery ─────────────────────────────────────────────────
    exports.Set("audio_resetCrashedPlugin",  Napi::Function::New(env, Audio_ResetCrashedPlugin));

    // ── Main window handle (for VST editor parenting) ───────────────────────
    exports.Set("audio_setMainWindowHandle", Napi::Function::New(env, Audio_SetMainWindowHandle));

    // ── Phase 1 — Sync ───────────────────────────────────────────────────────
    // sync_getStats = getSyncStats (aliased)
    exports.Set("sync_getStats", Napi::Function::New(env, GetSyncStats));

    // ── Phase 1B — SourcePlayer (Sample Picker preview) ─────────────────────
    exports.Set("source_loadSource",   Napi::Function::New(env, Source_LoadSource));
    exports.Set("source_playSource",   Napi::Function::New(env, Source_PlaySource));
    exports.Set("source_playRegionPreview", Napi::Function::New(env, Source_PlayRegionPreview));
    exports.Set("source_pauseSource",  Napi::Function::New(env, Source_PauseSource));
    exports.Set("source_resumeSource", Napi::Function::New(env, Source_ResumeSource));
    exports.Set("source_seekSource",   Napi::Function::New(env, Source_SeekSource));
    exports.Set("source_stopSource",   Napi::Function::New(env, Source_StopSource));
    exports.Set("source_getPosition",  Napi::Function::New(env, Source_GetPosition));
    exports.Set("source_isPlaying",    Napi::Function::New(env, Source_IsPlaying));
    exports.Set("source_unloadSource", Napi::Function::New(env, Source_UnloadSource));

    // ── Phase 1B — FrameServer (fast frame extraction) ──────────────────────
    exports.Set("video_openSource",  Napi::Function::New(env, Video_OpenSource));
    exports.Set("video_closeSource", Napi::Function::New(env, Video_CloseSource));
    exports.Set("video_getFrame",    Napi::Function::New(env, Video_GetFrame));
    exports.Set("video_requestPreviewFrameAtTimelinePosition",
                Napi::Function::New(env, Video_RequestPreviewFrameAtTimelinePosition));

    // ── Waveform mipmap bindings ─────────────────────────────────────────────
    exports.Set("waveform_getRegionPeaks", Napi::Function::New(env, Waveform_GetRegionPeaks));
    exports.Set("waveform_getRawSamples",  Napi::Function::New(env, Waveform_GetRawSamples));
    exports.Set("waveform_getFilePeaks",   Napi::Function::New(env, Waveform_GetFilePeaks));
    exports.Set("waveform_getClipPeaks",   Napi::Function::New(env, Waveform_GetClipPeaks));

    // ── GPU device management ────────────────────────────────────────────────
    exports.Set("gpu_getAvailableGpus", Napi::Function::New(env, Gpu_GetAvailableGpus));
    exports.Set("gpu_setAdapter",       Napi::Function::New(env, Gpu_SetAdapter));

    // ── Diagnostics (Settings → Graphics → Export Visual Preview Log) ───────
    exports.Set("diag_getVisualPreviewDiagnostic",
                Napi::Function::New(env, Diag_GetVisualPreviewDiagnostic));

    // ── Hardware encoder detection ───────────────────────────────────────────
    exports.Set("hwenc_getAvailableEncoders", Napi::Function::New(env, HwEnc_GetAvailableEncoders));
    exports.Set("hwenc_getDefaultEncoder",    Napi::Function::New(env, HwEnc_GetDefaultEncoder));
    exports.Set("hwenc_refresh",              Napi::Function::New(env, HwEnc_Refresh));

    // ── MIDI Import ──────────────────────────────────────────────────────────
    exports.Set("midi_parseSummary",  Napi::Function::New(env, Midi_ParseSummary));
    exports.Set("midi_importFull",    Napi::Function::New(env, Midi_ImportFull));
    exports.Set("midi_executeImport", Napi::Function::New(env, Midi_ExecuteImport));

    return exports;
}

NODE_API_MODULE(xleth_native, Init)
