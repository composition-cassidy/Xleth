#include "Pattern.h"

void to_json(nlohmann::json& j, const PatternNote& n) {
    j = nlohmann::json{
        {"id",            n.id},
        {"positionTicks", n.position.ticks},
        {"durationTicks", n.duration.ticks},
        {"pitch",         n.pitch},
        {"velocity",      n.velocity},
        {"isSlide",       n.isSlide},
        {"slideCurveCx",  n.slideCurveCx},
        {"slideCurveCy",  n.slideCurveCy}
    };
    // Written only when present: a note without one (Follow) saves exactly as
    // before, so projects that never used overrides are unchanged on disk.
    if (n.lensOverride)
        j["lensOverride"] = lensroam::lensNoteOverrideToJson(*n.lensOverride);
    // Clones (schema v10): written only when pinned; absent = Auto.
    if (n.voicePin >= 0)
        j["voicePin"] = n.voicePin;
}

void from_json(const nlohmann::json& j, PatternNote& n) {
    j.at("id").get_to(n.id);
    n.position.ticks = j.at("positionTicks").get<int64_t>();
    n.duration.ticks = j.at("durationTicks").get<int64_t>();
    j.at("pitch").get_to(n.pitch);
    j.at("velocity").get_to(n.velocity);
    n.isSlide      = j.value("isSlide", false);
    n.slideCurveCx = j.value("slideCurveCx", 0.5f);
    n.slideCurveCy = j.value("slideCurveCy", 0.5f);
    // Absent (every older project) = Follow.
    n.lensOverride = j.contains("lensOverride")
        ? lensroam::lensNoteOverrideFromJson(j.at("lensOverride"))
        : nullptr;
    // Absent / malformed / out of range = Auto.
    n.voicePin = kVoicePinAuto;
    if (j.contains("voicePin") && j.at("voicePin").is_number_integer()) {
        const int p = j.at("voicePin").get<int>();
        if (p >= 0 && p <= kMaxVoicePin) n.voicePin = p;
    }
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
