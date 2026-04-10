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
#include <vector>

#include "GpuDeviceManager.h"   // NOMINMAX, d3d11_4.h, ComPtr
#include "FrameCache.h"         // RenderFrameCache, FrameCacheKey, FrameCacheEntry
#include "FrameCollector.h"     // CellFrameRequest

// ---------------------------------------------------------------------------
// CellConstants — matches cbuffer CellConstants in GridComposite.hlsl
// ---------------------------------------------------------------------------
struct alignas(16) CellConstants {
    float cellRect[4];      // x, y, width, height in UV [0,1]
    float opacity;
    int   flipMode;
    int   globalNoteIndex;
    float padding;
};
static_assert(sizeof(CellConstants) == 32, "CellConstants must be 32 bytes (2 x float4)");

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

    bool isInitialized() const { return initialized_; }
    int  getWidth()  const { return width_; }
    int  getHeight() const { return height_; }

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
                        int gridCols, int gridRows);

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

private:
    // ── Device references (not owned) ──────────────────────────────────────
    ID3D11Device*        device_    = nullptr;
    ID3D11DeviceContext* deviceCtx_ = nullptr;
    int  width_  = 0;
    int  height_ = 0;
    bool initialized_ = false;

    // ── Render target ──────────────────────────────────────────────────────
    Microsoft::WRL::ComPtr<ID3D11Texture2D>          renderTarget_;
    Microsoft::WRL::ComPtr<ID3D11RenderTargetView>   renderTargetRTV_;
    Microsoft::WRL::ComPtr<ID3D11ShaderResourceView> renderTargetSRV_;

    // ── Staging texture (for GPU→CPU readback) ─────────────────────────────
    Microsoft::WRL::ComPtr<ID3D11Texture2D> stagingTexture_;

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
    Microsoft::WRL::ComPtr<ID3D11RasterizerState>   rasterizerState_;
    Microsoft::WRL::ComPtr<ID3D11DepthStencilState> depthStencilState_;

    // ── Internal helpers ───────────────────────────────────────────────────
    bool createRenderTarget();
    bool createStagingTexture();
    bool createShaders();
    bool createGeometry();
    bool createPipelineState();

    /** Convert half-grid cell position to UV rect {x, y, w, h}. */
    static void gridCellToUV(int cellCol, int cellRow, int spanX, int spanY,
                              int gridCols, int gridRows,
                              float& outX, float& outY, float& outW, float& outH);

    /** Draw one cell: set constants, bind texture, draw quad. */
    void drawCell(ID3D11ShaderResourceView* srv,
                  float rectX, float rectY, float rectW, float rectH,
                  float opacity, int flipMode, int globalNoteIndex);
};
