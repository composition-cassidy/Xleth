// FX_VibratoSwirl.hlsl - clip-local Vibrato companion swirl
//
// Compile: fxc /T ps_5_0 /E PSMain /Fh FX_VibratoSwirlPS.h /Vn g_FX_VibratoSwirlPS FX_VibratoSwirl.hlsl

Texture2D    inputTexture  : register(t0);
SamplerState linearSampler : register(s0);

cbuffer VibratoSwirlConstants : register(b2)
{
    float amount;
    float radius;
    float centerX;
    float centerY;
    float lfo;
    float phase01;
    float cents;
    float pad0;
};

struct VSOutput
{
    float4 pos : SV_Position;
    float2 uv  : TEXCOORD0;
};

float4 PSMain(VSOutput input) : SV_Target
{
    float2 center = float2(centerX, centerY);
    float2 delta  = input.uv - center;
    float  r      = length(delta);
    float  safeRadius = max(radius, 0.0001);
    float  falloff = saturate(1.0 - r / safeRadius);
    falloff = falloff * falloff * (3.0 - 2.0 * falloff);

    // MVP is intentionally driven by vibratoLfo only. phase01 and cents are
    // carried for future use, but cents is not mixed into angle until a stable
    // normalization has been designed and verified.
    float angle = amount * 3.0 * lfo * falloff;
    angle = clamp(angle, -1.25, 1.25);
    float s = sin(angle);
    float c = cos(angle);
    float2 swirled = float2(delta.x * c - delta.y * s,
                            delta.x * s + delta.y * c) + center;

    swirled = clamp(swirled, 0.0, 1.0);
    return inputTexture.Sample(linearSampler, swirled);
}
