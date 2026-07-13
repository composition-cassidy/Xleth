// SnapshotTransition.hlsl — whole-frame snapshot transition compositor.
//
// Compile: fxc /T ps_5_0 /E PSMain /Fh SnapshotTransitionPS.h /Vn g_SnapshotTransitionPS SnapshotTransition.hlsl

Texture2D snapshotA : register(t0);
Texture2D snapshotB : register(t1);
SamplerState linearSampler : register(s0);

cbuffer TransitionConstants : register(b2)
{
    int mode;
    float t;
    float angleRad;
    float pad;
};

struct VSOutput
{
    float4 pos : SV_Position;
    float2 uv  : TEXCOORD0;
};

float4 PSMain(VSOutput input) : SV_Target
{
    const float4 colorA = snapshotA.Sample(linearSampler, input.uv);
    const float4 colorB = snapshotB.Sample(linearSampler, input.uv);

    if (mode == 1)
    {
        const float2 dir = float2(cos(angleRad), sin(angleRad));
        const float p = dot(input.uv - 0.5, dir) + 0.5;
        const float softEdge = max(fwidth(p), 1.0e-6);
        const float revealB = 1.0 - smoothstep(t - softEdge, t + softEdge, p);
        return lerp(colorA, colorB, revealB);
    }

    return lerp(colorA, colorB, t);
}
