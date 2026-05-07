#pragma once

/**
 * GridCompositor — D3D11 GPU compositor for the render pipeline.
 *
 * Assembles decoded video frames (D3D11 textures from RenderFrameCache)
 * into a final output frame using the grid layout.
 *
 * Compositing order per output frame:
 *   1. Clear render target to black
 *   2. Chorus layer (full-screen, behind grid cells)
 *   3. Grid cells (each at its grid position, sorted by zOrder)
 *   4. Crash overlay (full-screen, on top)
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
// Layout matches the HLSL cbuffer's 28 bytes + 4 bytes implicit pad (sizeof=32).
// ---------------------------------------------------------------------------
struct alignas(16) CellConstants {
    float cellRect[4];      // x, y, width, height in UV [0,1]
    float opacity;
    int   orientation;      // 0=none, 1=h, 2=v, 3=rot180, 4=rot90cw, 5=rot90ccw
    float cornerRadius;
    // 4-byte tail pad — implicit; struct is 28 bytes used, padded to 32 for alignof(16).
};
static_assert(sizeof(CellConstants) == 32, "CellConstants must be 32 bytes (2 x float4)");

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

// ---------------------------------------------------------------------------
// RTPool — render target pairs for ping-pong effect chain processing
// ---------------------------------------------------------------------------
struct RTPool {
    struct RTPair {
        Microsoft::WRL::ComPtr<ID3D11Texture2D> texA, texB;
        Microsoft::WRL::ComPtr<ID3D11RenderTargetView> rtvA, rtvB;
        Microsoft::WRL::ComPtr<ID3D11ShaderResourceView> srvA, srvB;
        int width = 0, height = 0;
    };

    // Key = (width << 32) | height | (slot << 48) — slot prevents aliasing
    std::unordered_map<uint64_t, RTPair> pairs;

    /** Get or create an RT pair for the given dimensions and slot.
     *  Different slots with the same dimensions return DIFFERENT pairs
     *  to prevent SRV/RTV aliasing hazards. */
    RTPair& acquire(ID3D11Device* device, int width, int height, int slot = 0);

    /** Release all GPU resources. */
    void clear();
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

    // Per-effect constant buffers at b2 (small, updated per draw)
    Microsoft::WRL::ComPtr<ID3D11Buffer> desatCB;       // 16 bytes
    Microsoft::WRL::ComPtr<ID3D11Buffer> tintCB;        // 32 bytes
    Microsoft::WRL::ComPtr<ID3D11Buffer> brightContCB;  // 16 bytes
    Microsoft::WRL::ComPtr<ID3D11Buffer> tvSimCB;       // 32 bytes
    Microsoft::WRL::ComPtr<ID3D11Buffer> zoomPanRotCB;  // 16 bytes
    Microsoft::WRL::ComPtr<ID3D11Buffer> vibratoSwirlCB;     // 32 bytes
    Microsoft::WRL::ComPtr<ID3D11Buffer> scratchWaveSmearCB; // 32 bytes

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
     *  are still applied — they are cheap single-pass or CPU-side operations. */
    void setEffectsBypass(bool bypass) { effectsBypass_ = bypass; }

    // ── Compositing ────────────────────────────────────────────────────────

    /**
     * Composite one output frame from the collected cell requests.
     *
     * @param requests    Cell requests from FrameCollector::collectRequests
     * @param cache       Frame cache containing decoded textures
     * @param gridCols    Grid columns (from GridLayout)
     * @param gridRows    Grid rows (from GridLayout)
     */
    void compositeFrame(const std::vector<CellFrameRequest>& requests,
                        RenderFrameCache& cache,
                        int gridCols, int gridRows,
                        float time = 0.0f,
                        float gapScale = 0.0f);

    // ── Readback ───────────────────────────────────────────────────────────

    /**
     * Copy the render target to a staging texture and read back to CPU.
     * Immediate mode is the default for offline export/tests. PreviewRing is
     * explicitly for live preview and reads a staging slot from two frames ago.
     *
     * @return ReadbackBuffer with BGRA pixels, or invalid buffer on failure
     */
    ReadbackBuffer readback(ReadbackMode mode = ReadbackMode::Immediate);

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

private:
    // ── Device references (not owned) ──────────────────────────────────────
    ID3D11Device*        device_    = nullptr;
    ID3D11DeviceContext* deviceCtx_ = nullptr;
    int  width_  = 0;
    int  height_ = 0;
    bool initialized_    = false;
    bool effectsBypass_  = false;  // preview-only fast path — skips all chainable RT passes

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
    Microsoft::WRL::ComPtr<ID3D11SamplerState>      samplerState_;
    Microsoft::WRL::ComPtr<ID3D11Buffer>             constantBuffer_;
    Microsoft::WRL::ComPtr<ID3D11Buffer>             globalConstantBuffer_;
    Microsoft::WRL::ComPtr<ID3D11RasterizerState>   rasterizerState_;
    Microsoft::WRL::ComPtr<ID3D11DepthStencilState> depthStencilState_;

    // ── Effect chain infrastructure ────────────────────────────────────────
    RTPool             rtPool_;
    EffectShaderCache  effectShaders_;

    // RTPool encodes slot + dimensions in its key and has no fixed slot
    // capacity. Slot ownership in compositeFrame/processEffectChain:
    //   0 = track visual chain, 1 = standalone ZPR, 2 = ping-pong crossfade.
    // This named slot is reserved for clip-local companion FX so SRV/RTV
    // aliasing cannot occur with existing passes.
    static constexpr int kCompanionFxRtSlot = 3;

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
                  float opacity, int orientation, float cornerRadius);

    /** Blit sourceSRV into the currently bound render target as a fullscreen quad.
     *  Uses the main pixel shader with the supplied orientation applied. */
    void blitFullscreen(ID3D11ShaderResourceView* srv, int orientation = 0);

    /** Draw a fullscreen pass with a specific pixel shader (for effect chain).
     *  Binds srv at t0, draws the quad. Caller must set the PS and CB beforehand. */
    void drawEffectPass(ID3D11ShaderResourceView* srv);

    void restoreMainPipelineState();

    ID3D11ShaderResourceView* processCompanionFx(
        ID3D11ShaderResourceView* sourceSRV,
        int cellWidth, int cellHeight,
        const CellFrameRequest& req);
};
