// FX_ZoomPanRotation.hlsl — Zoom / Pan / Rotation effect
//
// Compile: fxc /T ps_5_0 /E PSMain /Fh FX_ZoomPanRotationPS.h /Vn g_FX_ZoomPanRotationPS FX_ZoomPanRotation.hlsl

Texture2D    inputTexture  : register(t0);
SamplerState linearSampler : register(s0);

#define MAX_MOTION_TAPS 32

// Matches struct ZprConstants in GridCompositor.h.
cbuffer ZPRConstants : register(b0)
{
    float zoom;      // current interpolated zoom (1.0 = no zoom)
    float panX;      // current interpolated pan X (-1..1, 0=center)
    float panY;      // current interpolated pan Y (-1..1, 0=center)
    float rotRad;    // current interpolated rotation in RADIANS
    // Motion blur (render/MotionBlur.h): taps > 1 averages the pass over
    // tap[0..taps) = (zoom, panX, panY, rotRad) sub-frame poses instead of
    // the single pose above. taps <= 1 runs the original single sample.
    int    taps;
    int3   tapPad;
    float4 tap[MAX_MOTION_TAPS];
};

struct VSOutput
{
    float4 pos : SV_Position;
    float2 uv  : TEXCOORD0;
};

// One pose's source UV for destination `uv`: the same arithmetic as PSMain.
float2 zprSourceUV(float2 uv, float z, float px, float py, float r, float aspect)
{
    uv -= 0.5;
    uv.x *= aspect;
    float s = sin(r);
    float c = cos(r);
    uv = float2(uv.x * c - uv.y * s, uv.x * s + uv.y * c);
    uv.x /= aspect;
    uv /= max(z, 0.001);
    uv -= float2(px, py);
    uv += 0.5;
    return clamp(uv, 0.0, 1.0);
}

float4 PSMain(VSOutput input) : SV_Target
{
    float2 uv = input.uv;

    if (taps > 1)
    {
        uint tw, th;
        inputTexture.GetDimensions(tw, th);
        const float aspectM = (tw > 0u && th > 0u) ? float(tw) / float(th) : 1.0;
        const int n = min(taps, MAX_MOTION_TAPS);
        float4 acc = float4(0.0, 0.0, 0.0, 0.0);   // premultiplied
        [loop]
        for (int i = 0; i < n; ++i)
        {
            float4 c = inputTexture.SampleLevel(linearSampler,
                zprSourceUV(uv, tap[i].x, tap[i].y, tap[i].z, tap[i].w, aspectM), 0.0);
            acc += float4(c.rgb * c.a, c.a);
        }
        acc /= float(n);
        return acc.a > 0.0 ? float4(acc.rgb / acc.a, acc.a) : float4(0.0, 0.0, 0.0, 0.0);
    }

    // Center UVs on cell midpoint
    uv -= 0.5;

    // Rotation, rigid in PIXELS. UV space is stretched to the cell's aspect,
    // so rotating there sheared the picture: a 16:9 cell turned 90 degrees
    // came out squashed to 9:16-in-16:9. Scale u to pixel proportions, rotate,
    // scale back (the same rule LensRoamMath::computeRoamInverse follows).
    uint texW, texH;
    inputTexture.GetDimensions(texW, texH);
    const float aspect = (texW > 0u && texH > 0u) ? float(texW) / float(texH) : 1.0;
    uv.x *= aspect;
    float s = sin(rotRad);
    float c = cos(rotRad);
    uv = float2(uv.x * c - uv.y * s, uv.x * s + uv.y * c);
    uv.x /= aspect;

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
