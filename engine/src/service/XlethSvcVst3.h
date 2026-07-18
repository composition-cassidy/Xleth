// XlethSvcVst3.h — VST3 plugin scanner / editor-window / missing-plugin domain
// handler declarations (S2 Stage 5).
//
// INTERNAL header (engine/src/service/, NOT engine/include/). Declares the
// thirteen audio_* handlers so XlethEngineService.cpp's dispatch() can still
// call them after the definitions moved to XlethSvcVst3.cpp. Verbatim move,
// no behavior change — see docs/S2_SPLIT_PLAN.md §4 Stage 5.

#pragma once

#include "XlethServiceJsonApi.h"

// VST3 plugin scanner
JsonApi::Value Audio_ScanPlugins(const JsonApi::CallbackInfo& info);
JsonApi::Value Audio_GetScanProgress(const JsonApi::CallbackInfo& info);
JsonApi::Value Audio_GetScannedPlugins(const JsonApi::CallbackInfo& info);
JsonApi::Value Audio_GetFailedPlugins(const JsonApi::CallbackInfo& info);
JsonApi::Value Audio_SetMainWindowHandle(const JsonApi::CallbackInfo& info);

// Plugin editor windows
JsonApi::Value Audio_OpenPluginEditor(const JsonApi::CallbackInfo& info);
JsonApi::Value Audio_ClosePluginEditor(const JsonApi::CallbackInfo& info);
JsonApi::Value Audio_CloseAllPluginEditors(const JsonApi::CallbackInfo& info);
JsonApi::Value Audio_IsPluginEditorOpen(const JsonApi::CallbackInfo& info);

// Missing-plugin helpers
JsonApi::Value Audio_GetMissingPlugins(const JsonApi::CallbackInfo& info);
JsonApi::Value Audio_RetryMissingPlugin(const JsonApi::CallbackInfo& info);
JsonApi::Value Audio_RemoveAllMissing(const JsonApi::CallbackInfo& info);
JsonApi::Value Audio_ResetCrashedPlugin(const JsonApi::CallbackInfo& info);
