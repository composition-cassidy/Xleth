// FX_BrightnessContrast.hlsl — Brightness and contrast adjustment
//
// Compile: fxc /T ps_5_0 /E PSMain /Fh FX_BrightnessContrastPS.h /Vn g_FX_BrightnessContrastPS FX_BrightnessContrast.hlsl

Texture2D inputTexture : register(t0);
SamplerState linearSampler : register(s0);

cbuffer BrightContConstants : register(b2)
{
    float brightness;   // -1.0 to 1.0  (0 = neutral)
    float contrast;     // -1.0 to 1.0  (0 = neutral)
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
    // Brightness: additive offset
    color.rgb += brightness;
    // Contrast: scale around 0.5 midpoint
    float contrastFactor = max(1.0 + contrast * 2.0, 0.0);
    color.rgb = (color.rgb - 0.5) * contrastFactor + 0.5;
    color.rgb = saturate(color.rgb);
    return color;
}
