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
    float edgeSoftness;
    float zoomAmount;
    float dissolveGrainPx;
    float radialOriginX;
    float radialOriginY;
    float pixelateMaxBlockPx;
    float glitchIntensity;
    float glitchBlockPx;
    float blurRadiusPx;
    float displacementAmount;
    float displacementScale;
    int effectSeed;
    float pad0;
};

struct VSOutput
{
    float4 pos : SV_Position;
    float2 uv  : TEXCOORD0;
};

bool uvInBounds(float2 uv)
{
    return all(uv >= 0.0) && all(uv <= 1.0);
}

float stableNoise(float2 cell)
{
    float3 p3 = frac(float3(cell.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return frac((p3.x + p3.y) * p3.z);
}

float stableNoiseSeeded(float2 cell, float seed)
{
    return stableNoise(cell + float2(seed * 0.06711056, seed * 0.00583715));
}

float valueNoise(float2 p, float seed)
{
    const float2 cell = floor(p);
    const float2 f = frac(p);
    const float2 blend = f * f * (3.0 - 2.0 * f);
    const float a = stableNoiseSeeded(cell, seed);
    const float b = stableNoiseSeeded(cell + float2(1.0, 0.0), seed);
    const float c = stableNoiseSeeded(cell + float2(0.0, 1.0), seed);
    const float d = stableNoiseSeeded(cell + float2(1.0, 1.0), seed);
    return lerp(lerp(a, b, blend.x), lerp(c, d, blend.x), blend.y);
}

float4 blendedSnapshot(float2 uv, float progress)
{
    if (!uvInBounds(uv)) return float4(0.0, 0.0, 0.0, 1.0);
    return lerp(snapshotA.Sample(linearSampler, uv),
                snapshotB.Sample(linearSampler, uv), progress);
}

float4 PSMain(VSOutput input) : SV_Target
{
    const float progress = saturate(t);
    const float4 colorA = snapshotA.Sample(linearSampler, input.uv);
    const float4 colorB = snapshotB.Sample(linearSampler, input.uv);

    // Exact shoulders are part of the public transition contract. Besides
    // avoiding feather/noise remnants, these keep the first and last frames
    // byte-identical to the single-snapshot path.
    if (progress <= 0.0) return colorA;
    if (progress >= 1.0) return colorB;

    if (mode == 1)
    {
        const float2 dir = float2(cos(angleRad), sin(angleRad));
        const float halfSpan = max(0.5 * (abs(dir.x) + abs(dir.y)), 1.0e-6);
        const float p = (dot(input.uv - 0.5, dir) + halfSpan) / (2.0 * halfSpan);
        const float softEdge = max(max(fwidth(p), edgeSoftness), 1.0e-6);
        const float revealB = 1.0 - smoothstep(progress - softEdge, progress + softEdge, p);
        return lerp(colorA, colorB, revealB);
    }

    // Push: B enters from -dir while A exits toward +dir. Push and Slide are
    // authored as cardinal directions, so their translated rectangles tile the
    // target without gaps or overlap.
    if (mode == 2)
    {
        const float2 dir = round(float2(cos(angleRad), sin(angleRad)));
        const float2 uvA = input.uv - dir * progress;
        const float2 uvB = input.uv + dir * (1.0 - progress);
        if (uvInBounds(uvB)) return snapshotB.Sample(linearSampler, uvB);
        if (uvInBounds(uvA)) return snapshotA.Sample(linearSampler, uvA);
        return float4(0.0, 0.0, 0.0, 1.0);
    }

    // Slide Over: B follows the same incoming motion, but A remains stationary
    // underneath it instead of being pushed away.
    if (mode == 3)
    {
        const float2 dir = round(float2(cos(angleRad), sin(angleRad)));
        const float2 uvB = input.uv + dir * (1.0 - progress);
        return uvInBounds(uvB) ? snapshotB.Sample(linearSampler, uvB) : colorA;
    }

    // Centered zoom-through. Both samples stay full-frame (scale >= 1), which
    // avoids exposed borders while A pushes in and B settles to its native size.
    if (mode == 4)
    {
        const float scaleA = 1.0 + zoomAmount * progress;
        const float scaleB = 1.0 + zoomAmount * (1.0 - progress);
        const float2 uvA = (input.uv - 0.5) / scaleA + 0.5;
        const float2 uvB = (input.uv - 0.5) / scaleB + 0.5;
        return lerp(snapshotA.Sample(linearSampler, uvA),
                    snapshotB.Sample(linearSampler, uvB), progress);
    }

    // Static spatial dissolve. The mask depends only on pixel position and the
    // authored grain size, never frame/time, so it cannot shimmer or diverge
    // between preview and export at the same output size.
    if (mode == 5)
    {
        const float grain = max(round(dissolveGrainPx), 1.0);
        const float noise = stableNoise(floor(input.pos.xy / grain));
        const float revealB = smoothstep(noise - 1.0e-6, noise + 1.0e-6, progress);
        return lerp(colorA, colorB, revealB);
    }

    // Out-Then-In: each easing half owns one side of an exact opaque-black pin.
    if (mode == 6)
    {
        const float4 black = float4(0.0, 0.0, 0.0, 1.0);
        if (progress <= 0.5) return lerp(colorA, black, progress * 2.0);
        return lerp(black, colorB, (progress - 0.5) * 2.0);
    }

    // Circular reveal from an authored normalized origin. edgeSoftness is shared
    // with Line Sweep so both procedural masks use the same compact feather model.
    if (mode == 7)
    {
        const float2 origin = float2(radialOriginX, radialOriginY);
        const float distanceFromOrigin = length(input.uv - origin);
        const float maxRadius = max(max(length(origin), length(origin - float2(1.0, 0.0))),
                                   max(length(origin - float2(0.0, 1.0)),
                                       length(origin - float2(1.0, 1.0))));
        const float radius = progress * maxRadius;
        const float softEdge = max(max(fwidth(distanceFromOrigin), edgeSoftness), 1.0e-6);
        const float revealB = 1.0 - smoothstep(radius - softEdge, radius + softEdge,
                                               distanceFromOrigin);
        return lerp(colorA, colorB, revealB);
    }

    // Pixelate peaks at the pin and resolves symmetrically. The snapshots still
    // crossfade underneath, avoiding a discontinuous source switch at t=0.5.
    if (mode == 8)
    {
        uint width, height;
        snapshotA.GetDimensions(width, height);
        const float2 dimensions = max(float2(width, height), 1.0);
        const float envelope = sin(progress * 3.14159265359);
        const float blockPx = max(round(lerp(1.0, pixelateMaxBlockPx, envelope)), 1.0);
        const float2 pixelCenter = (floor(input.pos.xy / blockPx) + 0.5) * blockPx;
        const float2 blockUv = saturate(pixelCenter / dimensions);
        return lerp(snapshotA.Sample(linearSampler, blockUv),
                    snapshotB.Sample(linearSampler, blockUv), progress);
    }

    // Deterministic VJ glitch: quantized progress drives stable horizontal slice
    // jumps while RGB channels separate around the displaced sample. No wall-clock
    // or mutable random state enters this calculation.
    if (mode == 9)
    {
        uint width, height;
        snapshotA.GetDimensions(width, height);
        const float2 dimensions = max(float2(width, height), 1.0);
        const float envelope = sin(progress * 3.14159265359) * glitchIntensity;
        const float stripe = floor(input.pos.y / max(round(glitchBlockPx), 4.0));
        const float phase = floor(progress * 24.0);
        const float jumpNoise = stableNoiseSeeded(float2(stripe, phase), effectSeed);
        const float gate = step(0.42, stableNoiseSeeded(float2(stripe + 19.0, phase), effectSeed));
        const float jumpPx = (jumpNoise * 2.0 - 1.0) * dimensions.x * 0.075 * envelope * gate;
        const float2 jumpUv = float2(jumpPx / dimensions.x, 0.0);
        const float splitPx = (2.0 + 10.0 * jumpNoise) * envelope;
        const float2 splitUv = float2(splitPx / dimensions.x, 0.0);
        const float4 base = blendedSnapshot(input.uv + jumpUv, progress);
        const float red = blendedSnapshot(input.uv + jumpUv + splitUv, progress).r;
        const float blue = blendedSnapshot(input.uv + jumpUv - splitUv, progress).b;
        return float4(red, base.g, blue, base.a);
    }

    // Five-tap directional blur. Radius peaks at the cue pin and direction reuses
    // the canonical arbitrary-angle geometry field.
    if (mode == 10)
    {
        uint width, height;
        snapshotA.GetDimensions(width, height);
        const float2 dimensions = max(float2(width, height), 1.0);
        const float radius = blurRadiusPx * sin(progress * 3.14159265359);
        const float2 axis = float2(cos(angleRad), sin(angleRad)) / dimensions;
        float4 result = blendedSnapshot(input.uv, progress) * 0.38774;
        result += blendedSnapshot(input.uv + axis * radius * 0.5, progress) * 0.24477;
        result += blendedSnapshot(input.uv - axis * radius * 0.5, progress) * 0.24477;
        result += blendedSnapshot(input.uv + axis * radius, progress) * 0.06136;
        result += blendedSnapshot(input.uv - axis * radius, progress) * 0.06136;
        return result;
    }

    // Procedural two-axis displacement. Two seeded value-noise fields form a
    // stable vector field, with opposing A/B motion that peaks at the pin.
    if (mode == 11)
    {
        const float envelope = sin(progress * 3.14159265359) * displacementAmount;
        const float2 noisePoint = input.uv * displacementScale;
        const float2 field = float2(
            valueNoise(noisePoint, effectSeed),
            valueNoise(noisePoint + float2(17.37, 41.73), effectSeed + 101.0)
        ) * 2.0 - 1.0;
        const float2 offset = field * envelope;
        const float2 uvA = saturate(input.uv + offset * progress);
        const float2 uvB = saturate(input.uv - offset * (1.0 - progress));
        return lerp(snapshotA.Sample(linearSampler, uvA),
                    snapshotB.Sample(linearSampler, uvB), progress);
    }

    return lerp(colorA, colorB, progress);
}
