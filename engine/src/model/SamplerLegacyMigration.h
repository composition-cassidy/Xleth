#pragma once

#include "SamplerModulationConfig.h"

#include <nlohmann/json.hpp>

// ─── Legacy sampler modulation → ModConfig migration ─────────────────────────
// Schema 3 and earlier stored sampler modulation as four hardcoded systems:
// an amplitude DAHDSR, a pitch envelope, and three drawable LFOs (volume, pan,
// pitch). Schema 4 replaces all of that with the general 6×ENV / 6×LFO / VELO /
// NOTE source bank plus a route list.
//
// This module is the one-way bridge. It reads the LEGACY JSON KEYS directly
// rather than the SampleRegion struct, which is what lets the struct fields be
// deleted in the same change: an old project file still carries the keys, and
// nothing else needs to keep a parallel copy of them alive.
//
// ── What maps to what ────────────────────────────────────────────────────────
//   amp DAHDSR   → ENV 1 (envs[0]).  NOT a route. See the note below.
//   pitch env    → ENV 2 (envs[1])  → SlotSem on every occupied slot
//   VOL   LFO    → LFO 1 (lfos[0])  → MasterVolume, bipolar
//   PAN   LFO    → LFO 2 (lfos[1])  → MasterPan,    bipolar
//   PITCH LFO    → LFO 3 (lfos[2])  → SlotSem on every occupied slot, bipolar
//
// ── Why the amp envelope is not a route ──────────────────────────────────────
// The amplitude envelope is not a modulation source that happens to target
// volume: it is the voice's amplitude contour AND its lifecycle gate — the
// render loop frees a voice when its envelope reaches Off. MasterVolume is an
// ADDITIVE target with a base of 1.0, so "ENV 1 → MasterVolume" would leave a
// silent envelope sounding at unity gain and would never free the voice.
//
// So ENV 1 *is* the amp envelope: envs[0] mirrors the DAHDSR the VCA already
// runs, which makes it visible and routable as a source in the new rack while
// the VCA keeps driving amplitude and lifecycle exactly as it always did. That
// is what makes a migrated project sound identical rather than merely similar.
//
// ── The one place migration is NOT bit-exact ─────────────────────────────────
// The legacy PAN LFO multiplied its own constant-power pan curve onto the
// slot's, and only the slot's was √2-normalised — so merely ENABLING it
// attenuated the voice by 3.01 dB at centre, and by a position-dependent
// amount elsewhere. MasterPan instead shifts the pan POSITION and normalises
// once, which is the musically intended behaviour. A migrated project that had
// the PAN LFO enabled therefore plays 3.01 dB LOUDER at centre than the legacy
// render did. The error was position-dependent, so no static gain trim can
// reproduce it; migrating the defect into the new system would be worse than
// correcting it. Every other mapping above is exact — see the unit tests.

namespace xleth::samplegacy {

// Nearest NoteValue index (never Off) for a length expressed in beats.
int nearestNoteValue(double beats) noexcept;

// Legacy LFO tempo divisions are a PERIOD of `division / 4` beats — the legacy
// rate formula was cycleHz = (bpm/60)·(4/division), whose reciprocal is
// (division/4)·(60/bpm) seconds. That makes the legacy UI labels backwards
// (its "eighth" ran at a half-note period), so migration preserves the
// division's ACTUAL behaviour rather than its label.
int noteValueForLegacyDivision(int division) noexcept;

// Migrate every legacy modulation system found in `j` into `cfg`.
//
// `occupiedSlots` is how many slots carry audio: the pitch envelope and the
// pitch LFO were note-level in the legacy engine, so they become one route per
// occupied slot to reproduce that.
//
// `bpm` is used only to approximate a synced LFO's RISE/DELAY, which the legacy
// engine always stored in milliseconds while the new model reads them through
// the LFO's own sync toggle. Both representations are written, so flipping sync
// off restores the exact millisecond value.
//
// Returns true when anything was migrated. Idempotent by construction: it is
// only called when the legacy keys are present and `cfg` carries no routes yet.
bool migrateLegacyModulation(const nlohmann::json& j,
                             int occupiedSlots,
                             double bpm,
                             xleth::sampmod::ModConfig& cfg);

// True when `j` carries any schema-3 sampler modulation keys at all.
bool hasLegacyModulation(const nlohmann::json& j) noexcept;

// Write an amplitude DAHDSR into ENV 1 (envs[0]) — its new home and the VCA's
// source of truth. Called only during legacy migration; a post-migration
// project persists envs[0] directly.
void syncAmpEnvelopeToEnv1(float delayMs, float attackMs, float holdMs,
                           float decayMs, float sustain, float releaseMs,
                           float attackTension, float decayTension,
                           float releaseTension,
                           xleth::sampmod::ModConfig& cfg) noexcept;

// Migrate a legacy amp envelope straight from the raw JSON keys ("attackMs",
// "delayMs", … "releaseTension") into ENV 1. Called when `j` still carries the
// legacy amp keys — i.e. a project saved before ENV 1 became the amp envelope.
void migrateLegacyAmpEnvelope(const nlohmann::json& j,
                              xleth::sampmod::ModConfig& cfg);

} // namespace xleth::samplegacy
