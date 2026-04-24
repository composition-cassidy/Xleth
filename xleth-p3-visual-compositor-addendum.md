# Xleth P3 Spec Addendum — Visual Compositor Effects System

**Version:** 1.0  
**Author:** Krasen Mendiola (design) / Claude (spec)  
**Status:** Draft — awaiting approval before Claude Code prompts are generated  
**Scope:** Per-cell visual effects, chainable effect pipeline, slide-note animation triggers, ping-pong video looping, bounce animation, and preview performance controls.  
**Depends on:** P3 Full Spec Sections 11.2 (Frame Deduplication), 11.3 (Offline Render Loop), 11.5 (GPU Pipeline — D3D11 Compositing)  
**Modifies:** `GridCompositor`, `FrameCollector`, `buildVideoEvents()`, `GridComposite.hlsl`, `CellConstants`, `CellFrameRequest`, `TimelineTypes.h`, Grid Layout UI

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Visual Effect Chain System](#2-visual-effect-chain-system)
3. [Global Gap Scale](#3-global-gap-scale)
4. [Bounce Animation](#4-bounce-animation)
5. [Corner Radius](#5-corner-radius)
6. [Desaturation](#6-desaturation)
7. [Tint](#7-tint)
8. [Brightness & Contrast](#8-brightness--contrast)
9. [TV Simulator (CRT Distortion)](#9-tv-simulator-crt-distortion)
10. [Zoom / Pan / Rotation Animation](#10-zoom--pan--rotation-animation)
11. [Ping-Pong Video Loop](#11-ping-pong-video-loop)
12. [Slide Note Animation Triggers](#12-slide-note-animation-triggers)
13. [Per-Cell Animation State Machine](#13-per-cell-animation-state-machine)
14. [Preview Performance Controls](#14-preview-performance-controls)
15. [Data Model Changes](#15-data-model-changes)
16. [Shader Architecture](#16-shader-architecture)
17. [Clip Tracks vs Pattern Tracks](#17-clip-tracks-vs-pattern-tracks)

---

## 1. Architecture Overview

### What Changed and Why

The existing compositor is stateless. Every frame, it receives a list of `CellFrameRequest` objects, uploads a `CellConstants` per draw call, and renders each cell as a textured quad with opacity and flip mode. There is no animation state, no per-cell effect processing, no global uniforms, and no multi-pass rendering.

This addendum introduces:

- **A per-cell visual effect chain** — a user-ordered sequence of GPU post-processing effects per track, applied to each cell's texture before final compositing. Effects can be reordered to produce different looks.
- **A per-cell animation state machine** — persistent state across frames that tracks zoom/pan/rotation and bounce animations, triggered on note start or slide note.
- **Frame-logic effects** (ping-pong loop) that modify which source frame is requested, not how pixels are processed.
- **Geometry effects** (gap scale, bounce, corner radius) that modify cell position/size/shape but are not part of the chainable pipeline.

### The Two Categories

**Non-chainable (fixed pipeline position):**

| Effect | What it modifies | When it runs |
|--------|-----------------|--------------|
| Global Gap Scale | Cell rect size | Before rendering (CPU, modifies UV rect) |
| Bounce Animation | Cell rect position + scale | Before rendering (CPU, modifies UV rect) |
| Corner Radius | Cell alpha mask | After all chainable effects (shader, always last visual step) |
| Opacity | Cell alpha | Always last (existing behavior) |
| Ping-Pong Loop | Source frame index | Before decode (CPU, modifies frame request) |

These are not reorderable because they operate on fundamentally different things than pixel color. Gap scale and bounce modify where the cell appears. Corner radius and opacity modify visibility. Ping-pong modifies which frame is decoded. None of these interact with color/distortion effects in a meaningful way.

**Chainable (user-ordered per-track):**

| Effect | What it does |
|--------|-------------|
| Desaturation | Converts to grayscale with variable intensity |
| Tint | Applies color tint with lightness-aware masking |
| Brightness & Contrast | Adjusts brightness and contrast |
| TV Simulator | CRT distortion (scanlines, displacement, chromatic aberration, etc.) |
| Zoom / Pan / Rotation | Animated UV transform |

These all operate on the cell's pixel data. Their order matters — desaturation before TV simulator produces a different look than TV simulator before desaturation. The user controls the order.

---

## 2. Visual Effect Chain System

### Layer 1 — What It Does

Each track has a visual effect chain — a list of GPU effects applied to that track's grid cells in order. The user adds, removes, and reorders effects just like the audio effect chain (Section 3 of the P3 spec), but for video.

**How the user interacts with it:**

- In the per-track grid cell settings panel, a "Visual FX" section shows the chain.
- Click "+" to add an effect from the menu: Desaturation, Tint, Brightness & Contrast, TV Simulator, Zoom/Pan/Rotation.
- Drag effects to reorder them.
- Click an effect to expand its parameter UI (Simple view by default, Advanced toggle for full controls).
- Right-click → Remove to delete an effect.
- Toggle bypass per-effect (same 5ms crossfade principle as audio effects, but applied as alpha blend between processed and unprocessed frames).
- **Hard limit:** 16 chainable effects per track. This is generous — most users will use 2–4.

**What the user sees:** The chain runs top-to-bottom. The output of one effect feeds the input of the next. The final output goes through corner radius masking and opacity, then composites into the output frame.

### Layer 2 — Implementation Detail

**Render target ping-pong architecture:**

For each active cell that has chainable effects:

```
1. Render base texture into RT_A
   (apply flip mode to UVs during this step — it's a UV transform, not a color effect)

2. For each effect in the chain (in user-defined order):
   a. Bind current source RT as SRV (input texture)
   b. Set the effect's pixel shader and its constant buffer
   c. Draw fullscreen quad → write to the other RT
   d. Swap source/dest RT pointers

3. The final RT contains the fully processed cell
   → Composite into output frame with:
     - Gap-adjusted cell rect position
     - Bounce-adjusted cell rect position + scale
     - Corner radius alpha mask
     - Opacity multiplication
```

**Render target management:**

- Allocate two RTs per cell resolution tier. In practice, all cells in a grid are the same size, so one pair of RTs sized to `(cellWidth, cellHeight)` is reused for every cell. If cells have different sizes (half-grid spans), maintain a small pool keyed by `(width, height)`.
- RT format: `DXGI_FORMAT_R8G8B8A8_UNORM` (same as the source textures).
- For cells with zero chainable effects, skip the ping-pong entirely — render the base texture directly into the output frame as the existing code already does. This is the fast path and should remain the common case.

**Effect shaders:**

Each chainable effect is a separate HLSL pixel shader. They all share the same vertex shader (fullscreen quad). Each has its own constant buffer with effect-specific parameters.

```
// Every chainable effect shader has this signature:
Texture2D inputTexture : register(t0);
SamplerState linearSampler : register(s0);
cbuffer EffectParams : register(b0) { /* effect-specific */ };

float4 PSMain(VSOutput input) : SV_Target {
    float2 uv = input.uv;
    float4 color = inputTexture.Sample(linearSampler, uv);
    // ... effect processing ...
    return color;
}
```

**Global constant buffer:**

A new `cbuffer GlobalConstants : register(b1)` is added, set once per frame (not per draw call):

```cpp
struct alignas(16) GlobalConstants {
    float time;          // seconds since playback start (for TV simulator animation)
    float outputWidth;   // output frame width in pixels
    float outputHeight;  // output frame height in pixels
    float padding;
};
```

This is bound at `b1` for all shaders that need it (currently only TV Simulator uses `time`). The existing `CellConstants` stays at `b0`.

**Bypass implementation:**

When a chainable effect is bypassed, skip its shader pass entirely (don't draw). Since each effect is a separate draw call in the ping-pong chain, skipping one just means the input RT passes through unchanged to the next effect. No crossfade needed for bypass because there's no audible click equivalent in video — a visual pop on one frame is imperceptible at 30+ fps. If testing reveals that bypassing TV Simulator mid-playback looks jarring, add a 3-frame alpha blend.

**Performance budget:**

Each chainable effect pass = 1 draw call of a simple pixel shader on a cell-sized RT. At 1080p with 4×4 grid (cell size ~480×270), each pass processes ~130K pixels. A modern GPU processes billions of pixels per second. Even 16 effects × 16 cells = 256 draw calls of trivial shaders. Total cost: well under 2ms. The bottleneck remains video decoding, never compositing.

---

## 3. Global Gap Scale

### Layer 1 — What It Does

A single slider that shrinks every grid cell inward from its center, creating uniform gaps between cells. The cell positions don't change — only their rendered size decreases, revealing the chorus layer (or black) behind them.

**Controls:**

- **Simple:** One slider in the Grid Layout panel. "Cell Gap" — 0% (cells fill grid, no gap) to 50% (cells at half size). Display as percentage.
- **Per-track override:** Each track has a checkbox "Custom Gap" in its grid cell settings. When checked, a per-track slider appears that overrides the global value for that track's cells. Unchecked = follows global.

### Layer 2 — Implementation Detail

**Data:**

- `GridLayout::gapScale` — `float`, range 0.0–0.5. Stored in project file. Default: 0.0.
- `TrackInfo::gapScaleOverride` — `std::optional<float>`. When set, overrides `GridLayout::gapScale` for this track. Default: `std::nullopt`.

**Application:** In `GridCompositor::gridCellToUV()` (or wherever the UV rect is computed from grid coordinates), after computing the base rect:

```cpp
float gap = track.gapScaleOverride.value_or(gridLayout.gapScale);
float shrunkW = cellW * (1.0f - gap);
float shrunkH = cellH * (1.0f - gap);
float offsetX = (cellW - shrunkW) * 0.5f;
float offsetY = (cellH - shrunkH) * 0.5f;
cellRect = { cellX + offsetX, cellY + offsetY, shrunkW, shrunkH };
```

This runs on the CPU before the cell rect is uploaded to `CellConstants`. The shader never knows about gap scale — it just gets a smaller rect. This is important because it means gap scale works identically for cells with and without chainable effects.

---

## 4. Bounce Animation

### Layer 1 — What It Does

On every note trigger, the cell's position overshoots in a user-chosen direction and settles back to its home position using an ease-out-back curve. The cell can also squash and stretch during the bounce for a cartoonish punch effect.

**Controls:**

- **Simple:** Enable toggle. Direction preset buttons (Up, Down, Left, Right). Distance slider.
- **Advanced:** Direction as angle (0–360°). Duration (ms). Squash/stretch amount. Overshoot intensity (how far past the target it swings before settling). Repeat count (how many times the bounce repeats with decaying amplitude). Easing selector (Ease-Out-Back, Elastic, Spring).

### Layer 2 — Implementation Detail

**Data (per-track, stored in `TrackInfo`):**

```cpp
struct BounceSettings {
    bool   enabled        = false;
    float  directionDeg   = 270.0f;  // 0=right, 90=up, 180=left, 270=down
    float  distance       = 0.15f;   // fraction of cell size (0.0–1.0)
    float  durationMs     = 200.0f;  // animation duration
    float  squashAmount   = 0.0f;    // 0.0–1.0, deformation intensity
    float  overshoot      = 1.70158f;// ease-out-back constant c1 (default = standard overshoot)
    int    repeatCount    = 1;       // 1 = single bounce, 2+ = repeat with decay
    int    easingType     = 0;       // 0=EaseOutBack, 1=Elastic, 2=Spring
};
```

**Easing functions:**

```cpp
// Ease-Out-Back: overshoots then settles
float easeOutBack(float t, float overshoot) {
    float c3 = overshoot + 1.0f;
    return 1.0f + c3 * powf(t - 1.0f, 3) + overshoot * powf(t - 1.0f, 2);
}

// Elastic: oscillates with exponential decay
float easeOutElastic(float t) {
    if (t == 0.0f || t == 1.0f) return t;
    return powf(2.0f, -10.0f * t) * sinf((t * 10.0f - 0.75f) * (2.0f * PI / 3.0f)) + 1.0f;
}

// Spring: critically damped spring simulation
float easeOutSpring(float t) {
    return 1.0f - powf(2.0f, -6.0f * t) * cosf(6.0f * PI * t);
}
```

**Runtime:** Managed by the `CellAnimation` state machine (Section 13). On note trigger, the bounce animation starts. Each frame, the compositor computes:

```cpp
float t = std::min(bounceElapsedMs / bounceDurationMs, 1.0f);
float progress = applyEasing(t, easingType, overshoot); // 0 → overshoot → 1
float displacement = distance * (1.0f - progress);      // starts at full, settles to 0

// Repeat with decay
if (repeatCount > 1) {
    int currentRepeat = static_cast<int>(bounceElapsedMs / bounceDurationMs);
    if (currentRepeat < repeatCount) {
        float localT = fmodf(bounceElapsedMs / bounceDurationMs, 1.0f);
        float decay = powf(0.5f, static_cast<float>(currentRepeat)); // halve amplitude each repeat
        progress = applyEasing(localT, easingType, overshoot);
        displacement = distance * (1.0f - progress) * decay;
    } else {
        displacement = 0.0f; // all repeats done, at rest
    }
}

float dirRad = directionDeg * PI / 180.0f;
float offsetX = cosf(dirRad) * displacement * cellW;
float offsetY = -sinf(dirRad) * displacement * cellH; // negative because screen Y is inverted

// Squash/stretch (axis-aligned approximation)
float scaleX = 1.0f + squashAmount * fabsf(displacement) * fabsf(sinf(dirRad));
float scaleY = 1.0f + squashAmount * fabsf(displacement) * fabsf(cosf(dirRad));
// Perpendicular axis compresses to preserve area
float perpScaleX = 1.0f - squashAmount * fabsf(displacement) * fabsf(cosf(dirRad)) * 0.5f;
float perpScaleY = 1.0f - squashAmount * fabsf(displacement) * fabsf(sinf(dirRad)) * 0.5f;
scaleX *= perpScaleX;
scaleY *= perpScaleY;
```

**Application to cell rect:** After gap scale, before the cell rect is uploaded:

```cpp
// Offset position
cellRect.x += offsetX;
cellRect.y += offsetY;
// Scale from center
float cx = cellRect.x + cellRect.w * 0.5f;
float cy = cellRect.y + cellRect.h * 0.5f;
cellRect.w *= scaleX;
cellRect.h *= scaleY;
cellRect.x = cx - cellRect.w * 0.5f;
cellRect.y = cy - cellRect.h * 0.5f;
```

Like gap scale, this is purely CPU-side. The shader just gets the modified rect.

---

## 5. Corner Radius

### Layer 1 — What It Does

Rounds the corners of each grid cell from sharp rectangles to pill/oval shapes.

**Controls:**

- **Simple:** Single slider per track. 0% = sharp corners. 100% = full ellipse (when cell is square, it's a circle).
- **Global toggle:** Checkbox "Apply to All Tracks" copies the current value to every track. Not a linked global — it's a one-time paste. Each track remains independently adjustable after.

### Layer 2 — Implementation Detail

**Data:**

- `TrackInfo::cornerRadius` — `float`, range 0.0–1.0. Default: 0.0.

**Shader implementation:** Corner radius is applied as the final alpha mask after all chainable effects, during the cell's composite into the output frame. It runs in the main compositing shader (the existing `GridComposite.hlsl`, extended), NOT as a chainable effect pass.

The `CellConstants` struct gains a `float cornerRadius` field. The shader uses a Signed Distance Field (SDF) rounded rectangle:

```hlsl
float roundedRectSDF(float2 p, float2 halfSize, float radius) {
    float2 d = abs(p) - halfSize + radius;
    return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - radius;
}

// In PSMain, after sampling the (possibly effect-processed) texture:
float maxRadius = min(cellSize.x, cellSize.y) * 0.5;
float r = cornerRadius * maxRadius;
float2 fragLocal = (uv - cellCenter) * cellSizePixels; // convert to pixel space for clean AA
float dist = roundedRectSDF(fragLocal, cellSizePixels * 0.5, r);
float mask = 1.0 - smoothstep(-1.0, 0.5, dist); // ~1px anti-aliased edge
color.a *= mask;
```

The `smoothstep(-1.0, 0.5, dist)` produces approximately 1.5 pixels of anti-aliasing at the rounded edge. This runs after the chainable effect chain's output has been composited, so it always clips the fully processed cell.

---

## 6. Desaturation

### Layer 1 — What It Does

Converts the cell's video to grayscale with variable intensity. The classic "bass track is black and white" look.

**Controls:**

- **Simple:** Amount slider, 0% (full color) to 100% (full grayscale).

No advanced controls — this effect is intentionally minimal. Users who want more control use Tint or Brightness & Contrast.

### Layer 2 — Implementation Detail

**Data (per effect instance in chain):**

```cpp
struct DesaturationParams {
    float amount = 1.0f; // 0.0–1.0
};
```

**Constant buffer:**

```hlsl
cbuffer DesatParams : register(b0) {
    float amount;
    float3 padding;
};
```

**Shader:**

```hlsl
float4 PSMain(VSOutput input) : SV_Target {
    float4 color = inputTexture.Sample(linearSampler, input.uv);
    float luma = dot(color.rgb, float3(0.299, 0.587, 0.114)); // ITU-R BT.601
    color.rgb = lerp(color.rgb, float3(luma, luma, luma), amount);
    return color;
}
```

7 lines of shader. Probably the simplest effect in the chain. But its position in the chain matters — desaturation before tint means the tint hits a grayscale image (adding color to gray). Desaturation after tint means the tint is removed. Both are valid creative choices, which is exactly why the chain is user-ordered.

---

## 7. Tint

### Layer 1 — What It Does

Applies a color tint to the cell's video. Unlike a flat color overlay, the tint is lightness-aware: it only affects pixels within a specified lightness range, so dark areas (like black outlines) stay unaffected and the tint blends naturally into the midtones and highlights.

**Controls:**

- **Simple:** Color picker for tint color. Strength slider (0–100%).
- **Advanced:** Lightness floor (0–100%) — pixels darker than this are unaffected. Lightness ceiling (100%) — pixels lighter than this are unaffected. These define the range of lightness values that receive the tint.

### Layer 2 — Implementation Detail

**Data:**

```cpp
struct TintParams {
    float r = 1.0f, g = 0.8f, b = 0.5f; // tint color (sepia default)
    float strength      = 0.5f;           // 0.0–1.0
    float lightnessFloor   = 0.15f;       // lightness below this is untouched (keeps blacks black)
    float lightnessCeiling = 1.0f;        // lightness above this is untouched
};
```

**Constant buffer:**

```hlsl
cbuffer TintParams : register(b0) {
    float3 tintColor;
    float  strength;
    float  lightnessFloor;
    float  lightnessCeiling;
    float2 padding;
};
```

**Shader:**

```hlsl
float4 PSMain(VSOutput input) : SV_Target {
    float4 color = inputTexture.Sample(linearSampler, input.uv);

    // Compute perceptual lightness (0–1)
    float lightness = dot(color.rgb, float3(0.299, 0.587, 0.114));

    // Smooth mask: 1.0 within [floor, ceiling], fades to 0.0 outside
    float maskLow  = smoothstep(lightnessFloor - 0.05, lightnessFloor + 0.05, lightness);
    float maskHigh = 1.0 - smoothstep(lightnessCeiling - 0.05, lightnessCeiling + 0.05, lightness);
    float mask = maskLow * maskHigh;

    // Apply tint: multiply source color by tint color, blend by strength and mask
    float3 tinted = color.rgb * tintColor;
    color.rgb = lerp(color.rgb, tinted, strength * mask);

    return color;
}
```

The `smoothstep` on the floor/ceiling boundaries creates a soft transition (over ~10% of the lightness range) so the tint doesn't have a hard cutoff. Multiplying source by tint color (rather than replacing) preserves the original value relationships — dark-ish reds stay darker than light-ish reds.

---

## 8. Brightness & Contrast

### Layer 1 — What It Does

Adjusts the brightness and contrast of the cell's video.

**Controls:**

- **Simple:** Brightness slider (-100% to +100%, default 0%). Contrast slider (-100% to +100%, default 0%).

No advanced controls needed.

### Layer 2 — Implementation Detail

**Data:**

```cpp
struct BrightnessContrastParams {
    float brightness = 0.0f; // -1.0 to 1.0
    float contrast   = 0.0f; // -1.0 to 1.0
};
```

**Constant buffer:**

```hlsl
cbuffer BrightContrastParams : register(b0) {
    float brightness;
    float contrast;
    float2 padding;
};
```

**Shader:**

```hlsl
float4 PSMain(VSOutput input) : SV_Target {
    float4 color = inputTexture.Sample(linearSampler, input.uv);

    // Brightness: simple offset
    color.rgb += brightness;

    // Contrast: scale around midpoint (0.5)
    // Map contrast [-1, 1] to multiplier [0, 3] with 1.0 at contrast=0
    float contrastFactor = 1.0 + contrast * 2.0; // range [−1,3] but clamped below
    contrastFactor = max(contrastFactor, 0.0);
    color.rgb = (color.rgb - 0.5) * contrastFactor + 0.5;

    color.rgb = saturate(color.rgb); // clamp to [0,1]
    return color;
}
```

---

## 9. TV Simulator (CRT Distortion)

### Layer 1 — What It Does

Simulates a broken CRT television — horizontal line displacement, rolling sync bars, scanline darkening, chromatic aberration, static noise, horizontal hold jitter, and color bleed. Can be subtle (slight scanline texture) or aggressive (full broken TV look).

**Controls:**

- **Simple:** Enable toggle. Intensity slider (0–100%) — scales all sub-effects together.
- **Advanced:**
  - **Roll Speed:** How fast the horizontal sync bar scrolls vertically. 0 = frozen, higher = faster.
  - **Scanline Alpha:** Visibility of the darkened scanlines. 0 = invisible, 1 = heavy scanlines.
  - **Chromatic Aberration:** How far the RGB channels separate horizontally. 0 = no separation, higher = more rainbow fringing.
  - **Static Noise:** Amount of random pixel noise overlaid. 0 = none, higher = more snow.
  - **H-Hold Jitter Frequency:** How often the horizontal displacement jumps to a new pattern. Low = slow drifting, high = rapid jittering.
  - **Color Bleed:** Horizontal smearing of bright colors into adjacent pixels. Simulates the analog signal bleeding across scanlines.

### Layer 2 — Implementation Detail

**Data:**

```cpp
struct TVSimulatorParams {
    float intensity       = 0.5f;  // master intensity, scales all sub-effects
    float rollSpeed       = 1.0f;  // vertical scroll speed of sync bar
    float scanlineAlpha   = 0.3f;  // scanline visibility
    float chromaOffset    = 0.003f;// chromatic aberration offset in UV space
    float staticNoise     = 0.0f;  // noise overlay amount
    float jitterFreq      = 2.0f;  // H-hold jitter frequency
    float colorBleed      = 0.0f;  // horizontal color smearing amount
};
```

**Constant buffer:**

```hlsl
cbuffer TVParams : register(b0) {
    float intensity;
    float rollSpeed;
    float scanlineAlpha;
    float chromaOffset;
    float staticNoise;
    float jitterFreq;
    float colorBleed;
    float padding;
};

cbuffer GlobalConstants : register(b1) {
    float time;
    float outputWidth;
    float outputHeight;
    float globalPadding;
};
```

**Shader:**

```hlsl
// Hash function for noise
float hash(float2 p) {
    float h = dot(p, float2(127.1, 311.7));
    return frac(sin(h) * 43758.5453);
}

float4 PSMain(VSOutput input) : SV_Target {
    float2 uv = input.uv;
    float2 resolution = float2(outputWidth, outputHeight);
    float scaledIntensity = intensity;

    // --- 1. Horizontal line displacement (jitter) ---
    float scanlineY = floor(uv.y * resolution.y);
    float jitterSeed = scanlineY + floor(time * jitterFreq) * 100.0;
    float lineNoise = (hash(float2(jitterSeed, 0.0)) * 2.0 - 1.0);
    uv.x += lineNoise * scaledIntensity * 0.02;

    // --- 2. Chromatic aberration (sample R, G, B at offset UVs) ---
    float caOffset = chromaOffset * scaledIntensity;
    float r = inputTexture.Sample(linearSampler, float2(uv.x - caOffset, uv.y)).r;
    float g = inputTexture.Sample(linearSampler, uv).g;
    float b = inputTexture.Sample(linearSampler, float2(uv.x + caOffset, uv.y)).b;
    float a = inputTexture.Sample(linearSampler, uv).a;
    float4 color = float4(r, g, b, a);

    // --- 3. Color bleed (horizontal box blur on color, not luminance) ---
    if (colorBleed > 0.001) {
        float bleedPixels = colorBleed * scaledIntensity * 8.0;
        float2 texelSize = float2(1.0 / resolution.x, 0.0);
        float3 bleed = color.rgb;
        bleed += inputTexture.Sample(linearSampler, uv + texelSize * bleedPixels).rgb;
        bleed += inputTexture.Sample(linearSampler, uv + texelSize * bleedPixels * 2.0).rgb;
        bleed += inputTexture.Sample(linearSampler, uv - texelSize * bleedPixels * 0.5).rgb;
        color.rgb = lerp(color.rgb, bleed * 0.25, colorBleed * scaledIntensity);
    }

    // --- 4. Rolling sync bar ---
    float barPos = frac(time * rollSpeed * 0.1);
    float barDist = abs(uv.y - barPos);
    barDist = min(barDist, 1.0 - barDist); // wrap around
    float bar = 1.0 - smoothstep(0.0, 0.15, barDist);
    color.rgb += bar * scaledIntensity * 0.08;

    // --- 5. Scanline darkening ---
    float scanline = sin(uv.y * resolution.y * 3.14159) * 0.5 + 0.5;
    color.rgb *= lerp(1.0, scanline, scanlineAlpha * scaledIntensity);

    // --- 6. Static noise overlay ---
    if (staticNoise > 0.001) {
        float noise = hash(uv * resolution + time * 1000.0) * 2.0 - 1.0;
        color.rgb += noise * staticNoise * scaledIntensity * 0.15;
    }

    color.rgb = saturate(color.rgb);
    return color;
}
```

**Note on `time`:** The `GlobalConstants.time` value comes from the compositor's frame counter divided by fps: `time = frameIndex / fps`. During offline render, this advances deterministically. During real-time preview, it advances with the audio clock. The TV effect is purely cosmetic — `time` drives animation only, not A/V sync.

**Note on `resolution`:** The TV simulator needs to know pixel dimensions for scanline spacing. This comes from `GlobalConstants.outputWidth/Height` during offline render, or the preview RT dimensions during real-time preview.

---

## 10. Zoom / Pan / Rotation Animation

### Layer 1 — What It Does

When a note triggers on a grid cell, the video *inside* the cell (not the cell box itself) can animate its zoom level, pan offset, and rotation over a duration, then hold the final keyframe for the rest of the note. The cell boundary stays fixed — only the content within transforms.

**Controls:**

- **Simple:** Zoom target slider (0.25× to 4×, default 1× = no zoom). Duration (ms).
- **Advanced:**
  - **Start zoom** (what zoom level the animation starts from — default 1×).
  - **Start pan X, Y** and **Target pan X, Y** (-1 to 1, normalized offset from center).
  - **Start rotation** and **Target rotation** (degrees, -360 to 360).
  - **Per-axis easing:** Separate easing types for zoom, pan, and rotation. Each can be Linear, Ease-Out, Ease-In-Out, or Ease-Out-Back.
  - **Overshoot:** For Ease-Out-Back curves, how far past the target the animation swings (0–3, default 1.70158).

### Layer 2 — Implementation Detail

**Data (per-track, stored in `TrackInfo`):**

```cpp
struct ZoomPanRotSettings {
    bool   enabled       = false;

    // Zoom
    float  startZoom     = 1.0f;   // animation start
    float  targetZoom    = 1.0f;   // animation end (hold here after duration)

    // Pan (normalized: -1 = full left/up, 0 = center, 1 = full right/down)
    float  startPanX     = 0.0f;
    float  startPanY     = 0.0f;
    float  targetPanX    = 0.0f;
    float  targetPanY    = 0.0f;

    // Rotation (degrees)
    float  startRotation = 0.0f;
    float  targetRotation = 0.0f;

    // Timing
    float  durationMs    = 300.0f;

    // Easing (per-axis)
    int    zoomEasing    = 1;  // 0=Linear, 1=EaseOut, 2=EaseInOut, 3=EaseOutBack
    int    panEasing     = 1;
    int    rotEasing     = 1;
    float  overshoot     = 1.70158f; // only used by EaseOutBack
};
```

**Runtime:** Managed by the `CellAnimation` state machine (Section 13). Each frame, the compositor computes interpolated values:

```cpp
float tZoom = applyEasing(rawT, zoomEasing, overshoot);
float currentZoom = lerp(startZoom, targetZoom, tZoom);

float tPan = applyEasing(rawT, panEasing, overshoot);
float currentPanX = lerp(startPanX, targetPanX, tPan);
float currentPanY = lerp(startPanY, targetPanY, tPan);

float tRot = applyEasing(rawT, rotEasing, overshoot);
float currentRotation = lerp(startRotation, targetRotation, tRot);
```

These values are passed as part of the effect's constant buffer when Zoom/Pan/Rotation is in the chainable effect chain.

**Shader (chainable effect):**

```hlsl
cbuffer ZoomPanRotParams : register(b0) {
    float zoom;
    float panX;
    float panY;
    float rotation; // radians
};

float4 PSMain(VSOutput input) : SV_Target {
    float2 uv = input.uv;

    // Center UVs
    uv -= 0.5;

    // Rotation
    float s = sin(rotation);
    float c = cos(rotation);
    uv = float2(uv.x * c - uv.y * s, uv.x * s + uv.y * c);

    // Zoom (1/zoom because zooming in = narrower UV range)
    uv /= zoom;

    // Pan (offset in normalized cell space)
    uv -= float2(panX, panY);

    // Back to [0,1]
    uv += 0.5;

    // Clamp — shows edge pixels stretched rather than wrapping
    uv = clamp(uv, 0.0, 1.0);

    return inputTexture.Sample(linearSampler, uv);
}
```

**As a chainable effect:** Zoom/Pan/Rotation being in the user-ordered chain means:
- Before desaturation: zoom, then desaturate the zoomed view.
- After TV simulator: the CRT distortion is applied to the full frame, then zoomed into (so you'd zoom into scanlines). This could be the desired artistic effect or not — the user chooses by positioning it in the chain.

**Why it's chainable and not geometry:** Because it transforms the *content* inside the cell's fixed boundaries, not the cell's position on screen. Unlike bounce (which moves the cell rect), zoom/pan/rotation change what part of the texture you're seeing. This makes it a pixel-space operation and a natural fit for the chainable pipeline.

---

## 11. Ping-Pong Video Loop

### Layer 1 — What It Does

When a note is longer than its source video, instead of freezing or going black, the video plays forward and then reverses through a configurable region of the video, creating a continuous back-and-forth loop. This keeps visual motion alive for sustained notes — essential for pads and held chorus notes.

**Controls:**

- **Simple:** Enable toggle. Loop tail % slider (what portion of the video is used for the bounce region).
- **Advanced:**
  - **Loop Region Start (%):** Where the bounce-back region begins (default: computed from tail %). Allows the user to set a specific start point, e.g., "start bouncing at 60% through the video."
  - **Loop Region End (%):** Where the bounce-back region ends (default: 100%, i.e., the end of the video). Allows trimming — "don't use the last 10% of the video."
  - **Crossfade Frames:** Number of frames to crossfade at each direction change (forward→reverse, reverse→forward). Default: 3 frames. Prevents visible pops at reversal points.
  - **Reverse Speed (%):** Playback speed of the reversed section. 100% = same speed. 50% = half speed (dreamy). 200% = double speed. Default: 100%.
  - **Max Loops:** Maximum number of forward/reverse cycles before freezing on the last frame. 0 = infinite. Default: 0.

### Layer 2 — Implementation Detail

**Data (per-track, stored in `TrackInfo`):**

```cpp
struct PingPongSettings {
    bool   enabled          = false;
    float  regionStartPct   = 0.8f;  // 0.0–1.0, where bounce region starts
    float  regionEndPct     = 1.0f;  // 0.0–1.0, where bounce region ends
    int    crossfadeFrames  = 3;     // frames to blend at direction change
    float  reverseSpeed     = 1.0f;  // speed multiplier for reverse playback
    int    maxLoops         = 0;     // 0 = infinite
};
```

**Application:** This runs in the frame request logic, NOT the shader. It modifies which `sourceFrameIndex` the `FrameCollector` requests for a given cell at a given output timestamp.

In `FrameCollector::collectRequests()` (or wherever `sourceFrameIndex` is computed), after computing the base elapsed frame count:

```cpp
int64_t computePingPongFrame(
    int64_t elapsed,           // frames elapsed since note start
    int64_t sourceDuration,    // total source video frames
    const PingPongSettings& pp
) {
    if (elapsed < sourceDuration) {
        // Normal forward playback — not yet past the end
        return elapsed;
    }

    if (!pp.enabled) {
        // No ping-pong: freeze on last frame
        return sourceDuration - 1;
    }

    int64_t regionStart = static_cast<int64_t>(sourceDuration * pp.regionStartPct);
    int64_t regionEnd   = static_cast<int64_t>(sourceDuration * pp.regionEndPct);
    int64_t regionLen   = regionEnd - regionStart;

    if (regionLen <= 0) return sourceDuration - 1; // degenerate

    int64_t pastEnd = elapsed - sourceDuration;

    // Adjust for reverse speed: reverse section takes longer at lower speed
    // Forward section is always 1x through the region, reverse is at reverseSpeed
    // One full cycle = regionLen (forward) + regionLen/reverseSpeed (reverse)
    double forwardLen = static_cast<double>(regionLen);
    double reverseLen = static_cast<double>(regionLen) / pp.reverseSpeed;
    double cycleLen = forwardLen + reverseLen;

    // Check max loops
    if (pp.maxLoops > 0) {
        double maxFrames = cycleLen * pp.maxLoops;
        if (static_cast<double>(pastEnd) >= maxFrames) {
            return regionStart; // frozen at loop start after max loops
        }
    }

    // Where are we in the current cycle?
    double posInCycle = fmod(static_cast<double>(pastEnd), cycleLen);

    if (posInCycle < forwardLen) {
        // Forward through region
        return regionStart + static_cast<int64_t>(posInCycle);
    } else {
        // Reverse through region
        double reversePos = (posInCycle - forwardLen) * pp.reverseSpeed;
        return regionEnd - 1 - static_cast<int64_t>(reversePos);
    }
}
```

**Crossfade at direction changes:** When the computed frame is within `crossfadeFrames` of a direction change boundary, the compositor requests BOTH the current frame and the adjacent frame from the other direction, and alpha-blends them. This requires the frame cache to hold both frames simultaneously — but since they're from the same source file and adjacent in time, the LRU cache handles this naturally.

```cpp
// Pseudocode for crossfade detection
double posInCycle = fmod(pastEnd, cycleLen);
bool nearForwardToReverse = (forwardLen - posInCycle) >= 0
                            && (forwardLen - posInCycle) < crossfadeFrames;
bool nearReverseToForward = (posInCycle - forwardLen) >= (reverseLen - crossfadeFrames)
                            && (posInCycle - forwardLen) < reverseLen;

if (nearForwardToReverse || nearReverseToForward) {
    // Request both frames, blend with alpha based on distance to boundary
    float blendFactor = distanceToBoundary / crossfadeFrames;
    // Compositor blends: frameA * blendFactor + frameB * (1 - blendFactor)
}
```

**Integration with source deduplication:** Ping-pong doesn't break deduplication. The frame collector still groups by `(sourcePath, sourceFrameIndex)`. If multiple cells ping-pong to the same source frame simultaneously, it's decoded once.

**UI — Loop Region Visualizer:** In the per-track settings, the loop region start/end should be visualized like a waveform/video crossfader. Show a thumbnail timeline strip of the source video with draggable handles for start and end positions. The user can see exactly which portion of the video will be used for the bounce. This is the "crossfader" feel you described.

---

## 12. Slide Note Animation Triggers

### Layer 1 — What It Does

On pattern tracks, slide notes currently serve no visual purpose — they're audio-only pitch events that are filtered out before reaching the compositor. This feature repurposes slide notes as animation triggers: when a slide note fires, it triggers one of the visual effects (Zoom/Pan/Rotation, Bounce, or TV Simulator) on the currently active cell for that track.

The slide note does NOT create a new cell or change the video source. It modifies the visual behavior of the existing active cell.

**How the user configures it (per-track):**

1. In the per-track grid cell settings, a "Slide Note Effect" dropdown appears with options:
   - **None** (default — slide notes have no visual effect)
   - **Zoom / Pan / Rotation** — triggers the zoom animation
   - **Bounce** — triggers the bounce animation
   - **TV Simulator** — triggers/intensifies the TV distortion

2. A "Duration Mode" toggle:
   - **Follow Slide Length:** The animation duration matches the slide note's duration. Longer slide = slower animation.
   - **Fixed Duration (ms):** The animation plays at a fixed speed regardless of slide length.

3. The parameter values used by the triggered effect come from the track's existing effect settings (the same controls as the regular effect). The slide note just controls *when* and *how long* the animation plays.

**Interaction with regular note triggers:**

- If the track has Zoom/Pan/Rotation in its visual chain AND Slide Note Effect is set to Zoom/Pan/Rotation: the regular note triggers the animation using the track's zoom settings, AND a slide note can re-trigger it mid-note with potentially different timing (the slide note's duration overrides the animation duration if in "Follow Slide Length" mode).
- If the track does NOT have Zoom/Pan/Rotation in its chain but Slide Note Effect is set to it: the slide note temporarily activates that effect for its duration only. After the slide note ends (and the animation holds its final keyframe), the effect remains applied for the rest of the parent note.

### Layer 2 — Implementation Detail

**Data (per-track, stored in `TrackInfo`):**

```cpp
struct SlideNoteEffectSettings {
    enum class EffectType { None, ZoomPanRot, Bounce, TVSimulator };
    EffectType type = EffectType::None;

    enum class DurationMode { FollowSlide, Fixed };
    DurationMode durationMode = DurationMode::FollowSlide;
    float fixedDurationMs     = 300.0f;
};
```

**Pipeline changes:**

Currently, `buildVideoEvents()` filters out slide notes entirely — they never produce a `VideoEvent`. This must change.

**New behavior in `buildVideoEvents()`:**

1. Slide notes still do NOT produce a `VideoEvent` (they don't create a new cell).
2. Instead, slide notes produce a new lightweight event type:

```cpp
struct SlideAnimationEvent {
    double   startBeat;
    double   durationBeats;
    int      trackId;
    float    slideVelocity;    // can modulate effect intensity
    float    slideCurveCx;     // bezier curve shape (future: shape the animation curve)
    float    slideCurveCy;
};
```

3. These are passed alongside `VideoEvent` objects to the `FrameCollector`.

**In `FrameCollector::collectRequests()` (or the animation state manager):**

When processing a frame, check if any `SlideAnimationEvent` starts at or has started before the current beat position and hasn't ended yet. If so, trigger or update the animation on the corresponding track's active cell.

```cpp
for (auto& slideEvt : slideAnimationEvents) {
    if (currentBeat >= slideEvt.startBeat
        && currentBeat < slideEvt.startBeat + slideEvt.durationBeats) {

        // Find the active cell for this track
        CellAnimation& anim = cellAnimations[slideEvt.trackId];
        auto& settings = tracks[slideEvt.trackId].slideNoteEffect;

        if (settings.type == SlideNoteEffectSettings::EffectType::ZoomPanRot) {
            float duration = (settings.durationMode == SlideNoteEffectSettings::DurationMode::FollowSlide)
                ? beatsToMs(slideEvt.durationBeats)
                : settings.fixedDurationMs;
            anim.triggerZoomPanRot(duration);  // resets animation, starts from current values
        }
        // ... similar for Bounce, TVSimulator
    }
}
```

**TV Simulator as a slide-triggered effect:** When Slide Note Effect is set to TV Simulator, the slide note doesn't "animate" the TV effect the same way as zoom/bounce. Instead, it controls the intensity: the TV effect ramps from 0 intensity to the track's configured intensity over the slide duration. When the slide note ends, the intensity holds at the configured value for the rest of the parent note. This creates a "glitch in" effect.

**Important constraints:**

- Slide note animation triggers are **pattern tracks only**. Clip tracks do not have slide notes.
- A slide note can only affect the cell that is currently active on the same track. If no cell is active (no parent note playing), the slide note has no visual effect.
- Multiple overlapping slide notes on the same track: each re-triggers the animation. The latest slide note wins.

---

## 13. Per-Cell Animation State Machine

### Layer 1 — What It Does

This is the shared infrastructure behind Zoom/Pan/Rotation (Section 10) and Bounce (Section 4). It maintains animation state across frames for each active grid cell, so animations can progress smoothly over time rather than being computed statelessly.

### Layer 2 — Implementation Detail

**Data structure:**

```cpp
struct CellAnimation {
    // --- Zoom/Pan/Rotation state ---
    bool  zprActive       = false;
    float zprElapsedMs    = 0.0f;
    float zprDurationMs   = 0.0f;
    float currentZoom     = 1.0f;
    float currentPanX     = 0.0f;
    float currentPanY     = 0.0f;
    float currentRotationDeg = 0.0f;

    // --- Bounce state ---
    bool  bounceActive    = false;
    float bounceElapsedMs = 0.0f;
    float bounceDurationMs = 0.0f;

    // --- TV Simulator ramp (for slide-triggered TV) ---
    bool  tvRampActive    = false;
    float tvRampElapsedMs = 0.0f;
    float tvRampDurationMs = 0.0f;
    float tvRampIntensity = 0.0f; // current ramped intensity

    // --- Bookkeeping ---
    int   activeNoteId    = -1;  // which note is currently driving this cell
    int   trackId         = -1;

    void triggerNote(int noteId, const ZoomPanRotSettings& zpr, const BounceSettings& bounce) {
        activeNoteId = noteId;

        if (zpr.enabled) {
            zprActive = true;
            zprElapsedMs = 0.0f;
            zprDurationMs = zpr.durationMs;
            currentZoom = zpr.startZoom;
            currentPanX = zpr.startPanX;
            currentPanY = zpr.startPanY;
            currentRotationDeg = zpr.startRotation;
        }

        if (bounce.enabled) {
            bounceActive = true;
            bounceElapsedMs = 0.0f;
            bounceDurationMs = bounce.durationMs * bounce.repeatCount;
        }
    }

    void triggerSlide(float durationMs,
                      SlideNoteEffectSettings::EffectType type,
                      const ZoomPanRotSettings& zpr,
                      const BounceSettings& bounce) {
        switch (type) {
            case SlideNoteEffectSettings::EffectType::ZoomPanRot:
                zprActive = true;
                zprElapsedMs = 0.0f;
                zprDurationMs = durationMs;
                currentZoom = zpr.startZoom;
                currentPanX = zpr.startPanX;
                currentPanY = zpr.startPanY;
                currentRotationDeg = zpr.startRotation;
                break;
            case SlideNoteEffectSettings::EffectType::Bounce:
                bounceActive = true;
                bounceElapsedMs = 0.0f;
                bounceDurationMs = durationMs;
                break;
            case SlideNoteEffectSettings::EffectType::TVSimulator:
                tvRampActive = true;
                tvRampElapsedMs = 0.0f;
                tvRampDurationMs = durationMs;
                tvRampIntensity = 0.0f;
                break;
            default: break;
        }
    }

    void advance(float deltaMs) {
        if (zprActive) {
            zprElapsedMs = std::min(zprElapsedMs + deltaMs, zprDurationMs);
            // Hold at end — don't reset
        }
        if (bounceActive) {
            bounceElapsedMs = std::min(bounceElapsedMs + deltaMs, bounceDurationMs);
        }
        if (tvRampActive) {
            tvRampElapsedMs = std::min(tvRampElapsedMs + deltaMs, tvRampDurationMs);
            tvRampIntensity = tvRampElapsedMs / tvRampDurationMs; // linear ramp 0→1
        }
    }

    void reset() {
        zprActive = false;
        bounceActive = false;
        tvRampActive = false;
        activeNoteId = -1;
        currentZoom = 1.0f;
        currentPanX = 0.0f;
        currentPanY = 0.0f;
        currentRotationDeg = 0.0f;
        tvRampIntensity = 0.0f;
    }
};
```

**Storage:** A `std::unordered_map<int, CellAnimation>` keyed by track ID, owned by the compositor (or a new `AnimationManager` class that sits alongside the compositor). One animation state per track — since a track can only have one active cell at a time in the grid, one state per track is sufficient.

**Frame advancement:** Each frame, before collecting cell requests:

```cpp
float deltaMs = 1000.0f / fps;  // e.g., 33.33ms at 30fps
for (auto& [trackId, anim] : cellAnimations) {
    anim.advance(deltaMs);
}
```

**Note trigger detection:** When `FrameCollector` processes a cell and sees that the note driving it has a different ID than `anim.activeNoteId`, it calls `triggerNote()` to reset and start new animations.

**Cell deactivation:** When a track's cell becomes inactive (no note playing, opacity → 0), call `reset()` on its animation state.

---

## 14. Preview Performance Controls

### Layer 1 — What It Does

Three controls that let users trade visual quality for preview performance:

1. **Preview Resolution Scale:** Renders the preview at a fraction of full resolution, then upscales. Reduces GPU compositing and effect processing cost proportionally.
2. **Preview Effects Bypass:** Disables all chainable visual effects during preview. Cells render as plain textures with only opacity and flip mode. Layout, gap scale, and corner radius remain visible.
3. **Preview FPS:** Already exists (`GridLayout::previewFps`, 1–120). Combined with the above, users can find their ideal quality/performance balance.

### Layer 2 — Implementation Detail

**Data (stored in user preferences, not project file — these are workstation-specific):**

```cpp
struct PreviewSettings {
    float resolutionScale    = 1.0f;  // 1.0 = full, 0.75, 0.5, 0.25
    bool  effectsBypass      = false; // skip all chainable effects in preview
    // previewFps already exists in GridLayout
};
```

**Resolution scaling:** When `resolutionScale < 1.0`, the compositor creates its render targets at `outputWidth * scale × outputHeight * scale`. The final composited frame is then stretched to fill the preview window. During offline export, resolution scale is always 1.0 — this setting only affects the real-time preview.

**Effects bypass:** When `effectsBypass == true`, the compositor skips the entire ping-pong RT chain for every cell. Cells go directly from base texture to final composite (with gap scale, bounce, corner radius, and opacity still applied — these are cheap CPU-side or single-pass operations). This is the fastest possible preview mode while still showing correct layout and timing.

**UI:** A small toolbar at the top of the preview panel:
- Resolution dropdown: 100% / 75% / 50% / 25%
- "FX" toggle button (lit = effects on, dim = effects bypassed)
- FPS already exists in grid layout settings

---

## 15. Data Model Changes

### TimelineTypes.h Additions

```cpp
// New struct for visual effect chain entry
struct VisualEffect {
    enum class Type {
        Desaturation,
        Tint,
        BrightnessContrast,
        TVSimulator,
        ZoomPanRotation
    };
    Type type;
    bool bypassed = false;

    // Union-style params (or std::variant, or a param blob)
    // Each type has its own param struct
    float params[16] = {}; // flat float array, interpreted per-type
    // Index mapping defined per effect type (see individual sections)
};

// Param index mappings:
// Desaturation:      params[0] = amount
// Tint:              params[0] = r, [1] = g, [2] = b, [3] = strength,
//                    [4] = lightnessFloor, [5] = lightnessCeiling
// BrightnessContrast: params[0] = brightness, [1] = contrast
// TVSimulator:       params[0] = intensity, [1] = rollSpeed, [2] = scanlineAlpha,
//                    [3] = chromaOffset, [4] = staticNoise, [5] = jitterFreq,
//                    [6] = colorBleed
// ZoomPanRotation:   params[0] = startZoom, [1] = targetZoom,
//                    [2] = startPanX, [3] = startPanY,
//                    [4] = targetPanX, [5] = targetPanY,
//                    [6] = startRotation, [7] = targetRotation,
//                    [8] = durationMs,
//                    [9] = zoomEasing, [10] = panEasing, [11] = rotEasing,
//                    [12] = overshoot
```

### TrackInfo Additions

```cpp
struct TrackInfo {
    // ... existing fields ...

    // Visual compositor settings (new)
    float                       gapScaleOverride = -1.0f; // -1 = use global, ≥0 = override
    float                       cornerRadius     = 0.0f;  // 0.0–1.0
    BounceSettings              bounce;
    PingPongSettings            pingPong;
    ZoomPanRotSettings          zoomPanRot;       // default settings for note triggers
    SlideNoteEffectSettings     slideNoteEffect;
    std::vector<VisualEffect>   visualEffectChain; // user-ordered chainable effects
};
```

### GridLayout Additions

```cpp
struct GridLayout {
    // ... existing fields ...

    float gapScale = 0.0f;  // global gap scale, 0.0–0.5
};
```

### CellFrameRequest Additions

```cpp
struct CellFrameRequest {
    // ... existing fields ...

    // New fields for visual effects
    float cornerRadius   = 0.0f;
    float desaturation   = 0.0f;  // computed from chain, for simple cases without RT ping-pong

    // Animation state snapshot (computed by AnimationManager each frame)
    float currentZoom    = 1.0f;
    float currentPanX    = 0.0f;
    float currentPanY    = 0.0f;
    float currentRotDeg  = 0.0f;
    float bounceOffsetX  = 0.0f;
    float bounceOffsetY  = 0.0f;
    float bounceScaleX   = 1.0f;
    float bounceScaleY   = 1.0f;

    // Pointer to track's visual effect chain (for RT ping-pong processing)
    const std::vector<VisualEffect>* visualChain = nullptr;
};
```

### CellConstants (GPU) — Expanded

```cpp
struct alignas(16) CellConstants {
    float cellRect[4];      // bytes  0–15 : x, y, w, h in UV [0,1]
    float opacity;          // bytes 16–19
    int   flipMode;         // bytes 20–23
    int   globalNoteIndex;  // bytes 24–27
    float cornerRadius;     // bytes 28–31
    // Total: 32 bytes (same alignment, one new field)
};
// Corner radius is the only new field in the MAIN compositing pass CB.
// Chainable effects each have their own CBs, bound during their respective RT passes.
```

---

## 16. Shader Architecture

### Overview

The current single-shader architecture (`GridComposite.hlsl`) is extended but NOT replaced. The compositing shader remains the final pass. New chainable effect shaders are separate `.hlsl` files.

### File Layout

```
engine/src/render/shaders/
├── GridComposite.hlsl        // MODIFIED: adds corner radius + global CB
├── FX_Desaturation.hlsl      // NEW: chainable effect
├── FX_Tint.hlsl              // NEW: chainable effect
├── FX_BrightnessContrast.hlsl // NEW: chainable effect
├── FX_TVSimulator.hlsl       // NEW: chainable effect
├── FX_ZoomPanRotation.hlsl   // NEW: chainable effect
└── FullscreenQuad.hlsl       // EXISTING: shared vertex shader
```

### Processing Order (Per Cell)

```
CPU SIDE (FrameCollector + AnimationManager):
  1. Compute gap-adjusted cell rect
  2. Compute bounce offset + squash/stretch → modify cell rect
  3. Compute ping-pong source frame index → modify frame request
  4. Advance animation state → compute current zoom/pan/rot values

GPU SIDE (GridCompositor):
  IF cell has chainable effects:
    5. Render base texture to RT_A (apply flip mode here)
    6. For each effect in chain:
       - Bind source RT, set effect shader + CB
       - Draw → other RT
       - Swap
    7. Composite final RT into output frame:
       - Apply corner radius SDF alpha mask
       - Multiply by opacity
       - Composite at bounce-adjusted cell rect position

  ELSE (fast path — no chainable effects):
    5. Existing single-pass: sample texture, apply flip, apply opacity
       + NEW: apply corner radius SDF
       → composite at gap/bounce-adjusted cell rect position
```

### GridComposite.hlsl — Modified

```hlsl
cbuffer CellConstants : register(b0) {
    float4 cellRectPacked;   // x, y, w, h
    float  opacity;
    int    flipMode;
    int    globalNoteIndex;
    float  cornerRadius;
};

cbuffer GlobalConstants : register(b1) {
    float time;
    float outputWidth;
    float outputHeight;
    float globalPadding;
};

Texture2D cellTexture : register(t0);
SamplerState linearSampler : register(s0);

struct VSOutput {
    float4 pos : SV_Position;
    float2 uv  : TEXCOORD0;
};

float roundedRectSDF(float2 p, float2 halfSize, float radius) {
    float2 d = abs(p) - halfSize + radius;
    return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - radius;
}

float4 PSMain(VSOutput input) : SV_Target {
    float2 cellPos  = cellRectPacked.xy;
    float2 cellSize = cellRectPacked.zw;

    // Compute local UV within cell
    float2 localUV = (input.uv - cellPos) / cellSize;

    // Discard if outside cell bounds
    if (localUV.x < 0.0 || localUV.x > 1.0 || localUV.y < 0.0 || localUV.y > 1.0)
        discard;

    // Apply flip mode (unchanged from existing)
    // ... existing flip code ...

    // Sample texture
    float4 color = cellTexture.Sample(linearSampler, localUV);

    // Corner radius alpha mask
    if (cornerRadius > 0.001) {
        float2 cellSizePx = cellSize * float2(outputWidth, outputHeight);
        float maxR = min(cellSizePx.x, cellSizePx.y) * 0.5;
        float r = cornerRadius * maxR;
        float2 fragLocal = (localUV - 0.5) * cellSizePx;
        float dist = roundedRectSDF(fragLocal, cellSizePx * 0.5, r);
        float mask = 1.0 - smoothstep(-1.0, 0.5, dist);
        color.a *= mask;
    }

    // Opacity
    color.a *= opacity;

    return color;
}
```

---

## 17. Clip Tracks vs Pattern Tracks

### What Works Identically

| Feature | Clip Tracks | Pattern Tracks |
|---------|-------------|----------------|
| Gap Scale | ✅ Same | ✅ Same |
| Corner Radius | ✅ Same | ✅ Same |
| Desaturation | ✅ Same | ✅ Same |
| Tint | ✅ Same | ✅ Same |
| Brightness & Contrast | ✅ Same | ✅ Same |
| TV Simulator | ✅ Same | ✅ Same |
| Zoom/Pan/Rotation | ✅ Triggers on clip start | ✅ Triggers on note start |
| Bounce | ✅ Triggers on clip start | ✅ Triggers on note start |
| Ping-Pong | ✅ When clip source runs out | ✅ When note source runs out |

### What Differs

| Feature | Clip Tracks | Pattern Tracks |
|---------|-------------|----------------|
| Slide Note Triggers | ❌ Not available (no slide notes) | ✅ Full support |

### Why This Is Fine

All visual effects are per-track, applied to the cells produced by that track. Both clip tracks and pattern tracks produce `VideoEvent` objects and `CellFrameRequest` objects through the same pipeline. The visual effect chain operates on `CellFrameRequest` — it doesn't care whether the request originated from a clip or a pattern note.

The only clip-track limitation is the absence of slide-note animation triggers. This is a fundamental data model constraint (clip tracks don't have `PatternNote` with `isSlide`), not an implementation shortcoming. If users need mid-clip animation triggers on clip tracks, a future feature could add keyframe markers on clips — but that's out of scope for this addendum.

---

## Open Questions

1. **Visual effect chain hard limit:** 16 effects proposed. Is this too generous? The RT ping-pong cost is linear in chain length, but even 16 trivial shaders at cell resolution is under 1ms. Keep 16 unless testing reveals issues.

2. **Zoom/Pan/Rotation as chainable vs. built-in:** Currently spec'd as chainable (user can reorder relative to desaturation, TV sim, etc.). Alternative: make it a fixed-position built-in like bounce (always applied at a specific stage). Chainable gives more creative control but adds one RT pass. Recommendation: keep chainable.

3. **Ping-Pong crossfade implementation:** The crossfade requires the compositor to hold two decoded frames simultaneously for a cell during direction changes. This is fine for the frame cache (both frames are from the same source, adjacent in time) but adds a code path for dual-texture blending during those few frames. Worth the complexity? Recommendation: yes, the visual pop without it is noticeable.

4. **Serialization format for visual effect chain:** The `params[16]` flat float array is simple but fragile — adding a new parameter to an effect shifts indices. Alternative: named parameter map (`std::unordered_map<std::string, float>`). More robust for forward compatibility but heavier. Recommendation: use the flat array for the GPU constant buffer but serialize to JSON with named keys in the project file. Map from names to indices at load time.

5. **Slide note bezier curve shape:** The `PatternNote::slideCurveCx/Cy` fields exist but are unused in this spec. Future possibility: use the slide's bezier curve to shape the animation easing, so the user's drawn curve in the piano roll directly controls the zoom/bounce trajectory. Defer to post-implementation.

---

## Resolved Decisions

| Decision | Resolution |
|----------|------------|
| Effect chain architecture | Per-cell RT ping-pong (two RTs, alternating source/dest per effect pass) |
| Chainable effects | Desaturation, Tint, Brightness & Contrast, TV Simulator, Zoom/Pan/Rotation |
| Non-chainable effects | Gap Scale, Bounce, Corner Radius, Opacity, Ping-Pong |
| Animation state | Per-track `CellAnimation` struct, advanced each frame by `deltaMs` |
| Slide note visual behavior | Triggers animation on active cell (Zoom, Bounce, or TV ramp); pattern tracks only |
| Slide note duration | User choice: follow slide note length OR fixed duration |
| Per-corner radius control | Rejected — single continuous slider per track |
| Gap scale per-track override | Checkbox + slider, defaults to global |
| Ping-pong loop region | User-configurable start/end percentages with visual crossfader UI |
| Preview performance | Resolution scale + effects bypass toggle + existing FPS control |
| Global uniforms | New `cbuffer GlobalConstants : register(b1)` with time, resolution |
| Corner radius SDF | Anti-aliased `smoothstep(-1.0, 0.5, dist)` in main compositing shader |
| TV Simulator time source | `frameIndex / fps`, deterministic in both preview and offline render |
