#pragma once

/**
 * Nv12Converter — GPU-side NV12 → BGRA conversion for hardware-decoded frames.
 *
 * D3D11VA hands the decoder an NV12 array slice that only has
 * D3D11_BIND_DECODER. The render pipeline wants a sampleable BGRA texture per
 * cached frame (one SRV per cell is what every consumer — the grid
 * compositor, the effect chain, visual echo, snapshot transitions and the
 * offline renderer — takes). Until now the decoder bridged that gap on the
 * CPU: av_hwframe_transfer_data (GPU→CPU), sws_scale NV12→BGRA, and a texture
 * upload (CPU→GPU) — measured 8-19 ms per 720p frame, the dominant per-frame
 * cost on integrated GPUs.
 *
 * This class keeps the frame on the GPU instead. The decoder copies the
 * decoded slice into an NV12 texture it owns (CopySubresourceRegion), views it
 * as two planes (R8_UNORM luma, R8G8_UNORM chroma) and calls convert(), which
 * draws a fullscreen triangle through shaders/Nv12ToBgra.hlsl into a freshly
 * created BGRA texture — the FrameCacheEntry. Downscaling to the preview's
 * setMaxOutputSize cap happens in the same draw (linear sampling), so the
 * cache entry has exactly the size and byte count the CPU path would have
 * produced.
 *
 * The conversion touches pipeline state on the immediate context; convert()
 * saves and restores every slot it binds so a caller mid-way through its own
 * frame (the compositor rebinds per frame anyway) is unaffected.
 *
 * Colour: the YUV→RGB matrix is chosen per frame from the stream's
 * colorspace tag. Untagged sources (every proxy ProxyTranscoder writes) use
 * BT.601 — the same default sws_scale applies on the CPU path, so a software-
 * and a hardware-decoded frame of one untagged file match. A source tagged
 * BT.709 gets BT.709 (the CPU path's sws_scale ignored the tag).
 */

#include "GpuDeviceManager.h"   // guards NOMINMAX before <d3d11_4.h>; wrl ComPtr

#include <cstdint>

class Nv12Converter
{
public:
    enum class Matrix : uint8_t { BT601, BT709, BT2020, SMPTE240M };

    struct Params {
        int    srcWidth   = 0;    // valid (even) NV12 area in the source texture
        int    srcHeight  = 0;
        int    dstWidth   = 0;    // BGRA output size (<= src: linear downscale)
        int    dstHeight  = 0;
        Matrix matrix     = Matrix::BT601;
        bool   fullRange  = false;
        // Chroma siting as a UV offset for the chroma sample, in units of the
        // full-resolution picture (0.5f / srcWidth puts a chroma sample on
        // the even luma column — the H.264 / MPEG-2 default, "left").
        float  chromaShiftU = 0.0f;
        float  chromaShiftV = 0.0f;
    };

    Nv12Converter()  = default;
    ~Nv12Converter() = default;
    Nv12Converter(const Nv12Converter&)            = delete;
    Nv12Converter& operator=(const Nv12Converter&) = delete;

    /** Creates the shaders, sampler and constant buffer. Returns false (and
     *  stays unusable) when NV12 textures cannot be sampled on this device —
     *  the caller then keeps the CPU transfer path. */
    bool init(ID3D11Device* device);
    void shutdown();
    bool isReady() const { return ready_; }

    /** True when the device can create NV12 textures and sample them through
     *  R8 / R8G8 plane views. */
    static bool nv12SamplingSupported(ID3D11Device* device);

    /** Creates an NV12 texture of w x h (both even) with shader-resource
     *  binding plus its two plane views. */
    static bool createNv12Target(ID3D11Device* device, int w, int h,
                                 Microsoft::WRL::ComPtr<ID3D11Texture2D>& tex,
                                 Microsoft::WRL::ComPtr<ID3D11ShaderResourceView>& lumaSrv,
                                 Microsoft::WRL::ComPtr<ID3D11ShaderResourceView>& chromaSrv);

    /** Draws luma/chroma into a new BGRA texture of dstWidth x dstHeight and
     *  returns it with an SRV. Pipeline state the draw binds is restored. */
    bool convert(ID3D11Device* device, ID3D11DeviceContext* ctx,
                 ID3D11ShaderResourceView* lumaSrv,
                 ID3D11ShaderResourceView* chromaSrv,
                 const Params& p,
                 Microsoft::WRL::ComPtr<ID3D11Texture2D>& outTexture,
                 Microsoft::WRL::ComPtr<ID3D11ShaderResourceView>& outSrv);

    /** The three affine rows the shader applies: rgb[i] = dot(row[i], (Y,Cb,Cr,1)).
     *  Exposed for tests. */
    static void yuvToRgbRows(Matrix m, bool fullRange, float rows[12]);

private:
    Microsoft::WRL::ComPtr<ID3D11VertexShader>    vs_;
    Microsoft::WRL::ComPtr<ID3D11PixelShader>     ps_;
    Microsoft::WRL::ComPtr<ID3D11SamplerState>    sampler_;
    Microsoft::WRL::ComPtr<ID3D11Buffer>          constants_;
    Microsoft::WRL::ComPtr<ID3D11RasterizerState> rasterizer_;
    Microsoft::WRL::ComPtr<ID3D11BlendState>      blend_;
    Microsoft::WRL::ComPtr<ID3D11DepthStencilState> depthStencil_;
    bool ready_ = false;
};
