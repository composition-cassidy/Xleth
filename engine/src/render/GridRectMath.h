#pragma once

// ---------------------------------------------------------------------------
// GridRectMath — the ONE place a grid slot becomes a canvas rect.
//
// A slot is placed on a fine sub-unit grid (kGridSubUnitsPerColumn per column,
// kGridSubUnitsPerRow per row) and drawn inset by the gap. Two callers need
// that rect and must agree to the last bit:
//
//   • GridCompositor::compositeFrame, for every grid cell it draws;
//   • Timeline::landingsAt, which resolves where a Landing ends (and, for
//     WhereItWas, where it starts).
//
// A Landing's last frame has to land on exactly the rect the incoming snapshot
// draws a frame later, or the cut pops. So both call these functions and
// neither keeps its own copy of the arithmetic.
//
// Pure, header-only, float-in / float-out, no GPU and no JUCE. The expressions
// are the compositor's original ones, kept operation for operation so existing
// projects render byte-identically (test_grid_rect_math checks this against a
// frozen copy of the old code).
//
// All rects are canvas-normalized (output UV, 0..1, y down).
// ---------------------------------------------------------------------------

#include "model/TimelineTypes.h"   // kGridSubUnitsPerColumn / kGridSubUnitsPerRow

namespace xleth {

// The slot's rect BEFORE the gap: its placement on the fine grid. This is also
// the unit a Roam offset is measured in.
inline void slotCellRect(int cellCol, int cellRow, int spanX, int spanY,
                         int gridCols, int gridRows,
                         float& x, float& y, float& w, float& h) noexcept
{
    const float subCellW = 1.0f / (gridCols * static_cast<float>(kGridSubUnitsPerColumn));
    const float subCellH = 1.0f / (gridRows * static_cast<float>(kGridSubUnitsPerRow));

    x = cellCol * subCellW;
    y = cellRow * subCellH;
    w = spanX  * subCellW;
    h = spanY  * subCellH;
}

// Shrink a rect symmetrically by the gap. gapScale <= 0 leaves it untouched.
inline void insetSlotGap(float gapScale, float& x, float& y, float& w, float& h) noexcept
{
    if (gapScale > 0.0f) {
        const float sx = w * gapScale * 0.5f;
        const float sy = h * gapScale * 0.5f;
        x += sx;  y += sy;
        w -= sx * 2.0f;  h -= sy * 2.0f;
    }
}

// The gap a track is drawn with: its own override when it has one (>= 0),
// otherwise the layout's.
inline float effectiveSlotGap(float layoutGapScale, float trackGapScaleOverride) noexcept
{
    return (trackGapScaleOverride >= 0.0f) ? trackGapScaleOverride : layoutGapScale;
}

// The slot's DRAWN rect: placement, then gap. `gapScale` is the effective gap
// (see effectiveSlotGap).
inline void slotCanvasRect(int cellCol, int cellRow, int spanX, int spanY,
                           int gridCols, int gridRows, float gapScale,
                           float& x, float& y, float& w, float& h) noexcept
{
    slotCellRect(cellCol, cellRow, spanX, spanY, gridCols, gridRows, x, y, w, h);
    insetSlotGap(gapScale, x, y, w, h);
}

} // namespace xleth
