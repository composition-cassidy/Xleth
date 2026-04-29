#include "SampleRegion.h"

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
        {"rootNote",         r.rootNote},
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
        {"loopEnabled",      r.loopEnabled},
        {"loopStart",        r.loopStart},
        {"loopEnd",          r.loopEnd},
        {"crossfadeEnabled", r.crossfadeEnabled},
        {"smpStart",         r.smpStart},
        {"smpLength",        r.smpLength},
        {"declickMs",        r.declickMs},
        {"fadeInMs",         r.fadeInMs},
        {"fadeOutMs",        r.fadeOutMs},
        {"crossfadeSamples", r.crossfadeSamples},
        {"dcOffsetRemoved",  r.dcOffsetRemoved},
        {"normalized",       r.normalized},
        {"polarityReversed", r.polarityReversed},
        {"reversed",         r.reversed},
        {"monoEnabled",       r.monoEnabled},
        {"portamentoEnabled", r.portamentoEnabled},
        {"portamentoTimeMs",  r.portamentoTimeMs},
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
        {"proxyEndTime",     r.proxyEndTime}
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
    j.at("rootNote").get_to(r.rootNote);
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
    if (j.contains("loopEnabled"))      j.at("loopEnabled").get_to(r.loopEnabled);
    if (j.contains("loopStart"))        j.at("loopStart").get_to(r.loopStart);
    if (j.contains("loopEnd"))          j.at("loopEnd").get_to(r.loopEnd);
    if (j.contains("crossfadeEnabled")) j.at("crossfadeEnabled").get_to(r.crossfadeEnabled);
    if (j.contains("smpStart"))        j.at("smpStart").get_to(r.smpStart);
    if (j.contains("smpLength"))       j.at("smpLength").get_to(r.smpLength);
    if (j.contains("declickMs"))       j.at("declickMs").get_to(r.declickMs);
    else if (j.contains("declickSamples")) {
        int ds = 64; j.at("declickSamples").get_to(ds);
        r.declickMs = static_cast<float>(ds * 1000.0 / 44100.0);
    }
    if (j.contains("fadeInMs"))        j.at("fadeInMs").get_to(r.fadeInMs);
    if (j.contains("fadeOutMs"))       j.at("fadeOutMs").get_to(r.fadeOutMs);
    if (j.contains("crossfadeSamples")) j.at("crossfadeSamples").get_to(r.crossfadeSamples);
    if (j.contains("dcOffsetRemoved"))  j.at("dcOffsetRemoved").get_to(r.dcOffsetRemoved);
    if (j.contains("normalized"))       j.at("normalized").get_to(r.normalized);
    if (j.contains("polarityReversed")) j.at("polarityReversed").get_to(r.polarityReversed);
    if (j.contains("reversed"))         j.at("reversed").get_to(r.reversed);
    if (j.contains("monoEnabled"))       j.at("monoEnabled").get_to(r.monoEnabled);
    if (j.contains("portamentoEnabled")) j.at("portamentoEnabled").get_to(r.portamentoEnabled);
    if (j.contains("portamentoTimeMs"))  j.at("portamentoTimeMs").get_to(r.portamentoTimeMs);
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
    j.at("syllables").get_to(r.syllables);
    // On-demand proxy fields (added in proxy redesign). Default values on
    // legacy projects mean "no proxy yet" — will be generated on next grid-cell placement.
    if (j.contains("proxyPath"))      j.at("proxyPath").get_to(r.proxyPath);
    if (j.contains("proxyReady"))     j.at("proxyReady").get_to(r.proxyReady);
    if (j.contains("proxyStartTime")) j.at("proxyStartTime").get_to(r.proxyStartTime);
    if (j.contains("proxyEndTime"))   j.at("proxyEndTime").get_to(r.proxyEndTime);
}
