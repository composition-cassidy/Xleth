#include "Clip.h"
#include <algorithm>

void to_json(nlohmann::json& j, const Clip& c) {
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
        {"fadeInTicks",       c.fadeInTicks},
        {"fadeOutTicks",      c.fadeOutTicks},
        {"fadeInX1",          c.fadeInX1},
        {"fadeInY1",          c.fadeInY1},
        {"fadeInX2",          c.fadeInX2},
        {"fadeInY2",          c.fadeInY2},
        {"fadeOutX1",         c.fadeOutX1},
        {"fadeOutY1",         c.fadeOutY1},
        {"fadeOutX2",         c.fadeOutX2},
        {"fadeOutY2",         c.fadeOutY2}
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

    c.fadeInTicks   = j.value("fadeInTicks",  0.0f);
    c.fadeOutTicks  = j.value("fadeOutTicks", 0.0f);
    c.fadeInX1      = j.value("fadeInX1",     0.0f);
    c.fadeInY1      = j.value("fadeInY1",     0.0f);
    c.fadeInX2      = j.value("fadeInX2",     1.0f);
    c.fadeInY2      = j.value("fadeInY2",     1.0f);
    c.fadeOutX1     = j.value("fadeOutX1",    0.0f);
    c.fadeOutY1     = j.value("fadeOutY1",    0.0f);
    c.fadeOutX2     = j.value("fadeOutX2",    1.0f);
    c.fadeOutY2     = j.value("fadeOutY2",    1.0f);
}
