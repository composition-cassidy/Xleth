# Phase E.3 — Realtime Preview Companion Visual FX (OpenGL) — Diagnostic & Implementation Plan

Branch: `feature/clip-modulation-fx-integration`
Status: **diagnostic only — no production code changed**
Scope: how to bring Vibrato Swirl + Scratch Wave/Smear into the realtime OpenGL `VideoCompositor` so the preview matches what the D3D11 export pipeline already produces (Phase E.2 / E.2.1).

---

## 1. Executive summary

- **Realtime preview is feasible.** All upstream ingredients already exist:
  - `VideoEvent` already carries `modulation` and the clip metadata needed to evaluate timing (Phase E.1).
  - `xleth::clipmod::evaluateVideoClipModulationTiming(...)` is already called inside [`SyncManager::videoTick`](engine/src/SyncManager.cpp:158) — its `vibratoLfo / scratchPhase01 / scratchIntensity01` outputs are presently discarded in preview but available for free.
  - `ClipCompanionFxSnapshot` already exists in [`FrameCollector.h:53`](engine/src/render/FrameCollector.h:53) as a plain-value snapshot we can reuse verbatim in the preview path.
  - The export reference shaders ([FX_VibratoSwirl.hlsl](engine/src/render/shaders/FX_VibratoSwirl.hlsl), [FX_ScratchWaveSmear.hlsl](engine/src/render/shaders/FX_ScratchWaveSmear.hlsl)) are short, self-contained UV‑remap fragment kernels that translate to GLSL almost line‑for‑line.
- **Gap.** [`VideoCompositor`](engine/src/VideoCompositor.cpp) currently has only a single direct YUV→RGB composite path (`kCompositeFragmentSrc`) with no FBO/RT plumbing, no per‑layer offscreen pass, and no awareness of `ClipModulation`. There is no surface in `setLayer` for companion FX state today.
- **Recommended strategy: Option C — single combined GLSL fragment shader** that does YUV→RGB *and* applies Swirl-then-Wave/Smear in one pass, gated by a `bool` uniform per effect. No FBOs, no extra texture, no draw‑call multiplication. This matches the math of the export shaders (one Swirl UV remap + one Wave/Smear UV remap) without needing ping‑pong, and the visual difference vs. true two‑pass for these specific kernels is negligible because both are pure UV displacements (each samples `inputTexture` once at a derived UV).
- **Performance risk: low.** Adds ~20 ALU ops + 0–2 extra texture taps (Smear) per pixel of each visible layer, only when at least one effect is active for that layer.
- **No blockers.** Phase E.1 timing values, `VideoCompanion` settings, and `VideoLayer` plumbing are all already in place; the only structural change is extending `VideoLayer` with a `ClipCompanionFxSnapshot` and rewriting the composite fragment shader.

---

## 2. Current realtime preview call flow

The preview path is single‑threaded (video thread) and stateless w.r.t. modulation:

```
Transport tick (audio thread updates position)
        │
        ▼
SyncManager::videoTick()  [video thread, ~60 Hz]
        │  for each VideoEvent active at audioTimeBeat:
        │    - sourceFps = decoder.getFPS()
        │    - timingCtx = makeVideoTimingContext(event, …)
        │    - timing    = evaluateVideoClipModulationTiming(modulation, ctx, compatible)
        │    - sourceTime = timing.sourceTimeSeconds          ← E.1: timing follow USED
        │    - (timing.vibratoLfo / scratchPhase01 / …)       ← E.1 outputs DISCARDED
        │    - decoder.seekAndDecode → CachedFrame
        │    - VideoCompositor::uploadFrameToSet(...)
        │    - VideoLayer layer = { x, y, width, height, opacity, zOrder, visible, sourceTextureSet };
        │      VideoCompositor::setLayer(layerIndex, layer);
        ▼
VideoCompositor::renderComposite()
        ▪ glClear → enable alpha blend
        ▪ sort layers by zOrder
        ▪ for each visible layer:
              glUseProgram(compositeShaderProgram_);
              uPosition / uScale / uOpacity uniforms;
              bind YUV tex set; glDrawArrays(GL_TRIANGLES, 0, 6);
        ▪ glfwSwapBuffers
```

Key file references:
- [`SyncManager::videoTick`](engine/src/SyncManager.cpp:109) — already calls `evaluateVideoClipModulationTiming`. The `timing` result is currently consumed only for `sourceTimeSeconds`; the Vibrato/Scratch FX‑side fields are computed and dropped.
- `VideoEvent` ([`SyncManager.h:16`](engine/src/SyncManager.h:16)) already carries `hasClipModulation`, `modulation`, `clipReversed`, `clipStretchRatio`, `clipFormantPreserve`, `clipPitchOffsetSemis/Cents`, `clipStartTimelineSamples` — i.e. everything the E.1 evaluator needs.
- The compatibility predicate `isVideoModulationCompatible` (`SyncManager.cpp:21`) is identical in spirit to the export path (FrameCollector.cpp): only emit FX when modulation is enabled, not reversed, stretch=1.0, no formant preserve.
- `VideoLayer` is the only struct that crosses from `SyncManager` into `VideoCompositor::setLayer`. It currently has **no companion‑FX field** — that is the single piece of plumbing that must change in E.3.

There is no preview equivalent of `FrameCollector::makeCompanionFxSnapshot` today; SyncManager will gain a sibling helper.

---

## 3. Current `VideoCompositor` shader / FBO architecture

From [`VideoCompositor.cpp`](engine/src/VideoCompositor.cpp):

- **Shaders are inline C++ string literals** (`kVertexShaderSrc`, `kFragmentShaderSrc`, `kCompositeVertexSrc`, `kCompositeFragmentSrc`). No external `.glsl` files, no shader cache, no resource generation step. New shaders are added by adding another `R"glsl(…)glsl"` literal and a `linkProgram(...)` call.
- **GL profile**: 3.3 core (`GLFW_CONTEXT_VERSION_MAJOR=3, MINOR=3, CORE_PROFILE`) — supports everything we need (FBOs, GL_TEXTURE_2D, `texture()` sampler).
- **Compositor state** is limited to:
  - one fullscreen quad VAO/VBO (`kQuadVertices`),
  - per‑source `TextureSet` (Y/U/V `R8` textures),
  - one PBO double‑buffer for upload,
  - two shader programs (`shaderProgram_` legacy single layer; `compositeShaderProgram_` multi‑layer).
- **No FBO / ping‑pong / offscreen RT** exists today. `renderComposite()` always renders directly to the default framebuffer (the GLFW window).
- **Per‑layer draw is one fullscreen‑quad draw with translation/scale uniforms** (`uPosition`, `uScale`) — the same shader is reused for every layer. There is currently no per‑clip / per‑event uniform path.
- **Texcoord convention** ([`kQuadVertices`](engine/src/VideoCompositor.cpp:76)): V is flipped at quad construction so video top‑left maps to bottom‑left of GL clip space; in the fragment shader `TexCoord = (0,0)` = video top‑left, `(1,1)` = video bottom‑right. **This matches HLSL's convention** for `uv.x` left→right and `uv.y` top→bottom, so the export shader math (Swirl rotation direction, Wave's `sin(uv.y * freq …)`) maps to GLSL with **no sign flip** — see §6 for the proof.

Implication: the smallest safe preview implementation is a **shader rewrite of `kCompositeFragmentSrc`** plus **new uniforms in `VideoLayer`** — *not* an FBO refactor.

---

## 4. Recommended snapshot / data path

### 4.1 Reuse `ClipCompanionFxSnapshot` directly

Do **not** invent a parallel preview struct. The plain‑value `ClipCompanionFxSnapshot` from [`FrameCollector.h:53`](engine/src/render/FrameCollector.h:53) is already exactly the data the export shaders consume; reuse it verbatim. This guarantees timing→shader values stay in lockstep between preview and export.

### 4.2 Extend `VideoLayer`

Add one field:

```cpp
// engine/src/VideoLayer.h (planned)
#include "render/FrameCollector.h"   // for ClipCompanionFxSnapshot

struct VideoLayer {
    // existing fields …
    ClipCompanionFxSnapshot companionFx;   // default-constructed = no FX
};
```

`ClipCompanionFxSnapshot` is plain‑POD‑ish (bools + floats), so this remains a value type — no pointers to `Clip` objects, satisfying the "do not store pointers to mutable Clip objects" constraint.

> Note on header coupling: `FrameCollector.h` already ships in the engine's public set; pulling its snapshot type into `VideoLayer.h` is acceptable. If the `#include` is undesirable for compile‑time reasons, a forward‑compatible alternative is to **mirror** the same fields inside a `VideoLayer::CompanionFx` POD, with a one‑line in‑header copy assignment. Either works; the first is simpler.

### 4.3 Fill the snapshot inside `SyncManager::videoTick`

`SyncManager.cpp` already computes `timing` per active event. Add the same helper that `FrameCollector.cpp:64` uses, kept local to `SyncManager.cpp`:

```cpp
// engine/src/SyncManager.cpp (planned)
ClipCompanionFxSnapshot makePreviewCompanionFxSnapshot(
    const VideoEvent& event,
    const xleth::clipmod::VideoModulationTimingResult& timing) noexcept
{
    ClipCompanionFxSnapshot out;
    if (!timing.timingActive) return out;
    const auto& v = event.modulation.video;

    if (v.vibratoSwirlEnabled && timing.vibratoActive) {
        out.vibratoSwirlEnabled = true;
        out.vibratoLfo     = timing.vibratoLfo;
        out.vibratoPhase01 = timing.vibratoPhase01;
        out.vibratoCents   = timing.vibratoCents;
        out.swirlAmount    = v.swirlAmount;
        out.swirlRadius    = v.swirlRadius;
        out.swirlCenterX   = v.swirlCenterX;
        out.swirlCenterY   = v.swirlCenterY;
    }
    if (v.scratchWaveEnabled && timing.scratchActive) {
        out.scratchWaveEnabled      = true;
        out.scratchRateMultiplier   = timing.scratchRateMultiplier;
        out.scratchPhase01          = timing.scratchPhase01;
        out.scratchIntensity01      = timing.scratchIntensity01;
        out.waveAmount              = v.waveAmount;
        out.waveFrequency           = v.waveFrequency;
        out.smearAmount             = v.smearAmount;
        out.reverseWaveWithScratch  = v.reverseWaveWithScratch;
    }
    return out;
}
```

This is a **byte‑for‑byte clone of [`FrameCollector.cpp:64`](engine/src/render/FrameCollector.cpp:64)**. Long term it should be lifted into a shared helper (e.g. `engine/src/model/ClipCompanionFxBuilder.h`) so preview and export cannot diverge — recommend doing this consolidation as part of E.3 to avoid two truths.

The build site is the existing layer construction in [`SyncManager.cpp:287–297`](engine/src/SyncManager.cpp:287):

```cpp
VideoLayer layer = {};
layer.sourceTextureSet = event.sourceId;
layer.x = event.x; layer.y = event.y;
layer.width = event.width; layer.height = event.height;
layer.opacity = event.opacity;
layer.zOrder  = event.layerIndex;
layer.visible = true;
layer.companionFx = makePreviewCompanionFxSnapshot(event, timing);  // ← new
compositor_->setLayer(event.layerIndex, layer);
```

The "frame already displayed on this layer" early‑out branch ([`SyncManager.cpp:204`](engine/src/SyncManager.cpp:204)) must do the same assignment, otherwise FX freezes when the source frame is repeated (which is common — events run at audio rate, source plays at video FPS).

### 4.4 No bridge / API / schema changes

`ClipModulation` already round‑trips through the bridge. `VideoCompositor` lives entirely on the engine side and is not exposed to JS. E.3 is engine‑internal only.

---

## 5. Recommended OpenGL implementation strategy

### 5.1 Options recap

| Option | Description | Verdict |
|---|---|---|
| **A — fold into existing per-layer composite shader** | Add Swirl + Wave/Smear math to `kCompositeFragmentSrc`. | ✅ **Recommended** (this is essentially Option C; the existing per‑layer shader IS the composite shader). |
| **B — offscreen FBO ping‑pong** | Match the D3D11 path: render layer → RT_A → Swirl → RT_B → Wave → final composite. | Defer. Adds FBO management, RTPool equivalent, framebuffer completeness checks, and viewport bookkeeping for what is mathematically a single‑sample UV remap. Reserve for if a future effect actually needs accumulation between passes. |
| **C — combined single‑pass shader (Swirl→Wave→Smear→YUV→RGB)** | One FS that computes `swirledUV → wavedUV → sample`, with Smear adding two extra taps. | ✅ **Recommended.** Functionally identical to A. |
| **D — defer entirely; export only** | Hide preview; ship UI later. | ❌ Reject. The user already authored Phase E.1/E.2; preview parity is the visible win for E.3. |

### 5.2 Recommended: combined shader (Option A/C)

Keep the existing two shader programs (`shaderProgram_` legacy + `compositeShaderProgram_` multi‑layer) and replace `kCompositeFragmentSrc` with a single‑pass version that:

1. Optionally computes a swirled UV (driven by `uSwirlEnabled` + uniforms),
2. Optionally computes a wave/smear UV displacement (driven by `uWaveEnabled` + uniforms),
3. Samples Y/U/V at the final UV (and twice more for Smear),
4. Performs YUV→RGB exactly as today,
5. Multiplies by `uOpacity`.

Because both Swirl and Wave/Smear are **pure UV remaps that sample the source once each (Smear is two extra taps blended)** there is zero benefit to ping‑pong — the math composes cleanly: `finalUV = wave(swirl(uv))`, identical pixel values to the two‑pass version up to floating‑point rounding.

The fast path (`uSwirlEnabled = false && uWaveEnabled = false`) is one branch that skips both UV transforms entirely → preserves the **Phase 0 perf floor** for projects with no clip modulation.

Sketch (illustrative, not final code):

```glsl
#version 330 core
in vec2 TexCoord;
out vec4 FragColor;

uniform sampler2D yTex, uTex, vTex;
uniform float uOpacity;

uniform bool  uSwirlEnabled;
uniform float uSwirlAmount, uSwirlRadius, uSwirlCenterX, uSwirlCenterY;
uniform float uSwirlLfo;

uniform bool  uWaveEnabled;
uniform float uWaveAmount, uWaveFrequency, uWaveSmearAmount;
uniform float uWaveRateMultiplier, uWavePhase01, uWaveIntensity01;
uniform bool  uReverseWaveWithScratch;

vec3 yuvToRgb(vec2 uv) {
    float y = texture(yTex, uv).r;
    float u = texture(uTex, uv).r - 0.5;
    float v = texture(vTex, uv).r - 0.5;
    return clamp(vec3(
        y + 1.5748 * v,
        y - 0.1873 * u - 0.4681 * v,
        y + 1.8556 * u), 0.0, 1.0);
}

void main() {
    vec2 uv = TexCoord;

    if (uSwirlEnabled) {
        vec2 c    = vec2(uSwirlCenterX, uSwirlCenterY);
        vec2 d    = uv - c;
        float r   = length(d);
        float sr  = max(uSwirlRadius, 0.0001);
        float f   = clamp(1.0 - r / sr, 0.0, 1.0);
        f = f * f * (3.0 - 2.0 * f);
        float a = clamp(uSwirlAmount * 3.0 * uSwirlLfo * f, -1.25, 1.25);
        float s = sin(a), co = cos(a);
        uv = clamp(vec2(d.x * co - d.y * s, d.x * s + d.y * co) + c, 0.0, 1.0);
    }

    vec3 rgb;
    if (uWaveEnabled) {
        float dir = (uReverseWaveWithScratch && uWaveRateMultiplier < 0.0) ? -1.0 : 1.0;
        float intensity = clamp(uWaveIntensity01, 0.0, 1.0);
        float phase     = uWavePhase01 * 6.28318531;
        float freq      = clamp(uWaveFrequency, 0.25, 64.0);
        float wave      = sin(uv.y * freq * 6.28318531 + phase);
        float offset    = clamp(wave * uWaveAmount * 1.5 * intensity * dir, -0.35, 0.35);
        vec2 wavedUV    = clamp(vec2(uv.x + offset, uv.y), 0.0, 1.0);

        rgb = yuvToRgb(wavedUV);

        float smear = clamp(abs(uWaveSmearAmount), 0.0, 1.0) * intensity;
        if (smear > 0.0001) {
            float so = clamp(uWaveSmearAmount * 0.25 * dir * intensity, -0.25, 0.25);
            vec3 a = yuvToRgb(clamp(vec2(wavedUV.x - so, wavedUV.y), 0.0, 1.0));
            vec3 b = yuvToRgb(clamp(vec2(wavedUV.x + so, wavedUV.y), 0.0, 1.0));
            rgb = mix(rgb, 0.5 * (a + b), smear);
        }
    } else {
        rgb = yuvToRgb(uv);
    }

    FragColor = vec4(rgb, uOpacity);
}
```

`renderComposite()` gains a `glUniform*` block per layer to push `layer.companionFx` into these uniforms, gated by `vibratoSwirlEnabled / scratchWaveEnabled`. When both flags are false it sets the two `bool` enables to false — the GPU still runs the shader, but takes the fast `else { rgb = yuvToRgb(uv); }` branch. (Modern GLSL compilers will scalarize the per‑draw `if` since the bool is a uniform.)

### 5.3 If Option B is ever needed later

If a future effect needs true accumulation/feedback (e.g. motion trails), plan B is straightforward:

1. Add `GLuint fboA_, fboB_; GLuint texA_, texB_;` to `VideoCompositor`, sized to a single shared "preview RT" (window resolution suffices).
2. Wrap `renderComposite()` so each layer is drawn into the FBO, runs N effect passes, and is then drawn into the default framebuffer with `glBlendFunc(GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA)`.

Not recommended for E.3.

---

## 6. GLSL ↔ HLSL parity for export mappings

| Aspect | HLSL (export) | GLSL (proposed preview) | Polarity |
|---|---|---|---|
| `uv.x` direction | 0=left, 1=right | 0=left, 1=right (vertices have `(0,_)` at left) | match |
| `uv.y` direction | 0=top, 1=bottom (D3D texcoord) | 0=top, 1=bottom (V is **pre‑flipped** in `kQuadVertices`) | match |
| Swirl rotation matrix | `(c, -s; s, c)` applied to `delta` | identical | match |
| `clamp(angle, ‑1.25, 1.25)` | yes | yes | match |
| Signed `swirlAmount` | yes (negative inverts direction) | yes | match |
| Signed `vibratoLfo` | yes (sign flips through directly) | yes | match |
| Smoothstep falloff `f*f*(3-2f)` | yes | yes | match |
| Wave `sin(uv.y * freq * 2π + phase)` | yes | yes | match |
| Frequency clamp `[0.25, 64]` | yes | yes | match |
| Final wave displacement clamp `[-0.35, 0.35]` | yes | yes | match |
| Reverse direction when `reverseWithScratch && rateMultiplier < 0` | yes | yes | match |
| Smear taps `(uv ± smearOffset, uv.y)` | yes | yes | match |
| Smear offset clamp `[-0.25, 0.25]` | yes | yes | match |
| Final mix with `lerp(color, smearColor, smear)` | yes | `mix(...)` | match |

**Bottom line: no coordinate flips, no sign inversions.** The GLSL shader can be a straight port of the two HLSL kernels chained at the UV level. Polarity (positive `swirlAmount` = same visual rotation, negative `waveAmount` = same horizontal direction reversal) **must visually match the export path** so the user gets identical preview/export behavior; the table above shows it does.

The one subtle sampler difference (linear filtering, `CLAMP_TO_EDGE`) already matches: GL textures are created with `GL_LINEAR / GL_CLAMP_TO_EDGE` ([`makeYuvTexture`](engine/src/VideoCompositor.cpp:104)), HLSL uses `linearSampler` with default clamp. The explicit `clamp(uv, 0.0, 1.0)` in both shaders makes the clamp behavior identical even if drivers differ.

---

## 7. Effect order

**Export order** (per `processCompanionFx` in [`GridCompositor.cpp:1485`](engine/src/render/GridCompositor.cpp:1485)):
```
cell SRV → blit to RT_A → Vibrato Swirl pass → Scratch Wave/Smear pass → drawCell (final composite)
```

**Recommended preview order** (combined shader, Option C):
```
YUV layer texture → swirl(UV) → waved(UV after swirl) → YUV→RGB → opacity → composite
```

Mathematically equivalent to "Swirl then Wave/Smear then final draw" because Wave/Smear's `wavedUV = swirledUV + offset(uv.y)` correctly chains the two UV remaps. **Do not** swap the order: putting Wave first would mean the wave's vertical sinusoid is read out of an already‑rotated coordinate, which the export shader does not do.

There is no preview equivalent of `TrackInfo::visualEffectChain` to slot in front; the constraint "do not attach companion FX to `TrackInfo::visualEffectChain`" is naturally satisfied — the snapshot is per‑clip, applied in the layer composite shader only.

---

## 8. Performance risks and mitigations

### 8.1 Per‑frame cost estimate

For a typical preview at 1280×720 (≈ 1M pixels) per visible layer, the worst case (both effects on, smear active) adds:

- 1× Swirl ALU branch: ~25 FLOPs (length/normalize/sincos/mat2)
- 1× Wave ALU branch: ~10 FLOPs
- 0 extra texture taps for Swirl (it remaps the same UV)
- 0 extra taps for Wave (single tap at displaced UV — *replaces* the regular tap, doesn't add)
- 2 extra YUV triple‑taps for Smear (= 6 extra `texture()` calls when smear active)

Best case (effects off): **0 extra ALU, 0 extra texture taps** — a single uniform branch elides the work. On any modern GPU this is well below 1 ms / layer at preview resolution.

### 8.2 Risk surfaces

| Risk | Mitigation |
|---|---|
| Branch divergence on uniform `if` | Uniforms; modern compilers fold this. Fast path is identical to today. |
| Extra cost when smear active | Cap smear to only run when both `scratchWaveEnabled && smear > 0.0001`. Already in shader. |
| DNxHR seek perf regression | E.3 changes only the GPU shader; decode path is untouched. |
| A/V drift | `videoTick`'s drift accounting is unchanged. The composite shader runs on the GL thread same as today. |
| Tiny / hidden layers | Existing `if (!layer.visible) continue;` and `if (layer.opacity == 0)` short‑circuits cover this. |
| Many simultaneous active clips | Each visible layer is one fullscreen quad draw; cost scales linearly with visible layer count, same as today. |
| OpenGL driver shader compile time | One additional shader program, compiled once at `initialize()`. No runtime hitch. |

### 8.3 Skip rules (recommended)

In `renderComposite`, before binding the FX uniforms:

```cpp
const bool effectsActive = layer.companionFx.vibratoSwirlEnabled
                        || layer.companionFx.scratchWaveEnabled;
glUniform1i(uSwirlEnabled, layer.companionFx.vibratoSwirlEnabled);
glUniform1i(uWaveEnabled,  layer.companionFx.scratchWaveEnabled);
// (the fast path is automatic in the shader — both uniforms false → identity)
```

No need to switch shader programs — the same program serves both fast and slow paths.

---

## 9. Files likely to change in E.3 implementation

| File | Change |
|---|---|
| `engine/src/VideoLayer.h` | Add `ClipCompanionFxSnapshot companionFx` field. |
| `engine/src/VideoCompositor.cpp` | Replace `kCompositeFragmentSrc` with combined shader. Add new uniform locations (`uSwirlEnabled`, `uSwirlAmount`, …, `uWaveEnabled`, …). Push uniforms in `renderComposite()` per layer. |
| `engine/src/VideoCompositor.h` | (Maybe) cache uniform locations to avoid `glGetUniformLocation` per draw. |
| `engine/src/SyncManager.cpp` | Add `makePreviewCompanionFxSnapshot(...)` (or call the to‑be‑shared helper). Populate `layer.companionFx` at the two layer‑build sites (cache hit branch ~L208 and full‑build branch ~L287). |
| **(recommended refactor)** `engine/src/model/ClipCompanionFxBuilder.{h,cpp}` | Lift the `makeCompanionFxSnapshot` helper out of `FrameCollector.cpp` so preview and export share one truth. |
| `engine/test/test_compositor.cpp` | Extend with a preview‑side polarity test: build a `VideoLayer` with positive vs negative `swirlAmount`/`waveAmount` and assert pixel direction. (Headless GL context required; see test plan.) |
| `engine/CMakeLists.txt` | No new sources unless the shared helper is added. `VideoCompositor.cpp` is already `XlethEngine`‑only via `XLETH_CORE_ONLY`. |

**Untouched**: `GridCompositor.*`, `FrameCollector.*` (apart from the optional shared helper extraction), HLSL shaders, bridge code, UI, schema.

---

## 10. Test plan

### 10.1 Automated (engine tests)

Build on `test_compositor.cpp`'s existing pattern. Add tests under a `// Preview path` section:

1. **Identity when disabled.** Construct a layer with `companionFx = {}` (default). Assert preview render output bit‑equals the current preview shader's output for the same input frame. (Renders to default FBO via offscreen GL context; hash compare.)
2. **Swirl polarity matches export.** Build identical `ClipCompanionFxSnapshot` for preview and export; render the same source frame through both; assert that center‑of‑mass shift direction matches between paths for `swirlAmount > 0` and `swirlAmount < 0`.
3. **Wave polarity matches export.** Same as (2) for `waveAmount > 0` vs `< 0`.
4. **Reverse with scratch.** With `reverseWaveWithScratch = true` and `scratchRateMultiplier < 0`, the displacement direction must flip — preview and export must agree.
5. **Negative `vibratoLfo`.** With positive `swirlAmount`, a negative `vibratoLfo` flips rotation direction (matches export's `clamp(amount * 3 * lfo * falloff, -1.25, 1.25)`).
6. **`amount = 0` is identity.** Both Swirl and Wave with zero amount must produce output equal to the no‑FX path within a 1‑LSB tolerance.
7. **E.1 timing follow regression.** Run an existing E.1 timing test through `videoTick`; assert `sourceTime` consumption and frame output unchanged.
8. **E.2 / E.2.1 export tests still pass.** Re‑run `test_frame_collector` and `test_compositor` companion‑FX assertions — should be untouched since GridCompositor is not modified.

A practical implementation note: `VideoCompositor::initialize` opens a real GLFW window. For CI, either:
- create an invisible window via `glfwWindowHint(GLFW_VISIBLE, GLFW_FALSE)` (already a one‑line addition for E.3), or
- gate the new tests behind `XLETH_HAS_GL` so headless CI machines without GL skip them.

### 10.2 Manual checks

- Toggle `vibratoSwirlEnabled` in a clip while playing → preview shows swirl pulsing at LFO rate; export of the same project shows visually matching swirl.
- Side‑by‑side preview vs exported MP4 of a 2‑bar pattern: positive `swirlAmount` should rotate the same direction in both.
- Set `swirlAmount = 0` and `waveAmount = 0` while keeping `vibratoSwirlEnabled = true` → preview must look like no‑FX (identity).
- Set wave amount to 0.2, scratch rate negative, `reverseWaveWithScratch = true` → wave must travel in the opposite vertical direction compared to positive scratch.
- Confirm Phase 0 perf: scrub through a busy project with 8 visible layers and no clip modulation — frame time and drift must not regress vs. main.

---

## 11. Risks and non‑goals

### 11.1 Risks

- **Two truths for snapshot construction.** If `FrameCollector::makeCompanionFxSnapshot` is duplicated into `SyncManager` instead of shared, future evaluator changes will silently desync preview from export. **Mitigation:** lift to a shared helper as part of E.3.
- **Branch‑divergence cost on old GPUs.** Negligible on anything ≥ Intel HD 5000 / GTX 9xx, but if a target needs to be safer the shader can be split into two programs (`composite` and `compositeWithFx`) and selected per layer. Defer unless profiling shows a problem.
- **Stuck FX state on cache‑hit early‑out.** If the "frame already displayed" branch is left as‑is and only the full‑build branch sets `companionFx`, the FX values freeze whenever the source frame doesn't advance. This is the single highest‑value test to write first.
- **Thread‑safety of `VideoLayer`.** `setLayer` is called from the video thread, and `renderComposite` reads `layers_` from the same thread; no new race introduced. Confirm all existing call sites stay on the video thread (they do per `SyncManager::videoTick`).
- **Sampler clamp behaviour for swirl outside `[0,1]`.** Both shaders clamp UV explicitly, so out‑of‑bounds swirl rotation degenerates to edge color rather than wrap — matching export.
- **PBO upload contention.** Unchanged; the FX path runs entirely in the fragment shader using already‑uploaded YUV planes.

### 11.2 Non‑goals (explicitly out of scope for E.3)

- No UI controls. (Phase E.4 candidate after preview parity lands.)
- No bridge / Node API surface for companion FX.
- No schema changes — `ClipModulation::VideoCompanion` already serializes from Phase E.0/E.1.
- No changes to FrameCollector / GridCompositor / export pipeline.
- No new audio DSP. Vibrato/Scratch presets unchanged.
- No FFmpeg path involvement.
- No coupling to `TrackInfo::visualEffectChain`.
- No new branch / worktree.

### 11.3 UI implication

UI for `ClipModulation::VideoCompanion` should remain hidden (or behind a debug flag) **until E.3 lands**, so users do not author preview‑invisible effects. Once E.3 is merged, E.4 can expose the controls — by that point preview and export are visually identical.

---

## 12. Confirmation: no production code changed

This pass produced exactly one new file:

- `docs/plans/phase-e3-realtime-preview-companion-fx-diagnostic.md` (this document).

No engine source, header, shader, bridge, UI, schema, or test file was modified. No new branch, worktree, or build target was created. `git status` after this pass shows the same modified/untracked set as before, plus this single new doc.

---

### Appendix A — references

- [`engine/src/SyncManager.cpp:109`](engine/src/SyncManager.cpp:109) — `videoTick` (preview event loop).
- [`engine/src/SyncManager.cpp:158`](engine/src/SyncManager.cpp:158) — `evaluateVideoClipModulationTiming` call site (E.1 — output partially used).
- [`engine/src/SyncManager.h:16`](engine/src/SyncManager.h:16) — `VideoEvent` struct.
- [`engine/src/VideoCompositor.cpp:55`](engine/src/VideoCompositor.cpp:55) — `kCompositeFragmentSrc` (the shader to replace).
- [`engine/src/VideoCompositor.cpp:717`](engine/src/VideoCompositor.cpp:717) — `renderComposite()` (uniform push site).
- [`engine/src/render/FrameCollector.h:53`](engine/src/render/FrameCollector.h:53) — `ClipCompanionFxSnapshot` (reused).
- [`engine/src/render/FrameCollector.cpp:64`](engine/src/render/FrameCollector.cpp:64) — `makeCompanionFxSnapshot` (the helper to lift / mirror).
- [`engine/src/render/GridCompositor.cpp:1485`](engine/src/render/GridCompositor.cpp:1485) — `processCompanionFx` (export reference).
- [`engine/src/render/shaders/FX_VibratoSwirl.hlsl`](engine/src/render/shaders/FX_VibratoSwirl.hlsl) — Swirl reference.
- [`engine/src/render/shaders/FX_ScratchWaveSmear.hlsl`](engine/src/render/shaders/FX_ScratchWaveSmear.hlsl) — Wave/Smear reference.
- [`engine/src/model/TimelineTypes.h:303`](engine/src/model/TimelineTypes.h:303) — `ClipModulation::VideoCompanion` settings.
- [`engine/src/model/ClipVideoModulationTiming.h`](engine/src/model/ClipVideoModulationTiming.h) — timing evaluator (Phase B).
