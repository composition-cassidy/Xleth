// FX_Tint.hlsl — Lightness-aware colour tint effect
//
// Compile: fxc /T ps_5_0 /E PSMain /Fh FX_TintPS.h /Vn g_FX_TintPS FX_Tint.hlsl

Texture2D inputTexture : register(t0);
SamplerState linearSampler : register(s0);

cbuffer TintConstants : register(b2)
{
    float tintR, tintG, tintB, tintStrength;   // RGB tint colour + blend strength (0–1)
    float lightnessFloor, lightnessCeiling;     // tint only within this lightness band
    float pad0, pad1;
};

struct VSOutput
{
    float4 pos : SV_Position;
    float2 uv  : TEXCOORD0;
};

float4 PSMain(VSOutput input) : SV_Target
{
    float4 color = inputTexture.Sample(linearSampler, input.uv);
    float lightness = dot(color.rgb, float3(0.299, 0.587, 0.114));

    // Smooth mask: full tint between floor and ceiling, fades out toward edges
    float maskLow  = smoothstep(lightnessFloor  - 0.05, lightnessFloor  + 0.05, lightness);
    float maskHigh = 1.0 - smoothstep(lightnessCeiling - 0.05, lightnessCeiling + 0.05, lightness);
    float mask = maskLow * maskHigh;

    float3 tinted = color.rgb * float3(tintR, tintG, tintB);
    color.rgb = lerp(color.rgb, tinted, tintStrength * mask);
    return color;
}
