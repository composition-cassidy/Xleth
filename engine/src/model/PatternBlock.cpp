#include "PatternBlock.h"

void to_json(nlohmann::json& j, const PatternBlock& b) {
    j = nlohmann::json{
        {"id",            b.id},
        {"trackId",       b.trackId},
        {"patternId",     b.patternId},
        {"positionTicks", b.position.ticks},
        {"durationTicks", b.duration.ticks},
        {"offsetTicks",   b.offset.ticks},
        {"loopEnabled",   b.loopEnabled}
    };
}

void from_json(const nlohmann::json& j, PatternBlock& b) {
    j.at("id").get_to(b.id);
    j.at("trackId").get_to(b.trackId);
    j.at("patternId").get_to(b.patternId);
    b.position.ticks = j.at("positionTicks").get<int64_t>();
    b.duration.ticks = j.at("durationTicks").get<int64_t>();
    b.offset.ticks   = j.at("offsetTicks").get<int64_t>();
    // Default to false: matches FL Studio convention (new blocks don't loop)
    b.loopEnabled = j.value("loopEnabled", false);
}
