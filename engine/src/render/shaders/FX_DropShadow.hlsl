// FX_DropShadow.hlsl — builds a drop-shadow LAYER from the cell's alpha silhouette.
//
// Compile with fxc (CMake does NOT run fxc — the bytecode header beside this
// file is committed by hand):
//   fxc /T ps_5_0 /E PSMain /Fh FX_DropShadowPS.h /Vn g_FX_DropShadowPS FX_DropShadow.hlsl
//
// This pass does NOT output the cell composited over its shadow. It outputs the
// shadow on its own, into a padded render target, and GridCompositor then draws
// that target as a separate quad BEHIND the cell. That separation is what makes
// the darkening blend modes real: a shadow set to Multiply has to multiply
// against whatever is behind the cell (a fullscreen layer, a lower-z cell), and
// nothing inside the per-cell effect chain can see the backdrop.
//
// Because the blend has to be fixed-function at that composite draw, the mode's
// arithmetic is baked into what this shader emits — see the emit table at the
// bottom. The matching blend states live in GridCompositor::createPipelineState.
//
// Shape pipeline: silhouette → offset → inflate (spread) → feather.

Texture2D    cellTexture   : register(t0);
SamplerState linearSampler : register(s0);

#include "FX_SilhouetteDistance.hlsli"

// ---------------------------------------------------------------------------
// Per-effect constant buffer at b2.
//
// NOT a raw copy of VisualEffect::params[] — the CPU side repacks it: the user's
// distance/angle pair becomes a single UV offset (orientation-compensated, so a
// mirrored cell's shadow still falls the way the angle says), and the 0..1 size
// and softness sliders become pixel radii. Keep in sync with struct
// DropShadowConstants in GridCompositor.h and the canonical param list on
// VisualEffect in engine/src/model/TimelineTypes.h.
// ---------------------------------------------------------------------------
cbuffer DropShadowConstants : register(b2)
{
    float3 shadowColor;     // params[0..2], 0..1
    float  opacity;         // params[7] * the cell's own opacity
    float2 offsetUV;        // params[3]/[4] (distance px + angle°) resolved to UV
    float  inflatePx;       // params[5] mapped to a dilation radius in real pixels
    float  blurPx;          // params[6] mapped to a feather radius in real pixels
    float2 texel;           // 1/paddedWidth, 1/paddedHeight
    float  alphaThreshold;  // params[9], 0..1 — alpha at/below this casts no shadow
    float  blendMode;       // params[8] rounded: 0=Normal 1=Multiply 2=Darken 3=LinearBurn
    float2 innerHalf;       // half-extents of the content region, in texels
    float  cornerRadiusPx;  // the CELL's corner radius, in texels; 0 = none
    float  dropShadowPad0;
};

struct VSOutput
{
    float4 pos : SV_Position;
    float2 uv  : TEXCOORD0;
};

float4 PSMain(VSOutput input) : SV_Target
{
    // Reading the silhouette from uv - offsetUV moves the shadow BY +offsetUV.
    float2 p     = input.uv - offsetUV;
    float3 shape = float3(innerHalf, cornerRadiusPx);

    // Feather band, in pixels of distance from the silhouette, centred on the
    // inflate radius. Clamped at zero because the distance field is unsigned:
    // the shadow keeps a solid core and softens outward only. Hidden behind the
    // cell in every case except a shadow softer than it is offset, where the
    // alternative (a shadow that also thins under the subject) would look
    // washed out rather than more correct.
    float inflate  = max(inflatePx, 0.0);
    float blurHalf = max(blurPx, 0.5);          // 0.5 px keeps a hard edge anti-aliased
    float e0 = max(inflate - blurHalf, 0.0);
    float e1 = max(inflate + blurHalf, e0 + 1e-4);

    // A foreground pixel is zero pixels from itself. The outward search starts
    // one step out, so without this the whole interior would read as empty and
    // a size-0 / softness-0 shadow would vanish entirely.
    float here = xlSilhouetteAt(cellTexture, linearSampler, p, alphaThreshold, texel, shape);
    float d = (here > 0.5)
        ? 0.0
        : xlDistanceToSilhouette(cellTexture, linearSampler, p, texel,
                                 alphaThreshold, e1, shape);

    float a = (1.0 - smoothstep(e0, e1, d)) * saturate(opacity);
    float3 c = saturate(shadowColor);

    // ---- Emit in the form the mode's fixed-function blend expects ----------
    // Alpha is always plain coverage; every mode's blend state uses
    // ONE / INV_SRC_ALPHA on alpha, so the shadow accumulates coverage normally
    // and stays visible when the backdrop is still transparent.
    //
    //   Normal      SRC_ALPHA / INV_SRC_ALPHA   → c*a + dst*(1-a)
    //   Multiply    DEST_COLOR / ZERO           → dst * lerp(1,c,a)
    //   Darken      ONE / ONE, OP_MIN           → min(lerp(1,c,a), dst)
    //   LinearBurn  ONE / ONE, OP_REV_SUBTRACT  → dst - (1-c)*a
    //
    // Colour Burn is deliberately absent: 1-(1-dst)/c cannot be expressed as a
    // fixed-function blend, and reading the backdrop as a texture would mean
    // resolving the output target mid-cell-loop.
    if (blendMode < 0.5)
        return float4(c, a);                                // Normal
    if (blendMode < 2.5)
        return float4(lerp(float3(1.0, 1.0, 1.0), c, a), a); // Multiply, Darken
    return float4((1.0 - c) * a, a);                         // Linear Burn
}
