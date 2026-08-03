// FX_SilhouetteDistance.hlsli — shared alpha-silhouette distance field.
//
// Included by FX_Outline.hlsl and FX_DropShadow.hlsl. Both effects need the same
// question answered — "how many pixels away is the nearest foreground pixel?" —
// and both feed the answer to a single smoothstep, which is what lets one code
// path render a hard edge, a soft feather and a wide glow.
//
// fxc resolves #include relative to the including file, so no /I is needed:
//   fxc /T ps_5_0 /E PSMain /Fh FX_OutlinePS.h /Vn g_FX_OutlinePS FX_Outline.hlsl
//
// Everything is passed explicitly rather than read from an ambient cbuffer, so
// the two includers stay free to lay out their own constant buffers.
//
// IMPORTANT: recompile BOTH bytecode headers after editing this file. CMake does
// not run fxc, so a stale FX_OutlinePS.h / FX_DropShadowPS.h will silently keep
// the old algorithm.

#ifndef XL_FX_SILHOUETTE_DISTANCE_INCLUDED
#define XL_FX_SILHOUETTE_DISTANCE_INCLUDED

// 16 evenly spaced unit directions. 16 is the point where a convex silhouette
// corner stops showing facets at the radii these effects are tuned for
// (<= ~32 px); 8 visibly flattens corners, 32 doubles the cost for no gain.
static const float2 kXlDir16[16] = {
    float2( 1.00000,  0.00000), float2( 0.92388,  0.38268),
    float2( 0.70711,  0.70711), float2( 0.38268,  0.92388),
    float2( 0.00000,  1.00000), float2(-0.38268,  0.92388),
    float2(-0.70711,  0.70711), float2(-0.92388,  0.38268),
    float2(-1.00000,  0.00000), float2(-0.92388, -0.38268),
    float2(-0.70711, -0.70711), float2(-0.38268, -0.92388),
    float2( 0.00000, -1.00000), float2( 0.38268, -0.92388),
    float2( 0.70711, -0.70711), float2( 0.92388, -0.38268)
};

// Steps taken along each direction. The step length is derived from the search
// radius so short radii advance exactly one pixel at a time — an exact distance
// field, hence a clean hard edge. Past 16 px the step grows and the measured
// distance quantises, which only shows on a hard-edged stroke that wide.
static const int kXlSteps = 16;

// ---------------------------------------------------------------------------
// Signed distance to a rounded rectangle centred on the origin. Same formula as
// GridComposite.hlsl's roundedRectSDF; duplicated because these are separate
// compilation units with no shared prelude.
// ---------------------------------------------------------------------------
float xlRoundedRectSDF(float2 p, float2 halfSize, float radius)
{
    float2 q = abs(p) - halfSize + radius;
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - radius;
}

// ---------------------------------------------------------------------------
// Corner-rounding mask for the cell's content region.
//
// `shape` = (innerHalfW, innerHalfH, cornerRadiusPx), all in TRUE texels of the
// padded render target, with the content region centred (the pad is symmetric).
// A radius of 0 disables the mask, which is the common case.
//
// This exists because the cell's corner radius is normally applied by
// GridComposite.hlsl at the FINAL composite, over whatever rect is drawn. Once
// a stroke has grown that rect, applying it there would round the padded
// boundary and leave the video's own corners square. So when a padded stage
// runs, it takes ownership of the rounding: it masks the silhouette here, which
// also makes the stroke trace the rounded corner instead of cutting across it,
// and the caller passes cornerRadius = 0 to drawCell.
// ---------------------------------------------------------------------------
float xlShapeMask(float2 uv, float2 texel, float3 shape)
{
    float radius = shape.z;
    if (radius <= 0.0) return 1.0;

    float2 halfSize = max(shape.xy, 1e-3);
    float  r        = min(radius, min(halfSize.x, halfSize.y));

    // Texels from the target's centre. texel is 1/width, so dividing by it
    // converts a UV offset back into real texels — the aspect ratio is therefore
    // exact, which is the whole reason this is not done in the blit's composite
    // pass (that one only has the OUTPUT dimensions to work from).
    float2 posPx = (uv - 0.5) / max(texel, 1e-9);
    float  sdf   = xlRoundedRectSDF(posPx, halfSize, r);
    return 1.0 - smoothstep(-1.0, 1.0, sdf);
}

// ---------------------------------------------------------------------------
// Silhouette test: 1 = foreground, 0 = background.
//
// The user-facing rule is "treat anything at or below ~95% alpha as background",
// which exists so a keyer that leaves a faint wash of background alpha behind
// is not mistaken for solid subject. A 0.02-wide ramp above the threshold keeps
// the distance field smooth enough to anti-alias instead of stair-stepping.
//
// Callers sample a render target whose border texels are transparent and whose
// sampler is CLAMP, so a tap that walks off the edge repeats a transparent texel
// and correctly reads as background.
//
// SampleLevel(..., 0) rather than Sample(): the search loop below breaks on the
// first hit, so its iteration count varies across a wave, and an implicit-LOD
// sample there has undefined derivatives (fxc warning X3595). These render
// targets are single-mip so the LOD choice is academic, but asking for level 0
// explicitly makes that a guarantee instead of an accident.
// ---------------------------------------------------------------------------
float xlSilhouetteAt(Texture2D tex, SamplerState samp, float2 uv,
                     float threshold, float2 texel, float3 shape)
{
    float a  = tex.SampleLevel(samp, uv, 0).a * xlShapeMask(uv, texel, shape);
    float lo = saturate(threshold);
    float hi = min(1.0, lo + 0.02);
    return smoothstep(lo, max(hi, lo + 1e-4), a);
}

// ---------------------------------------------------------------------------
// Distance in pixels from `uv` to the nearest foreground pixel, searched
// outward along kXlDir16 and capped at `maxPx`. Returns 1e9 when nothing
// foreground lies within range.
//
// Walking outward and stopping at the first hit is what makes this a distance
// measurement rather than a coverage estimate. Coverage-style dilation (max over
// a disc of taps) bands badly once the radius exceeds a couple of ring steps,
// and cannot express "hard edge at exactly R px" at all.
// ---------------------------------------------------------------------------
float xlDistanceToSilhouette(Texture2D tex, SamplerState samp, float2 uv,
                             float2 texel, float threshold, float maxPx,
                             float3 shape)
{
    float stepPx = max(maxPx / float(kXlSteps), 1.0);
    float best   = 1e9;

    [unroll]
    for (int i = 0; i < 16; ++i)
    {
        float2 dir = kXlDir16[i];
        [loop]
        for (int s = 1; s <= kXlSteps; ++s)
        {
            float rad = float(s) * stepPx;
            if (rad > maxPx + 0.001) break;
            if (xlSilhouetteAt(tex, samp, uv + dir * rad * texel,
                               threshold, texel, shape) > 0.5)
            {
                best = min(best, rad);
                break;
            }
        }
    }
    return best;
}

#endif  // XL_FX_SILHOUETTE_DISTANCE_INCLUDED
