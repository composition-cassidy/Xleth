// GridComposite.hlsl — Vertex + Pixel shaders for D3D11 grid compositor.
//
// Compile with fxc:
//   fxc /T vs_5_0 /E VSMain /Fh GridCompositeVS.h GridComposite.hlsl
//   fxc /T ps_5_0 /E PSMain /Fh GridCompositePS.h GridComposite.hlsl
//
// Phase 4 (flip v2): the legacy `flipMode` + `globalNoteIndex` cbuffer pair is
// gone. Per-cell flip state is now resolved at event-build time by the
// VideoFlipResolver and baked into a flat `orientation` enum that this shader
// reads directly. Six orientations cover the D₄-subset used by Sparta
// remixers; diagonal mirrors are deferred. See xleth-flip-v2-architecture-spec.md
// §5.3 for the canonical UV transforms and §7.6 for byte-identical migration
// parity against the legacy shader on ordinals 0..7.

// ---------------------------------------------------------------------------
// Per-draw constant buffer (matches struct CellConstants in GridCompositor.h)
// ---------------------------------------------------------------------------
//
// Lens + Roam (P2, docs/XLETH_LENS_ROAM_SPEC.md). Two optional affine maps,
// switched on per draw by `xformFlags`. Every value is computed on the CPU by
// render/LensRoamMath.h (the one evaluator preview and export share); this
// shader only applies them. xformFlags == 0 runs today's exact arithmetic,
// so an identity Lens/Roam (every old project) renders bit-identically.
//   bit 0  kXformLens  localUV -> source UV through lensRow0/1; a sample
//                      outside [0,1] is the cell background (transparent,
//                      what an empty cell shows today). Used by the Lens
//                      framing pass, which runs BEFORE the visual effects.
//   bit 1  kXformRoam  screen UV -> localUV through roamRow0/1 (a Roam
//                      rotation about the cell centre), replacing the
//                      axis-aligned (uv - xy) / zw.
cbuffer CellConstants : register(b0)
{
    float4 cellRect;        // (x, y, width, height) in UV space [0,1]
    float  opacity;         // slot.opacity * event.opacity
    int    orientation;     // 0=none, 1=h, 2=v, 3=rot180, 4=rot90cw, 5=rot90ccw
    float  cornerRadius;    // 0.0–1.0 corner rounding (fraction of min(w,h))
    int    xformFlags;      // bit 0 = Lens map, bit 1 = Roam inverse
    float4 lensRow0;        // sampleUV.x = dot(lensRow0.xy, localUV) + lensRow0.z
    float4 lensRow1;        // sampleUV.y = dot(lensRow1.xy, localUV) + lensRow1.z
    float4 roamRow0;        // localUV.x  = dot(roamRow0.xy, uv) + roamRow0.z
    float4 roamRow1;        // localUV.y  = dot(roamRow1.xy, uv) + roamRow1.z
};

// ---------------------------------------------------------------------------
// Per-frame global constant buffer
// ---------------------------------------------------------------------------
cbuffer GlobalConstants : register(b1)
{
    float  gTime;           // seconds since playback start
    float  gOutputWidth;    // render target width in pixels
    float  gOutputHeight;   // render target height in pixels
    float  gPadding;
};

// ---------------------------------------------------------------------------
// Motion blur taps (matches struct MotionConstants in GridCompositor.h).
// Read ONLY when xformFlags carries a motion bit; otherwise whatever is bound
// at b3 is ignored. Every map is computed on the CPU (render/MotionBlur.h).
//   bit 2  kXformMotionLens    tap i frames the source with motionRow0/1[i]
//                              in place of lensRow0/1 (the Lens framing pass)
//   bit 3  kXformMotionScreen  tap i first maps output UV through
//                              motionRow0/1[i] back to the frame-time pose,
//                              then runs the draw's own mapping (final draws)
// The taps are averaged in premultiplied alpha, so a moving edge fades out
// along its path instead of darkening.
// ---------------------------------------------------------------------------
#define MAX_MOTION_TAPS 32

cbuffer MotionConstants : register(b3)
{
    int    motionTaps;
    int3   motionPad;
    float4 motionRow0[MAX_MOTION_TAPS];
    float4 motionRow1[MAX_MOTION_TAPS];
};

Texture2D    cellTexture   : register(t0);
SamplerState linearSampler : register(s0);

// ---------------------------------------------------------------------------
// Signed distance to a rounded rectangle.
// p:        pixel-space position relative to cell center
// halfSize: half-extents of the cell in pixels (float2(w/2, h/2))
// radius:   corner radius in pixels
// ---------------------------------------------------------------------------
float roundedRectSDF(float2 p, float2 halfSize, float radius)
{
    float2 q = abs(p) - halfSize + radius;
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - radius;
}

// ---------------------------------------------------------------------------
// Vertex shader — fullscreen quad, pass-through position + UV
// ---------------------------------------------------------------------------
struct VSInput
{
    float2 pos : POSITION;
    float2 uv  : TEXCOORD0;
};

struct VSOutput
{
    float4 pos : SV_Position;
    float2 uv  : TEXCOORD0;
};

VSOutput VSMain(VSInput input)
{
    VSOutput output;
    output.pos = float4(input.pos, 0.0f, 1.0f);
    output.uv  = input.uv;
    return output;
}

// ---------------------------------------------------------------------------
// One motion-blur tap: the same arithmetic as PSMain below, as a function
// that returns transparent (instead of discarding) outside the cell, so taps
// can be averaged. `uv` is already in the frame-time pose; (l0, l1) is the
// Lens map this tap frames with.
// ---------------------------------------------------------------------------
float4 cellTap(float2 uv, float4 l0, float4 l1)
{
    float2 localUV;
    if (xformFlags & 2)
        localUV = float2(dot(roamRow0.xy, uv) + roamRow0.z,
                         dot(roamRow1.xy, uv) + roamRow1.z);
    else
        localUV = (uv - cellRect.xy) / cellRect.zw;

    if (localUV.x < 0.0f || localUV.x > 1.0f ||
        localUV.y < 0.0f || localUV.y > 1.0f)
        return float4(0.0f, 0.0f, 0.0f, 0.0f);

    float2 sampleUV = localUV;
    if      (orientation == 1) sampleUV.x = 1.0f - sampleUV.x;
    else if (orientation == 2) sampleUV.y = 1.0f - sampleUV.y;
    else if (orientation == 3) { sampleUV.x = 1.0f - sampleUV.x; sampleUV.y = 1.0f - sampleUV.y; }
    else if (orientation == 4) sampleUV   = float2(localUV.y,        1.0f - localUV.x);
    else if (orientation == 5) sampleUV   = float2(1.0f - localUV.y, localUV.x);

    float4 color;
    if (xformFlags & 1)
    {
        float2 lensUV = float2(dot(l0.xy, sampleUV) + l0.z,
                               dot(l1.xy, sampleUV) + l1.z);
        if (lensUV.x < 0.0f || lensUV.x > 1.0f ||
            lensUV.y < 0.0f || lensUV.y > 1.0f)
            color = float4(0.0f, 0.0f, 0.0f, 0.0f);
        else
            color = cellTexture.SampleLevel(linearSampler, lensUV, 0.0f);
    }
    else
    {
        color = cellTexture.SampleLevel(linearSampler, sampleUV, 0.0f);
    }
    color.a *= opacity;

    if (cornerRadius > 0.0f)
    {
        float cellWidthPx   = gOutputWidth  * cellRect.z;
        float cellHeightPx  = gOutputHeight * cellRect.w;
        float2 pixelPos     = (localUV - 0.5f) * float2(cellWidthPx, cellHeightPx);
        float2 halfSize     = float2(cellWidthPx * 0.5f, cellHeightPx * 0.5f);
        float  radiusPx     = cornerRadius * min(cellWidthPx, cellHeightPx);
        float  sdf          = roundedRectSDF(pixelPos, halfSize, radiusPx);
        color.a *= 1.0f - smoothstep(-1.0f, 1.0f, sdf);
    }
    return color;
}

float4 motionBlurred(float2 uv)
{
    const int taps = clamp(motionTaps, 1, MAX_MOTION_TAPS);
    float4 acc = float4(0.0f, 0.0f, 0.0f, 0.0f);   // premultiplied
    [loop]
    for (int i = 0; i < taps; ++i)
    {
        float2 tuv = uv;
        float4 l0  = lensRow0;
        float4 l1  = lensRow1;
        if (xformFlags & 4)
        {
            l0 = motionRow0[i];
            l1 = motionRow1[i];
        }
        if (xformFlags & 8)
        {
            tuv = float2(dot(motionRow0[i].xy, uv) + motionRow0[i].z,
                         dot(motionRow1[i].xy, uv) + motionRow1[i].z);
        }
        float4 c = cellTap(tuv, l0, l1);
        acc += float4(c.rgb * c.a, c.a);
    }
    acc /= float(taps);
    if (acc.a <= 0.0f) discard;
    return float4(acc.rgb / acc.a, acc.a);   // back to straight alpha
}

// ---------------------------------------------------------------------------
// Pixel shader — cell rectangle clipping, orientation transform, opacity
// ---------------------------------------------------------------------------
float4 PSMain(VSOutput input) : SV_Target
{
    float2 uv = input.uv;

    // Motion blur (bits 2/3): averaged taps. Every other draw runs the
    // original arithmetic below, untouched.
    if (xformFlags & 12)
        return motionBlurred(uv);

    // Map screen UV to local UV within the cell rectangle. A Roam rotation
    // replaces the axis-aligned divide with its inverse affine; otherwise the
    // original expression runs unchanged (bit-exact for every old project).
    float2 localUV;
    if (xformFlags & 2)
    {
        localUV = float2(dot(roamRow0.xy, uv) + roamRow0.z,
                         dot(roamRow1.xy, uv) + roamRow1.z);
    }
    else
    {
        localUV = (uv - cellRect.xy) / cellRect.zw;
    }

    // Discard if outside cell bounds
    if (localUV.x < 0.0f || localUV.x > 1.0f ||
        localUV.y < 0.0f || localUV.y > 1.0f)
    {
        discard;
    }

    // ---- Orientation transform (spec §5.3) -------------------------------
    // Six members of D₄ that Xleth supports. The two diagonal mirrors are
    // deferred — no Sparta cycle uses them in v1. Implemented as a 6-branch
    // if/else; per phase 0 the GPU composite-cost floor is 0.25 ms/frame and
    // a flat branch on a per-draw uniform is well below that threshold.
    float2 sampleUV = localUV;
    if      (orientation == 1) sampleUV.x = 1.0f - sampleUV.x;                            // horizontal
    else if (orientation == 2) sampleUV.y = 1.0f - sampleUV.y;                            // vertical
    else if (orientation == 3) { sampleUV.x = 1.0f - sampleUV.x; sampleUV.y = 1.0f - sampleUV.y; } // rotate-180
    else if (orientation == 4) sampleUV   = float2(localUV.y,        1.0f - localUV.x);   // rotate-90 CW
    else if (orientation == 5) sampleUV   = float2(1.0f - localUV.y, localUV.x);          // rotate-90 CCW
    // orientation == 0 (none): identity, sampleUV stays = localUV

    // ---- Lens framing (fit, centre, zoom, rotation) ------------------------
    // Only the Lens framing pass sets this, and always with orientation 0: the
    // flip is applied later, by the final draw of the FRAMED cell, so it
    // mirrors the framed result. Outside the source = the cell background.
    float4 color;
    if (xformFlags & 1)
    {
        float2 lensUV = float2(dot(lensRow0.xy, sampleUV) + lensRow0.z,
                               dot(lensRow1.xy, sampleUV) + lensRow1.z);
        if (lensUV.x < 0.0f || lensUV.x > 1.0f ||
            lensUV.y < 0.0f || lensUV.y > 1.0f)
        {
            color = float4(0.0f, 0.0f, 0.0f, 0.0f);
        }
        else
        {
            color = cellTexture.Sample(linearSampler, lensUV);
        }
    }
    else
    {
        color = cellTexture.Sample(linearSampler, sampleUV);
    }
    color.a *= opacity;

    // Corner radius SDF alpha mask (pixel-space, anti-aliased over 1 px)
    if (cornerRadius > 0.0f)
    {
        float cellWidthPx   = gOutputWidth  * cellRect.z;
        float cellHeightPx  = gOutputHeight * cellRect.w;
        float2 pixelPos     = (localUV - 0.5f) * float2(cellWidthPx, cellHeightPx);
        float2 halfSize     = float2(cellWidthPx * 0.5f, cellHeightPx * 0.5f);
        float  radiusPx     = cornerRadius * min(cellWidthPx, cellHeightPx);
        float  sdf          = roundedRectSDF(pixelPos, halfSize, radiusPx);
        float  mask         = 1.0f - smoothstep(-1.0f, 1.0f, sdf);
        color.a *= mask;
    }

    return color;
}
