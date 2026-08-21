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

Napi::Value SetBPM(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "setBPM");
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

Napi::Value Timeline_PasteClipsBatch(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "timeline_pasteClipsBatch");
}

Napi::Value Timeline_MoveClipsBatch(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "timeline_moveClipsBatch");
}

Napi::Value Timeline_RemoveClipsBatch(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "timeline_removeClipsBatch");
}

Napi::Value Timeline_AutoTrimClip(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "timeline_autoTrimClip");
}

Napi::Value Timeline_SpliceClipsAtPlayhead(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "timeline_spliceClipsAtPlayhead");
}

Napi::Value Timeline_GetGridLayout(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "timeline_getGridLayout");
}

Napi::Value Timeline_CreateSnapshot(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "timeline_createSnapshot");
}

Napi::Value Timeline_DuplicateSnapshot(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "timeline_duplicateSnapshot");
}

Napi::Value Timeline_DeleteSnapshot(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "timeline_deleteSnapshot");
}

Napi::Value Timeline_RenameSnapshot(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "timeline_renameSnapshot");
}

Napi::Value Timeline_SetActiveSnapshot(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "timeline_setActiveSnapshot");
}

Napi::Value Timeline_ListSnapshots(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "timeline_listSnapshots");
}

Napi::Value Timeline_AddCue(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "timeline_addCue");
}

Napi::Value Timeline_MoveCue(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "timeline_moveCue");
}

Napi::Value Timeline_RemoveCue(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "timeline_removeCue");
}

Napi::Value Timeline_ListCues(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "timeline_listCues");
}

Napi::Value Timeline_GetDefaultSnapshot(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "timeline_getDefaultSnapshot");
}

// Slice 2 snapshot-transition authoring IPC. The service handler
// (XlethEngineService Timeline_SetCueTransition) and its dispatch entry already
// exist, as do the preload / electron-main bindings that call
// callWorker('timeline_setCueTransition', ...); this named export is the missing
// link that makes the transition-authoring path reachable through the addon.
Napi::Value Timeline_SetCueTransition(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "timeline_setCueTransition");
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

Napi::Value Timeline_SetPlacementZOrder(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "timeline_setPlacementZOrder");
}

Napi::Value Timeline_SetPreviewFps(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "timeline_setPreviewFps");
}

Napi::Value Timeline_MoveNotesBatch(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "timeline_moveNotesBatch");
}

Napi::Value Timeline_AddNotesBatch(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "timeline_addNotesBatch");
}

Napi::Value Timeline_QuantizeClipsBatch(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "timeline_quantizeClipsBatch");
}

Napi::Value Timeline_ResizeNotesBatch(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "timeline_resizeNotesBatch");
}

Napi::Value Timeline_PreviewNote(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "timeline_previewNote");
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

// Most audio pass-through wrappers (loadSample, mapRegionToSample,
// loadSourceRegion, peak meters, realtime-diagnostics reset/get, mixer
// volume/pan/spread + master volume, output-device get/set) are generated from
// the manifest (XlethRpcExports.inc, AUDIT.md S1 slice 5). The hand-written
// wrappers that remain: setRealtimeDiagnosticsEnabled (excluded — arg coercion),
// the shared Audio_GetAudioPerformanceTelemetry (also serves the non-prefixed
// getAudioPerformanceTelemetry alias), the capture-lifecycle exports, and
// setTestDeviceOutputLatencySamplesForDiagnostics.
Napi::Value Audio_SetRealtimeDiagnosticsEnabled(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "audio_setRealtimeDiagnosticsEnabled");
}

Napi::Value Audio_GetAudioPerformanceTelemetry(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "audio_getAudioPerformanceTelemetry");
}

Napi::Value Audio_StartAudioPerformanceCapture(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "audio_startAudioPerformanceCapture");
}

Napi::Value Audio_StopAudioPerformanceCapture(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "audio_stopAudioPerformanceCapture");
}

Napi::Value Audio_ExportAudioPerformanceCaptureReport(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "audio_exportAudioPerformanceCaptureReport");
}

Napi::Value Audio_CaptureAudioPerformanceReport(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "audio_captureAudioPerformanceReport");
}

Napi::Value Audio_SetTestDeviceOutputLatencySamplesForDiagnostics(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "audio_setTestDeviceOutputLatencySamplesForDiagnostics");
}

Napi::Value Audio_ExportStart(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "audio_exportStart");
}

Napi::Value Video_ExportStart(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "video_exportStart");
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

Napi::Value Video_ExportRegion(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "video_exportRegion");
}

Napi::Value Video_SwapRegionVideo(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "video_swapRegionVideo");
}

Napi::Value Video_RevertRegionVideo(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "video_revertRegionVideo");
}

Napi::Value Audio_SetEffectVisualizationEnabled(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "audio_setEffectVisualizationEnabled");
}

Napi::Value Audio_DrainEffectVizFrames(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "audio_drainEffectVizFrames");
}

// The graph-mode routing surface (wire mutations + graph-owned effect instances
// FXG.3-b, parameter descriptors FXG.4-a, hydrate/sync/adopt topology ops
// FXG.3-d, track + master) is manifest-generated now (XlethRpcExports.inc,
// AUDIT.md S1 slice 7).

Napi::Value Audio_ScanPlugins(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "audio_scanPlugins");
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

Napi::Value Gpu_SetAdapter(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "gpu_setAdapter");
}

Napi::Value Diag_GetVisualPreviewDiagnostic(const Napi::CallbackInfo& info)
{
    return dispatchToService(info, "diag_getVisualPreviewDiagnostic");
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
    exports.Set("triggerSample",      Napi::Function::New(env, TriggerSample));
    exports.Set("loadVideo",          Napi::Function::New(env, LoadVideo));
    exports.Set("getVideoDuration",   Napi::Function::New(env, GetVideoDuration));
    exports.Set("setBPM",             Napi::Function::New(env, SetBPM));
    exports.Set("getCurrentFrame",    Napi::Function::New(env, GetCurrentFrame));
    exports.Set("getFrameBuffer",     Napi::Function::New(env, GetFrameBuffer));
    exports.Set("initFrameOutput",    Napi::Function::New(env, InitFrameOutput));
    exports.Set("initVideoSharedMemory", Napi::Function::New(env, InitVideoSharedMemory));
    exports.Set("addAudioEvent",      Napi::Function::New(env, AddAudioEvent));
    exports.Set("addVideoEvent",      Napi::Function::New(env, AddVideoEvent));
    exports.Set("clearTimeline",      Napi::Function::New(env, ClearTimeline));

    // ── Phase 1 — Project ────────────────────────────────────────────────────
    // Most project exports come from the manifest (XlethRpcExports.inc, S1 slice
    // 3). Only project_load / project_newBlank stay hand-written — their
    // electron-main handlers carry per-call logic (see the wrappers above).
    exports.Set("project_load",            Napi::Function::New(env, Project_Load));
    exports.Set("project_newBlank",        Napi::Function::New(env, Project_NewBlank));

    // ── Phase 1 — Timeline mutations (via UndoManager) ───────────────────────
    exports.Set("timeline_addClipsBatch",           Napi::Function::New(env, Timeline_AddClipsBatch));
    exports.Set("timeline_pasteClipsBatch",         Napi::Function::New(env, Timeline_PasteClipsBatch));
    exports.Set("timeline_moveClipsBatch",          Napi::Function::New(env, Timeline_MoveClipsBatch));
    exports.Set("timeline_removeClipsBatch",        Napi::Function::New(env, Timeline_RemoveClipsBatch));
    exports.Set("timeline_autoTrimClip",            Napi::Function::New(env, Timeline_AutoTrimClip));
    exports.Set("timeline_spliceClipsAtPlayhead",   Napi::Function::New(env, Timeline_SpliceClipsAtPlayhead));

    // ── Grid Layout ──────────────────────────────────────────────────────────
    exports.Set("timeline_createSnapshot",    Napi::Function::New(env, Timeline_CreateSnapshot));
    exports.Set("timeline_duplicateSnapshot", Napi::Function::New(env, Timeline_DuplicateSnapshot));
    exports.Set("timeline_deleteSnapshot",    Napi::Function::New(env, Timeline_DeleteSnapshot));
    exports.Set("timeline_renameSnapshot",    Napi::Function::New(env, Timeline_RenameSnapshot));
    exports.Set("timeline_setActiveSnapshot", Napi::Function::New(env, Timeline_SetActiveSnapshot));
    exports.Set("timeline_listSnapshots",      Napi::Function::New(env, Timeline_ListSnapshots));
    // ── Grid Cues (time-based snapshot resolution) ───────────────────────────
    exports.Set("timeline_addCue",             Napi::Function::New(env, Timeline_AddCue));
    exports.Set("timeline_moveCue",            Napi::Function::New(env, Timeline_MoveCue));
    exports.Set("timeline_removeCue",          Napi::Function::New(env, Timeline_RemoveCue));
    exports.Set("timeline_listCues",           Napi::Function::New(env, Timeline_ListCues));
    exports.Set("timeline_getDefaultSnapshot", Napi::Function::New(env, Timeline_GetDefaultSnapshot));
    exports.Set("timeline_setCueTransition",   Napi::Function::New(env, Timeline_SetCueTransition));
    exports.Set("timeline_getGridLayout",       Napi::Function::New(env, Timeline_GetGridLayout));
    exports.Set("timeline_setGridLayout",       Napi::Function::New(env, Timeline_SetGridLayout));
    exports.Set("timeline_assignTrackToGrid",            Napi::Function::New(env, Timeline_AssignTrackToGrid));
    exports.Set("timeline_assignTrackToGridWithZOrder",  Napi::Function::New(env, Timeline_AssignTrackToGridWithZOrder));
    exports.Set("timeline_removeTrackFromGrid",          Napi::Function::New(env, Timeline_RemoveTrackFromGrid));
    exports.Set("timeline_setFullscreenLayers", Napi::Function::New(env, Timeline_SetFullscreenLayers));
    exports.Set("timeline_setPlacementZOrder",  Napi::Function::New(env, Timeline_SetPlacementZOrder));
    exports.Set("timeline_setPreviewFps",       Napi::Function::New(env, Timeline_SetPreviewFps));

    // ── Patterns / PatternBlocks / Notes ─────────────────────────────────────
    // The region / pattern / pattern-block / single-note pass-throughs and
    // fsc_parse come from the manifest now (XlethRpcExports.inc, S1 slice 4).
    // Only the batch ops and previewNote (preload default) stay hand-written.
    exports.Set("timeline_moveNotesBatch",         Napi::Function::New(env, Timeline_MoveNotesBatch));
    exports.Set("timeline_addNotesBatch",          Napi::Function::New(env, Timeline_AddNotesBatch));
    exports.Set("timeline_quantizeClipsBatch",     Napi::Function::New(env, Timeline_QuantizeClipsBatch));
    exports.Set("timeline_resizeNotesBatch",        Napi::Function::New(env, Timeline_ResizeNotesBatch));
    exports.Set("timeline_previewNote",            Napi::Function::New(env, Timeline_PreviewNote));

    // ── Phase 7 — Preview visibility ────────────────────────────────────────
    exports.Set("preview_setEnabled", Napi::Function::New(env, Preview_SetEnabled));

    // ── Phase 1 — Transport extensions ──────────────────────────────────────
    // DEPRECATED: use getTransportState instead.
    exports.Set("transport_getState", Napi::Function::New(env,
        [](const Napi::CallbackInfo& info) {
            return dispatchToService(info, "getTransportState");
        }));

    // ── WORLD processing indicator ───────────────────────────────────────────
    exports.Set("cache_getWorldActiveJobs", Napi::Function::New(env, Cache_GetWorldActiveJobIds));

    // ── Global clip-processing defaults ─────────────────────────────────────
    exports.Set("engine_setGlobalStretchMethod",   Napi::Function::New(env, Engine_SetGlobalStretchMethod));
    exports.Set("engine_getGlobalStretchMethod",   Napi::Function::New(env, Engine_GetGlobalStretchMethod));
    exports.Set("engine_setGlobalFormantPreserve", Napi::Function::New(env, Engine_SetGlobalFormantPreserve));
    exports.Set("engine_getGlobalFormantPreserve", Napi::Function::New(env, Engine_GetGlobalFormantPreserve));

    // ── Phase 1 — Audio / MixEngine ─────────────────────────────────────────
    // Pure pass-through exports (loadSample, mapRegionToSample, loadSourceRegion,
    // peak meters, realtime-diagnostics reset/get, performance telemetry, mixer
    // volume/pan/spread + master volume, output-device get/set) come from the
    // manifest (XlethRpcExports.inc, S1 slice 5). Hand-written below: the excluded
    // setRealtimeDiagnosticsEnabled, deprecated performance aliases, and the
    // canonical capture lifecycle exports.
    exports.Set("audio_setRealtimeDiagnosticsEnabled",
                Napi::Function::New(env, Audio_SetRealtimeDiagnosticsEnabled));
    // DEPRECATED: use audio_getAudioPerformanceTelemetry instead.
    exports.Set("getAudioPerformanceTelemetry", Napi::Function::New(env,
        [](const Napi::CallbackInfo& info) {
            return dispatchToService(info, "audio_getAudioPerformanceTelemetry");
        }));
    // DEPRECATED: use audio_startAudioPerformanceCapture instead.
    exports.Set("startAudioPerformanceCapture", Napi::Function::New(env,
        [](const Napi::CallbackInfo& info) {
            return dispatchToService(info, "audio_startAudioPerformanceCapture");
        }));
    exports.Set("audio_startAudioPerformanceCapture",
                Napi::Function::New(env, Audio_StartAudioPerformanceCapture));
    // DEPRECATED: use audio_stopAudioPerformanceCapture instead.
    exports.Set("stopAudioPerformanceCapture", Napi::Function::New(env,
        [](const Napi::CallbackInfo& info) {
            return dispatchToService(info, "audio_stopAudioPerformanceCapture");
        }));
    exports.Set("audio_stopAudioPerformanceCapture",
                Napi::Function::New(env, Audio_StopAudioPerformanceCapture));
    // DEPRECATED: use audio_exportAudioPerformanceCaptureReport instead.
    exports.Set("exportAudioPerformanceCaptureReport", Napi::Function::New(env,
        [](const Napi::CallbackInfo& info) {
            return dispatchToService(info, "audio_exportAudioPerformanceCaptureReport");
        }));
    exports.Set("audio_exportAudioPerformanceCaptureReport",
                Napi::Function::New(env, Audio_ExportAudioPerformanceCaptureReport));
    // DEPRECATED: use audio_captureAudioPerformanceReport instead.
    exports.Set("captureAudioPerformanceReport", Napi::Function::New(env,
        [](const Napi::CallbackInfo& info) {
            return dispatchToService(info, "audio_captureAudioPerformanceReport");
        }));
    exports.Set("audio_captureAudioPerformanceReport",
                Napi::Function::New(env, Audio_CaptureAudioPerformanceReport));
    exports.Set("audio_setTestDeviceOutputLatencySamplesForDiagnostics",
                Napi::Function::New(env, Audio_SetTestDeviceOutputLatencySamplesForDiagnostics));
    // audio_exportStart / video_exportStart stay hand-written (each starts a
    // progress-poll interval). exportGetProgress / exportCancel for both migrated
    // to the RPC manifest (XlethRpcExports.inc).
    exports.Set("audio_exportStart",       Napi::Function::New(env, Audio_ExportStart));
    exports.Set("video_exportStart",            Napi::Function::New(env, Video_ExportStart));
    exports.Set("video_computeDurationSeconds", Napi::Function::New(env, Video_ComputeDurationSeconds));
    exports.Set("audio_exportRegion",       Napi::Function::New(env, Audio_ExportRegion));
    exports.Set("audio_swapRegionAudio",    Napi::Function::New(env, Audio_SwapRegionAudio));
    exports.Set("audio_loadRegionAudio",    Napi::Function::New(env, Audio_LoadRegionAudio));
    exports.Set("audio_probeAudioDuration", Napi::Function::New(env, Audio_ProbeAudioDuration));
    exports.Set("audio_revertRegionAudio", Napi::Function::New(env, Audio_RevertRegionAudio));
    exports.Set("video_exportRegion",       Napi::Function::New(env, Video_ExportRegion));
    exports.Set("video_swapRegionVideo",    Napi::Function::New(env, Video_SwapRegionVideo));
    exports.Set("video_revertRegionVideo",  Napi::Function::New(env, Video_RevertRegionVideo));

    // ── P3 — Effect visualization (dynamics; binary payload) ────────────────
    // The rest of the effect chain / EQ / Waveshaper / SmartBalance surface is
    // manifest-generated (XlethRpcExports.inc, AUDIT.md S1 slice 6).
    exports.Set("audio_setEffectVisualizationEnabled",
                Napi::Function::New(env, Audio_SetEffectVisualizationEnabled));
    exports.Set("audio_drainEffectVizFrames",
                Napi::Function::New(env, Audio_DrainEffectVizFrames));

    // ── Graph-mode routing surface (wire mutations + graph-owned effect
    //    instances FXG.3-b / parameter descriptors FXG.4-a / hydrate-sync-adopt
    //    topology ops FXG.3-d, track + master) is manifest-generated now
    //    (XlethRpcExports.inc, AUDIT.md S1 slice 7).

    // ── VST3 plugin scanner ─────────────────────────────────────────────────
    // audio_scanPlugins stays hand-written (its vst3.js handler reshapes the
    // argument before forwarding). The scan-progress/scanned/failed queries, the
    // plugin-editor window methods, the missing-plugin helpers, and crash
    // recovery all migrated to the RPC manifest (XlethRpcExports.inc).
    exports.Set("audio_scanPlugins",      Napi::Function::New(env, Audio_ScanPlugins));

    // ── Main window handle (for VST editor parenting) ───────────────────────
    exports.Set("audio_setMainWindowHandle", Napi::Function::New(env, Audio_SetMainWindowHandle));

    // ── Phase 1 — Sync ───────────────────────────────────────────────────────
    // DEPRECATED: use getSyncStats instead.
    exports.Set("sync_getStats", Napi::Function::New(env,
        [](const Napi::CallbackInfo& info) {
            return dispatchToService(info, "getSyncStats");
        }));

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
    // gpu_getAvailableGpus migrated to the RPC manifest (XlethRpcExports.inc).
    exports.Set("gpu_setAdapter",       Napi::Function::New(env, Gpu_SetAdapter));

    // ── Diagnostics (Settings → Graphics → Export Visual Preview Log) ───────
    exports.Set("diag_getVisualPreviewDiagnostic",
                Napi::Function::New(env, Diag_GetVisualPreviewDiagnostic));

    // ── Hardware encoder detection ───────────────────────────────────────────
    // hwenc_getAvailableEncoders / hwenc_getDefaultEncoder migrated to the RPC
    // manifest (XlethRpcExports.inc).
    exports.Set("hwenc_refresh",              Napi::Function::New(env, HwEnc_Refresh));

    // ── MIDI Import ──────────────────────────────────────────────────────────
    exports.Set("midi_parseSummary",  Napi::Function::New(env, Midi_ParseSummary));
    exports.Set("midi_importFull",    Napi::Function::New(env, Midi_ImportFull));
    exports.Set("midi_executeImport", Napi::Function::New(env, Midi_ExecuteImport));

    return exports;
}

NODE_API_MODULE(xleth_native, Init)
