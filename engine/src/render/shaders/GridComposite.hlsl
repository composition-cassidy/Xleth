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
    float  padding;
};

Texture2D    cellTexture   : register(t0);
SamplerState linearSampler : register(s0);

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
    return color;
}
