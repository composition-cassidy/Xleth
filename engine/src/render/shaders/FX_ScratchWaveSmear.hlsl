// FX_ScratchWaveSmear.hlsl - clip-local Scratch companion wave/smear
//
// Compile: fxc /T ps_5_0 /E PSMain /Fh FX_ScratchWaveSmearPS.h /Vn g_FX_ScratchWaveSmearPS FX_ScratchWaveSmear.hlsl

Texture2D    inputTexture  : register(t0);
SamplerState linearSampler : register(s0);

cbuffer ScratchWaveSmearConstants : register(b2)
{
    float amount;
    float frequency;
    float smearAmount;
    float reverseWithScratch;
    float rateMultiplier;
    float phase01;
    float intensity01;
    float pad0;
};

struct VSOutput
{
    float4 pos : SV_Position;
    float2 uv  : TEXCOORD0;
};

float4 PSMain(VSOutput input) : SV_Target
{
    float direction = 1.0;
    if (reverseWithScratch > 0.5 && rateMultiplier < 0.0)
        direction = -1.0;

    float intensity = saturate(intensity01);
    float phase = phase01 * 6.28318531;
    float safeFrequency = clamp(frequency, 0.25, 64.0);
    float wave = sin(input.uv.y * safeFrequency * 6.28318531 + phase);
    float offset = wave * amount * 1.5 * intensity * direction;
    offset = clamp(offset, -0.35, 0.35);

    float2 uv = clamp(float2(input.uv.x + offset, input.uv.y), 0.0, 1.0);
    float4 color = inputTexture.Sample(linearSampler, uv);

    float smear = saturate(abs(smearAmount)) * intensity;
    if (smear > 0.0001) {
        float smearOffset = smearAmount * 0.25 * direction * intensity;
        smearOffset = clamp(smearOffset, -0.25, 0.25);
        float2 uvA = clamp(float2(uv.x - smearOffset, uv.y), 0.0, 1.0);
        float2 uvB = clamp(float2(uv.x + smearOffset, uv.y), 0.0, 1.0);
        float4 smearColor = (inputTexture.Sample(linearSampler, uvA)
                           + inputTexture.Sample(linearSampler, uvB)) * 0.5;
        color = lerp(color, smearColor, smear);
    }

    return color;
}
