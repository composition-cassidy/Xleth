#include "commands/QuantizeClipsBatchCommand.h"
#include "model/Timeline.h"
#include "XlethDebug.h"
#include <algorithm>
#include <cstdio>
#include <iostream>

namespace {
    // Apply one snapshot forward: set clip/pattern-block geometry + stretch.
    void applyEntry(Timeline& timeline,
                    const QuantizeClipsBatchCommand::QuantizeClipSnapshot& s,
                    bool forward)
    {
        const int64_t start   = forward ? s.newStart   : s.oldStart;
        const int64_t end     = forward ? s.newEnd     : s.oldEnd;
        const int64_t offset  = forward ? s.newOffset  : s.oldOffset;
        const double  stretch = forward ? s.newStretch : s.oldStretch;

        const int64_t dur = end - start;
        if (dur <= 0) {
            std::cerr << "[Quantize] WARNING entry id=" << s.id
                      << " non-positive duration (start=" << start
                      << " end=" << end << "), skipping\n";
            return;
        }

        if (s.isPatternBlock) {
            PatternBlock* pb = timeline.getPatternBlockMutable(s.id);
            if (!pb) {
                std::cerr << "[Quantize] ERROR patternBlock id=" << s.id
                          << " not found\n";
                return;
            }
            pb->position = TickTime{ start };
            pb->duration = TickTime{ dur };
            pb->offset   = TickTime{ offset };
        } else {
            Clip* c = timeline.getClipMutable(s.id);
            if (!c) {
                std::cerr << "[Quantize] ERROR clip id=" << s.id
                          << " not found\n";
                return;
            }
            c->position     = TickTime{ start };
            c->duration     = TickTime{ dur };
            c->regionOffset = TickTime{ offset };
            c->stretchRatio = std::clamp(stretch, 0.1, 20.0);
        }
    }
} // namespace

QuantizeClipsBatchCommand::QuantizeClipsBatchCommand(
    std::vector<QuantizeClipSnapshot> snapshots)
    : snapshots_(std::move(snapshots))
{
}

void QuantizeClipsBatchCommand::execute(Timeline& timeline) {
#ifdef XLETH_DEBUG
    fprintf(stderr, "[Quantize] execute: %zu entries\n", snapshots_.size());
#endif
    for (const auto& s : snapshots_)
        applyEntry(timeline, s, /*forward=*/true);
}

void QuantizeClipsBatchCommand::undo(Timeline& timeline) {
#ifdef XLETH_DEBUG
    fprintf(stderr, "[Quantize] undo: %zu entries\n", snapshots_.size());
#endif
    for (const auto& s : snapshots_)
        applyEntry(timeline, s, /*forward=*/false);
}

std::string QuantizeClipsBatchCommand::describe() const {
    return "Quantize " + std::to_string(snapshots_.size()) + " clips";
}
