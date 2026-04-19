// FX_TVSimulator.hlsl — CRT / TV Simulator effect
//
// Compile: fxc /T ps_5_0 /E PSMain /Fh FX_TVSimulatorPS.h /Vn g_FX_TVSimulatorPS FX_TVSimulator.hlsl

Texture2D    inputTexture  : register(t0);
SamplerState linearSampler : register(s0);

cbuffer GlobalConstants : register(b1)
{
    float gTime;
    float gOutputWidth;
    float gOutputHeight;
    float gPadding;
};

cbuffer TVSimConstants : register(b2)
{
    float intensity;       // [0] overall effect strength (0-1)
    float rollSpeed;       // [1] vertical roll speed (lines/sec, 0=no roll)
    float scanlineAlpha;   // [2] scanline darkness (0=none, 1=full black bands)
    float chromaOffset;    // [3] chroma aberration UV offset (0-0.01)
    float staticNoise;     // [4] noise grain intensity (0-1)
    float jitterFreq;      // [5] horizontal jitter frequency (0-10)
    float colorBleed;      // [6] horizontal color bleed (0-0.02)
    float tvPad;
};

struct VSOutput
{
    float4 pos : SV_Position;
    float2 uv  : TEXCOORD0;
};

// Fast low-quality hash for noise
float hash(float2 p)
{
    float h = dot(p, float2(127.1, 311.7));
    return frac(sin(h) * 43758.5453123);
}

float4 PSMain(VSOutput input) : SV_Target
{
    float2 uv = input.uv;

    // --- CRT barrel distortion ---
    float2 centered = uv * 2.0 - 1.0;
    float  r2       = dot(centered, centered);
    uv = (centered * (1.0 + r2 * 0.12 * intensity)) * 0.5 + 0.5;

    // Clip pixels outside the barrel-warped frame to black
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0)
        return float4(0.0, 0.0, 0.0, 1.0);

    // --- Vertical roll ---
    uv.y = frac(uv.y + gTime * rollSpeed * 0.0002);

    // --- Horizontal scanline jitter ---
    float jitter = (hash(float2(floor(uv.y * gOutputHeight), gTime)) - 0.5)
                   * 0.002 * jitterFreq * intensity;
    uv.x = saturate(uv.x + jitter);

    // --- Chromatic aberration (R shifted left, B shifted right) ---
    float rOff = chromaOffset * intensity;
    float4 color;
    color.r = inputTexture.Sample(linearSampler, float2(uv.x - rOff, uv.y)).r;
    color.g = inputTexture.Sample(linearSampler, uv).g;
    color.b = inputTexture.Sample(linearSampler, float2(uv.x + rOff, uv.y)).b;
    color.a = inputTexture.Sample(linearSampler, uv).a;

    // --- Horizontal color bleed (smear R channel left) ---
    if (colorBleed > 0.0) {
        float blOff = colorBleed * intensity;
        color.r = lerp(color.r,
                       inputTexture.Sample(linearSampler, float2(uv.x - blOff, uv.y)).r,
                       0.5);
    }

    // --- Scanlines (darken every other pixel row) ---
    float scanMask = sin(uv.y * gOutputHeight * 3.14159265) * 0.5 + 0.5;
    color.rgb *= lerp(1.0, scanMask, scanlineAlpha);

    // --- Static noise grain ---
    if (staticNoise > 0.0) {
        float noise = hash(uv + frac(float2(gTime * 0.07, gTime * 0.13))) * 2.0 - 1.0;
        color.rgb += noise * staticNoise * intensity;
    }

    color.rgb = saturate(color.rgb);
    return color;
}
