#include "Nv12Converter.h"

#include "shaders/Nv12ToBgraVS.h"
#include "shaders/Nv12ToBgraPS.h"

#include <cstdio>
#include <cstring>

// ===========================================================================
// Colour matrix
// ===========================================================================

void Nv12Converter::yuvToRgbRows(Matrix m, bool fullRange, float rows[12])
{
    // Luma coefficients Kr / Kb per matrix; Kg = 1 - Kr - Kb.
    float kr = 0.299f, kb = 0.114f;                      // BT.601 (BT.470BG / SMPTE 170M)
    switch (m) {
        case Matrix::BT709:     kr = 0.2126f; kb = 0.0722f; break;
        case Matrix::BT2020:    kr = 0.2627f; kb = 0.0593f; break;
        case Matrix::SMPTE240M: kr = 0.212f;  kb = 0.087f;  break;
        case Matrix::BT601:     break;
    }
    const float kg = 1.0f - kr - kb;

    // Normalised (0..1) plane values → Y', Cb, Cr about zero.
    // Limited range: Y in [16,235] → scale 255/219; C in [16,240] → 255/224.
    const float yScale = fullRange ? 1.0f : 255.0f / 219.0f;
    const float yOff   = fullRange ? 0.0f : 16.0f / 255.0f;
    const float cScale = fullRange ? 1.0f : 255.0f / 224.0f;
    const float cOff   = 128.0f / 255.0f;

    // R = Y' + 2(1-Kr) Cr
    // G = Y' - 2 Kb (1-Kb)/Kg Cb - 2 Kr (1-Kr)/Kg Cr
    // B = Y' + 2(1-Kb) Cb
    const float rCr = 2.0f * (1.0f - kr);
    const float gCb = -2.0f * kb * (1.0f - kb) / kg;
    const float gCr = -2.0f * kr * (1.0f - kr) / kg;
    const float bCb = 2.0f * (1.0f - kb);

    // Each row: (coef_y, coef_u, coef_v, constant) applied to the RAW plane
    // values, i.e. the offsets are folded into the constant term.
    auto row = [&](float* r, float cu, float cv) {
        r[0] = yScale;
        r[1] = cu * cScale;
        r[2] = cv * cScale;
        r[3] = -yOff * yScale - (cu + cv) * cScale * cOff;
    };
    row(rows + 0, 0.0f, rCr);
    row(rows + 4, gCb,  gCr);
    row(rows + 8, bCb,  0.0f);
}

// ===========================================================================
// Capability
// ===========================================================================

bool Nv12Converter::nv12SamplingSupported(ID3D11Device* device)
{
    if (!device) return false;
    UINT support = 0;
    if (FAILED(device->CheckFormatSupport(DXGI_FORMAT_NV12, &support))) return false;
    const UINT need = D3D11_FORMAT_SUPPORT_TEXTURE2D | D3D11_FORMAT_SUPPORT_SHADER_SAMPLE;
    return (support & need) == need;
}

// ===========================================================================
// Lifecycle
// ===========================================================================

bool Nv12Converter::init(ID3D11Device* device)
{
    shutdown();
    if (!device) return false;

    if (!nv12SamplingSupported(device)) {
        std::fprintf(stderr, "[Nv12Converter] NV12 textures cannot be sampled on this device — "
                             "hw frames will take the CPU transfer path\n");
        return false;
    }

    HRESULT hr = device->CreateVertexShader(g_Nv12ToBgraVS, sizeof(g_Nv12ToBgraVS), nullptr, &vs_);
    if (FAILED(hr)) {
        std::fprintf(stderr, "[Nv12Converter] CreateVertexShader failed HR=0x%08X\n",
                     static_cast<unsigned int>(hr));
        shutdown();
        return false;
    }
    hr = device->CreatePixelShader(g_Nv12ToBgraPS, sizeof(g_Nv12ToBgraPS), nullptr, &ps_);
    if (FAILED(hr)) {
        std::fprintf(stderr, "[Nv12Converter] CreatePixelShader failed HR=0x%08X\n",
                     static_cast<unsigned int>(hr));
        shutdown();
        return false;
    }

    D3D11_SAMPLER_DESC sd = {};
    sd.Filter         = D3D11_FILTER_MIN_MAG_MIP_LINEAR;
    sd.AddressU       = D3D11_TEXTURE_ADDRESS_CLAMP;
    sd.AddressV       = D3D11_TEXTURE_ADDRESS_CLAMP;
    sd.AddressW       = D3D11_TEXTURE_ADDRESS_CLAMP;
    sd.ComparisonFunc = D3D11_COMPARISON_NEVER;
    sd.MaxLOD         = D3D11_FLOAT32_MAX;
    hr = device->CreateSamplerState(&sd, &sampler_);
    if (FAILED(hr)) { shutdown(); return false; }

    D3D11_BUFFER_DESC bd = {};
    bd.ByteWidth      = 4 * 4 * sizeof(float);     // three float4 rows + chroma shift
    bd.Usage          = D3D11_USAGE_DYNAMIC;
    bd.BindFlags      = D3D11_BIND_CONSTANT_BUFFER;
    bd.CPUAccessFlags = D3D11_CPU_ACCESS_WRITE;
    hr = device->CreateBuffer(&bd, nullptr, &constants_);
    if (FAILED(hr)) { shutdown(); return false; }

    D3D11_RASTERIZER_DESC rd = {};
    rd.FillMode        = D3D11_FILL_SOLID;
    rd.CullMode        = D3D11_CULL_NONE;
    rd.DepthClipEnable = TRUE;
    hr = device->CreateRasterizerState(&rd, &rasterizer_);
    if (FAILED(hr)) { shutdown(); return false; }

    D3D11_BLEND_DESC bld = {};
    bld.RenderTarget[0].BlendEnable           = FALSE;
    bld.RenderTarget[0].RenderTargetWriteMask = D3D11_COLOR_WRITE_ENABLE_ALL;
    hr = device->CreateBlendState(&bld, &blend_);
    if (FAILED(hr)) { shutdown(); return false; }

    D3D11_DEPTH_STENCIL_DESC dsd = {};
    dsd.DepthEnable   = FALSE;
    dsd.StencilEnable = FALSE;
    hr = device->CreateDepthStencilState(&dsd, &depthStencil_);
    if (FAILED(hr)) { shutdown(); return false; }

    ready_ = true;
    std::fprintf(stderr, "[Nv12Converter] ready: hardware-decoded frames stay on the GPU "
                         "(NV12 -> BGRA shader)\n");
    return true;
}

void Nv12Converter::shutdown()
{
    vs_.Reset();
    ps_.Reset();
    sampler_.Reset();
    constants_.Reset();
    rasterizer_.Reset();
    blend_.Reset();
    depthStencil_.Reset();
    ready_ = false;
}

// ===========================================================================
// NV12 target + plane views
// ===========================================================================

bool Nv12Converter::createNv12Target(ID3D11Device* device, int w, int h,
                                     Microsoft::WRL::ComPtr<ID3D11Texture2D>& tex,
                                     Microsoft::WRL::ComPtr<ID3D11ShaderResourceView>& lumaSrv,
                                     Microsoft::WRL::ComPtr<ID3D11ShaderResourceView>& chromaSrv)
{
    tex.Reset();
    lumaSrv.Reset();
    chromaSrv.Reset();
    if (!device || w <= 0 || h <= 0 || (w & 1) || (h & 1)) return false;

    D3D11_TEXTURE2D_DESC td = {};
    td.Width            = static_cast<UINT>(w);
    td.Height           = static_cast<UINT>(h);
    td.MipLevels        = 1;
    td.ArraySize        = 1;
    td.Format           = DXGI_FORMAT_NV12;
    td.SampleDesc.Count = 1;
    td.Usage            = D3D11_USAGE_DEFAULT;
    td.BindFlags        = D3D11_BIND_SHADER_RESOURCE;

    HRESULT hr = device->CreateTexture2D(&td, nullptr, &tex);
    if (FAILED(hr)) {
        std::fprintf(stderr, "[Nv12Converter] NV12 texture %dx%d failed HR=0x%08X\n",
                     w, h, static_cast<unsigned int>(hr));
        return false;
    }

    D3D11_SHADER_RESOURCE_VIEW_DESC sv = {};
    sv.ViewDimension       = D3D11_SRV_DIMENSION_TEXTURE2D;
    sv.Texture2D.MipLevels = 1;

    sv.Format = DXGI_FORMAT_R8_UNORM;          // plane 0: Y
    hr = device->CreateShaderResourceView(tex.Get(), &sv, &lumaSrv);
    if (FAILED(hr)) {
        std::fprintf(stderr, "[Nv12Converter] R8 luma view failed HR=0x%08X\n",
                     static_cast<unsigned int>(hr));
        tex.Reset();
        return false;
    }
    sv.Format = DXGI_FORMAT_R8G8_UNORM;        // plane 1: interleaved CbCr
    hr = device->CreateShaderResourceView(tex.Get(), &sv, &chromaSrv);
    if (FAILED(hr)) {
        std::fprintf(stderr, "[Nv12Converter] R8G8 chroma view failed HR=0x%08X\n",
                     static_cast<unsigned int>(hr));
        lumaSrv.Reset();
        tex.Reset();
        return false;
    }
    return true;
}

// ===========================================================================
// Conversion draw
// ===========================================================================

namespace {

// Every pipeline slot convert() writes, captured before and put back after.
// The decoder runs between frames in practice, but nothing here should depend
// on that: the compositor's own bindings must survive a decode untouched.
struct SavedState {
    ID3D11RenderTargetView*   rtv            = nullptr;
    ID3D11DepthStencilView*   dsv            = nullptr;
    D3D11_VIEWPORT            viewports[D3D11_VIEWPORT_AND_SCISSORRECT_OBJECT_COUNT_PER_PIPELINE] = {};
    UINT                      viewportCount  = 0;
    ID3D11InputLayout*        inputLayout    = nullptr;
    D3D11_PRIMITIVE_TOPOLOGY  topology       = D3D11_PRIMITIVE_TOPOLOGY_UNDEFINED;
    ID3D11VertexShader*       vs             = nullptr;
    ID3D11PixelShader*        ps             = nullptr;
    ID3D11ShaderResourceView* srvs[2]        = {};
    ID3D11SamplerState*       sampler        = nullptr;
    ID3D11Buffer*             psConstants    = nullptr;
    ID3D11RasterizerState*    rasterizer     = nullptr;
    ID3D11BlendState*         blend          = nullptr;
    float                     blendFactor[4] = {};
    UINT                      sampleMask     = 0xFFFFFFFF;
    ID3D11DepthStencilState*  depthStencil   = nullptr;
    UINT                      stencilRef     = 0;

    void capture(ID3D11DeviceContext* ctx)
    {
        ctx->OMGetRenderTargets(1, &rtv, &dsv);
        viewportCount = D3D11_VIEWPORT_AND_SCISSORRECT_OBJECT_COUNT_PER_PIPELINE;
        ctx->RSGetViewports(&viewportCount, viewports);
        ctx->IAGetInputLayout(&inputLayout);
        ctx->IAGetPrimitiveTopology(&topology);
        ctx->VSGetShader(&vs, nullptr, nullptr);
        ctx->PSGetShader(&ps, nullptr, nullptr);
        ctx->PSGetShaderResources(0, 2, srvs);
        ctx->PSGetSamplers(0, 1, &sampler);
        ctx->PSGetConstantBuffers(0, 1, &psConstants);
        ctx->RSGetState(&rasterizer);
        ctx->OMGetBlendState(&blend, blendFactor, &sampleMask);
        ctx->OMGetDepthStencilState(&depthStencil, &stencilRef);
    }

    void restore(ID3D11DeviceContext* ctx)
    {
        // Unbind our views first: the BGRA target we just drew into is about
        // to be sampled by the caller, and the planes must not linger in t0/t1.
        ID3D11ShaderResourceView* nulls[2] = {};
        ctx->PSSetShaderResources(0, 2, nulls);
        ID3D11RenderTargetView* nullRtv = nullptr;
        ctx->OMSetRenderTargets(1, &nullRtv, nullptr);

        ctx->OMSetRenderTargets(1, &rtv, dsv);
        if (viewportCount > 0) ctx->RSSetViewports(viewportCount, viewports);
        ctx->IASetInputLayout(inputLayout);
        ctx->IASetPrimitiveTopology(topology);
        ctx->VSSetShader(vs, nullptr, 0);
        ctx->PSSetShader(ps, nullptr, 0);
        ctx->PSSetShaderResources(0, 2, srvs);
        ctx->PSSetSamplers(0, 1, &sampler);
        ctx->PSSetConstantBuffers(0, 1, &psConstants);
        ctx->RSSetState(rasterizer);
        ctx->OMSetBlendState(blend, blendFactor, sampleMask);
        ctx->OMSetDepthStencilState(depthStencil, stencilRef);
        release();
    }

    void release()
    {
        auto rel = [](IUnknown* p) { if (p) p->Release(); };
        rel(rtv); rel(dsv); rel(inputLayout); rel(vs); rel(ps);
        rel(srvs[0]); rel(srvs[1]); rel(sampler); rel(psConstants);
        rel(rasterizer); rel(blend); rel(depthStencil);
        *this = SavedState{};
    }
};

} // namespace

bool Nv12Converter::convert(ID3D11Device* device, ID3D11DeviceContext* ctx,
                            ID3D11ShaderResourceView* lumaSrv,
                            ID3D11ShaderResourceView* chromaSrv,
                            const Params& p,
                            Microsoft::WRL::ComPtr<ID3D11Texture2D>& outTexture,
                            Microsoft::WRL::ComPtr<ID3D11ShaderResourceView>& outSrv)
{
    outTexture.Reset();
    outSrv.Reset();
    if (!ready_ || !device || !ctx || !lumaSrv || !chromaSrv) return false;
    if (p.dstWidth <= 0 || p.dstHeight <= 0) return false;

    // Destination: the BGRA texture the frame cache will own. RENDER_TARGET is
    // the only bind flag the CPU path's texture did not carry; every consumer
    // samples it exactly as before.
    D3D11_TEXTURE2D_DESC td = {};
    td.Width            = static_cast<UINT>(p.dstWidth);
    td.Height           = static_cast<UINT>(p.dstHeight);
    td.MipLevels        = 1;
    td.ArraySize        = 1;
    td.Format           = DXGI_FORMAT_B8G8R8A8_UNORM;
    td.SampleDesc.Count = 1;
    td.Usage            = D3D11_USAGE_DEFAULT;
    td.BindFlags        = D3D11_BIND_SHADER_RESOURCE | D3D11_BIND_RENDER_TARGET;

    Microsoft::WRL::ComPtr<ID3D11Texture2D> tex;
    HRESULT hr = device->CreateTexture2D(&td, nullptr, &tex);
    if (FAILED(hr)) {
        std::fprintf(stderr, "[Nv12Converter] BGRA target %dx%d failed HR=0x%08X\n",
                     p.dstWidth, p.dstHeight, static_cast<unsigned int>(hr));
        return false;
    }

    Microsoft::WRL::ComPtr<ID3D11RenderTargetView> rtv;
    hr = device->CreateRenderTargetView(tex.Get(), nullptr, &rtv);
    if (FAILED(hr)) {
        std::fprintf(stderr, "[Nv12Converter] RTV failed HR=0x%08X\n", static_cast<unsigned int>(hr));
        return false;
    }

    D3D11_SHADER_RESOURCE_VIEW_DESC sv = {};
    sv.Format                    = DXGI_FORMAT_B8G8R8A8_UNORM;
    sv.ViewDimension             = D3D11_SRV_DIMENSION_TEXTURE2D;
    sv.Texture2D.MostDetailedMip = 0;
    sv.Texture2D.MipLevels       = 1;
    Microsoft::WRL::ComPtr<ID3D11ShaderResourceView> srv;
    hr = device->CreateShaderResourceView(tex.Get(), &sv, &srv);
    if (FAILED(hr)) {
        std::fprintf(stderr, "[Nv12Converter] SRV failed HR=0x%08X\n", static_cast<unsigned int>(hr));
        return false;
    }

    // Matrix rows for this frame's colour tags.
    {
        D3D11_MAPPED_SUBRESOURCE mapped;
        hr = ctx->Map(constants_.Get(), 0, D3D11_MAP_WRITE_DISCARD, 0, &mapped);
        if (FAILED(hr)) return false;
        float cb[16];
        yuvToRgbRows(p.matrix, p.fullRange, cb);
        cb[12] = p.chromaShiftU;
        cb[13] = p.chromaShiftV;
        cb[14] = 0.0f;
        cb[15] = 0.0f;
        std::memcpy(mapped.pData, cb, sizeof(cb));
        ctx->Unmap(constants_.Get(), 0);
    }

    SavedState saved;
    saved.capture(ctx);

    // The target cannot also be bound as an input anywhere — it is brand new —
    // but the slots we are about to fill may hold whatever the caller left.
    ID3D11ShaderResourceView* nulls[2] = {};
    ctx->PSSetShaderResources(0, 2, nulls);

    ID3D11RenderTargetView* rtvs[1] = { rtv.Get() };
    ctx->OMSetRenderTargets(1, rtvs, nullptr);

    D3D11_VIEWPORT vp = {};
    vp.Width    = static_cast<float>(p.dstWidth);
    vp.Height   = static_cast<float>(p.dstHeight);
    vp.MaxDepth = 1.0f;
    ctx->RSSetViewports(1, &vp);

    ctx->IASetInputLayout(nullptr);
    ctx->IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
    ctx->VSSetShader(vs_.Get(), nullptr, 0);
    ctx->PSSetShader(ps_.Get(), nullptr, 0);
    ID3D11ShaderResourceView* planes[2] = { lumaSrv, chromaSrv };
    ctx->PSSetShaderResources(0, 2, planes);
    ctx->PSSetSamplers(0, 1, sampler_.GetAddressOf());
    ctx->PSSetConstantBuffers(0, 1, constants_.GetAddressOf());
    ctx->RSSetState(rasterizer_.Get());
    const float blendFactor[4] = { 0, 0, 0, 0 };
    ctx->OMSetBlendState(blend_.Get(), blendFactor, 0xFFFFFFFF);
    ctx->OMSetDepthStencilState(depthStencil_.Get(), 0);

    ctx->Draw(3, 0);

    saved.restore(ctx);

    outTexture = tex;
    outSrv     = srv;
    return true;
}
