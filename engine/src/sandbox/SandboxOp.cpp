#include "sandbox/SandboxOp.h"

#include <algorithm>
#include <bit>
#include <cmath>
#include <cstring>

namespace xleth::sandbox {

// ─── Registry ─────────────────────────────────────────────────────────────────
// One table. Every type↔name site below indexes it, so a new op that forgets an
// entry trips the static_assert rather than serializing as an empty string.

namespace {

struct TypeEntry { SandboxOpType type; const char* name; };

constexpr TypeEntry kTypeTable[] = {
    { SandboxOpType::Trim,      "trim"      },
    { SandboxOpType::Cut,       "cut"       },
    { SandboxOpType::Paste,     "paste"     },
    { SandboxOpType::Splice,    "splice"    },
    { SandboxOpType::Reverse,   "reverse"   },
    { SandboxOpType::Fade,      "fade"      },
    { SandboxOpType::Gain,      "gain"      },
    { SandboxOpType::Crossfade, "crossfade" },
    { SandboxOpType::Pitch,     "pitch"     },
    { SandboxOpType::Stretch,   "stretch"   },
    { SandboxOpType::GainEnvelope,  "gainEnvelope"  },
    { SandboxOpType::FormantShift,  "formantShift"  },
    { SandboxOpType::Declip,        "declip"        },
    { SandboxOpType::Denoise,       "denoise"       },
    { SandboxOpType::SpectralPaint, "spectralPaint" },
    { SandboxOpType::Autotune,      "autotune"      },
};

static_assert(std::size(kTypeTable) == kSandboxOpTypeCount,
              "kTypeTable must carry exactly one entry per SandboxOpType");

// ─── FNV-1a 64 ────────────────────────────────────────────────────────────────
// Chosen over xxhash because XlethEngineModel deliberately links nothing but
// nlohmann/json and libavutil — pulling xxhash_static down into the model tier
// to hash a handful of ints would be a dependency for no gain. Stacks are tens
// of ops, not megabytes of PCM; this is not on any hot path.

constexpr uint64_t kFnvOffset = 1469598103934665603ull;
constexpr uint64_t kFnvPrime  = 1099511628211ull;

inline uint64_t hashBytes(uint64_t h, const void* data, size_t len) noexcept {
    const auto* p = static_cast<const unsigned char*>(data);
    for (size_t i = 0; i < len; ++i) {
        h ^= static_cast<uint64_t>(p[i]);
        h *= kFnvPrime;
    }
    return h;
}

inline uint64_t hashU64(uint64_t h, uint64_t v) noexcept { return hashBytes(h, &v, sizeof v); }
inline uint64_t hashI64(uint64_t h, int64_t v) noexcept  { return hashU64(h, static_cast<uint64_t>(v)); }
inline uint64_t hashI32(uint64_t h, int32_t v) noexcept  { return hashU64(h, static_cast<uint64_t>(static_cast<uint32_t>(v))); }
inline uint64_t hashBool(uint64_t h, bool v) noexcept    { return hashU64(h, v ? 1ull : 0ull); }

// Hash the BIT PATTERN, not the value: a double compared equal is a double
// hashed equal, and no rounding drifts between runs. -0.0 is normalized to 0.0
// first so a sign-flipped zero cannot fork the cache into two identical renders.
inline uint64_t hashF64(uint64_t h, double v) noexcept {
    if (v == 0.0) v = 0.0;
    return hashU64(h, std::bit_cast<uint64_t>(v));
}

// ─── Per-op visitors ──────────────────────────────────────────────────────────
// Each of the three overload sets below is exhaustive over SandboxOpParams. Add
// an alternative to the variant without adding it here and std::visit fails to
// compile — which is precisely the guarantee `float params[16]` cannot offer.

struct HashVisitor {
    uint64_t h;
    uint64_t operator()(const TrimParams& p) const {
        return hashI64(hashI64(h, p.startSample), p.endSample);
    }
    uint64_t operator()(const CutParams& p) const {
        return hashI32(hashI64(hashI64(h, p.startSample), p.endSample), static_cast<int32_t>(p.mode));
    }
    uint64_t operator()(const PasteParams& p) const {
        return hashBool(hashI64(hashI32(hashI64(h, p.atSample), p.clipboardId),
                                p.clipboardLengthSamples), p.insert);
    }
    uint64_t operator()(const SpliceParams& p) const {
        return hashI64(hashI32(hashI64(h, p.atSample), static_cast<int32_t>(p.mode)), p.gapSamples);
    }
    uint64_t operator()(const ReverseParams& p) const {
        return hashI64(hashI64(h, p.startSample), p.endSample);
    }
    uint64_t operator()(const FadeParams& p) const {
        return hashBool(hashI32(hashI64(hashI64(h, p.startSample), p.lengthSamples),
                                static_cast<int32_t>(p.shape)), p.fadeIn);
    }
    uint64_t operator()(const GainParams& p) const {
        return hashF64(hashBool(hashF64(hashI64(hashI64(h, p.startSample), p.endSample),
                                        p.gainDb), p.normalize), p.targetPeakDb);
    }
    uint64_t operator()(const CrossfadeParams& p) const {
        return hashI32(hashI64(hashI64(h, p.atSample), p.lengthSamples),
                       static_cast<int32_t>(p.shape));
    }
    uint64_t operator()(const PitchParams& p) const {
        return hashI32(hashBool(hashF64(h, p.cents), p.formantPreserve),
                       static_cast<int32_t>(p.mode));
    }
    uint64_t operator()(const StretchParams& p) const {
        return hashI32(hashF64(h, p.ratio), p.algorithm);
    }
    // Count first: without it a 2-point envelope could digest to the same value
    // as a 3-point one whose extra point happens to chain to the identity, and
    // the renderer's prefix cache would then serve the wrong audio. mode and
    // the follower times go in too — flipping Absolute/Relative or retuning
    // attack/release changes the render without touching a single breakpoint.
    uint64_t operator()(const GainEnvelopeParams& p) const {
        uint64_t acc = hashU64(h, static_cast<uint64_t>(p.points.size()));
        for (const auto& pt : p.points) acc = hashF64(hashI64(acc, pt.samplePos), pt.db);
        acc = hashI32(acc, static_cast<int32_t>(p.mode));
        acc = hashF64(hashF64(acc, p.followerAttackMs), p.followerReleaseMs);
        return acc;
    }
    uint64_t operator()(const FormantShiftParams& p) const {
        return hashF64(h, p.cents);
    }
    uint64_t operator()(const DeclipParams& p) const {
        return hashI32(hashF64(hashI64(hashI64(h, p.startSample), p.endSample), p.threshold),
                       p.maxRunSamples);
    }
    uint64_t operator()(const DenoiseParams& p) const {
        return hashF64(hashF64(hashI64(hashI64(h, p.noiseStartSample), p.noiseEndSample),
                               p.reductionDb), p.sensitivity);
    }
    // Count first, same reasoning as GainEnvelope's own comment: without it a
    // 2-dab stack could digest to the same value as a 3-dab one whose extra
    // dab happens to chain to the identity.
    uint64_t operator()(const SpectralPaintParams& p) const {
        uint64_t acc = hashU64(h, static_cast<uint64_t>(p.dabs.size()));
        for (const auto& d : p.dabs) {
            acc = hashI64(acc, d.centerSample);
            acc = hashI64(acc, d.halfWidthSamples);
            acc = hashF64(acc, d.centerFreqHz);
            acc = hashF64(acc, d.halfHeightHz);
            acc = hashF64(acc, d.amountDb);
            acc = hashF64(acc, d.featherTimeMs);
            acc = hashF64(acc, d.featherFreqHz);
        }
        return acc;
    }
    // allowedNotes count first, same reasoning as the two vector-carrying
    // visitors above. scale/key go in even when allowedNotes overrides them:
    // a user who sets a custom note set, renders, then clears it back to the
    // preset must get a DIFFERENT render, not a cache hit on the custom one.
    uint64_t operator()(const AutotuneParams& p) const {
        uint64_t acc = hashI32(hashI32(h, static_cast<int32_t>(p.scale)), p.key);
        acc = hashI32(acc, static_cast<int32_t>(p.mode));
        acc = hashU64(acc, static_cast<uint64_t>(p.allowedNotes.size()));
        for (int pc : p.allowedNotes) acc = hashI32(acc, pc);
        acc = hashF64(acc, p.correction.correctionAmount);
        acc = hashF64(acc, p.correction.retuneSpeedMs);
        acc = hashF64(acc, p.correction.smoothnessMs);
        acc = hashF64(acc, p.correction.jumpiness);
        acc = hashF64(acc, p.correction.preserveVibrato);
        acc = hashU64(acc, static_cast<uint64_t>(p.manualPoints.size()));
        for (const auto& pt : p.manualPoints) {
            acc = hashF64(acc, pt.timeSec);
            acc = hashF64(acc, pt.targetHz);
            acc = hashF64(acc, pt.tension);
        }
        return acc;
    }
};

struct ToJsonVisitor {
    nlohmann::json operator()(const TrimParams& p) const {
        return { {"startSample", p.startSample}, {"endSample", p.endSample} };
    }
    nlohmann::json operator()(const CutParams& p) const {
        return { {"startSample", p.startSample}, {"endSample", p.endSample},
                 {"mode", static_cast<int>(p.mode)} };
    }
    nlohmann::json operator()(const PasteParams& p) const {
        return { {"atSample", p.atSample}, {"clipboardId", p.clipboardId},
                 {"clipboardLengthSamples", p.clipboardLengthSamples}, {"insert", p.insert} };
    }
    nlohmann::json operator()(const SpliceParams& p) const {
        return { {"atSample", p.atSample}, {"mode", static_cast<int>(p.mode)},
                 {"gapSamples", p.gapSamples} };
    }
    nlohmann::json operator()(const ReverseParams& p) const {
        return { {"startSample", p.startSample}, {"endSample", p.endSample} };
    }
    nlohmann::json operator()(const FadeParams& p) const {
        return { {"startSample", p.startSample}, {"lengthSamples", p.lengthSamples},
                 {"shape", static_cast<int>(p.shape)}, {"fadeIn", p.fadeIn} };
    }
    nlohmann::json operator()(const GainParams& p) const {
        return { {"startSample", p.startSample}, {"endSample", p.endSample},
                 {"gainDb", p.gainDb}, {"normalize", p.normalize},
                 {"targetPeakDb", p.targetPeakDb} };
    }
    nlohmann::json operator()(const CrossfadeParams& p) const {
        return { {"atSample", p.atSample}, {"lengthSamples", p.lengthSamples},
                 {"shape", static_cast<int>(p.shape)} };
    }
    nlohmann::json operator()(const PitchParams& p) const {
        return { {"cents", p.cents}, {"formantPreserve", p.formantPreserve},
                 {"mode", static_cast<int>(p.mode)} };
    }
    nlohmann::json operator()(const StretchParams& p) const {
        return { {"ratio", p.ratio}, {"algorithm", p.algorithm} };
    }
    nlohmann::json operator()(const GainEnvelopeParams& p) const {
        nlohmann::json pts = nlohmann::json::array();
        for (const auto& pt : p.points)
            pts.push_back({ {"samplePos", pt.samplePos}, {"db", pt.db} });
        return { {"points", std::move(pts)},
                 {"mode", static_cast<int>(p.mode)},
                 {"followerAttackMs", p.followerAttackMs},
                 {"followerReleaseMs", p.followerReleaseMs} };
    }
    nlohmann::json operator()(const FormantShiftParams& p) const {
        return { {"cents", p.cents} };
    }
    nlohmann::json operator()(const DeclipParams& p) const {
        return { {"startSample", p.startSample}, {"endSample", p.endSample},
                 {"threshold", p.threshold}, {"maxRunSamples", p.maxRunSamples} };
    }
    nlohmann::json operator()(const DenoiseParams& p) const {
        return { {"noiseStartSample", p.noiseStartSample}, {"noiseEndSample", p.noiseEndSample},
                 {"reductionDb", p.reductionDb}, {"sensitivity", p.sensitivity} };
    }
    nlohmann::json operator()(const SpectralPaintParams& p) const {
        nlohmann::json dabs = nlohmann::json::array();
        for (const auto& d : p.dabs) {
            dabs.push_back({
                {"centerSample", d.centerSample}, {"halfWidthSamples", d.halfWidthSamples},
                {"centerFreqHz", d.centerFreqHz}, {"halfHeightHz", d.halfHeightHz},
                {"amountDb", d.amountDb},
                {"featherTimeMs", d.featherTimeMs}, {"featherFreqHz", d.featherFreqHz},
            });
        }
        return { {"dabs", std::move(dabs)} };
    }
    // FLAT: the six controls sit at the top level of "params" rather than
    // nested under the CorrectionParams the C++ struct embeds — see
    // AutotuneParams. The UI edits six controls, not a control and an object.
    nlohmann::json operator()(const AutotuneParams& p) const {
        nlohmann::json notes = nlohmann::json::array();
        for (int pc : p.allowedNotes) notes.push_back(pc);
        nlohmann::json pts = nlohmann::json::array();
        for (const auto& pt : p.manualPoints)
            pts.push_back({ {"t", pt.timeSec}, {"hz", pt.targetHz}, {"tension", pt.tension} });
        return { {"mode", static_cast<int>(p.mode)},
                 {"scale", static_cast<int>(p.scale)}, {"key", p.key},
                 {"allowedNotes", std::move(notes)},
                 {"correctionAmount", p.correction.correctionAmount},
                 {"retuneSpeedMs",    p.correction.retuneSpeedMs},
                 {"smoothnessMs",     p.correction.smoothnessMs},
                 {"jumpiness",        p.correction.jumpiness},
                 {"preserveVibrato",  p.correction.preserveVibrato},
                 {"manualPoints",     std::move(pts)} };
    }
};

// value_or with a type check: nlohmann's value() throws on a type mismatch, and
// one bad field must not cost the user the whole stack.
template <typename T>
T readField(const nlohmann::json& j, const char* key, T fallback) {
    if (!j.is_object()) return fallback;
    auto it = j.find(key);
    if (it == j.end()) return fallback;
    try { return it->get<T>(); } catch (...) { return fallback; }
}

int readEnum(const nlohmann::json& j, const char* key, int fallback, int lo, int hi) {
    const int v = readField<int>(j, key, fallback);
    return (v >= lo && v <= hi) ? v : fallback;
}

struct FromJsonVisitor {
    const nlohmann::json& j;
    void operator()(TrimParams& p) const {
        p.startSample = readField<int64_t>(j, "startSample", p.startSample);
        p.endSample   = readField<int64_t>(j, "endSample",   p.endSample);
    }
    void operator()(CutParams& p) const {
        p.startSample = readField<int64_t>(j, "startSample", p.startSample);
        p.endSample   = readField<int64_t>(j, "endSample",   p.endSample);
        p.mode = static_cast<SandboxRippleMode>(readEnum(j, "mode", static_cast<int>(p.mode), 0, 1));
    }
    void operator()(PasteParams& p) const {
        p.atSample               = readField<int64_t>(j, "atSample", p.atSample);
        p.clipboardId            = readField<int>(j, "clipboardId", p.clipboardId);
        p.clipboardLengthSamples = readField<int64_t>(j, "clipboardLengthSamples", p.clipboardLengthSamples);
        p.insert                 = readField<bool>(j, "insert", p.insert);
    }
    void operator()(SpliceParams& p) const {
        p.atSample   = readField<int64_t>(j, "atSample",   p.atSample);
        p.mode       = static_cast<SandboxRippleMode>(readEnum(j, "mode", static_cast<int>(p.mode), 0, 1));
        p.gapSamples = readField<int64_t>(j, "gapSamples", p.gapSamples);
    }
    void operator()(ReverseParams& p) const {
        p.startSample = readField<int64_t>(j, "startSample", p.startSample);
        p.endSample   = readField<int64_t>(j, "endSample",   p.endSample);
    }
    void operator()(FadeParams& p) const {
        p.startSample   = readField<int64_t>(j, "startSample",   p.startSample);
        p.lengthSamples = readField<int64_t>(j, "lengthSamples", p.lengthSamples);
        p.shape  = static_cast<SandboxFadeShape>(readEnum(j, "shape", static_cast<int>(p.shape), 0, 5));
        p.fadeIn = readField<bool>(j, "fadeIn", p.fadeIn);
    }
    void operator()(GainParams& p) const {
        p.startSample  = readField<int64_t>(j, "startSample", p.startSample);
        p.endSample    = readField<int64_t>(j, "endSample",   p.endSample);
        p.gainDb       = readField<double>(j, "gainDb",       p.gainDb);
        p.normalize    = readField<bool>(j, "normalize",      p.normalize);
        p.targetPeakDb = readField<double>(j, "targetPeakDb", p.targetPeakDb);
    }
    void operator()(CrossfadeParams& p) const {
        p.atSample      = readField<int64_t>(j, "atSample",      p.atSample);
        p.lengthSamples = readField<int64_t>(j, "lengthSamples", p.lengthSamples);
        p.shape = static_cast<SandboxFadeShape>(readEnum(j, "shape", static_cast<int>(p.shape), 0, 5));
    }
    void operator()(PitchParams& p) const {
        p.cents           = readField<double>(j, "cents", p.cents);
        p.formantPreserve = readField<bool>(j, "formantPreserve", p.formantPreserve);
        // Absent in a v4-and-earlier stack, which is exactly what should read
        // back as Preserve — that is the only thing PITCH could do then.
        p.mode = static_cast<SandboxPitchMode>(readEnum(j, "mode", static_cast<int>(p.mode), 0, 1));
    }
    void operator()(StretchParams& p) const {
        p.ratio     = readField<double>(j, "ratio",     p.ratio);
        p.algorithm = readField<int>(j, "algorithm",    p.algorithm);
    }
    // Read point-by-point rather than through a whole-array get<>: one
    // malformed entry must cost that entry, not the entire curve — the same
    // rule readField applies to every scalar param in this file. A missing or
    // non-array "points" leaves the default (empty = unity), which renders as
    // a pass-through rather than as silence.
    void operator()(GainEnvelopeParams& p) const {
        if (!j.is_object()) return;
        auto it = j.find("points");
        if (it == j.end() || !it->is_array()) return;
        std::vector<SandboxGainPoint> pts;
        pts.reserve(it->size());
        for (const auto& e : *it) {
            if (!e.is_object()) continue;
            SandboxGainPoint pt;
            pt.samplePos = readField<int64_t>(e, "samplePos", pt.samplePos);
            pt.db        = readField<double>(e, "db",         pt.db);
            pts.push_back(pt);
        }
        p.points = std::move(pts);
        p.mode = static_cast<SandboxGainEnvelopeMode>(
            readEnum(j, "mode", static_cast<int>(p.mode), 0, 1));
        p.followerAttackMs  = readField<double>(j, "followerAttackMs",  p.followerAttackMs);
        p.followerReleaseMs = readField<double>(j, "followerReleaseMs", p.followerReleaseMs);
        normalizeGainEnvelope(p);
    }
    void operator()(FormantShiftParams& p) const {
        p.cents = readField<double>(j, "cents", p.cents);
    }
    void operator()(DeclipParams& p) const {
        p.startSample   = readField<int64_t>(j, "startSample",   p.startSample);
        p.endSample     = readField<int64_t>(j, "endSample",     p.endSample);
        p.threshold     = readField<double>(j, "threshold",      p.threshold);
        p.maxRunSamples = readField<int>(j, "maxRunSamples",     p.maxRunSamples);
    }
    void operator()(DenoiseParams& p) const {
        p.noiseStartSample = readField<int64_t>(j, "noiseStartSample", p.noiseStartSample);
        p.noiseEndSample   = readField<int64_t>(j, "noiseEndSample",   p.noiseEndSample);
        p.reductionDb      = readField<double>(j, "reductionDb",       p.reductionDb);
        p.sensitivity      = readField<double>(j, "sensitivity",       p.sensitivity);
    }
    // Read dab-by-dab, same reasoning as GainEnvelope's point-by-point read:
    // one malformed dab costs that dab, not the whole painted mask.
    void operator()(SpectralPaintParams& p) const {
        if (!j.is_object()) return;
        auto it = j.find("dabs");
        if (it == j.end() || !it->is_array()) return;
        std::vector<SpectralPaintDab> dabs;
        dabs.reserve(it->size());
        for (const auto& e : *it) {
            if (!e.is_object()) continue;
            SpectralPaintDab d;
            d.centerSample     = readField<int64_t>(e, "centerSample",     d.centerSample);
            d.halfWidthSamples = readField<int64_t>(e, "halfWidthSamples", d.halfWidthSamples);
            d.centerFreqHz     = readField<double>(e, "centerFreqHz",      d.centerFreqHz);
            d.halfHeightHz     = readField<double>(e, "halfHeightHz",      d.halfHeightHz);
            d.amountDb         = readField<double>(e, "amountDb",          d.amountDb);
            d.featherTimeMs    = readField<double>(e, "featherTimeMs",     d.featherTimeMs);
            d.featherFreqHz    = readField<double>(e, "featherFreqHz",     d.featherFreqHz);
            dabs.push_back(d);
        }
        p.dabs = std::move(dabs);
    }
    // Read note-by-note rather than through a whole-array get<>, same rule the
    // two visitors above follow: one malformed entry costs that entry, not the
    // user's whole note set. A missing/non-array "allowedNotes" leaves the
    // default (empty = use scale/key), which is a valid configuration rather
    // than an error.
    void operator()(AutotuneParams& p) const {
        if (!j.is_object()) return;
        p.mode = static_cast<AutotuneMode>(
            readEnum(j, "mode", static_cast<int>(p.mode), 0, 1));
        p.scale = static_cast<xleth::dsp::ScaleType>(
            readEnum(j, "scale", static_cast<int>(p.scale), 0, 10));
        p.key = readField<int>(j, "key", p.key);

        if (auto it = j.find("allowedNotes"); it != j.end() && it->is_array()) {
            std::vector<int> notes;
            notes.reserve(it->size());
            for (const auto& e : *it) {
                if (!e.is_number_integer()) continue;
                notes.push_back(e.get<int>());
            }
            p.allowedNotes = std::move(notes);
        }

        p.correction.correctionAmount = readField<double>(j, "correctionAmount", p.correction.correctionAmount);
        p.correction.retuneSpeedMs    = readField<double>(j, "retuneSpeedMs",    p.correction.retuneSpeedMs);
        p.correction.smoothnessMs     = readField<double>(j, "smoothnessMs",     p.correction.smoothnessMs);
        p.correction.jumpiness        = readField<double>(j, "jumpiness",        p.correction.jumpiness);
        p.correction.preserveVibrato  = readField<double>(j, "preserveVibrato",  p.correction.preserveVibrato);

        // Same per-entry tolerance as allowedNotes above: one malformed
        // breakpoint costs that breakpoint, not the user's whole drawn curve.
        if (auto it = j.find("manualPoints"); it != j.end() && it->is_array()) {
            std::vector<xleth::dsp::ManualPitchPoint> pts;
            pts.reserve(it->size());
            for (const auto& e : *it) {
                if (!e.is_object()) continue;
                xleth::dsp::ManualPitchPoint pt;
                pt.timeSec  = readField<double>(e, "t", 0.0);
                pt.targetHz = readField<double>(e, "hz", 0.0);
                pt.tension  = readField<double>(e, "tension", 0.0);
                pts.push_back(pt);
            }
            p.manualPoints = std::move(pts);
        }

        normalizeAutotune(p);
    }
};

// Resolve an inclusive-exclusive range against a concrete buffer length,
// honouring the "endSample < 0 means to the end" convention. Returns an empty
// range (start == end) when the request does not overlap the buffer at all.
struct Range { int64_t start = 0; int64_t end = 0; };

Range resolveRange(int64_t start, int64_t end, int64_t length) noexcept {
    if (length <= 0) return {};
    const int64_t s = std::clamp<int64_t>(start, 0, length);
    const int64_t e = std::clamp<int64_t>(end < 0 ? length : end, 0, length);
    if (e <= s) return { s, s };
    return { s, e };
}

} // namespace

// ─── Registry accessors ───────────────────────────────────────────────────────

const char* opTypeName(SandboxOpType type) noexcept {
    const int idx = static_cast<int>(type);
    if (idx < 0 || idx >= kSandboxOpTypeCount) return "";
    return kTypeTable[idx].name;
}

bool opTypeFromName(const std::string& name, SandboxOpType& out) noexcept {
    for (const auto& e : kTypeTable) {
        if (name == e.name) { out = e.type; return true; }
    }
    return false;
}

SandboxOpParams defaultParamsFor(SandboxOpType type) {
    switch (type) {
        case SandboxOpType::Trim:      return TrimParams{};
        case SandboxOpType::Cut:       return CutParams{};
        case SandboxOpType::Paste:     return PasteParams{};
        case SandboxOpType::Splice:    return SpliceParams{};
        case SandboxOpType::Reverse:   return ReverseParams{};
        case SandboxOpType::Fade:      return FadeParams{};
        case SandboxOpType::Gain:      return GainParams{};
        case SandboxOpType::Crossfade: return CrossfadeParams{};
        case SandboxOpType::Pitch:     return PitchParams{};
        case SandboxOpType::Stretch:   return StretchParams{};
        case SandboxOpType::GainEnvelope:   return GainEnvelopeParams{};
        case SandboxOpType::FormantShift:   return FormantShiftParams{};
        case SandboxOpType::Declip:         return DeclipParams{};
        case SandboxOpType::Denoise:        return DenoiseParams{};
        case SandboxOpType::SpectralPaint:  return SpectralPaintParams{};
        case SandboxOpType::Autotune:       return AutotuneParams{};
    }
    return GainParams{};
}

// ─── Gain envelope ────────────────────────────────────────────────────────────
// The ONE implementation of the curve. SandboxRenderer's per-sample loop calls
// straight into gainEnvelopeAt rather than reimplementing the interpolation
// incrementally: a second copy of the maths would be free to drift from the one
// the UI predicts against, and the binary search it costs (log2 of a handful of
// breakpoints) is nothing next to the buffer copy the op already performs.

double envDbToGain(double db) noexcept {
    if (db <= kGainEnvelopeSilenceDb) return 0.0;
    return std::pow(10.0, db / 20.0);
}

void normalizeGainEnvelope(GainEnvelopeParams& p) {
    std::vector<SandboxGainPoint> keep;
    keep.reserve(p.points.size());
    for (SandboxGainPoint pt : p.points) {
        if (pt.samplePos < 0) continue;                 // a point before the buffer is not a point
        if (pt.db != pt.db) pt.db = 0.0;                // NaN out of a corrupt file reads as unity
        pt.db = std::clamp(pt.db, kGainEnvelopeMinDb, kGainEnvelopeMaxDb);
        keep.push_back(pt);
    }

    // STABLE sort: equal positions must retain their written order for the
    // de-duplication below to mean "last one written wins" rather than
    // "whichever the sort happened to leave last".
    std::stable_sort(keep.begin(), keep.end(),
                     [](const SandboxGainPoint& a, const SandboxGainPoint& b) {
                         return a.samplePos < b.samplePos;
                     });

    std::vector<SandboxGainPoint> out;
    out.reserve(keep.size());
    for (const auto& pt : keep) {
        if (!out.empty() && out.back().samplePos == pt.samplePos) out.back() = pt;
        else                                                     out.push_back(pt);
    }
    p.points = std::move(out);

    if (p.mode != SandboxGainEnvelopeMode::Relative) p.mode = SandboxGainEnvelopeMode::Absolute;
    if (p.followerAttackMs != p.followerAttackMs)   p.followerAttackMs  = kGainEnvelopeDefaultAttackMs;
    if (p.followerReleaseMs != p.followerReleaseMs) p.followerReleaseMs = kGainEnvelopeDefaultReleaseMs;
    p.followerAttackMs  = std::clamp(p.followerAttackMs,  kGainEnvelopeMinAttackMs,  kGainEnvelopeMaxAttackMs);
    p.followerReleaseMs = std::clamp(p.followerReleaseMs, kGainEnvelopeMinReleaseMs, kGainEnvelopeMaxReleaseMs);
}

double gainEnvelopeDbAt(const GainEnvelopeParams& p, int64_t samplePos) noexcept {
    const auto& pts = p.points;
    if (pts.empty())     return 0.0;                    // no curve = unity
    if (pts.size() == 1) return pts.front().db;

    // Held flat outside the authored range, rather than extrapolated: a curve
    // that kept its slope past the last handle would keep ducking material the
    // user never drew over, and an upstream length change would silently move
    // where that runaway starts.
    if (samplePos <= pts.front().samplePos) return pts.front().db;
    if (samplePos >= pts.back().samplePos)  return pts.back().db;

    const auto it = std::upper_bound(pts.begin(), pts.end(), samplePos,
                                     [](int64_t v, const SandboxGainPoint& q) {
                                         return v < q.samplePos;
                                     });
    // Guarded by the two bounds checks above: samplePos is strictly inside the
    // authored range, so `it` is neither begin() nor end().
    const SandboxGainPoint& b = *it;
    const SandboxGainPoint& a = *(it - 1);

    const int64_t span = b.samplePos - a.samplePos;
    if (span <= 0) return b.db;                         // unsorted/duplicate input

    double t = static_cast<double>(samplePos - a.samplePos) / static_cast<double>(span);
    t = t * t * (3.0 - 2.0 * t);                        // smoothstep — zero slope at both handles
    return a.db + (b.db - a.db) * t;
}

double gainEnvelopeAt(const GainEnvelopeParams& p, int64_t samplePos) noexcept {
    return envDbToGain(gainEnvelopeDbAt(p, samplePos));
}

// ─── Autotune ─────────────────────────────────────────────────────────────────

void normalizeAutotune(AutotuneParams& p) {
    p.key = ((p.key % 12) + 12) % 12;

    // Out-of-range pitch classes are DROPPED rather than wrapped: a "13" in a
    // saved note set is a corrupt field, not a request for the octave above,
    // and silently turning it into a C would put a note in the user's scale
    // that they never picked. Sorted + de-duplicated so two note sets that
    // mean the same scale also hash the same and share one render.
    std::vector<int> notes;
    notes.reserve(p.allowedNotes.size());
    for (int pc : p.allowedNotes)
        if (pc >= 0 && pc <= 11) notes.push_back(pc);
    std::sort(notes.begin(), notes.end());
    notes.erase(std::unique(notes.begin(), notes.end()), notes.end());
    p.allowedNotes = std::move(notes);

    auto& c = p.correction;
    c.correctionAmount = std::clamp(c.correctionAmount, 0.0, 100.0);
    c.jumpiness        = std::clamp(c.jumpiness,        0.0, 100.0);
    c.preserveVibrato  = std::clamp(c.preserveVibrato,  0.0, 100.0);
    c.retuneSpeedMs    = std::clamp(c.retuneSpeedMs,    0.0, kAutotuneMaxRetuneMs);
    c.smoothnessMs     = std::clamp(c.smoothnessMs,     0.0, kAutotuneMaxSmoothnessMs);

    // Drop non-finite/non-positive-Hz breakpoints (a corrupt field, not a
    // pitch anyone drew), clamp tension into its reserved range, then
    // re-sort by time — evalManualCurve/computeManualCorrectionCurve assume
    // the ascending-by-timeSec invariant rather than re-checking it per call.
    std::vector<xleth::dsp::ManualPitchPoint> pts;
    pts.reserve(p.manualPoints.size());
    for (const auto& pt : p.manualPoints) {
        if (!std::isfinite(pt.timeSec) || !std::isfinite(pt.targetHz) || pt.targetHz <= 0.0)
            continue;
        xleth::dsp::ManualPitchPoint clean = pt;
        clean.tension = std::clamp(pt.tension, -1.0, 1.0);
        pts.push_back(clean);
    }
    std::stable_sort(pts.begin(), pts.end(),
                      [](const xleth::dsp::ManualPitchPoint& a, const xleth::dsp::ManualPitchPoint& b) {
                          return a.timeSec < b.timeSec;
                      });
    p.manualPoints = std::move(pts);
}

// ─── SandboxOp ────────────────────────────────────────────────────────────────

bool SandboxOp::implemented() const noexcept {
    switch (type) {
        case SandboxOpType::Trim:
        case SandboxOpType::Cut:
        case SandboxOpType::Paste:
        case SandboxOpType::Splice:
        case SandboxOpType::Reverse:
        case SandboxOpType::Fade:
        case SandboxOpType::Gain:
        case SandboxOpType::Crossfade:
        case SandboxOpType::GainEnvelope:
        case SandboxOpType::Pitch:
        case SandboxOpType::FormantShift:
        case SandboxOpType::Declip:
        case SandboxOpType::Denoise:
        case SandboxOpType::SpectralPaint:
        case SandboxOpType::Autotune:
            return true;
        // DSP deferred until the stretch engines are wired in.
        case SandboxOpType::Stretch:
            return false;
    }
    return false;
}

bool SandboxOp::autoRender() const noexcept {
    switch (type) {
        case SandboxOpType::Trim:
        case SandboxOpType::Cut:
        case SandboxOpType::Paste:
        case SandboxOpType::Splice:
        case SandboxOpType::Reverse:
        case SandboxOpType::Fade:
        case SandboxOpType::Gain:
        case SandboxOpType::Crossfade:
        case SandboxOpType::Pitch:
        case SandboxOpType::Stretch:
        // A per-sample curve evaluation over one buffer, offline — the same
        // order of cost as FADE. Nothing here justifies the manual fallback.
        case SandboxOpType::GainEnvelope:
        // RubberBand offline pitch/formant moves and the declip/denoise scans
        // are all single-pass over one buffer — heavier than a FADE, but still
        // a bounded per-edit cost, not the open-ended kind autoRender exists
        // to gate off (e.g. a future model-separation op).
        case SandboxOpType::FormantShift:
        case SandboxOpType::Declip:
        case SandboxOpType::Denoise:
        // An offline STFT pass over one buffer, same order of cost as
        // Denoise's — the dab-evaluation loop it adds on top is per-frame
        // arithmetic, not a second transform.
        case SandboxOpType::SpectralPaint:
        // AUTOTUNE's detection pass (a dense NSDF pitch track) is the most
        // expensive thing in this table, but SandboxRenderer caches it against
        // the identity of the op's INPUT prefix — so it runs ONCE when the op
        // is added and never again while the six controls are dragged, which
        // is the only interaction that would otherwise stall. The PSOLA
        // resynthesis on its own is a single overlap-add pass over one buffer,
        // the same order of cost as DENOISE.
        case SandboxOpType::Autotune:
            return true;
    }
    return true;
}

int64_t SandboxOp::outputLength(int64_t inputLength) const noexcept {
    if (inputLength < 0) inputLength = 0;
    if (!enabled || !implemented() || !consistent()) return inputLength;

    switch (type) {
        case SandboxOpType::Trim: {
            const auto& p = std::get<TrimParams>(params);
            const Range r = resolveRange(p.startSample, p.endSample, inputLength);
            return r.end - r.start;
        }
        case SandboxOpType::Cut: {
            const auto& p = std::get<CutParams>(params);
            const Range r = resolveRange(p.startSample, p.endSample, inputLength);
            if (p.mode == SandboxRippleMode::Gap) return inputLength;
            return inputLength - (r.end - r.start);
        }
        case SandboxOpType::Paste: {
            const auto& p = std::get<PasteParams>(params);
            const int64_t insLen = std::max<int64_t>(0, p.clipboardLengthSamples);
            // Overwrite never changes length, even past the buffer end — the
            // renderer clamps what actually gets written, same as GAIN/FADE.
            return p.insert ? inputLength + insLen : inputLength;
        }
        case SandboxOpType::Splice: {
            const auto& p = std::get<SpliceParams>(params);
            if (p.mode != SandboxRippleMode::Gap) return inputLength;
            return inputLength + std::max<int64_t>(0, p.gapSamples);
        }
        // The ONE length-changing pitch mode. Preserve holds length by
        // definition and falls through to the in-place default below.
        case SandboxOpType::Pitch: {
            const auto& p = std::get<PitchParams>(params);
            if (p.mode != SandboxPitchMode::Resample) return inputLength;
            return xleth::dsp::varispeedOutputLength(inputLength, p.cents);
        }
        // Reverse / Fade / Gain / Crossfade are all in-place.
        default:
            return inputLength;
    }
}

uint64_t SandboxOp::contentHash() const noexcept {
    // id and dirty are deliberately excluded — see the field comments in the
    // header. Type goes in first so two ops with coincidentally identical
    // param bytes (e.g. Trim and Reverse over the same range) never collide.
    uint64_t h = hashBool(hashI32(kFnvOffset, static_cast<int32_t>(type)), enabled);
    if (!consistent()) {
        // A malformed op hashes on its declared type alone. It renders as a
        // pass-through, so every malformed op of a type IS the same render.
        return hashU64(h, 0xBADC0FFEEull);
    }
    return std::visit(HashVisitor{h}, params);
}

// ─── Stack helpers ────────────────────────────────────────────────────────────

uint64_t prefixHash(const std::vector<SandboxOp>& ops, size_t count) noexcept {
    count = std::min(count, ops.size());
    // Seed with the count so a 2-op prefix can never digest to the same value
    // as a 3-op one whose third op happens to hash to the chaining identity.
    uint64_t h = hashU64(kFnvOffset, static_cast<uint64_t>(count));
    for (size_t i = 0; i < count; ++i) h = hashU64(h, ops[i].contentHash());
    return h;
}

uint64_t stackHash(const std::vector<SandboxOp>& ops) noexcept {
    return prefixHash(ops, ops.size());
}

int64_t stackOutputLength(const std::vector<SandboxOp>& ops, int64_t inputLength) noexcept {
    int64_t len = inputLength < 0 ? 0 : inputLength;
    for (const auto& op : ops) len = op.outputLength(len);
    return len;
}

// ─── JSON ─────────────────────────────────────────────────────────────────────

nlohmann::json opToJson(const SandboxOp& op) {
    nlohmann::json j = nlohmann::json::object();
    j["id"]      = op.id;
    j["type"]    = opTypeName(op.type);
    j["enabled"] = op.enabled;
    // `dirty` is NOT serialized: it describes this session's render state, not
    // the edit. A loaded stack starts dirty by definition — nothing has been
    // rendered yet — which SandboxCore::fromJson stamps on read.
    j["params"]  = op.consistent() ? std::visit(ToJsonVisitor{}, op.params)
                                   : std::visit(ToJsonVisitor{}, defaultParamsFor(op.type));
    return j;
}

bool opFromJson(const nlohmann::json& j, SandboxOp& out) {
    if (!j.is_object()) return false;

    SandboxOpType type{};
    const std::string name = readField<std::string>(j, "type", std::string{});
    if (!opTypeFromName(name, type)) return false;

    SandboxOp op;
    op.id      = readField<int>(j, "id", 0);
    op.type    = type;
    op.enabled = readField<bool>(j, "enabled", true);
    op.dirty   = true;                       // nothing rendered yet
    op.params  = defaultParamsFor(type);

    auto it = j.find("params");
    if (it != j.end() && it->is_object()) {
        std::visit(FromJsonVisitor{*it}, op.params);
    }

    out = std::move(op);
    return true;
}

nlohmann::json stackToJson(const std::vector<SandboxOp>& ops) {
    nlohmann::json j = nlohmann::json::object();
    j["sandboxStackVersion"] = kSandboxStackVersion;
    nlohmann::json arr = nlohmann::json::array();
    for (const auto& op : ops) arr.push_back(opToJson(op));
    j["ops"] = std::move(arr);
    return j;
}

bool stackFromJson(const nlohmann::json& j,
                   std::vector<SandboxOp>& out,
                   int* versionOut,
                   int* skipped) {
    const nlohmann::json* arr = nullptr;
    int version = kSandboxStackVersion;

    if (j.is_array()) {
        arr = &j;                                   // bare array — no wrapper
    } else if (j.is_object()) {
        version = readField<int>(j, "sandboxStackVersion", 1);
        auto it = j.find("ops");
        if (it == j.end() || !it->is_array()) return false;
        arr = &(*it);
    } else {
        return false;
    }

    std::vector<SandboxOp> ops;
    ops.reserve(arr->size());
    int skippedCount = 0;
    for (const auto& e : *arr) {
        SandboxOp op;
        if (opFromJson(e, op)) ops.push_back(std::move(op));
        else                   ++skippedCount;
    }

    out = std::move(ops);
    if (versionOut) *versionOut = version;
    if (skipped)    *skipped    = skippedCount;
    return true;
}

} // namespace xleth::sandbox
