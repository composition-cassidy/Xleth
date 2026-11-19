// FX_ColorGrade.hlsl — Color Grade (model/ColorGrade.h), up to three levels in one pass.
//
// Compile (PowerShell, from this directory; Git Bash mangles /T):
//   fxc /T ps_5_0 /E PSMain /O3 /Fh FX_ColorGradePS.h /Vn g_FX_ColorGradePS FX_ColorGrade.hlsl
//
// One draw applies levelCount grades in order. The per-cell pass binds Source,
// Clip and Layer (whichever exist); the master pass binds the Master grade
// alone and writes an opaque frame.
//
// Everything a grade does is computed on the CPU by xleth::grade::bakeColorGrade
// and only APPLIED here, exactly as applyBakedGrade (the CPU reference the
// tests check this shader against) applies it:
//
//   transfer   exposure, white balance, lift/gamma/gain, contrast and curves,
//              folded into one per-channel table (4096 x 1, RGBA16)
//   vibrance   saturation that favours muted colours
//   matrix     saturation and hue, one 3x3
//   lut        optional imported 3D LUT, blended by its amount
//
// Between levels the value is clamped to [0,1] but stays in float, so chained
// levels never quantise to 8 bits in between.

Texture2D    inputTexture  : register(t0);
Texture2D    transfer0     : register(t1);
Texture2D    transfer1     : register(t2);
Texture2D    transfer2     : register(t3);
Texture3D    lut0          : register(t4);
Texture3D    lut1          : register(t5);
Texture3D    lut2          : register(t6);
SamplerState linearSampler : register(s0);

// Matches struct GradeLevelConstants in GridCompositor.h (6 x float4).
struct GradeLevel
{
    float4 row0;         // xyz = matrix row 0, w = vibrance
    float4 row1;         // xyz = matrix row 1, w = LUT amount
    float4 row2;         // xyz = matrix row 2, w = LUT size (entries per axis)
    float4 flags;        // x = has transfer, y = has matrix, z = has LUT
    float4 lutMin;       // xyz = LUT domain minimum
    float4 lutInvRange;  // xyz = 1 / (domain maximum - minimum)
};

// Matches struct GradeConstants in GridCompositor.h.
cbuffer GradeConstants : register(b2)
{
    int        levelCount;    // 1..3
    int        forceOpaque;   // master pass: write alpha 1 (the delivered picture)
    int        gradePad0;
    int        gradePad1;
    GradeLevel levels[3];
};

static const float  kTransferSize = 4096.0;
static const float3 kLuma = float3(0.2126, 0.7152, 0.0722);

struct VSOutput
{
    float4 pos : SV_Position;
    float2 uv  : TEXCOORD0;
};

float3 applyLevel(float3 c, GradeLevel L, Texture2D transferTex, Texture3D lutTex)
{
    if (L.flags.x > 0.5)
    {
        // Texel centres: entry i sits at (i + 0.5) / size, so 0 and 1 land
        // exactly on the first and last entries and the hardware filter does
        // the same linear interpolation the CPU reference does.
        float3 u = (c * (kTransferSize - 1.0) + 0.5) / kTransferSize;
        c.r = transferTex.SampleLevel(linearSampler, float2(u.r, 0.5), 0).r;
        c.g = transferTex.SampleLevel(linearSampler, float2(u.g, 0.5), 0).g;
        c.b = transferTex.SampleLevel(linearSampler, float2(u.b, 0.5), 0).b;
    }

    float vibrance = L.row0.w;
    if (vibrance != 0.0)
    {
        float mx   = max(c.r, max(c.g, c.b));
        float mn   = min(c.r, min(c.g, c.b));
        float luma = dot(c, kLuma);
        float f    = max(0.0, 1.0 + vibrance * (1.0 - (mx - mn)));
        c = luma + (c - luma) * f;
    }

    if (L.flags.y > 0.5)
    {
        c = float3(dot(L.row0.xyz, c), dot(L.row1.xyz, c), dot(L.row2.xyz, c));
    }

    c = saturate(c);

    if (L.flags.z > 0.5)
    {
        float  n   = L.row2.w;
        float3 u   = saturate((c - L.lutMin.xyz) * L.lutInvRange.xyz);
        float3 uvw = (u * (n - 1.0) + 0.5) / n;
        float3 looked = lutTex.SampleLevel(linearSampler, uvw, 0).rgb;
        c = saturate(lerp(c, looked, L.row1.w));
    }

    return c;
}

float4 PSMain(VSOutput input) : SV_Target
{
    float4 src = inputTexture.SampleLevel(linearSampler, input.uv, 0);

    // A fully transparent texel has no picture to grade (a Contain letterbox,
    // a keyed-out background). Left alone, so a lifted black cannot tint the
    // fringe where it meets the picture.
    if (forceOpaque == 0 && src.a <= 0.0)
        return src;

    float3 c = saturate(src.rgb);
    c = applyLevel(c, levels[0], transfer0, lut0);
    if (levelCount > 1) c = applyLevel(c, levels[1], transfer1, lut1);
    if (levelCount > 2) c = applyLevel(c, levels[2], transfer2, lut2);

    return float4(c, forceOpaque != 0 ? 1.0 : src.a);
}
