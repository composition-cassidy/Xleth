#include "GpuDeviceManager.h"

#include <algorithm>
#include <cstdio>

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

    // Build creation flags
    UINT flags = D3D11_CREATE_DEVICE_VIDEO_SUPPORT;
#ifdef _DEBUG
    flags |= D3D11_CREATE_DEVICE_DEBUG;
#endif

    std::fprintf(stderr, "[GpuDevice] Creating D3D11 device on adapter %d ('%ls') featureLevel=11_0 flags=0x%X\n",
                 adapterIndex,
                 info ? info->name.c_str() : L"unknown",
                 flags);

    D3D_FEATURE_LEVEL requestedLevel = D3D_FEATURE_LEVEL_11_0;
    D3D_FEATURE_LEVEL actualLevel    = D3D_FEATURE_LEVEL_11_0;

    hr = D3D11CreateDevice(
        chosenAdapter.Get(),         // adapter (nullptr = default)
        D3D_DRIVER_TYPE_UNKNOWN,     // must be UNKNOWN when pAdapter is non-null
        nullptr,                     // no software rasterizer
        flags,
        &requestedLevel, 1,          // feature level 11_0
        D3D11_SDK_VERSION,
        device_.GetAddressOf(),
        &actualLevel,
        context_.GetAddressOf()
    );

    if (FAILED(hr)) {
        std::fprintf(stderr, "[GpuDevice] ERROR: D3D11CreateDevice failed. HRESULT=0x%08X adapter=%d\n",
                     static_cast<unsigned int>(hr), adapterIndex);
        return false;
    }

    activeAdapterIndex_ = adapterIndex;

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
