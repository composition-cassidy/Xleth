#pragma once

/**
 * GpuDeviceManager — D3D11 device creation and DXGI adapter enumeration.
 *
 * Enumerates DXGI adapters, ranks discrete GPUs first, creates a D3D11 device
 * with VIDEO_SUPPORT flag (required for D3D11VA decode) and multi-thread
 * protection (required because FFmpeg decode thread and compositor render
 * thread share the same device).
 *
 * NOT a singleton — pass by reference to consumers (compositor, decoder).
 * Created once during engine init; device can be recreated if the user
 * switches GPU in settings.
 */

#include <cstdint>
#include <string>
#include <vector>

// Prevent windows.h min/max macros from breaking std::numeric_limits<>::max()
#ifndef NOMINMAX
    #define NOMINMAX
#endif
#include <d3d11_4.h>      // ID3D11Device, ID3D11Multithread
#include <dxgi1_2.h>
#include <wrl/client.h>   // Microsoft::WRL::ComPtr

// ---------------------------------------------------------------------------
// HRESULT check macro — logs and returns false on failure
// ---------------------------------------------------------------------------
#define GPU_HR_CHECK(hr, msg)                                                    \
    do {                                                                          \
        if (FAILED(hr)) {                                                         \
            std::fprintf(stderr, "[GpuDevice] ERROR: %s HRESULT=0x%08X\n",       \
                         (msg), static_cast<unsigned int>(hr));                    \
            return false;                                                         \
        }                                                                         \
    } while (0)

// ---------------------------------------------------------------------------
// GpuAdapterInfo — describes one DXGI adapter
// ---------------------------------------------------------------------------
struct GpuAdapterInfo {
    std::wstring name;
    uint32_t     vendorId              = 0;
    uint32_t     deviceId              = 0;
    size_t       dedicatedVideoMemoryMB = 0;
    size_t       sharedSystemMemoryMB   = 0;
    int          adapterIndex          = -1;
    bool         isDiscrete            = false;   // dedicatedVideoMemory > 256 MB
    bool         isDefault             = false;   // highest-ranked adapter
    // DXGI AdapterLuid — needed to verify D3D11 and Chromium/ANGLE picked the
    // same physical adapter. LUID is a 64-bit kernel-namespace handle; we
    // split it into two 32-bit halves so it survives JS Number round-trips.
    uint32_t     luidHighPart          = 0;       // signed in DXGI; reinterpreted as u32
    uint32_t     luidLowPart           = 0;
};

// Vendor ID constants
namespace GpuVendor {
    inline constexpr uint32_t Intel  = 0x8086;
    inline constexpr uint32_t NVIDIA = 0x10DE;
    inline constexpr uint32_t AMD    = 0x1002;
}

// ---------------------------------------------------------------------------
// GpuDeviceManager
// ---------------------------------------------------------------------------
class GpuDeviceManager
{
public:
    GpuDeviceManager();
    ~GpuDeviceManager();

    // Non-copyable, non-movable (COM pointers + lifecycle)
    GpuDeviceManager(const GpuDeviceManager&)            = delete;
    GpuDeviceManager& operator=(const GpuDeviceManager&) = delete;

    // ── Adapter enumeration ─────────────────────────────────────────────────

    /** Enumerate DXGI adapters and rank them (discrete first). */
    bool detectAdapters();

    /** Cached adapter list from the last detectAdapters() call. */
    const std::vector<GpuAdapterInfo>& getAdapters() const { return adapters_; }

    /** Index of the highest-ranked (default) adapter, or -1 if none. */
    int getDefaultAdapterIndex() const;

    // ── Device creation ─────────────────────────────────────────────────────

    /**
     * Create D3D11 device on the given adapter index.
     * Pass -1 to use the default (highest-ranked) adapter.
     * Destroys any existing device first.
     */
    bool createDevice(int adapterIndex = -1);

    /** True if a D3D11 device has been successfully created. */
    bool hasDevice() const { return device_ != nullptr; }

    /** The active adapter index, or -1 if no device. */
    int getActiveAdapterIndex() const { return activeAdapterIndex_; }

    // ── Device diagnostics (populated by createDevice) ──────────────────────
    /** Achieved D3D_FEATURE_LEVEL as a raw value (e.g. 0xb000 == 11_0), 0 if none. */
    uint32_t getActiveFeatureLevel() const { return activeFeatureLevel_; }
    /** True if the device was created as a WARP (software) rasterizer.
     *  Only happens when XLETH_D3D11_WARP=1 — diagnostic use only. */
    bool isWarpDevice() const { return isWarp_; }
    /** True if the D3D11 debug layer is active on the device (XLETH_D3D11_DEBUG_LAYER=1
     *  or a _DEBUG build, and the SDK layer was actually available). */
    bool isDebugLayerActive() const { return debugLayerActive_; }

    // ── Device accessors (downstream consumers use these) ───────────────────

    ID3D11Device*        getDevice()  const { return device_.Get(); }
    ID3D11DeviceContext* getContext() const { return context_.Get(); }

private:
    // ── Adapter cache ───────────────────────────────────────────────────────
    std::vector<GpuAdapterInfo>                           adapters_;
    Microsoft::WRL::ComPtr<IDXGIFactory1>                 factory_;

    // ── D3D11 device ────────────────────────────────────────────────────────
    Microsoft::WRL::ComPtr<ID3D11Device>        device_;
    Microsoft::WRL::ComPtr<ID3D11DeviceContext> context_;
    int                                         activeAdapterIndex_ = -1;
    uint32_t                                    activeFeatureLevel_ = 0;
    bool                                        isWarp_           = false;
    bool                                        debugLayerActive_ = false;

    // ── Helpers ─────────────────────────────────────────────────────────────
    void rankAdapters();
    bool enableMultithreadProtection();
};
