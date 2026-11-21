#include "ColorGrade.h"
#include "Timeline.h"

#include <algorithm>

// buildColorGradeSnapshot: the one place the Timeline's grades are turned into
// what the render path reads. Kept apart from ColorGrade.cpp so the grade math
// itself stays free of Timeline.

namespace xleth::grade {

namespace {

void addEntry(ColorGradeSnapshot::Table& out, int id, const ColorGrade& grade,
              const ColorGradeSnapshot::Table* previous, Lut3DLibrary* luts) {
    if (!grade.isActive()) return;
    static const ColorGradeSnapshot::Baked kNone;
    const ColorGradeSnapshot::Baked& prev =
        previous ? ColorGradeSnapshot::find(*previous, id) : kNone;
    if (ColorGradeSnapshot::Baked baked = bakeOrReuse(grade, prev, luts))
        out.emplace_back(id, std::move(baked));
}

void sortTable(ColorGradeSnapshot::Table& t) {
    std::sort(t.begin(), t.end(),
              [](const auto& a, const auto& b) { return a.first < b.first; });
}

} // namespace

std::shared_ptr<const ColorGradeSnapshot> buildColorGradeSnapshot(
    const ::Timeline& timeline, const ColorGradeSnapshot* previous, Lut3DLibrary* luts)
{
    auto snap = std::make_shared<ColorGradeSnapshot>();

    for (const SourceMedia* s : timeline.getAllSources())
        addEntry(snap->sources, s->id, s->colorGrade, previous ? &previous->sources : nullptr, luts);
    for (const Clip* c : timeline.getAllClips())
        addEntry(snap->clips, c->id, c->colorGrade, previous ? &previous->clips : nullptr, luts);
    for (const SampleRegion* r : timeline.getAllRegions())
        addEntry(snap->regions, r->id, r->colorGrade, previous ? &previous->regions : nullptr, luts);
    for (const TrackInfo* t : timeline.getAllTracks())
        addEntry(snap->tracks, t->id, t->colorGrade, previous ? &previous->tracks : nullptr, luts);

    sortTable(snap->sources);
    sortTable(snap->clips);
    sortTable(snap->regions);
    sortTable(snap->tracks);

    static const ColorGradeSnapshot::Baked kNone;
    snap->master = bakeOrReuse(timeline.getMasterColorGrade(),
                               previous ? previous->master : kNone, luts);
    return snap;
}

} // namespace xleth::grade
