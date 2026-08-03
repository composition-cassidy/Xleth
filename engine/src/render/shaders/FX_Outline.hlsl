// FX_Outline.hlsl — traces a coloured outline around the cell's alpha silhouette.
//
// Compile with fxc (CMake does NOT run fxc — the bytecode header beside this
// file is committed by hand):
//   fxc /T ps_5_0 /E PSMain /Fh FX_OutlinePS.h /Vn g_FX_OutlinePS FX_Outline.hlsl
//
// Purpose: finish the Chroma Key cutout look. Everything the keyer made
// transparent is background, and this pass draws a stroke of the user's colour
// hugging whatever survived. On footage with no keyer at all the silhouette is
// simply the cell rectangle, so the stroke frames the box.
//
// This runs as a TERMINAL stage, not as an ordinary chain pass: it renders into
// a render target PADDED by the stroke thickness, because a stroke has to live
// OUTSIDE the source's own bounds. See applyOutlineStage in GridCompositor.cpp.
// The source has already been blitted into the middle of that padded target, so
// the border texels around it are transparent and the search below is free to
// walk into them.
//
// STRAIGHT (non-premultiplied) alpha in and out — the single SRC_ALPHA composite
// in GridCompositor::drawCell is the only place alpha multiplies into RGB.

Texture2D    cellTexture   : register(t0);
SamplerState linearSampler : register(s0);

#include "FX_SilhouetteDistance.hlsli"

// ---------------------------------------------------------------------------
// Per-effect constant buffer at b2.
//
// NOT a raw copy of VisualEffect::params[] — the CPU side repacks it, because
// `texel` and `innerHalf` / `cornerRadiusPx` are derived from the padded render
// target's real dimensions rather than from user params. Keep this in sync with
// struct OutlineConstants in GridCompositor.h and with the canonical param list
// on VisualEffect in engine/src/model/TimelineTypes.h.
// ---------------------------------------------------------------------------
cbuffer OutlineConstants : register(b2)
{
    float3 outlineColor;    // params[0..2], 0..1
    float  thicknessPx;     // params[3], in TRUE render-target pixels
    float  softness;        // params[4], 0..1 — fraction of the thickness feathered
    float  opacity;         // params[5], 0..1
    float  alphaThreshold;  // params[6], 0..1 — alpha at/below this counts as background
    float  cornerRadiusPx;  // the CELL's corner radius, in texels; 0 = none
    float2 texel;           // 1/paddedWidth, 1/paddedHeight
    float2 innerHalf;       // half-extents of the content region, in texels
};

struct VSOutput
{
    float4 pos : SV_Position;
    float2 uv  : TEXCOORD0;
};

float4 PSMain(VSOutput input) : SV_Target
{
    float2 uv    = input.uv;
    float3 shape = float3(innerHalf, cornerRadiusPx);

    // The corner-rounding mask is applied here rather than at the final
    // composite (see xlShapeMask), so it has to be applied to the source too —
    // not just to the silhouette the stroke is measured against.
    float4 src = cellTexture.SampleLevel(linearSampler, uv, 0);
    src.a *= xlShapeMask(uv, texel, shape);

    float thickness = max(thicknessPx, 0.0);
    float alpha01   = saturate(opacity);
    if (thickness <= 0.0 || alpha01 <= 0.0)
        return src;                     // uniform branch — the whole wave takes it

    // Falloff band, in pixels of distance from the silhouette.
    //   softness 0 → e0/e1 straddle the thickness by half a pixel: a hard stroke
    //                with one pixel of anti-aliasing.
    //   softness 1 → e0 sits just inside the silhouette, so the stroke fades
    //                continuously all the way out: a glow.
    const float kHalfAA = 0.5;
    float e1 = thickness + kHalfAA;
    float e0 = min(thickness * (1.0 - saturate(softness)) - kHalfAA, e1 - 1e-4);

    float d       = xlDistanceToSilhouette(cellTexture, linearSampler, uv,
                                           texel, alphaThreshold, e1, shape);
    float strokeA = (1.0 - smoothstep(e0, e1, d)) * alpha01;

    // Composite the source OVER the stroke, in straight alpha. Deliberately not
    // masked by the silhouette: where the source is semi-transparent — a soft
    // matte edge — the stroke should show through it, which is exactly what
    // source-over does for free.
    float3 strokeRGB = saturate(outlineColor);
    float  aTop      = saturate(src.a);
    float  aBot      = saturate(strokeA);
    float  aOut      = aTop + aBot * (1.0 - aTop);

    float3 rgbOut = (aOut > 1e-5)
        ? (src.rgb * aTop + strokeRGB * aBot * (1.0 - aTop)) / aOut
        : src.rgb;

    return float4(rgbOut, aOut);
}
