// FX_Mask.hlsl — Motion view Masks (docs/XLETH_MOTION_VIEW_DESIGN.md R11-R13, 3.4).
//
// Compile (PowerShell, from this directory; Git Bash mangles /T):
//   fxc /T ps_5_0 /E PSMain /Vn g_FX_MaskPS /Fh FX_MaskPS.h FX_Mask.hlsl
// CMake never runs fxc: regenerate and check in FX_MaskPS.h with every edit.
//
// A content stage of the cell (GridCompositor, after the companion FX and
// before the echo push and the Outline): the cell texture is copied into a
// cell-size target with its alpha multiplied by the masks' coverage. Every
// later stage (Outline, Drop Shadow, Echo, the final draw with its rotation,
// Roam, Parent, motion blur and scissor) therefore sees the masked picture.
//
// Geometry is computed on the CPU (render/MaskMath.h, which also holds the CPU
// reference of the arithmetic below): each mask is a closed polygon in CELL
// PIXELS (the drawn cell's size in output pixels, about its centre, y down).
// Coverage is evaluated where the final draw SHOWS the texel, i.e. at the
// inverse of its orientation, so the mask never flips with the content.
//
// Per mask: signed distance to the polygon (nonzero winding), minus the
// expansion, then a smoothstep centred on the edge as wide as the feather (one
// anti-aliasing pixel when the feather is 0), invert, then the R12
// combination top to bottom. Optionally the R9 carried-home clip quad of a
// parented Bounds Clip cell is intersected last, as a hard edge.

#define MAX_MASKS        9      // kMaskFrameMasks: 8 user masks + the Roam crop
#define MAX_MASK_POINTS  1092   // maskmath::kMaskMaxPoints (two per float4)

cbuffer MaskConstants : register(b2)
{
    int    maskCount;     // 0..MAX_MASKS, top to bottom
    int    orientation;   // the final draw's orientation (0..5)
    int    clipFirst;     // first point of the clip quad, -1 = none
    int    maskPad0;
    float2 cellPx;        // the drawn cell, output pixels
    float  aaPx;          // anti-aliasing width, pixels
    float  maskPad1;
    int4   maskInfo[MAX_MASKS];     // firstPoint, pointCount, mode (Add 0, Subtract 1, Intersect 2), invert
    float4 maskParams[MAX_MASKS];   // featherPx, expansionPx, opacity, 0
    float4 maskPoints[MAX_MASK_POINTS / 2];
};

Texture2D    cellTexture   : register(t0);
SamplerState linearSampler : register(s0);

struct VSOutput
{
    float4 pos : SV_Position;
    float2 uv  : TEXCOORD0;
};

float2 pointAt(int i)
{
    const float4 q = maskPoints[i >> 1];
    return (i & 1) ? q.zw : q.xy;
}

// Signed distance (pixels, negative inside) to a closed polygon; inside by
// the nonzero winding rule.
float polygonSdf(float2 p, int first, int count)
{
    float d = 1e30f;
    int wind = 0;
    float2 a = pointAt(first + count - 1);
    [loop]
    for (int i = 0; i < count; ++i)
    {
        const float2 b = pointAt(first + i);
        const float2 e = b - a;
        const float2 w = p - a;
        const float  t = saturate(dot(w, e) / max(dot(e, e), 1e-12f));
        const float2 q = w - e * t;
        d = min(d, dot(q, q));
        const float cr = e.x * w.y - e.y * w.x;
        if (a.y <= p.y) { if (b.y > p.y && cr > 0.0f) wind += 1; }
        else            { if (b.y <= p.y && cr < 0.0f) wind -= 1; }
        a = b;
    }
    const float s = sqrt(d);
    return wind != 0 ? -s : s;
}

float edgeCoverage(float d, float featherPx)
{
    const float w = max(featherPx, aaPx);
    return 1.0f - smoothstep(-0.5f * w, 0.5f * w, d);
}

float4 PSMain(VSOutput input) : SV_Target
{
    const float2 t = input.uv;
    float4 color = cellTexture.Sample(linearSampler, t);

    // Where the final draw shows this texel (inverse of sampleUV = orient(localUV)).
    float2 local = t;
    if      (orientation == 1) local = float2(1.0f - t.x, t.y);
    else if (orientation == 2) local = float2(t.x, 1.0f - t.y);
    else if (orientation == 3) local = float2(1.0f - t.x, 1.0f - t.y);
    else if (orientation == 4) local = float2(1.0f - t.y, t.x);
    else if (orientation == 5) local = float2(t.y, 1.0f - t.x);
    const float2 p = (local - 0.5f) * cellPx;

    // R12 start: 0 when the first mask that has any opacity adds, else 1. A
    // mask at opacity 0 has no effect, so it must not pick the start either
    // (render/MaskMath.h maskStart, the CPU reference).
    float acc = 1.0f;
    [loop]
    for (int k = 0; k < maskCount; ++k)
    {
        if (maskParams[k].z > 0.0f)
        {
            acc = maskInfo[k].z == 0 ? 0.0f : 1.0f;
            break;
        }
    }
    [loop]
    for (int m = 0; m < maskCount; ++m)
    {
        const int4   info = maskInfo[m];
        const float4 prm  = maskParams[m];
        float c = 0.0f;
        if (info.y >= 3)
        {
            const float d = polygonSdf(p, info.x, info.y) - prm.y;
            c = edgeCoverage(d, prm.x);
        }
        if (info.w != 0) c = 1.0f - c;
        const float oc = prm.z * c;
        if      (info.z == 1) acc = acc * (1.0f - oc);
        else if (info.z == 2) acc = acc * (1.0f - prm.z * (1.0f - c));
        else                  acc = acc + oc - acc * oc;
    }
    if (clipFirst >= 0)
    {
        const float d = polygonSdf(p, clipFirst, 4);
        acc *= saturate(0.5f - d / aaPx);
    }

    color.a *= acc;
    return color;
}
