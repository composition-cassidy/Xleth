// XlethSvcWaveform.h — Waveform mipmap domain handler declarations (S2 Stage 4).
//
// INTERNAL header (engine/src/service/, NOT engine/include/). Declares the
// four waveform_* handlers so XlethEngineService.cpp's dispatch() can still
// call them after the definitions moved to XlethSvcWaveform.cpp. Verbatim
// move, no behavior change — see docs/S2_SPLIT_PLAN.md §4 Stage 4.

#pragma once

#include "XlethServiceJsonApi.h"

JsonApi::Value Waveform_GetRegionPeaks(const JsonApi::CallbackInfo& info);
JsonApi::Value Waveform_GetRawSamples(const JsonApi::CallbackInfo& info);
JsonApi::Value Waveform_GetClipPeaks(const JsonApi::CallbackInfo& info);
JsonApi::Value Waveform_GetFilePeaks(const JsonApi::CallbackInfo& info);
