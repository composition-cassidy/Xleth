// XlethSvcEqWs.h — EQ / Waveshaper / SmartBalance host bridge bindings
// domain handler declarations (S2 Stage 6).
//
// INTERNAL header (engine/src/service/, NOT engine/include/). Declares the
// fifteen audio_* handlers so XlethEngineService.cpp's dispatch() can still
// call them after the definitions moved to XlethSvcEqWs.cpp. Verbatim move,
// no behavior change — see docs/S2_SPLIT_PLAN.md §4 Stage 6.

#pragma once

#include "XlethServiceJsonApi.h"

// EQ
JsonApi::Value Audio_EQ_AddBand(const JsonApi::CallbackInfo& info);
JsonApi::Value Audio_EQ_RemoveBand(const JsonApi::CallbackInfo& info);
JsonApi::Value Audio_EQ_SetBandParam(const JsonApi::CallbackInfo& info);
JsonApi::Value Audio_EQ_GetResponseCurve(const JsonApi::CallbackInfo& info);
JsonApi::Value Audio_EQ_GetSpectrumData(const JsonApi::CallbackInfo& info);
JsonApi::Value Audio_EQ_SetPreSpectrum(const JsonApi::CallbackInfo& info);
JsonApi::Value Audio_EQ_GetBands(const JsonApi::CallbackInfo& info);
JsonApi::Value Audio_EQ_GetBandGR(const JsonApi::CallbackInfo& info);
JsonApi::Value Audio_EQ_SetGlobalParam(const JsonApi::CallbackInfo& info);
JsonApi::Value Audio_EQ_GetGlobalParams(const JsonApi::CallbackInfo& info);
JsonApi::Value Audio_EQ_GetSampleRate(const JsonApi::CallbackInfo& info);

// Waveshaper
JsonApi::Value Audio_WS_GetCurvePoints(const JsonApi::CallbackInfo& info);
JsonApi::Value Audio_WS_SetCurvePoints(const JsonApi::CallbackInfo& info);
JsonApi::Value Audio_WS_SetPreset(const JsonApi::CallbackInfo& info);

// SmartBalance
JsonApi::Value Audio_SmartBalance_GetDebug(const JsonApi::CallbackInfo& info);
