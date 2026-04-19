// GridComposite.hlsl — Vertex + Pixel shaders for D3D11 grid compositor.
//
// Compile with fxc:
//   fxc /T vs_5_0 /E VSMain /Fh GridCompositeVS.h GridComposite.hlsl
//   fxc /T ps_5_0 /E PSMain /Fh GridCompositePS.h GridComposite.hlsl

// ---------------------------------------------------------------------------
// Per-draw constant buffer
// ---------------------------------------------------------------------------
cbuffer CellConstants : register(b0)
{
    float4 cellRect;        // (x, y, width, height) in UV space [0,1]
    float  opacity;         // slot.opacity * event.opacity
    int    flipMode;        // 0=None, 1=HorizEven, 2=CW, 3=CCW
    int    globalNoteIndex; // for HorizontalEven flip cycling
    float  cornerRadius;   // 0.0–1.0 corner rounding
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
// Pixel shader — cell rectangle clipping, flip modes, opacity
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

    // Apply flip mode
    if (flipMode == 1)
    {
        // HorizontalEven: flip X on even-numbered notes
        if ((globalNoteIndex % 2) == 0)
            localUV.x = 1.0f - localUV.x;
    }
    else if (flipMode == 2)
    {
        // Clockwise cycle: normal → flipY → flipXY → flipX → repeat
        int phase = globalNoteIndex % 4;
        if (phase == 1)
            localUV.y = 1.0f - localUV.y;
        else if (phase == 2)
        {
            localUV.x = 1.0f - localUV.x;
            localUV.y = 1.0f - localUV.y;
        }
        else if (phase == 3)
            localUV.x = 1.0f - localUV.x;
    }
    else if (flipMode == 3)
    {
        // CounterClockwise cycle: normal → flipX → flipXY → flipY → repeat
        int phase = globalNoteIndex % 4;
        if (phase == 1)
            localUV.x = 1.0f - localUV.x;
        else if (phase == 2)
        {
            localUV.x = 1.0f - localUV.x;
            localUV.y = 1.0f - localUV.y;
        }
        else if (phase == 3)
            localUV.y = 1.0f - localUV.y;
    }

    float4 color = cellTexture.Sample(linearSampler, localUV);
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
