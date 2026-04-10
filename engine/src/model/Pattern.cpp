#include "Pattern.h"

void to_json(nlohmann::json& j, const PatternNote& n) {
    j = nlohmann::json{
        {"id",            n.id},
        {"positionTicks", n.position.ticks},
        {"durationTicks", n.duration.ticks},
        {"pitch",         n.pitch},
        {"velocity",      n.velocity}
    };
}

void from_json(const nlohmann::json& j, PatternNote& n) {
    j.at("id").get_to(n.id);
    n.position.ticks = j.at("positionTicks").get<int64_t>();
    n.duration.ticks = j.at("durationTicks").get<int64_t>();
    j.at("pitch").get_to(n.pitch);
    j.at("velocity").get_to(n.velocity);
}

void to_json(nlohmann::json& j, const Pattern& p) {
    j = nlohmann::json{
        {"id",               p.id},
        {"name",             p.name},
        {"regionId",         p.regionId},
        {"lengthTicks",      p.length.ticks},
        {"notes",            p.notes},          // auto-serialize via ADL
        {"nextNoteId",       p.nextNoteId}
    };
}

void from_json(const nlohmann::json& j, Pattern& p) {
    j.at("id").get_to(p.id);
    j.at("name").get_to(p.name);
    j.at("regionId").get_to(p.regionId);
    p.length.ticks = j.at("lengthTicks").get<int64_t>();
    j.at("notes").get_to(p.notes);             // auto-deserialize via ADL
    j.at("nextNoteId").get_to(p.nextNoteId);
    // NOTE: Legacy projects may still carry rootNote/attackMs/decayMs/sustain/
    // releaseMs/loopEnabled/loopStart/loopEnd/crossfadeEnabled here; those are
    // migrated onto the matching SampleRegion by Timeline's loader (see
    // Timeline::migrateLegacyPatternSamplerFields).
}
