#include "ParamTrack.h"
#include "TimelineTypes.h"

#include <algorithm>
#include <cmath>
#include <cstdio>

namespace paramtrack {

// ===========================================================================
// Evaluation
// ===========================================================================

double evaluate(const ParamTrack& track, double normalizedTime) {
    const auto& keys = track.keys;
    if (keys.empty()) return track.constantValue;

    if (normalizedTime <= keys.front().t) return keys.front().value;
    if (normalizedTime >= keys.back().t)  return keys.back().value;

    // Linear scan. Tracks are tiny (2-3 keys after migration, a handful when
    // hand-authored), so a scan beats a binary search and keeps this branchy
    // code readable.
    std::size_t i = 0;
    while (i + 1 < keys.size() && keys[i + 1].t <= normalizedTime) ++i;
    if (i + 1 >= keys.size()) return keys.back().value;

    const Keyframe& a = keys[i];
    const Keyframe& b = keys[i + 1];

    const double span = b.t - a.t;
    if (span <= 0.0) return b.value;   // degenerate segment — snap to the far end

    const double x = (normalizedTime - a.t) / span;
    const double e = paramTrackEase(a.p1x, a.p1y, a.p2x, a.p2y, x);
    return a.value + (b.value - a.value) * e;
}

// ===========================================================================
// Mutation
// ===========================================================================

std::size_t insertKeyframe(ParamTrack& track, const Keyframe& k) {
    auto& keys = track.keys;

    // Replace an existing key at the same t rather than creating a zero-width
    // segment that evaluate() would have to special-case.
    for (std::size_t i = 0; i < keys.size(); ++i) {
        if (std::abs(keys[i].t - k.t) < 1e-12) {
            keys[i] = k;
            return i;
        }
    }

    auto pos = std::lower_bound(keys.begin(), keys.end(), k.t,
                                [](const Keyframe& kf, double t) { return kf.t < t; });
    const std::size_t idx = static_cast<std::size_t>(pos - keys.begin());
    keys.insert(pos, k);
    return idx;
}

bool removeKeyframe(ParamTrack& track, std::size_t index) {
    if (index >= track.keys.size()) return false;
    track.keys.erase(track.keys.begin() + static_cast<std::ptrdiff_t>(index));
    return true;
}

std::size_t moveKeyframe(ParamTrack& track, std::size_t index, double newT) {
    if (index >= track.keys.size()) return static_cast<std::size_t>(-1);
    Keyframe k = track.keys[index];
    k.t = newT;
    track.keys.erase(track.keys.begin() + static_cast<std::ptrdiff_t>(index));
    return insertKeyframe(track, k);
}

bool setKeyframeValue(ParamTrack& track, std::size_t index, double value) {
    if (index >= track.keys.size()) return false;
    track.keys[index].value = value;
    return true;
}

bool setKeyframeCurve(ParamTrack& track, std::size_t index, const EaseCurve& c) {
    if (index >= track.keys.size()) return false;
    Keyframe& k = track.keys[index];
    k.p1x = c.p1x;  k.p1y = c.p1y;
    k.p2x = c.p2x;  k.p2y = c.p2y;
    return true;
}

// ===========================================================================
// Time reversal
// ===========================================================================

void reverseInto(ParamTrack& out, const ParamTrack& in) {
    out.constantValue = in.constantValue;
    const auto& keys = in.keys;
    const std::size_t n = keys.size();
    out.keys.resize(n);
    if (n == 0) return;

    for (std::size_t j = 0; j < n; ++j) {
        // New keyframe j takes the (t, value) of old keyframe (n-1-j), mirrored
        // in t. Ascending j walks old keys in descending order, so new t is
        // ascending by construction (no re-sort needed).
        const std::size_t i = n - 1 - j;
        Keyframe& nk = out.keys[j];
        nk.t     = 1.0 - keys[i].t;
        nk.value = keys[i].value;

        if (j + 1 < n) {
            // New segment j (out.keys[j] -> out.keys[j+1]) is old segment i-1
            // (keys[i-1] -> keys[i]) played backward. Its curve is stored on
            // keys[i-1] (the segment's forward-start keyframe).
            const Keyframe& oldSeg = keys[i - 1];
            nk.p1x = 1.0 - oldSeg.p2x;
            nk.p1y = 1.0 - oldSeg.p2y;
            nk.p2x = 1.0 - oldSeg.p1x;
            nk.p2y = 1.0 - oldSeg.p1y;
        }
        // Curve on the last keyframe is meaningless (per Keyframe's own doc) —
        // leave it default.
    }
}

void normalize(ParamTrack& track) {
    auto& keys = track.keys;
    std::stable_sort(keys.begin(), keys.end(),
                     [](const Keyframe& a, const Keyframe& b) { return a.t < b.t; });
    // Collapse duplicate t (last one wins, matching insertKeyframe's replace).
    keys.erase(std::unique(keys.begin(), keys.end(),
                           [](const Keyframe& a, const Keyframe& b) {
                               return std::abs(a.t - b.t) < 1e-12;
                           }),
               keys.end());
}

// ===========================================================================
// Legacy easing migration
// ===========================================================================

bool legacyEasingToBezier(int easingType, double overshoot, EaseCurve& out) {
    switch (static_cast<LegacyEasing>(easingType)) {
        case LegacyEasing::Linear:
            out = EaseCurve{ 1.0 / 3.0, 1.0 / 3.0, 2.0 / 3.0, 2.0 / 3.0 };
            return true;
        case LegacyEasing::EaseOut:
            out = EaseCurve{ 1.0 / 3.0, 2.0 / 3.0, 2.0 / 3.0, 1.0 };
            return true;
        case LegacyEasing::EaseOutBack:
            // p1y = (s + 3) / 3, which exceeds 1 for every s > 0. Unclamped y
            // is what makes the overshoot survive the migration.
            out = EaseCurve{ 1.0 / 3.0, (overshoot + 3.0) / 3.0, 2.0 / 3.0, 1.0 };
            return true;
        case LegacyEasing::EaseInOut:
            // Two segments — buildLegacyTrack's job, not a single curve.
            return false;
        case LegacyEasing::Elastic:
        case LegacyEasing::Spring:
        default:
            return false;
    }
}

void buildLegacyTrack(ParamTrack& out, double from, double to,
                      int easingType, double overshoot) {
    // clear() keeps capacity, so a track rebuilt on every note-onset allocates
    // only the first time.
    out.keys.clear();
    out.constantValue = from;

    const auto easing = static_cast<LegacyEasing>(easingType);

    if (easing == LegacyEasing::EaseInOut) {
        // Piecewise-quadratic: exact as two cubic segments split at t = 0.5.
        // The legacy curve passes through exactly half the span at t = 0.5
        // (2 * 0.5^2 == 0.5), so the midpoint value is the plain average.
        Keyframe k0; k0.t = 0.0; k0.value = from;
        k0.p1x = kEaseInOutSegA.p1x; k0.p1y = kEaseInOutSegA.p1y;
        k0.p2x = kEaseInOutSegA.p2x; k0.p2y = kEaseInOutSegA.p2y;

        Keyframe k1; k1.t = 0.5; k1.value = from + (to - from) * 0.5;
        k1.p1x = kEaseInOutSegB.p1x; k1.p1y = kEaseInOutSegB.p1y;
        k1.p2x = kEaseInOutSegB.p2x; k1.p2y = kEaseInOutSegB.p2y;

        Keyframe k2; k2.t = 1.0; k2.value = to;   // curve on the last key is unused

        out.keys.push_back(k0);
        out.keys.push_back(k1);
        out.keys.push_back(k2);
        return;
    }

    EaseCurve c;
    if (!legacyEasingToBezier(easingType, overshoot, c)) {
        // Elastic (4) and Spring (5) are transcendental — no cubic bezier
        // represents them. Unreachable from the ZPR easing dropdown (0..3), so
        // this only fires on a hand-edited project. Log once per process so a
        // per-note-onset rebuild cannot flood the log.
        static bool warned = false;
        if (!warned) {
            warned = true;
            std::fprintf(stderr,
                "[ParamTrack] easing index %d (Elastic/Spring) has no cubic-bezier "
                "representation; falling back to Linear. Reachable only from a "
                "hand-edited project file.\n", easingType);
        }
        c = EaseCurve{ 1.0 / 3.0, 1.0 / 3.0, 2.0 / 3.0, 2.0 / 3.0 };
    }

    Keyframe k0; k0.t = 0.0; k0.value = from;
    k0.p1x = c.p1x; k0.p1y = c.p1y; k0.p2x = c.p2x; k0.p2y = c.p2y;

    Keyframe k1; k1.t = 1.0; k1.value = to;   // curve on the last key is unused

    out.keys.push_back(k0);
    out.keys.push_back(k1);
}

// ===========================================================================
// Serialization
// ===========================================================================

nlohmann::json toJson(const ParamTrack& track) {
    nlohmann::json j = nlohmann::json::object();
    j["constantValue"] = track.constantValue;

    if (!track.keys.empty()) {
        nlohmann::json arr = nlohmann::json::array();
        for (const auto& k : track.keys) {
            nlohmann::json kj = nlohmann::json::object();
            kj["t"] = k.t;
            kj["v"] = k.value;
            // Omit the curve when it is the default identity — keeps a linear
            // track compact and makes a hand-read file easier to scan.
            const bool identity =
                std::abs(k.p1x - 1.0 / 3.0) < 1e-12 && std::abs(k.p1y - 1.0 / 3.0) < 1e-12 &&
                std::abs(k.p2x - 2.0 / 3.0) < 1e-12 && std::abs(k.p2y - 2.0 / 3.0) < 1e-12;
            if (!identity)
                kj["c"] = nlohmann::json::array({ k.p1x, k.p1y, k.p2x, k.p2y });
            arr.push_back(kj);
        }
        j["keys"] = arr;
    }
    return j;
}

ParamTrack fromJson(const nlohmann::json& j) {
    ParamTrack track;
    if (!j.is_object()) return track;

    track.constantValue = j.value("constantValue", 0.0);

    if (j.contains("keys") && j.at("keys").is_array()) {
        for (const auto& kj : j.at("keys")) {
            if (!kj.is_object()) continue;
            Keyframe k;
            k.t     = kj.value("t", 0.0);
            k.value = kj.value("v", 0.0);
            if (kj.contains("c") && kj.at("c").is_array() && kj.at("c").size() >= 4) {
                const auto& c = kj.at("c");
                k.p1x = c[0].get<double>();
                k.p1y = c[1].get<double>();
                k.p2x = c[2].get<double>();
                k.p2y = c[3].get<double>();
            }
            track.keys.push_back(k);
        }
        // Never trust a loaded file's ordering.
        normalize(track);
    }
    return track;
}

} // namespace paramtrack

// ===========================================================================
// ZoomPanRot canonical-space track construction
// ===========================================================================
//
// Declared in TimelineTypes.h alongside ZprTracks / ZoomPanRotSettings.

static bool trackEquivalent(const paramtrack::ParamTrack& a,
                            const paramtrack::ParamTrack& b) {
    constexpr double kEps = 1e-9;
    if (a.keys.size() != b.keys.size()) return false;
    if (std::abs(a.constantValue - b.constantValue) > kEps) return false;
    for (std::size_t i = 0; i < a.keys.size(); ++i) {
        const auto& x = a.keys[i];
        const auto& y = b.keys[i];
        if (std::abs(x.t     - y.t)     > kEps) return false;
        if (std::abs(x.value - y.value) > kEps) return false;
        // Control points only matter on a segment that actually has one.
        if (i + 1 < a.keys.size()) {
            if (std::abs(x.p1x - y.p1x) > kEps) return false;
            if (std::abs(x.p1y - y.p1y) > kEps) return false;
            if (std::abs(x.p2x - y.p2x) > kEps) return false;
            if (std::abs(x.p2y - y.p2y) > kEps) return false;
        }
    }
    return true;
}

bool zprTracksEquivalent(const ZprTracks& a, const ZprTracks& b) {
    return trackEquivalent(a.panX,     b.panX)
        && trackEquivalent(a.panY,     b.panY)
        && trackEquivalent(a.zoomLog2, b.zoomLog2)
        && trackEquivalent(a.rotationDeg, b.rotationDeg);
}

void buildZprTracks(ZprTracks& out, const ZoomPanRotSettings& z) {
    buildZprTracks(out,
                   z.startZoom,     z.targetZoom,
                   z.startPanX,     z.targetPanX,
                   z.startPanY,     z.targetPanY,
                   z.startRotation, z.targetRotation,
                   z.zoomEasing, z.panEasing, z.rotEasing, z.overshoot);
    // Derived from the scalars by definition, so never "authored".
    out.authored = false;
}

void buildZprTracks(ZprTracks& out,
                    float zoomFrom,  float zoomTo,
                    float panXFrom,  float panXTo,
                    float panYFrom,  float panYTo,
                    float rotFrom,   float rotTo,
                    int zoomEasing, int panEasing, int rotEasing,
                    float overshoot) {
    // Zoom is interpolated in log2 space. A linear 1x -> 8x sweep is
    // perceptually non-uniform (it visually decelerates); log2 makes equal
    // steps of t equal ratios of magnification. exp2() is applied only when the
    // transform matrix is built, never here.
    paramtrack::buildLegacyTrack(out.zoomLog2,
                                 zprZoomToLog2(zoomFrom), zprZoomToLog2(zoomTo),
                                 zoomEasing, overshoot);

    // Pan is a UV OFFSET, not a focal centre — see the note on ZprTracks.
    paramtrack::buildLegacyTrack(out.panX, panXFrom, panXTo, panEasing, overshoot);
    paramtrack::buildLegacyTrack(out.panY, panYFrom, panYTo, panEasing, overshoot);

    // Rotation stays UNWRAPPED. 350 -> 370 must travel +20, not -340, so no
    // fmod / normalize is applied anywhere along this path.
    paramtrack::buildLegacyTrack(out.rotationDeg, rotFrom, rotTo, rotEasing, overshoot);
}
