// test_grid_rect_math.cpp — rect parity for render/GridRectMath.h
// (docs/XLETH_LANDING_SPEC.md §6.1, P2).
//
// GridRectMath.h is the slot -> canvas rect arithmetic promoted out of
// GridCompositor so the compositor and the Landing resolver share it. The
// promotion must not move a single pixel of an existing project, so this test
// keeps a FROZEN copy of the compositor's old code (gridCellToUV plus the gap
// inset compositeFrame applied inline, as of af40dee) and compares every
// output bit for bit across
//   • every grid size from 1x1 to 8x8,
//   • every half-grid placement (and every finer placement the per-track
//     subdivision factors 1/2/4/8 can produce),
//   • gaps 0, 0.1 and 0.5, as the layout gap and as a per-track override.
//
// CPU only. Pass: prints "ALL TESTS PASSED" and exits 0.

#include "render/GridRectMath.h"

#include <cmath>
#include <cstring>
#include <iostream>

static long long g_passed = 0;
static long long g_failed = 0;

#define CHECK(cond, msg)                                             \
    do {                                                             \
        if (cond) {                                                  \
            ++g_passed;                                              \
        } else {                                                     \
            if (g_failed < 20)                                       \
                std::cerr << "  FAIL [" << __LINE__ << "] " << msg << "\n"; \
            ++g_failed;                                              \
        }                                                            \
    } while (0)

namespace {

bool sameBits(float a, float b) {
    return std::memcmp(&a, &b, sizeof(float)) == 0;
}

// ── FROZEN: GridCompositor::gridCellToUV as of af40dee. Do not "tidy". ───────
void oldGridCellToUV(int cellCol, int cellRow, int spanX, int spanY,
                     int gridCols, int gridRows,
                     float& outX, float& outY, float& outW, float& outH)
{
    const float subCellW = 1.0f / (gridCols * static_cast<float>(kGridSubUnitsPerColumn));
    const float subCellH = 1.0f / (gridRows * static_cast<float>(kGridSubUnitsPerRow));

    outX = cellCol * subCellW;
    outY = cellRow * subCellH;
    outW = spanX  * subCellW;
    outH = spanY  * subCellH;
}

// ── FROZEN: the grid branch of GridCompositor::compositeFrame as of af40dee:
// the rect, the Roam unit taken before the gap, then the inline gap inset. ───
void oldCompositorCellRect(int cellCol, int cellRow, int spanX, int spanY,
                           int gridCols, int gridRows,
                           float gapScale, float gapScaleOverride,
                           float& rx, float& ry, float& rw, float& rh,
                           float& roamUnitW, float& roamUnitH)
{
    oldGridCellToUV(cellCol, cellRow, spanX, spanY, gridCols, gridRows, rx, ry, rw, rh);
    roamUnitW = rw;
    roamUnitH = rh;

    float effectiveGap = (gapScaleOverride >= 0.0f) ? gapScaleOverride : gapScale;
    if (effectiveGap > 0.0f) {
        float sx = rw * effectiveGap * 0.5f;
        float sy = rh * effectiveGap * 0.5f;
        rx += sx;  ry += sy;
        rw -= sx * 2.0f;  rh -= sy * 2.0f;
    }
}

void comparePlacement(int cols, int rows, int gx, int gy, int sx, int sy,
                      float gapScale, float gapOverride)
{
    float ox, oy, ow, oh, ouw, ouh;
    oldCompositorCellRect(gx, gy, sx, sy, cols, rows, gapScale, gapOverride,
                          ox, oy, ow, oh, ouw, ouh);

    // The drawn rect.
    float nx, ny, nw, nh;
    xleth::slotCanvasRect(gx, gy, sx, sy, cols, rows,
                          xleth::effectiveSlotGap(gapScale, gapOverride),
                          nx, ny, nw, nh);
    CHECK(sameBits(ox, nx) && sameBits(oy, ny) && sameBits(ow, nw) && sameBits(oh, nh),
          "slotCanvasRect == old compositor rect  (" << cols << "x" << rows
          << " @" << gx << "," << gy << " span " << sx << "x" << sy
          << " gap " << gapScale << " override " << gapOverride << ")");

    // The pre-gap placement (Roam's unit, and gridCellToUV's whole output).
    float ux, uy, uw, uh;
    xleth::slotCellRect(gx, gy, sx, sy, cols, rows, ux, uy, uw, uh);
    float gxo, gyo, gwo, gho;
    oldGridCellToUV(gx, gy, sx, sy, cols, rows, gxo, gyo, gwo, gho);
    CHECK(sameBits(ux, gxo) && sameBits(uy, gyo) && sameBits(uw, gwo) && sameBits(uh, gho),
          "slotCellRect == old gridCellToUV");
    CHECK(sameBits(uw, ouw) && sameBits(uh, ouh), "slotCellRect size == old Roam unit");
}

void testParity() {
    std::cout << "[P] slotCanvasRect / slotCellRect vs the compositor's old math\n";

    const float gaps[] = { 0.0f, 0.1f, 0.5f };
    // -1 = no per-track override (use the layout gap); the rest override it.
    const float overrides[] = { -1.0f, 0.0f, 0.1f, 0.5f };
    // Spans the per-track subdivision factors produce: 8/F for F in {1,2,4,8},
    // plus the multi-cell spans a slot can be stretched to.
    const int spans[] = { 1, 2, 4, 8, 12, 16, 24, 32, 64 };

    for (int cols = 1; cols <= 8; ++cols) {
        for (int rows = 1; rows <= 8; ++rows) {
            const int fineW = cols * kGridSubUnitsPerColumn;
            const int fineH = rows * kGridSubUnitsPerRow;
            for (float gap : gaps) {
                for (float ov : overrides) {
                    // Every HALF-grid placement (half a cell = 4 fine units),
                    // with every span that fits.
                    for (int gx = 0; gx < fineW; gx += 4)
                        for (int gy = 0; gy < fineH; gy += 4)
                            for (int sx : spans)
                                for (int sy : spans) {
                                    if (gx + sx > fineW || gy + sy > fineH) continue;
                                    comparePlacement(cols, rows, gx, gy, sx, sy, gap, ov);
                                }
                    // Every FINE placement along the diagonal, so the eighth-
                    // cell positions are covered without an 8x8x64x64 sweep.
                    for (int g = 0; g < fineW && g < fineH; ++g)
                        for (int s : { 1, 2, 4, 8 }) {
                            if (g + s > fineW || g + s > fineH) continue;
                            comparePlacement(cols, rows, g, g, s, s, gap, ov);
                        }
                }
            }
        }
    }
}

void testGapRules() {
    std::cout << "[G] gap rules\n";

    CHECK(xleth::effectiveSlotGap(0.1f, -1.0f) == 0.1f, "no override: the layout gap");
    CHECK(xleth::effectiveSlotGap(0.1f, 0.0f) == 0.0f, "an override of 0 removes the gap");
    CHECK(xleth::effectiveSlotGap(0.1f, 0.3f) == 0.3f, "an override replaces the layout gap");

    // A zero or negative gap leaves the rect bit-identical to the placement.
    float x, y, w, h, ux, uy, uw, uh;
    xleth::slotCellRect(8, 0, 8, 8, 3, 3, ux, uy, uw, uh);
    xleth::slotCanvasRect(8, 0, 8, 8, 3, 3, 0.0f, x, y, w, h);
    CHECK(sameBits(x, ux) && sameBits(y, uy) && sameBits(w, uw) && sameBits(h, uh),
          "gap 0: the drawn rect is the placement");
    xleth::slotCanvasRect(8, 0, 8, 8, 3, 3, -0.25f, x, y, w, h);
    CHECK(sameBits(x, ux) && sameBits(w, uw), "a negative gap is no gap");

    // The inset is symmetric: the centre does not move, the size shrinks by the gap.
    xleth::slotCanvasRect(8, 8, 8, 8, 3, 3, 0.5f, x, y, w, h);
    CHECK(std::abs((x + w * 0.5f) - (ux + uw * 0.5f)) < 1e-6f, "the gap keeps the cell centred");
    CHECK(std::abs(w - uw * 0.5f) < 1e-6f && std::abs(h - uh * 0.5f) < 1e-6f,
          "gap 0.5 halves the cell");

    // A full 1x1 placement is the whole canvas.
    xleth::slotCanvasRect(0, 0, 8, 8, 1, 1, 0.0f, x, y, w, h);
    CHECK(x == 0.0f && y == 0.0f && w == 1.0f && h == 1.0f, "1x1 full cell is the canvas");
}

} // namespace

int main() {
    testParity();
    testGapRules();

    std::cout << "\n" << g_passed << " passed, " << g_failed << " failed\n";
    if (g_failed == 0) {
        std::cout << "ALL TESTS PASSED\n";
        return 0;
    }
    std::cout << "FAILED\n";
    return 1;
}
