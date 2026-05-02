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

    // Per-effect constant buffers at b2 (small, updated per draw)
    Microsoft::WRL::ComPtr<ID3D11Buffer> desatCB;       // 16 bytes
    Microsoft::WRL::ComPtr<ID3D11Buffer> tintCB;        // 32 bytes
    Microsoft::WRL::ComPtr<ID3D11Buffer> brightContCB;  // 16 bytes
    Microsoft::WRL::ComPtr<ID3D11Buffer> tvSimCB;       // 32 bytes
    Microsoft::WRL::ComPtr<ID3D11Buffer> zoomPanRotCB;  // 16 bytes

    bool initialized = false;

    /** Create all effect shaders and constant buffers. */
    bool init(ID3D11Device* device);

    /** Release all resources. */
    void shutdown();
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
     * For offline export — call after compositeFrame().
     *
     * @return ReadbackBuffer with BGRA pixels, or invalid buffer on failure
     */
    ReadbackBuffer readback();

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
    // Two-texture ring: CopyResource into staging[N%2], Map staging[(N-1)%2].
    // Gives the GPU a full frame period to finish the copy before we Map it,
    // working around AMD WDDM Map(D3D11_MAP_READ) failures on back-to-back calls
    // to the same staging texture.
    Microsoft::WRL::ComPtr<ID3D11Texture2D> stagingTextures_[2];
    uint64_t readbackFrameCount_ = 0;   // incremented each readback() call
    HRESULT  lastReadbackHR_     = S_OK;

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
};
