#include "render/VisualEchoTypes.h"

#include <algorithm>
#include <cmath>

namespace xleth::echo {

int EchoSettings::requiredRingFrames() const noexcept
{
    if (!active || taps <= 0 || !(frameDelay > 0.0f)) return 0;
    const double span = static_cast<double>(taps) * static_cast<double>(frameDelay);
    const int    need = static_cast<int>(std::ceil(span)) + 2;
    return std::clamp(need, 2, kMaxRingFrames);
}

// ── Orientation composition ─────────────────────────────────────────────────
//
// The Klein four-group {None, Horizontal, Vertical, Rotate180} is exactly the
// set of "mirror x?" x "mirror y?" — two independent bits — so composing two of
// its members is a plain XOR of those bits. That is the whole table.
//
//   enum:  0 None       (mx=0, my=0)
//          1 Horizontal (mx=1, my=0)
//          2 Vertical   (mx=0, my=1)
//          3 Rotate180  (mx=1, my=1)
//
// 4 (Rotate90CW) and 5 (Rotate90CCW) are outside it. A quarter-turn composed
// with a half-turn is the OTHER quarter-turn — exact and representable — but a
// quarter-turn composed with a single mirror is a diagonal reflection, which
// the shader has no transform for. Those are dropped rather than approximated.
namespace {

constexpr int kNone       = 0;
constexpr int kHorizontal = 1;
constexpr int kVertical   = 2;
constexpr int kRotate180  = 3;
constexpr int kRotate90CW = 4;
constexpr int kRot90CCW   = 5;

// The Klein element this tap contributes, by flip mode. tapIndex is 1-based.
int tapKleinElement(int flipMode, int tapIndex) noexcept
{
    const int n = tapIndex;
    switch (flipMode) {
        case kFlipAltHorizontal: return (n & 1) ? kHorizontal : kNone;
        case kFlipAltVertical:   return (n & 1) ? kVertical   : kNone;
        case kFlipAltHalfTurn:   return (n & 1) ? kRotate180  : kNone;
        case kFlipKleinCycle: {
            // None → H → Rotate180 → V → None …  a full lap of the subgroup, in
            // an order where each step changes exactly one mirror bit, so the
            // trail reads as a rotation rather than a random shuffle.
            static constexpr int kCycle[4] = { kNone, kHorizontal, kRotate180, kVertical };
            return kCycle[n & 3];
        }
        case kFlipNone:
        default:                 return kNone;
    }
}

} // namespace

int composeTapOrientation(int baseOrientation, int flipMode, int tapIndex) noexcept
{
    if (flipMode <= kFlipNone || flipMode >= kFlipModeCount) return baseOrientation;

    const int tap = tapKleinElement(flipMode, tapIndex);
    if (tap == kNone) return baseOrientation;

    if (baseOrientation == kRotate90CW || baseOrientation == kRot90CCW) {
        // Only the half-turn component survives: q ∘ Rotate180 is the opposite
        // quarter-turn. A mirror component would land on a diagonal reflection
        // the shader cannot express, so it is dropped (see the header note).
        if (tap == kRotate180)
            return (baseOrientation == kRotate90CW) ? kRot90CCW : kRotate90CW;
        return baseOrientation;
    }

    if (baseOrientation < kNone || baseOrientation > kRotate180)
        return baseOrientation;   // defensive: unknown enum value passes through

    return baseOrientation ^ tap;   // XOR of the two mirror bits
}

float tapGainAt(float g, int taps, int tapIndex) noexcept
{
    if (taps <= 0 || tapIndex < 1 || tapIndex > taps) return 0.0f;

    const float decay = std::pow(std::clamp(g, 0.0f, 1.0f),
                                 static_cast<float>(tapIndex));

    // Raised-cosine taper: 1 at tap 0 (the live frame), exactly 0 at tap == taps.
    // M_PI is not portable on MSVC without _USE_MATH_DEFINES; spell it out.
    constexpr float kPi = 3.14159265358979323846f;
    const float phase = kPi * static_cast<float>(tapIndex) / static_cast<float>(taps);
    const float taper = 0.5f * (1.0f + std::cos(phase));

    return decay * taper;
}

} // namespace xleth::echo
