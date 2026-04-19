// FX_Desaturation.hlsl — Greyscale desaturation effect
//
// Compile: fxc /T ps_5_0 /E PSMain /Fh FX_DesaturationPS.h /Vn g_FX_DesaturationPS FX_Desaturation.hlsl

Texture2D inputTexture : register(t0);
SamplerState linearSampler : register(s0);

cbuffer DesatConstants : register(b2)
{
    float amount;       // 0.0 = full color, 1.0 = full greyscale
    float pad0, pad1, pad2;
};

struct VSOutput
{
    float4 pos : SV_Position;
    float2 uv  : TEXCOORD0;
};

float4 PSMain(VSOutput input) : SV_Target
{
    float4 color = inputTexture.Sample(linearSampler, input.uv);
    float luma = dot(color.rgb, float3(0.299, 0.587, 0.114));
    color.rgb = lerp(color.rgb, float3(luma, luma, luma), amount);
    return color;
}
