#include "commands/ColorGradeCommands.h"
#include "model/Timeline.h"

SetColorGradesCommand::SetColorGradesCommand(std::vector<Target> targets,
                                             const Timeline& timeline,
                                             std::string label,
                                             const std::vector<ColorGrade>* baselines)
    : label_(std::move(label))
{
    entries_.reserve(targets.size());
    for (size_t i = 0; i < targets.size(); ++i) {
        Target& t = targets[i];
        const ColorGrade* current = timeline.getColorGrade(t.level, t.id);
        if (!current) continue;                       // owner is gone
        xleth::grade::sanitizeColorGrade(t.after);
        const ColorGrade before =
            (baselines && i < baselines->size()) ? (*baselines)[i] : *current;
        if (before == t.after && *current == t.after) continue;   // nothing to do
        entries_.push_back(Entry{ t.level, t.id, before, std::move(t.after) });
    }
    if (entries_.empty()) setApplied(false);
}

void SetColorGradesCommand::execute(Timeline& timeline) {
    for (const Entry& e : entries_) timeline.setColorGrade(e.level, e.id, e.after);
}

void SetColorGradesCommand::undo(Timeline& timeline) {
    for (const Entry& e : entries_) timeline.setColorGrade(e.level, e.id, e.before);
}

std::string SetColorGradesCommand::describe() const {
    if (!label_.empty()) return label_;
    if (entries_.size() == 1)
        return std::string("Color Grade (") + xleth::grade::levelName(entries_[0].level) + ")";
    return "Color Grade (" + std::to_string(entries_.size()) + " targets)";
}
