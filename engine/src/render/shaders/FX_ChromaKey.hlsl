// FX_ChromaKey.hlsl — chroma-key (green screen) matte for the per-track chain.
//
// Compile with fxc (CMake does NOT run fxc — the bytecode header beside this
// file is committed by hand):
//   fxc /T ps_5_0 /E PSMain /Fh FX_ChromaKeyPS.h /Vn g_FX_ChromaKeyPS FX_ChromaKey.hlsl
//
// Purpose: a sample whose video is a green-screen render composites as a
// transparent cutout in the grid — background pixels get alpha = 0, revealing
// whatever layer sits behind the cell (typically the chorus fullscreen-behind
// layer). This shader produces STRAIGHT (non-premultiplied) alpha; the single
// SRC_ALPHA/INV_SRC_ALPHA composite in GridCompositor::drawCell is the only
// place alpha is ever multiplied into RGB. See the note on the opaque blend
// state in GridCompositor::processEffectChain.
//
// Pipeline order (matches the spec): key → spill suppression → choke → edge blur.
//
// Quality target is consumer YouTube-rip sources (heavily compressed 4:2:0
// chroma), not studio plates — hence chroma-only distance and generous
// two-threshold softness rather than a hard per-channel difference key.

// ---------------------------------------------------------------------------
// Per-effect constant buffer at b2.
// Layout is the canonical ChromaKey params[] block documented on
// VisualEffect in engine/src/model/TimelineTypes.h — keep the two in sync.
// float3 + trailing scalar pack into one 16-byte register, so this maps to
// params[0..7] byte-for-byte under the generic memcpy in processEffectChain.
// ---------------------------------------------------------------------------
cbuffer ChromaKeyConstants : register(b2)
{
    float3 keyColor;    // params[0..2]  key colour RGB, 0..1
    float  tolerance;   // params[3]     core threshold  (CbCr distance)
    float  softness;    // params[4]     edge threshold  (CbCr distance, > tolerance)
    float  spill;       // params[5]     spill suppression amount 0..1
    float  choke;       // params[6]     matte erode radius, OUTPUT pixels
    float  edgeBlur;    // params[7]     matte feather radius, OUTPUT pixels
};

// Per-frame globals (shared with GridComposite.hlsl).
cbuffer GlobalConstants : register(b1)
{
    float gTime;
    float gOutputWidth;
    float gOutputHeight;
    float gPadding;
};

Texture2D    cellTexture   : register(t0);
SamplerState linearSampler : register(s0);

struct VSOutput
{
    float4 pos : SV_Position;
    float2 uv  : TEXCOORD0;
};

// ---------------------------------------------------------------------------
// BT.601 RGB <-> YCbCr. 601 (not 709) because the sources are consumer rips
// that overwhelmingly decode as 601, and because the keyer only needs a
// perceptually-sane chroma plane, not colourimetric accuracy.
// Cb/Cr come out in [-0.5, 0.5], so the CbCr-plane distance used for the
// matte spans roughly [0, 1.41] — that is the unit the tolerance and softness
// sliders are expressed in.
// ---------------------------------------------------------------------------
float3 rgbToYCbCr(float3 c)
{
    return float3(
         0.299000 * c.r + 0.587000 * c.g + 0.114000 * c.b,
        -0.168736 * c.r - 0.331264 * c.g + 0.500000 * c.b,
         0.500000 * c.r - 0.418688 * c.g - 0.081312 * c.b);
}

float3 yCbCrToRgb(float3 y)
{
    return float3(
        y.x + 1.402000 * y.z,
        y.x - 0.344136 * y.y - 0.714136 * y.z,
        y.x + 1.772000 * y.y);
}

// ---------------------------------------------------------------------------
// Raw matte at a UV: 0 = fully keyed out (background), 1 = fully opaque
// (foreground). Chroma-only distance, so luminance variation across the
// screen — shadows, hot spots, uneven lighting — does not pull the key apart.
// ---------------------------------------------------------------------------
float matteAt(float2 uv, float2 keyCbCr, float t0, float t1)
{
    float3 src = cellTexture.Sample(linearSampler, uv).rgb;
    float2 cbcr = rgbToYCbCr(src).yz;
    float  d    = length(cbcr - keyCbCr);
    return smoothstep(t0, t1, d);
}

// 8-tap ring, unit radius. Used for both the erode and the feather so the two
// share a sampling pattern (and so the worst case stays a bounded 9x9 = 81
// samples, only when BOTH choke and edge blur are non-zero — both default to 0
// and the branches below are on uniforms, so they are fully wave-coherent).
static const float2 kRing[8] = {
    float2( 1.0,  0.0), float2( 0.70711,  0.70711),
    float2( 0.0,  1.0), float2(-0.70711,  0.70711),
    float2(-1.0,  0.0), float2(-0.70711, -0.70711),
    float2( 0.0, -1.0), float2( 0.70711, -0.70711)
};

// Matte after choke. Erosion = local minimum over the choke radius, which
// shrinks the matte inward and eats the compression fringe that 4:2:0 chroma
// subsampling smears around every hard edge.
float chokedMatteAt(float2 uv, float2 keyCbCr, float t0, float t1, float2 chokeUV)
{
    float a = matteAt(uv, keyCbCr, t0, t1);
    if (chokeUV.x <= 0.0 && chokeUV.y <= 0.0)
        return a;

    [unroll]
    for (int i = 0; i < 8; ++i)
        a = min(a, matteAt(uv + kRing[i] * chokeUV, keyCbCr, t0, t1));

    return a;
}

float4 PSMain(VSOutput input) : SV_Target
{
    float2 uv    = input.uv;
    float4 color = cellTexture.Sample(linearSampler, uv);

    // Two-threshold core/edge matte. Clamp the edge threshold strictly above
    // the core threshold so a user dragging softness below tolerance gets a
    // hard-edged key instead of a divide-by-zero / inverted smoothstep.
    float t0 = tolerance;
    float t1 = max(softness, tolerance + 1e-4);

    float3 keyY   = rgbToYCbCr(saturate(keyColor));
    float2 keyCbCr = keyY.yz;

    // Radii are in OUTPUT pixels (see the v1 note in TimelineTypes.h): the
    // chain render target is CELL-sized, but GlobalConstants only carries the
    // output dimensions, so a cell smaller than the full frame erodes and
    // feathers by proportionally fewer of its own texels than the slider says.
    float2 outTexel = float2(1.0 / max(gOutputWidth,  1.0),
                             1.0 / max(gOutputHeight, 1.0));
    float2 chokeUV  = max(choke,    0.0) * outTexel;
    float2 blurUV   = max(edgeBlur, 0.0) * outTexel;

    // Choke, then feather. Feathering averages the CHOKED matte so the two
    // compose in the documented order rather than fighting each other.
    float alpha = chokedMatteAt(uv, keyCbCr, t0, t1, chokeUV);
    if (blurUV.x > 0.0 || blurUV.y > 0.0)
    {
        float sum = alpha;
        [unroll]
        for (int i = 0; i < 8; ++i)
            sum += chokedMatteAt(uv + kRing[i] * blurUV, keyCbCr, t0, t1, chokeUV);
        alpha = sum / 9.0;
    }

    // ---- Spill suppression -------------------------------------------------
    // Surviving foreground pixels pick up bounce light from the screen. Project
    // the pixel's chroma onto the key's chroma direction and pull back along it,
    // leaving luma untouched. Generic in the key direction, so this works for a
    // blue screen exactly as well as a green one.
    if (spill > 0.0)
    {
        float keyLen = length(keyCbCr);
        if (keyLen > 1e-5)
        {
            float2 kdir = keyCbCr / keyLen;
            float3 ycc  = rgbToYCbCr(color.rgb);
            float  proj = dot(ycc.yz, kdir);
            if (proj > 0.0)
            {
                ycc.yz -= kdir * (proj * saturate(spill));
                color.rgb = saturate(yCbCrToRgb(ycc));
            }
        }
    }

    // Multiply rather than replace so an already-transparent upstream pass
    // (or a source that genuinely carries alpha) is never made opaque again.
    color.a *= saturate(alpha);

    // STRAIGHT alpha out — RGB is deliberately NOT premultiplied here.
    return color;
}
