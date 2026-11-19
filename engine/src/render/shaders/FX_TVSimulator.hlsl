// FX_TVSimulator.hlsl — CRT / TV Simulator effect
//
// Compile: fxc /T ps_5_0 /E PSMain /Fh FX_TVSimulatorPS.h /Vn g_FX_TVSimulatorPS FX_TVSimulator.hlsl
//
// Runs as one pass of the visual chain (GridCompositor::processEffectChain),
// into a target sized to the cell's ON-OUTPUT pixels, and as the slide TV ramp
// pass on that same target. The constant layout is VisualEffect::params[0..6]
// (TimelineTypes.h) and the slide ramp packs the same order, so it must not
// change.
//
// Rules this pass keeps:
//
//  * Intensity is the master. At 0 the pass is an exact pass-through, so the
//    slide ramp (which animates intensity from 0 to its peak) fades in with no
//    pop. Scanlines and the hum bar were never scaled by intensity before and
//    the default intensity is 50 %, so they reach their knob value at 50 % and
//    stay there; everything else scales linearly with intensity, as it did.
//
//  * The scanline raster is measured in OUTPUT lines, not in pixels of this
//    target. kLinesPerFrame lines span the full output height, so a grid cell
//    shows a smaller patch of the same-sized lines, and the preview (any size)
//    and the export draw the same raster relative to the frame. The old pass
//    used gOutputHeight as a line count inside a CELL-sized target: in a 2x2
//    grid that put one sine period on every pixel and the scanlines collapsed
//    to a flat 50 % dim; 3x3 and up aliased into moire. When the lines get too
//    fine to resolve here they fade to their average darkening instead.
//
//  * Nothing moves the picture with project time. The old roll added
//    gTime * speed to v and wrapped, so a static project slowly slid its own
//    picture upward and wrapped the top onto the bottom (about 6 % after five
//    minutes at the default speed). Roll is now a rolling hum bar.
//
//  * Every random value is an integer hash of (pixel or line, field), with the
//    field counted from project time at a fixed rate: repeatable, the same in
//    preview and export, and independent of the export frame rate. (The old
//    sin()-hash of large time values lost precision as the project went on.)

Texture2D    inputTexture  : register(t0);
SamplerState linearSampler : register(s0);

cbuffer GlobalConstants : register(b1)
{
    float gTime;           // project time, seconds
    float gOutputWidth;
    float gOutputHeight;
    float gPadding;
};

cbuffer TVSimConstants : register(b2)
{
    float intensity;       // [0] master strength (0-1)
    float rollSpeed;       // [1] hum bar speed (0 = no bar, 0-5)
    float scanlineAlpha;   // [2] scanline depth (0-1)
    float chromaOffset;    // [3] red/blue convergence error, cell UV (0-0.01)
    float staticNoise;     // [4] grain and line noise (0-1)
    float jitterFreq;      // [5] horizontal sync instability (0-10)
    float colorBleed;      // [6] chroma smear width, cell UV (0-0.02)
    float tvPad;
};

struct VSOutput
{
    float4 pos : SV_Position;
    float2 uv  : TEXCOORD0;
};

static const float kLinesPerFrame = 240.0;   // visible lines over the output height
static const float kFieldRate     = 59.94;   // noise/jitter re-roll rate, per second
static const float kTwoPi         = 6.28318531;

// ── Hashing ────────────────────────────────────────────────────────────────
uint pcgHash(uint v)
{
    uint state = v * 747796405u + 2891336453u;
    uint word  = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
    return (word >> 22u) ^ word;
}

float hash01(uint a, uint b, uint c)
{
    return float(pcgHash(a ^ pcgHash(b ^ pcgHash(c)))) * (1.0 / 4294967296.0);
}

// ── NTSC-style colour space, for the chroma smear ──────────────────────────
float3 rgbToYiq(float3 c)
{
    return float3(dot(c, float3(0.299,  0.587,  0.114)),
                  dot(c, float3(0.596, -0.274, -0.322)),
                  dot(c, float3(0.211, -0.523,  0.312)));
}

float3 yiqToRgb(float3 c)
{
    return float3(dot(c, float3(1.0,  0.956,  0.621)),
                  dot(c, float3(1.0, -0.272, -0.647)),
                  dot(c, float3(1.0, -1.106,  1.703)));
}

float4 PSMain(VSOutput input) : SV_Target
{
    const float I = saturate(intensity);

    // Exact pass-through at zero (uniform branch: same for every pixel).
    if (I <= 0.0)
        return inputTexture.Sample(linearSampler, input.uv);

    const float master = saturate(I * 2.0);

    uint texW, texH;
    inputTexture.GetDimensions(texW, texH);
    const float2 texSize = float2(max(texW, 1u), max(texH, 1u));

    // How many output lines this target holds, and how many of its pixels one
    // line spans (== output height / kLinesPerFrame, whatever the cell size).
    const float outH      = (gOutputHeight > 0.5) ? gOutputHeight : texSize.y;
    const float lines     = max(texSize.y * kLinesPerFrame / outH, 1.0);
    const float pxPerLine = texSize.y / lines;

    const float t     = max(gTime, 0.0);
    const uint  field = (uint)floor(t * kFieldRate);

    // ── Tube curvature (unchanged amount: 12 % radial bulge at full) ───────
    const float2 c  = input.uv * 2.0 - 1.0;
    const float2 uv = (c * (1.0 + dot(c, c) * 0.12 * I)) * 0.5 + 0.5;

    // Rounded tube face, antialiased. Signed distance in target pixels to a
    // rounded rectangle; negative inside.
    const float  cornerPx = 0.045 * min(texSize.x, texSize.y) * master;
    const float2 q        = abs(uv - 0.5) * texSize - (0.5 * texSize - cornerPx);
    const float  dEdge    = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - cornerPx;
    const float  tube     = saturate(0.5 - dEdge / max(fwidth(dEdge), 1e-3));

    // Darker toward the glass edge.
    float vig = saturate(16.0 * uv.x * uv.y * (1.0 - uv.x) * (1.0 - uv.y));
    vig = pow(max(vig, 1e-4), 0.22 * I);

    const float lineY  = saturate(uv.y) * lines;
    const uint  lineId = (uint)lineY;

    // ── Horizontal sync: per-line jitter, a slow wobble, tracking tears ────
    float jit = (hash01(lineId, field, 0x9E37u) - 0.5) * 0.002 * jitterFreq;
    jit += sin(uv.y * 9.0 + frac(t * 0.37) * kTwoPi) * 0.0004 * jitterFreq;

    // Above Jitter 3 an occasional band of lines tears sideways, re-rolled six
    // times a second. Uniform per slot, so this branch is coherent.
    const float tearChance = saturate((jitterFreq - 3.0) / 7.0) * 0.6;
    const uint  slot       = (uint)floor(t * 6.0);
    if (hash01(slot, 0x51u, 0x7Fu) < tearChance) {
        const float bandY  = hash01(slot, 0x52u, 0x7Fu);
        const float bandH  = lerp(0.015, 0.06, hash01(slot, 0x53u, 0x7Fu));
        const float inBand = 1.0 - smoothstep(0.0, bandH, abs(uv.y - bandY));
        jit += inBand * (hash01(lineId, field, 0x54u) - 0.3) * 0.03;
    }

    // ── Roll: a soft dark hum bar travelling up the screen ─────────────────
    float hum = 0.0;
    if (rollSpeed > 0.0) {
        const float phase = frac(uv.y + frac(t * rollSpeed * 0.12));
        const float band  = 0.5 + 0.5 * cos(kTwoPi * phase);
        hum = band * band * band * band;
        jit += hum * 0.0025;          // the bar drags the picture sideways a touch
    }

    jit *= I;

    // ── Convergence error: red pulled left, blue pushed right ──────────────
    const float2 suv    = float2(uv.x + jit, uv.y);
    const float  rOff   = chromaOffset * I;
    const float4 centre = inputTexture.Sample(linearSampler, suv);
    float3 rgb = float3(inputTexture.Sample(linearSampler, suv - float2(rOff, 0.0)).r,
                        centre.g,
                        inputTexture.Sample(linearSampler, suv + float2(rOff, 0.0)).b);

    // ── Colour bleed: luma stays sharp, chroma is low-passed and trails ────
    // to the right, the way a band-limited composite chroma signal smears.
    const float bleed = colorBleed * I;
    if (bleed > 0.0) {
        const float3 yiq = rgbToYiq(rgb);
        float2 iq   = yiq.yz;
        float  wsum = 1.0;
        [unroll] for (int k = 1; k <= 4; ++k) {
            const float  tk = k / 4.0;
            const float  w  = exp(-2.0 * tk);
            const float3 s  = inputTexture.Sample(linearSampler, suv - float2(bleed * tk, 0.0)).rgb;
            iq   += rgbToYiq(s).yz * w;
            wsum += w;
        }
        rgb = yiqToRgb(float3(yiq.x, iq / wsum));
    }

    // ── Scanlines: a gaussian beam per line, wider where the picture is ───
    // bright. Fades to its own average when lines are under ~3 pixels apart.
    const float scanAmt = saturate(scanlineAlpha) * master;
    float scan = 1.0;
    if (scanAmt > 0.0) {
        const float luma    = dot(saturate(rgb), float3(0.299, 0.587, 0.114));
        const float f       = frac(lineY) - 0.5;
        const float sigma   = lerp(0.24, 0.42, luma);
        const float beam    = exp(-0.5 * f * f / (sigma * sigma));
        const float beamAvg = lerp(0.58, 0.81, luma);   // mean of `beam` over a line
        const float resolve = saturate((pxPerLine - 1.5) / 1.5);
        scan = lerp(1.0, lerp(beamAvg, beam, resolve), scanAmt);
    }

    // ── Static: zero-mean grain per pixel, streaks per line, field flicker ─
    const float noiseAmt = staticNoise * I;
    if (noiseAmt > 0.0) {
        const uint2 p      = (uint2)input.pos.xy;
        const float grain  = hash01(p.x, p.y, field) + hash01(p.y ^ 0xA511E9B3u, p.x, field ^ 0x63D8u) - 1.0;
        const float streak = hash01(lineId, field, 0x2Cu) - 0.5;
        rgb += (grain + streak * 0.6) * noiseAmt;
        rgb *= 1.0 + (hash01(field, 0xF1u, 0x1Cu) - 0.5) * 0.08 * noiseAmt;
    }

    rgb *= scan * vig * (1.0 - 0.12 * master * hum);
    rgb  = saturate(rgb);

    // Outside the tube face: opaque black, as before.
    return lerp(float4(0.0, 0.0, 0.0, 1.0), float4(rgb, centre.a), tube);
}
