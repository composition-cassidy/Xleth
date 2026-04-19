// FX_ZoomPanRotation.hlsl — Zoom / Pan / Rotation effect
//
// Compile: fxc /T ps_5_0 /E PSMain /Fh FX_ZoomPanRotationPS.h /Vn g_FX_ZoomPanRotationPS FX_ZoomPanRotation.hlsl

Texture2D    inputTexture  : register(t0);
SamplerState linearSampler : register(s0);

cbuffer ZPRConstants : register(b0)
{
    float zoom;      // current interpolated zoom (1.0 = no zoom)
    float panX;      // current interpolated pan X (-1..1, 0=center)
    float panY;      // current interpolated pan Y (-1..1, 0=center)
    float rotRad;    // current interpolated rotation in RADIANS
};

struct VSOutput
{
    float4 pos : SV_Position;
    float2 uv  : TEXCOORD0;
};

float4 PSMain(VSOutput input) : SV_Target
{
    float2 uv = input.uv;

    // Center UVs on cell midpoint
    uv -= 0.5;

    // Rotation
    float s = sin(rotRad);
    float c = cos(rotRad);
    uv = float2(uv.x * c - uv.y * s, uv.x * s + uv.y * c);

    // Zoom (divide UVs: smaller range = zoomed in)
    uv /= max(zoom, 0.001);

    // Pan (shift in normalized cell space)
    uv -= float2(panX, panY);

    // Back to [0,1]
    uv += 0.5;

    // Clamp to edge (stretches edge pixels rather than wrapping/clipping)
    uv = clamp(uv, 0.0, 1.0);

    return inputTexture.Sample(linearSampler, uv);
}
