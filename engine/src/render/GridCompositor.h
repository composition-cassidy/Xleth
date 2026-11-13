#pragma once

/**
 * GridCompositor — D3D11 GPU compositor for the render pipeline.
 *
 * Assembles decoded video frames (D3D11 textures from RenderFrameCache)
 * into a final output frame using the grid layout.
 *
 * Compositing order per output frame:
 *   1. Clear render target to black
 *   2. Draw every request in the order handed in — grid cells AND fullscreen
 *      layers interleaved. FrameCollector has already performed the single
 *      global stable_sort by zOrder, so a fullscreen layer whose zOrder sits
 *      between two grid cells' zOrders is drawn (and thus occludes/reveals)
 *      between them. There is no separate behind/grid/front banding; request
 *      order IS draw order.
 *
 * Each layer is drawn as a fullscreen quad with a pixel shader that clips
 * to the cell rectangle, applies flip mode, and modulates opacity.
 *
 * Resources (shaders, vertex buffer, blend state, etc.) are created once
 * during init() and reused every frame.
 *
 * GPU→CPU readback via staging texture for offline export.
 */

#include <chrono>
#include <cstdint>
#include <string>
#include <unordered_map>
#include <vector>

#include "GpuDeviceManager.h"   // NOMINMAX, d3d11_4.h, ComPtr
#include "FrameCache.h"         // RenderFrameCache, FrameCacheKey, FrameCacheEntry
#include "FrameCollector.h"     // CellFrameRequest

struct VisualEffect;

// ---------------------------------------------------------------------------
// CellConstants — matches cbuffer CellConstants in GridComposite.hlsl
//
// Phase 4: legacy flipMode / globalNoteIndex are gone from both the HLSL cbuffer
// and this struct. Per-cell flip state is now resolved at event-build time and
// flows through `orientation` only (0..5 — see Orientation enum / spec §5.3).
//
// Lens + Roam (P2): `xformFlags` plus four float4 rows carry the two optional
// affine maps computed by render/LensRoamMath.h. A zero-initialised
// CellConstants (every existing `CellConstants cb{}` site) has xformFlags = 0,
// which runs the shader's original arithmetic unchanged.
// Layout matches the HLSL cbuffer exactly: 6 x float4 = 96 bytes.
// ---------------------------------------------------------------------------
struct alignas(16) CellConstants {
    float cellRect[4];      // x, y, width, height in UV [0,1]
    float opacity;
    int   orientation;      // 0=none, 1=h, 2=v, 3=rot180, 4=rot90cw, 5=rot90ccw
    float cornerRadius;
    int   xformFlags;       // kXformLens | kXformRoam (0 = today's path)
    float lensRow0[4];      // localUV -> source UV, row 0 (m00, m01, tx, 0)
    float lensRow1[4];      //                       row 1 (m10, m11, ty, 0)
    float roamRow0[4];      // output UV -> localUV, row 0 (r00, r01, r02, 0)
    float roamRow1[4];      //                        row 1 (r10, r11, r12, 0)
};
static_assert(sizeof(CellConstants) == 96, "CellConstants must be 96 bytes (6 x float4)");
static constexpr int kXformLens = 1;
static constexpr int kXformRoam = 2;

// How the final draws of ONE request (echo taps, drop shadow, the cell) are
// placed beyond their rect: the orientation to draw with (the track's flip,
// or a Lens flip override), a Roam rotation about each drawn rect's own
// centre, and the Bounds Clip scissor to the home cell. Default-constructed
// = today's draw. Passed explicitly, never stored on the compositor, so the
// intermediate blits those stages make (echo lerp, shadow silhouette) can
// never pick it up.
struct CellDrawXform {
    int        orientation = 0;
    float      rotationRad = 0.0f;   // Roam rotation, clockwise on screen
    bool       scissor     = false;  // Bounds Clip: clip to scissorRect
    D3D11_RECT scissorRect{};        // home cell, output pixels
};

// ---------------------------------------------------------------------------
// GlobalConstants — per-frame global data, bound to cbuffer register(b1)
// ---------------------------------------------------------------------------
struct alignas(16) GlobalConstants {
    float time;          // seconds since playback start
    float outputWidth;   // render target width in pixels
    float outputHeight;  // render target height in pixels
    float padding;
};
static_assert(sizeof(GlobalConstants) == 16, "GlobalConstants must be 16 bytes (1 x float4)");

// ---------------------------------------------------------------------------
// TransitionConstants — whole-frame snapshot transition parameters at b2
// ---------------------------------------------------------------------------
struct alignas(16) TransitionConstants {
    int   mode;
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
    int   effectSeed;
    float pad0;
};
// [Safety audit: CB alignment] D3D11 constant buffers are 16-byte aligned.
static_assert(sizeof(TransitionConstants) == 64, "TransitionConstants must be 64 bytes");

struct alignas(16) VibratoSwirlConstants {
    float amount;
    float radius;
    float centerX;
    float centerY;
    float lfo;
    float phase01;
    float cents;
    float pad0;
};
static_assert(sizeof(VibratoSwirlConstants) == 32, "VibratoSwirlConstants must be 32 bytes");

struct alignas(16) ScratchWaveSmearConstants {
    float amount;
    float frequency;
    float smearAmount;
    float reverseWithScratch;
    float rateMultiplier;
    float phase01;
    float intensity01;
    float pad0;
};
static_assert(sizeof(ScratchWaveSmearConstants) == 32, "ScratchWaveSmearConstants must be 32 bytes");

// Constant buffers for the two terminal expansion stages. Unlike every other
// effect CB these are NOT a raw memcpy of VisualEffect::params[] — the CPU
// resolves the user's params into render-target geometry first (texel size, the
// content region's half-extents, distance+angle into a single UV offset), so the
// shaders can work in true target pixels. Field order must match the matching
// cbuffer in FX_Outline.hlsl / FX_DropShadow.hlsl exactly.
struct alignas(16) OutlineConstants {
    float color[3];         // stroke colour 0..1
    float thicknessPx;      // stroke width, in target texels
    float softness;         // 0..1 fraction of the thickness feathered
    float opacity;          // 0..1
    float alphaThreshold;   // alpha at or below this is background
    float cornerRadiusPx;   // the cell's corner radius in texels; 0 = none
    float texelW, texelH;   // 1/paddedWidth, 1/paddedHeight
    float innerHalfW, innerHalfH;  // content half-extents, in texels
};
static_assert(sizeof(OutlineConstants) == 48, "OutlineConstants must be 48 bytes");

struct alignas(16) DropShadowConstants {
    float color[3];         // shadow colour 0..1
    float opacity;          // param opacity * the cell's own opacity
    float offsetU, offsetV; // distance+angle resolved to a UV offset
    float inflatePx;        // dilation radius, in target texels
    float blurPx;           // feather radius, in target texels
    float texelW, texelH;   // 1/paddedWidth, 1/paddedHeight
    float alphaThreshold;   // alpha at or below this casts no shadow
    float blendMode;        // 0=Normal 1=Multiply 2=Darken 3=LinearBurn
    float innerHalfW, innerHalfH;  // content half-extents, in texels
    float cornerRadiusPx;   // the cell's corner radius in texels; 0 = none
    float dropShadowPad0;
};
static_assert(sizeof(DropShadowConstants) == 64, "DropShadowConstants must be 64 bytes");

// ---------------------------------------------------------------------------
// RTPool — render target pairs for ping-pong effect chain processing
// ---------------------------------------------------------------------------
struct RTPool {
    struct RTPair {
        Microsoft::WRL::ComPtr<ID3D11Texture2D> texA, texB;
        Microsoft::WRL::ComPtr<ID3D11RenderTargetView> rtvA, rtvB;
        Microsoft::WRL::ComPtr<ID3D11ShaderResourceView> srvA, srvB;
        int width = 0, height = 0;
        std::chrono::steady_clock::time_point lastTouched = std::chrono::steady_clock::now();
    };

    // Key = (slot << 48) | (width << 32) | height — both dimensions masked to
    // 16 bits symmetrically. Real cell/canvas sizes never approach 65536, so
    // this only guards against a mask that looks trustworthy but isn't.
    std::unordered_map<uint64_t, RTPair> pairs;

    /** Get or create an RT pair for the given dimensions and slot.
     *  Different slots with the same dimensions return DIFFERENT pairs
     *  to prevent SRV/RTV aliasing hazards. */
    RTPair& acquire(ID3D11Device* device, int width, int height, int slot = 0);

    /** Release all GPU resources. */
    void clear();

    /** Evict pairs untouched for at least idleSeconds. Same discipline as
     *  RenderVideoDecoder::pruneIdleContexts: a session that tries several
     *  grid sizes/effect combinations otherwise strands a texture pair per
     *  combination for the rest of the session. */
    void pruneIdle(double idleSeconds = 10.0);
};

// ---------------------------------------------------------------------------
// EchoRing — per-cell history of finished pixels for the Visual Echo effect.
//
// The one piece of FRAME-SPANNING state in the compositor. Everything else here
// is built and consumed inside a single compositeFrame call; this deliberately
// is not, because an echo is by definition made of frames already drawn.
//
// One ring per (trackId, cellCol, cellRow, layerKind) — see the ringKey comment
// in FrameCollector.cpp for why the cell, not just the track, is part of that.
//
// Storage is a plain circular array of cell-sized RGBA textures. It is real GPU
// memory (a 480x270 cell is ~518 KB a frame), which is why:
//   - only cells whose track actually has an active VisualEcho allocate one
//   - capacity is exactly EchoSettings::requiredRingFrames(), not a fixed max
//   - kMaxRingFrames caps it regardless (VisualEchoTypes.h)
//   - pruneIdleEchoRings frees rings whose cell stopped echoing
// ---------------------------------------------------------------------------
struct EchoRing {
    std::vector<Microsoft::WRL::ComPtr<ID3D11Texture2D>>          tex;
    std::vector<Microsoft::WRL::ComPtr<ID3D11RenderTargetView>>   rtv;
    std::vector<Microsoft::WRL::ComPtr<ID3D11ShaderResourceView>> srv;

    int width    = 0;
    int height   = 0;
    int capacity = 0;
    int writeIdx = 0;   // slot the NEXT push writes
    int count    = 0;   // buffered frames, saturating at capacity

    // Output-frame identity of the most recent push. Guards against a paused
    // preview, which re-composites the SAME frame repeatedly: without this the
    // ring would advance while the transport is stopped and the trail would
    // crawl backwards through history on a still image.
    double lastPushedTime = -1.0;

    std::chrono::steady_clock::time_point lastTouched = std::chrono::steady_clock::now();

    /** SRV of the frame `ago` pushes back (ago 0 = the most recent push).
     *  nullptr when the ring has not buffered that far yet — which is exactly
     *  what happens for the first N*D frames after a flush, and is why the
     *  trail grows in rather than appearing all at once. */
    ID3D11ShaderResourceView* at(int ago) const;

    /** Resize/reallocate to hold `frames` textures of w x h. Existing contents
     *  are DISCARDED when any of the three change — a ring whose geometry moved
     *  holds pixels of a different rectangle, and reusing them would smear the
     *  old cell size across the new one. Returns false if allocation failed. */
    bool ensure(ID3D11Device* device, int w, int h, int frames);

    void reset();   // drop history, keep the textures

    uint64_t bytes() const {
        return static_cast<uint64_t>(width) * static_cast<uint64_t>(height)
             * 4ull * static_cast<uint64_t>(capacity);
    }
};

// ---------------------------------------------------------------------------
// EchoStats — measured cost of the Visual Echo composite stage.
//
// Exists because the feature has a hard performance floor to answer to (the
// Phase 0 0.25 ms GPU composite budget) and "it looked fine" is not a
// measurement. Accumulated per frame, read by the smoke test / diagnostics.
// ---------------------------------------------------------------------------
struct EchoStats {
    double   lastFrameMs   = 0.0;   // CPU-side submit cost of all echo work this frame
    int      lastTapDraws  = 0;     // quads drawn for taps this frame
    int      lastPushes    = 0;     // ring pushes this frame
    int      activeRings   = 0;
    uint64_t ringBytes     = 0;     // total GPU bytes held by all live rings
};

// ---------------------------------------------------------------------------
// EffectShaderCache — compiled pixel shaders for chainable effects
// ---------------------------------------------------------------------------
struct EffectShaderCache {
    Microsoft::WRL::ComPtr<ID3D11PixelShader> desaturationPS;
    Microsoft::WRL::ComPtr<ID3D11PixelShader> tintPS;
    Microsoft::WRL::ComPtr<ID3D11PixelShader> brightnessContrastPS;
    Microsoft::WRL::ComPtr<ID3D11PixelShader> tvSimulatorPS;
    Microsoft::WRL::ComPtr<ID3D11PixelShader> zoomPanRotPS;
    Microsoft::WRL::ComPtr<ID3D11PixelShader> vibratoSwirlPS;
    Microsoft::WRL::ComPtr<ID3D11PixelShader> scratchWaveSmearPS;
    Microsoft::WRL::ComPtr<ID3D11PixelShader> chromaKeyPS;
    Microsoft::WRL::ComPtr<ID3D11PixelShader> outlinePS;
    Microsoft::WRL::ComPtr<ID3D11PixelShader> dropShadowPS;
    Microsoft::WRL::ComPtr<ID3D11PixelShader> transitionPS;

    // Per-effect constant buffers at b2 (small, updated per draw)
    Microsoft::WRL::ComPtr<ID3D11Buffer> desatCB;       // 16 bytes
    Microsoft::WRL::ComPtr<ID3D11Buffer> tintCB;        // 32 bytes
    Microsoft::WRL::ComPtr<ID3D11Buffer> brightContCB;  // 16 bytes
    Microsoft::WRL::ComPtr<ID3D11Buffer> tvSimCB;       // 32 bytes
    Microsoft::WRL::ComPtr<ID3D11Buffer> zoomPanRotCB;  // 16 bytes
    Microsoft::WRL::ComPtr<ID3D11Buffer> vibratoSwirlCB;     // 32 bytes
    Microsoft::WRL::ComPtr<ID3D11Buffer> scratchWaveSmearCB; // 32 bytes
    Microsoft::WRL::ComPtr<ID3D11Buffer> chromaKeyCB;        // 32 bytes (params[0..7])
    Microsoft::WRL::ComPtr<ID3D11Buffer> outlineCB;          // 48 bytes (OutlineConstants)
    Microsoft::WRL::ComPtr<ID3D11Buffer> dropShadowCB;       // 64 bytes (DropShadowConstants)
    // [Safety audit: No per-frame allocation] Created once in init() and reused.
    Microsoft::WRL::ComPtr<ID3D11Buffer> transitionCB;       // 64 bytes

    bool initialized = false;

    /** Create all effect shaders and constant buffers. */
    bool init(ID3D11Device* device);

    /** Release all resources. */
    void shutdown();
};

enum class ReadbackResult {
    Valid,
    NotReady,
    Fatal
};

// ---------------------------------------------------------------------------
// ReadbackBuffer — CPU-side pixel data from GPU readback
// ---------------------------------------------------------------------------
struct ReadbackBuffer {
    std::vector<uint8_t> pixels;   // BGRA, tightly packed (stride = width * 4)
    int  width   = 0;
    int  height  = 0;
    int  stride  = 0;              // bytes per row
    bool valid   = false;
    ReadbackResult result = ReadbackResult::Fatal;

    // True when readback() was given a destination and wrote the frame there
    // instead of into `pixels` — `pixels` is then untouched (and typically
    // empty). The caller owns those bytes; width/height/stride still describe
    // them. False for every call that omits a destination, so the export path
    // and the tests keep reading `pixels` exactly as before.
    bool intoDestination = false;
};

enum class ReadbackMode {
    Immediate,
    PreviewRing
};

enum class ReadbackPolicy {
    FastImmediate,   // blocking Map(0), no DO_NOT_WAIT — default for all GPUs
    AsyncQueued      // state-tracked ring with DO_NOT_WAIT — fallback if FastImmediate stalls
};

enum class ReadbackFailureStage {
    None = 0,
    StagingTextureMissing,
    StagingTextureCreateFailed,
    SourceTextureMissing,
    CopyPreconditionFailed,
    CopyIssuedThenDeviceRemoved,
    MapFailed,
    RowPitchInvalid,
    DimensionsInvalid,
    Unknown
};

struct ReadbackTextureDesc {
    UINT        width          = 0;
    UINT        height         = 0;
    DXGI_FORMAT format         = DXGI_FORMAT_UNKNOWN;
    D3D11_USAGE usage          = D3D11_USAGE_DEFAULT;
    UINT        cpuAccessFlags = 0;
    UINT        bindFlags      = 0;
    UINT        miscFlags      = 0;
    UINT        sampleCount    = 0;
};

struct ReadbackDiagnostics {
    ReadbackMode         mode                = ReadbackMode::Immediate;
    ReadbackFailureStage failureStage        = ReadbackFailureStage::None;
    HRESULT              hresult            = S_OK;
    HRESULT              deviceRemovedReason = S_OK;
    ReadbackTextureDesc  sourceTexture;
    ReadbackTextureDesc  stagingTexture;
    UINT                 mapType             = D3D11_MAP_READ;
    UINT                 mapFlags            = 0;
    UINT                 mappedRowPitch      = 0;
    uint64_t             expectedBytes       = 0;
    uint64_t             actualCopyBytes     = 0;
    bool                 dimensionsMatch     = false;
};

enum class StagingSlotState : uint8_t {
    Free,
    CopyIssued
};

// ---------------------------------------------------------------------------
// GridCompositor
// ---------------------------------------------------------------------------
class GridCompositor
{
public:
    GridCompositor();
    ~GridCompositor();

    // Non-copyable
    GridCompositor(const GridCompositor&)            = delete;
    GridCompositor& operator=(const GridCompositor&) = delete;

    // ── Lifecycle ──────────────────────────────────────────────────────────

    /**
     * Create all GPU resources: render target, shaders, vertex buffer,
     * blend state, sampler, constant buffer, staging texture.
     *
     * @param device     D3D11 device from GpuDeviceManager
     * @param deviceCtx  D3D11 immediate context
     * @param width      Output resolution width
     * @param height     Output resolution height
     * @return true on success
     */
    bool init(ID3D11Device* device, ID3D11DeviceContext* deviceCtx,
              int width, int height);

    /** Release all GPU resources. Safe to call multiple times. */
    void shutdown();

    bool    isInitialized()         const { return initialized_; }
    int     getWidth()              const { return width_; }
    int     getHeight()             const { return height_; }
    HRESULT getLastReadbackHRESULT() const { return lastReadbackHR_; }
    const ReadbackDiagnostics& getLastReadbackDiagnostics() const { return lastReadbackDiag_; }

    // ── Readback policy ────────────────────────────────────────────────────
    /** Set which readback path PreviewRing uses. Resets ring state. Call after init(). */
    void           setReadbackPolicy(ReadbackPolicy policy);
    ReadbackPolicy getActiveReadbackPolicy()  const { return activePolicy_; }
    uint64_t       getDroppedPendingFrames()  const { return droppedPendingFrames_; }
    int            getPendingSlotsCount()     const {
        return static_cast<int>(asyncWriteHead_ - asyncReadHead_);
    }

    /** Skip all chainable RT effect passes (desaturation, tint, B&C, TV-sim, ZPR,
     *  ping-pong crossfade) for faster preview. Gap, bounce, corner-radius and opacity
     *  are still applied — they are cheap single-pass or CPU-side operations.
     *
     *  NOT a blanket skip: bypass-EXEMPT effects still run. Chroma Key is
     *  exempt because it decides which pixels exist rather than how they look —
     *  skipping it would render the green screen the user is keying out and
     *  hide the layer behind the cell. See isChainEffectBypassExempt() in
     *  GridCompositor.cpp (VisualEffect is incomplete in this header). */
    void setEffectsBypass(bool bypass) { effectsBypass_ = bypass; }

    /** Set the canvas-fit viewport: where the project authoring canvas maps in
     *  output-UV space. Applied to every grid cell and fullscreen layer in
     *  compositeFrame so a single call realizes crop / stretch / letterbox
     *  without any shader change. Identity (0,0,1,1) — the default — is the
     *  legacy full-frame fill. See render/CanvasFit.h for how the viewport is
     *  derived. Persists until changed; safe to call before compositeFrame. */
    void setCanvasFit(float x, float y, float w, float h) {
        canvasFitX_ = x; canvasFitY_ = y; canvasFitW_ = w; canvasFitH_ = h;
    }

    // ── Compositing ────────────────────────────────────────────────────────

    /**
     * Composite one output frame from the collected cell requests.
     *
     * @param requests    Cell requests from FrameCollector::collectRequests
     * @param cache       Frame cache containing decoded textures
     * @param gridCols    Grid columns (from GridLayout)
     * @param gridRows    Grid rows (from GridLayout)
     * @param targetRTV   Optional output target; nullptr preserves the member target path
     */
    void compositeFrame(const std::vector<CellFrameRequest>& requests,
                        RenderFrameCache& cache,
                        int gridCols, int gridRows,
                        float time = 0.0f,
                        float gapScale = 0.0f,
                        ID3D11RenderTargetView* targetRTV = nullptr);

    // ── Visual Echo ────────────────────────────────────────────────────────

    /** Drop all buffered echo history (textures are kept for reuse).
     *
     *  Call on a TRANSPORT SEEK, so a jump does not leave the previous
     *  position's pixels trailing behind the new one.
     *
     *  Deliberately NOT called on a loop wrap. A wrap is musical continuity —
     *  the audio delay carries its repeats across the loop point and the video
     *  echo must too. The ring is indexed by push order, never by timeline
     *  position, so a wrap needs no special handling at all: the taps go on
     *  pointing at the frames that really were drawn N*D frames ago, which after
     *  a wrap are the frames from the end of the loop. */
    void flushEchoRings();

    /** Free rings untouched for at least idleSeconds. Same discipline as
     *  RTPool::pruneIdle, and for a sharper reason: a ring is far larger than an
     *  RT pair, so a cell that stops echoing (effect removed, track moved, Delay
     *  unbound) must not strand tens of megabytes for the session. */
    void pruneIdleEchoRings(double idleSeconds = 4.0);

    const EchoStats& getEchoStats() const { return echoStats_; }

    /** Acquire the cached whole-frame pair used for snapshot A and snapshot B.
     *  Requires a successfully initialized compositor. */
    RTPool::RTPair& acquireTransitionTargets();

    /** Blend two whole-frame snapshot SRVs into the compositor's readback target. */
    void transitionPass(ID3D11ShaderResourceView* srvA,
                        ID3D11ShaderResourceView* srvB,
                        int mode, float t, float angleRad,
                        float edgeSoftness, float zoomAmount,
                        int dissolveGrainPx,
                        float radialOriginX = 0.5f, float radialOriginY = 0.5f,
                        int pixelateMaxBlockPx = 32,
                        float glitchIntensity = 0.65f, int glitchBlockPx = 24,
                        float blurRadiusPx = 16.0f,
                        float displacementAmount = 0.06f, float displacementScale = 6.0f,
                        int effectSeed = 0);

    // ── Readback ───────────────────────────────────────────────────────────

    /**
     * Copy the render target to a staging texture and read back to CPU.
     * Immediate mode is the default for offline export/tests. PreviewRing is
     * explicitly for live preview and reads a staging slot from two frames ago.
     *
     * @param destination  Optional caller-owned buffer to receive the frame.
     *        When non-null and exactly the right size, the mapped staging rows
     *        are copied straight into it and the compositor's own `pixels`
     *        vector is skipped entirely — one full-frame copy per frame less
     *        for the live preview, whose real destination is the shared-memory
     *        back buffer rather than an owning vector. Must stay valid for the
     *        duration of the call and hold width*height*4 bytes.
     * @param destinationBytes  Capacity of `destination`. The destination is
     *        used only when it matches the frame's byte count exactly; any
     *        mismatch falls back to `pixels` rather than writing a
     *        differently-shaped image into the caller's buffer.
     *
     * @return ReadbackBuffer with BGRA pixels, or invalid buffer on failure.
     *         Backed by a buffer owned by this GridCompositor and reused
     *         across calls (resized only when dimensions change) — valid
     *         until the next readback() call on this instance. When
     *         `intoDestination` is set the pixels are in the caller's buffer
     *         instead and `pixels` holds nothing meaningful.
     */
    const ReadbackBuffer& readback(ReadbackMode mode = ReadbackMode::Immediate,
                                   uint8_t* destination = nullptr,
                                   size_t destinationBytes = 0);

    // ── Render target access (for downstream consumers) ────────────────────

    ID3D11Texture2D*          getRenderTarget()     const { return renderTarget_.Get(); }
    ID3D11ShaderResourceView* getRenderTargetSRV()  const { return renderTargetSRV_.Get(); }

    // ── Effect chain processing ────────────────────────────────────────────

    /**
     * Process a cell's visual effect chain via ping-pong render targets.
     * Returns the SRV of the fully-processed texture.
     * If the chain is empty or all effects bypassed, returns sourceSRV unchanged
     * (zero GPU cost fast path).
     *
     * @param sourceSRV     Decoded frame texture
     * @param cellWidth     Cell pixel width (for RT sizing)
     * @param cellHeight    Cell pixel height (for RT sizing)
     * @param chain         Visual effect chain from TrackInfo
     * @param req           CellFrameRequest (for animation state)
     * @param time          Global time in seconds (for TV simulator etc.)
     * @param rtSlot        RT pool slot (0=main chain, 1=standalone ZPR, 2=crossfade)
     * @return SRV of the processed texture, or sourceSRV if no processing needed
     */
    ID3D11ShaderResourceView* processEffectChain(
        ID3D11ShaderResourceView* sourceSRV,
        int cellWidth, int cellHeight,
        const std::vector<VisualEffect>& chain,
        const CellFrameRequest& req,
        float time,
        int rtSlot = 0);

    // ── Terminal expansion stages (Outline, Drop Shadow) ───────────────────
    //
    // These two chainable effects are LAYER STYLES rather than pixel filters, and
    // that is why they are not cases in processEffectChain's switch:
    //
    //   • They draw OUTSIDE the source's own bounds. A stroke on a cell that
    //     already fills its target has nowhere to go, so each stage renders into
    //     a target PADDED by the radius it needs and reports the pad back so the
    //     caller can grow the cell's composite rect to match. No other effect
    //     changes that rect.
    //   • They are TERMINAL: applied after the chain, the standalone ZPR pass,
    //     the ping-pong crossfade and companion FX, so the stroke traces — and
    //     the shadow is cast by — the finished cell. Their position within the
    //     chain therefore does not affect the result.
    //
    // Both follow the global preview bypass. Unlike Chroma Key they only add
    // decoration, so skipping them for speed leaves the composite structurally
    // correct rather than wrong.

    /**
     * Apply every active Outline in the chain, innermost first, into a padded
     * render target. Several strokes nest and their pads add.
     *
     * @param sourceSRV      The finished cell texture
     * @param contentWidth   Pixel width the cell's composite rect maps to
     * @param contentHeight  Pixel height the cell's composite rect maps to
     * @param chain          Visual effect chain from TrackInfo
     * @param cornerRadius   The cell's corner radius, 0..1. Non-zero means this
     *                       stage TAKES OVER the rounding (the caller must then
     *                       pass 0 to drawCell) — applying it at the final
     *                       composite would round the padded boundary and leave
     *                       the video's own corners square.
     * @param outPadPx       Out: texels of padding added on each side, 0 if the
     *                       stage did not run
     * @return SRV of the padded, stroked texture, or sourceSRV if nothing ran
     */
    ID3D11ShaderResourceView* applyOutlineStage(
        ID3D11ShaderResourceView* sourceSRV,
        int contentWidth, int contentHeight,
        const std::vector<VisualEffect>& chain,
        float cornerRadius,
        int& outPadPx);

    /**
     * Build and immediately draw each active Drop Shadow BEHIND the cell.
     *
     * Drawn as its own quad rather than composited into the cell texture,
     * because that is the only way the darkening blend modes can be real: a
     * Multiply shadow has to multiply against whatever is behind the cell, and
     * nothing inside the per-cell chain can see the backdrop. Leaves the main
     * pipeline state restored and ready for the caller's drawCell.
     *
     * @param cellSRV        The finished (possibly stroked) cell texture
     * @param contentWidth   Texels of cellSRV that map onto rectW
     * @param contentHeight  Texels of cellSRV that map onto rectH
     * @param req            Cell request — chain, orientation, opacity
     * @param rectX/Y/W/H    The cell's composite rect in OUTPUT-UV space
     * @param cornerRadius   The cell's corner radius, 0..1, so the shadow is cast
     *                       by the rounded shape. Pass 0 when applyOutlineStage
     *                       has already baked it into cellSRV.
     * @param activeRTV      The output target to restore and draw into
     */
    void drawDropShadowLayers(
        ID3D11ShaderResourceView* cellSRV,
        int contentWidth, int contentHeight,
        const CellFrameRequest& req,
        float rectX, float rectY, float rectW, float rectH,
        float cornerRadius,
        ID3D11RenderTargetView* activeRTV,
        const CellDrawXform* xf = nullptr);   // nullptr = {req.orientation}, no Roam

private:
    // ── Device references (not owned) ──────────────────────────────────────
    ID3D11Device*        device_    = nullptr;
    ID3D11DeviceContext* deviceCtx_ = nullptr;
    int  width_  = 0;
    int  height_ = 0;
    bool initialized_    = false;
    bool effectsBypass_  = false;  // preview-only fast path — skips all chainable RT passes

    // Canvas-fit viewport (output-UV placement of the project canvas). Identity =
    // legacy full-frame fill. Set via setCanvasFit; applied in compositeFrame.
    float canvasFitX_ = 0.0f, canvasFitY_ = 0.0f, canvasFitW_ = 1.0f, canvasFitH_ = 1.0f;

    // ── Render target ──────────────────────────────────────────────────────
    Microsoft::WRL::ComPtr<ID3D11Texture2D>          renderTarget_;
    Microsoft::WRL::ComPtr<ID3D11RenderTargetView>   renderTargetRTV_;
    Microsoft::WRL::ComPtr<ID3D11ShaderResourceView> renderTargetSRV_;

    // ── Staging texture ring (for GPU→CPU readback) ────────────────────────
    // FastImmediate: always uses staging[0] with blocking Map (no DO_NOT_WAIT).
    // AsyncQueued: state-tracked ring of K slots with DO_NOT_WAIT.
    static constexpr int kReadbackStagingTextureCount = 5;
    Microsoft::WRL::ComPtr<ID3D11Texture2D> stagingTextures_[kReadbackStagingTextureCount];
    uint64_t readbackFrameCount_ = 0;   // unused after policy refactor, kept for shutdown reset
    HRESULT  lastReadbackHR_     = S_OK;
    ReadbackDiagnostics lastReadbackDiag_;
    // Persistent readback result — reused across calls so buf.pixels is
    // resized (reallocated) only when the readback dimensions change, not
    // on every frame. readback() resets the scalar fields to their
    // fresh-construction defaults on every call.
    ReadbackBuffer readbackBuf_;

    // ── Readback policy (per-vendor, set after init) ───────────────────────
    ReadbackPolicy   activePolicy_         = ReadbackPolicy::FastImmediate;
    uint64_t         asyncWriteHead_       = 0;   // AsyncQueued: slot written next
    uint64_t         asyncReadHead_        = 0;   // AsyncQueued: oldest pending slot; advances only on success/fatal
    uint64_t         droppedPendingFrames_ = 0;
    StagingSlotState slotState_[kReadbackStagingTextureCount] = {};

    // ── Shaders ────────────────────────────────────────────────────────────
    Microsoft::WRL::ComPtr<ID3D11VertexShader> vertexShader_;
    Microsoft::WRL::ComPtr<ID3D11PixelShader>  pixelShader_;
    Microsoft::WRL::ComPtr<ID3D11InputLayout>  inputLayout_;

    // ── Geometry (fullscreen quad) ─────────────────────────────────────────
    Microsoft::WRL::ComPtr<ID3D11Buffer> vertexBuffer_;
    Microsoft::WRL::ComPtr<ID3D11Buffer> indexBuffer_;

    // ── Pipeline state ─────────────────────────────────────────────────────
    Microsoft::WRL::ComPtr<ID3D11BlendState>        blendState_;
    // Blend DISABLED — a straight overwrite. Bound for the duration of the
    // offscreen effect-chain passes so a pass emitting alpha < 1 writes its
    // RGB verbatim instead of being premultiplied against a cleared target.
    // See the long comment in processEffectChain for why this matters.
    Microsoft::WRL::ComPtr<ID3D11BlendState>        opaqueBlendState_;
    // Darkening blends for the Drop Shadow quad, which is drawn behind the cell
    // straight into the output target. Each one pairs with a specific output form
    // baked by FX_DropShadow.hlsl — see the emit table at the bottom of that
    // shader; swapping a state without swapping the emit is silently wrong.
    // "Normal" mode needs no state of its own: it is plain blendState_.
    Microsoft::WRL::ComPtr<ID3D11BlendState>        shadowMultiplyBlendState_;
    Microsoft::WRL::ComPtr<ID3D11BlendState>        shadowDarkenBlendState_;
    Microsoft::WRL::ComPtr<ID3D11BlendState>        shadowLinearBurnBlendState_;
    Microsoft::WRL::ComPtr<ID3D11SamplerState>      samplerState_;
    Microsoft::WRL::ComPtr<ID3D11Buffer>             constantBuffer_;
    Microsoft::WRL::ComPtr<ID3D11Buffer>             globalConstantBuffer_;
    Microsoft::WRL::ComPtr<ID3D11RasterizerState>   rasterizerState_;
    Microsoft::WRL::ComPtr<ID3D11DepthStencilState> depthStencilState_;

    // ── Effect chain infrastructure ────────────────────────────────────────
    RTPool             rtPool_;
    EffectShaderCache  effectShaders_;

    // Snapshot-transition safety audit:
    //  1. Read/write hazard: unbind RT_A/RT_B as RTVs before sampling their SRVs.
    //  2. Clean SRV state: unbind transition t0/t1 after the pass.
    //  3. Default-path regression: nullptr target resolves to renderTargetRTV_.
    //  4. No per-frame allocation: cache shader/CB and the slot-4 RTPair.
    //  5. CB alignment: TransitionConstants is statically asserted to 64 bytes.
    //
    // RTPool encodes slot + dimensions in its key and has no fixed slot
    // capacity. Slot ownership in compositeFrame/processEffectChain:
    //   0 = track visual chain, 1 = standalone ZPR, 2 = ping-pong crossfade,
    //   3 = companion FX, 4 = whole-frame snapshot transition,
    //   5 = Outline stage, 6 = Drop Shadow stage.
    static constexpr int kCompanionFxRtSlot = 3;
    // [Safety audit: No per-frame allocation] Slot 4 retains one full-frame pair.
    static constexpr int kTransitionRtSlot = 4;
    // Slots 5 and 6 must differ from each other and from 0-3: the Drop Shadow
    // stage samples the Outline stage's output while building its own, so sharing
    // a slot would bind the same texture as both SRV and RTV.
    static constexpr int kOutlineRtSlot    = 5;
    static constexpr int kDropShadowRtSlot = 6;
    // Lens framing pass (P2). Must differ from 0-7: it is the FIRST stage of a
    // cell and every later stage (chain 0, ZPR 1, ping-pong 2, companion 3,
    // outline 5, shadow 6, echo lerp 7) may still be reading it.
    static constexpr int kLensRtSlot = 8;

    // Bounds Clip: same as rasterizerState_ plus ScissorEnable. Bound only
    // around a request's final draws (see drawCell).
    Microsoft::WRL::ComPtr<ID3D11RasterizerState>   scissorRasterizerState_;

    // Dev-only [Roam] per-frame composite timing (XLETH_DEV_ROAM_LOG or the
    // XLETH_DEV_LENS_ROAM_TRACK hook). GPU time via timestamp queries, read
    // back a few frames late without stalling. Created once, on first use.
    // The members are UNCONDITIONAL on purpose: only the .cpp logic is gated
    // on XLETH_DEBUG. A macro-dependent class layout would differ between the
    // engine (XLETH_DEBUG on) and any consumer built without it (ODR).
    struct RoamGpuTimer {
        Microsoft::WRL::ComPtr<ID3D11Query> disjoint, begin, end;
        bool    pending = false;
        int64_t frame   = 0;
    };
    static constexpr int kRoamGpuTimers = 4;
    RoamGpuTimer roamGpuTimers_[kRoamGpuTimers];
    bool         roamGpuTimersReady_ = false;
    int64_t      roamFrameCounter_   = 0;

    // ── Visual Echo state ──────────────────────────────────────────────────
    std::unordered_map<uint64_t, EchoRing> echoRings_;
    EchoStats                              echoStats_;
    // Blend state for an additive trail: SRC_ALPHA / ONE. The live cell always
    // draws through blendState_; only taps can opt into this.
    Microsoft::WRL::ComPtr<ID3D11BlendState> additiveBlendState_;
    // RTPool slot for the fractional-tap lerp target. Must differ from 0-6: the
    // lerp samples a ring texture while writing this one, and the cell's own
    // chain output is still live in slot 0 at that moment.
    static constexpr int kEchoLerpRtSlot = 7;

    /** Copy the cell's finished pixels into its ring.
     *  Called once per DISTINCT output frame — see EchoRing::lastPushedTime. */
    void pushEchoFrame(const CellFrameRequest& req,
                       ID3D11ShaderResourceView* cellSRV,
                       int cellPixelW, int cellPixelH,
                       float time,
                       ID3D11RenderTargetView* activeRTV);

    /** Draw this cell's echo taps into activeRTV, oldest/faintest first, so the
     *  live cell the caller draws afterwards lands on top of its own trail. */
    void drawEchoTaps(const CellFrameRequest& req,
                      float rectX, float rectY, float rectW, float rectH,
                      float cornerRadius,
                      ID3D11RenderTargetView* activeRTV,
                      const CellDrawXform& xf);

    /** Resolve one tap to a single SRV, lerping between the two adjacent
     *  buffered frames when the tap's offset is fractional. Returns nullptr when
     *  the ring has not buffered that far back yet. */
    ID3D11ShaderResourceView* resolveEchoTapSRV(EchoRing& ring,
                                                float agoFrames,
                                                ID3D11RenderTargetView* activeRTV);

    // ── Internal helpers ───────────────────────────────────────────────────
    bool createRenderTarget();
    bool createStagingTexture();
    bool createShaders();
    bool createGeometry();
    bool createPipelineState();

    /** Convert fine-grid cell position to UV rect {x, y, w, h}. */
    static void gridCellToUV(int cellCol, int cellRow, int spanX, int spanY,
                              int gridCols, int gridRows,
                              float& outX, float& outY, float& outW, float& outH);

    /** Draw one cell: set constants, bind texture, draw quad.
     *  `orientation` is the flip-v2 enum (0..5 — see GridComposite.hlsl). */
    void drawCell(ID3D11ShaderResourceView* srv,
                  float rectX, float rectY, float rectW, float rectH,
                  float opacity, int orientation, float cornerRadius,
                  const CellDrawXform* xf = nullptr);

    /** Lens framing pass: draw `srcSRV` framed by `map` into slot kLensRtSlot
     *  (dstW x dstH, cleared to the transparent cell background) and return
     *  that target's SRV, or srcSRV when no target could be acquired. Runs
     *  BEFORE the visual chain (spec Ruling 3). Leaves the caller to restore
     *  the main pipeline state. */
    ID3D11ShaderResourceView* applyLensPass(ID3D11ShaderResourceView* srcSRV,
                                            int dstW, int dstH,
                                            const float lensRow0[4],
                                            const float lensRow1[4]);

    /** Blit sourceSRV into the currently bound render target as a fullscreen quad.
     *  Uses the main pixel shader with the supplied orientation applied. */
    void blitFullscreen(ID3D11ShaderResourceView* srv, int orientation = 0);

    /** Draw a fullscreen pass with a specific pixel shader (for effect chain).
     *  Binds srv at t0, draws the quad. Caller must set the PS and CB beforehand. */
    void drawEffectPass(ID3D11ShaderResourceView* srv);

    /** Write CellConstants for a centred, un-scaled blit of a contentW x contentH
     *  region into a larger targetW x targetH render target, leaving the border at
     *  the clear colour. Used by the two padded expansion stages so their distance
     *  searches have transparent texels to walk into. */
    void setInsetBlitConstants(int targetW, int targetH, int contentW, int contentH);

    void restoreMainPipelineState(ID3D11RenderTargetView* targetRTV = nullptr);

    ID3D11ShaderResourceView* processCompanionFx(
        ID3D11ShaderResourceView* sourceSRV,
        int cellWidth, int cellHeight,
        const CellFrameRequest& req);
};
