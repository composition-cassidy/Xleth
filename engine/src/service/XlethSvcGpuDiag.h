// XlethSvcGpuDiag.h — GPU device / visual-preview diagnostics / hardware
// encoder detection / preview-visibility domain handler declarations
// (S2 Stage 3).
//
// INTERNAL header (engine/src/service/, NOT engine/include/). Declares the
// seven handlers so XlethEngineService.cpp's dispatch() can still call them
// after the definitions moved to XlethSvcGpuDiag.cpp. Verbatim move, no
// behavior change — see docs/S2_SPLIT_PLAN.md §4 Stage 3.

#pragma once

#include "XlethServiceJsonApi.h"

JsonApi::Value Gpu_GetAvailableGpus(const JsonApi::CallbackInfo& info);
JsonApi::Value Diag_GetVisualPreviewDiagnostic(const JsonApi::CallbackInfo& info);
JsonApi::Value Gpu_SetAdapter(const JsonApi::CallbackInfo& info);
JsonApi::Value HwEnc_GetAvailableEncoders(const JsonApi::CallbackInfo& info);
JsonApi::Value HwEnc_GetDefaultEncoder(const JsonApi::CallbackInfo& info);
JsonApi::Value HwEnc_Refresh(const JsonApi::CallbackInfo& info);
JsonApi::Value Preview_SetEnabled(const JsonApi::CallbackInfo& info);
