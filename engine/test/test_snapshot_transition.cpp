// test_snapshot_transition.cpp — direct D3D11 validation of whole-frame transitions.

#include "render/GridCompositor.h"
#include "render/GpuDeviceManager.h"

// Force assert even in Release builds (NDEBUG is defined).
#undef NDEBUG
#include <cassert>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>

namespace {

struct Color {
    uint8_t r;
    uint8_t g;
    uint8_t b;
    uint8_t a;
};

constexpr int kWidth = 64;
constexpr int kHeight = 32;

void fillTarget(ID3D11DeviceContext* context,
                ID3D11RenderTargetView* rtv,
                const Color& color)
{
    ID3D11RenderTargetView* target = rtv;
    context->OMSetRenderTargets(1, &target, nullptr);
    const float clear[4] = {
        static_cast<float>(color.r) / 255.0f,
        static_cast<float>(color.g) / 255.0f,
        static_cast<float>(color.b) / 255.0f,
        static_cast<float>(color.a) / 255.0f,
    };
    context->ClearRenderTargetView(rtv, clear);
}

Color pixelAt(const ReadbackBuffer& buffer, int x, int y)
{
    assert(buffer.valid);
    assert(x >= 0 && x < buffer.width);
    assert(y >= 0 && y < buffer.height);
    const uint8_t* bgra = buffer.pixels.data()
        + static_cast<size_t>(y) * buffer.stride
        + static_cast<size_t>(x) * 4;
    return { bgra[2], bgra[1], bgra[0], bgra[3] };
}

bool channelNear(uint8_t actual, uint8_t expected, int tolerance)
{
    return std::abs(static_cast<int>(actual) - static_cast<int>(expected)) <= tolerance;
}

bool colorNear(const Color& actual, const Color& expected, int tolerance)
{
    return channelNear(actual.r, expected.r, tolerance)
        && channelNear(actual.g, expected.g, tolerance)
        && channelNear(actual.b, expected.b, tolerance)
        && channelNear(actual.a, expected.a, tolerance);
}

void assertEveryPixel(const ReadbackBuffer& buffer,
                      const Color& expected,
                      int tolerance)
{
    assert(buffer.valid);
    assert(buffer.width == kWidth && buffer.height == kHeight);
    for (int y = 0; y < buffer.height; ++y) {
        for (int x = 0; x < buffer.width; ++x) {
            const Color actual = pixelAt(buffer, x, y);
            if (!colorNear(actual, expected, tolerance)) {
                std::fprintf(stderr,
                    "[TEST:SnapshotTransition] pixel (%d,%d) = (%u,%u,%u,%u), "
                    "expected (%u,%u,%u,%u) +/- %d\n",
                    x, y, actual.r, actual.g, actual.b, actual.a,
                    expected.r, expected.g, expected.b, expected.a, tolerance);
                assert(false && "transition output pixel mismatch");
            }
        }
    }
}

Color channelAverage(const Color& a, const Color& b)
{
    return {
        static_cast<uint8_t>((static_cast<int>(a.r) + b.r + 1) / 2),
        static_cast<uint8_t>((static_cast<int>(a.g) + b.g + 1) / 2),
        static_cast<uint8_t>((static_cast<int>(a.b) + b.b + 1) / 2),
        static_cast<uint8_t>((static_cast<int>(a.a) + b.a + 1) / 2),
    };
}

} // namespace

int main()
{
    std::fprintf(stderr, "[TEST:SnapshotTransition] Starting GPU transition test\n");

    GpuDeviceManager gpu;
    if (!gpu.detectAdapters()) {
        std::fprintf(stderr, "[TEST:SnapshotTransition] UNAVAILABLE: no DXGI adapter\n");
        return EXIT_FAILURE;
    }
    if (!gpu.createDevice()) {
        std::fprintf(stderr, "[TEST:SnapshotTransition] UNAVAILABLE: D3D11 device creation failed\n");
        return EXIT_FAILURE;
    }

    ID3D11Device* device = gpu.getDevice();
    ID3D11DeviceContext* context = gpu.getContext();
    assert(device && context);

    GridCompositor compositor;
    assert(compositor.init(device, context, kWidth, kHeight));

    RTPool::RTPair& targets = compositor.acquireTransitionTargets();
    assert(targets.rtvA && targets.rtvB && targets.srvA && targets.srvB);
    assert(targets.width == kWidth && targets.height == kHeight);

    constexpr Color colorA{ 40, 80, 200, 255 };
    constexpr Color colorB{ 220, 160, 20, 255 };
    static_assert(colorA.r != colorB.r && colorA.g != colorB.g && colorA.b != colorB.b);

    fillTarget(context, targets.rtvA.Get(), colorA);
    fillTarget(context, targets.rtvB.Get(), colorB);

    compositor.transitionPass(targets.srvA.Get(), targets.srvB.Get(), 0, 0.0f, 0.0f);
    assertEveryPixel(compositor.readback(), colorA, 0);

    compositor.transitionPass(targets.srvA.Get(), targets.srvB.Get(), 0, 1.0f, 0.0f);
    assertEveryPixel(compositor.readback(), colorB, 0);

    compositor.transitionPass(targets.srvA.Get(), targets.srvB.Get(), 0, 0.5f, 0.0f);
    assertEveryPixel(compositor.readback(), channelAverage(colorA, colorB), 1);

    compositor.transitionPass(targets.srvA.Get(), targets.srvB.Get(), 1, 0.5f, 0.0f);
    const ReadbackBuffer sweep = compositor.readback();
    assert(sweep.valid);
    const Color left = pixelAt(sweep, kWidth / 4, kHeight / 2);
    const Color right = pixelAt(sweep, 3 * kWidth / 4, kHeight / 2);
    assert(colorNear(left, colorB, 0));
    assert(colorNear(right, colorA, 0));
    assert(!colorNear(left, right, 0));

    compositor.shutdown();
    std::fprintf(stderr, "[TEST:SnapshotTransition] ALL TESTS PASSED\n");
    return EXIT_SUCCESS;
}
