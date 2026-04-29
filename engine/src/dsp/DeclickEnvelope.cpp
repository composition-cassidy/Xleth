#include "dsp/DeclickEnvelope.h"
#include <cmath>

namespace xleth::dsp {

std::array<float, DeclickEnvelope::kLutSize> DeclickEnvelope::sLut{};
bool DeclickEnvelope::sInitialized = false;

void DeclickEnvelope::initialize()
{
    if (sInitialized) return;
    constexpr float kPi = 3.14159265358979323846f;
    for (int i = 0; i < kLutSize; ++i)
    {
        const float t = static_cast<float>(i) / static_cast<float>(kLutSize - 1);
        sLut[i] = 0.5f * (1.0f - cosf(kPi * t));
    }
    sInitialized = true;
}

} // namespace xleth::dsp
