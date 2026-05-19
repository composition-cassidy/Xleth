#include "Track.h"

void to_json(nlohmann::json& j, const TrackInfo& t) {
    j = nlohmann::json{
        {"id",                t.id},
        {"name",              t.name},
        {"volume",            t.volume},
        {"pan",               t.pan},
        {"stereoSpread",      t.stereoSpread},
        {"muted",             t.muted},
        {"solo",              t.solo},
        {"order",             t.order},
        {"fxMode",            trackFxModeToString(t.fxMode)},
        {"videoX",            t.videoX},
        {"videoY",            t.videoY},
        {"videoW",            t.videoW},
        {"videoH",            t.videoH},
        {"videoOpacity",      t.videoOpacity},
        {"videoZOrder",       t.videoZOrder},
        {"type",              trackTypeToString(t.type)},
        {"videoFlipMode",     videoFlipModeToString(t.videoFlipMode)},
        {"videoHoldLastFrame", t.videoHoldLastFrame}
    };
}

void from_json(const nlohmann::json& j, TrackInfo& t) {
    j.at("id").get_to(t.id);
    j.at("name").get_to(t.name);
    j.at("volume").get_to(t.volume);
    j.at("pan").get_to(t.pan);
    t.stereoSpread = j.value("stereoSpread", 1.0f);  // default 1.0 for old projects
    j.at("muted").get_to(t.muted);
    j.at("solo").get_to(t.solo);
    j.at("order").get_to(t.order);
    t.fxMode = stringToTrackFxMode(j.value("fxMode", std::string("chain")));
    j.at("videoX").get_to(t.videoX);
    j.at("videoY").get_to(t.videoY);
    j.at("videoW").get_to(t.videoW);
    j.at("videoH").get_to(t.videoH);
    j.at("videoOpacity").get_to(t.videoOpacity);
    j.at("videoZOrder").get_to(t.videoZOrder);

    // Backward-compat fields for the pattern/sampler extension.
    t.type              = stringToTrackType(j.value("type", std::string("Clip")));
    // Legacy fields (assignedRegionId, assignedPatternId) read and discarded
    // for backward compatibility — pattern tracks no longer bind to a region.
    (void)j.value("assignedRegionId",  -1);
    (void)j.value("assignedPatternId", -1);
    t.videoFlipMode     = stringToVideoFlipMode(j.value("videoFlipMode", std::string("None")));
    t.videoHoldLastFrame = j.value("videoHoldLastFrame", false);
}
