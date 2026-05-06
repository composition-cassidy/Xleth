#include "Clip.h"
#include <algorithm>

// ─── ClipModulation serialization ─────────────────────────────────────────────
// Free functions in the global namespace mirror the Clip ADL pattern. New
// projects emit a "modulation" object; old projects (no key) load with all
// modulation disabled — see ClipModulation default member initializers.

static nlohmann::json lfoBreakpointsToJson(
    const std::vector<SampleRegion::LfoBreakpoint>& bps)
{
    nlohmann::json arr = nlohmann::json::array();
    for (const auto& bp : bps)
        arr.push_back({{"time", bp.time}, {"value", bp.value}});
    return arr;
}

static std::vector<SampleRegion::LfoBreakpoint> lfoBreakpointsFromJson(
    const nlohmann::json& j)
{
    std::vector<SampleRegion::LfoBreakpoint> out;
    if (!j.is_array()) return out;
    for (const auto& item : j) {
        SampleRegion::LfoBreakpoint bp;
        bp.time  = item.value("time",  0.0f);
        bp.value = item.value("value", 0.0f);
        out.push_back(bp);
    }
    return out;
}

void to_json(nlohmann::json& j, const ClipModulation& m) {
    nlohmann::json vib = {
        {"enabled",               m.vibrato.enabled},
        {"depthCents",            m.vibrato.depthCents},
        {"rateMode",              vibratoRateModeToString(m.vibrato.rateMode)},
        {"rateHz",                m.vibrato.rateHz},
        {"syncDivision",          vibratoSyncDivisionToString(m.vibrato.syncDivision)},
        {"shape",                 vibratoShapeToString(m.vibrato.shape)},
        {"phaseResetOnClipStart", m.vibrato.phaseResetOnClipStart},
        {"phaseOffset",           m.vibrato.phaseOffset},
        {"customShape",           lfoBreakpointsToJson(m.vibrato.customShape)}
    };

    nlohmann::json scratchCurve = nlohmann::json::array();
    for (const auto& p : m.scratch.curve)
        scratchCurve.push_back({
            {"time",           p.time},
            {"rateMultiplier", p.rateMultiplier},
            {"curve",          p.curve}
        });

    nlohmann::json scr = {
        {"enabled",            m.scratch.enabled},
        {"timeMode",           scratchTimeModeToString(m.scratch.timeMode)},
        {"smoothingMs",        m.scratch.smoothingMs},
        {"gainCompensationDb", m.scratch.gainCompensationDb},
        {"edgeMode",           scratchEdgeModeToString(m.scratch.edgeMode)},
        {"curve",              scratchCurve}
    };

    nlohmann::json vid = {
        {"vibratoSwirlEnabled",    m.video.vibratoSwirlEnabled},
        {"scratchWaveEnabled",     m.video.scratchWaveEnabled},
        {"swirlAmount",            m.video.swirlAmount},
        {"swirlRadius",            m.video.swirlRadius},
        {"swirlCenterX",           m.video.swirlCenterX},
        {"swirlCenterY",           m.video.swirlCenterY},
        {"waveAmount",             m.video.waveAmount},
        {"waveFrequency",          m.video.waveFrequency},
        {"smearAmount",            m.video.smearAmount},
        {"reverseWaveWithScratch", m.video.reverseWaveWithScratch}
    };

    j = nlohmann::json{
        {"enabled", m.enabled},
        {"vibrato", vib},
        {"scratch", scr},
        {"video",   vid}
    };
}

void from_json(const nlohmann::json& j, ClipModulation& m) {
    m.enabled = j.value("enabled", false);

    if (j.contains("vibrato") && j.at("vibrato").is_object()) {
        const auto& v = j.at("vibrato");
        m.vibrato.enabled               = v.value("enabled",               false);
        m.vibrato.depthCents            = v.value("depthCents",            0.0f);
        m.vibrato.rateMode              = stringToVibratoRateMode(
            v.value("rateMode", std::string("freeHz")));
        m.vibrato.rateHz                = v.value("rateHz",                5.0f);
        m.vibrato.syncDivision          = stringToVibratoSyncDivision(
            v.value("syncDivision", std::string("eighth")));
        m.vibrato.shape                 = stringToVibratoShape(
            v.value("shape", std::string("sine")));
        m.vibrato.phaseResetOnClipStart = v.value("phaseResetOnClipStart", true);
        m.vibrato.phaseOffset           = v.value("phaseOffset",           0.0f);
        if (v.contains("customShape"))
            m.vibrato.customShape = lfoBreakpointsFromJson(v.at("customShape"));
    }

    if (j.contains("scratch") && j.at("scratch").is_object()) {
        const auto& s = j.at("scratch");
        m.scratch.enabled            = s.value("enabled",            false);
        m.scratch.timeMode           = stringToScratchTimeMode(
            s.value("timeMode", std::string("clipSeconds")));
        m.scratch.smoothingMs        = s.value("smoothingMs",        2.0f);
        m.scratch.gainCompensationDb = s.value("gainCompensationDb", 0.0f);
        m.scratch.edgeMode           = stringToScratchEdgeMode(
            s.value("edgeMode", std::string("clamp")));
        m.scratch.curve.clear();
        if (s.contains("curve") && s.at("curve").is_array()) {
            for (const auto& pj : s.at("curve")) {
                ClipModulation::ScratchPoint p;
                p.time           = pj.value("time",           0.0f);
                p.rateMultiplier = pj.value("rateMultiplier", 1.0f);
                p.curve          = pj.value("curve",          0.0f);
                m.scratch.curve.push_back(p);
            }
        }
    }

    if (j.contains("video") && j.at("video").is_object()) {
        const auto& v = j.at("video");
        m.video.vibratoSwirlEnabled    = v.value("vibratoSwirlEnabled",    false);
        m.video.scratchWaveEnabled     = v.value("scratchWaveEnabled",     false);
        m.video.swirlAmount            = v.value("swirlAmount",            0.25f);
        m.video.swirlRadius            = v.value("swirlRadius",            0.45f);
        m.video.swirlCenterX           = v.value("swirlCenterX",           0.5f);
        m.video.swirlCenterY           = v.value("swirlCenterY",           0.5f);
        m.video.waveAmount             = v.value("waveAmount",             0.08f);
        m.video.waveFrequency          = v.value("waveFrequency",          8.0f);
        m.video.smearAmount            = v.value("smearAmount",            0.0f);
        m.video.reverseWaveWithScratch = v.value("reverseWaveWithScratch", true);
    }
}

void to_json(nlohmann::json& j, const Clip& c) {
    float fadeInPercent = c.fadeInPercent;
    float fadeOutPercent = c.fadeOutPercent;
    normalizeClipFadePercents(fadeInPercent, fadeOutPercent);

    j = nlohmann::json{
        {"id",                c.id},
        {"trackId",           c.trackId},
        {"regionId",          c.regionId},
        {"positionTicks",     c.position.ticks},
        {"durationTicks",     c.duration.ticks},
        {"regionOffsetTicks", c.regionOffset.ticks},
        {"syllableIndex",     c.syllableIndex},
        {"velocity",          c.velocity},
        {"pitchOffset",       c.pitchOffset},
        {"pitchOffsetCents",  c.pitchOffsetCents},
        {"reversed",          c.reversed},
        {"stretchRatio",      c.stretchRatio},
        {"stretchMethod",     static_cast<int>(c.stretchMethod)},
        {"formantPreserve",   c.formantPreserve},
        {"fadeInPercent",     fadeInPercent},
        {"fadeOutPercent",    fadeOutPercent},
        {"fadeInX1",          c.fadeInX1},
        {"fadeInY1",          c.fadeInY1},
        {"fadeInX2",          c.fadeInX2},
        {"fadeInY2",          c.fadeInY2},
        {"fadeOutX1",         c.fadeOutX1},
        {"fadeOutY1",         c.fadeOutY1},
        {"fadeOutX2",         c.fadeOutX2},
        {"fadeOutY2",         c.fadeOutY2},
        {"modulation",        c.modulation}
    };
}

void from_json(const nlohmann::json& j, Clip& c) {
    j.at("id").get_to(c.id);
    j.at("trackId").get_to(c.trackId);
    j.at("regionId").get_to(c.regionId);
    c.position.ticks     = j.at("positionTicks").get<int64_t>();
    c.duration.ticks     = j.at("durationTicks").get<int64_t>();
    c.regionOffset.ticks = j.value("regionOffsetTicks", int64_t(0));
    j.at("syllableIndex").get_to(c.syllableIndex);
    j.at("velocity").get_to(c.velocity);
    j.at("pitchOffset").get_to(c.pitchOffset);

    // New fields — safe defaults for old project files that lack them
    int cents = j.value("pitchOffsetCents", 0);
    c.pitchOffsetCents = std::max(-99, std::min(99, cents));
    c.reversed         = j.value("reversed",       false);
    double ratio       = j.value("stretchRatio",   1.0);
    c.stretchRatio     = (ratio <= 0.0) ? 1.0 : ratio;
    c.stretchMethod    = static_cast<StretchMethod>(j.value("stretchMethod", 0));
    c.formantPreserve  = j.value("formantPreserve", false);

    if (j.contains("fadeInPercent"))
        c.fadeInPercent = j.value("fadeInPercent", 0.0f);
    else
        c.fadeInPercent = legacyFadeTicksToPercent(j.value("fadeInTicks", 0.0f), c.duration.ticks);

    if (j.contains("fadeOutPercent"))
        c.fadeOutPercent = j.value("fadeOutPercent", 0.0f);
    else
        c.fadeOutPercent = legacyFadeTicksToPercent(j.value("fadeOutTicks", 0.0f), c.duration.ticks);
    normalizeClipFadePercents(c);

    c.fadeInX1      = j.value("fadeInX1",     0.0f);
    c.fadeInY1      = j.value("fadeInY1",     0.0f);
    c.fadeInX2      = j.value("fadeInX2",     1.0f);
    c.fadeInY2      = j.value("fadeInY2",     1.0f);
    c.fadeOutX1     = j.value("fadeOutX1",    0.0f);
    c.fadeOutY1     = j.value("fadeOutY1",    0.0f);
    c.fadeOutX2     = j.value("fadeOutX2",    1.0f);
    c.fadeOutY2     = j.value("fadeOutY2",    1.0f);

    // Phase A: clip modulation (Vibrato/Scratch/Video). Old projects with no
    // "modulation" key load with all-disabled defaults.
    c.modulation = j.value("modulation", ClipModulation{});
}
