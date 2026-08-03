// XlethSvcGpuDiag.cpp — GPU device / visual-preview diagnostics / hardware
// encoder detection / preview-visibility domain (S2 Stage 3).
//
// Verbatim move of Gpu_GetAvailableGpus / Diag_GetVisualPreviewDiagnostic /
// Gpu_SetAdapter / HwEnc_GetAvailableEncoders / HwEnc_GetDefaultEncoder /
// HwEnc_Refresh / Preview_SetEnabled out of XlethEngineService.cpp, plus the
// three internal-linkage text helpers they alone call (readbackHRESULTText,
// featureLevelText, readbackFailureStageText — relocated from the file's
// top anonymous namespace since they are otherwise unreachable from this TU).
// No behavior change — see docs/S2_SPLIT_PLAN.md §4 Stage 3.
// dispatch() (still in XlethEngineService.cpp) resolves these via
// XlethSvcGpuDiag.h.

#include "service/XlethSvcGlobals.h"
using namespace xleth::svc;
#include "service/XlethSvcShared.h"
#include "service/XlethSvcGpuDiag.h"

#include "model/Timeline.h"
#include "model/TimelineTypes.h"
#include "project/ProxyManager.h"
#include "render/GpuDeviceManager.h"
#include "render/GridCompositor.h"
#include "render/HwEncoderDetector.h"
#include "render/RenderVideoDecoder.h"
#include "render/VisualFrameDiagnostics.h"

#include <cstdio>
#include <cstring>
#include <mutex>
#include <string>
#include <vector>

// ─────────────────────────────────────────────────────────────────────────────
// Text helpers — relocated verbatim from the file-top anonymous namespace in
// XlethEngineService.cpp (was lines 147/166/183). Each has exactly one caller,
// Diag_GetVisualPreviewDiagnostic below; kept `static` (internal linkage,
// matching their original anon-namespace linkage).
// ─────────────────────────────────────────────────────────────────────────────

static const char* readbackHRESULTText(int32_t hrValue)
{
    const HRESULT hr = static_cast<HRESULT>(hrValue);
    switch (hr) {
        case S_OK:                         return "S_OK";
        case DXGI_ERROR_INVALID_CALL:      return "DXGI_ERROR_INVALID_CALL";
        case DXGI_ERROR_WAS_STILL_DRAWING: return "DXGI_ERROR_WAS_STILL_DRAWING";
        case DXGI_ERROR_DEVICE_REMOVED:    return "DXGI_ERROR_DEVICE_REMOVED";
        case DXGI_ERROR_DEVICE_HUNG:       return "DXGI_ERROR_DEVICE_HUNG";
        case DXGI_ERROR_DEVICE_RESET:      return "DXGI_ERROR_DEVICE_RESET";
        case E_INVALIDARG:                 return "E_INVALIDARG";
        case E_POINTER:                    return "E_POINTER";
        case E_FAIL:                       return "E_FAIL";
        case E_OUTOFMEMORY:                return "E_OUTOFMEMORY";
        default:                           return "(unknown)";
    }
}

// Map a raw D3D_FEATURE_LEVEL value to its short name for the diagnostic log.
static const char* featureLevelText(uint32_t fl)
{
    switch (fl) {
        case 0x9100: return "9_1";
        case 0x9200: return "9_2";
        case 0x9300: return "9_3";
        case 0xa000: return "10_0";
        case 0xa100: return "10_1";
        case 0xb000: return "11_0";
        case 0xb100: return "11_1";
        case 0xc000: return "12_0";
        case 0xc100: return "12_1";
        case 0:      return "n/a";
        default:     return "(other)";
    }
}

static const char* readbackFailureStageText(int stage)
{
    switch (static_cast<ReadbackFailureStage>(stage)) {
        case ReadbackFailureStage::None:                        return "none";
        case ReadbackFailureStage::StagingTextureMissing:       return "staging_texture_missing";
        case ReadbackFailureStage::StagingTextureCreateFailed:  return "staging_texture_create_failed";
        case ReadbackFailureStage::SourceTextureMissing:        return "source_texture_missing";
        case ReadbackFailureStage::CopyPreconditionFailed:      return "copy_precondition_failed";
        case ReadbackFailureStage::CopyIssuedThenDeviceRemoved: return "copy_issued_then_device_removed";
        case ReadbackFailureStage::MapFailed:                   return "map_failed";
        case ReadbackFailureStage::RowPitchInvalid:             return "row_pitch_invalid";
        case ReadbackFailureStage::DimensionsInvalid:           return "dimensions_invalid";
        default:                                                return "unknown";
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// GPU device management (D3D11)
// ─────────────────────────────────────────────────────────────────────────────

// gpu_getAvailableGpus() → [{name, vendor, vendorId, vramMB, isDiscrete, isDefault}]
JsonApi::Value Gpu_GetAvailableGpus(const JsonApi::CallbackInfo& info)
{
    JsonApi::Env env = info.Env();
    BridgeCallLog log("gpu.getAvailableGpus");

    // Lazy-init: detect adapters on first call
    if (!g_gpuDevice) {
        g_gpuDevice = std::make_unique<GpuDeviceManager>();
        if (!g_gpuDevice->detectAdapters()) {
            JsonApi::Error::New(env, "Failed to enumerate DXGI adapters").ThrowAsJavaScriptException();
            return env.Undefined();
        }
    }

    const auto& adapters = g_gpuDevice->getAdapters();
    std::fprintf(stderr, "[GpuDevice] host bridge getAvailableGpus: returning %zu adapters\n",
                 adapters.size());

    JsonApi::Array arr = JsonApi::Array::New(env, adapters.size());
    for (size_t i = 0; i < adapters.size(); ++i) {
        const auto& a = adapters[i];

        // Convert wstring name to narrow string for JS
        // GPU names are ASCII in practice (vendor model strings)
        std::string nameUtf8;
        nameUtf8.reserve(a.name.size());
        for (wchar_t wc : a.name)
            nameUtf8.push_back(static_cast<char>(wc & 0x7F));

        // Vendor string
        const char* vendorStr = "Unknown";
        if (a.vendorId == GpuVendor::NVIDIA) vendorStr = "NVIDIA";
        else if (a.vendorId == GpuVendor::AMD)    vendorStr = "AMD";
        else if (a.vendorId == GpuVendor::Intel)  vendorStr = "Intel";

        JsonApi::Object o = JsonApi::Object::New(env);
        o.Set("name",       JsonApi::String::New(env, nameUtf8));
        o.Set("vendor",     JsonApi::String::New(env, vendorStr));
        o.Set("vendorId",   JsonApi::Number::New(env, a.vendorId));
        o.Set("deviceId",   JsonApi::Number::New(env, a.deviceId));
        o.Set("vramMB",     JsonApi::Number::New(env, static_cast<double>(a.dedicatedVideoMemoryMB)));
        o.Set("sharedSystemMemoryMB",
                            JsonApi::Number::New(env, static_cast<double>(a.sharedSystemMemoryMB)));
        o.Set("isDiscrete", JsonApi::Boolean::New(env, a.isDiscrete));
        o.Set("isDefault",  JsonApi::Boolean::New(env, a.isDefault));
        o.Set("index",      JsonApi::Number::New(env, a.adapterIndex));
        o.Set("luidHighPart", JsonApi::Number::New(env, a.luidHighPart));
        o.Set("luidLowPart",  JsonApi::Number::New(env, a.luidLowPart));
        arr.Set(static_cast<uint32_t>(i), o);
    }

    log.done(std::to_string(adapters.size()) + " adapters");
    return arr;
}

// ─────────────────────────────────────────────────────────────────────────────
// diag_getVisualPreviewDiagnostic()
//
// Returns a structured snapshot of the live preview / grid pipeline state for
// the Settings → Graphics → Export Visual Preview Diagnostic Log feature.
// All counters are atomic and read without locking the compositor mutex so
// the call is safe to invoke from the JS thread mid-playback.
//
// The shape is intentionally flat-ish so JSON.stringify in the renderer can
// turn the whole object into a plain-text section in the .txt log.
// ─────────────────────────────────────────────────────────────────────────────
JsonApi::Value Diag_GetVisualPreviewDiagnostic(const JsonApi::CallbackInfo& info)
{
    JsonApi::Env env = info.Env();
    JsonApi::Object o = JsonApi::Object::New(env);

    // ── Adapter list (mirrors gpu_getAvailableGpus output, included so the
    //    diagnostic .txt is self-contained without a second host bridge call) ───────
    JsonApi::Array adapterArr;
    if (g_gpuDevice) {
        const auto& adapters = g_gpuDevice->getAdapters();
        adapterArr = JsonApi::Array::New(env, adapters.size());
        for (size_t i = 0; i < adapters.size(); ++i) {
            const auto& a = adapters[i];
            std::string nameUtf8;
            nameUtf8.reserve(a.name.size());
            for (wchar_t wc : a.name)
                nameUtf8.push_back(static_cast<char>(wc & 0x7F));
            const char* vendorStr = "Unknown";
            if (a.vendorId == GpuVendor::NVIDIA)      vendorStr = "NVIDIA";
            else if (a.vendorId == GpuVendor::AMD)    vendorStr = "AMD";
            else if (a.vendorId == GpuVendor::Intel)  vendorStr = "Intel";

            JsonApi::Object ao = JsonApi::Object::New(env);
            ao.Set("name",       JsonApi::String::New(env, nameUtf8));
            ao.Set("vendor",     JsonApi::String::New(env, vendorStr));
            ao.Set("vendorId",   JsonApi::Number::New(env, a.vendorId));
            ao.Set("deviceId",   JsonApi::Number::New(env, a.deviceId));
            ao.Set("vramMB",     JsonApi::Number::New(env, static_cast<double>(a.dedicatedVideoMemoryMB)));
            ao.Set("sharedSystemMemoryMB",
                                 JsonApi::Number::New(env, static_cast<double>(a.sharedSystemMemoryMB)));
            ao.Set("isDiscrete", JsonApi::Boolean::New(env, a.isDiscrete));
            ao.Set("isDefault",  JsonApi::Boolean::New(env, a.isDefault));
            ao.Set("index",      JsonApi::Number::New(env, a.adapterIndex));
            ao.Set("luidHighPart", JsonApi::Number::New(env, a.luidHighPart));
            ao.Set("luidLowPart",  JsonApi::Number::New(env, a.luidLowPart));
            adapterArr.Set(static_cast<uint32_t>(i), ao);
        }
        o.Set("activeAdapterIndex",
              JsonApi::Number::New(env, g_gpuDevice->getActiveAdapterIndex()));
        o.Set("hasD3D11Device", JsonApi::Boolean::New(env, g_gpuDevice->hasDevice()));
        o.Set("activeFeatureLevel",
              JsonApi::String::New(env, featureLevelText(g_gpuDevice->getActiveFeatureLevel())));
        o.Set("deviceIsWarp", JsonApi::Boolean::New(env, g_gpuDevice->isWarpDevice()));
        o.Set("debugLayerActive", JsonApi::Boolean::New(env, g_gpuDevice->isDebugLayerActive()));
    } else {
        adapterArr = JsonApi::Array::New(env, 0);
        o.Set("activeAdapterIndex", JsonApi::Number::New(env, -1));
        o.Set("hasD3D11Device", JsonApi::Boolean::New(env, false));
        o.Set("activeFeatureLevel", JsonApi::String::New(env, "n/a"));
        o.Set("deviceIsWarp", JsonApi::Boolean::New(env, false));
        o.Set("debugLayerActive", JsonApi::Boolean::New(env, false));
    }
    o.Set("adapters", adapterArr);

    // ── Compositor lifecycle / state ─────────────────────────────────────────
    o.Set("compositorReady",
          JsonApi::Boolean::New(env, g_previewCompositorReady.load()));
    o.Set("compositorPresent",
          JsonApi::Boolean::New(env, g_previewCompositor != nullptr));
    o.Set("decoderPresent",
          JsonApi::Boolean::New(env, g_previewRenderDecoder != nullptr));
    o.Set("collectorPresent",
          JsonApi::Boolean::New(env, g_previewCollector != nullptr));
    o.Set("renderCachePresent",
          JsonApi::Boolean::New(env, g_previewRenderCache != nullptr));
    o.Set("animMgrPresent",
          JsonApi::Boolean::New(env, g_previewAnimMgr != nullptr));
    o.Set("pauseForExport",
          JsonApi::Boolean::New(env, g_previewPauseForExport.load()));
    o.Set("pauseForVisibility",
          JsonApi::Boolean::New(env, g_previewPauseForVisibility.load()));
    o.Set("previewResolutionScale",
          JsonApi::Number::New(env, g_previewResolutionScale));
    o.Set("previewEffectsBypass",
          JsonApi::Boolean::New(env, g_previewEffectsBypass));
    o.Set("previewPosterMode",
          JsonApi::Boolean::New(env, g_previewPosterMode));
    {
        JsonApi::Object stoppedPreview = JsonApi::Object::New(env);
        stoppedPreview.Set("latestSeq",
            JsonApi::Number::New(env, static_cast<double>(
                g_latestStoppedPreviewSeq.load(std::memory_order_acquire))));
        stoppedPreview.Set("pendingSeq",
            JsonApi::Number::New(env, static_cast<double>(
                g_pendingStoppedPreviewSeq.load(std::memory_order_acquire))));
        stoppedPreview.Set("publishedSeq",
            JsonApi::Number::New(env, static_cast<double>(
                g_publishedStoppedPreviewSeq.load(std::memory_order_acquire))));
        stoppedPreview.Set("discardedCount",
            JsonApi::Number::New(env, static_cast<double>(
                g_discardedStoppedPreviewSeq.load(std::memory_order_acquire))));
        stoppedPreview.Set("pendingSample",
            JsonApi::Number::New(env, static_cast<double>(
                g_pendingStoppedPreviewSample.load(std::memory_order_acquire))));
        o.Set("stoppedPreview", stoppedPreview);
    }

    // ── Canvas / FrameOutput ─────────────────────────────────────────────────
    o.Set("canvasWidth",  JsonApi::Number::New(env, CANVAS_W));
    o.Set("canvasHeight", JsonApi::Number::New(env, CANVAS_H));
    o.Set("frameOutputInitialized",
          JsonApi::Boolean::New(env, frameOutput.isInitialized()));
    o.Set("frameOutputWidth",  JsonApi::Number::New(env, frameOutput.getWidth()));
    o.Set("frameOutputHeight", JsonApi::Number::New(env, frameOutput.getHeight()));
    o.Set("frameOutputBufferSize", JsonApi::Number::New(env, frameOutput.getBufferSize()));
    o.Set("frameOutputCurrentIndex", JsonApi::Number::New(env, frameOutput.getCurrentBufferIndex()));

    // ── Counters (since process start) ───────────────────────────────────────
    JsonApi::Object c = JsonApi::Object::New(env);
    c.Set("videoTickCount",
          JsonApi::Number::New(env, static_cast<double>(g_previewDiag.videoTickCount.load())));
    c.Set("compositorPathEntered",
          JsonApi::Number::New(env, static_cast<double>(g_previewDiag.compositorPathEntered.load())));
    c.Set("gateIsPlayingTrueTicks",
          JsonApi::Number::New(env, static_cast<double>(g_previewDiag.gateIsPlayingTrueTicks.load())));
    c.Set("gateEventsNonEmptyTicks",
          JsonApi::Number::New(env, static_cast<double>(g_previewDiag.gateEventsNonEmptyTicks.load())));
    c.Set("gateForceRenderTicks",
          JsonApi::Number::New(env, static_cast<double>(g_previewDiag.gateForceRenderTicks.load())));
    c.Set("gatePreviewPausedTicks",
          JsonApi::Number::New(env, static_cast<double>(g_previewDiag.gatePreviewPausedTicks.load())));
    c.Set("gateBlockReachedTicks",
          JsonApi::Number::New(env, static_cast<double>(g_previewDiag.gateBlockReachedTicks.load())));
    c.Set("gateBlockSkippedNoInit",
          JsonApi::Number::New(env, static_cast<double>(g_previewDiag.gateBlockSkippedNoInit.load())));
    c.Set("compositeFrameCount",
          JsonApi::Number::New(env, static_cast<double>(g_previewDiag.compositeFrameCount.load())));
    c.Set("readbackValidCount",
          JsonApi::Number::New(env, static_cast<double>(g_previewDiag.readbackValidCount.load())));
    c.Set("readbackNotReadyCount",
          JsonApi::Number::New(env, static_cast<double>(g_previewDiag.readbackNotReadyCount.load())));
    c.Set("readbackInvalidCount",
          JsonApi::Number::New(env, static_cast<double>(g_previewDiag.readbackInvalidCount.load())));
    c.Set("canvasCopyCount",
          JsonApi::Number::New(env, static_cast<double>(g_previewDiag.canvasCopyCount.load())));
    c.Set("blackFrameCount",
          JsonApi::Number::New(env, static_cast<double>(g_previewDiag.blackFrameCount.load())));
    c.Set("compositorInitFailures",
          JsonApi::Number::New(env, static_cast<double>(g_previewDiag.initInitFailures.load())));
    c.Set("readbackPolicyActive",
          JsonApi::Number::New(env, g_previewDiag.readbackPolicyActive.load()));
    c.Set("readbackPolicySwitchReason",
          JsonApi::Number::New(env, g_previewDiag.readbackPolicySwitchReason.load()));
    c.Set("droppedPendingFrames",
          JsonApi::Number::New(env, static_cast<double>(g_previewDiag.droppedPendingFrames.load())));
    c.Set("pendingSlotsCount",
          JsonApi::Number::New(env, g_previewDiag.pendingSlotsCount.load()));
    c.Set("lastReadbackUs",
          JsonApi::Number::New(env, g_previewDiag.lastReadbackUs.load()));
    c.Set("avgReadbackUs",
          JsonApi::Number::New(env, g_previewDiag.avgReadbackUs.load()));
    c.Set("maxReadbackUs",
          JsonApi::Number::New(env, g_previewDiag.maxReadbackUs.load()));
    // ── Preview-tick per-stage wall-clock timing (µs) — instrumentation only ──
    c.Set("lastCollectUs",   JsonApi::Number::New(env, g_previewDiag.lastCollectUs.load()));
    c.Set("avgCollectUs",    JsonApi::Number::New(env, g_previewDiag.avgCollectUs.load()));
    c.Set("maxCollectUs",    JsonApi::Number::New(env, g_previewDiag.maxCollectUs.load()));
    c.Set("lastResolveUs",   JsonApi::Number::New(env, g_previewDiag.lastResolveUs.load()));
    c.Set("avgResolveUs",    JsonApi::Number::New(env, g_previewDiag.avgResolveUs.load()));
    c.Set("maxResolveUs",    JsonApi::Number::New(env, g_previewDiag.maxResolveUs.load()));
    c.Set("lastDecodeUs",    JsonApi::Number::New(env, g_previewDiag.lastDecodeUs.load()));
    c.Set("avgDecodeUs",     JsonApi::Number::New(env, g_previewDiag.avgDecodeUs.load()));
    c.Set("maxDecodeUs",     JsonApi::Number::New(env, g_previewDiag.maxDecodeUs.load()));
    c.Set("lastCompositeUs", JsonApi::Number::New(env, g_previewDiag.lastCompositeUs.load()));
    c.Set("avgCompositeUs",  JsonApi::Number::New(env, g_previewDiag.avgCompositeUs.load()));
    c.Set("maxCompositeUs",  JsonApi::Number::New(env, g_previewDiag.maxCompositeUs.load()));
    c.Set("lastSwizzleUs",   JsonApi::Number::New(env, g_previewDiag.lastSwizzleUs.load()));
    c.Set("avgSwizzleUs",    JsonApi::Number::New(env, g_previewDiag.avgSwizzleUs.load()));
    c.Set("maxSwizzleUs",    JsonApi::Number::New(env, g_previewDiag.maxSwizzleUs.load()));
    c.Set("lastTickUs",      JsonApi::Number::New(env, g_previewDiag.lastTickUs.load()));
    c.Set("avgTickUs",       JsonApi::Number::New(env, g_previewDiag.avgTickUs.load()));
    c.Set("maxTickUs",       JsonApi::Number::New(env, g_previewDiag.maxTickUs.load()));
    c.Set("deliveredFps",    JsonApi::Number::New(env, g_previewDiag.deliveredFps.load()));
    c.Set("lastCellCount",   JsonApi::Number::New(env, g_previewDiag.lastCellCount.load()));
    c.Set("maxCellCount",    JsonApi::Number::New(env, g_previewDiag.maxCellCount.load()));
    c.Set("syncManagerDecodeCount",
          JsonApi::Number::New(env, g_previewDiag.syncManagerDecodeCount.load()));
    c.Set("lastVideoTickUs", JsonApi::Number::New(env, g_previewDiag.lastVideoTickUs.load()));
    c.Set("avgVideoTickUs",  JsonApi::Number::New(env, g_previewDiag.avgVideoTickUs.load()));
    c.Set("maxVideoTickUs",  JsonApi::Number::New(env, g_previewDiag.maxVideoTickUs.load()));
    o.Set("counters", c);

    // ── Last-tick snapshot ───────────────────────────────────────────────────
    JsonApi::Object last = JsonApi::Object::New(env);
    last.Set("readbackWidth",  JsonApi::Number::New(env, g_previewDiag.lastReadbackWidth.load()));
    last.Set("readbackHeight", JsonApi::Number::New(env, g_previewDiag.lastReadbackHeight.load()));
    last.Set("requestCount",   JsonApi::Number::New(env, g_previewDiag.lastRequestCount.load()));
    last.Set("decodeMissCount",JsonApi::Number::New(env, g_previewDiag.lastDecodeMissCount.load()));
    last.Set("activeVisualEvents", JsonApi::Number::New(env, g_previewDiag.lastActiveVisualEvents.load()));
    last.Set("dedupKeyCount",      JsonApi::Number::New(env, g_previewDiag.lastDedupKeyCount.load()));
    last.Set("cacheHitCount",      JsonApi::Number::New(env, g_previewDiag.lastCacheHitCount.load()));
    last.Set("decodeSuccessCount", JsonApi::Number::New(env, g_previewDiag.lastDecodeSuccessCount.load()));
    last.Set("decodeFailCount",    JsonApi::Number::New(env, g_previewDiag.lastDecodeFailCount.load()));
    last.Set("previewTimeMs",      JsonApi::Number::New(env, g_previewDiag.lastPreviewTimeMs.load()));
    last.Set("layoutColumns",  JsonApi::Number::New(env, g_previewDiag.lastLayoutColumns.load()));
    last.Set("layoutRows",     JsonApi::Number::New(env, g_previewDiag.lastLayoutRows.load()));
    last.Set("compositorWidth",  JsonApi::Number::New(env, g_previewDiag.lastCompositorWidth.load()));
    last.Set("compositorHeight", JsonApi::Number::New(env, g_previewDiag.lastCompositorHeight.load()));
    last.Set("initWidth",  JsonApi::Number::New(env, g_previewDiag.lastInitW.load()));
    last.Set("initHeight", JsonApi::Number::New(env, g_previewDiag.lastInitH.load()));
    {
        const int32_t hr = g_previewDiag.lastReadbackHRESULT.load();
        char hrHex[12];
        std::snprintf(hrHex, sizeof(hrHex), "0x%08X", static_cast<unsigned int>(hr));
        last.Set("lastReadbackHRESULT", JsonApi::String::New(env, hrHex));
        last.Set("lastReadbackHRESULTText",
                 JsonApi::String::New(env, readbackHRESULTText(hr)));

        const int32_t removed = g_previewDiag.lastDeviceRemovedReason.load();
        char removedHex[12];
        std::snprintf(removedHex, sizeof(removedHex), "0x%08X",
                      static_cast<unsigned int>(removed));
        last.Set("deviceRemovedReason", JsonApi::String::New(env, removedHex));
        last.Set("deviceRemovedReasonText",
                 JsonApi::String::New(env, readbackHRESULTText(removed)));

        const int stage = g_previewDiag.lastReadbackFailureStage.load();
        last.Set("lastReadbackFailureStage",
                 JsonApi::String::New(env, readbackFailureStageText(stage)));
        last.Set("readbackMapType",
                 JsonApi::Number::New(env, g_previewDiag.lastReadbackMapType.load()));
        last.Set("readbackMapFlags",
                 JsonApi::Number::New(env, g_previewDiag.lastReadbackMapFlags.load()));
        last.Set("mappedRowPitch",
                 JsonApi::Number::New(env, g_previewDiag.lastReadbackRowPitch.load()));
        last.Set("expectedBytes",
                 JsonApi::Number::New(env, static_cast<double>(
                     g_previewDiag.lastReadbackExpectedBytes.load())));
        last.Set("actualCopyBytes",
                 JsonApi::Number::New(env, static_cast<double>(
                     g_previewDiag.lastReadbackActualCopyBytes.load())));
        last.Set("sourceStagingDimensionsMatch",
                 JsonApi::Boolean::New(env, g_previewDiag.lastReadbackDimensionsMatch.load()));

        JsonApi::Object source = JsonApi::Object::New(env);
        source.Set("width", JsonApi::Number::New(env, g_previewDiag.lastReadbackSourceWidth.load()));
        source.Set("height", JsonApi::Number::New(env, g_previewDiag.lastReadbackSourceHeight.load()));
        source.Set("format", JsonApi::Number::New(env, g_previewDiag.lastReadbackSourceFormat.load()));
        source.Set("sampleCount", JsonApi::Number::New(env, g_previewDiag.lastReadbackSourceSampleCount.load()));
        last.Set("sourceTexture", source);

        JsonApi::Object staging = JsonApi::Object::New(env);
        staging.Set("width", JsonApi::Number::New(env, g_previewDiag.lastReadbackStagingWidth.load()));
        staging.Set("height", JsonApi::Number::New(env, g_previewDiag.lastReadbackStagingHeight.load()));
        staging.Set("format", JsonApi::Number::New(env, g_previewDiag.lastReadbackStagingFormat.load()));
        staging.Set("usage", JsonApi::Number::New(env, g_previewDiag.lastReadbackStagingUsage.load()));
        staging.Set("cpuAccessFlags", JsonApi::Number::New(env, g_previewDiag.lastReadbackStagingCPUAccessFlags.load()));
        staging.Set("bindFlags", JsonApi::Number::New(env, g_previewDiag.lastReadbackStagingBindFlags.load()));
        staging.Set("miscFlags", JsonApi::Number::New(env, g_previewDiag.lastReadbackStagingMiscFlags.load()));
        staging.Set("sampleCount", JsonApi::Number::New(env, g_previewDiag.lastReadbackStagingSampleCount.load()));
        last.Set("stagingTexture", staging);
    }
    o.Set("lastTick", last);

    // ── Timeline / grid summary (best-effort, optional) ──────────────────────
    if (g_timeline) {
        const auto layout = g_timeline->getGridLayout();
        JsonApi::Object gl = JsonApi::Object::New(env);
        gl.Set("columns",    JsonApi::Number::New(env, layout.columns));
        gl.Set("rows",       JsonApi::Number::New(env, layout.rows));
        gl.Set("previewFps", JsonApi::Number::New(env, layout.previewFps));
        gl.Set("gapScale",   JsonApi::Number::New(env, layout.gapScale));
        o.Set("gridLayout", gl);
    }

    // ── Per-source poster / proxy + active decode path ───────────────────────
    // The fields that let a capture confirm the poster/proxy fix:
    //   posterReady / proxyReady — generation status per source.
    //   decodePath               — hardware (D3D11VA) vs software, read from the
    //                              live RenderVideoDecoder context for the path
    //                              currently open for this source.
    //   posterEngaged            — true when the preview is actually binding the
    //                              poster JPEG (so the long-GOP original is NOT
    //                              being decoded). The success signal is:
    //                              posterReady=true + posterEngaged=true while
    //                              the decode-miss timing collapses to ~0.
    // Decoder context reads are guarded by the compositor mutex — the same lock
    // the video-thread decode loop holds — so we never iterate the contexts_ map
    // while it is being mutated.
    if (g_timeline) {
        std::vector<RenderVideoDecoder::OpenSourceInfo> openInfos;
        if (g_previewRenderDecoder) {
            std::lock_guard<std::mutex> compLock(g_previewCompositorMutex);
            openInfos = g_previewRenderDecoder->openSourceInfos();
        }
        auto decodePathName = [](RenderVideoDecoder::DecodePath p) -> const char* {
            switch (p) {
                case RenderVideoDecoder::DecodePath::Hardware: return "hardware";
                case RenderVideoDecoder::DecodePath::Software: return "software";
                default:                                       return "none";
            }
        };
        auto findOpen = [&](const std::string& path)
            -> const RenderVideoDecoder::OpenSourceInfo* {
            if (path.empty()) return nullptr;
            for (const auto& oi : openInfos)
                if (oi.sourcePath == path) return &oi;
            return nullptr;
        };

        const auto& sources = g_timeline->getAllSources();
        JsonApi::Array srcArr = JsonApi::Array::New(env, sources.size());
        uint32_t idx = 0;
        for (const SourceMedia* src : sources) {
            JsonApi::Object so = JsonApi::Object::New(env);
            so.Set("sourceId",    JsonApi::Number::New(env, src->id));
            so.Set("fileName",    JsonApi::String::New(env, src->fileName));
            so.Set("hasVideo",    JsonApi::Boolean::New(env, src->hasVideo));
            so.Set("width",       JsonApi::Number::New(env, src->width));
            so.Set("height",      JsonApi::Number::New(env, src->height));
            so.Set("posterReady", JsonApi::Boolean::New(env, src->posterReady));
            so.Set("posterPath",  JsonApi::String::New(env, src->posterPath));
            so.Set("proxyReady",  JsonApi::Boolean::New(env, src->proxyReady));
            so.Set("proxyPath",   JsonApi::String::New(env, src->proxyPath));

            // Whole-source preview proxy: ready/path/height plus live build state
            // (building flag + 0..1 progress) so the UI can show a progress
            // indicator while the one-time transcode runs and switch to "ready"
            // once live preview reads from the proxy.
            so.Set("previewProxyReady",  JsonApi::Boolean::New(env, src->previewProxyReady));
            so.Set("previewProxyPath",   JsonApi::String::New(env, src->previewProxyPath));
            so.Set("previewProxyHeight", JsonApi::Number::New(env, src->previewProxyHeight));
            {
                ProxyManager::SourcePreviewStatus ps =
                    g_proxyManager ? g_proxyManager->sourcePreviewStatus(src->id)
                                   : ProxyManager::SourcePreviewStatus{};
                so.Set("previewProxyBuilding", JsonApi::Boolean::New(env, ps.building));
                so.Set("previewProxyProgress", JsonApi::Number::New(env, ps.progress));
            }
            // The proxy is what's actually open once engaged — report its decode
            // path too so a diagnostic can confirm live preview is on the small
            // intra proxy, not the 4K original.
            const auto* previewProxyOpen = findOpen(src->previewProxyPath);

            // Prefer the preview-proxy context if it's open (live preview reading
            // the small intra proxy — the success case); then the poster context
            // (poster mode engaged while the proxy builds); otherwise report how
            // the original source is being decoded right now.
            const auto* posterOpen = findOpen(src->posterPath);
            const auto* origOpen   = findOpen(src->filePath);
            const RenderVideoDecoder::OpenSourceInfo* shown =
                previewProxyOpen ? previewProxyOpen
                                 : (posterOpen ? posterOpen : origOpen);
            so.Set("decodePath",
                   JsonApi::String::New(env, decodePathName(
                       shown ? shown->path : RenderVideoDecoder::DecodePath::None)));
            so.Set("decodeIntraOnly",
                   JsonApi::Boolean::New(env, shown ? shown->intraOnly : false));
            so.Set("decodeOpenPath",
                   JsonApi::String::New(env, shown ? shown->sourcePath : std::string{}));
            so.Set("posterEngaged",
                   JsonApi::Boolean::New(env, posterOpen != nullptr));
            srcArr.Set(idx++, so);
        }
        o.Set("activeSources", srcArr);
        o.Set("posterModeActive", JsonApi::Boolean::New(env, g_previewPosterMode));
        o.Set("previewProxyTargetHeight",
              JsonApi::Number::New(env, g_previewProxyTargetHeight));
    }

    // ── Pixel-content verification (opt-in: XLETH_VISUAL_DIAG_PIXELS=1) ───────
    // Per-stage content fingerprints recorded by the native pipeline. Renderer
    // stages (renderer-pre-webgl-upload / renderer-post-webgl-readpixels) are
    // collected JS-side and merged by the report builder, not here.
    {
        auto statsToObj = [&](const xleth::visualdiag::FramePixelStats& s) {
            JsonApi::Object so = JsonApi::Object::New(env);
            so.Set("observed",      JsonApi::Boolean::New(env, s.observed));
            so.Set("format",        JsonApi::String::New(env,
                                        xleth::visualdiag::pixelFormatName(s.format)));
            so.Set("width",         JsonApi::Number::New(env, s.width));
            so.Set("height",        JsonApi::Number::New(env, s.height));
            so.Set("rowPitch",      JsonApi::Number::New(env, s.rowPitch));
            so.Set("byteCount",     JsonApi::Number::New(env, static_cast<double>(s.byteCount)));
            // checksum as string — avoids JS Number precision worries at scale.
            so.Set("checksum64",    JsonApi::String::New(env, std::to_string(s.checksum64)));
            so.Set("nonZeroBytes",  JsonApi::Number::New(env, static_cast<double>(s.nonZeroBytes)));
            so.Set("nonZeroPixels", JsonApi::Number::New(env, static_cast<double>(s.nonZeroPixels)));
            so.Set("averageLuma",   JsonApi::Number::New(env, s.averageLuma));
            so.Set("first16Bytes",  JsonApi::String::New(env, xleth::visualdiag::first16Hex(s)));
            JsonApi::Array cp = JsonApi::Array::New(env, 4);
            for (uint32_t i = 0; i < 4; ++i)
                cp.Set(i, JsonApi::Number::New(env, s.centerPixel[i]));
            so.Set("centerPixel", cp);
            JsonApi::Array corners = JsonApi::Array::New(env, 4);
            for (uint32_t c = 0; c < 4; ++c) {
                JsonApi::Array one = JsonApi::Array::New(env, 4);
                for (uint32_t i = 0; i < 4; ++i)
                    one.Set(i, JsonApi::Number::New(env, s.corners[c][i]));
                corners.Set(c, one);
            }
            so.Set("corners",    corners);
            so.Set("frameIndex", JsonApi::Number::New(env, static_cast<double>(s.frameIndex)));
            so.Set("tickIndex",  JsonApi::Number::New(env, static_cast<double>(s.tickIndex)));
            so.Set("timestamp",  JsonApi::Number::New(env, s.timestamp));
            return so;
        };

        auto snaps = xleth::visualdiag::snapshotAll();
        JsonApi::Array pixelStatsArr = JsonApi::Array::New(env, snaps.size());
        for (size_t i = 0; i < snaps.size(); ++i) {
            const auto& sn = snaps[i];
            JsonApi::Object row = JsonApi::Object::New(env);
            row.Set("stage",       JsonApi::String::New(env, sn.stage));
            row.Set("observed",    JsonApi::Boolean::New(env, sn.observed));
            row.Set("sampleCount", JsonApi::Number::New(env, static_cast<double>(sn.sampleCount)));
            row.Set("dumpCount",   JsonApi::Number::New(env, static_cast<double>(sn.dumpCount)));
            row.Set("first",  statsToObj(sn.first));
            row.Set("latest", statsToObj(sn.latest));
            pixelStatsArr.Set(static_cast<uint32_t>(i), row);
        }
        o.Set("pixelStats", pixelStatsArr);

        JsonApi::Object flags = JsonApi::Object::New(env);
        flags.Set("pixelsEnabled",
                  JsonApi::Boolean::New(env, xleth::visualdiag::pixelsEnabled()));
        flags.Set("dumpFramesEnabled",
                  JsonApi::Boolean::New(env, xleth::visualdiag::dumpFramesEnabled()));
        flags.Set("maxDumpFramesPerStage",
                  JsonApi::Number::New(env, xleth::visualdiag::maxDumpFramesPerStage()));
        flags.Set("dumpSessionDir",
                  JsonApi::String::New(env, xleth::visualdiag::dumpSessionDir()));
        o.Set("visualDiagFlags", flags);
    }

    return o;
}

// gpu_setAdapter(index) → {success, name, vramMB}
JsonApi::Value Gpu_SetAdapter(const JsonApi::CallbackInfo& info)
{
    JsonApi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsNumber()) {
        JsonApi::TypeError::New(env, "gpu_setAdapter(index: number)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }

    int index = info[0].As<JsonApi::Number>().Int32Value();
    BridgeCallLog log("gpu.setAdapter");

    std::fprintf(stderr, "[GpuDevice] host bridge setGpuAdapter: switching to adapter %d, recreating device...\n",
                 index);

    if (!g_gpuDevice) {
        g_gpuDevice = std::make_unique<GpuDeviceManager>();
        if (!g_gpuDevice->detectAdapters()) {
            JsonApi::Error::New(env, "Failed to enumerate DXGI adapters").ThrowAsJavaScriptException();
            return env.Undefined();
        }
    }

    bool ok = g_gpuDevice->createDevice(index);

    JsonApi::Object o = JsonApi::Object::New(env);
    o.Set("success", JsonApi::Boolean::New(env, ok));

    if (ok) {
        // Find adapter info for response
        for (const auto& a : g_gpuDevice->getAdapters()) {
            if (a.adapterIndex == g_gpuDevice->getActiveAdapterIndex()) {
                std::string nameUtf8;
                nameUtf8.reserve(a.name.size());
                for (wchar_t wc : a.name)
                    nameUtf8.push_back(static_cast<char>(wc & 0x7F));
                o.Set("name",   JsonApi::String::New(env, nameUtf8));
                o.Set("vramMB", JsonApi::Number::New(env, static_cast<double>(a.dedicatedVideoMemoryMB)));
                break;
            }
        }
    }

    log.done(ok ? "ok" : "failed");
    return o;
}

// ─────────────────────────────────────────────────────────────────────────────
// Hardware encoder detection (NVENC, AMF, QSV, software fallbacks)
// ─────────────────────────────────────────────────────────────────────────────

/** Map a JS codec string to AVCodecID using the engine's HwEncoderDetector. */
static int codecNameToId(const std::string& name)
{
    return HwEncoderDetector::codecNameToId(name.c_str());
}

/** Lazy-init the detector — runs detection on first call. */
static HwEncoderDetector& ensureDetector()
{
    if (!g_hwEncoderDetector) {
        g_hwEncoderDetector = std::make_unique<HwEncoderDetector>();
        // Correlate with GPU vendor if device manager is available
        if (g_gpuDevice && g_gpuDevice->getActiveAdapterIndex() >= 0) {
            for (const auto& a : g_gpuDevice->getAdapters()) {
                if (a.adapterIndex == g_gpuDevice->getActiveAdapterIndex()) {
                    g_hwEncoderDetector->setGpuVendorId(a.vendorId);
                    break;
                }
            }
        }
        g_hwEncoderDetector->detect();
    }
    return *g_hwEncoderDetector;
}

// hwenc_getAvailableEncoders(codec: string) → [{name, displayName, isHardware, isAvailable}]
JsonApi::Value HwEnc_GetAvailableEncoders(const JsonApi::CallbackInfo& info)
{
    JsonApi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsString()) {
        JsonApi::TypeError::New(env, "hwenc_getAvailableEncoders(codec: string) — "
                             "codec is one of: h264, hevc, av1, mpeg4, dnxhd, prores, aac")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }

    std::string codecStr = info[0].As<JsonApi::String>().Utf8Value();
    int codecId = codecNameToId(codecStr);
    if (codecId < 0) {
        JsonApi::TypeError::New(env, "Unknown codec: " + codecStr).ThrowAsJavaScriptException();
        return env.Undefined();
    }

    auto& detector = ensureDetector();
    auto encoders = detector.getAvailableEncoders(codecId);

    JsonApi::Array arr = JsonApi::Array::New(env, encoders.size());
    for (size_t i = 0; i < encoders.size(); ++i) {
        const auto& e = encoders[i];
        JsonApi::Object o = JsonApi::Object::New(env);
        o.Set("name",        JsonApi::String::New(env, e.name));
        o.Set("displayName", JsonApi::String::New(env, e.displayName));
        o.Set("isHardware",  JsonApi::Boolean::New(env, e.isHardware));
        o.Set("isAvailable", JsonApi::Boolean::New(env, e.isAvailable));
        arr.Set(static_cast<uint32_t>(i), o);
    }

    return arr;
}

// hwenc_getDefaultEncoder(codec: string) → string (encoder name)
JsonApi::Value HwEnc_GetDefaultEncoder(const JsonApi::CallbackInfo& info)
{
    JsonApi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsString()) {
        JsonApi::TypeError::New(env, "hwenc_getDefaultEncoder(codec: string)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }

    std::string codecStr = info[0].As<JsonApi::String>().Utf8Value();
    int codecId = codecNameToId(codecStr);
    if (codecId < 0) {
        JsonApi::TypeError::New(env, "Unknown codec: " + codecStr).ThrowAsJavaScriptException();
        return env.Undefined();
    }

    auto& detector = ensureDetector();
    return JsonApi::String::New(env, detector.getDefaultEncoder(codecId));
}

// hwenc_refresh() → void — re-detect all encoders (e.g. after GPU change)
JsonApi::Value HwEnc_Refresh(const JsonApi::CallbackInfo& info)
{
    JsonApi::Env env = info.Env();
    if (g_hwEncoderDetector) {
        // Update vendor preference if GPU changed
        if (g_gpuDevice && g_gpuDevice->getActiveAdapterIndex() >= 0) {
            for (const auto& a : g_gpuDevice->getAdapters()) {
                if (a.adapterIndex == g_gpuDevice->getActiveAdapterIndex()) {
                    g_hwEncoderDetector->setGpuVendorId(a.vendorId);
                    break;
                }
            }
        }
        g_hwEncoderDetector->refresh();
    } else {
        ensureDetector();
    }
    return env.Undefined();
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 7 — Preview visibility (panel show/hide)
// ─────────────────────────────────────────────────────────────────────────────

// preview_setEnabled(enabled: boolean) → undefined
//   enabled=true  ⇒ panel visible, GPU compositor runs
//   enabled=false ⇒ panel hidden, compositor pauses (one black frame, then idle)
// Independent of g_previewPauseForExport — render path resumes only when BOTH
// flags are clear.
JsonApi::Value Preview_SetEnabled(const JsonApi::CallbackInfo& info)
{
    JsonApi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsBoolean()) {
        JsonApi::TypeError::New(env, "preview_setEnabled(enabled: boolean)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }
    const bool enabled = info[0].As<JsonApi::Boolean>().Value();
    g_previewPauseForVisibility.store(!enabled);
    return env.Undefined();
}

