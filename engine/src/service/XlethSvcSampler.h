// XlethSvcSampler.h — Sampler / Auto Loop Optimizer domain handler declarations.
//
// INTERNAL header (engine/src/service/, NOT engine/include/). Declares
// sampler_analyzeLoop so XlethEngineService.cpp's dispatch() can call it.
// Follows the same TU-per-domain shape as the S2 Stage 2-6 splits.

#pragma once

#include "XlethServiceJsonApi.h"

JsonApi::Value Sampler_AnalyzeLoop(const JsonApi::CallbackInfo& info);
