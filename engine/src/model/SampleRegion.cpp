#include "SampleRegion.h"
#include "SamplerLegacyMigration.h"

void to_json(nlohmann::json& j, const SampleRegion::Syllable& s) {
    j = nlohmann::json{
        {"startTime", s.startTime},
        {"endTime",   s.endTime},
        {"number",    s.number},
        {"text",      s.text}
    };
}

void from_json(const nlohmann::json& j, SampleRegion::Syllable& s) {
    j.at("startTime").get_to(s.startTime);
    j.at("endTime").get_to(s.endTime);
    j.at("number").get_to(s.number);
    j.at("text").get_to(s.text);
}

// ─── SampleSlot ───────────────────────────────────────────────────────────────
// Slots are written as a "slots" array on the region. Legacy projects have no
// such array — from_json(SampleRegion) synthesises slot 0 from the old
// top-level scalars instead, which is what makes the migration lossless.

void to_json(nlohmann::json& j, const SampleSlot& s) {
    j = nlohmann::json{
        {"audioFilePath",    s.audioFilePath},
        {"name",             s.name},
        {"rootNote",         s.rootNote},
        {"octave",           s.octave},
        {"semitone",         s.semitone},
        {"fine",             s.fine},
        {"coarse",           s.coarse},
        {"volume",           s.volume},
        {"pan",              s.pan},
        {"mute",             s.mute},
        {"solo",             s.solo},
        {"smpStart",         s.smpStart},
        {"smpLength",        s.smpLength},
        {"declickMs",        s.declickMs},
        {"fadeInMs",         s.fadeInMs},
        {"fadeOutMs",        s.fadeOutMs},
        {"loopEnabled",      s.loopEnabled},
        {"loopStart",        s.loopStart},
        {"loopEnd",          s.loopEnd},
        {"crossfadeSamples", s.crossfadeSamples},
        {"loopMode",         s.loopMode},
        {"exitLoopOnRelease", s.exitLoopOnRelease},
        {"prepAlgorithm",    s.prepAlgorithm},
        {"prepStretch",      s.prepStretch},
        {"prepShiftCents",   s.prepShiftCents},
        {"dcOffsetRemoved",  s.dcOffsetRemoved},
        {"normalized",       s.normalized},
        {"polarityReversed", s.polarityReversed},
        {"reversed",         s.reversed}
    };

    // MANGLE chain (schema 5+). Written as an ordered array; each entry is one
    // instance. An empty chain writes an empty array — a slot with no MANGLE.
    nlohmann::json chain = nlohmann::json::array();
    for (const auto& mi : s.mangleChain) {
        chain.push_back({
            {"mode",   mi.mode},
            {"amount", mi.amount},
            {"mix",    mi.mix},
            {"bypass", mi.bypass}
        });
    }
    j["mangleChain"] = std::move(chain);
}

void from_json(const nlohmann::json& j, SampleSlot& s) {
    s.audioFilePath    = j.value("audioFilePath",    s.audioFilePath);
    s.name             = j.value("name",             s.name);
    s.rootNote         = j.value("rootNote",         s.rootNote);
    s.octave           = j.value("octave",           s.octave);
    s.semitone         = j.value("semitone",         s.semitone);
    s.fine             = j.value("fine",             s.fine);
    s.coarse           = j.value("coarse",           s.coarse);
    s.volume           = j.value("volume",           s.volume);
    s.pan              = j.value("pan",              s.pan);
    s.mute             = j.value("mute",             s.mute);
    s.solo             = j.value("solo",             s.solo);
    s.smpStart         = j.value("smpStart",         s.smpStart);
    s.smpLength        = j.value("smpLength",        s.smpLength);
    s.declickMs        = j.value("declickMs",        s.declickMs);
    s.fadeInMs         = j.value("fadeInMs",         s.fadeInMs);
    s.fadeOutMs        = j.value("fadeOutMs",        s.fadeOutMs);
    s.loopEnabled      = j.value("loopEnabled",      s.loopEnabled);
    s.loopStart        = j.value("loopStart",        s.loopStart);
    s.loopEnd          = j.value("loopEnd",          s.loopEnd);
    s.crossfadeSamples = j.value("crossfadeSamples", s.crossfadeSamples);
    // Absent on projects saved before loop modes / PREP existed — the defaults
    // (Forward, no exit-on-release, unity stretch and shift) are exactly the
    // old behaviour, so a legacy slot deserializes to a bit-identical player.
    s.loopMode          = j.value("loopMode",          s.loopMode);
    s.exitLoopOnRelease = j.value("exitLoopOnRelease", s.exitLoopOnRelease);
    // MANGLE chain (schema 5+). Three cases, in priority order:
    //  1. "mangleChain" present  → read the ordered array directly.
    //  2. legacy "mangleMode"    → migrate the single MANGLE to a one-instance
    //     chain with identical values (and therefore identical sound); a legacy
    //     mode of Off migrates to an EMPTY chain, which is the same silent
    //     bypass without carrying a phantom Off instance into the new UI.
    //  3. neither (pre-MANGLE)   → empty chain, i.e. no MANGLE. Bit-identical.
    s.mangleChain.clear();
    if (j.contains("mangleChain") && j.at("mangleChain").is_array()) {
        for (const auto& e : j.at("mangleChain")) {
            MangleInstance mi;
            mi.mode   = e.value("mode",   0);
            mi.amount = e.value("amount", 0.0f);
            mi.mix    = e.value("mix",    1.0f);
            mi.bypass = e.value("bypass", false);
            s.mangleChain.push_back(mi);
        }
    } else if (j.contains("mangleMode")) {
        const int mode = j.value("mangleMode", 0);
        if (mode != 0) {
            MangleInstance mi;
            mi.mode   = mode;
            mi.amount = j.value("mangleAmount", 0.0f);
            mi.mix    = j.value("mangleMix",    1.0f);
            mi.bypass = false;
            s.mangleChain.push_back(mi);
        }
    }
    s.prepAlgorithm     = j.value("prepAlgorithm",     s.prepAlgorithm);
    s.prepStretch       = j.value("prepStretch",       s.prepStretch);
    s.prepShiftCents    = j.value("prepShiftCents",    s.prepShiftCents);
    s.dcOffsetRemoved  = j.value("dcOffsetRemoved",  s.dcOffsetRemoved);
    s.normalized       = j.value("normalized",       s.normalized);
    s.polarityReversed = j.value("polarityReversed", s.polarityReversed);
    s.reversed         = j.value("reversed",         s.reversed);
}

void to_json(nlohmann::json& j, const SampleRegion& r) {
    j = nlohmann::json{
        {"id",               r.id},
        {"sourceId",         r.sourceId},
        {"name",             r.name},
        {"label",            sampleLabelToString(r.label)},
        {"customLabelName",  r.customLabelName},
        {"startTime",        r.startTime},
        {"endTime",          r.endTime},
        {"startFrame",       r.startFrame},
        {"endFrame",         r.endFrame},
        {"audioFilePath",    r.audioFilePath},
        {"swappedAudioPath", r.swappedAudioPath},
        {"hasSwappedAudio",  r.hasSwappedAudio},
        {"swappedAudioDurationSec", r.swappedAudioDurationSec},
        {"crossfadeEnabled", r.crossfadeEnabled},
        {"slots",            r.slots},
        {"monoEnabled",       r.monoEnabled},
        {"portamentoEnabled", r.portamentoEnabled},
        {"portamentoTimeMs",  r.portamentoTimeMs},
        {"portamentoMode",    r.portamentoMode},
        {"portamentoCurve",   r.portamentoCurve},
        {"legatoEnabled",     r.legatoEnabled},
        {"voiceCount",        r.voiceCount},
        {"arpEnabled",        r.arpEnabled},
        {"arpTempoSync",      r.arpTempoSync},
        {"arpDivision",       r.arpDivision},
        {"arpFreeTimeMs",     r.arpFreeTimeMs},
        {"arpGate",           r.arpGate},
        {"arpRange",          r.arpRange},
        {"arpDirection",      r.arpDirection},
        {"syllables",        r.syllables},
        {"proxyPath",        r.proxyPath},
        {"proxyReady",       r.proxyReady},
        {"proxyStartTime",   r.proxyStartTime},
        {"proxyEndTime",     r.proxyEndTime},
        {"swappedVideoPath",             r.swappedVideoPath},
        {"hasSwappedVideo",              r.hasSwappedVideo},
        {"swappedVideoDurationSec",      r.swappedVideoDurationSec},
        {"swappedVideoDurationMismatch", r.swappedVideoDurationMismatch},
        {"swappedVideoWidth",            r.swappedVideoWidth},
        {"swappedVideoHeight",           r.swappedVideoHeight}
    };
    // ── Modulation system (schema 3) ─────────────────────────────────────────
    // Always written, even when bypassed: the reader is tolerant of a missing
    // key (that is how schema-2 projects load), but a round trip through this
    // engine should be byte-stable rather than dropping the key when empty.
    j["modulation"] = r.modulation;
}

void from_json(const nlohmann::json& j, SampleRegion& r) {
    j.at("id").get_to(r.id);
    j.at("sourceId").get_to(r.sourceId);
    j.at("name").get_to(r.name);
    r.label = stringToSampleLabel(j.at("label").get<std::string>());
    j.at("customLabelName").get_to(r.customLabelName);
    j.at("startTime").get_to(r.startTime);
    j.at("endTime").get_to(r.endTime);
    j.at("startFrame").get_to(r.startFrame);
    j.at("endFrame").get_to(r.endFrame);
    j.at("audioFilePath").get_to(r.audioFilePath);
    j.at("swappedAudioPath").get_to(r.swappedAudioPath);
    j.at("hasSwappedAudio").get_to(r.hasSwappedAudio);
    if (j.contains("swappedAudioDurationSec"))
        j.at("swappedAudioDurationSec").get_to(r.swappedAudioDurationSec);
    // else: defaults to 0; project_load migration probes the file and fills it in.
    // The amp/pitch envelopes and three drawable LFOs are no longer struct
    // fields — they live in the modulation config and are migrated in from the
    // raw legacy JSON keys below (SamplerLegacyMigration).
    if (j.contains("crossfadeEnabled")) j.at("crossfadeEnabled").get_to(r.crossfadeEnabled);

    // ── Sample slots ─────────────────────────────────────────────────────────
    // Schema >= 2 carries a "slots" array. Schema 1 (legacy, single-sample)
    // carries the per-sample state as top-level scalars on the region; those
    // are read into slot 0 so a legacy project sounds byte-identical after the
    // upgrade. Slots 1..7 simply did not exist, so nothing else is lost.
    r.slots.clear();
    if (j.contains("slots") && j["slots"].is_array() && !j["slots"].empty()) {
        for (const auto& sj : j["slots"]) {
            if (static_cast<int>(r.slots.size()) >= MAX_SAMPLE_SLOTS) break;
            SampleSlot s;
            from_json(sj, s);
            r.slots.push_back(std::move(s));
        }
    } else {
        SampleSlot s;   // legacy migration target — slot 0
        if (j.contains("rootNote"))         j.at("rootNote").get_to(s.rootNote);
        if (j.contains("loopEnabled"))      j.at("loopEnabled").get_to(s.loopEnabled);
        if (j.contains("loopStart"))        j.at("loopStart").get_to(s.loopStart);
        if (j.contains("loopEnd"))          j.at("loopEnd").get_to(s.loopEnd);
        if (j.contains("smpStart"))         j.at("smpStart").get_to(s.smpStart);
        if (j.contains("smpLength"))        j.at("smpLength").get_to(s.smpLength);
        if (j.contains("declickMs"))        j.at("declickMs").get_to(s.declickMs);
        else if (j.contains("declickSamples")) {
            // Pre-declickMs projects stored a raw sample count baked at 44.1 kHz.
            int ds = 64; j.at("declickSamples").get_to(ds);
            s.declickMs = static_cast<float>(ds * 1000.0 / 44100.0);
        }
        if (j.contains("fadeInMs"))         j.at("fadeInMs").get_to(s.fadeInMs);
        if (j.contains("fadeOutMs"))        j.at("fadeOutMs").get_to(s.fadeOutMs);
        if (j.contains("crossfadeSamples")) j.at("crossfadeSamples").get_to(s.crossfadeSamples);
        if (j.contains("dcOffsetRemoved"))  j.at("dcOffsetRemoved").get_to(s.dcOffsetRemoved);
        if (j.contains("normalized"))       j.at("normalized").get_to(s.normalized);
        if (j.contains("polarityReversed")) j.at("polarityReversed").get_to(s.polarityReversed);
        if (j.contains("reversed"))         j.at("reversed").get_to(s.reversed);
        r.slots.push_back(std::move(s));
    }
    if (r.slots.empty()) r.slots.emplace_back();   // invariant: never zero slots

    if (j.contains("monoEnabled"))       j.at("monoEnabled").get_to(r.monoEnabled);
    if (j.contains("portamentoEnabled")) j.at("portamentoEnabled").get_to(r.portamentoEnabled);
    if (j.contains("portamentoTimeMs"))  j.at("portamentoTimeMs").get_to(r.portamentoTimeMs);
    // Absent in schema < 4. The defaults (ALWAYS, linear, no legato, 32 voices)
    // are exactly the pre-voicing behaviour, so an old project is unchanged.
    if (j.contains("portamentoMode"))    j.at("portamentoMode").get_to(r.portamentoMode);
    if (j.contains("portamentoCurve"))   j.at("portamentoCurve").get_to(r.portamentoCurve);
    if (j.contains("legatoEnabled"))     j.at("legatoEnabled").get_to(r.legatoEnabled);
    if (j.contains("voiceCount"))        j.at("voiceCount").get_to(r.voiceCount);
    if (j.contains("arpEnabled"))        j.at("arpEnabled").get_to(r.arpEnabled);
    if (j.contains("arpTempoSync"))      j.at("arpTempoSync").get_to(r.arpTempoSync);
    if (j.contains("arpDivision"))       j.at("arpDivision").get_to(r.arpDivision);
    if (j.contains("arpFreeTimeMs"))     j.at("arpFreeTimeMs").get_to(r.arpFreeTimeMs);
    if (j.contains("arpGate"))           j.at("arpGate").get_to(r.arpGate);
    if (j.contains("arpRange"))          j.at("arpRange").get_to(r.arpRange);
    if (j.contains("arpDirection"))      j.at("arpDirection").get_to(r.arpDirection);
    // Modulation system (schema 3+). Absent on every schema-2 project, which
    // leaves the default empty route list — an exact bypass.
    if (j.contains("modulation")) {
        xleth::sampmod::from_json(j["modulation"], r.modulation);
    } else {
        // Schema-2 region — predates dynamic LFO presence. Clear the fresh-region
        // default (LFO 1 present) so migration below adds only the legacy LFOs
        // that were actually enabled and an old file never sprouts a phantom LFO.
        r.modulation.lfoPresent = { { false, false, false, false, false, false } };
    }

    // ── Legacy amp envelope → ENV 1 (the VCA source) ─────────────────────────
    // The amplitude DAHDSR used to be flat region scalars; it is ENV 1 now. A
    // project saved before that move carries "attackMs" etc. in its JSON, so
    // migrate them into envs[0]. Files saved after the move omit those keys, so
    // the ENV 1 loaded from "modulation" above stands — presence of the key is
    // the version discriminator, and it never clobbers a user-edited ENV 1.
    if (j.contains("attackMs"))
        xleth::samplegacy::migrateLegacyAmpEnvelope(j, r.modulation);

    // ── Legacy pitch envelope + 3 drawable LFOs → routes ─────────────────────
    // Reads the LEGACY KEYS straight out of `j`, so it keeps working now that
    // the struct fields are gone. Idempotent: gated on the region carrying no
    // routes yet, so it never clobbers routes a user built in the new system.
    // Post-migration files omit the legacy keys, so hasLegacyModulation() is
    // false and this costs a few map lookups. The legacy engine paths are gone,
    // so there is nothing left to disable to avoid double application.
    if (r.modulation.numRoutes == 0
        && xleth::samplegacy::hasLegacyModulation(j))
    {
        int occupied = 0;
        for (const auto& s : r.slots) if (!s.audioFilePath.empty()) ++occupied;
        if (occupied == 0) occupied = 1;   // slot 0 plays the region's own audio
        xleth::samplegacy::migrateLegacyModulation(j, occupied, 120.0, r.modulation);
    }

    j.at("syllables").get_to(r.syllables);
    // On-demand proxy fields (added in proxy redesign). Default values on
    // legacy projects mean "no proxy yet" — will be generated on next grid-cell placement.
    if (j.contains("proxyPath"))      j.at("proxyPath").get_to(r.proxyPath);
    if (j.contains("proxyReady"))     j.at("proxyReady").get_to(r.proxyReady);
    if (j.contains("proxyStartTime")) j.at("proxyStartTime").get_to(r.proxyStartTime);
    if (j.contains("proxyEndTime"))   j.at("proxyEndTime").get_to(r.proxyEndTime);
    // Swapped video fields (added for video swap/export feature). Defaults on
    // legacy projects mean "no video swap" — region plays its original source video.
    if (j.contains("swappedVideoPath"))
        j.at("swappedVideoPath").get_to(r.swappedVideoPath);
    if (j.contains("hasSwappedVideo"))
        j.at("hasSwappedVideo").get_to(r.hasSwappedVideo);
    if (j.contains("swappedVideoDurationSec"))
        j.at("swappedVideoDurationSec").get_to(r.swappedVideoDurationSec);
    if (j.contains("swappedVideoDurationMismatch"))
        j.at("swappedVideoDurationMismatch").get_to(r.swappedVideoDurationMismatch);
    if (j.contains("swappedVideoWidth"))
        j.at("swappedVideoWidth").get_to(r.swappedVideoWidth);
    if (j.contains("swappedVideoHeight"))
        j.at("swappedVideoHeight").get_to(r.swappedVideoHeight);
}
