#include "SamplerModulationJson.h"

#include <algorithm>

namespace xleth::sampmod {

// ── Tolerant readers ─────────────────────────────────────────────────────────
// One helper per primitive so every field in this file reads the same way: take
// the value if it is present AND the right JSON type, otherwise keep whatever
// the default-constructed struct already holds.

static float readF(const nlohmann::json& j, const char* key, float dflt)
{
    auto it = j.find(key);
    if (it == j.end() || !it->is_number()) return dflt;
    return it->get<float>();
}

static int readI(const nlohmann::json& j, const char* key, int dflt)
{
    auto it = j.find(key);
    if (it == j.end() || !it->is_number()) return dflt;
    return it->get<int>();
}

static bool readB(const nlohmann::json& j, const char* key, bool dflt)
{
    auto it = j.find(key);
    if (it == j.end() || !it->is_boolean()) return dflt;
    return it->get<bool>();
}

// Range-checked enum read: an out-of-range index (a value written by a newer
// build) falls back to the default rather than indexing off a table.
static int readEnum(const nlohmann::json& j, const char* key, int dflt, int count)
{
    const int v = readI(j, key, dflt);
    return (v >= 0 && v < count) ? v : dflt;
}

// ── ModTime ──────────────────────────────────────────────────────────────────

void to_json(nlohmann::json& j, const ModTime& t)
{
    j = nlohmann::json{
        {"ms",        t.ms},
        {"noteValue", t.noteValue},
        {"triplet",   t.triplet},
        {"dotted",    t.dotted}
    };
}

void from_json(const nlohmann::json& j, ModTime& t)
{
    if (!j.is_object()) return;
    t.ms        = readF(j, "ms", t.ms);
    t.noteValue = readEnum(j, "noteValue", t.noteValue, kNumNoteValues);
    t.triplet   = readB(j, "triplet", t.triplet);
    t.dotted    = readB(j, "dotted", t.dotted);
}

// Read a nested ModTime only when the key is actually an object, so a legacy
// or malformed entry leaves the default in place.
static void readTime(const nlohmann::json& j, const char* key, ModTime& t)
{
    auto it = j.find(key);
    if (it != j.end() && it->is_object()) from_json(*it, t);
}

// ── ModEnvConfig ─────────────────────────────────────────────────────────────

void to_json(nlohmann::json& j, const ModEnvConfig& c)
{
    j = nlohmann::json{
        {"tempoSync",      c.tempoSync},
        {"delay",          c.delay},
        {"attack",         c.attack},
        {"hold",           c.hold},
        {"decay",          c.decay},
        {"release",        c.release},
        {"sustainPct",     c.sustainPct},
        {"attackTension",  c.attackTension},
        {"decayTension",   c.decayTension},
        {"releaseTension", c.releaseTension},
        {"outputAmount",   c.outputAmount}
    };
}

void from_json(const nlohmann::json& j, ModEnvConfig& c)
{
    if (!j.is_object()) return;
    c.tempoSync = readB(j, "tempoSync", c.tempoSync);
    readTime(j, "delay",   c.delay);
    readTime(j, "attack",  c.attack);
    readTime(j, "hold",    c.hold);
    readTime(j, "decay",   c.decay);
    readTime(j, "release", c.release);
    c.sustainPct     = std::clamp(readF(j, "sustainPct", c.sustainPct), 0.0f, 100.0f);
    c.attackTension  = std::clamp(readF(j, "attackTension",  c.attackTension),  -1.0f, 1.0f);
    c.decayTension   = std::clamp(readF(j, "decayTension",   c.decayTension),   -1.0f, 1.0f);
    c.releaseTension = std::clamp(readF(j, "releaseTension", c.releaseTension), -1.0f, 1.0f);
    c.outputAmount   = std::clamp(readF(j, "outputAmount", c.outputAmount), -1.0f, 1.0f);
}

// ── LfoPoint / ModLfoConfig ──────────────────────────────────────────────────

void to_json(nlohmann::json& j, const LfoPoint& p)
{
    j = nlohmann::json{
        {"t",       p.time},
        {"v",       p.value},
        {"seg",     p.segment},
        {"tension", p.tension}
    };
}

void from_json(const nlohmann::json& j, LfoPoint& p)
{
    if (!j.is_object()) return;
    p.time    = std::clamp(readF(j, "t", p.time), 0.0f, 1.0f);
    p.value   = std::clamp(readF(j, "v", p.value), -1.0f, 1.0f);
    p.segment = readEnum(j, "seg", p.segment, 3);
    p.tension = std::clamp(readF(j, "tension", p.tension), -1.0f, 1.0f);
}

void to_json(nlohmann::json& j, const ModLfoConfig& c)
{
    nlohmann::json pts = nlohmann::json::array();
    for (int i = 0; i < std::clamp(c.numPoints, 0, kMaxLfoPoints); ++i)
        pts.push_back(c.points[static_cast<size_t>(i)]);

    j = nlohmann::json{
        {"points",       pts},
        {"tempoSync",    c.tempoSync},
        {"rateHz",       c.rateHz},
        {"syncRate",     c.syncRate},
        {"rise",         c.rise},
        {"delay",        c.delay},
        {"smooth",       c.smooth},
        {"phase",        c.phase},
        {"behavior",     c.behavior},
        {"mono",         c.mono},
        {"outputAmount", c.outputAmount}
    };
}

void from_json(const nlohmann::json& j, ModLfoConfig& c)
{
    if (!j.is_object()) return;

    auto pts = j.find("points");
    if (pts != j.end() && pts->is_array()) {
        c.numPoints = 0;
        for (const auto& e : *pts) {
            if (c.numPoints >= kMaxLfoPoints) break;
            LfoPoint p;
            from_json(e, p);
            c.points[static_cast<size_t>(c.numPoints++)] = p;
        }
        // The evaluator assumes an ordered list and would otherwise pick the
        // wrong segment for a shape whose points arrived out of order.
        std::stable_sort(c.points.begin(), c.points.begin() + c.numPoints,
                         [](const LfoPoint& a, const LfoPoint& b) { return a.time < b.time; });
    }

    c.tempoSync = readB(j, "tempoSync", c.tempoSync);
    c.rateHz    = std::clamp(readF(j, "rateHz", c.rateHz), 0.01f, 40.0f);
    readTime(j, "syncRate", c.syncRate);
    readTime(j, "rise",     c.rise);
    readTime(j, "delay",    c.delay);
    c.smooth   = std::clamp(readF(j, "smooth", c.smooth), 0.0f, 100.0f);
    c.phase    = std::clamp(readF(j, "phase",  c.phase),  0.0f, 100.0f);
    c.behavior = readEnum(j, "behavior", c.behavior, 3);
    c.mono     = readB(j, "mono", c.mono);
    c.outputAmount = std::clamp(readF(j, "outputAmount", c.outputAmount), -1.0f, 1.0f);
}

// ── CurvePoint / ModCurveConfig ──────────────────────────────────────────────

void to_json(nlohmann::json& j, const CurvePoint& p)
{
    j = nlohmann::json{ {"x", p.x}, {"y", p.y}, {"tension", p.tension} };
}

void from_json(const nlohmann::json& j, CurvePoint& p)
{
    if (!j.is_object()) return;
    p.x       = std::clamp(readF(j, "x", p.x), 0.0f, 1.0f);
    p.y       = std::clamp(readF(j, "y", p.y), 0.0f, 1.0f);
    p.tension = std::clamp(readF(j, "tension", p.tension), -1.0f, 1.0f);
}

void to_json(nlohmann::json& j, const ModCurveConfig& c)
{
    nlohmann::json pts = nlohmann::json::array();
    for (int i = 0; i < std::clamp(c.numPoints, 0, kMaxCurvePoints); ++i)
        pts.push_back(c.points[static_cast<size_t>(i)]);
    j = nlohmann::json{ {"points", pts}, {"outputAmount", c.outputAmount} };
}

void from_json(const nlohmann::json& j, ModCurveConfig& c)
{
    if (!j.is_object()) return;
    auto pts = j.find("points");
    if (pts != j.end() && pts->is_array()) {
        c.numPoints = 0;
        for (const auto& e : *pts) {
            if (c.numPoints >= kMaxCurvePoints) break;
            CurvePoint p;
            from_json(e, p);
            c.points[static_cast<size_t>(c.numPoints++)] = p;
        }
        std::stable_sort(c.points.begin(), c.points.begin() + c.numPoints,
                         [](const CurvePoint& a, const CurvePoint& b) { return a.x < b.x; });
    }
    c.outputAmount = std::clamp(readF(j, "outputAmount", c.outputAmount), -1.0f, 1.0f);
}

// ── ModRoute ─────────────────────────────────────────────────────────────────

void to_json(nlohmann::json& j, const ModRoute& r)
{
    j = nlohmann::json{
        {"source",  r.source},
        {"target",  r.target},
        {"index",   r.index},
        {"stage",   r.stage},
        {"amount",  r.amount},
        {"bipolar", r.bipolar}
    };
}

void from_json(const nlohmann::json& j, ModRoute& r)
{
    if (!j.is_object()) return;
    r.source  = readI(j, "source", r.source);
    r.target  = readEnum(j, "target", r.target, static_cast<int>(ModTarget::Count));
    r.index   = readI(j, "index", r.index);
    r.stage   = readI(j, "stage", r.stage);
    r.amount  = std::clamp(readF(j, "amount", r.amount), -1.0f, 1.0f);
    r.bipolar = readB(j, "bipolar", r.bipolar);
}

// ── ModConfig ────────────────────────────────────────────────────────────────

void to_json(nlohmann::json& j, const ModConfig& c)
{
    nlohmann::json envs = nlohmann::json::array();
    for (const auto& e : c.envs) envs.push_back(e);

    nlohmann::json lfos = nlohmann::json::array();
    for (const auto& l : c.lfos) lfos.push_back(l);

    nlohmann::json routes = nlohmann::json::array();
    for (int i = 0; i < std::clamp(c.numRoutes, 0, kMaxRoutes); ++i)
        routes.push_back(c.routes[static_cast<size_t>(i)]);

    nlohmann::json envPresent = nlohmann::json::array();
    for (bool p : c.envPresent) envPresent.push_back(p);
    nlohmann::json lfoPresent = nlohmann::json::array();
    for (bool p : c.lfoPresent) lfoPresent.push_back(p);

    j = nlohmann::json{
        {"envs",       envs},
        {"lfos",       lfos},
        {"velo",       c.velo},
        {"note",       c.note},
        {"envPresent", envPresent},
        {"lfoPresent", lfoPresent},
        {"routes",     routes}
    };
}

// Read a presence array, tolerant of a missing key. `legacyAllPresent` is what
// a project written before this system existed gets: the old build showed a
// fixed rack where every source was editable, so "all present" preserves that
// exactly rather than making sources a user configured silently disappear.
static void readPresence(const nlohmann::json& j, const char* key,
                         bool* out, int count, bool legacyAllPresent)
{
    auto it = j.find(key);
    if (it == j.end() || !it->is_array()) {
        for (int i = 0; i < count; ++i) out[i] = legacyAllPresent;
        return;
    }
    for (int i = 0; i < count; ++i) {
        const auto& a = *it;
        out[i] = (i < static_cast<int>(a.size()) && a[static_cast<size_t>(i)].is_boolean())
                     ? a[static_cast<size_t>(i)].get<bool>()
                     : false;
    }
}

void from_json(const nlohmann::json& j, ModConfig& c)
{
    if (!j.is_object()) return;

    auto envs = j.find("envs");
    if (envs != j.end() && envs->is_array()) {
        int i = 0;
        for (const auto& e : *envs) {
            if (i >= kNumEnvs) break;
            from_json(e, c.envs[static_cast<size_t>(i++)]);
        }
    }

    auto lfos = j.find("lfos");
    if (lfos != j.end() && lfos->is_array()) {
        int i = 0;
        for (const auto& e : *lfos) {
            if (i >= kNumLfos) break;
            from_json(e, c.lfos[static_cast<size_t>(i++)]);
        }
    }

    auto velo = j.find("velo");
    if (velo != j.end()) from_json(*velo, c.velo);
    auto note = j.find("note");
    if (note != j.end()) from_json(*note, c.note);

    // Presence: a blob with the keys reads them verbatim; a legacy blob without
    // them reads as all-present (see readPresence). enforceInvariants() below
    // re-asserts ENV 0 regardless of what any of the above set.
    readPresence(j, "envPresent", c.envPresent.data(), kNumEnvs, /*legacyAllPresent*/ true);
    readPresence(j, "lfoPresent", c.lfoPresent.data(), kNumLfos, /*legacyAllPresent*/ true);

    auto routes = j.find("routes");
    if (routes != j.end() && routes->is_array()) {
        c.numRoutes = 0;
        for (const auto& e : *routes) {
            if (c.numRoutes >= kMaxRoutes) break;
            ModRoute r;
            from_json(e, r);
            // Drop routes the engine would refuse anyway, so a saved file can
            // never grow a route list the compiler will silently ignore and the
            // round-trip test can compare route counts directly.
            if (!isRouteValid(r)) continue;
            c.routes[static_cast<size_t>(c.numRoutes++)] = r;
        }
    }

    c.enforceInvariants();
}

} // namespace xleth::sampmod
