#pragma once

#include "Command.h"
#include "model/ColorGrade.h"

#include <string>
#include <vector>

// ─── SetColorGradesCommand ───────────────────────────────────────────────────
// Writes one or more Color Grades as ONE undo step: a slider drag (one target),
// a paste or reset (one target), a bulk apply across sources or an Auto run
// over many of them (many targets).
//
// A Source grade edit is one entry however many clips and pattern placements
// show that source, because the grade is stored once, on the source.
//
// Targets that do not exist, and targets whose grade already equals the new
// value, are dropped at construction. If nothing is left the command records
// no undo entry at all.
class SetColorGradesCommand : public Command {
public:
    struct Target {
        xleth::grade::Level level = xleth::grade::Level::Source;
        int                 id    = 0;      // ignored for Master
        ColorGrade          after;
    };

    /** `baselines`, when given, are the values undo restores, one per target
     *  and in the same order. Used by a live edit session, whose preview has
     *  already written the timeline: the value to undo to is the one from
     *  before the drag, not the one the timeline holds now. */
    SetColorGradesCommand(std::vector<Target> targets, const Timeline& timeline,
                          std::string label,
                          const std::vector<ColorGrade>* baselines = nullptr);

    void        execute(Timeline& timeline) override;
    void        undo(Timeline& timeline) override;
    std::string describe() const override;

    /** How many targets actually change. */
    int changedCount() const { return static_cast<int>(entries_.size()); }

private:
    struct Entry {
        xleth::grade::Level level;
        int                 id;
        ColorGrade          before;
        ColorGrade          after;
    };
    std::vector<Entry> entries_;
    std::string        label_;
};
