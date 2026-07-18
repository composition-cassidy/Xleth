// XlethSvcHelpers.h — cross-domain helper declarations (S2 Stage 2+).
//
// INTERNAL header (engine/src/service/, NOT engine/include/). Declares small
// helpers whose single DEFINITION stays in XlethEngineService.cpp (per
// docs/S2_SPLIT_PLAN.md §5) but which later-stage domain TUs need to call.
// Grows one stage at a time; each entry names the stage that first needed it.
//
// Promoting these from `static` (internal linkage) to external linkage is a
// linkage change only — no behavior change. The definitions do not move here.

#pragma once

#include <string>

// S2 Stage 2 (MIDI import): re-syncs mixer track slots after the undo-managed
// ImportMidiCommand mutates the timeline. Definition stays in
// XlethEngineService.cpp (was `static`, line ~567).
void syncMixerTrackSlots(bool snapVolumeSmoothers = false);

// S2 Stage 2 (MIDI import): kicks off background waveform mipmap generation
// for a newly-loaded sample slot. Definition stays in XlethEngineService.cpp
// (was `static`, line ~3837).
void triggerMipmapGeneration(int sampleBankId,
                              const std::string& sourcePath,
                              bool saveXlpeak);
