#include "audio/StockParameterCatalog.h"
#include "audio/XlethEffectBase.h"

#include <juce_audio_processors/juce_audio_processors.h>

#include <algorithm>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

namespace xleth::audio {

namespace {

// Curated metadata for a single parameter on a stock plugin.  Range/default
// come from the APVTS at runtime so this table only carries the human-side
// fields that APVTS does not know about: human labels and grouping.
struct StaticDesc
{
    std::string_view paramId;
    std::string_view label;
    std::string_view compactLabel;   // empty → fall back to label
    std::string_view group;
    std::string_view unit;
    std::string_view scale;          // empty == linear
};

using DescTable = std::vector<StaticDesc>;

const DescTable& tableFor(const std::string& pluginId)
{
    static const std::unordered_map<std::string, DescTable> kTables = {
        { "delay", {
            { "time_l",       "Time L",        "L",      "Time",     "ms",  "log" },
            { "time_r",       "Time R",        "R",      "Time",     "ms",  "log" },
            { "feedback",     "Feedback",      "FB",     "Feedback", "%",   ""    },
            { "filter_lo",    "Filter Low",    "LP",     "Filter",   "Hz",  "log" },
            { "filter_hi",    "Filter High",   "HP",     "Filter",   "Hz",  "log" },
            { "mod_rate",     "Mod Rate",      "Rate",   "Mod",      "Hz",  "log" },
            { "mod_depth",    "Mod Depth",     "Depth",  "Mod",      "%",   ""    },
            { "stereo_width", "Stereo Width",  "Width",  "Stereo",   "%",   ""    },
            { "duck_amount",  "Duck Amount",   "Duck",   "Dynamics", "%",   ""    },
            { "mix",          "Mix",           "Mix",    "Output",   "%",   ""    },
        }},
        { "reverb", {
            { "predelay",   "Predelay",     "PreDly", "Time",     "ms",  ""    },
            { "decay",      "Decay",        "Decay",  "Time",     "s",   "log" },
            { "size",       "Size",         "Size",   "Space",    "",    ""    },
            { "damping",    "Damping",      "Damp",   "Tone",     "%",   ""    },
            { "mod_rate",   "Mod Rate",     "Rate",   "Mod",      "Hz",  "log" },
            { "mod_depth",  "Mod Depth",    "Depth",  "Mod",      "%",   ""    },
            { "er_level",   "ER Level",     "ER",     "ER",       "dB",  ""    },
            { "er_late",    "ER → Late",    "ER→L",   "ER",       "",    ""    },
            { "hicut",      "Hi Cut",       "HiCut",  "Filter",   "Hz",  "log" },
            { "locut",      "Lo Cut",       "LoCut",  "Filter",   "Hz",  "log" },
            { "mix",        "Mix",          "Mix",    "Output",   "%",   ""    },
            { "smoothness", "Smoothness",   "Smooth", "Mod",      "",    ""    },
        }},
        { "flanger", {
            { "delay",    "Delay",    "Dly",  "Time",     "ms", ""    },
            { "rate",     "Rate",     "Rate", "Mod",      "Hz", "log" },
            { "depth",    "Depth",    "Dpth", "Mod",      "%",  ""    },
            { "feedback", "Feedback", "FB",   "Feedback", "%",  ""    },
            { "width",    "Width",    "W",    "Stereo",   "%",  ""    },
            { "mix",      "Mix",      "Mix",  "Output",   "%",  ""    },
        }},
        { "chorus", {
            { "delay",    "Delay",    "Dly",  "Time",     "ms", ""    },
            { "rate",     "Rate",     "Rate", "Mod",      "Hz", "log" },
            { "depth",    "Depth",    "Dpth", "Mod",      "%",  ""    },
            { "feedback", "Feedback", "FB",   "Feedback", "%",  ""    },
            { "width",    "Width",    "W",    "Stereo",   "%",  ""    },
            { "mix",      "Mix",      "Mix",  "Output",   "%",  ""    },
        }},
        { "phaser", {
            { "rate",      "Rate",       "Rate", "Mod",      "Hz", "log" },
            { "depth",     "Depth",      "Dpth", "Mod",      "%",  ""    },
            { "feedback",  "Feedback",   "FB",   "Feedback", "%",  ""    },
            { "resonance", "Resonance",  "Res",  "Tone",     "",   ""    },
            { "width",     "Width",      "W",    "Stereo",   "%",  ""    },
            { "mix",       "Mix",        "Mix",  "Output",   "%",  ""    },
            { "freq_low",  "Freq Low",   "fLo",  "Range",    "Hz", "log" },
            { "freq_high", "Freq High",  "fHi",  "Range",    "Hz", "log" },
            { "spread",    "Spread",     "Spr",  "Stereo",   "%",  ""    },
        }},
        { "smartbalance", {
            { "amount",       "Amount",     "Amt",   "Action",   "%",  ""   },
            { "preserve",     "Preserve",   "Prsv",  "Action",   "%",  ""   },
            { "response",     "Response",   "Resp",  "Action",   "ms", "log" },
            { "mix",          "Mix",        "Mix",   "Output",   "%",  ""   },
            { "target_sub",   "Sub Target", "Sub",   "Targets",  "dB", ""   },
            { "target_lomid", "Lo Mid Target","LoMid","Targets", "dB", ""   },
            { "target_upmid", "Up Mid Target","UpMid","Targets", "dB", ""   },
            { "target_air",   "Air Target", "Air",   "Targets",  "dB", ""   },
            { "bandamt_sub",   "Sub Amt",   "Sub",   "Band Amt", "%",  ""   },
            { "bandamt_lomid", "Lo Mid Amt","LoMid", "Band Amt", "%",  ""   },
            { "bandamt_upmid", "Up Mid Amt","UpMid", "Band Amt", "%",  ""   },
            { "bandamt_air",   "Air Amt",   "Air",   "Band Amt", "%",  ""   },
            { "floor_sub",     "Sub Floor", "Sub",   "Floors",   "dB", ""   },
            { "floor_lomid",   "Lo Mid Floor","LoMid","Floors",  "dB", ""   },
            { "floor_upmid",   "Up Mid Floor","UpMid","Floors",  "dB", ""   },
            { "floor_air",     "Air Floor", "Air",   "Floors",   "dB", ""   },
        }},
        { "compressor", {
            { "threshold", "Threshold", "Thr",  "Dynamics", "dB", ""    },
            { "ratio",     "Ratio",     "Rat",  "Dynamics", ":1", ""    },
            { "attack",    "Attack",    "Att",  "Envelope", "ms", "log" },
            { "release",   "Release",   "Rel",  "Envelope", "ms", "log" },
            { "knee",      "Knee",      "Knee", "Dynamics", "dB", ""    },
            { "makeup",    "Makeup",    "Mkp",  "Output",   "dB", ""    },
            { "mix",       "Mix",       "Mix",  "Output",   "%",  ""    },
            { "sc_external","External Sidechain","ExtSC","Sidechain","", "" },
        }},
        { "limiter", {
            { "gain",    "Gain",     "Gain", "Output", "dB", ""    },
            { "ceiling", "Ceiling",  "Ceil", "Output", "dB", ""    },
            { "release", "Release",  "Rel",  "Envelope","ms","log" },
        }},
        { "distortion", {
            { "drive", "Drive", "Drv", "Drive",  "dB", ""  },
            { "tone",  "Tone",  "Tone","Tone",   "Hz","log" },
            { "mix",   "Mix",   "Mix", "Output", "%",  ""  },
        }},
        { "overdone", {
            { "depth",      "Depth",      "Dpth", "Action",   "%",  ""    },
            { "time",       "Time",       "Time", "Envelope", "ms", "log" },
            { "xover_low",  "XOver Low",  "XLo",  "Crossover","Hz","log"  },
            { "xover_high", "XOver High", "XHi",  "Crossover","Hz","log"  },
            { "gain_low",   "Low Gain",   "Lo",   "Gain",     "dB", ""    },
            { "gain_mid",   "Mid Gain",   "Mid",  "Gain",     "dB", ""    },
            { "gain_high",  "High Gain",  "Hi",   "Gain",     "dB", ""    },
        }},
        { "waveshaper", {
            { "pregain",  "Pre Gain",  "Pre", "Gain",   "dB", "" },
            { "postgain", "Post Gain", "Post","Gain",   "dB", "" },
            { "mix",      "Mix",       "Mix", "Output", "%",  "" },
        }},
        { "transientproc", {
            { "attack",       "Attack",       "Att",  "Transients", "%",  ""    },
            { "sustain",      "Sustain",      "Sus",  "Transients", "%",  ""    },
            { "attack_speed", "Attack Speed", "Spd",  "Transients", "ms", "log" },
            { "threshold",    "Threshold",    "Thr",  "Dynamics",   "dB", ""    },
            { "mix",          "Mix",          "Mix",  "Output",     "%",  ""    },
        }},
        { "resonancesuppressor", {
            { "depth",       "Depth",       "Dpth", "Action",   "%",  ""    },
            { "sharpness",   "Sharpness",   "Sharp","Action",   "",   ""    },
            { "selectivity", "Selectivity", "Sel",  "Action",   "",   ""    },
            { "mix",         "Mix",         "Mix",  "Output",   "%",  ""    },
            { "trim",        "Trim",        "Trim", "Output",   "dB", ""    },
            { "stereo_link", "Stereo Link", "Link", "Stereo",   "%",  ""    },
            { "attack",      "Attack",      "Att",  "Envelope", "ms", "log" },
            { "release",     "Release",     "Rel",  "Envelope", "ms", "log" },
            { "wc_hp",       "Sidechain HP","HP",   "Sidechain","Hz","log"  },
            { "wc_lp",       "Sidechain LP","LP",   "Sidechain","Hz","log"  },
        }},
    };

    static const DescTable kEmpty;
    auto it = kTables.find(pluginId);
    return it == kTables.end() ? kEmpty : it->second;
}

// Per-band parameter naming for the parametric EQ.  Mirrors how XlethEQEffect
// allocates band parameters with `paramId(bandIndex, "freq")` etc.
struct EqBandDesc
{
    std::string_view suffix;
    std::string_view label;
    std::string_view compactLabel;
    std::string_view group;
    std::string_view unit;
    std::string_view scale;
};

const std::vector<EqBandDesc>& eqBandDescs()
{
    static const std::vector<EqBandDesc> kDescs = {
        { "freq",         "Frequency",      "Freq", "Band {i}", "Hz", "log" },
        { "gain",         "Gain",           "Gain", "Band {i}", "dB", ""    },
        { "q",            "Q",              "Q",    "Band {i}", "",   ""    },
        { "dyn_thresh",   "Dyn Threshold",  "DyTh", "Band {i} Dyn", "dB", "" },
        { "dyn_ratio",    "Dyn Ratio",      "DyRa", "Band {i} Dyn", ":1", "" },
        { "dyn_attack",   "Dyn Attack",     "DyAt", "Band {i} Dyn", "ms", "log" },
        { "dyn_release",  "Dyn Release",    "DyRe", "Band {i} Dyn", "ms", "log" },
        { "spec_sens",    "Spec Sens",      "SpSn", "Band {i} Spec", "", "" },
        { "spec_depth",   "Spec Depth",     "SpDp", "Band {i} Spec", "", "" },
        { "spec_sel",     "Spec Sel",       "SpSe", "Band {i} Spec", "", "" },
        { "spec_attack",  "Spec Attack",    "SpAt", "Band {i} Spec", "ms", "log" },
        { "spec_release", "Spec Release",   "SpRe", "Band {i} Spec", "ms", "log" },
    };
    return kDescs;
}

std::string substituteBandIndex(std::string_view text, int bandIndex)
{
    std::string s{ text };
    const std::string placeholder = "{i}";
    const std::string replacement = std::to_string(bandIndex);
    for (size_t pos = s.find(placeholder); pos != std::string::npos; pos = s.find(placeholder, pos))
    {
        s.replace(pos, placeholder.size(), replacement);
        pos += replacement.size();
    }
    return s;
}

bool fillRangeFromApvts(const juce::AudioProcessorValueTreeState& apvts,
                        const std::string& paramId,
                        StockParameterEntry& entry)
{
    auto* param = apvts.getParameter(juce::String(paramId));
    if (!param) return false;
    auto* rp = dynamic_cast<juce::RangedAudioParameter*>(param);
    if (!rp) return false;
    const auto& range = rp->getNormalisableRange();
    entry.min          = range.start;
    entry.max          = range.end;
    entry.defaultValue = rp->convertFrom0to1(rp->getDefaultValue());
    return true;
}

void appendCuratedEntries(const std::string& pluginId,
                          XlethEffectBase& effect,
                          std::vector<StockParameterEntry>& out)
{
    const auto& table = tableFor(pluginId);
    if (table.empty()) return;
    const auto& apvts = effect.getAPVTSForCatalog();
    for (const auto& d : table)
    {
        StockParameterEntry e;
        e.paramId      = std::string(d.paramId);
        e.label        = std::string(d.label);
        e.compactLabel = std::string(d.compactLabel);
        e.group        = std::string(d.group);
        e.unit         = std::string(d.unit);
        e.scale        = std::string(d.scale);
        if (!fillRangeFromApvts(apvts, e.paramId, e)) continue;
        out.push_back(std::move(e));
    }
}

void appendEqBandEntries(XlethEffectBase& effect,
                         std::vector<StockParameterEntry>& out)
{
    const int bandCount = std::max(0, effect.getStockModulationBandCount());
    if (bandCount <= 0) return;
    const auto& apvts = effect.getAPVTSForCatalog();
    const auto& descs = eqBandDescs();
    for (int i = 0; i < bandCount; ++i)
    {
        for (const auto& d : descs)
        {
            StockParameterEntry e;
            e.paramId      = "b" + std::to_string(i) + "_" + std::string(d.suffix);
            e.label        = substituteBandIndex(d.label, i);
            e.compactLabel = substituteBandIndex(d.compactLabel, i);
            e.group        = substituteBandIndex(d.group, i);
            e.unit         = std::string(d.unit);
            e.scale        = std::string(d.scale);
            if (!fillRangeFromApvts(apvts, e.paramId, e)) continue;
            out.push_back(std::move(e));
        }
    }
}

void appendGenericApvtsFallback(XlethEffectBase& effect,
                                std::vector<StockParameterEntry>& out)
{
    const auto& apvts = effect.getAPVTSForCatalog();
    for (auto* param : effect.getParameters())
    {
        auto* rp = dynamic_cast<juce::RangedAudioParameter*>(param);
        if (!rp) continue;
        StockParameterEntry e;
        e.paramId      = rp->paramID.toStdString();
        e.label        = rp->getName(256).toStdString();
        if (e.label.empty()) e.label = e.paramId;
        e.unit         = rp->getLabel().toStdString();
        if (!fillRangeFromApvts(apvts, e.paramId, e)) continue;
        out.push_back(std::move(e));
    }
}

}

std::vector<StockParameterEntry> availableStockParameterTargets(
    const std::string& pluginId, XlethEffectBase& effect)
{
    std::vector<StockParameterEntry> out;

    appendCuratedEntries(pluginId, effect, out);

    if (pluginId == "xletheq")
        appendEqBandEntries(effect, out);

    if (out.empty())
        appendGenericApvtsFallback(effect, out);

    return out;
}

}
