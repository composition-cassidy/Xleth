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
cbuffer CellConstants : register(b0)
{
    float4 cellRect;        // (x, y, width, height) in UV space [0,1]
    float  opacity;         // slot.opacity * event.opacity
    int    orientation;     // 0=none, 1=h, 2=v, 3=rot180, 4=rot90cw, 5=rot90ccw
    float  cornerRadius;    // 0.0–1.0 corner rounding (fraction of min(w,h))
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
// Pixel shader — cell rectangle clipping, orientation transform, opacity
// ---------------------------------------------------------------------------
float4 PSMain(VSOutput input) : SV_Target
{
    float2 uv = input.uv;

    // Map screen UV to local UV within the cell rectangle
    float2 localUV = (uv - cellRect.xy) / cellRect.zw;

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

    float4 color = cellTexture.Sample(linearSampler, sampleUV);
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
