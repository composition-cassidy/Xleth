// XlethSvcMidi.h — MIDI Import domain handler declarations (S2 Stage 2).
//
// INTERNAL header (engine/src/service/, NOT engine/include/). Declares the
// three midi_* handlers so XlethEngineService.cpp's dispatch() can still call
// them after the definitions moved to XlethSvcMidi.cpp. Verbatim move, no
// behavior change — see docs/S2_SPLIT_PLAN.md §4 Stage 2.

#pragma once

#include "XlethServiceJsonApi.h"

JsonApi::Value Midi_ParseSummary(const JsonApi::CallbackInfo& info);
JsonApi::Value Midi_ImportFull(const JsonApi::CallbackInfo& info);
void           Midi_ExecuteImport(const JsonApi::CallbackInfo& info);
