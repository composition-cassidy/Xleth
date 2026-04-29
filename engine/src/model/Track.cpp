#include "Track.h"

// ── VideoFlipConfig JSON helpers ─────────────────────────────────────────────

nlohmann::json videoFlipConfigToJson(const VideoFlipConfig& cfg) {
    nlohmann::json j;
    j["enabled"]         = cfg.enabled;
    j["startStateIndex"] = cfg.startStateIndex;

    nlohmann::json states = nlohmann::json::array();
    for (const auto& s : cfg.states) {
        nlohmann::json sj;
        sj["id"]          = s.id;
        sj["orientation"] = orientationToString(s.orientation);
        // Omit label when empty to keep the JSON compact.
        if (!s.label.empty()) sj["label"] = s.label;
        states.push_back(sj);
    }
    j["states"] = states;

    nlohmann::json mod;
    mod["type"] = videoFlipModifierTypeToString(cfg.modifier.type);
    nlohmann::json config = nlohmann::json::object();
    switch (cfg.modifier.type) {
        case VideoFlipModifier::Type::SpecificPitches:
            config["pitches"] = cfg.modifier.pitches;
            break;
        case VideoFlipModifier::Type::EveryNBeats:
            config["n"]           = cfg.modifier.n;
            config["subdivision"] = videoFlipSubdivisionToString(cfg.modifier.subdivision);
            break;
        default:
            break;
    }
    mod["config"] = config;
    j["modifier"] = mod;
    return j;
}

VideoFlipConfig videoFlipConfigFromJson(const nlohmann::json& j) {
    VideoFlipConfig cfg;
    cfg.enabled         = j.value("enabled",         false);
    cfg.startStateIndex = j.value("startStateIndex", 0);

    if (j.contains("states") && j.at("states").is_array()) {
        cfg.states.clear();
        for (const auto& sj : j.at("states")) {
            VideoFlipState s;
            s.id          = sj.value("id",          std::string(""));
            s.orientation = stringToOrientation(sj.value("orientation", std::string("none")));
            s.label       = sj.value("label",       std::string(""));
            cfg.states.push_back(s);
        }
    }
    if (cfg.states.empty())
        cfg.states = { {"s0", Orientation::None, ""} };

    if (j.contains("modifier") && j.at("modifier").is_object()) {
        const auto& mod     = j.at("modifier");
        cfg.modifier.type   = stringToVideoFlipModifierType(
            mod.value("type", std::string("every-note")));
        if (mod.contains("config") && mod.at("config").is_object()) {
            const auto& c = mod.at("config");
            switch (cfg.modifier.type) {
                case VideoFlipModifier::Type::SpecificPitches:
                    if (c.contains("pitches") && c.at("pitches").is_array()) {
                        cfg.modifier.pitches.clear();
                        for (const auto& p : c.at("pitches"))
                            cfg.modifier.pitches.push_back(p.get<int>());
                    }
                    break;
                case VideoFlipModifier::Type::EveryNBeats:
                    cfg.modifier.n = c.value("n", 1);
                    cfg.modifier.subdivision = stringToVideoFlipSubdivision(
                        c.value("subdivision", std::string("beat")));
                    break;
                default:
                    break;
            }
        }
    }

    // Clamp to valid range after deserialization.
    if (!cfg.states.empty()) {
        if (cfg.startStateIndex < 0)
            cfg.startStateIndex = 0;
        if (cfg.startStateIndex >= static_cast<int>(cfg.states.size()))
            cfg.startStateIndex = static_cast<int>(cfg.states.size()) - 1;
    }
    return cfg;
}

// ── VisualEffect named-key helpers (Prompt 11) ───────────────────────────────

std::string visualEffectTypeToString(VisualEffect::Type t) {
    switch (t) {
        case VisualEffect::Type::Desaturation:       return "Desaturation";
        case VisualEffect::Type::Tint:               return "Tint";
        case VisualEffect::Type::BrightnessContrast: return "BrightnessContrast";
        case VisualEffect::Type::TVSimulator:        return "TVSimulator";
        case VisualEffect::Type::ZoomPanRotation:    return "ZoomPanRotation";
    }
    return "Desaturation";
}

VisualEffect::Type stringToVisualEffectType(const std::string& s) {
    if (s == "Tint")               return VisualEffect::Type::Tint;
    if (s == "BrightnessContrast") return VisualEffect::Type::BrightnessContrast;
    if (s == "TVSimulator")        return VisualEffect::Type::TVSimulator;
    if (s == "ZoomPanRotation")    return VisualEffect::Type::ZoomPanRotation;
    return VisualEffect::Type::Desaturation;
}

nlohmann::json visualEffectParamsToNamedJson(VisualEffect::Type type,
                                             const float (&p)[16]) {
    nlohmann::json j = nlohmann::json::object();
    switch (type) {
        case VisualEffect::Type::Desaturation:
            j["amount"] = p[0];
            break;
        case VisualEffect::Type::Tint:
            j["r"]               = p[0];
            j["g"]               = p[1];
            j["b"]               = p[2];
            j["strength"]        = p[3];
            j["lightnessFloor"]  = p[4];
            j["lightnessCeiling"]= p[5];
            break;
        case VisualEffect::Type::BrightnessContrast:
            j["brightness"] = p[0];
            j["contrast"]   = p[1];
            break;
        case VisualEffect::Type::TVSimulator:
            j["intensity"]     = p[0];
            j["rollSpeed"]     = p[1];
            j["scanlineAlpha"] = p[2];
            j["chromaOffset"]  = p[3];
            j["staticNoise"]   = p[4];
            j["jitterFreq"]    = p[5];
            j["colorBleed"]    = p[6];
            break;
        case VisualEffect::Type::ZoomPanRotation:
            j["startZoom"]      = p[0];
            j["targetZoom"]     = p[1];
            j["startPanX"]      = p[2];
            j["startPanY"]      = p[3];
            j["targetPanX"]     = p[4];
            j["targetPanY"]     = p[5];
            j["startRotation"]  = p[6];
            j["targetRotation"] = p[7];
            j["durationMs"]     = p[8];
            j["zoomEasing"]     = p[9];
            j["panEasing"]      = p[10];
            j["rotEasing"]      = p[11];
            j["overshoot"]      = p[12];
            break;
    }
    return j;
}

void visualEffectParamsFromNamedJson(VisualEffect::Type type,
                                     const nlohmann::json& j,
                                     float (&p)[16]) {
    // Zero all slots first so any unused params read as 0.
    for (int i = 0; i < 16; ++i) p[i] = 0.0f;

    if (!j.is_object()) return;

    switch (type) {
        case VisualEffect::Type::Desaturation:
            p[0] = j.value("amount", 0.0f);
            break;
        case VisualEffect::Type::Tint:
            p[0] = j.value("r",                1.0f);
            p[1] = j.value("g",                1.0f);
            p[2] = j.value("b",                1.0f);
            p[3] = j.value("strength",         0.0f);
            p[4] = j.value("lightnessFloor",   0.0f);
            p[5] = j.value("lightnessCeiling", 1.0f);
            break;
        case VisualEffect::Type::BrightnessContrast:
            p[0] = j.value("brightness", 0.0f);
            p[1] = j.value("contrast",   1.0f);
            break;
        case VisualEffect::Type::TVSimulator:
            p[0] = j.value("intensity",     0.0f);
            p[1] = j.value("rollSpeed",     0.0f);
            p[2] = j.value("scanlineAlpha", 0.0f);
            p[3] = j.value("chromaOffset",  0.0f);
            p[4] = j.value("staticNoise",   0.0f);
            p[5] = j.value("jitterFreq",    0.0f);
            p[6] = j.value("colorBleed",    0.0f);
            break;
        case VisualEffect::Type::ZoomPanRotation:
            p[0]  = j.value("startZoom",      1.0f);
            p[1]  = j.value("targetZoom",     1.0f);
            p[2]  = j.value("startPanX",      0.0f);
            p[3]  = j.value("startPanY",      0.0f);
            p[4]  = j.value("targetPanX",     0.0f);
            p[5]  = j.value("targetPanY",     0.0f);
            p[6]  = j.value("startRotation",  0.0f);
            p[7]  = j.value("targetRotation", 0.0f);
            p[8]  = j.value("durationMs",     300.0f);
            p[9]  = j.value("zoomEasing",     1.0f);
            p[10] = j.value("panEasing",      1.0f);
            p[11] = j.value("rotEasing",      1.0f);
            p[12] = j.value("overshoot",      1.70158f);
            break;
    }
}

// ── TrackInfo JSON ADL ───────────────────────────────────────────────────────

void to_json(nlohmann::json& j, const TrackInfo& t) {
    j = nlohmann::json{
        {"id",                t.id},
        {"name",              t.name},
        {"volume",            t.volume},
        {"pan",               t.pan},
        {"stereoSpread",      t.stereoSpread},
        {"muted",             t.muted},
        {"solo",              t.solo},
        {"visualOnly",        t.visualOnly},
        {"order",             t.order},
        {"videoX",            t.videoX},
        {"videoY",            t.videoY},
        {"videoW",            t.videoW},
        {"videoH",            t.videoH},
        {"videoOpacity",      t.videoOpacity},
        {"videoZOrder",       t.videoZOrder},
        {"type",              trackTypeToString(t.type)},
        {"videoHoldLastFrame", t.videoHoldLastFrame}
    };
    // videoFlipConfig is a nested object — append after the flat initializer.
    j["videoFlipConfig"] = videoFlipConfigToJson(t.videoFlipConfig);

    // ── Visual compositor effect settings (Prompt 11 persistence) ────────
    j["gapScaleOverride"] = t.gapScaleOverride;
    j["cornerRadius"]     = t.cornerRadius;

    j["subdivisionFactor"] = t.subdivisionFactor;

    j["bounce"] = {
        {"enabled",      t.bounce.enabled},
        {"directionDeg", t.bounce.directionDeg},
        {"distance",     t.bounce.distance},
        {"durationMs",   t.bounce.durationMs},
        {"squashAmount", t.bounce.squashAmount},
        {"overshoot",    t.bounce.overshoot},
        {"repeatCount",  t.bounce.repeatCount},
        {"easingType",   t.bounce.easingType},
    };

    j["pingPong"] = {
        {"enabled",         t.pingPong.enabled},
        {"regionStartPct",  t.pingPong.regionStartPct},
        {"regionEndPct",    t.pingPong.regionEndPct},
        {"crossfadeFrames", t.pingPong.crossfadeFrames},
        {"reverseSpeed",    t.pingPong.reverseSpeed},
        {"maxLoops",        t.pingPong.maxLoops},
    };

    j["zoomPanRot"] = {
        {"enabled",        t.zoomPanRot.enabled},
        {"startZoom",      t.zoomPanRot.startZoom},
        {"targetZoom",     t.zoomPanRot.targetZoom},
        {"startPanX",      t.zoomPanRot.startPanX},
        {"startPanY",      t.zoomPanRot.startPanY},
        {"targetPanX",     t.zoomPanRot.targetPanX},
        {"targetPanY",     t.zoomPanRot.targetPanY},
        {"startRotation",  t.zoomPanRot.startRotation},
        {"targetRotation", t.zoomPanRot.targetRotation},
        {"durationMs",     t.zoomPanRot.durationMs},
        {"zoomEasing",     t.zoomPanRot.zoomEasing},
        {"panEasing",      t.zoomPanRot.panEasing},
        {"rotEasing",      t.zoomPanRot.rotEasing},
        {"overshoot",      t.zoomPanRot.overshoot},
    };

    j["slideNoteEffect"] = {
        {"type",                static_cast<int>(t.slideNoteEffect.type)},
        {"durationMode",        static_cast<int>(t.slideNoteEffect.durationMode)},
        {"fixedDurationMs",     t.slideNoteEffect.fixedDurationMs},
        {"slideZoomDelta",      t.slideNoteEffect.slideZoomDelta},
        {"slidePanXDelta",      t.slideNoteEffect.slidePanXDelta},
        {"slidePanYDelta",      t.slideNoteEffect.slidePanYDelta},
        {"slideRotationDelta",  t.slideNoteEffect.slideRotationDelta},
        {"slideBounceDistance", t.slideNoteEffect.slideBounceDistance},
        {"slideBounceDirDeg",   t.slideNoteEffect.slideBounceDirDeg},
        {"slideTVIntensity",    t.slideNoteEffect.slideTVIntensity},
    };

    nlohmann::json chain = nlohmann::json::array();
    for (const auto& fx : t.visualEffectChain) {
        nlohmann::json f;
        f["type"]     = visualEffectTypeToString(fx.type);
        f["bypassed"] = fx.bypassed;
        f["params"]   = visualEffectParamsToNamedJson(fx.type, fx.params);
        chain.push_back(f);
    }
    j["visualEffectChain"] = chain;
}

void from_json(const nlohmann::json& j, TrackInfo& t) {
    j.at("id").get_to(t.id);
    j.at("name").get_to(t.name);
    j.at("volume").get_to(t.volume);
    j.at("pan").get_to(t.pan);
    t.stereoSpread = j.value("stereoSpread", 1.0f);  // default 1.0 for old projects
    j.at("muted").get_to(t.muted);
    j.at("solo").get_to(t.solo);
    t.visualOnly = j.value("visualOnly", false);
    j.at("order").get_to(t.order);
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
    t.videoHoldLastFrame = j.value("videoHoldLastFrame", false);

    // ── VideoFlipConfig migration (spec §3.5) ─────────────────────────────
    // v2+ projects carry "videoFlipConfig"; v1 projects carry "videoFlipMode".
    // Read the new field first; fall back to migrating the legacy string.
    if (j.contains("videoFlipConfig") && j.at("videoFlipConfig").is_object()) {
        t.videoFlipConfig = videoFlipConfigFromJson(j.at("videoFlipConfig"));
    } else {
        const std::string legacyMode = j.value("videoFlipMode", std::string("None"));
        t.videoFlipConfig = migrateVideoFlipMode(stringToVideoFlipMode(legacyMode));
    }

    // ── Visual compositor effect settings (Prompt 11 persistence) ────────
    // All fields use j.value(...) with struct defaults so pre-Prompt-11
    // project.json files load cleanly with every visual effect at default.
    t.gapScaleOverride = j.value("gapScaleOverride", -1.0f);
    t.cornerRadius     = j.value("cornerRadius",      0.0f);

    {
        int f = j.value("subdivisionFactor", 1);
        // Sanitize: only the four canonical factors are valid.
        if (f != 1 && f != 2 && f != 4 && f != 8) f = 1;
        t.subdivisionFactor = f;
    }

    if (j.contains("bounce") && j.at("bounce").is_object()) {
        const auto& jb = j.at("bounce");
        t.bounce.enabled      = jb.value("enabled",      false);
        t.bounce.directionDeg = jb.value("directionDeg", 270.0f);
        t.bounce.distance     = jb.value("distance",     0.15f);
        t.bounce.durationMs   = jb.value("durationMs",   200.0f);
        t.bounce.squashAmount = jb.value("squashAmount", 0.0f);
        t.bounce.overshoot    = jb.value("overshoot",    1.70158f);
        t.bounce.repeatCount  = jb.value("repeatCount",  1);
        t.bounce.easingType   = jb.value("easingType",   0);
    }

    if (j.contains("pingPong") && j.at("pingPong").is_object()) {
        const auto& jp = j.at("pingPong");
        t.pingPong.enabled         = jp.value("enabled",         false);
        t.pingPong.regionStartPct  = jp.value("regionStartPct",  0.8f);
        t.pingPong.regionEndPct    = jp.value("regionEndPct",    1.0f);
        t.pingPong.crossfadeFrames = jp.value("crossfadeFrames", 3);
        t.pingPong.reverseSpeed    = jp.value("reverseSpeed",    1.0f);
        t.pingPong.maxLoops        = jp.value("maxLoops",        0);
    }

    if (j.contains("zoomPanRot") && j.at("zoomPanRot").is_object()) {
        const auto& jz = j.at("zoomPanRot");
        t.zoomPanRot.enabled        = jz.value("enabled",        false);
        t.zoomPanRot.startZoom      = jz.value("startZoom",      1.0f);
        t.zoomPanRot.targetZoom     = jz.value("targetZoom",     1.0f);
        t.zoomPanRot.startPanX      = jz.value("startPanX",      0.0f);
        t.zoomPanRot.startPanY      = jz.value("startPanY",      0.0f);
        t.zoomPanRot.targetPanX     = jz.value("targetPanX",     0.0f);
        t.zoomPanRot.targetPanY     = jz.value("targetPanY",     0.0f);
        t.zoomPanRot.startRotation  = jz.value("startRotation",  0.0f);
        t.zoomPanRot.targetRotation = jz.value("targetRotation", 0.0f);
        t.zoomPanRot.durationMs     = jz.value("durationMs",     300.0f);
        t.zoomPanRot.zoomEasing     = jz.value("zoomEasing",     1);
        t.zoomPanRot.panEasing      = jz.value("panEasing",      1);
        t.zoomPanRot.rotEasing      = jz.value("rotEasing",      1);
        t.zoomPanRot.overshoot      = jz.value("overshoot",      1.70158f);
    }

    if (j.contains("slideNoteEffect") && j.at("slideNoteEffect").is_object()) {
        const auto& js = j.at("slideNoteEffect");
        t.slideNoteEffect.type = static_cast<SlideNoteEffectSettings::EffectType>(
            js.value("type", 0));
        t.slideNoteEffect.durationMode = static_cast<SlideNoteEffectSettings::DurationMode>(
            js.value("durationMode", 0));
        t.slideNoteEffect.fixedDurationMs     = js.value("fixedDurationMs",     300.0f);
        t.slideNoteEffect.slideZoomDelta      = js.value("slideZoomDelta",      1.0f);
        t.slideNoteEffect.slidePanXDelta      = js.value("slidePanXDelta",      0.0f);
        t.slideNoteEffect.slidePanYDelta      = js.value("slidePanYDelta",      0.0f);
        t.slideNoteEffect.slideRotationDelta  = js.value("slideRotationDelta",  0.0f);
        t.slideNoteEffect.slideBounceDistance = js.value("slideBounceDistance", 0.0f);
        t.slideNoteEffect.slideBounceDirDeg   = js.value("slideBounceDirDeg",   0.0f);
        t.slideNoteEffect.slideTVIntensity    = js.value("slideTVIntensity",    0.0f);
    }

    t.visualEffectChain.clear();
    if (j.contains("visualEffectChain") && j.at("visualEffectChain").is_array()) {
        for (const auto& fj : j.at("visualEffectChain")) {
            VisualEffect fx;
            fx.type     = stringToVisualEffectType(fj.value("type", std::string("Desaturation")));
            fx.bypassed = fj.value("bypassed", false);
            if (fj.contains("params")) {
                visualEffectParamsFromNamedJson(fx.type, fj.at("params"), fx.params);
            } else {
                for (int i = 0; i < 16; ++i) fx.params[i] = 0.0f;
            }
            t.visualEffectChain.push_back(fx);
        }
    }
}
