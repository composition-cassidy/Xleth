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
        {"mangleMode",       s.mangleMode},
        {"mangleAmount",     s.mangleAmount},
        {"mangleMix",        s.mangleMix},
        {"prepAlgorithm",    s.prepAlgorithm},
        {"prepStretch",      s.prepStretch},
        {"prepShiftCents",   s.prepShiftCents},
        {"dcOffsetRemoved",  s.dcOffsetRemoved},
        {"normalized",       s.normalized},
        {"polarityReversed", s.polarityReversed},
        {"reversed",         s.reversed}
    };
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
    // MANGLE is absent on every pre-MANGLE project; the default is mode Off,
    // which is a genuine bypass, so those slots deserialize bit-identical.
    s.mangleMode        = j.value("mangleMode",        s.mangleMode);
    s.mangleAmount      = j.value("mangleAmount",      s.mangleAmount);
    s.mangleMix         = j.value("mangleMix",         s.mangleMix);
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
        {"attackMs",         r.attackMs},
        {"decayMs",          r.decayMs},
        {"sustain",          r.sustain},
        {"releaseMs",        r.releaseMs},
        {"delayMs",          r.delayMs},
        {"holdMs",           r.holdMs},
        {"attackTension",    r.attackTension},
        {"decayTension",     r.decayTension},
        {"releaseTension",   r.releaseTension},
        {"pitchEnvEnabled",        r.pitchEnvEnabled},
        {"pitchEnvAmount",         r.pitchEnvAmount},
        {"pitchEnvDelayMs",        r.pitchEnvDelayMs},
        {"pitchEnvAttackMs",       r.pitchEnvAttackMs},
        {"pitchEnvHoldMs",         r.pitchEnvHoldMs},
        {"pitchEnvDecayMs",        r.pitchEnvDecayMs},
        {"pitchEnvSustain",        r.pitchEnvSustain},
        {"pitchEnvReleaseMs",      r.pitchEnvReleaseMs},
        {"pitchEnvAttackTension",  r.pitchEnvAttackTension},
        {"pitchEnvDecayTension",   r.pitchEnvDecayTension},
        {"pitchEnvReleaseTension", r.pitchEnvReleaseTension},
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
    // LFO waveform arrays (serialised separately since nlohmann::json
    // doesn't know about LfoBreakpoint).
    auto serializeWaveform = [](const std::vector<SampleRegion::LfoBreakpoint>& wf) {
        nlohmann::json arr = nlohmann::json::array();
        for (const auto& bp : wf)
            arr.push_back({{"t", bp.time}, {"v", bp.value}});
        return arr;
    };
    // Volume LFO
    j["lfoVolEnabled"]       = r.lfoVolEnabled;
    j["lfoVolAmount"]        = r.lfoVolAmount;
    j["lfoVolSpeedHz"]       = r.lfoVolSpeedHz;
    j["lfoVolTempoSync"]     = r.lfoVolTempoSync;
    j["lfoVolTempoDivision"] = r.lfoVolTempoDivision;
    j["lfoVolAttackMs"]      = r.lfoVolAttackMs;
    j["lfoVolDelayMs"]       = r.lfoVolDelayMs;
    j["lfoVolWaveform"]      = serializeWaveform(r.lfoVolWaveform);
    // Panning LFO
    j["lfoPanEnabled"]       = r.lfoPanEnabled;
    j["lfoPanAmount"]        = r.lfoPanAmount;
    j["lfoPanSpeedHz"]       = r.lfoPanSpeedHz;
    j["lfoPanTempoSync"]     = r.lfoPanTempoSync;
    j["lfoPanTempoDivision"] = r.lfoPanTempoDivision;
    j["lfoPanAttackMs"]      = r.lfoPanAttackMs;
    j["lfoPanDelayMs"]       = r.lfoPanDelayMs;
    j["lfoPanWaveform"]      = serializeWaveform(r.lfoPanWaveform);
    // Pitch LFO
    j["lfoPitchEnabled"]       = r.lfoPitchEnabled;
    j["lfoPitchAmount"]        = r.lfoPitchAmount;
    j["lfoPitchSpeedHz"]       = r.lfoPitchSpeedHz;
    j["lfoPitchTempoSync"]     = r.lfoPitchTempoSync;
    j["lfoPitchTempoDivision"] = r.lfoPitchTempoDivision;
    j["lfoPitchAttackMs"]      = r.lfoPitchAttackMs;
    j["lfoPitchDelayMs"]       = r.lfoPitchDelayMs;
    j["lfoPitchWaveform"]      = serializeWaveform(r.lfoPitchWaveform);

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
    // Sampler settings (added in sampler-per-region refactor). Defaults keep
    // legacy projects loading cleanly; Timeline's loader migrates any fields
    // that old projects still carry on Pattern onto the matching region.
    if (j.contains("attackMs"))         j.at("attackMs").get_to(r.attackMs);
    if (j.contains("decayMs"))          j.at("decayMs").get_to(r.decayMs);
    if (j.contains("sustain"))          j.at("sustain").get_to(r.sustain);
    if (j.contains("releaseMs"))        j.at("releaseMs").get_to(r.releaseMs);
    if (j.contains("delayMs"))          j.at("delayMs").get_to(r.delayMs);
    if (j.contains("holdMs"))           j.at("holdMs").get_to(r.holdMs);
    if (j.contains("attackTension"))    j.at("attackTension").get_to(r.attackTension);
    if (j.contains("decayTension"))     j.at("decayTension").get_to(r.decayTension);
    if (j.contains("releaseTension"))   j.at("releaseTension").get_to(r.releaseTension);
    if (j.contains("pitchEnvEnabled"))        j.at("pitchEnvEnabled").get_to(r.pitchEnvEnabled);
    if (j.contains("pitchEnvAmount"))         j.at("pitchEnvAmount").get_to(r.pitchEnvAmount);
    if (j.contains("pitchEnvDelayMs"))        j.at("pitchEnvDelayMs").get_to(r.pitchEnvDelayMs);
    if (j.contains("pitchEnvAttackMs"))       j.at("pitchEnvAttackMs").get_to(r.pitchEnvAttackMs);
    if (j.contains("pitchEnvHoldMs"))         j.at("pitchEnvHoldMs").get_to(r.pitchEnvHoldMs);
    if (j.contains("pitchEnvDecayMs"))        j.at("pitchEnvDecayMs").get_to(r.pitchEnvDecayMs);
    if (j.contains("pitchEnvSustain"))        j.at("pitchEnvSustain").get_to(r.pitchEnvSustain);
    if (j.contains("pitchEnvReleaseMs"))      j.at("pitchEnvReleaseMs").get_to(r.pitchEnvReleaseMs);
    if (j.contains("pitchEnvAttackTension"))  j.at("pitchEnvAttackTension").get_to(r.pitchEnvAttackTension);
    if (j.contains("pitchEnvDecayTension"))   j.at("pitchEnvDecayTension").get_to(r.pitchEnvDecayTension);
    if (j.contains("pitchEnvReleaseTension")) j.at("pitchEnvReleaseTension").get_to(r.pitchEnvReleaseTension);
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
    // LFO deserialization
    auto deserializeWaveform = [](const nlohmann::json& arr, std::vector<SampleRegion::LfoBreakpoint>& out) {
        out.clear();
        for (const auto& bp : arr) {
            SampleRegion::LfoBreakpoint pt;
            pt.time  = bp.value("t", 0.0f);
            pt.value = bp.value("v", 0.0f);
            out.push_back(pt);
        }
    };
    // Volume LFO
    if (j.contains("lfoVolEnabled"))       j.at("lfoVolEnabled").get_to(r.lfoVolEnabled);
    if (j.contains("lfoVolAmount"))        j.at("lfoVolAmount").get_to(r.lfoVolAmount);
    if (j.contains("lfoVolSpeedHz"))       j.at("lfoVolSpeedHz").get_to(r.lfoVolSpeedHz);
    if (j.contains("lfoVolTempoSync"))     j.at("lfoVolTempoSync").get_to(r.lfoVolTempoSync);
    if (j.contains("lfoVolTempoDivision")) j.at("lfoVolTempoDivision").get_to(r.lfoVolTempoDivision);
    if (j.contains("lfoVolAttackMs"))      j.at("lfoVolAttackMs").get_to(r.lfoVolAttackMs);
    if (j.contains("lfoVolDelayMs"))       j.at("lfoVolDelayMs").get_to(r.lfoVolDelayMs);
    if (j.contains("lfoVolWaveform"))      deserializeWaveform(j["lfoVolWaveform"], r.lfoVolWaveform);
    // Panning LFO
    if (j.contains("lfoPanEnabled"))       j.at("lfoPanEnabled").get_to(r.lfoPanEnabled);
    if (j.contains("lfoPanAmount"))        j.at("lfoPanAmount").get_to(r.lfoPanAmount);
    if (j.contains("lfoPanSpeedHz"))       j.at("lfoPanSpeedHz").get_to(r.lfoPanSpeedHz);
    if (j.contains("lfoPanTempoSync"))     j.at("lfoPanTempoSync").get_to(r.lfoPanTempoSync);
    if (j.contains("lfoPanTempoDivision")) j.at("lfoPanTempoDivision").get_to(r.lfoPanTempoDivision);
    if (j.contains("lfoPanAttackMs"))      j.at("lfoPanAttackMs").get_to(r.lfoPanAttackMs);
    if (j.contains("lfoPanDelayMs"))       j.at("lfoPanDelayMs").get_to(r.lfoPanDelayMs);
    if (j.contains("lfoPanWaveform"))      deserializeWaveform(j["lfoPanWaveform"], r.lfoPanWaveform);
    // Pitch LFO
    if (j.contains("lfoPitchEnabled"))       j.at("lfoPitchEnabled").get_to(r.lfoPitchEnabled);
    if (j.contains("lfoPitchAmount"))        j.at("lfoPitchAmount").get_to(r.lfoPitchAmount);
    if (j.contains("lfoPitchSpeedHz"))       j.at("lfoPitchSpeedHz").get_to(r.lfoPitchSpeedHz);
    if (j.contains("lfoPitchTempoSync"))     j.at("lfoPitchTempoSync").get_to(r.lfoPitchTempoSync);
    if (j.contains("lfoPitchTempoDivision")) j.at("lfoPitchTempoDivision").get_to(r.lfoPitchTempoDivision);
    if (j.contains("lfoPitchAttackMs"))      j.at("lfoPitchAttackMs").get_to(r.lfoPitchAttackMs);
    if (j.contains("lfoPitchDelayMs"))       j.at("lfoPitchDelayMs").get_to(r.lfoPitchDelayMs);
    if (j.contains("lfoPitchWaveform"))      deserializeWaveform(j["lfoPitchWaveform"], r.lfoPitchWaveform);
    // Modulation system (schema 3). Absent on every schema-2 project, which
    // leaves the default empty route list — an exact bypass.
    if (j.contains("modulation")) xleth::sampmod::from_json(j["modulation"], r.modulation);

    // ── Schema 3 → 4 migration ───────────────────────────────────────────────
    // Reads the LEGACY KEYS straight out of `j`, so it keeps working after the
    // struct fields are gone. Gated on the region carrying no routes yet, which
    // makes it idempotent and stops it from ever clobbering routes a user built
    // in the new system. Schema 4 files no longer WRITE the legacy keys, so on
    // those hasLegacyModulation() is false and this costs four map lookups.
    if (r.modulation.numRoutes == 0
        && xleth::samplegacy::hasLegacyModulation(j))
    {
        int occupied = 0;
        for (const auto& s : r.slots) if (!s.audioFilePath.empty()) ++occupied;
        if (occupied == 0) occupied = 1;   // slot 0 plays the region's own audio
        xleth::samplegacy::migrateLegacyModulation(j, occupied, 120.0, r.modulation);
    }

    // ENV 1 is a derived VIEW of the amplitude envelope — the amp scalars above
    // remain its storage of record and the VCA keeps driving amplitude and
    // voice lifecycle. Syncing on every load (not just legacy ones) is what
    // keeps the rack's ENV 1 showing the envelope that is actually sounding.
    xleth::samplegacy::syncAmpEnvelopeToEnv1(
        r.delayMs, r.attackMs, r.holdMs, r.decayMs, r.sustain, r.releaseMs,
        r.attackTension, r.decayTension, r.releaseTension, r.modulation);

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
