#include "GpuDeviceManager.h"

#include <algorithm>
#include <cstdio>
#include <cstdlib>   // std::getenv
#include <cstring>   // std::strcmp

// Link against D3D11 and DXGI (pragma lib — MSVC only, avoids CMake changes
// for consumers that only include the header).
#pragma comment(lib, "d3d11.lib")
#pragma comment(lib, "dxgi.lib")

// ===========================================================================
// Construction / destruction
// ===========================================================================

GpuDeviceManager::GpuDeviceManager()  = default;
GpuDeviceManager::~GpuDeviceManager() = default;

// ===========================================================================
// Adapter enumeration
// ===========================================================================

bool GpuDeviceManager::detectAdapters()
{
    adapters_.clear();
    factory_.Reset();

    HRESULT hr = CreateDXGIFactory1(__uuidof(IDXGIFactory1),
                                    reinterpret_cast<void**>(factory_.GetAddressOf()));
    GPU_HR_CHECK(hr, "CreateDXGIFactory1");

    Microsoft::WRL::ComPtr<IDXGIAdapter1> adapter;
    for (UINT i = 0; factory_->EnumAdapters1(i, adapter.ReleaseAndGetAddressOf()) != DXGI_ERROR_NOT_FOUND; ++i) {
        DXGI_ADAPTER_DESC1 desc{};
        hr = adapter->GetDesc1(&desc);
        if (FAILED(hr)) {
            std::fprintf(stderr, "[GpuDevice] WARNING: GetDesc1 failed for adapter %u HRESULT=0x%08X\n",
                         i, static_cast<unsigned int>(hr));
            continue;
        }

        // Skip software adapters (Microsoft Basic Render Driver)
        if (desc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE)
            continue;

        GpuAdapterInfo info;
        info.name                  = desc.Description;
        info.vendorId              = desc.VendorId;
        info.deviceId              = desc.DeviceId;
        info.dedicatedVideoMemoryMB = desc.DedicatedVideoMemory / (1024 * 1024);
        info.sharedSystemMemoryMB  = desc.SharedSystemMemory / (1024 * 1024);
        info.adapterIndex          = static_cast<int>(i);
        info.isDiscrete            = (desc.DedicatedVideoMemory > 256ULL * 1024 * 1024);
        info.isDefault             = false;
        // LUID — DXGI returns LONG/DWORD; reinterpret HighPart as unsigned for
        // a stable JS round-trip (we never do arithmetic on it).
        info.luidHighPart          = static_cast<uint32_t>(desc.AdapterLuid.HighPart);
        info.luidLowPart           = desc.AdapterLuid.LowPart;

        std::fprintf(stderr, "[GpuDevice] Found adapter %d: '%ls' vendor=0x%04X device=0x%04X vram=%zuMB shared=%zuMB luid=%08X:%08X discrete=%s\n",
                     info.adapterIndex,
                     info.name.c_str(),
                     info.vendorId,
                     info.deviceId,
                     info.dedicatedVideoMemoryMB,
                     info.sharedSystemMemoryMB,
                     info.luidHighPart,
                     info.luidLowPart,
                     info.isDiscrete ? "yes" : "no");

        adapters_.push_back(std::move(info));
    }

    if (adapters_.empty()) {
        std::fprintf(stderr, "[GpuDevice] ERROR: No DXGI adapters found\n");
        return false;
    }

    rankAdapters();
    return true;
}

uint64_t GpuDeviceManager::queryMaxDedicatedVramBytes()
{
    // Standalone enumeration — does not touch the instance's factory_/adapters_,
    // so it can run before any GpuDeviceManager exists. ComPtr releases on scope
    // exit, so no manual cleanup is needed on any return path.
    Microsoft::WRL::ComPtr<IDXGIFactory1> factory;
    HRESULT hr = CreateDXGIFactory1(__uuidof(IDXGIFactory1),
                                    reinterpret_cast<void**>(factory.GetAddressOf()));
    if (FAILED(hr) || !factory)
        return 0;

    uint64_t maxVram = 0;
    Microsoft::WRL::ComPtr<IDXGIAdapter1> adapter;
    for (UINT i = 0; factory->EnumAdapters1(i, adapter.ReleaseAndGetAddressOf()) != DXGI_ERROR_NOT_FOUND; ++i) {
        DXGI_ADAPTER_DESC1 desc{};
        if (FAILED(adapter->GetDesc1(&desc)))
            continue;
        if (desc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE)   // skip Basic Render Driver
            continue;
        if (desc.DedicatedVideoMemory > maxVram)
            maxVram = desc.DedicatedVideoMemory;
    }
    return maxVram;
}

void GpuDeviceManager::rankAdapters()
{
    // Sort: discrete first, then by VRAM descending
    std::stable_sort(adapters_.begin(), adapters_.end(),
        [](const GpuAdapterInfo& a, const GpuAdapterInfo& b) {
            if (a.isDiscrete != b.isDiscrete)
                return a.isDiscrete;   // discrete sorts before integrated
            return a.dedicatedVideoMemoryMB > b.dedicatedVideoMemoryMB;
        });

    // Mark highest-ranked as default
    for (auto& a : adapters_) a.isDefault = false;
    if (!adapters_.empty()) {
        adapters_[0].isDefault = true;
        std::fprintf(stderr, "[GpuDevice] Ranked %zu adapters. Default: '%ls' (index %d)\n",
                     adapters_.size(),
                     adapters_[0].name.c_str(),
                     adapters_[0].adapterIndex);
    }
}

int GpuDeviceManager::getDefaultAdapterIndex() const
{
    for (const auto& a : adapters_)
        if (a.isDefault)
            return a.adapterIndex;
    return -1;
}

// ===========================================================================
// Device creation
// ===========================================================================

bool GpuDeviceManager::createDevice(int adapterIndex)
{
    // Release any existing device
    context_.Reset();
    device_.Reset();
    activeAdapterIndex_ = -1;

    if (adapters_.empty()) {
        std::fprintf(stderr, "[GpuDevice] ERROR: No adapters detected — call detectAdapters() first\n");
        return false;
    }

    // Resolve -1 to default
    if (adapterIndex < 0)
        adapterIndex = getDefaultAdapterIndex();

    // Find the DXGI adapter by its original enumeration index
    Microsoft::WRL::ComPtr<IDXGIAdapter1> chosenAdapter;
    HRESULT hr = factory_->EnumAdapters1(static_cast<UINT>(adapterIndex),
                                         chosenAdapter.GetAddressOf());
    GPU_HR_CHECK(hr, "EnumAdapters1 (chosen adapter)");

    // Find the adapter info for logging
    const GpuAdapterInfo* info = nullptr;
    for (const auto& a : adapters_) {
        if (a.adapterIndex == adapterIndex) {
            info = &a;
            break;
        }
    }

    // ── Diagnostic launch switches (one-run, NOT shipping behaviour) ─────────
    // XLETH_D3D11_WARP=1        → force the WARP software rasterizer so a tester
    //                             can prove whether the failure is hardware-driver
    //                             specific. Ignores the chosen DXGI adapter.
    // XLETH_D3D11_DEBUG_LAYER=1 → request D3D11_CREATE_DEVICE_DEBUG; if the SDK
    //                             debug layer is unavailable we retry without it
    //                             and continue (never crash).
    auto envOn = [](const char* n) {
        const char* v = std::getenv(n);
        return v && v[0] && std::strcmp(v, "0") != 0;
    };
    const bool forceWarp     = envOn("XLETH_D3D11_WARP");
    const bool wantDebugLayer = envOn("XLETH_D3D11_DEBUG_LAYER");

    // Build creation flags
    UINT flags = D3D11_CREATE_DEVICE_VIDEO_SUPPORT;
    bool requestDebug = false;
#ifdef _DEBUG
    requestDebug = true;
#endif
    if (wantDebugLayer) requestDebug = true;
    if (requestDebug) flags |= D3D11_CREATE_DEVICE_DEBUG;

    // WARP must be created with DRIVER_TYPE_WARP and a NULL adapter; VIDEO_SUPPORT
    // is not meaningful on WARP, so drop it to avoid a create failure.
    IDXGIAdapter1*     createAdapter = forceWarp ? nullptr : chosenAdapter.Get();
    const D3D_DRIVER_TYPE driverType = forceWarp ? D3D_DRIVER_TYPE_WARP
                                                 : D3D_DRIVER_TYPE_UNKNOWN;
    if (forceWarp) flags &= ~D3D11_CREATE_DEVICE_VIDEO_SUPPORT;

    std::fprintf(stderr,
        "[GpuDevice] Creating D3D11 device on adapter %d ('%ls') featureLevel=11_0 "
        "flags=0x%X driverType=%s%s%s\n",
        adapterIndex, info ? info->name.c_str() : L"unknown", flags,
        forceWarp ? "WARP" : "UNKNOWN",
        forceWarp ? " [XLETH_D3D11_WARP]" : "",
        wantDebugLayer ? " [XLETH_D3D11_DEBUG_LAYER]" : "");

    D3D_FEATURE_LEVEL requestedLevel = D3D_FEATURE_LEVEL_11_0;
    D3D_FEATURE_LEVEL actualLevel    = D3D_FEATURE_LEVEL_11_0;

    auto tryCreate = [&](UINT createFlags) -> HRESULT {
        return D3D11CreateDevice(
            createAdapter, driverType, nullptr, createFlags,
            &requestedLevel, 1, D3D11_SDK_VERSION,
            device_.GetAddressOf(), &actualLevel, context_.GetAddressOf());
    };

    hr = tryCreate(flags);

    // If the debug layer was requested but is not installed, the call fails with
    // DXGI_ERROR_SDK_COMPONENT_MISSING / E_FAIL — retry without it.
    if (FAILED(hr) && (flags & D3D11_CREATE_DEVICE_DEBUG)) {
        std::fprintf(stderr,
            "[GpuDevice] D3D11 debug layer unavailable (HRESULT=0x%08X) — retrying "
            "without D3D11_CREATE_DEVICE_DEBUG\n", static_cast<unsigned int>(hr));
        requestDebug = false;
        flags &= ~D3D11_CREATE_DEVICE_DEBUG;
        hr = tryCreate(flags);
    }

    if (FAILED(hr)) {
        std::fprintf(stderr, "[GpuDevice] ERROR: D3D11CreateDevice failed. HRESULT=0x%08X adapter=%d\n",
                     static_cast<unsigned int>(hr), adapterIndex);
        return false;
    }

    activeAdapterIndex_ = adapterIndex;
    activeFeatureLevel_ = static_cast<uint32_t>(actualLevel);
    isWarp_             = forceWarp;
    debugLayerActive_   = requestDebug && (flags & D3D11_CREATE_DEVICE_DEBUG) != 0;

    // Enable multi-thread protection
    bool mtOk = enableMultithreadProtection();

    std::fprintf(stderr, "[GpuDevice] Device created successfully. VideoSupport=%s MultithreadProtected=%s\n",
                 (flags & D3D11_CREATE_DEVICE_VIDEO_SUPPORT) ? "yes" : "no",
                 mtOk ? "yes" : "no");

    return true;
}

// ===========================================================================
// Multi-thread protection
// ===========================================================================

bool GpuDeviceManager::enableMultithreadProtection()
{
    if (!device_) return false;

    Microsoft::WRL::ComPtr<ID3D11Multithread> mt;
    HRESULT hr = device_.As(&mt);
    if (FAILED(hr)) {
        std::fprintf(stderr, "[GpuDevice] WARNING: QueryInterface(ID3D11Multithread) failed HRESULT=0x%08X\n",
                     static_cast<unsigned int>(hr));
        return false;
    }

    mt->SetMultithreadProtected(TRUE);
    return true;
}
