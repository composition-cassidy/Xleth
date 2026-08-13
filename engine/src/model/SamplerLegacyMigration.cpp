#include "SamplerLegacyMigration.h"

#include <algorithm>
#include <cmath>
#include <string>
#include <vector>

namespace xleth::samplegacy {

namespace sm = xleth::sampmod;

namespace {

// ── Small JSON readers ───────────────────────────────────────────────────────
// Legacy files are hand-edited often enough that a wrong type must not throw
// out of a project load; every reader falls back to the caller's default.
float readFloat(const nlohmann::json& j, const char* key, float fallback)
{
    if (!j.contains(key)) return fallback;
    const auto& v = j.at(key);
    return v.is_number() ? v.get<float>() : fallback;
}

bool readBool(const nlohmann::json& j, const char* key, bool fallback)
{
    if (!j.contains(key)) return fallback;
    const auto& v = j.at(key);
    return v.is_boolean() ? v.get<bool>() : fallback;
}

int readInt(const nlohmann::json& j, const char* key, int fallback)
{
    if (!j.contains(key)) return fallback;
    const auto& v = j.at(key);
    return v.is_number() ? v.get<int>() : fallback;
}

struct LegacyPoint { float time; float value; };

std::vector<LegacyPoint> readWaveform(const nlohmann::json& j, const char* key)
{
    std::vector<LegacyPoint> out;
    if (!j.contains(key)) return out;
    const auto& arr = j.at(key);
    if (!arr.is_array()) return out;
    out.reserve(arr.size());
    for (const auto& e : arr) {
        if (!e.is_object()) continue;
        out.push_back(LegacyPoint{ readFloat(e, "time", 0.0f),
                                   readFloat(e, "value", 0.0f) });
    }
    return out;
}

// ── One legacy LFO → one ModLfoConfig ────────────────────────────────────────
// `prefix` is "lfoVol" / "lfoPan" / "lfoPitch"; the legacy keys are that plus
// "Enabled", "Amount", "SpeedHz", "TempoSync", "TempoDivision", "AttackMs",
// "DelayMs", "Waveform".
struct LegacyLfo {
    bool  enabled  = false;
    float amount   = 0.0f;
    sm::ModLfoConfig cfg{};
};

LegacyLfo readLegacyLfo(const nlohmann::json& j, const std::string& prefix, double bpm)
{
    LegacyLfo out;
    out.enabled = readBool(j, (prefix + "Enabled").c_str(), false);
    out.amount  = readFloat(j, (prefix + "Amount").c_str(), 0.0f);

    sm::ModLfoConfig& c = out.cfg;
    c.rateHz    = readFloat(j, (prefix + "SpeedHz").c_str(), 1.0f);
    c.tempoSync = readBool(j, (prefix + "TempoSync").c_str(), false);

    const int division = readInt(j, (prefix + "TempoDivision").c_str(), 4);
    c.syncRate = sm::ModTime{ 0.0f, noteValueForLegacyDivision(division), false, false };

    // RISE / DELAY. The legacy engine stored these in milliseconds and read
    // them that way regardless of sync; the new model reads them through the
    // LFO's own sync toggle. Writing BOTH representations keeps the
    // millisecond value exact for a free-running LFO and, for a synced one,
    // approximates it to the nearest note value at the project tempo. When
    // both are zero — the overwhelmingly common case — the two agree exactly,
    // because a note value of Off is a length of zero beats.
    const float riseMs  = readFloat(j, (prefix + "AttackMs").c_str(), 0.0f);
    const float delayMs = readFloat(j, (prefix + "DelayMs").c_str(), 0.0f);
    const double beatsPerMs = (bpm > 0.0 ? bpm : 120.0) / 60000.0;

    c.rise.ms  = riseMs;
    c.delay.ms = delayMs;
    c.rise.noteValue = (riseMs > 0.0f)
        ? nearestNoteValue(static_cast<double>(riseMs) * beatsPerMs)
        : static_cast<int>(sm::NoteValue::Off);
    c.delay.noteValue = (delayMs > 0.0f)
        ? nearestNoteValue(static_cast<double>(delayMs) * beatsPerMs)
        : static_cast<int>(sm::NoteValue::Off);

    // The legacy LFO state lived on the Voice and started at phase 0 on every
    // note-on, with no shared instance — that is exactly RETRIG, not MONO.
    c.behavior = static_cast<int>(sm::LfoBehavior::Retrig);
    c.mono     = false;
    c.smooth   = 0.0f;   // legacy segments were straight lines
    c.phase    = 0.0f;
    c.outputAmount = 1.0f;

    // ── Shape ────────────────────────────────────────────────────────────────
    // An empty legacy waveform meant the built-in sine, which numPoints == 0
    // means here too. Otherwise the breakpoints carry over as LINE segments,
    // which is the only interpolation the legacy evaluator had.
    const std::vector<LegacyPoint> pts = readWaveform(j, (prefix + "Waveform").c_str());
    if (!pts.empty()) {
        int n = 0;
        for (const auto& p : pts) {
            if (n >= sm::kMaxLfoPoints) break;
            sm::LfoPoint lp;
            lp.time    = std::clamp(p.time, 0.0f, 1.0f);
            lp.value   = std::clamp(p.value, -1.0f, 1.0f);
            lp.segment = static_cast<int>(sm::LfoSegment::Line);
            lp.tension = 0.0f;
            c.points[static_cast<size_t>(n++)] = lp;
        }
        // The legacy evaluator HELD the last breakpoint's value for the rest of
        // the cycle; the new one wraps the last point round to the first. When
        // the shape does not already reach the end of the cycle, an explicit
        // point at time 1.0 carrying the same value reproduces the hold — the
        // wrap segment then spans zero width and is never read.
        if (n > 0 && n < sm::kMaxLfoPoints
            && c.points[static_cast<size_t>(n - 1)].time < 1.0f - 1.0e-6f)
        {
            sm::LfoPoint tail = c.points[static_cast<size_t>(n - 1)];
            tail.time = 1.0f;
            c.points[static_cast<size_t>(n++)] = tail;
        }
        c.numPoints = n;
    }

    return out;
}

void addRoute(sm::ModConfig& cfg, int source, sm::ModTarget target,
              int index, float amount, bool bipolar)
{
    if (cfg.numRoutes >= sm::kMaxRoutes) return;
    sm::ModRoute r;
    r.source  = source;
    r.target  = static_cast<int>(target);
    r.index   = index;
    r.stage   = 0;
    r.amount  = std::clamp(amount, -1.0f, 1.0f);
    r.bipolar = bipolar;
    if (!sm::isRouteValid(r)) return;
    cfg.routes[static_cast<size_t>(cfg.numRoutes++)] = r;
}

} // namespace

// ─────────────────────────────────────────────────────────────────────────────

int nearestNoteValue(double beats) noexcept
{
    int   best     = static_cast<int>(sm::NoteValue::Bars32);
    double bestErr = 1.0e18;
    // Skip index 0 (Off): "nearest" must name a real length, and Off is the
    // caller's explicit choice rather than something to round into.
    for (int i = 1; i < sm::kNumNoteValues; ++i) {
        const double err = std::abs(sm::noteValueBeats(i, false, false) - beats);
        if (err < bestErr) { bestErr = err; best = i; }
    }
    return best;
}

int noteValueForLegacyDivision(int division) noexcept
{
    if (division <= 0) division = 4;
    return nearestNoteValue(static_cast<double>(division) / 4.0);
}

bool hasLegacyModulation(const nlohmann::json& j) noexcept
{
    static constexpr const char* kKeys[] = {
        "pitchEnvEnabled", "lfoVolEnabled", "lfoPanEnabled", "lfoPitchEnabled"
    };
    for (const char* k : kKeys)
        if (j.contains(k)) return true;
    return false;
}

void syncAmpEnvelopeToEnv1(float delayMs, float attackMs, float holdMs,
                           float decayMs, float sustain, float releaseMs,
                           float attackTension, float decayTension,
                           float releaseTension,
                           sm::ModConfig& cfg) noexcept
{
    sm::ModEnvConfig& e = cfg.envs[0];
    e.tempoSync  = false;            // the VCA envelope has always been in ms
    e.delay      = sm::ModTime{ delayMs,   static_cast<int>(sm::NoteValue::Off), false, false };
    e.attack     = sm::ModTime{ attackMs,  static_cast<int>(sm::NoteValue::Off), false, false };
    e.hold       = sm::ModTime{ holdMs,    static_cast<int>(sm::NoteValue::Off), false, false };
    e.decay      = sm::ModTime{ decayMs,   static_cast<int>(sm::NoteValue::Off), false, false };
    e.release    = sm::ModTime{ releaseMs, static_cast<int>(sm::NoteValue::Off), false, false };
    e.sustainPct = std::clamp(sustain, 0.0f, 1.0f) * 100.0f;
    e.attackTension  = attackTension;
    e.decayTension   = decayTension;
    e.releaseTension = releaseTension;
    e.outputAmount   = 1.0f;
}

void migrateLegacyAmpEnvelope(const nlohmann::json& j, sm::ModConfig& cfg)
{
    // The defaults mirror the old SampleRegion amp-env defaults so a project
    // that saved only some of the keys still migrates to the same envelope.
    syncAmpEnvelopeToEnv1(
        readFloat(j, "delayMs",         0.0f),
        readFloat(j, "attackMs",        0.0f),
        readFloat(j, "holdMs",          0.0f),
        readFloat(j, "decayMs",         0.0f),
        readFloat(j, "sustain",         1.0f),
        readFloat(j, "releaseMs",      50.0f),
        readFloat(j, "attackTension",   0.0f),
        readFloat(j, "decayTension",    0.0f),
        readFloat(j, "releaseTension",  0.0f),
        cfg);
}

bool migrateLegacyModulation(const nlohmann::json& j,
                             int occupiedSlots,
                             double bpm,
                             sm::ModConfig& cfg)
{
    if (!hasLegacyModulation(j)) return false;

    const int slots = std::clamp(occupiedSlots, 1, sm::kMaxModSlots);
    bool migrated = false;

    // ── Pitch envelope → ENV 2 → SlotSem on every occupied slot ──────────────
    // Legacy: pitchOffsetSemitones += pitchEnvAmount · envLevel.
    // New:    offset = (amount)·outAmt·u·span, span = 48, outAmt = 1, u = level.
    // So amount = pitchEnvAmount / 48 reproduces it EXACTLY, sign included.
    if (readBool(j, "pitchEnvEnabled", false))
    {
        const float amountSemis = readFloat(j, "pitchEnvAmount", 0.0f);
        sm::ModEnvConfig& e = cfg.envs[1];
        e.tempoSync = false;
        e.delay   = sm::ModTime{ readFloat(j, "pitchEnvDelayMs",   0.0f), 0, false, false };
        e.attack  = sm::ModTime{ readFloat(j, "pitchEnvAttackMs",  0.0f), 0, false, false };
        e.hold    = sm::ModTime{ readFloat(j, "pitchEnvHoldMs",    0.0f), 0, false, false };
        e.decay   = sm::ModTime{ readFloat(j, "pitchEnvDecayMs",   0.0f), 0, false, false };
        e.release = sm::ModTime{ readFloat(j, "pitchEnvReleaseMs", 0.0f), 0, false, false };
        e.sustainPct     = std::clamp(readFloat(j, "pitchEnvSustain", 0.0f), 0.0f, 1.0f) * 100.0f;
        e.attackTension  = readFloat(j, "pitchEnvAttackTension",  0.0f);
        e.decayTension   = readFloat(j, "pitchEnvDecayTension",   0.0f);
        e.releaseTension = readFloat(j, "pitchEnvReleaseTension", 0.0f);
        e.outputAmount   = 1.0f;

        // A zero amount produced no audible pitch movement in the legacy
        // engine either, but the envelope's SHAPE is still worth carrying over
        // so the user can see what they had; only the route is skipped.
        if (std::abs(amountSemis) > 1.0e-6f) {
            const float amount = amountSemis / 48.0f;
            for (int s = 0; s < slots; ++s)
                addRoute(cfg, sm::kEnvSource0 + 1, sm::ModTarget::SlotSem, s, amount, false);
        }
        // The shape is carried over even at zero amount, so the source EXISTS as
        // far as the tray is concerned regardless of whether a route was added.
        cfg.envPresent[1] = true;
        migrated = true;
    }

    // ── VOL LFO → LFO 1 → MasterVolume (bipolar) ─────────────────────────────
    // Legacy: gain = max(0, 1 + mod·amount), a multiplier on the whole voice.
    // New:    modMasterGain = clamp(1 + amount·raw, 0, 2) for a bipolar route
    //         with span 1. Identical across the legal amount range of 0..1.
    {
        const LegacyLfo l = readLegacyLfo(j, "lfoVol", bpm);
        if (l.enabled) {
            cfg.lfos[0] = l.cfg;
            cfg.lfoPresent[0] = true;
            if (std::abs(l.amount) > 1.0e-6f)
                addRoute(cfg, sm::kLfoSource0 + 0, sm::ModTarget::MasterVolume, 0,
                         l.amount, true);
            migrated = true;
        }
    }

    // ── PAN LFO → LFO 2 → MasterPan (bipolar) ────────────────────────────────
    // The ONE inexact mapping. See the header: the legacy path multiplied an
    // unnormalised second constant-power curve onto the slot's, costing 3.01 dB
    // at centre. MasterPan shifts the pan POSITION and normalises once, so a
    // migrated project is 3.01 dB louder at centre and correctly panned. The
    // legacy error was position-dependent, so no static trim reproduces it.
    {
        const LegacyLfo l = readLegacyLfo(j, "lfoPan", bpm);
        if (l.enabled) {
            cfg.lfos[1] = l.cfg;
            cfg.lfoPresent[1] = true;
            if (std::abs(l.amount) > 1.0e-6f)
                addRoute(cfg, sm::kLfoSource0 + 1, sm::ModTarget::MasterPan, 0,
                         l.amount, true);
            migrated = true;
        }
    }

    // ── PITCH LFO → LFO 3 → SlotSem on every occupied slot (bipolar) ─────────
    // Legacy: pitchOffsetSemitones += amount · mod, mod ∈ [-1,+1].
    // New:    offset = (amount/48)·raw·48 = amount·raw. Exact.
    {
        const LegacyLfo l = readLegacyLfo(j, "lfoPitch", bpm);
        if (l.enabled) {
            cfg.lfos[2] = l.cfg;
            cfg.lfoPresent[2] = true;
            if (std::abs(l.amount) > 1.0e-6f) {
                const float amount = l.amount / 48.0f;
                for (int s = 0; s < slots; ++s)
                    addRoute(cfg, sm::kLfoSource0 + 2, sm::ModTarget::SlotSem, s,
                             amount, true);
            }
            migrated = true;
        }
    }

    return migrated;
}

} // namespace xleth::samplegacy
