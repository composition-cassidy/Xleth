// test_frame_cache.cpp — Verifies the render-pipeline LRU FrameCache
// Uses real D3D11 textures created on the GPU.

#include "render/FrameCache.h"
#include "render/GpuDeviceManager.h"
#include <cassert>
#include <cstdio>

static ID3D11Device* g_device = nullptr;

static FrameCacheEntry makeEntry(int w, int h)
{
    D3D11_TEXTURE2D_DESC desc = {};
    desc.Width            = static_cast<UINT>(w);
    desc.Height           = static_cast<UINT>(h);
    desc.MipLevels        = 1;
    desc.ArraySize        = 1;
    desc.Format           = DXGI_FORMAT_B8G8R8A8_UNORM;
    desc.SampleDesc.Count = 1;
    desc.Usage            = D3D11_USAGE_DEFAULT;
    desc.BindFlags        = D3D11_BIND_SHADER_RESOURCE;

    FrameCacheEntry entry;
    HRESULT hr = g_device->CreateTexture2D(&desc, nullptr, entry.texture.GetAddressOf());
    assert(SUCCEEDED(hr) && "CreateTexture2D failed");
    hr = g_device->CreateShaderResourceView(entry.texture.Get(), nullptr, entry.srv.GetAddressOf());
    assert(SUCCEEDED(hr) && "CreateShaderResourceView failed");
    entry.width           = w;
    entry.height          = h;
    entry.memorySizeBytes = static_cast<size_t>(w) * h * 4;
    return entry;
}

int main()
{
    std::fprintf(stderr, "[TEST:FrameCache] Starting cache tests...\n");

    // ── GPU setup ────────────────────────────────────────────────────────────
    GpuDeviceManager gpu;
    if (!gpu.detectAdapters()) {
        std::fprintf(stderr, "[TEST:FrameCache] SKIP: no DXGI adapters\n");
        return 0;
    }
    if (!gpu.createDevice()) {
        std::fprintf(stderr, "[TEST:FrameCache] SKIP: D3D11 device creation failed\n");
        return 0;
    }
    g_device = gpu.getDevice();
    assert(g_device);
    std::fprintf(stderr, "[TEST:FrameCache] GPU device ready\n");

    // ── Test 1: put and get ─────────────────────────────────────────────────
    {
        RenderFrameCache cache;
        cache.setMemoryLimit(50 * 1024 * 1024);  // 50 MB

        cache.put({"video.mp4", 100}, makeEntry(64, 64));
        auto* result = cache.get({"video.mp4", 100});
        assert(result != nullptr);
        assert(result->width == 64 && result->height == 64);
        std::fprintf(stderr, "[TEST:FrameCache] Test 1 — Put+Get: PASSED\n");
    }

    // ── Test 2: miss ────────────────────────────────────────────────────────
    {
        RenderFrameCache cache;
        cache.setMemoryLimit(50 * 1024 * 1024);

        cache.put({"video.mp4", 100}, makeEntry(64, 64));
        auto* result = cache.get({"video.mp4", 999});
        assert(result == nullptr);
        std::fprintf(stderr, "[TEST:FrameCache] Test 2 — Miss: PASSED\n");
    }

    // ── Test 3: composite key — same frame, different source ────────────────
    {
        RenderFrameCache cache;
        cache.setMemoryLimit(50 * 1024 * 1024);

        cache.put({"video.mp4", 100}, makeEntry(64, 64));
        cache.put({"other.mp4", 100}, makeEntry(64, 64));

        auto* r1 = cache.get({"other.mp4", 100});
        assert(r1 != nullptr);
        auto* r2 = cache.get({"video.mp4", 100});
        assert(r2 != nullptr);
        assert(r1 != r2);  // different entries
        std::fprintf(stderr, "[TEST:FrameCache] Test 3 — Composite key: PASSED\n");
    }

    // ── Test 4: LRU eviction (memory-limited) ──────────────────────────────
    {
        // 64x64 BGRA = 16384 bytes per entry
        // Set limit to hold ~3 entries
        RenderFrameCache cache;
        cache.setMemoryLimit(64 * 64 * 4 * 3);

        cache.put({"a.mp4", 1}, makeEntry(64, 64));
        cache.put({"a.mp4", 2}, makeEntry(64, 64));
        cache.put({"a.mp4", 3}, makeEntry(64, 64));

        // Verify all 3 present
        assert(cache.get({"a.mp4", 1}) != nullptr);
        assert(cache.get({"a.mp4", 2}) != nullptr);
        assert(cache.get({"a.mp4", 3}) != nullptr);
        // Access order is now: 3 (MRU), 2, 1 (LRU)

        // Adding a 4th should evict the LRU (frame 1 — last accessed earliest after the gets reorder)
        // Actually after the three gets above, order is: 3, 2, 1.
        // Now insert frame 4 — over capacity, evicts frame 1 (LRU = back of list)
        cache.put({"a.mp4", 4}, makeEntry(64, 64));

        auto* evicted = cache.get({"a.mp4", 1});
        assert(evicted == nullptr && "Frame 1 should have been evicted");

        // Frame 2, 3, 4 should still be present
        assert(cache.get({"a.mp4", 2}) != nullptr);
        assert(cache.get({"a.mp4", 3}) != nullptr);
        assert(cache.get({"a.mp4", 4}) != nullptr);

        auto stats = cache.getStats();
        assert(stats.evictionCount >= 1);
        std::fprintf(stderr, "[TEST:FrameCache] Test 4 — LRU eviction: PASSED (evictions=%llu)\n",
                     (unsigned long long)stats.evictionCount);
    }

    // ── Test 5: frame-count-limited mode ────────────────────────────────────
    {
        RenderFrameCache cache;
        cache.setFrameLimit(2);

        cache.put({"b.mp4", 1}, makeEntry(64, 64));
        cache.put({"b.mp4", 2}, makeEntry(64, 64));
        cache.put({"b.mp4", 3}, makeEntry(64, 64));  // should evict frame 1

        assert(cache.get({"b.mp4", 1}) == nullptr);
        assert(cache.get({"b.mp4", 2}) != nullptr);
        assert(cache.get({"b.mp4", 3}) != nullptr);
        std::fprintf(stderr, "[TEST:FrameCache] Test 5 — Frame-count limit: PASSED\n");
    }

    // ── Test 6: MRU promotion prevents eviction ────────────────────────────
    {
        RenderFrameCache cache;
        cache.setMemoryLimit(64 * 64 * 4 * 3);

        cache.put({"c.mp4", 1}, makeEntry(64, 64));
        cache.put({"c.mp4", 2}, makeEntry(64, 64));
        cache.put({"c.mp4", 3}, makeEntry(64, 64));

        // Touch frame 1 to make it MRU
        cache.get({"c.mp4", 1});
        // LRU order is now: 1 (MRU), 3, 2 (LRU)

        // Adding frame 4 should evict frame 2 (the LRU), NOT frame 1
        cache.put({"c.mp4", 4}, makeEntry(64, 64));

        assert(cache.get({"c.mp4", 1}) != nullptr && "Frame 1 was promoted, should survive");
        assert(cache.get({"c.mp4", 2}) == nullptr && "Frame 2 was LRU, should be evicted");
        std::fprintf(stderr, "[TEST:FrameCache] Test 6 — MRU promotion: PASSED\n");
    }

    // ── Test 7: clear ───────────────────────────────────────────────────────
    {
        RenderFrameCache cache;
        cache.put({"d.mp4", 1}, makeEntry(64, 64));
        cache.put({"d.mp4", 2}, makeEntry(64, 64));
        cache.clear();

        auto stats = cache.getStats();
        assert(stats.currentEntries == 0);
        assert(stats.currentBytes == 0);
        assert(cache.get({"d.mp4", 1}) == nullptr);
        std::fprintf(stderr, "[TEST:FrameCache] Test 7 — Clear: PASSED\n");
    }

    // ── Test 8: memory tracking accuracy ────────────────────────────────────
    {
        RenderFrameCache cache;
        cache.setMemoryLimit(1024 * 1024 * 1024);  // 1 GB — no eviction

        cache.put({"e.mp4", 1}, makeEntry(100, 100));  // 40000 bytes
        cache.put({"e.mp4", 2}, makeEntry(200, 200));  // 160000 bytes

        auto stats = cache.getStats();
        assert(stats.currentBytes == 40000 + 160000);
        assert(stats.currentEntries == 2);

        cache.clear();
        stats = cache.getStats();
        assert(stats.currentBytes == 0);
        std::fprintf(stderr, "[TEST:FrameCache] Test 8 — Memory tracking: PASSED\n");
    }

    // ── Test 9: update existing key ─────────────────────────────────────────
    {
        RenderFrameCache cache;
        cache.put({"f.mp4", 1}, makeEntry(64, 64));    // 16384 bytes
        cache.put({"f.mp4", 1}, makeEntry(128, 128));   // replace with 65536 bytes

        auto stats = cache.getStats();
        assert(stats.currentEntries == 1);
        assert(stats.currentBytes == 128 * 128 * 4);

        auto* result = cache.get({"f.mp4", 1});
        assert(result != nullptr);
        assert(result->width == 128 && result->height == 128);
        std::fprintf(stderr, "[TEST:FrameCache] Test 9 — Update existing: PASSED\n");
    }

    std::fprintf(stderr, "\n[TEST:FrameCache] ALL TESTS PASSED\n");
    return 0;
}
