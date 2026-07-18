// XlethSvcVst3.cpp — VST3 plugin scanner / editor-window / missing-plugin
// domain handlers (S2 Stage 5).
//
// Verbatim move of the audio_scanPlugins/getScanProgress/getScannedPlugins/
// getFailedPlugins/setMainWindowHandle, audio_open/close/closeAll/isPlugin
// EditorOpen, and audio_getMissingPlugins/retryMissingPlugin/removeAllMissing/
// resetCrashedPlugin handlers out of XlethEngineService.cpp (was lines
// 12264-12553 at branch base e81e099). No behavior change — see
// docs/S2_SPLIT_PLAN.md §4 Stage 5. dispatch() (still in
// XlethEngineService.cpp) resolves these via XlethSvcVst3.h.
//
// getThisModuleDir() is used below (for the scanner exe path) but its
// definition stays in XlethEngineService.cpp, since Lifecycle's Initialize()
// also calls it directly; declared (external linkage) in XlethSvcHelpers.h.

// audio/PluginRegistry.h (juce_audio_processors) must be included before any
// header that pulls in juce_gui_extra (e.g. XlethSvcGlobals.h -> render/
// GridCompositor.h) -- matching XlethEngineService.cpp's own include order
// (PluginRegistry.h at line 54, GridCompositor.h at line 62). Reversing this
// order breaks JUCE's amalgamated module parsing (juce_PushNotifications.h).
#include "audio/PluginRegistry.h"  // MixEngine.h only forward-declares this

#include "service/XlethSvcGlobals.h"
using namespace xleth::svc;
#include "service/XlethSvcShared.h"
#include "service/XlethSvcHelpers.h"
#include "service/XlethSvcVst3.h"

#include <cstdint>
#include <cstdio>
#include <string>

// audio_scanPlugins(paths: string[]) → void
// Replaces the search path list and starts an async background scan.
// If paths is empty or omitted, the scan is skipped.
JsonApi::Value Audio_ScanPlugins(const JsonApi::CallbackInfo& info)
{
    JsonApi::Env env = info.Env();
    if (!isInitialised() || !audioEngine) {
        JsonApi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    auto& registry = audioEngine->getMixEngine().getPluginRegistry();

    // Replace (not append) the search path list with the caller-supplied paths.
    registry.clearSearchPaths();
    if (info.Length() >= 1 && info[0].IsArray()) {
        const auto arr = info[0].As<JsonApi::Array>();
        for (uint32_t i = 0; i < arr.Length(); ++i) {
            if (arr.Get(i).IsString())
                registry.addSearchPath(
                    juce::String(arr.Get(i).As<JsonApi::String>().Utf8Value()));
        }
    }

    // No paths → no-op. scanPlugins() has the same guard internally,
    // but returning early here avoids launching the scanner exe at all.
    if (registry.getSearchPaths().isEmpty())
        return env.Undefined();

    const juce::File scannerExe =
        getThisModuleDir().getChildFile("xleth-plugin-scanner.exe");
    registry.scanPlugins(scannerExe);
    return env.Undefined();
}

// audio_getScanProgress() → { scanning: bool, scanned: number, total: number, failedCount: number }
JsonApi::Value Audio_GetScanProgress(const JsonApi::CallbackInfo& info)
{
    IPC_TIME_START;
    IPC_GAP_CHECK("audio_getScanProgress");
    JsonApi::Env env = info.Env();
    if (!isInitialised() || !audioEngine) {
        JsonApi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    const auto& reg = audioEngine->getMixEngine().getPluginRegistry();
    auto obj = JsonApi::Object::New(env);
    obj.Set("scanning",    JsonApi::Boolean::New(env, reg.isScanning()));
    obj.Set("scanned",     JsonApi::Number::New(env,  reg.getScannedCount()));
    obj.Set("total",       JsonApi::Number::New(env,  reg.getTotalCount()));
    obj.Set("failedCount", JsonApi::Number::New(env,  (int)reg.getFailedPlugins().size()));
    IPC_TIME_END("audio_getScanProgress");
    return obj;
}

// audio_getScannedPlugins() → JSON string (array of plugin descriptors)
JsonApi::Value Audio_GetScannedPlugins(const JsonApi::CallbackInfo& info)
{
    JsonApi::Env env = info.Env();
    if (!isInitialised() || !audioEngine) {
        JsonApi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    const juce::String json =
        audioEngine->getMixEngine().getPluginRegistry().getPluginListAsJSON();
    return JsonApi::String::New(env, json.toStdString());
}

// audio_getFailedPlugins() → JSON string (array of { filePath: string })
JsonApi::Value Audio_GetFailedPlugins(const JsonApi::CallbackInfo& info)
{
    JsonApi::Env env = info.Env();
    if (!isInitialised() || !audioEngine) {
        JsonApi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    const auto failed = audioEngine->getMixEngine().getPluginRegistry().getFailedPlugins();
    juce::String json = "[";
    for (int i = 0; i < failed.size(); ++i) {
        if (i > 0) json += ",";
        const auto esc = failed[i].replace("\\", "\\\\").replace("\"", "\\\"");
        json += "{\"filePath\":\"" + esc + "\"}";
    }
    json += "]";
    return JsonApi::String::New(env, json.toStdString());
}

// audio_setMainWindowHandle(hwndHex: string) → void
// Called once from main.js after the BrowserWindow is created.
JsonApi::Value Audio_SetMainWindowHandle(const JsonApi::CallbackInfo& info)
{
    JsonApi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsString())
    {
        JsonApi::TypeError::New(env, "audio_setMainWindowHandle(hwndHex: string)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }

    const std::string hexStr = info[0].As<JsonApi::String>().Utf8Value();
    uintptr_t hwnd = 0;
    try { hwnd = (uintptr_t)std::stoull(hexStr, nullptr, 16); } catch (...) {}

#ifdef _WIN32
    g_mainXlethHwnd.store(hwnd);
#endif

    std::fprintf(stderr, "[HWND] Main window handle: 0x%llX\n",
                 (unsigned long long)hwnd);

    if (audioEngine && hwnd != 0)
        audioEngine->getMixEngine().setMainWindowHandle(hwnd);

    return env.Undefined();
}

// ── Plugin editor windows ─────────────────────────────────────────────────────

// audio_openPluginEditor(trackId, nodeId) → { hasEditor: boolean }
// trackId = -1 for master chain.
// hasEditor = true if the editor window was opened (or was already open),
//             false if the plugin has no GUI.
JsonApi::Value Audio_OpenPluginEditor(const JsonApi::CallbackInfo& info)
{
    JsonApi::Env env = info.Env();
    if (!isInitialised() || !audioEngine) {
        JsonApi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsNumber()) {
        JsonApi::TypeError::New(env, "audio_openPluginEditor(trackId: number, nodeId: number)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }
    const int trackId = info[0].As<JsonApi::Number>().Int32Value();
    const int nodeId  = info[1].As<JsonApi::Number>().Int32Value();
    BridgeCallLog log("audio.openPluginEditor");

    const bool opened = audioEngine->getMixEngine().openPluginEditor(trackId, nodeId);

    JsonApi::Object result = JsonApi::Object::New(env);
    result.Set("hasEditor", JsonApi::Boolean::New(env, opened));
    log.done(std::to_string(trackId) + " node=" + std::to_string(nodeId)
             + " hasEditor=" + (opened ? "true" : "false"));
    return result;
}

// audio_closePluginEditor(trackId, nodeId) → boolean
JsonApi::Value Audio_ClosePluginEditor(const JsonApi::CallbackInfo& info)
{
    JsonApi::Env env = info.Env();
    if (!isInitialised() || !audioEngine) {
        JsonApi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsNumber()) {
        JsonApi::TypeError::New(env, "audio_closePluginEditor(trackId: number, nodeId: number)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }
    const int trackId = info[0].As<JsonApi::Number>().Int32Value();
    const int nodeId  = info[1].As<JsonApi::Number>().Int32Value();
    BridgeCallLog log("audio.closePluginEditor");

    const bool wasOpen = audioEngine->getMixEngine().isPluginEditorOpen(trackId, nodeId);
    audioEngine->getMixEngine().closePluginEditor(trackId, nodeId);
    log.done(std::to_string(trackId) + " node=" + std::to_string(nodeId));
    return JsonApi::Boolean::New(env, wasOpen);
}

// audio_closeAllPluginEditors() → void
JsonApi::Value Audio_CloseAllPluginEditors(const JsonApi::CallbackInfo& info)
{
    JsonApi::Env env = info.Env();
    if (!isInitialised() || !audioEngine) {
        JsonApi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    BridgeCallLog log("audio.closeAllPluginEditors");
    audioEngine->getMixEngine().closeAllPluginEditors();
    log.done();
    return env.Undefined();
}

// audio_isPluginEditorOpen(trackId, nodeId) → boolean
JsonApi::Value Audio_IsPluginEditorOpen(const JsonApi::CallbackInfo& info)
{
    JsonApi::Env env = info.Env();
    if (!isInitialised() || !audioEngine) {
        JsonApi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsNumber()) {
        JsonApi::TypeError::New(env, "audio_isPluginEditorOpen(trackId: number, nodeId: number)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }
    const int trackId = info[0].As<JsonApi::Number>().Int32Value();
    const int nodeId  = info[1].As<JsonApi::Number>().Int32Value();
    return JsonApi::Boolean::New(env,
        audioEngine->getMixEngine().isPluginEditorOpen(trackId, nodeId));
}

// ── Missing-plugin helpers ────────────────────────────────────────────────────

// audio_getMissingPlugins() → JSON string
// Returns array of { trackId, nodeId, pluginId, pluginName, pluginVendor, filePath }.
// trackId == -1 means master chain.
// Enrichment (pluginName/pluginVendor/filePath) is done in MixEngine::getMissingPluginsJSON().
JsonApi::Value Audio_GetMissingPlugins(const JsonApi::CallbackInfo& info)
{
    JsonApi::Env env = info.Env();
    if (!isInitialised() || !audioEngine) {
        JsonApi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    BridgeCallLog log("audio.getMissingPlugins");
    const std::string json = audioEngine->getMixEngine().getMissingPluginsJSON();
    log.done();
    return JsonApi::String::New(env, json);
}

// audio_retryMissingPlugin(trackId: number, nodeId: number) → { success: boolean }
JsonApi::Value Audio_RetryMissingPlugin(const JsonApi::CallbackInfo& info)
{
    JsonApi::Env env = info.Env();
    if (!isInitialised() || !audioEngine) {
        JsonApi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsNumber()) {
        JsonApi::TypeError::New(env, "audio_retryMissingPlugin(trackId: number, nodeId: number)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }
    const int trackId = info[0].As<JsonApi::Number>().Int32Value();
    const int nodeId  = info[1].As<JsonApi::Number>().Int32Value();
    BridgeCallLog log("audio.retryMissingPlugin");

    const bool ok = audioEngine->getMixEngine().tryResolvePlugin(trackId, nodeId);

    JsonApi::Object result = JsonApi::Object::New(env);
    result.Set("success", JsonApi::Boolean::New(env, ok));
    log.done("trackId=" + std::to_string(trackId) + " nodeId=" + std::to_string(nodeId)
             + " success=" + (ok ? "true" : "false"));
    return result;
}

// audio_removeAllMissing() → void
JsonApi::Value Audio_RemoveAllMissing(const JsonApi::CallbackInfo& info)
{
    JsonApi::Env env = info.Env();
    if (!isInitialised() || !audioEngine) {
        JsonApi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    BridgeCallLog log("audio.removeAllMissing");
    audioEngine->getMixEngine().removeAllMissingPlugins();
    log.done();
    return env.Undefined();
}

// audio_resetCrashedPlugin(trackId, nodeId) → boolean
// Attempts to recover a VST node that crashed inside processBlock.
// Returns true if the plugin is healthy again, false if it still faults.
JsonApi::Value Audio_ResetCrashedPlugin(const JsonApi::CallbackInfo& info)
{
    JsonApi::Env env = info.Env();
    if (!isInitialised() || !audioEngine) {
        JsonApi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsNumber()) {
        JsonApi::TypeError::New(env, "audio_resetCrashedPlugin(trackId: number, nodeId: number)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }
    const int trackId = info[0].As<JsonApi::Number>().Int32Value();
    const int nodeId  = info[1].As<JsonApi::Number>().Int32Value();
    BridgeCallLog log("audio.resetCrashedPlugin");

    // Close any open editor first — if the plugin crashed, the editor may hold
    // dangling pointers into crashed state.  Reopening happens lazily on demand.
    audioEngine->getMixEngine().closePluginEditor(trackId, nodeId);

    const bool ok = audioEngine->getMixEngine().resetCrashedPlugin(trackId, nodeId);
    log.done("trackId=" + std::to_string(trackId) + " nodeId=" + std::to_string(nodeId)
             + " success=" + (ok ? "true" : "false"));
    return JsonApi::Boolean::New(env, ok);
}
