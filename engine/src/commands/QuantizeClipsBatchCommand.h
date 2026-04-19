#pragma once
#include "Command.h"
#include "model/TimelineTypes.h"
#include <cstdint>
#include <string>
#include <vector>

class Timeline;

// ─── QuantizeClipsBatchCommand ────────────────────────────────────────────────
// Applies a pre-computed quantize result to N clips and/or pattern blocks in
// one undoable operation. All math (snap decisions, offset/stretch composition)
// is done UI-side; the command just swaps geometry + stretch fields atomically
// using existing Timeline mutation APIs.
//
// Snapshot fields per entry:
//   id, isPatternBlock
//   oldStart, oldEnd, oldOffset, oldStretch
//   newStart, newEnd, newOffset, newStretch
// (stretch fields are ignored for pattern blocks.)

class QuantizeClipsBatchCommand : public Command {
public:
    struct QuantizeClipSnapshot {
        int     id            = 0;
        bool    isPatternBlock = false;
        int64_t oldStart      = 0;
        int64_t oldEnd        = 0;
        int64_t oldOffset     = 0;
        double  oldStretch    = 1.0;
        int64_t newStart      = 0;
        int64_t newEnd        = 0;
        int64_t newOffset     = 0;
        double  newStretch    = 1.0;
    };

    explicit QuantizeClipsBatchCommand(std::vector<QuantizeClipSnapshot> snapshots);

    void        execute(Timeline& timeline) override;
    void        undo(Timeline& timeline) override;
    std::string describe() const override;

private:
    std::vector<QuantizeClipSnapshot> snapshots_;
};
