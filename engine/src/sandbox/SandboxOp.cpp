#include "sandbox/SandboxOp.h"

#include <algorithm>
#include <bit>
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
        return hashBool(hashF64(h, p.cents), p.formantPreserve);
    }
    uint64_t operator()(const StretchParams& p) const {
        return hashI32(hashF64(h, p.ratio), p.algorithm);
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
        return { {"cents", p.cents}, {"formantPreserve", p.formantPreserve} };
    }
    nlohmann::json operator()(const StretchParams& p) const {
        return { {"ratio", p.ratio}, {"algorithm", p.algorithm} };
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
    }
    void operator()(StretchParams& p) const {
        p.ratio     = readField<double>(j, "ratio",     p.ratio);
        p.algorithm = readField<int>(j, "algorithm",    p.algorithm);
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
    }
    return GainParams{};
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
            return true;
        // DSP deferred until the stretch engines are wired in.
        case SandboxOpType::Pitch:
        case SandboxOpType::Stretch:
            return false;
    }
    return false;
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
