#include "commands/TimelineCommands.h"
#include "model/Timeline.h"
#include "model/ParentMath.h"
#include "commands/TempoTrimAnchor.h"
#include "XlethDebug.h"
#include <algorithm>
#include <cmath>
#include <cstdio>
#include <iostream>
#include <set>
#include <unordered_set>

// ─── AddClipCommand ───────────────────────────────────────────────────────────

AddClipCommand::AddClipCommand(Clip clip) : clip_(std::move(clip)) {}

void AddClipCommand::execute(Timeline& timeline) {
    if (firstExecute_) {
        // Let the timeline assign the canonical ID on first use
        int id = timeline.addClip(clip_);
        if (id < 0) {
            std::cerr << "[Undo] ERROR AddClipCommand::execute: addClip failed"
                         " (check trackId/regionId exist)\n";
            setApplied(false);
            return;
        }
        clip_.id      = id;
        firstExecute_ = false;
    } else {
        // Redo: restore with the same ID so dependent commands stay valid
        timeline.restoreClip(clip_);
    }
}

void AddClipCommand::undo(Timeline& timeline) {
    timeline.removeClip(clip_.id);
}

std::string AddClipCommand::describe() const {
    return "Add Clip (region=" + std::to_string(clip_.regionId)
         + " track="  + std::to_string(clip_.trackId) + ")";
}

// ─── RemoveClipCommand ────────────────────────────────────────────────────────

RemoveClipCommand::RemoveClipCommand(int clipId, const Timeline& timeline) {
    const Clip* c = timeline.getClip(clipId);
    if (c) {
        clip_ = *c;
    } else {
        std::cerr << "[Undo] ERROR RemoveClipCommand: clip id=" << clipId
                  << " not found in timeline\n";
    }
}

void RemoveClipCommand::execute(Timeline& timeline) {
    setApplied(timeline.removeClip(clip_.id));
}

void RemoveClipCommand::undo(Timeline& timeline) {
    timeline.restoreClip(clip_);
}

std::string RemoveClipCommand::describe() const {
    return "Remove Clip id=" + std::to_string(clip_.id);
}

// ─── MoveClipCommand ──────────────────────────────────────────────────────────

MoveClipCommand::MoveClipCommand(int clipId, int newTrackId, TickTime newPosition,
                                 const Timeline& timeline)
    : clipId_(clipId), newTrackId_(newTrackId), newPosition_(newPosition)
{
    const Clip* c = timeline.getClip(clipId);
    if (c) {
        oldPosition_ = c->position;
        oldTrackId_  = c->trackId;
    } else {
        std::cerr << "[Undo] ERROR MoveClipCommand: clip id=" << clipId
                  << " not found in timeline\n";
        oldTrackId_ = -1;
    }
}

void MoveClipCommand::execute(Timeline& timeline) {
    const bool moved = timeline.moveClip(clipId_, newTrackId_, newPosition_);
    setApplied(moved && (newTrackId_ != oldTrackId_
                         || newPosition_.ticks != oldPosition_.ticks));
}

void MoveClipCommand::undo(Timeline& timeline) {
    timeline.moveClip(clipId_, oldTrackId_, oldPosition_);
}

std::string MoveClipCommand::describe() const {
    return "Move Clip id=" + std::to_string(clipId_)
         + " (" + std::to_string(oldPosition_.ticks)
         + " → " + std::to_string(newPosition_.ticks) + " ticks)";
}

// ─── ResizeClipCommand ────────────────────────────────────────────────────────

ResizeClipCommand::ResizeClipCommand(int clipId, TickTime newDuration,
                                     const Timeline& timeline)
    : clipId_(clipId), newDuration_(newDuration)
{
    const Clip* c = timeline.getClip(clipId);
    if (c) {
        oldDuration_ = c->duration;
    } else {
        std::cerr << "[Undo] ERROR ResizeClipCommand: clip id=" << clipId
                  << " not found in timeline\n";
    }
}

ResizeClipCommand::ResizeClipCommand(int clipId, TickTime newDuration,
                                     TickTime newRegionOffset,
                                     const Timeline& timeline)
    : clipId_(clipId), newDuration_(newDuration),
      setsRegionOffset_(true), newRegionOffset_(newRegionOffset)
{
    const Clip* c = timeline.getClip(clipId);
    if (c) {
        oldDuration_     = c->duration;
        oldRegionOffset_ = c->regionOffset;
        position_        = c->position;
    } else {
        std::cerr << "[Undo] ERROR ResizeClipCommand: clip id=" << clipId
                  << " not found in timeline\n";
    }
}

void ResizeClipCommand::execute(Timeline& timeline) {
    if (setsRegionOffset_) {
        const bool ok = timeline.resizeClipLeft(clipId_, position_, newDuration_, newRegionOffset_);
        setApplied(ok && (newDuration_.ticks != oldDuration_.ticks
                          || newRegionOffset_.ticks != oldRegionOffset_.ticks));
        return;
    }
    const bool ok = timeline.resizeClip(clipId_, newDuration_);
    setApplied(ok && newDuration_.ticks != oldDuration_.ticks);
}

void ResizeClipCommand::undo(Timeline& timeline) {
    if (setsRegionOffset_) {
        timeline.resizeClipLeft(clipId_, position_, oldDuration_, oldRegionOffset_);
        return;
    }
    timeline.resizeClip(clipId_, oldDuration_);
}

std::string ResizeClipCommand::describe() const {
    return "Resize Clip id=" + std::to_string(clipId_)
         + " (" + std::to_string(oldDuration_.ticks)
         + " → " + std::to_string(newDuration_.ticks) + " ticks)";
}

// ─── ResizeClipLeftCommand ────────────────────────────────────────────────────

ResizeClipLeftCommand::ResizeClipLeftCommand(int clipId, TickTime newPosition,
                                             TickTime newDuration, TickTime newRegionOffset,
                                             const Timeline& timeline)
    : clipId_(clipId), newPosition_(newPosition),
      newDuration_(newDuration), newRegionOffset_(newRegionOffset)
{
    const Clip* c = timeline.getClip(clipId);
    if (c) {
        oldPosition_     = c->position;
        oldDuration_     = c->duration;
        oldRegionOffset_ = c->regionOffset;
    } else {
        std::cerr << "[Undo] ERROR ResizeClipLeftCommand: clip id=" << clipId
                  << " not found in timeline\n";
    }
}

void ResizeClipLeftCommand::execute(Timeline& timeline) {
#ifdef XLETH_DEBUG
    fprintf(stderr, "[ResizeLeft] execute: clip=%d pos=%lld→%lld dur=%lld→%lld offset=%lld→%lld\n",
            clipId_,
            (long long)oldPosition_.ticks,     (long long)newPosition_.ticks,
            (long long)oldDuration_.ticks,     (long long)newDuration_.ticks,
            (long long)oldRegionOffset_.ticks, (long long)newRegionOffset_.ticks);
#endif
    const bool ok = timeline.resizeClipLeft(clipId_, newPosition_, newDuration_, newRegionOffset_);
    setApplied(ok && (newPosition_.ticks     != oldPosition_.ticks
                      || newDuration_.ticks  != oldDuration_.ticks
                      || newRegionOffset_.ticks != oldRegionOffset_.ticks));
}

void ResizeClipLeftCommand::undo(Timeline& timeline) {
#ifdef XLETH_DEBUG
    fprintf(stderr, "[ResizeLeft] undo: clip=%d pos=%lld→%lld dur=%lld→%lld offset=%lld→%lld\n",
            clipId_,
            (long long)newPosition_.ticks,     (long long)oldPosition_.ticks,
            (long long)newDuration_.ticks,     (long long)oldDuration_.ticks,
            (long long)newRegionOffset_.ticks, (long long)oldRegionOffset_.ticks);
#endif
    timeline.resizeClipLeft(clipId_, oldPosition_, oldDuration_, oldRegionOffset_);
}

std::string ResizeClipLeftCommand::describe() const {
    return "Resize Clip Left id=" + std::to_string(clipId_)
         + " pos(" + std::to_string(oldPosition_.ticks)
         + "→" + std::to_string(newPosition_.ticks) + ")"
         + " dur(" + std::to_string(oldDuration_.ticks)
         + "→" + std::to_string(newDuration_.ticks) + ")";
}

// ─── SpliceClipsCommand ───────────────────────────────────────────────────────

SpliceClipsCommand::SpliceClipsCommand(std::vector<Entry> entries,
                                       std::vector<std::pair<int,int>>* outIds)
    : entries_(std::move(entries)), outIds_(outIds)
{}

void SpliceClipsCommand::execute(Timeline& timeline) {
    for (auto& e : entries_) {
        timeline.removeClip(e.original.id);
        if (firstExecute_) {
            int lid = timeline.addClip(e.left);
            int rid = timeline.addClip(e.right);
            e.left.id  = lid;
            e.right.id = rid;
        } else {
            // Redo: restore with the IDs assigned on first execute
            timeline.restoreClip(e.left);
            timeline.restoreClip(e.right);
        }
    }
    if (firstExecute_ && outIds_) {
        outIds_->clear();
        for (const auto& e : entries_)
            outIds_->emplace_back(e.left.id, e.right.id);
    }
    firstExecute_ = false;
}

void SpliceClipsCommand::undo(Timeline& timeline) {
    for (auto& e : entries_) {
        timeline.removeClip(e.left.id);
        timeline.removeClip(e.right.id);
        timeline.restoreClip(e.original);
    }
}

std::string SpliceClipsCommand::describe() const {
    return "Split " + std::to_string(entries_.size()) + " clip(s)";
}

// ─── StretchClipCommand ───────────────────────────────────────────────────────

StretchClipCommand::StretchClipCommand(int clipId, TickTime newDuration,
                                       const Timeline& timeline)
    : clipId_(clipId), newDuration_(newDuration)
{
    const Clip* c = timeline.getClip(clipId);
    if (c) {
        oldDuration_     = c->duration;
        oldStretchRatio_ = c->stretchRatio;
        if (oldDuration_.ticks > 0) {
            const double factor = static_cast<double>(newDuration.ticks)
                                / static_cast<double>(oldDuration_.ticks);
            newStretchRatio_ = std::clamp(factor * oldStretchRatio_, 0.1, 20.0);
        } else {
            newStretchRatio_ = oldStretchRatio_;
        }
    } else {
        std::cerr << "[Undo] ERROR StretchClipCommand: clip id=" << clipId << " not found\n";
        oldDuration_.ticks = 0;
        oldStretchRatio_   = 1.0;
        newStretchRatio_   = 1.0;
    }
}

void StretchClipCommand::execute(Timeline& timeline) {
#ifdef XLETH_DEBUG
    fprintf(stderr, "[StretchCmd] execute: clip=%d dur=%lld→%lld ratio=%.4f→%.4f\n",
            clipId_,
            (long long)oldDuration_.ticks, (long long)newDuration_.ticks,
            oldStretchRatio_, newStretchRatio_);
#endif
    // A clip has to keep some length; a zero or negative one has no stretch
    // ratio that makes sense and breaks every division by duration after it.
    if (newDuration_.ticks <= 0 || !timeline.getClip(clipId_)) {
        setApplied(false);
        return;
    }
    Clip* c = timeline.getClipMutable(clipId_);
    setApplied(newDuration_.ticks != oldDuration_.ticks);
    c->duration     = newDuration_;
    c->stretchRatio = newStretchRatio_;
}

void StretchClipCommand::undo(Timeline& timeline) {
#ifdef XLETH_DEBUG
    fprintf(stderr, "[StretchCmd] undo: clip=%d dur=%lld→%lld ratio=%.4f→%.4f\n",
            clipId_,
            (long long)newDuration_.ticks, (long long)oldDuration_.ticks,
            newStretchRatio_, oldStretchRatio_);
#endif
    Clip* c = timeline.getClipMutable(clipId_);
    if (!c) return;
    c->duration     = oldDuration_;
    c->stretchRatio = oldStretchRatio_;
}

std::string StretchClipCommand::describe() const {
    return "Stretch Clip id=" + std::to_string(clipId_)
         + " (" + std::to_string(oldDuration_.ticks)
         + " → " + std::to_string(newDuration_.ticks) + " ticks)";
}

// ─── StretchClipLeftCommand ───────────────────────────────────────────────────

StretchClipLeftCommand::StretchClipLeftCommand(int clipId, TickTime newPosition,
                                               TickTime newDuration,
                                               const Timeline& timeline)
    : clipId_(clipId), newPosition_(newPosition), newDuration_(newDuration)
{
    const Clip* c = timeline.getClip(clipId);
    if (c) {
        oldPosition_     = c->position;
        oldDuration_     = c->duration;
        oldStretchRatio_ = c->stretchRatio;
        if (oldDuration_.ticks > 0) {
            const double factor = static_cast<double>(newDuration.ticks)
                                / static_cast<double>(oldDuration_.ticks);
            newStretchRatio_ = std::clamp(factor * oldStretchRatio_, 0.1, 20.0);
        } else {
            newStretchRatio_ = oldStretchRatio_;
        }
    } else {
        std::cerr << "[Undo] ERROR StretchClipLeftCommand: clip id=" << clipId << " not found\n";
        oldPosition_.ticks = 0;
        oldDuration_.ticks = 0;
        oldStretchRatio_   = 1.0;
        newStretchRatio_   = 1.0;
    }
}

void StretchClipLeftCommand::execute(Timeline& timeline) {
#ifdef XLETH_DEBUG
    fprintf(stderr, "[StretchCmd] execute-left: clip=%d pos=%lld→%lld dur=%lld→%lld ratio=%.4f→%.4f\n",
            clipId_,
            (long long)oldPosition_.ticks, (long long)newPosition_.ticks,
            (long long)oldDuration_.ticks, (long long)newDuration_.ticks,
            oldStretchRatio_, newStretchRatio_);
#endif
    if (newDuration_.ticks <= 0 || newPosition_.ticks < 0 || !timeline.getClip(clipId_)) {
        setApplied(false);
        return;
    }
    Clip* c = timeline.getClipMutable(clipId_);
    setApplied(newPosition_.ticks != oldPosition_.ticks
               || newDuration_.ticks != oldDuration_.ticks);
    c->position     = newPosition_;
    c->duration     = newDuration_;
    c->stretchRatio = newStretchRatio_;
}

void StretchClipLeftCommand::undo(Timeline& timeline) {
#ifdef XLETH_DEBUG
    fprintf(stderr, "[StretchCmd] undo-left: clip=%d pos=%lld→%lld dur=%lld→%lld ratio=%.4f→%.4f\n",
            clipId_,
            (long long)newPosition_.ticks, (long long)oldPosition_.ticks,
            (long long)newDuration_.ticks, (long long)oldDuration_.ticks,
            newStretchRatio_, oldStretchRatio_);
#endif
    Clip* c = timeline.getClipMutable(clipId_);
    if (!c) return;
    c->position     = oldPosition_;
    c->duration     = oldDuration_;
    c->stretchRatio = oldStretchRatio_;
}

std::string StretchClipLeftCommand::describe() const {
    return "Stretch Clip Left id=" + std::to_string(clipId_)
         + " pos(" + std::to_string(oldPosition_.ticks)
         + "→" + std::to_string(newPosition_.ticks) + ")"
         + " dur(" + std::to_string(oldDuration_.ticks)
         + "→" + std::to_string(newDuration_.ticks) + ")";
}

// ─── PitchShiftClipCommand ────────────────────────────────────────────────────

PitchShiftClipCommand::PitchShiftClipCommand(int clipId, int newSemis, int newCents,
                                             const Timeline& timeline)
    : clipId_(clipId), newSemis_(newSemis), newCents_(newCents)
{
    const Clip* c = timeline.getClip(clipId);
    if (c) {
        oldSemis_ = c->pitchOffset;
        oldCents_ = c->pitchOffsetCents;
    } else {
        std::cerr << "[Undo] ERROR PitchShiftClipCommand: clip id=" << clipId << " not found\n";
        oldSemis_ = 0;
        oldCents_ = 0;
    }
}

void PitchShiftClipCommand::execute(Timeline& timeline) {
#ifdef XLETH_DEBUG
    fprintf(stderr, "[PitchCmd] execute: clip=%d pitch=%dst+%dc → %dst+%dc\n",
            clipId_, oldSemis_, oldCents_, newSemis_, newCents_);
#endif
    if (!timeline.getClip(clipId_)) {
        setApplied(false);
        return;
    }
    Clip* c = timeline.getClipMutable(clipId_);
    setApplied(newSemis_ != oldSemis_ || newCents_ != oldCents_);
    c->pitchOffset      = newSemis_;
    c->pitchOffsetCents = newCents_;
}

void PitchShiftClipCommand::undo(Timeline& timeline) {
#ifdef XLETH_DEBUG
    fprintf(stderr, "[PitchCmd] undo: clip=%d pitch=%dst+%dc → %dst+%dc\n",
            clipId_, newSemis_, newCents_, oldSemis_, oldCents_);
#endif
    Clip* c = timeline.getClipMutable(clipId_);
    if (!c) return;
    c->pitchOffset      = oldSemis_;
    c->pitchOffsetCents = oldCents_;
}

std::string PitchShiftClipCommand::describe() const {
    return "Pitch Shift Clip id=" + std::to_string(clipId_)
         + " semis=" + std::to_string(newSemis_)
         + " cents=" + std::to_string(newCents_);
}

// ─── ReverseClipCommand ───────────────────────────────────────────────────────

ReverseClipCommand::ReverseClipCommand(int clipId, bool newReversed,
                                       const Timeline& timeline)
    : clipId_(clipId), newReversed_(newReversed)
{
    const Clip* c = timeline.getClip(clipId);
    if (c) {
        oldReversed_ = c->reversed;
    } else {
        std::cerr << "[Undo] ERROR ReverseClipCommand: clip id=" << clipId << " not found\n";
        oldReversed_ = false;
    }
}

void ReverseClipCommand::execute(Timeline& timeline) {
#ifdef XLETH_DEBUG
    fprintf(stderr, "[ReverseCmd] execute: clip=%d reversed=%d→%d\n",
            clipId_, (int)oldReversed_, (int)newReversed_);
#endif
    if (!timeline.getClip(clipId_)) {
        setApplied(false);
        return;
    }
    Clip* c = timeline.getClipMutable(clipId_);
    setApplied(newReversed_ != oldReversed_);
    c->reversed = newReversed_;
}

void ReverseClipCommand::undo(Timeline& timeline) {
#ifdef XLETH_DEBUG
    fprintf(stderr, "[ReverseCmd] undo: clip=%d reversed=%d→%d\n",
            clipId_, (int)newReversed_, (int)oldReversed_);
#endif
    Clip* c = timeline.getClipMutable(clipId_);
    if (!c) return;
    c->reversed = oldReversed_;
}

std::string ReverseClipCommand::describe() const {
    return std::string(newReversed_ ? "Reverse" : "Unreverse")
         + " Clip id=" + std::to_string(clipId_);
}

// ─── AutoTrimClipCommand ─────────────────────────────────────────────────────

AutoTrimClipCommand::AutoTrimClipCommand(int clipId,
                                         int64_t addOffsetTicks,
                                         int64_t subtractDurationTicks)
    : clipId_(clipId),
      addOffsetTicks_(addOffsetTicks),
      subtractDurationTicks_(subtractDurationTicks)
{}

void AutoTrimClipCommand::execute(Timeline& timeline) {
    Clip* c = timeline.getClipMutable(clipId_);
    if (!c) {
        std::cerr << "[Undo] ERROR AutoTrimClipCommand: clip id=" << clipId_
                  << " not found\n";
        return;
    }
    if (!snapshotValid_) {
        oldRegionOffset_ = c->regionOffset;
        oldDuration_     = c->duration;
        snapshotValid_   = true;
    }
    c->regionOffset = TickTime{ oldRegionOffset_.ticks + addOffsetTicks_ };
    c->duration     = TickTime{ oldDuration_.ticks     - subtractDurationTicks_ };
    std::cout << "[Timeline] AutoTrim clip id=" << clipId_
              << " regionOffset " << oldRegionOffset_.ticks
              << " → " << c->regionOffset.ticks
              << ", duration " << oldDuration_.ticks
              << " → " << c->duration.ticks << "\n";
}

void AutoTrimClipCommand::undo(Timeline& timeline) {
    if (!snapshotValid_) return;
    Clip* c = timeline.getClipMutable(clipId_);
    if (!c) return;
    c->regionOffset = oldRegionOffset_;
    c->duration     = oldDuration_;
    std::cout << "[Timeline] Undo AutoTrim clip id=" << clipId_ << "\n";
}

std::string AutoTrimClipCommand::describe() const {
    return "Auto-Trim Clip id=" + std::to_string(clipId_)
         + " (+" + std::to_string(addOffsetTicks_) + " offset, -"
         + std::to_string(subtractDurationTicks_) + " duration)";
}

// ─── SetClipParamsCommand ─────────────────────────────────────────────────────

SetClipParamsCommand::SetClipParamsCommand(int clipId, Params newParams,
                                           const Timeline& timeline)
    : clipId_(clipId), newParams_(std::move(newParams))
{
    const Clip* c = timeline.getClip(clipId);
    if (c) {
        oldParams_.pitchOffsetSemis = c->pitchOffset;
        oldParams_.pitchOffsetCents = c->pitchOffsetCents;
        oldParams_.reversed         = c->reversed;
        oldParams_.stretchRatio     = c->stretchRatio;
        oldParams_.stretchMethod    = c->stretchMethod;
        oldParams_.formantPreserve  = c->formantPreserve;
        oldParams_.velocity         = c->velocity;
        oldParams_.fadeInPercent    = c->fadeInPercent;
        oldParams_.fadeOutPercent   = c->fadeOutPercent;
        oldParams_.fadeInX1         = c->fadeInX1;
        oldParams_.fadeInY1         = c->fadeInY1;
        oldParams_.fadeInX2         = c->fadeInX2;
        oldParams_.fadeInY2         = c->fadeInY2;
        oldParams_.fadeOutX1        = c->fadeOutX1;
        oldParams_.fadeOutY1        = c->fadeOutY1;
        oldParams_.fadeOutX2        = c->fadeOutX2;
        oldParams_.fadeOutY2        = c->fadeOutY2;
    } else {
        std::cerr << "[Undo] ERROR SetClipParamsCommand: clip id=" << clipId
                  << " not found\n";
    }
}

static void applyClipParams(Timeline& timeline, int clipId,
                             const SetClipParamsCommand::Params& p)
{
    Clip* c = timeline.getClipMutable(clipId);
    if (!c) return;
    c->pitchOffset      = p.pitchOffsetSemis;
    c->pitchOffsetCents = p.pitchOffsetCents;
    c->reversed         = p.reversed;
    c->stretchRatio     = p.stretchRatio;
    c->stretchMethod    = p.stretchMethod;
    c->formantPreserve  = p.formantPreserve;
    c->velocity         = p.velocity;
    c->fadeInPercent    = p.fadeInPercent;
    c->fadeOutPercent   = p.fadeOutPercent;
    normalizeClipFadePercents(c->fadeInPercent, c->fadeOutPercent);
    c->fadeInX1         = p.fadeInX1;
    c->fadeInY1         = p.fadeInY1;
    c->fadeInX2         = p.fadeInX2;
    c->fadeInY2         = p.fadeInY2;
    c->fadeOutX1        = p.fadeOutX1;
    c->fadeOutY1        = p.fadeOutY1;
    c->fadeOutX2        = p.fadeOutX2;
    c->fadeOutY2        = p.fadeOutY2;
}

void SetClipParamsCommand::execute(Timeline& timeline) {
    const Clip* before = timeline.getClip(clipId_);
    if (!before) {
        setApplied(false);
        return;
    }
    // Compared on the clip, after the fades are normalised: asking for a value
    // the clip already has is not an edit.
    const Clip snapshot = *before;
    applyClipParams(timeline, clipId_, newParams_);
    const Clip* after = timeline.getClip(clipId_);
    setApplied(after
        && (after->pitchOffset      != snapshot.pitchOffset
         || after->pitchOffsetCents != snapshot.pitchOffsetCents
         || after->reversed         != snapshot.reversed
         || after->stretchRatio     != snapshot.stretchRatio
         || after->stretchMethod    != snapshot.stretchMethod
         || after->formantPreserve  != snapshot.formantPreserve
         || after->velocity         != snapshot.velocity
         || after->fadeInPercent    != snapshot.fadeInPercent
         || after->fadeOutPercent   != snapshot.fadeOutPercent
         || after->fadeInX1  != snapshot.fadeInX1  || after->fadeInY1  != snapshot.fadeInY1
         || after->fadeInX2  != snapshot.fadeInX2  || after->fadeInY2  != snapshot.fadeInY2
         || after->fadeOutX1 != snapshot.fadeOutX1 || after->fadeOutY1 != snapshot.fadeOutY1
         || after->fadeOutX2 != snapshot.fadeOutX2 || after->fadeOutY2 != snapshot.fadeOutY2));
}

void SetClipParamsCommand::undo(Timeline& timeline) {
    applyClipParams(timeline, clipId_, oldParams_);
}

std::string SetClipParamsCommand::describe() const {
    return "Set Clip Params id=" + std::to_string(clipId_);
}

// ─── SetClipModulationCommand ─────────────────────────────────────────────────

SetClipModulationCommand::SetClipModulationCommand(int clipId, ClipModulation newMod,
                                                   const Timeline& timeline)
    : clipId_(clipId), newMod_(std::move(newMod))
{
    if (const Clip* c = timeline.getClip(clipId)) {
        oldMod_ = c->modulation;
    } else {
        std::cerr << "[Undo] ERROR SetClipModulationCommand: clip id=" << clipId
                  << " not found\n";
    }
}

void SetClipModulationCommand::execute(Timeline& timeline) {
    if (Clip* c = timeline.getClipMutable(clipId_))
        c->modulation = newMod_;
}

void SetClipModulationCommand::undo(Timeline& timeline) {
    if (Clip* c = timeline.getClipMutable(clipId_))
        c->modulation = oldMod_;
}

std::string SetClipModulationCommand::describe() const {
    return "Set Clip Modulation id=" + std::to_string(clipId_);
}

// ─── AddTrackCommand ──────────────────────────────────────────────────────────

AddTrackCommand::AddTrackCommand(TrackInfo track) : track_(std::move(track)) {}

void AddTrackCommand::execute(Timeline& timeline) {
    if (firstExecute_) {
        int id = timeline.addTrack(track_);
        track_.id     = id;
        firstExecute_ = false;
    } else {
        timeline.restoreTrack(track_);
    }
}

void AddTrackCommand::undo(Timeline& timeline) {
    timeline.removeTrack(track_.id);
}

std::string AddTrackCommand::describe() const {
    return "Add Track '" + track_.name + "'";
}

// ─── RemoveTrackCommand ───────────────────────────────────────────────────────

RemoveTrackCommand::RemoveTrackCommand(int trackId, const Timeline& timeline,
                                       double keepOnScreenTick, bool cascadeFromSource) {
    oldTrackLayout_ = timeline.getTrackLayout();
    const TrackInfo* t = timeline.getTrack(trackId);
    if (t) {
        track_ = *t;
        // Clones: a source takes its Clones with it (same step). A Voice
        // clone removed on its own rewrites its source's pins (see header).
        if (!t->isClone()) {
            for (const TrackInfo* c : clones::allClonesOf(timeline, trackId))
                cloneRemovals_.push_back(std::make_unique<RemoveTrackCommand>(
                    c->id, timeline, keepOnScreenTick, /*cascadeFromSource*/ true));
        } else if (t->isVoiceClone() && !cascadeFromSource) {
            const int voice = clones::voiceNumberOf(timeline, *t);
            if (voice >= 1) {
                for (int pid : clones::patternsPlayedBy(timeline, t->cloneOf)) {
                    const Pattern* p = timeline.getPattern(pid);
                    if (!p) continue;
                    std::vector<PatternNote> after = p->notes;
                    if (clones::rewritePinsForRemovedVoice(after, voice)) {
                        pinsBefore_.emplace_back(pid, p->notes);
                        pinsAfter_.emplace_back(pid, std::move(after));
                    }
                }
            }
        }
        // Motion view: detach every child, keeping it where it is on screen
        // at keepOnScreenTick (solved now, while the parent still exists).
        for (const TrackInfo* c : timeline.getAllTracks()) {
            if (c->id == trackId || c->parentTrackId != trackId) continue;
            DetachedChild d;
            d.trackId   = c->id;
            d.oldParent = c->parentTrackId;
            d.oldBase   = c->roam.base;
            const parentmath::KeepOnScreen k =
                parentmath::keepOnScreen(timeline, c->id, -1, keepOnScreenTick);
            d.newBase   = k.placed ? k.solve.base : c->roam.base;
            children_.push_back(d);
        }
    } else {
        std::cerr << "[Undo] ERROR RemoveTrackCommand: track id=" << trackId
                  << " not found in timeline\n";
    }
    // Snapshot all clips on this track so undo() can restore them
    for (const Clip* c : timeline.getClipsOnTrack(trackId))
        clips_.push_back(*c);
    // Snapshot all pattern-blocks on this track so undo() can restore them
    for (const PatternBlock* b : timeline.getPatternBlocksOnTrack(trackId))
        patternBlocks_.push_back(*b);
    // Snapshot grid state involving this track so undo() can restore it.
    const GridLayout& gl = timeline.getGridLayout();
    for (const auto& s : gl.slots) {
        if (s.trackId == trackId) {
            hadGridSlot_     = true;
            removedGridSlot_ = s;
            break;
        }
    }
    // Snapshot every fullscreen layer pointing at this track (with its index)
    // so undo() can restore them in original positions.
    for (size_t i = 0; i < gl.fullscreenLayers.size(); ++i) {
        if (gl.fullscreenLayers[i].trackId == trackId)
            removedFullscreenLayers_.emplace_back(i, gl.fullscreenLayers[i]);
    }
    // Automation cascade: the track's automation lanes and their clips. A lane
    // is owned by exactly one track, so deleting the track has to take them —
    // otherwise the project keeps lanes whose owner no longer exists and the
    // timeline has nowhere to draw them. Envelopes are left alone (a clip on a
    // surviving track may share one).
    for (const AutomationLane* l : timeline.getAutomationLanesForOwner(trackId)) {
        automationLanes_.push_back(*l);
        for (const AutomationClip* c : timeline.getAutomationClipsOnLane(l->id))
            automationClips_.push_back(*c);
    }
}

void RemoveTrackCommand::execute(Timeline& timeline) {
    if (!timeline.getTrack(track_.id)) {
        setApplied(false);   // nothing was captured, nothing to remove
        return;
    }
    // Clones first (they belong to this track), then the track itself.
    for (auto& c : cloneRemovals_) c->execute(timeline);
    for (auto& [pid, notes] : pinsAfter_) {
        std::vector<PatternNote> copy = notes;
        timeline.setPatternNotesKeepIds(pid, copy);
    }
    // Cascade: remove all clips and pattern-blocks first, then the track
    for (const auto& c : clips_) {
        std::cout << "[Undo] RemoveTrackCommand cascading clip id=" << c.id << "\n";
        timeline.removeClip(c.id);
    }
    for (const auto& b : patternBlocks_) {
        std::cout << "[Undo] RemoveTrackCommand cascading patternBlock id=" << b.id << "\n";
        timeline.removePatternBlock(b.id);
    }
    timeline.removeTrack(track_.id);
    // Grid cascade: remove track's slot, strip any fullscreen layers referencing it.
    if (hadGridSlot_)
        timeline.removeTrackFromGrid(track_.id);
    if (!removedFullscreenLayers_.empty())
        timeline.removeFullscreenLayersForTrack(track_.id);
    // Automation cascade (removeAutomationLane also drops the lane's clips).
    for (const auto& l : automationLanes_)
        timeline.removeAutomationLane(l.id);
    // Motion view: the removed track's children detach (keep-on-screen base).
    for (const auto& d : children_) {
        if (TrackInfo* c = timeline.getTrackMutable(d.trackId)) {
            c->parentTrackId = -1;
            c->roam.base     = d.newBase;
        }
    }
}

void RemoveTrackCommand::undo(Timeline& timeline) {
    // Children first: reattach to the track about to come back, old bases.
    for (const auto& d : children_) {
        if (TrackInfo* c = timeline.getTrackMutable(d.trackId)) {
            c->parentTrackId = d.oldParent;
            c->roam.base     = d.oldBase;
        }
    }
    // Restore track before clips/blocks (they logically belong to the track)
    timeline.restoreTrack(track_);
    // Exact restore of the captured state (not setTrackLayout, which regroups
    // Clones by the CURRENT order, where restoreTrack just appended this one).
    timeline.restoreTrackLayout(oldTrackLayout_);
    for (const auto& c : clips_)
        timeline.restoreClip(c);
    for (const auto& b : patternBlocks_)
        timeline.restorePatternBlock(b);
    // Grid restore.
    if (hadGridSlot_) {
        timeline.assignTrackToGrid(removedGridSlot_.trackId,
                                   removedGridSlot_.gridX, removedGridSlot_.gridY,
                                   removedGridSlot_.spanX, removedGridSlot_.spanY);
    }
    // Re-insert fullscreen layers in their original positions.
    for (const auto& [idx, layer] : removedFullscreenLayers_) {
        timeline.restoreFullscreenLayer(idx, layer);
    }
    // Automation restore: lanes first, then their clips (a clip needs its lane).
    for (const auto& l : automationLanes_) timeline.restoreAutomationLane(l);
    for (const auto& c : automationClips_) timeline.restoreAutomationClip(c);
    // Clones: pins back, then the Clones (newest removal undone first), then
    // the whole layout once every track is back.
    for (auto& [pid, notes] : pinsBefore_) {
        std::vector<PatternNote> copy = notes;
        timeline.setPatternNotesKeepIds(pid, copy);
    }
    for (auto it = cloneRemovals_.rbegin(); it != cloneRemovals_.rend(); ++it)
        (*it)->undo(timeline);
    if (!cloneRemovals_.empty())
        timeline.restoreTrackLayout(oldTrackLayout_);
}

std::string RemoveTrackCommand::describe() const {
    std::string s = "Remove Track '" + track_.name + "' (+"
         + std::to_string(clips_.size()) + " clip(s), +"
         + std::to_string(patternBlocks_.size()) + " block(s)";
    if (!children_.empty())
        s += ", " + std::to_string(children_.size()) + " child track(s) detached";
    if (!cloneRemovals_.empty())
        s += ", " + std::to_string(cloneRemovals_.size()) + " clone(s)";
    return s + ")";
}

// ─── Clones (docs/XLETH_CLONE_SPEC.md, model/Clone.h) ────────────────────────

namespace {
// The layout with `cloneId` moved directly under its source's other Clones
// (in the source's container). Clones not listed keep their place; the
// generic grouping (clones::withClonesAfterSources) does the rest.
TrackLayout layoutWithCloneLast(const Timeline& timeline, const TrackLayout& in,
                                int sourceId, int cloneId) {
    TrackLayout out = in;
    auto dropId = [&](int id) {
        out.rootOrder.erase(std::remove_if(out.rootOrder.begin(), out.rootOrder.end(),
            [&](const TrackLayoutItem& i) {
                return i.kind == TrackLayoutItem::Kind::Track && i.id == id;
            }), out.rootOrder.end());
        for (auto& f : out.folders)
            f.trackIds.erase(std::remove(f.trackIds.begin(), f.trackIds.end(), id), f.trackIds.end());
    };
    dropId(cloneId);
    // Insert after the source's last existing clone (or the source itself).
    int after = sourceId;
    for (const TrackInfo* c : clones::allClonesOf(timeline, sourceId))
        if (c->id != cloneId) after = c->id;
    for (size_t i = 0; i < out.rootOrder.size(); ++i) {
        const auto& item = out.rootOrder[i];
        if (item.kind == TrackLayoutItem::Kind::Track && item.id == after) {
            out.rootOrder.insert(out.rootOrder.begin() + static_cast<long>(i) + 1,
                                 { TrackLayoutItem::Kind::Track, cloneId });
            return out;
        }
    }
    for (auto& f : out.folders) {
        auto it = std::find(f.trackIds.begin(), f.trackIds.end(), after);
        if (it != f.trackIds.end()) { f.trackIds.insert(it + 1, cloneId); return out; }
    }
    out.rootOrder.push_back({ TrackLayoutItem::Kind::Track, cloneId });
    return out;
}

// First free whole cell of the active arrangement, row by row; false = full.
bool firstFreeCell(const GridLayout& g, int& gx, int& gy) {
    for (int r = 0; r < g.rows; ++r) {
        for (int c = 0; c < g.columns; ++c) {
            const int x = c * kGridSubUnitsPerColumn, y = r * kGridSubUnitsPerRow;
            bool free = true;
            for (const GridSlot& s : g.slots) {
                if (s.trackId < 0) continue;
                if (x < s.gridX + s.spanX && s.gridX < x + kGridSubUnitsPerColumn
                    && y < s.gridY + s.spanY && s.gridY < y + kGridSubUnitsPerRow) { free = false; break; }
            }
            if (free) { gx = x; gy = y; return true; }
        }
    }
    return false;
}
} // namespace

AddCloneCommand::AddCloneCommand(TrackInfo clone, bool autoPlace, const Timeline& timeline)
    : clone_(std::move(clone)), autoPlace_(autoPlace), oldLayout_(timeline.getTrackLayout()) {}

void AddCloneCommand::execute(Timeline& timeline) {
    if (firstExecute_) {
        const TrackInfo* src = timeline.getTrack(clone_.cloneOf);
        if (!src || src->isClone() || src->type != TrackInfo::Type::Pattern) {
            setApplied(false);
            return;
        }
        oldLayout_ = timeline.getTrackLayout();
        clone_.id  = timeline.addTrack(clone_);
        newLayout_ = layoutWithCloneLast(timeline, timeline.getTrackLayout(),
                                         clone_.cloneOf, clone_.id);
        if (autoPlace_ && clone_.cloneKind == CloneKind::Voice) {
            int gx = 0, gy = 0;
            const GridLayout& g = timeline.getGridLayout();
            if (firstFreeCell(g, gx, gy)) {
                slot_.trackId = clone_.id;
                slot_.gridX = gx;  slot_.gridY = gy;
                slot_.spanX = kGridSubUnitsPerColumn;
                slot_.spanY = kGridSubUnitsPerRow;
                slot_.zOrder = 0;
                for (const GridSlot& s : g.slots)
                    if (s.trackId == clone_.cloneOf) { slot_.zOrder = s.zOrder; break; }
                placed_ = true;
            }
        }
        firstExecute_ = false;
    } else {
        timeline.restoreTrack(clone_);
    }
    timeline.restoreTrackLayout(newLayout_);
    if (placed_)
        timeline.assignTrackToGridWithZOrder(slot_.trackId, slot_.gridX, slot_.gridY,
                                             slot_.spanX, slot_.spanY, slot_.zOrder);
}

void AddCloneCommand::undo(Timeline& timeline) {
    if (placed_) timeline.removeTrackFromGrid(clone_.id);
    timeline.removeTrack(clone_.id);
    timeline.restoreTrackLayout(oldLayout_);
}

std::string AddCloneCommand::describe() const {
    return std::string("Add ") + (clone_.cloneKind == CloneKind::Trail ? "Trail" : "Voice")
         + " clone '" + clone_.name + "'";
}

SetCloneSettingsCommand::SetCloneSettingsCommand(int trackId, CloneLensMode lensMode,
                                                 std::map<int, LensTrack> trackLens,
                                                 TrailSettings trail, const Timeline& timeline)
    : trackId_(trackId), newMode_(lensMode), newLens_(std::move(trackLens)), newTrail_(std::move(trail)) {
    if (const TrackInfo* t = timeline.getTrack(trackId); t && t->isClone()) {
        oldMode_  = t->cloneLensMode;
        oldLens_  = t->trackLens;
        oldTrail_ = t->trail;
        valid_    = true;
    }
}

bool SetCloneSettingsCommand::changesAnything() const {
    if (!valid_) return false;
    if (oldMode_ != newMode_ || oldTrail_ != newTrail_) return true;
    if (oldLens_.size() != newLens_.size()) return true;
    for (auto a = oldLens_.begin(), b2 = newLens_.begin(); a != oldLens_.end(); ++a, ++b2) {
        if (a->first != b2->first) return true;
        const LensTrack& x = a->second;
        const LensTrack& y = b2->second;
        if (x.base != y.base || x.keys != y.keys || x.zones != y.zones) return true;
    }
    return false;
}

void SetCloneSettingsCommand::execute(Timeline& timeline) {
    TrackInfo* t = timeline.getTrackMutable(trackId_);
    if (!valid_ || !t || !t->isClone()) { setApplied(false); return; }
    t->cloneLensMode = newMode_;
    t->trackLens     = newLens_;
    t->trail         = newTrail_;
}

void SetCloneSettingsCommand::undo(Timeline& timeline) {
    TrackInfo* t = timeline.getTrackMutable(trackId_);
    if (!t) return;
    t->cloneLensMode = oldMode_;
    t->trackLens     = oldLens_;
    t->trail         = oldTrail_;
}

std::string SetCloneSettingsCommand::describe() const {
    return "Clone settings (track " + std::to_string(trackId_) + ")";
}

ReorderClonesCommand::ReorderClonesCommand(int sourceTrackId, std::vector<int> cloneIdsInOrder,
                                           const Timeline& timeline)
    : sourceTrackId_(sourceTrackId), oldLayout_(timeline.getTrackLayout()) {
    const TrackInfo* src = timeline.getTrack(sourceTrackId);
    if (!src || src->isClone()) return;
    const auto current = clones::allClonesOf(timeline, sourceTrackId);
    if (current.size() != cloneIdsInOrder.size()) return;
    std::set<int> want(cloneIdsInOrder.begin(), cloneIdsInOrder.end());
    if (want.size() != cloneIdsInOrder.size()) return;
    for (const TrackInfo* c : current) if (!want.count(c->id)) return;

    // New layout: drop every clone, re-insert in the requested order after
    // the source (layoutWithCloneLast appends after the previous clone).
    TrackLayout layout = oldLayout_;
    auto dropId = [&](int id) {
        layout.rootOrder.erase(std::remove_if(layout.rootOrder.begin(), layout.rootOrder.end(),
            [&](const TrackLayoutItem& i) {
                return i.kind == TrackLayoutItem::Kind::Track && i.id == id;
            }), layout.rootOrder.end());
        for (auto& f : layout.folders)
            f.trackIds.erase(std::remove(f.trackIds.begin(), f.trackIds.end(), id), f.trackIds.end());
    };
    for (int id : cloneIdsInOrder) dropId(id);
    int after = sourceTrackId;
    for (int id : cloneIdsInOrder) {
        bool done = false;
        for (size_t i = 0; i < layout.rootOrder.size() && !done; ++i) {
            const auto& item = layout.rootOrder[i];
            if (item.kind == TrackLayoutItem::Kind::Track && item.id == after) {
                layout.rootOrder.insert(layout.rootOrder.begin() + static_cast<long>(i) + 1,
                                        { TrackLayoutItem::Kind::Track, id });
                done = true;
            }
        }
        for (auto& f : layout.folders) {
            if (done) break;
            auto it = std::find(f.trackIds.begin(), f.trackIds.end(), after);
            if (it != f.trackIds.end()) { f.trackIds.insert(it + 1, id); done = true; }
        }
        if (!done) return;
        after = id;
    }
    if (!timeline.isTrackLayoutValid(layout)) return;
    newLayout_ = layout;
    valid_ = true;

    // Voice renumbering: old voice k -> new voice of the same clone.
    std::vector<int> oldVoices;      // clone id per old voice (1-based at [k-1])
    for (const TrackInfo* c : current) if (c->isVoiceClone()) oldVoices.push_back(c->id);
    std::vector<int> newVoices;
    for (int id : cloneIdsInOrder) {
        const TrackInfo* c = timeline.getTrack(id);
        if (c && c->isVoiceClone()) newVoices.push_back(id);
    }
    std::vector<int> newOfOld(oldVoices.size() + 1, 0);
    bool renumbered = false;
    for (size_t k = 0; k < oldVoices.size(); ++k) {
        const auto it = std::find(newVoices.begin(), newVoices.end(), oldVoices[k]);
        newOfOld[k + 1] = static_cast<int>(it - newVoices.begin()) + 1;
        if (newOfOld[k + 1] != static_cast<int>(k) + 1) renumbered = true;
    }
    if (renumbered) {
        for (int pid : clones::patternsPlayedBy(timeline, sourceTrackId)) {
            const Pattern* p = timeline.getPattern(pid);
            if (!p) continue;
            std::vector<PatternNote> after2 = p->notes;
            if (clones::rewritePinsForReorder(after2, newOfOld)) {
                notesBefore_.emplace_back(pid, p->notes);
                notesAfter_.emplace_back(pid, std::move(after2));
            }
        }
    }
    std::vector<int> oldOrder;
    for (const TrackInfo* c : current) oldOrder.push_back(c->id);
    changed_ = oldOrder != cloneIdsInOrder;
}

void ReorderClonesCommand::execute(Timeline& timeline) {
    if (!valid_) { setApplied(false); return; }
    timeline.restoreTrackLayout(newLayout_);
    for (auto& [pid, notes] : notesAfter_) {
        std::vector<PatternNote> copy = notes;
        timeline.setPatternNotesKeepIds(pid, copy);
    }
}

void ReorderClonesCommand::undo(Timeline& timeline) {
    if (!valid_) return;
    for (auto& [pid, notes] : notesBefore_) {
        std::vector<PatternNote> copy = notes;
        timeline.setPatternNotesKeepIds(pid, copy);
    }
    timeline.restoreTrackLayout(oldLayout_);
}

std::string ReorderClonesCommand::describe() const {
    return "Reorder clones (track " + std::to_string(sourceTrackId_) + ")";
}

SetNotesVoicePinCommand::SetNotesVoicePinCommand(const std::vector<Ref>& notes, int pin,
                                                 const Timeline& timeline)
    : pin_(pin < 0 ? kVoicePinAuto : std::min(pin, kMaxVoicePin)) {
    for (const Ref& r : notes) {
        const Pattern* p = timeline.getPattern(r.patternId);
        if (!p || r.noteId <= 0) continue;
        bool dup = false;
        for (const Entry& e : entries_)
            if (e.ref.patternId == r.patternId && e.ref.noteId == r.noteId) { dup = true; break; }
        if (dup) continue;
        for (const PatternNote& n : p->notes) {
            if (n.id != r.noteId) continue;
            entries_.push_back({ r, n.voicePin });
            break;
        }
    }
}

bool SetNotesVoicePinCommand::changesAnything() const {
    for (const Entry& e : entries_) if (e.oldPin != pin_) return true;
    return false;
}

void SetNotesVoicePinCommand::execute(Timeline& timeline) {
    if (entries_.empty()) { setApplied(false); return; }
    for (const Entry& e : entries_) {
        Pattern* p = timeline.getPatternMutable(e.ref.patternId);
        if (!p) continue;
        for (PatternNote& n : p->notes)
            if (n.id == e.ref.noteId) { n.voicePin = pin_; break; }
    }
}

void SetNotesVoicePinCommand::undo(Timeline& timeline) {
    for (const Entry& e : entries_) {
        Pattern* p = timeline.getPatternMutable(e.ref.patternId);
        if (!p) continue;
        for (PatternNote& n : p->notes)
            if (n.id == e.ref.noteId) { n.voicePin = e.oldPin; break; }
    }
}

std::string SetNotesVoicePinCommand::describe() const {
    return "Pin " + std::to_string(entries_.size()) + " note(s) to voice "
         + (pin_ < 0 ? std::string("Auto") : std::to_string(pin_));
}

// ─── AddRegionCommand ─────────────────────────────────────────────────────────

AddRegionCommand::AddRegionCommand(SampleRegion region)
    : region_(std::move(region)) {}

void AddRegionCommand::execute(Timeline& timeline) {
    if (firstExecute_) {
        int id = timeline.addRegion(region_);
        region_.id    = id;
        firstExecute_ = false;
    } else {
        timeline.restoreRegion(region_);
    }
}

void AddRegionCommand::undo(Timeline& timeline) {
    timeline.removeRegion(region_.id);
}

std::string AddRegionCommand::describe() const {
    return "Add Region '" + region_.name + "'";
}

// ─── ModifyRegionCommand ──────────────────────────────────────────────────────

ModifyRegionCommand::ModifyRegionCommand(int regionId, SampleRegion newState,
                                         const Timeline& timeline)
    : newState_(std::move(newState))
{
    const SampleRegion* r = timeline.getRegion(regionId);
    if (r) {
        oldState_ = *r;
    } else {
        std::cerr << "[Undo] ERROR ModifyRegionCommand: region id=" << regionId
                  << " not found in timeline\n";
    }
    newState_.id = oldState_.id; // ensure the new state targets the same region
}

void ModifyRegionCommand::execute(Timeline& timeline) {
    SampleRegion* r = timeline.getRegionMutable(newState_.id);
    if (r) *r = newState_;
}

void ModifyRegionCommand::undo(Timeline& timeline) {
    SampleRegion* r = timeline.getRegionMutable(oldState_.id);
    if (r) *r = oldState_;
}

std::string ModifyRegionCommand::describe() const {
    return "Modify Region '" + oldState_.name + "'";
}

// ─── SetSyllablesCommand ──────────────────────────────────────────────────────

SetSyllablesCommand::SetSyllablesCommand(int regionId,
                                         std::vector<SampleRegion::Syllable> newSyllables,
                                         const Timeline& timeline)
    : regionId_(regionId), newSyllables_(std::move(newSyllables))
{
    const SampleRegion* r = timeline.getRegion(regionId);
    if (r) {
        oldSyllables_ = r->syllables;
    } else {
        std::cerr << "[Undo] ERROR SetSyllablesCommand: region id=" << regionId
                  << " not found in timeline\n";
    }
}

void SetSyllablesCommand::execute(Timeline& timeline) {
    SampleRegion* r = timeline.getRegionMutable(regionId_);
    if (r) r->syllables = newSyllables_;
}

void SetSyllablesCommand::undo(Timeline& timeline) {
    SampleRegion* r = timeline.getRegionMutable(regionId_);
    if (r) r->syllables = oldSyllables_;
}

std::string SetSyllablesCommand::describe() const {
    return "Set Syllables (region=" + std::to_string(regionId_)
         + ", n=" + std::to_string(newSyllables_.size()) + ")";
}

// ─── RemoveRegionCommand ──────────────────────────────────────────────────────

RemoveRegionCommand::RemoveRegionCommand(int regionId, const Timeline& timeline) {
    const SampleRegion* r = timeline.getRegion(regionId);
    if (r) {
        region_ = *r;
    } else {
        std::cerr << "[Undo] ERROR RemoveRegionCommand: region id=" << regionId
                  << " not found in timeline\n";
    }
}

void RemoveRegionCommand::execute(Timeline& timeline) {
    setApplied(timeline.removeRegion(region_.id));
}

void RemoveRegionCommand::undo(Timeline& timeline) {
    timeline.restoreRegion(region_);
}

std::string RemoveRegionCommand::describe() const {
    return "Remove Region '" + region_.name + "'";
}

// ─── SetBPMCommand ────────────────────────────────────────────────────────────

SetBPMCommand::SetBPMCommand(double newBpm, const Timeline& timeline)
    : oldBpm_(timeline.getBPM()), newBpm_(newBpm)
{
    // Snapshot stretchRatios for stretched clips when tempo-lock is on, so undo
    // restores exact values without floating-point drift from repeated BPM changes.
    if (timeline.getTempoLocked()) {
        for (const Clip* c : timeline.getAllClips()) {
            if (c && c->stretchRatio != 1.0)
                savedStretchRatios_[c->id] = c->stretchRatio;
        }
    }
    // Tempo lock or not: a trim says where in the SOURCE a clip starts.
    savedRegionOffsets_ = xleth::tempotrim::captureTrimOffsets(timeline);
}

void SetBPMCommand::execute(Timeline& timeline) {
    setApplied(newBpm_ != oldBpm_);
    timeline.setBPM(newBpm_);
    // When tempo-lock is on, scale stretchRatio for all stretched clips so
    // srcReadDesired = durSamp/stretchRatio stays constant — the same source
    // audio content is consumed at the new tempo regardless of clip label.
    // new_stretchRatio = (oldBpm/newBpm) × old_stretchRatio
    const double scale = oldBpm_ / newBpm_;
    for (const auto& [clipId, oldRatio] : savedStretchRatios_) {
        Clip* c = timeline.getClipMutable(clipId);
        if (c) c->stretchRatio = oldRatio * scale;
    }
    xleth::tempotrim::applyTrimOffsets(timeline, savedRegionOffsets_, oldBpm_, newBpm_);
}

void SetBPMCommand::undo(Timeline& timeline) {
    timeline.setBPM(oldBpm_);
    for (const auto& [clipId, oldRatio] : savedStretchRatios_) {
        Clip* c = timeline.getClipMutable(clipId);
        if (c) c->stretchRatio = oldRatio;
    }
    xleth::tempotrim::restoreTrimOffsets(timeline, savedRegionOffsets_);
}

std::string SetBPMCommand::describe() const {
    return "Set BPM " + std::to_string((int)oldBpm_)
         + " → " + std::to_string((int)newBpm_);
}

// ─── SetLoopRegionCommand ─────────────────────────────────────────────────────

SetLoopRegionCommand::SetLoopRegionCommand(LoopRegion newRegion, int64_t minLengthTicks,
                                           const Timeline& timeline)
    : oldRegion_(timeline.getLoopRegion()),
      newRegion_(newRegion),
      minLengthTicks_(minLengthTicks)
{
}

void SetLoopRegionCommand::execute(Timeline& timeline) {
    timeline.setLoopRegion(newRegion_, minLengthTicks_);
}

void SetLoopRegionCommand::undo(Timeline& timeline) {
    // Restore the exact prior region. It was already normalized when stored, so
    // a 1-tick floor is sufficient and will not perturb the snapshot.
    timeline.setLoopRegion(oldRegion_, 1);
}

std::string SetLoopRegionCommand::describe() const {
    return std::string("Set Loop Region [")
         + std::to_string(newRegion_.startTick) + ", "
         + std::to_string(newRegion_.endTick) + ") "
         + (newRegion_.loopEnabled ? "on" : "off");
}

// ─── SetTrackMutedCommand ─────────────────────────────────────────────────────

// ─── SetTrackGraphStateCommand ────────────────────────────────────────────────

SetTrackGraphStateCommand::SetTrackGraphStateCommand(int trackId,
                                                     nlohmann::json newGraphState,
                                                     const Timeline& timeline)
    : trackId_(trackId), newGraphState_(std::move(newGraphState))
{
    newHasGraphState_ = !newGraphState_.is_null();

    const TrackInfo* t = timeline.getTrack(trackId);
    if (!t) {
        record_ = false;
        return;
    }
    oldHasGraphState_ = t->hasGraphState;
    oldGraphState_    = t->graphState;

    // The renderer re-persists graphState on paths that may not have changed it
    // (re-validation, hydration write-back). An identical blob is not an edit.
    record_ = (oldHasGraphState_ != newHasGraphState_) || (oldGraphState_ != newGraphState_);
}

void SetTrackGraphStateCommand::execute(Timeline& timeline) {
    timeline.setTrackGraphState(trackId_, newHasGraphState_ ? newGraphState_ : nlohmann::json());
}

void SetTrackGraphStateCommand::undo(Timeline& timeline) {
    timeline.setTrackGraphState(trackId_, oldHasGraphState_ ? oldGraphState_ : nlohmann::json());
}

std::string SetTrackGraphStateCommand::describe() const {
    return "Edit FX Graph (Track " + std::to_string(trackId_) + ")";
}

// ─── SetTrackFxModeCommand ────────────────────────────────────────────────────

SetTrackFxModeCommand::SetTrackFxModeCommand(int trackId, TrackFxMode newMode, const Timeline& timeline)
    : trackId_(trackId), newMode_(newMode)
{
    const TrackInfo* t = timeline.getTrack(trackId);
    if (!t) {
        record_ = false;
        return;
    }
    oldMode_ = t->fxMode;
    record_  = (oldMode_ != newMode_);
}

void SetTrackFxModeCommand::execute(Timeline& timeline) {
    timeline.setTrackFxMode(trackId_, newMode_);
}

void SetTrackFxModeCommand::undo(Timeline& timeline) {
    timeline.setTrackFxMode(trackId_, oldMode_);
}

std::string SetTrackFxModeCommand::describe() const {
    return std::string(newMode_ == TrackFxMode::Graph ? "Use FX Graph" : "Use Mixer Chain")
         + " (Track " + std::to_string(trackId_) + ")";
}

SetTrackMutedCommand::SetTrackMutedCommand(int trackId, bool newMuted, const Timeline& timeline)
    : trackId_(trackId), newMuted_(newMuted)
{
    const TrackInfo* t = timeline.getTrack(trackId);
    oldMuted_ = t ? t->muted : false;
}

void SetTrackMutedCommand::execute(Timeline& timeline) {
    TrackInfo* t = timeline.getTrackMutable(trackId_);
    setApplied(t != nullptr && newMuted_ != oldMuted_);
    if (t) t->muted = newMuted_;
}

void SetTrackMutedCommand::undo(Timeline& timeline) {
    if (TrackInfo* t = timeline.getTrackMutable(trackId_))
        t->muted = oldMuted_;
}

std::string SetTrackMutedCommand::describe() const {
    return std::string(newMuted_ ? "Mute" : "Unmute") + " Track " + std::to_string(trackId_);
}

// ─── SetTrackVisualOnlyCommand ────────────────────────────────────────────────

SetTrackVisualOnlyCommand::SetTrackVisualOnlyCommand(int trackId, bool newVisualOnly, const Timeline& timeline)
    : trackId_(trackId), newVisualOnly_(newVisualOnly)
{
    const TrackInfo* t = timeline.getTrack(trackId);
    oldVisualOnly_ = t ? t->visualOnly : false;
}

void SetTrackVisualOnlyCommand::execute(Timeline& timeline) {
#ifdef XLETH_DEBUG
    fprintf(stderr, "[VisualOnly] Track %d visualOnly = %s\n",
            trackId_, newVisualOnly_ ? "true" : "false");
#endif
    if (TrackInfo* t = timeline.getTrackMutable(trackId_))
        t->visualOnly = newVisualOnly_;
}

void SetTrackVisualOnlyCommand::undo(Timeline& timeline) {
#ifdef XLETH_DEBUG
    fprintf(stderr, "[VisualOnly] Track %d visualOnly = %s (undo)\n",
            trackId_, oldVisualOnly_ ? "true" : "false");
#endif
    if (TrackInfo* t = timeline.getTrackMutable(trackId_))
        t->visualOnly = oldVisualOnly_;
}

std::string SetTrackVisualOnlyCommand::describe() const {
    return std::string(newVisualOnly_ ? "Set Visual-Only" : "Clear Visual-Only")
           + " Track " + std::to_string(trackId_);
}

// ─── SetTrackSoloCommand ──────────────────────────────────────────────────────

SetTrackSoloCommand::SetTrackSoloCommand(int trackId, bool newSolo, const Timeline& timeline)
    : trackId_(trackId), newSolo_(newSolo)
{
    const TrackInfo* t = timeline.getTrack(trackId);
    oldSolo_ = t ? t->solo : false;
}

void SetTrackSoloCommand::execute(Timeline& timeline) {
    TrackInfo* t = timeline.getTrackMutable(trackId_);
    setApplied(t != nullptr && newSolo_ != oldSolo_);
    if (t) t->solo = newSolo_;
}

void SetTrackSoloCommand::undo(Timeline& timeline) {
    if (TrackInfo* t = timeline.getTrackMutable(trackId_))
        t->solo = oldSolo_;
}

std::string SetTrackSoloCommand::describe() const {
    return std::string(newSolo_ ? "Solo" : "Unsolo") + " Track " + std::to_string(trackId_);
}

// ─── SetTrackOrderCommand ─────────────────────────────────────────────────────

SetTrackOrderCommand::SetTrackOrderCommand(std::vector<int> trackIdsInOrder, const Timeline& timeline)
    : trackIdsInOrder_(std::move(trackIdsInOrder)), oldTrackLayout_(timeline.getTrackLayout()) {}

void SetTrackOrderCommand::execute(Timeline& timeline) {
    timeline.setTrackOrder(trackIdsInOrder_);
}

void SetTrackOrderCommand::undo(Timeline& timeline) {
    timeline.restoreTrackLayout(oldTrackLayout_);   // exact captured state
}

std::string SetTrackOrderCommand::describe() const {
    return "Reorder Tracks";
}

SetTrackLayoutCommand::SetTrackLayoutCommand(TrackLayout newLayout, const Timeline& timeline,
                                             std::string description)
    : oldLayout_(timeline.getTrackLayout()), newLayout_(std::move(newLayout)),
      description_(std::move(description)) {}

void SetTrackLayoutCommand::execute(Timeline& timeline) { timeline.setTrackLayout(newLayout_); }
void SetTrackLayoutCommand::undo(Timeline& timeline) { timeline.restoreTrackLayout(oldLayout_); }   // exact captured state
std::string SetTrackLayoutCommand::describe() const { return description_; }

CreateTrackFolderCommand::CreateTrackFolderCommand(std::string name,
                                                   std::vector<int> trackIds,
                                                   int rootIndex,
                                                   const Timeline& timeline)
    : name_(std::move(name)), trackIds_(std::move(trackIds)), rootIndex_(rootIndex),
      oldLayout_(timeline.getTrackLayout()) {}

void CreateTrackFolderCommand::execute(Timeline& timeline) {
    if (firstExecute_) {
        folderId_ = timeline.createTrackFolder(name_, trackIds_, rootIndex_);
        createdLayout_ = timeline.getTrackLayout();
        firstExecute_ = false;
    } else {
        timeline.restoreTrackLayout(createdLayout_);
    }
}

void CreateTrackFolderCommand::undo(Timeline& timeline) { timeline.restoreTrackLayout(oldLayout_); }
std::string CreateTrackFolderCommand::describe() const { return "Create Track Folder '" + name_ + "'"; }

RenameTrackFolderCommand::RenameTrackFolderCommand(int folderId, std::string name,
                                                   const Timeline& timeline)
    : folderId_(folderId), newName_(std::move(name)) {
    for (const auto& folder : timeline.getTrackLayout().folders)
        if (folder.id == folderId_) oldName_ = folder.name;
}

void RenameTrackFolderCommand::execute(Timeline& timeline) {
    timeline.setTrackFolderName(folderId_, newName_);
}
void RenameTrackFolderCommand::undo(Timeline& timeline) {
    timeline.setTrackFolderName(folderId_, oldName_);
}
std::string RenameTrackFolderCommand::describe() const { return "Rename Track Folder"; }

SetTrackFolderCollapsedCommand::SetTrackFolderCollapsedCommand(
    int folderId, bool collapsed, const Timeline& timeline)
    : folderId_(folderId), oldCollapsed_(false), newCollapsed_(collapsed) {
    for (const auto& folder : timeline.getTrackLayout().folders)
        if (folder.id == folderId_) oldCollapsed_ = folder.collapsed;
}

void SetTrackFolderCollapsedCommand::execute(Timeline& timeline) {
    timeline.setTrackFolderCollapsed(folderId_, newCollapsed_);
}
void SetTrackFolderCollapsedCommand::undo(Timeline& timeline) {
    timeline.setTrackFolderCollapsed(folderId_, oldCollapsed_);
}
std::string SetTrackFolderCollapsedCommand::describe() const {
    return newCollapsed_ ? "Collapse Track Folder" : "Expand Track Folder";
}

RemoveTrackFolderCommand::RemoveTrackFolderCommand(int folderId, const Timeline& timeline)
    : folderId_(folderId), oldLayout_(timeline.getTrackLayout()) {
    for (const auto& folder : oldLayout_.folders)
        if (folder.id == folderId_) folderName_ = folder.name;
}

void RemoveTrackFolderCommand::execute(Timeline& timeline) {
    if (firstExecute_) {
        timeline.removeTrackFolder(folderId_);
        ungroupedLayout_ = timeline.getTrackLayout();
        firstExecute_ = false;
    } else {
        timeline.restoreTrackLayout(ungroupedLayout_);
    }
}
void RemoveTrackFolderCommand::undo(Timeline& timeline) { timeline.restoreTrackLayout(oldLayout_); }
std::string RemoveTrackFolderCommand::describe() const {
    return "Delete Track Folder '" + folderName_ + "' (Keep Tracks)";
}

// ─── SetTrackOutputRouteCommand ───────────────────────────────────────────────

SetTrackOutputRouteCommand::SetTrackOutputRouteCommand(int sourceTrackId,
                                                       int newTargetTrackId,
                                                       const Timeline& timeline)
    : sourceTrackId_(sourceTrackId), newTargetTrackId_(newTargetTrackId)
{
    const TrackInfo* t = timeline.getTrack(sourceTrackId);
    oldTargetTrackId_ = t ? t->outputRoute.targetTrackId : -1;
}

void SetTrackOutputRouteCommand::execute(Timeline& timeline) {
    if (TrackInfo* t = timeline.getTrackMutable(sourceTrackId_))
        t->outputRoute.targetTrackId = newTargetTrackId_;
}

void SetTrackOutputRouteCommand::undo(Timeline& timeline) {
    if (TrackInfo* t = timeline.getTrackMutable(sourceTrackId_))
        t->outputRoute.targetTrackId = oldTargetTrackId_;
}

std::string SetTrackOutputRouteCommand::describe() const {
    return "Set Track " + std::to_string(sourceTrackId_) + " output route to "
         + (newTargetTrackId_ == -1 ? "Master"
                                    : "track " + std::to_string(newTargetTrackId_));
}

// ─── SetTrackRoutesCommand ────────────────────────────────────────────────────

SetTrackRoutesCommand::SetTrackRoutesCommand(int sourceTrackId, int newTargetTrackId,
                                             std::vector<TrackSend> newSends,
                                             const Timeline& timeline)
    : sourceTrackId_(sourceTrackId),
      newTargetTrackId_(newTargetTrackId),
      newSends_(std::move(newSends))
{
    if (const TrackInfo* t = timeline.getTrack(sourceTrackId)) {
        oldTargetTrackId_ = t->outputRoute.targetTrackId;
        oldSends_         = t->sends;
    }
    for (auto& send : newSends_)
        send.gain = std::isfinite(send.gain) ? std::clamp(send.gain, 0.0f, 2.0f) : 1.0f;
}

void SetTrackRoutesCommand::execute(Timeline& timeline) {
    if (TrackInfo* t = timeline.getTrackMutable(sourceTrackId_)) {
        t->outputRoute.targetTrackId = newTargetTrackId_;
        t->sends = newSends_;
    }
}

void SetTrackRoutesCommand::undo(Timeline& timeline) {
    if (TrackInfo* t = timeline.getTrackMutable(sourceTrackId_)) {
        t->outputRoute.targetTrackId = oldTargetTrackId_;
        t->sends = oldSends_;
    }
}

std::string SetTrackRoutesCommand::describe() const {
    return "Route Track " + std::to_string(sourceTrackId_);
}

// ─── AddSidechainRouteCommand ─────────────────────────────────────────────────

AddSidechainRouteCommand::AddSidechainRouteCommand(int sourceTrackId, SidechainRoute route)
    : sourceTrackId_(sourceTrackId), route_(std::move(route))
{
    // Persist the safe gain once so redo and the model agree on the stored value.
    route_.gain = xleth::clampSidechainGain(route_.gain);
}

void AddSidechainRouteCommand::execute(Timeline& timeline) {
    TrackInfo* t = timeline.getTrackMutable(sourceTrackId_);
    if (!t) return;
    // Idempotent: never insert the same routeId twice (defensive against a
    // double-execute). The same route_ object → identical routeId on every redo.
    for (const auto& r : t->sidechainRoutes)
        if (r.routeId == route_.routeId) return;
    t->sidechainRoutes.push_back(route_);
}

void AddSidechainRouteCommand::undo(Timeline& timeline) {
    TrackInfo* t = timeline.getTrackMutable(sourceTrackId_);
    if (!t) return;
    auto& routes = t->sidechainRoutes;
    routes.erase(std::remove_if(routes.begin(), routes.end(),
                                [&](const SidechainRoute& r) { return r.routeId == route_.routeId; }),
                 routes.end());
}

std::string AddSidechainRouteCommand::describe() const {
    return "Add sidechain route " + route_.routeId + " on track "
         + std::to_string(sourceTrackId_) + " -> track "
         + std::to_string(route_.targetTrackId);
}

// ─── RemoveSidechainRouteCommand ──────────────────────────────────────────────

RemoveSidechainRouteCommand::RemoveSidechainRouteCommand(int sourceTrackId,
                                                         const std::string& routeId,
                                                         const Timeline& timeline)
    : sourceTrackId_(sourceTrackId), routeId_(routeId)
{
    const TrackInfo* t = timeline.getTrack(sourceTrackId);
    if (!t) return;
    for (size_t i = 0; i < t->sidechainRoutes.size(); ++i) {
        if (t->sidechainRoutes[i].routeId == routeId_) {
            removedRoute_ = t->sidechainRoutes[i];
            index_        = i;
            had_          = true;
            return;
        }
    }
}

void RemoveSidechainRouteCommand::execute(Timeline& timeline) {
    TrackInfo* t = timeline.getTrackMutable(sourceTrackId_);
    if (!t) return;
    auto& routes = t->sidechainRoutes;
    routes.erase(std::remove_if(routes.begin(), routes.end(),
                                [&](const SidechainRoute& r) { return r.routeId == routeId_; }),
                 routes.end());
}

void RemoveSidechainRouteCommand::undo(Timeline& timeline) {
    if (!had_) return;
    TrackInfo* t = timeline.getTrackMutable(sourceTrackId_);
    if (!t) return;
    auto& routes = t->sidechainRoutes;
    // Restore at the original index when still in range; otherwise append.
    const size_t pos = index_ <= routes.size() ? index_ : routes.size();
    routes.insert(routes.begin() + static_cast<std::ptrdiff_t>(pos), removedRoute_);
}

std::string RemoveSidechainRouteCommand::describe() const {
    return "Remove sidechain route " + routeId_ + " on track "
         + std::to_string(sourceTrackId_);
}

// ─── SetSidechainRouteParamsCommand ───────────────────────────────────────────

SetSidechainRouteParamsCommand::SetSidechainRouteParamsCommand(
    int sourceTrackId, const std::string& routeId,
    const xleth::SidechainRouteParams& newParams, const Timeline& timeline)
    : sourceTrackId_(sourceTrackId), routeId_(routeId), newParams_(newParams)
{
    newParams_.gain = xleth::clampSidechainGain(newParams_.gain);
    const TrackInfo* t = timeline.getTrack(sourceTrackId);
    if (!t) return;
    for (const auto& r : t->sidechainRoutes) {
        if (r.routeId == routeId_) {
            oldParams_.gain     = r.gain;
            oldParams_.preFader = r.preFader;
            oldParams_.enabled  = r.enabled;
            had_                = true;
            return;
        }
    }
}

void SetSidechainRouteParamsCommand::execute(Timeline& timeline) {
    timeline.setSidechainRouteParams(sourceTrackId_, routeId_, newParams_);
}

void SetSidechainRouteParamsCommand::undo(Timeline& timeline) {
    if (!had_) return;
    timeline.setSidechainRouteParams(sourceTrackId_, routeId_, oldParams_);
}

std::string SetSidechainRouteParamsCommand::describe() const {
    return "Set sidechain route " + routeId_ + " params on track "
         + std::to_string(sourceTrackId_);
}

// ─── SetTrackNameCommand ──────────────────────────────────────────────────────

SetTrackNameCommand::SetTrackNameCommand(int trackId, std::string newName, const Timeline& timeline)
    : trackId_(trackId), newName_(std::move(newName))
{
    const TrackInfo* t = timeline.getTrack(trackId);
    oldName_ = t ? t->name : std::string{};
}

void SetTrackNameCommand::execute(Timeline& timeline) {
    TrackInfo* t = timeline.getTrackMutable(trackId_);
    setApplied(t != nullptr && newName_ != oldName_);
    if (t) t->name = newName_;
}

void SetTrackNameCommand::undo(Timeline& timeline) {
    if (TrackInfo* t = timeline.getTrackMutable(trackId_))
        t->name = oldName_;
}

std::string SetTrackNameCommand::describe() const {
    return "Rename Track " + std::to_string(trackId_) + " to \"" + newName_ + "\"";
}

// ─── SetPatternNameCommand ────────────────────────────────────────────────────

SetPatternNameCommand::SetPatternNameCommand(int patternId, std::string newName, const Timeline& timeline)
    : patternId_(patternId), newName_(std::move(newName))
{
    const Pattern* p = timeline.getPattern(patternId);
    oldName_ = p ? p->name : std::string{};
}

void SetPatternNameCommand::execute(Timeline& timeline) {
    if (Pattern* p = timeline.getPatternMutable(patternId_))
        p->name = newName_;
}

void SetPatternNameCommand::undo(Timeline& timeline) {
    if (Pattern* p = timeline.getPatternMutable(patternId_))
        p->name = oldName_;
}

std::string SetPatternNameCommand::describe() const {
    return "Rename Pattern " + std::to_string(patternId_) + " to \"" + newName_ + "\"";
}

// ─── SetPatternRegionCommand ─────────────────────────────────────────────────

SetPatternRegionCommand::SetPatternRegionCommand(int patternId, int newRegionId, const Timeline& timeline)
    : patternId_(patternId), newRegionId_(newRegionId)
{
    const Pattern* p = timeline.getPattern(patternId);
    oldRegionId_ = p ? p->regionId : -1;
}

void SetPatternRegionCommand::execute(Timeline& timeline) {
    if (Pattern* p = timeline.getPatternMutable(patternId_))
        p->regionId = newRegionId_;
}

void SetPatternRegionCommand::undo(Timeline& timeline) {
    if (Pattern* p = timeline.getPatternMutable(patternId_))
        p->regionId = oldRegionId_;
}

std::string SetPatternRegionCommand::describe() const {
    return "Set Pattern " + std::to_string(patternId_) + " region to " + std::to_string(newRegionId_);
}

// ─── SetGridLayoutCommand ─────────────────────────────────────────────────────

SetGridLayoutCommand::SetGridLayoutCommand(GridLayout newLayout, const Timeline& timeline)
    : oldLayout_(timeline.getGridLayout()), newLayout_(std::move(newLayout)) {}

void SetGridLayoutCommand::execute(Timeline& timeline) {
    timeline.setGridLayout(newLayout_);
}

void SetGridLayoutCommand::undo(Timeline& timeline) {
    timeline.setGridLayout(oldLayout_);
}

std::string SetGridLayoutCommand::describe() const {
    return "Set Grid Layout "
         + std::to_string(newLayout_.columns) + "x" + std::to_string(newLayout_.rows);
}

// ─── AssignTrackToGridCommand ─────────────────────────────────────────────────

AssignTrackToGridCommand::AssignTrackToGridCommand(int trackId, int gridX, int gridY,
                                                   int spanX, int spanY,
                                                   const Timeline& timeline)
    : trackId_(trackId), gridX_(gridX), gridY_(gridY), spanX_(spanX), spanY_(spanY)
{
    for (const auto& s : timeline.getGridLayout().slots) {
        if (s.trackId == trackId) {
            hadPrevious_ = true;
            prevSlot_    = s;
            break;
        }
    }
}

AssignTrackToGridCommand::AssignTrackToGridCommand(int trackId, int gridX, int gridY,
                                                   int spanX, int spanY, int zOrder,
                                                   const Timeline& timeline)
    : trackId_(trackId), gridX_(gridX), gridY_(gridY), spanX_(spanX), spanY_(spanY),
      hasZOrder_(true), zOrder_(zOrder)
{
    for (const auto& s : timeline.getGridLayout().slots) {
        if (s.trackId == trackId) {
            hadPrevious_ = true;
            prevSlot_    = s;
            break;
        }
    }
}

void AssignTrackToGridCommand::execute(Timeline& timeline) {
    if (hasZOrder_) {
        timeline.assignTrackToGridWithZOrder(trackId_, gridX_, gridY_,
                                             spanX_, spanY_, zOrder_);
    } else {
        timeline.assignTrackToGrid(trackId_, gridX_, gridY_, spanX_, spanY_);
    }
}

void AssignTrackToGridCommand::undo(Timeline& timeline) {
    if (hadPrevious_) {
        timeline.assignTrackToGrid(prevSlot_.trackId, prevSlot_.gridX, prevSlot_.gridY,
                                   prevSlot_.spanX, prevSlot_.spanY);
    } else {
        timeline.removeTrackFromGrid(trackId_);
    }
}

std::string AssignTrackToGridCommand::describe() const {
    return "Assign Track " + std::to_string(trackId_)
         + " to Grid (" + std::to_string(gridX_) + "," + std::to_string(gridY_) + ")";
}

// ─── RemoveTrackFromGridCommand ───────────────────────────────────────────────

RemoveTrackFromGridCommand::RemoveTrackFromGridCommand(int trackId, const Timeline& timeline)
    : trackId_(trackId)
{
    for (const auto& s : timeline.getGridLayout().slots) {
        if (s.trackId == trackId) {
            hadSlot_     = true;
            removedSlot_ = s;
            break;
        }
    }
}

void RemoveTrackFromGridCommand::execute(Timeline& timeline) {
    timeline.removeTrackFromGrid(trackId_);
}

void RemoveTrackFromGridCommand::undo(Timeline& timeline) {
    if (hadSlot_) {
        timeline.assignTrackToGrid(removedSlot_.trackId, removedSlot_.gridX, removedSlot_.gridY,
                                   removedSlot_.spanX, removedSlot_.spanY);
    }
}

std::string RemoveTrackFromGridCommand::describe() const {
    return "Remove Track " + std::to_string(trackId_) + " from Grid";
}

// ─── SetFullscreenLayersCommand ───────────────────────────────────────────────

SetFullscreenLayersCommand::SetFullscreenLayersCommand(std::vector<FullscreenLayer> newLayers,
                                                       const Timeline& timeline)
    : oldLayers_(timeline.getFullscreenLayers()),
      newLayers_(std::move(newLayers))
{
    // Snapshot pre-execute videoHoldLastFrame for every track that a new
    // BehindGrid layer will auto-enable. First writer wins so that if the same
    // track appears multiple times we only capture its true pre-command value.
    for (const auto& fl : newLayers_) {
        if (fl.placement != FullscreenLayerPlacement::BehindGrid) continue;
        if (fl.trackId < 0) continue;
        if (oldHoldByTrackId_.count(fl.trackId)) continue;
        if (const TrackInfo* t = timeline.getTrack(fl.trackId))
            oldHoldByTrackId_[fl.trackId] = t->videoHoldLastFrame;
    }
}

void SetFullscreenLayersCommand::execute(Timeline& timeline) {
    timeline.setFullscreenLayers(newLayers_);
}

void SetFullscreenLayersCommand::undo(Timeline& timeline) {
    timeline.setFullscreenLayers(oldLayers_);
    // Restore videoHoldLastFrame on tracks the command auto-enabled — but only
    // for tracks that aren't BehindGrid in the restored layer set (those should
    // remain hold-enabled to preserve the setFullscreenLayers invariant).
    std::unordered_set<int> stillBehind;
    for (const auto& fl : oldLayers_) {
        if (fl.placement == FullscreenLayerPlacement::BehindGrid && fl.trackId >= 0)
            stillBehind.insert(fl.trackId);
    }
    for (const auto& [tid, oldHold] : oldHoldByTrackId_) {
        if (stillBehind.count(tid)) continue;
        if (TrackInfo* t = timeline.getTrackMutable(tid))
            t->videoHoldLastFrame = oldHold;
    }
}

std::string SetFullscreenLayersCommand::describe() const {
    return "Set Fullscreen Layers (count=" + std::to_string(newLayers_.size()) + ")";
}

// ─── SetPlacementZOrderCommand ────────────────────────────────────────────────

SetPlacementZOrderCommand::SetPlacementZOrderCommand(int trackId, int newZOrder,
                                                     const Timeline& timeline)
    : trackId_(trackId), newZOrder_(newZOrder)
{
    // Snapshot the current placement zOrder for undo (grid slot wins; a track is
    // grid-slotted OR fullscreen by construction).
    const GridLayout& gl = timeline.getGridLayout();
    for (const auto& s : gl.slots) {
        if (s.trackId == trackId) {
            hadPlacement_ = true;
            oldZOrder_    = s.zOrder;
            return;
        }
    }
    for (const auto& fl : gl.fullscreenLayers) {
        if (fl.trackId == trackId) {
            hadPlacement_ = true;
            oldZOrder_    = fl.zOrder;
            return;
        }
    }
    // hadPlacement_ stays false → execute/undo are no-ops.
}

void SetPlacementZOrderCommand::execute(Timeline& timeline) {
    if (!hadPlacement_) return;
    timeline.setPlacementZOrder(trackId_, newZOrder_);
}

void SetPlacementZOrderCommand::undo(Timeline& timeline) {
    if (!hadPlacement_) return;
    timeline.setPlacementZOrder(trackId_, oldZOrder_);
}

std::string SetPlacementZOrderCommand::describe() const {
    return "Set Placement zOrder (track " + std::to_string(trackId_)
         + " = " + std::to_string(newZOrder_) + ")";
}

// ─── SetPreviewFpsCommand ─────────────────────────────────────────────────────

SetPreviewFpsCommand::SetPreviewFpsCommand(int fps, const Timeline& timeline)
    : oldFps_(timeline.getGridLayout().previewFps), newFps_(fps) {}

void SetPreviewFpsCommand::execute(Timeline& timeline) {
    timeline.setPreviewFps(newFps_);
}

void SetPreviewFpsCommand::undo(Timeline& timeline) {
    timeline.setPreviewFps(oldFps_);
}

std::string SetPreviewFpsCommand::describe() const {
    return "Set Preview FPS " + std::to_string(newFps_);
}

// ─── AddPatternCommand ────────────────────────────────────────────────────────

AddPatternCommand::AddPatternCommand(Pattern pattern) : pattern_(std::move(pattern)) {}

void AddPatternCommand::execute(Timeline& timeline) {
    if (firstExecute_) {
        int id = timeline.addPattern(pattern_);
        if (id < 0) {
            std::cerr << "[Undo] ERROR AddPatternCommand::execute: addPattern failed"
                         " (check regionId exists)\n";
            return;
        }
        pattern_.id   = id;
        firstExecute_ = false;
    } else {
        timeline.restorePattern(pattern_);
    }
}

void AddPatternCommand::undo(Timeline& timeline) {
    timeline.removePattern(pattern_.id);
}

std::string AddPatternCommand::describe() const {
    return "Add Pattern '" + pattern_.name + "' (region="
         + std::to_string(pattern_.regionId) + ")";
}

// ─── RemovePatternCommand ─────────────────────────────────────────────────────

RemovePatternCommand::RemovePatternCommand(int patternId, const Timeline& timeline) {
    const Pattern* p = timeline.getPattern(patternId);
    if (p) {
        pattern_ = *p;
    } else {
        std::cerr << "[Undo] ERROR RemovePatternCommand: pattern id=" << patternId
                  << " not found in timeline\n";
    }
    // Snapshot all blocks that reference this pattern.
    for (const PatternBlock* b : timeline.getAllPatternBlocks()) {
        if (b->patternId == patternId) blocks_.push_back(*b);
    }
}

void RemovePatternCommand::execute(Timeline& timeline) {
    if (!timeline.getPattern(pattern_.id)) {
        setApplied(false);
        return;
    }
    // Cascade: blocks first, then remove the pattern.
    for (const auto& b : blocks_) {
        std::cout << "[Undo] RemovePatternCommand cascading block id=" << b.id << "\n";
        timeline.removePatternBlock(b.id);
    }
    timeline.removePattern(pattern_.id);
}

void RemovePatternCommand::undo(Timeline& timeline) {
    // Restore pattern before blocks (blocks reference it).
    timeline.restorePattern(pattern_);
    for (const auto& b : blocks_)
        timeline.restorePatternBlock(b);
}

std::string RemovePatternCommand::describe() const {
    return "Remove Pattern '" + pattern_.name + "' (+"
         + std::to_string(blocks_.size()) + " block(s))";
}

// ─── SetSamplerSettingsCommand ────────────────────────────────────────────────

SetSamplerSettingsCommand::SetSamplerSettingsCommand(int regionId,
                                                     SamplerSettings newSettings,
                                                     const Timeline& timeline)
    : regionId_(regionId), newSettings_(newSettings)
{
    const SampleRegion* r = timeline.getRegion(regionId);
    if (r) {
        oldSettings_.slots            = r->slots;
        oldSettings_.crossfadeEnabled = r->crossfadeEnabled;
        oldSettings_.monoEnabled       = r->monoEnabled;
        oldSettings_.portamentoEnabled = r->portamentoEnabled;
        oldSettings_.portamentoTimeMs  = r->portamentoTimeMs;
        oldSettings_.portamentoMode    = r->portamentoMode;
        oldSettings_.portamentoCurve   = r->portamentoCurve;
        oldSettings_.legatoEnabled     = r->legatoEnabled;
        oldSettings_.voiceCount        = r->voiceCount;
        oldSettings_.arpEnabled        = r->arpEnabled;
        oldSettings_.arpTempoSync      = r->arpTempoSync;
        oldSettings_.arpDivision       = r->arpDivision;
        oldSettings_.arpFreeTimeMs     = r->arpFreeTimeMs;
        oldSettings_.arpGate           = r->arpGate;
        oldSettings_.arpRange          = r->arpRange;
        oldSettings_.arpDirection      = r->arpDirection;
        oldSettings_.modulation            = r->modulation;
    } else {
        std::cerr << "[Undo] ERROR SetSamplerSettingsCommand: region id=" << regionId
                  << " not found in timeline\n";
    }
}

static void applySamplerSettings(SampleRegion* r, const SamplerSettings& s) {
    r->slots            = s.slots;
    if (r->slots.empty()) r->slots.emplace_back();   // invariant: never zero slots
    r->crossfadeEnabled = s.crossfadeEnabled;
    r->monoEnabled       = s.monoEnabled;
    r->portamentoEnabled = s.portamentoEnabled;
    r->portamentoTimeMs  = s.portamentoTimeMs;
    r->portamentoMode    = s.portamentoMode;
    r->portamentoCurve   = s.portamentoCurve;
    r->legatoEnabled     = s.legatoEnabled;
    r->voiceCount        = s.voiceCount;
    r->arpEnabled        = s.arpEnabled;
    r->arpTempoSync      = s.arpTempoSync;
    r->arpDivision       = s.arpDivision;
    r->arpFreeTimeMs     = s.arpFreeTimeMs;
    r->arpGate           = s.arpGate;
    r->arpRange          = s.arpRange;
    r->arpDirection      = s.arpDirection;
    r->modulation            = s.modulation;
}

void SetSamplerSettingsCommand::execute(Timeline& timeline) {
    if (SampleRegion* r = timeline.getRegionMutable(regionId_))
        applySamplerSettings(r, newSettings_);
}

void SetSamplerSettingsCommand::undo(Timeline& timeline) {
    if (SampleRegion* r = timeline.getRegionMutable(regionId_))
        applySamplerSettings(r, oldSettings_);
}

std::string SetSamplerSettingsCommand::describe() const {
    return "Set Sampler Settings (region=" + std::to_string(regionId_) + ")";
}

// ─── AddPatternBlockCommand ───────────────────────────────────────────────────

AddPatternBlockCommand::AddPatternBlockCommand(PatternBlock block)
    : block_(std::move(block)) {}

void AddPatternBlockCommand::execute(Timeline& timeline) {
    if (firstExecute_) {
        int id = timeline.addPatternBlock(block_);
        if (id < 0) {
            // Timeline::addPatternBlock refuses three ways; only the last is common.
            const char* why = !timeline.getTrack(block_.trackId)     ? "trackId does not exist"
                            : !timeline.getPattern(block_.patternId) ? "patternId does not exist"
                            : "exact duplicate of an existing {trackId, patternId, position} block";
            std::cerr << "[Undo] ERROR AddPatternBlockCommand::execute: addPatternBlock"
                         " refused (" << why << "; trackId=" << block_.trackId
                      << " patternId=" << block_.patternId
                      << " position=" << block_.position.ticks << ")\n";
            setApplied(false);
            return;
        }
        block_.id     = id;
        firstExecute_ = false;
    } else {
        timeline.restorePatternBlock(block_);
    }
}

void AddPatternBlockCommand::undo(Timeline& timeline) {
    timeline.removePatternBlock(block_.id);
}

std::string AddPatternBlockCommand::describe() const {
    return "Add PatternBlock (pattern=" + std::to_string(block_.patternId)
         + " track=" + std::to_string(block_.trackId) + ")";
}

// ─── RemovePatternBlockCommand ────────────────────────────────────────────────

RemovePatternBlockCommand::RemovePatternBlockCommand(int blockId, const Timeline& timeline) {
    const PatternBlock* b = timeline.getPatternBlock(blockId);
    if (b) {
        block_ = *b;
    } else {
        std::cerr << "[Undo] ERROR RemovePatternBlockCommand: block id=" << blockId
                  << " not found in timeline\n";
    }
}

void RemovePatternBlockCommand::execute(Timeline& timeline) {
    setApplied(timeline.removePatternBlock(block_.id));
}

void RemovePatternBlockCommand::undo(Timeline& timeline) {
    timeline.restorePatternBlock(block_);
}

std::string RemovePatternBlockCommand::describe() const {
    return "Remove PatternBlock id=" + std::to_string(block_.id);
}

// ─── MovePatternBlockCommand ──────────────────────────────────────────────────

MovePatternBlockCommand::MovePatternBlockCommand(int blockId, int newTrackId,
                                                 TickTime newPosition,
                                                 const Timeline& timeline)
    : blockId_(blockId), newTrackId_(newTrackId), newPosition_(newPosition)
{
    const PatternBlock* b = timeline.getPatternBlock(blockId);
    if (b) {
        oldTrackId_  = b->trackId;
        oldPosition_ = b->position;
    } else {
        std::cerr << "[Undo] ERROR MovePatternBlockCommand: block id=" << blockId
                  << " not found in timeline\n";
        oldTrackId_ = -1;
    }
}

void MovePatternBlockCommand::execute(Timeline& timeline) {
    const bool moved = timeline.movePatternBlock(blockId_, newTrackId_, newPosition_);
    setApplied(moved && (newTrackId_ != oldTrackId_
                         || newPosition_.ticks != oldPosition_.ticks));
}

void MovePatternBlockCommand::undo(Timeline& timeline) {
    timeline.movePatternBlock(blockId_, oldTrackId_, oldPosition_);
}

std::string MovePatternBlockCommand::describe() const {
    return "Move PatternBlock id=" + std::to_string(blockId_)
         + " (" + std::to_string(oldPosition_.ticks)
         + " → " + std::to_string(newPosition_.ticks) + " ticks)";
}

// ─── ResizePatternBlockCommand ────────────────────────────────────────────────

ResizePatternBlockCommand::ResizePatternBlockCommand(int blockId, TickTime newDuration,
                                                     const Timeline& timeline)
    : blockId_(blockId), newDuration_(newDuration)
{
    const PatternBlock* b = timeline.getPatternBlock(blockId);
    if (b) {
        oldDuration_ = b->duration;
    } else {
        std::cerr << "[Undo] ERROR ResizePatternBlockCommand: block id=" << blockId
                  << " not found in timeline\n";
    }
}

void ResizePatternBlockCommand::execute(Timeline& timeline) {
    const bool ok = timeline.resizePatternBlock(blockId_, newDuration_);
    setApplied(ok && newDuration_.ticks != oldDuration_.ticks);
}

void ResizePatternBlockCommand::undo(Timeline& timeline) {
    timeline.resizePatternBlock(blockId_, oldDuration_);
}

std::string ResizePatternBlockCommand::describe() const {
    return "Resize PatternBlock id=" + std::to_string(blockId_)
         + " (" + std::to_string(oldDuration_.ticks)
         + " → " + std::to_string(newDuration_.ticks) + " ticks)";
}

// ─── ResizePatternBlockLeftCommand ───────────────────────────────────────────

ResizePatternBlockLeftCommand::ResizePatternBlockLeftCommand(
    int blockId, TickTime newPosition, TickTime newDuration, TickTime newOffset,
    const Timeline& timeline)
    : blockId_(blockId), newPosition_(newPosition), newDuration_(newDuration),
      newOffset_(newOffset)
{
    const PatternBlock* b = timeline.getPatternBlock(blockId);
    if (b) {
        oldPosition_ = b->position;
        oldDuration_ = b->duration;
        oldOffset_   = b->offset;
    } else {
        std::cerr << "[Undo] ERROR ResizePatternBlockLeftCommand: block id=" << blockId
                  << " not found in timeline\n";
    }
}

void ResizePatternBlockLeftCommand::execute(Timeline& timeline) {
    const bool ok = timeline.resizePatternBlockLeft(blockId_, newPosition_, newDuration_, newOffset_);
    setApplied(ok && (newPosition_.ticks != oldPosition_.ticks
                      || newDuration_.ticks != oldDuration_.ticks
                      || newOffset_.ticks   != oldOffset_.ticks));
}

void ResizePatternBlockLeftCommand::undo(Timeline& timeline) {
    timeline.resizePatternBlockLeft(blockId_, oldPosition_, oldDuration_, oldOffset_);
}

std::string ResizePatternBlockLeftCommand::describe() const {
    return "Resize PatternBlock left id=" + std::to_string(blockId_)
         + " (pos " + std::to_string(oldPosition_.ticks)
         + "→" + std::to_string(newPosition_.ticks)
         + " offset " + std::to_string(oldOffset_.ticks)
         + "→" + std::to_string(newOffset_.ticks) + ")";
}

// ─── SetPatternBlockLoopCommand ───────────────────────────────────────────────

SetPatternBlockLoopCommand::SetPatternBlockLoopCommand(int blockId, bool newLoopEnabled,
                                                       const Timeline& timeline)
    : blockId_(blockId), newLoopEnabled_(newLoopEnabled)
{
    const PatternBlock* b = timeline.getPatternBlock(blockId);
    if (b) {
        oldLoopEnabled_ = b->loopEnabled;
    } else {
        oldLoopEnabled_ = true;
        std::cerr << "[Undo] ERROR SetPatternBlockLoopCommand: block id=" << blockId
                  << " not found in timeline\n";
    }
}

void SetPatternBlockLoopCommand::execute(Timeline& timeline) {
    const bool ok = timeline.setPatternBlockLoopEnabled(blockId_, newLoopEnabled_);
    setApplied(ok && newLoopEnabled_ != oldLoopEnabled_);
}

void SetPatternBlockLoopCommand::undo(Timeline& timeline) {
    timeline.setPatternBlockLoopEnabled(blockId_, oldLoopEnabled_);
}

std::string SetPatternBlockLoopCommand::describe() const {
    return std::string("Set PatternBlock id=") + std::to_string(blockId_)
         + " loopEnabled=" + (newLoopEnabled_ ? "true" : "false");
}

// ─── AddNoteCommand ───────────────────────────────────────────────────────────

AddNoteCommand::AddNoteCommand(int patternId, PatternNote note)
    : patternId_(patternId), note_(std::move(note)) {}

void AddNoteCommand::execute(Timeline& timeline) {
    if (firstExecute_) {
        int id = timeline.addNoteToPattern(patternId_, note_);
        if (id < 0) {
            std::cerr << "[Undo] ERROR AddNoteCommand::execute: addNoteToPattern failed"
                         " (check patternId exists)\n";
            setApplied(false);
            return;
        }
        note_.id      = id;
        firstExecute_ = false;
    } else {
        timeline.restoreNoteInPattern(patternId_, note_);
    }
}

void AddNoteCommand::undo(Timeline& timeline) {
    timeline.removeNoteFromPattern(patternId_, note_.id);
}

std::string AddNoteCommand::describe() const {
    return "Add Note (pattern=" + std::to_string(patternId_)
         + " pitch=" + std::to_string(note_.pitch) + ")";
}

// ─── RemoveNoteCommand ────────────────────────────────────────────────────────

RemoveNoteCommand::RemoveNoteCommand(int patternId, int noteId, const Timeline& timeline)
    : patternId_(patternId)
{
    const Pattern* p = timeline.getPattern(patternId);
    if (p) {
        for (const auto& n : p->notes) {
            if (n.id == noteId) { note_ = n; return; }
        }
        std::cerr << "[Undo] ERROR RemoveNoteCommand: noteId=" << noteId
                  << " not found in pattern=" << patternId << "\n";
    } else {
        std::cerr << "[Undo] ERROR RemoveNoteCommand: patternId=" << patternId
                  << " not found\n";
    }
}

void RemoveNoteCommand::execute(Timeline& timeline) {
    setApplied(timeline.removeNoteFromPattern(patternId_, note_.id));
}

void RemoveNoteCommand::undo(Timeline& timeline) {
    timeline.restoreNoteInPattern(patternId_, note_);
}

std::string RemoveNoteCommand::describe() const {
    return "Remove Note id=" + std::to_string(note_.id)
         + " (pattern=" + std::to_string(patternId_) + ")";
}

// ─── MoveNoteCommand ──────────────────────────────────────────────────────────

MoveNoteCommand::MoveNoteCommand(int patternId, int noteId, TickTime newPosition,
                                 int newPitch, const Timeline& timeline)
    : patternId_(patternId), noteId_(noteId),
      newPosition_(newPosition), newPitch_(newPitch)
{
    const Pattern* p = timeline.getPattern(patternId);
    if (p) {
        for (const auto& n : p->notes) {
            if (n.id == noteId) {
                oldPosition_ = n.position;
                oldPitch_    = n.pitch;
                return;
            }
        }
    }
    std::cerr << "[Undo] ERROR MoveNoteCommand: noteId=" << noteId
              << " not found in pattern=" << patternId << "\n";
    oldPitch_ = 60;
}

void MoveNoteCommand::execute(Timeline& timeline) {
    const bool ok = timeline.moveNote(patternId_, noteId_, newPosition_, newPitch_);
    setApplied(ok && (newPosition_.ticks != oldPosition_.ticks || newPitch_ != oldPitch_));
}

void MoveNoteCommand::undo(Timeline& timeline) {
    timeline.moveNote(patternId_, noteId_, oldPosition_, oldPitch_);
}

std::string MoveNoteCommand::describe() const {
    return "Move Note id=" + std::to_string(noteId_)
         + " (pattern=" + std::to_string(patternId_) + ")";
}

// ─── MoveNotesBatchCommand ────────────────────────────────────────────────────

MoveNotesBatchCommand::MoveNotesBatchCommand(int patternId, std::vector<Move> moves,
                                             const Timeline& timeline)
    : patternId_(patternId)
{
    const Pattern* p = timeline.getPattern(patternId);
    if (!p) {
        std::cerr << "[Undo] ERROR MoveNotesBatchCommand: patternId=" << patternId
                  << " not found\n";
        return;
    }
    snapshots_.reserve(moves.size());
    for (const auto& m : moves) {
        bool found = false;
        for (const auto& n : p->notes) {
            if (n.id == m.noteId) {
                snapshots_.push_back({ m.noteId, n.position, m.newPosition,
                                       n.pitch, m.newPitch });
                found = true;
                break;
            }
        }
        if (!found) {
            std::cerr << "[Undo] ERROR MoveNotesBatchCommand: noteId=" << m.noteId
                      << " not found in pattern=" << patternId << "\n";
        }
    }
}

void MoveNotesBatchCommand::execute(Timeline& timeline) {
    for (const auto& s : snapshots_)
        timeline.moveNote(patternId_, s.noteId, s.newPosition, s.newPitch);
}

void MoveNotesBatchCommand::undo(Timeline& timeline) {
    for (const auto& s : snapshots_)
        timeline.moveNote(patternId_, s.noteId, s.oldPosition, s.oldPitch);
}

std::string MoveNotesBatchCommand::describe() const {
    return "Move " + std::to_string(snapshots_.size()) + " Notes"
         + " (pattern=" + std::to_string(patternId_) + ")";
}

// ─── ResizeNotesBatchCommand ──────────────────────────────────────────────────

ResizeNotesBatchCommand::ResizeNotesBatchCommand(int patternId, std::vector<Resize> resizes,
                                                 const Timeline& timeline)
    : patternId_(patternId)
{
    const Pattern* p = timeline.getPattern(patternId);
    if (!p) {
        std::cerr << "[Undo] ERROR ResizeNotesBatchCommand: patternId=" << patternId
                  << " not found\n";
        return;
    }
    snapshots_.reserve(resizes.size());
    for (const auto& r : resizes) {
        bool found = false;
        for (const auto& n : p->notes) {
            if (n.id == r.noteId) {
                snapshots_.push_back({ r.noteId, n.duration, r.newDuration });
                found = true;
                break;
            }
        }
        if (!found) {
            std::cerr << "[Undo] ERROR ResizeNotesBatchCommand: noteId=" << r.noteId
                      << " not found in pattern=" << patternId << "\n";
        }
    }
}

void ResizeNotesBatchCommand::execute(Timeline& timeline) {
    for (const auto& s : snapshots_)
        timeline.resizeNote(patternId_, s.noteId, s.newDuration);
}

void ResizeNotesBatchCommand::undo(Timeline& timeline) {
    for (const auto& s : snapshots_)
        timeline.resizeNote(patternId_, s.noteId, s.oldDuration);
}

std::string ResizeNotesBatchCommand::describe() const {
    return "Resize " + std::to_string(snapshots_.size()) + " Notes"
         + " (pattern=" + std::to_string(patternId_) + ")";
}

// ─── EditPatternNotesCommand ──────────────────────────────────────────────────

EditPatternNotesCommand::EditPatternNotesCommand(int patternId, std::vector<PatternNote> after,
                                                 const Timeline& timeline)
    : patternId_(patternId), after_(std::move(after))
{
    const Pattern* p = timeline.getPattern(patternId);
    if (!p) {
        std::cerr << "[Undo] ERROR EditPatternNotesCommand: patternId=" << patternId
                  << " not found\n";
        return;
    }
    before_ = p->notes;
    valid_ = true;
}

void EditPatternNotesCommand::execute(Timeline& timeline) {
    if (!valid_) return;
    // First run assigns ids to new notes in place; redo reuses them.
    timeline.setPatternNotesKeepIds(patternId_, after_);
}

void EditPatternNotesCommand::undo(Timeline& timeline) {
    if (!valid_) return;
    std::vector<PatternNote> before = before_;
    timeline.setPatternNotesKeepIds(patternId_, before);
}

std::string EditPatternNotesCommand::describe() const {
    return "Edit Notes (pattern=" + std::to_string(patternId_) + ")";
}

// ─── ResizeNoteCommand ────────────────────────────────────────────────────────

ResizeNoteCommand::ResizeNoteCommand(int patternId, int noteId, TickTime newDuration,
                                     const Timeline& timeline)
    : patternId_(patternId), noteId_(noteId), newDuration_(newDuration)
{
    const Pattern* p = timeline.getPattern(patternId);
    if (p) {
        for (const auto& n : p->notes) {
            if (n.id == noteId) { oldDuration_ = n.duration; return; }
        }
    }
    std::cerr << "[Undo] ERROR ResizeNoteCommand: noteId=" << noteId
              << " not found in pattern=" << patternId << "\n";
}

void ResizeNoteCommand::execute(Timeline& timeline) {
    const bool ok = timeline.resizeNote(patternId_, noteId_, newDuration_);
    setApplied(ok && newDuration_.ticks != oldDuration_.ticks);
}

void ResizeNoteCommand::undo(Timeline& timeline) {
    timeline.resizeNote(patternId_, noteId_, oldDuration_);
}

std::string ResizeNoteCommand::describe() const {
    return "Resize Note id=" + std::to_string(noteId_)
         + " (pattern=" + std::to_string(patternId_) + ")";
}

// ─── SetNoteVelocityCommand ───────────────────────────────────────────────────

SetNoteVelocityCommand::SetNoteVelocityCommand(int patternId, int noteId, float newVelocity,
                                               const Timeline& timeline)
    : patternId_(patternId), noteId_(noteId), newVelocity_(newVelocity)
{
    const Pattern* p = timeline.getPattern(patternId);
    oldVelocity_ = 1.0f;
    if (p) {
        for (const auto& n : p->notes) {
            if (n.id == noteId) { oldVelocity_ = n.velocity; return; }
        }
    }
    std::cerr << "[Undo] ERROR SetNoteVelocityCommand: noteId=" << noteId
              << " not found in pattern=" << patternId << "\n";
}

void SetNoteVelocityCommand::execute(Timeline& timeline) {
    const bool ok = timeline.setNoteVelocity(patternId_, noteId_, newVelocity_);
    setApplied(ok && newVelocity_ != oldVelocity_);
}

void SetNoteVelocityCommand::undo(Timeline& timeline) {
    timeline.setNoteVelocity(patternId_, noteId_, oldVelocity_);
}

std::string SetNoteVelocityCommand::describe() const {
    return "Set Note Velocity id=" + std::to_string(noteId_);
}

// ─── ConvertTrackTypeCommand ──────────────────────────────────────────────────

ConvertTrackTypeCommand::ConvertTrackTypeCommand(int trackId, TrackInfo::Type newType,
                                                 const Timeline& timeline)
    : trackId_(trackId), newType_(newType)
{
    const TrackInfo* t = timeline.getTrack(trackId);
    if (t) {
        oldType_            = t->type;
        oldVideoFlipConfig_ = t->videoFlipConfig;
    } else {
        std::cerr << "[Undo] ERROR ConvertTrackTypeCommand: trackId=" << trackId
                  << " not found in timeline\n";
        oldType_            = TrackInfo::Type::Clip;
        oldVideoFlipConfig_ = defaultVideoFlipConfig();
    }
    // When converting to Clip, any pattern-blocks on this track need cascading.
    if (newType == TrackInfo::Type::Clip) {
        for (const PatternBlock* b : timeline.getPatternBlocksOnTrack(trackId))
            cascadedBlocks_.push_back(*b);
    }
}

void ConvertTrackTypeCommand::execute(Timeline& timeline) {
    if (newType_ == TrackInfo::Type::Pattern) {
        timeline.convertToPatternTrack(trackId_);
    } else {
        // Cascade-delete pattern-blocks first, then convert.
        for (const auto& b : cascadedBlocks_) {
            std::cout << "[Undo] ConvertTrackTypeCommand cascading block id=" << b.id << "\n";
            timeline.removePatternBlock(b.id);
        }
        timeline.convertToClipTrack(trackId_);
    }
}

void ConvertTrackTypeCommand::undo(Timeline& timeline) {
    // Restore old track fields.
    if (TrackInfo* t = timeline.getTrackMutable(trackId_)) {
        t->type            = oldType_;
        t->videoFlipConfig = oldVideoFlipConfig_;
    }
    // Restore any cascaded pattern-blocks.
    for (const auto& b : cascadedBlocks_)
        timeline.restorePatternBlock(b);
}

std::string ConvertTrackTypeCommand::describe() const {
    return "Convert Track " + std::to_string(trackId_) + " to "
         + (newType_ == TrackInfo::Type::Pattern ? "Pattern" : "Clip");
}

// ─── SetVideoFlipConfigCommand ────────────────────────────────────────────────

SetVideoFlipConfigCommand::SetVideoFlipConfigCommand(int trackId, VideoFlipConfig newConfig,
                                                     const Timeline& timeline)
    : trackId_(trackId), newConfig_(std::move(newConfig))
{
    const TrackInfo* t = timeline.getTrack(trackId);
    oldConfig_ = t ? t->videoFlipConfig : defaultVideoFlipConfig();
}

void SetVideoFlipConfigCommand::execute(Timeline& timeline) {
    timeline.setTrackVideoFlipConfig(trackId_, newConfig_);
}

void SetVideoFlipConfigCommand::undo(Timeline& timeline) {
    timeline.setTrackVideoFlipConfig(trackId_, oldConfig_);
}

std::string SetVideoFlipConfigCommand::describe() const {
    return "Set VideoFlipConfig (track=" + std::to_string(trackId_)
         + " enabled=" + (newConfig_.enabled ? "true" : "false")
         + " states=" + std::to_string(newConfig_.states.size()) + ")";
}

// ─── SetTrackVideoHoldLastFrameCommand ────────────────────────────────────────

SetTrackVideoHoldLastFrameCommand::SetTrackVideoHoldLastFrameCommand(
    int trackId, bool newHold, const Timeline& timeline)
    : trackId_(trackId), newHold_(newHold)
{
    const TrackInfo* t = timeline.getTrack(trackId);
    oldHold_ = t ? t->videoHoldLastFrame : false;
}

void SetTrackVideoHoldLastFrameCommand::execute(Timeline& timeline) {
    timeline.setTrackVideoHoldLastFrame(trackId_, newHold_);
}

void SetTrackVideoHoldLastFrameCommand::undo(Timeline& timeline) {
    timeline.setTrackVideoHoldLastFrame(trackId_, oldHold_);
}

std::string SetTrackVideoHoldLastFrameCommand::describe() const {
    return std::string(newHold_ ? "Enable" : "Disable")
         + " Hold Last Frame (track=" + std::to_string(trackId_) + ")";
}

// ─── SetTrackVideoHoldLastFrameThresholdCommand ───────────────────────────────

SetTrackVideoHoldLastFrameThresholdCommand::SetTrackVideoHoldLastFrameThresholdCommand(
    int trackId, double newThresholdBeats, const Timeline& timeline)
    : trackId_(trackId), newThresholdBeats_(newThresholdBeats)
{
    const TrackInfo* t = timeline.getTrack(trackId);
    oldThresholdBeats_ = t ? t->videoHoldLastFrameThresholdBeats
                           : TrackInfo::kHoldLastFrameThresholdUnlimited;
}

void SetTrackVideoHoldLastFrameThresholdCommand::execute(Timeline& timeline) {
    timeline.setTrackVideoHoldLastFrameThresholdBeats(trackId_, newThresholdBeats_);
}

void SetTrackVideoHoldLastFrameThresholdCommand::undo(Timeline& timeline) {
    timeline.setTrackVideoHoldLastFrameThresholdBeats(trackId_, oldThresholdBeats_);
}

std::string SetTrackVideoHoldLastFrameThresholdCommand::describe() const {
    std::string value = newThresholdBeats_ < 0.0
                      ? "unlimited"
                      : std::to_string(newThresholdBeats_) + " beats";
    return "Set Hold Last Frame threshold to " + value
         + " (track=" + std::to_string(trackId_) + ")";
}

// ─── SetTrackVideoHoldBehaviorCommand ─────────────────────────────────────────

SetTrackVideoHoldBehaviorCommand::SetTrackVideoHoldBehaviorCommand(
    int trackId, bool smart, bool keepPlaying, const Timeline& timeline)
    : trackId_(trackId), newSmart_(smart), newKeepPlaying_(keepPlaying)
{
    if (const TrackInfo* t = timeline.getTrack(trackId)) {
        oldSmart_       = t->videoHoldSmart;
        oldKeepPlaying_ = t->videoHoldKeepPlaying;
    }
}

void SetTrackVideoHoldBehaviorCommand::execute(Timeline& timeline) {
    timeline.setTrackVideoHoldBehavior(trackId_, newSmart_, newKeepPlaying_);
}

void SetTrackVideoHoldBehaviorCommand::undo(Timeline& timeline) {
    timeline.setTrackVideoHoldBehavior(trackId_, oldSmart_, oldKeepPlaying_);
}

std::string SetTrackVideoHoldBehaviorCommand::describe() const {
    return std::string("Set Hold Last Frame to ")
         + (newSmart_ ? "smart gaps" : "all gaps") + ", "
         + (newKeepPlaying_ ? "keep playing" : "freeze")
         + " (track=" + std::to_string(trackId_) + ")";
}

// ─── SetTrackCornerRadiusCommand ──────────────────────────────────────────────

SetTrackCornerRadiusCommand::SetTrackCornerRadiusCommand(
    int trackId, float newRadius, const Timeline& timeline)
    : trackId_(trackId), newRadius_(newRadius)
{
    const TrackInfo* t = timeline.getTrack(trackId);
    oldRadius_ = t ? t->cornerRadius : 0.0f;
}

void SetTrackCornerRadiusCommand::execute(Timeline& timeline) {
    timeline.setTrackCornerRadius(trackId_, newRadius_);
}

void SetTrackCornerRadiusCommand::undo(Timeline& timeline) {
    timeline.setTrackCornerRadius(trackId_, oldRadius_);
}

std::string SetTrackCornerRadiusCommand::describe() const {
    return "Set Corner Radius (track=" + std::to_string(trackId_)
         + ") → " + std::to_string(newRadius_);
}

// ─── SetTrackGapScaleOverrideCommand ─────────────────────────────────────────

SetTrackGapScaleOverrideCommand::SetTrackGapScaleOverrideCommand(
    int trackId, float newGapScale, const Timeline& timeline)
    : trackId_(trackId), newGapScale_(newGapScale)
{
    const TrackInfo* t = timeline.getTrack(trackId);
    oldGapScale_ = t ? t->gapScaleOverride : -1.0f;
}

void SetTrackGapScaleOverrideCommand::execute(Timeline& timeline) {
    timeline.setTrackGapScaleOverride(trackId_, newGapScale_);
}

void SetTrackGapScaleOverrideCommand::undo(Timeline& timeline) {
    timeline.setTrackGapScaleOverride(trackId_, oldGapScale_);
}

std::string SetTrackGapScaleOverrideCommand::describe() const {
    return "Set Gap Scale Override (track=" + std::to_string(trackId_)
         + ") → " + std::to_string(newGapScale_);
}

// ─── SetTrackSubdivisionFactorCommand ────────────────────────────────────────

SetTrackSubdivisionFactorCommand::SetTrackSubdivisionFactorCommand(
    int trackId, int newFactor, const Timeline& timeline)
    : trackId_(trackId), newFactor_(newFactor)
{
    const TrackInfo* t = timeline.getTrack(trackId);
    oldFactor_ = t ? t->subdivisionFactor : 1;
}

void SetTrackSubdivisionFactorCommand::execute(Timeline& timeline) {
    timeline.setTrackSubdivisionFactor(trackId_, newFactor_);
}

void SetTrackSubdivisionFactorCommand::undo(Timeline& timeline) {
    timeline.setTrackSubdivisionFactor(trackId_, oldFactor_);
}

std::string SetTrackSubdivisionFactorCommand::describe() const {
    return "Set Subdivision Factor (track=" + std::to_string(trackId_)
         + ") → " + std::to_string(newFactor_) + "x";
}

// ─── SetTrackColorCommand (Pass 6D + 6F) ─────────────────────────────────────

SetTrackColorCommand::SetTrackColorCommand(
    int trackId, TrackColorMode newMode, int newSlot,
    std::string newCustomColor, const Timeline& timeline)
    : trackId_(trackId),
      newMode_(newMode),
      newSlot_(newSlot),
      newCustom_(std::move(newCustomColor))
{
    const TrackInfo* t = timeline.getTrack(trackId);
    oldMode_   = t ? t->trackColorMode   : TrackColorMode::Auto;
    oldSlot_   = t ? t->trackColorSlot   : 0;
    oldCustom_ = t ? t->trackColorCustom : std::string();
}

void SetTrackColorCommand::execute(Timeline& timeline) {
    timeline.setTrackColor(trackId_, newMode_, newSlot_, newCustom_);
}

void SetTrackColorCommand::undo(Timeline& timeline) {
    timeline.setTrackColor(trackId_, oldMode_, oldSlot_, oldCustom_);
}

std::string SetTrackColorCommand::describe() const {
    std::string suffix;
    if (newMode_ == TrackColorMode::PaletteSlot) {
        suffix = "[" + std::to_string(newSlot_) + "]";
    } else if (newMode_ == TrackColorMode::Custom) {
        suffix = "[" + newCustom_ + "]";
    }
    return "Set Track Color (track=" + std::to_string(trackId_)
         + ") → " + trackColorModeToString(newMode_) + suffix;
}

// ─── SetTrackBounceSettingsCommand ───────────────────────────────────────────

SetTrackBounceSettingsCommand::SetTrackBounceSettingsCommand(
    int trackId, const BounceSettings& newSettings, const Timeline& timeline)
    : trackId_(trackId), newSettings_(newSettings)
{
    const TrackInfo* t = timeline.getTrack(trackId);
    oldSettings_ = t ? t->bounce : BounceSettings{};
}

void SetTrackBounceSettingsCommand::execute(Timeline& timeline) {
    timeline.setTrackBounceSettings(trackId_, newSettings_);
}

void SetTrackBounceSettingsCommand::undo(Timeline& timeline) {
    timeline.setTrackBounceSettings(trackId_, oldSettings_);
}

std::string SetTrackBounceSettingsCommand::describe() const {
    return "Set Bounce Settings (track=" + std::to_string(trackId_) + ")";
}

// ─── SetTrackZoomPanRotSettingsCommand ────────────────────────────────────────

SetTrackZoomPanRotSettingsCommand::SetTrackZoomPanRotSettingsCommand(
    int trackId, const ZoomPanRotSettings& newSettings, const Timeline& timeline)
    : trackId_(trackId), newSettings_(newSettings)
{
    const TrackInfo* t = timeline.getTrack(trackId);
    oldSettings_ = t ? t->zoomPanRot : ZoomPanRotSettings{};
}

void SetTrackZoomPanRotSettingsCommand::execute(Timeline& timeline) {
    timeline.setTrackZoomPanRotSettings(trackId_, newSettings_);
}

void SetTrackZoomPanRotSettingsCommand::undo(Timeline& timeline) {
    timeline.setTrackZoomPanRotSettings(trackId_, oldSettings_);
}

std::string SetTrackZoomPanRotSettingsCommand::describe() const {
    return "Set ZoomPanRot Settings (track=" + std::to_string(trackId_) + ")";
}

// ─── SetTrackZprTracksCommand ─────────────────────────────────────────────────

SetTrackZprTracksCommand::SetTrackZprTracksCommand(
    int trackId, const ZprTracks& newTracks, const Timeline& timeline)
    : trackId_(trackId), newTracks_(newTracks)
{
    const TrackInfo* t = timeline.getTrack(trackId);
    oldTracks_ = t ? t->zoomPanRot.tracks : ZprTracks{};
}

void SetTrackZprTracksCommand::execute(Timeline& timeline) {
    timeline.setTrackZprTracks(trackId_, newTracks_);
}

void SetTrackZprTracksCommand::undo(Timeline& timeline) {
    timeline.setTrackZprTracks(trackId_, oldTracks_);
}

std::string SetTrackZprTracksCommand::describe() const {
    return "Edit Zoom/Pan/Rot Keyframes (track=" + std::to_string(trackId_) + ")";
}

// ─── SetTrackPingPongSettingsCommand ─────────────────────────────────────────

SetTrackPingPongSettingsCommand::SetTrackPingPongSettingsCommand(
    int trackId, const PingPongSettings& newSettings, const Timeline& timeline)
    : trackId_(trackId), newSettings_(newSettings)
{
    const TrackInfo* t = timeline.getTrack(trackId);
    oldSettings_ = t ? t->pingPong : PingPongSettings{};
}

void SetTrackPingPongSettingsCommand::execute(Timeline& timeline) {
    timeline.setTrackPingPongSettings(trackId_, newSettings_);
}

void SetTrackPingPongSettingsCommand::undo(Timeline& timeline) {
    timeline.setTrackPingPongSettings(trackId_, oldSettings_);
}

std::string SetTrackPingPongSettingsCommand::describe() const {
    return "Set PingPong Settings (track=" + std::to_string(trackId_) + ")";
}

// ─── SetTrackSlideNoteEffectCommand ──────────────────────────────────────────

SetTrackSlideNoteEffectCommand::SetTrackSlideNoteEffectCommand(
    int trackId, const SlideNoteEffectSettings& newSettings, const Timeline& timeline)
    : trackId_(trackId), newSettings_(newSettings)
{
    const TrackInfo* t = timeline.getTrack(trackId);
    oldSettings_ = t ? t->slideNoteEffect : SlideNoteEffectSettings{};
}

void SetTrackSlideNoteEffectCommand::execute(Timeline& timeline) {
    timeline.setTrackSlideNoteEffectSettings(trackId_, newSettings_);
}

void SetTrackSlideNoteEffectCommand::undo(Timeline& timeline) {
    timeline.setTrackSlideNoteEffectSettings(trackId_, oldSettings_);
}

std::string SetTrackSlideNoteEffectCommand::describe() const {
    return "Set Slide Note Effect (track=" + std::to_string(trackId_) + ")";
}

// ─── SetTrackNoteFadeCommand ─────────────────────────────────────────────────

SetTrackNoteFadeCommand::SetTrackNoteFadeCommand(
    int trackId, const NoteFadeSettings& newSettings, const Timeline& timeline)
    : trackId_(trackId), newSettings_(newSettings)
{
    const TrackInfo* t = timeline.getTrack(trackId);
    oldSettings_ = t ? t->noteFade : NoteFadeSettings{};
}

void SetTrackNoteFadeCommand::execute(Timeline& timeline) {
    timeline.setTrackNoteFadeSettings(trackId_, newSettings_);
}

void SetTrackNoteFadeCommand::undo(Timeline& timeline) {
    timeline.setTrackNoteFadeSettings(trackId_, oldSettings_);
}

std::string SetTrackNoteFadeCommand::describe() const {
    return "Set Note Fade (track=" + std::to_string(trackId_) + ")";
}

// ─── SetNoteSlideCommand ─────────────────────────────────────────────────────

SetNoteSlideCommand::SetNoteSlideCommand(int patternId, int noteId, bool isSlide,
                                         float curveCx, float curveCy, const Timeline& timeline)
    : patternId_(patternId), noteId_(noteId),
      newIsSlide_(isSlide), newCx_(curveCx), newCy_(curveCy)
{
    const Pattern* p = timeline.getPattern(patternId);
    if (p) {
        for (const auto& n : p->notes) {
            if (n.id == noteId) {
                oldIsSlide_ = n.isSlide;
                oldCx_      = n.slideCurveCx;
                oldCy_      = n.slideCurveCy;
                break;
            }
        }
    }
}

void SetNoteSlideCommand::execute(Timeline& timeline) {
    timeline.setNoteSlide(patternId_, noteId_, newIsSlide_, newCx_, newCy_);
}

void SetNoteSlideCommand::undo(Timeline& timeline) {
    timeline.setNoteSlide(patternId_, noteId_, oldIsSlide_, oldCx_, oldCy_);
}

std::string SetNoteSlideCommand::describe() const {
    return "Set Note Slide (pattern=" + std::to_string(patternId_)
         + " note=" + std::to_string(noteId_) + ")";
}

// ─── AddVisualEffectCommand ───────────────────────────────────────────────────

AddVisualEffectCommand::AddVisualEffectCommand(int trackId, VisualEffect::Type type)
    : trackId_(trackId), type_(type)
{}

void AddVisualEffectCommand::execute(Timeline& timeline) {
    addedIndex_ = timeline.addVisualEffect(trackId_, type_);
}

void AddVisualEffectCommand::undo(Timeline& timeline) {
    if (addedIndex_ >= 0)
        timeline.removeVisualEffect(trackId_, addedIndex_);
}

std::string AddVisualEffectCommand::describe() const {
    return "Add Visual Effect (track=" + std::to_string(trackId_) + ")";
}

// ─── RemoveVisualEffectCommand ────────────────────────────────────────────────

RemoveVisualEffectCommand::RemoveVisualEffectCommand(
    int trackId, int effectIndex, const Timeline& timeline)
    : trackId_(trackId), effectIndex_(effectIndex)
{
    const auto* chain = timeline.getVisualEffectChain(trackId);
    if (chain && effectIndex >= 0 && effectIndex < static_cast<int>(chain->size()))
        savedEffect_ = (*chain)[effectIndex];
}

void RemoveVisualEffectCommand::execute(Timeline& timeline) {
    timeline.removeVisualEffect(trackId_, effectIndex_);
}

void RemoveVisualEffectCommand::undo(Timeline& timeline) {
    timeline.insertVisualEffectAt(trackId_, effectIndex_, savedEffect_);
}

std::string RemoveVisualEffectCommand::describe() const {
    return "Remove Visual Effect (track=" + std::to_string(trackId_)
           + " index=" + std::to_string(effectIndex_) + ")";
}

// ─── ReorderVisualEffectCommand ───────────────────────────────────────────────

ReorderVisualEffectCommand::ReorderVisualEffectCommand(
    int trackId, int fromIndex, int toIndex)
    : trackId_(trackId), fromIndex_(fromIndex), toIndex_(toIndex)
{}

void ReorderVisualEffectCommand::execute(Timeline& timeline) {
    timeline.reorderVisualEffect(trackId_, fromIndex_, toIndex_);
}

void ReorderVisualEffectCommand::undo(Timeline& timeline) {
    // NOT a second reorderVisualEffect() call: that function's `toIndex` is an
    // original-array-space index (see its erase-then-insert-adjusted body), so
    // a naive from/to swap re-derives the same erase adjustment execute() already
    // applied and cancels out to a no-op for forward moves, and is off-by-one for
    // backward moves. It also can never express "reinsert at the end" (toIndex
    // must be < size), which a backward move off the last slot needs.
    // Instead, mirror RemoveVisualEffectCommand::undo: locate the effect at its
    // post-execute position and move it back with the two index-exact primitives.
    int postExecuteIndex = (toIndex_ > fromIndex_) ? toIndex_ - 1 : toIndex_;
    const auto* chain = timeline.getVisualEffectChain(trackId_);
    if (!chain || postExecuteIndex < 0 || postExecuteIndex >= static_cast<int>(chain->size()))
        return;
    VisualEffect moved = (*chain)[postExecuteIndex];
    timeline.removeVisualEffect(trackId_, postExecuteIndex);
    timeline.insertVisualEffectAt(trackId_, fromIndex_, moved);
}

std::string ReorderVisualEffectCommand::describe() const {
    return "Reorder Visual Effect (track=" + std::to_string(trackId_)
           + " from=" + std::to_string(fromIndex_)
           + " to=" + std::to_string(toIndex_) + ")";
}

// ─── SetTrackVfxChainOrderCommand ─────────────────────────────────────────────

SetTrackVfxChainOrderCommand::SetTrackVfxChainOrderCommand(
    int trackId, const std::vector<int>& newOrder, const Timeline&)
    : trackId_(trackId), newOrder_(newOrder) {}

void SetTrackVfxChainOrderCommand::execute(Timeline& timeline) {
    timeline.setTrackVisualEffectChainOrder(trackId_, newOrder_);
}

void SetTrackVfxChainOrderCommand::undo(Timeline& timeline) {
    int n = static_cast<int>(newOrder_.size());
    std::vector<int> inv(n);
    for (int i = 0; i < n; ++i) inv[newOrder_[i]] = i;
    timeline.setTrackVisualEffectChainOrder(trackId_, inv);
}

std::string SetTrackVfxChainOrderCommand::describe() const {
    return "Set Visual Effect Chain Order (track=" + std::to_string(trackId_) + ")";
}

// ─── SetVisualEffectParamCommand ──────────────────────────────────────────────

SetVisualEffectParamCommand::SetVisualEffectParamCommand(
    int trackId, int effectIndex, int paramIndex, float newValue, const Timeline& timeline)
    : trackId_(trackId), effectIndex_(effectIndex),
      paramIndex_(paramIndex), newValue_(newValue), oldValue_(0.0f)
{
    const auto* chain = timeline.getVisualEffectChain(trackId);
    if (chain && effectIndex >= 0 && effectIndex < static_cast<int>(chain->size())
        && paramIndex >= 0 && paramIndex < 16)
        oldValue_ = (*chain)[effectIndex].params[paramIndex];
}

void SetVisualEffectParamCommand::execute(Timeline& timeline) {
    const bool applied = timeline.setVisualEffectParam(trackId_, effectIndex_, paramIndex_, newValue_);
    applied_ = applied;
    if (!applied) {
        // A stale chain/index must not become a no-op undo-history entry.
        std::cerr << "[Undo] ERROR SetVisualEffectParamCommand::execute: setVisualEffectParam failed"
                  << " (trackId=" << trackId_
                  << " effectIndex=" << effectIndex_
                  << " paramIndex=" << paramIndex_
                  << " value=" << newValue_ << ")\n";
    }
}

void SetVisualEffectParamCommand::undo(Timeline& timeline) {
    const bool restored = timeline.setVisualEffectParam(trackId_, effectIndex_, paramIndex_, oldValue_);
    if (!restored) {
        std::cerr << "[Undo] ERROR SetVisualEffectParamCommand::undo: setVisualEffectParam failed"
                  << " (trackId=" << trackId_
                  << " effectIndex=" << effectIndex_
                  << " paramIndex=" << paramIndex_
                  << " value=" << oldValue_ << ")\n";
    }
}

std::string SetVisualEffectParamCommand::describe() const {
    return "Set Visual Effect Param (track=" + std::to_string(trackId_)
           + " effect=" + std::to_string(effectIndex_)
           + " param=" + std::to_string(paramIndex_) + ")";
}

bool SetVisualEffectParamCommand::shouldRecordInUndoHistory() const {
    return applied_;
}

// ─── SetVisualEffectBypassedCommand ──────────────────────────────────────────

SetVisualEffectBypassedCommand::SetVisualEffectBypassedCommand(
    int trackId, int effectIndex, bool newBypassed, const Timeline& timeline)
    : trackId_(trackId), effectIndex_(effectIndex),
      newBypassed_(newBypassed), oldBypassed_(false)
{
    const auto* chain = timeline.getVisualEffectChain(trackId);
    if (chain && effectIndex >= 0 && effectIndex < static_cast<int>(chain->size()))
        oldBypassed_ = (*chain)[effectIndex].bypassed;
}

void SetVisualEffectBypassedCommand::execute(Timeline& timeline) {
    timeline.setVisualEffectBypassed(trackId_, effectIndex_, newBypassed_);
}

void SetVisualEffectBypassedCommand::undo(Timeline& timeline) {
    timeline.setVisualEffectBypassed(trackId_, effectIndex_, oldBypassed_);
}

std::string SetVisualEffectBypassedCommand::describe() const {
    return "Set Visual Effect Bypassed (track=" + std::to_string(trackId_)
           + " effect=" + std::to_string(effectIndex_) + ")";
}

// ═══════════════════════════════════════════════════════════════════════════
// Automation clip commands (Phase A)
// ═══════════════════════════════════════════════════════════════════════════

// ─── AddAutomationClipCommand ─────────────────────────────────────────────────

AddAutomationClipCommand::AddAutomationClipCommand(AutomationClip clip)
    : clip_(std::move(clip)) {}

void AddAutomationClipCommand::execute(Timeline& timeline) {
    if (firstExecute_) {
        const int id = timeline.addAutomationClip(clip_);
        // Rejected: unknown lane/envelope, non-positive duration, or same-lane
        // overlap. Leave accepted_ false so UndoManager never records the step,
        // and stamp -1 so clipId() reports the rejection rather than echoing
        // whatever id the caller's payload happened to carry.
        if (id < 0) { clip_.id = -1; accepted_ = false; return; }
        clip_.id = id;
        accepted_ = true;
        firstExecute_ = false;
    } else {
        // Redo: restore the original id so later commands referring to it stay valid.
        timeline.restoreAutomationClip(clip_);
    }
}

void AddAutomationClipCommand::undo(Timeline& timeline) {
    if (accepted_) timeline.removeAutomationClip(clip_.id);
}

std::string AddAutomationClipCommand::describe() const {
    return "Add automation clip";
}

// ─── RemoveAutomationClipCommand ──────────────────────────────────────────────

RemoveAutomationClipCommand::RemoveAutomationClipCommand(int clipId, const Timeline& timeline) {
    if (const AutomationClip* c = timeline.getAutomationClip(clipId)) {
        clip_  = *c;
        found_ = true;
    }
}

void RemoveAutomationClipCommand::execute(Timeline& timeline) {
    if (found_) timeline.removeAutomationClip(clip_.id);
}

void RemoveAutomationClipCommand::undo(Timeline& timeline) {
    if (found_) timeline.restoreAutomationClip(clip_);
}

std::string RemoveAutomationClipCommand::describe() const {
    return "Remove automation clip";
}

// ─── MoveAutomationClipCommand ────────────────────────────────────────────────

MoveAutomationClipCommand::MoveAutomationClipCommand(int clipId, int newLaneId,
                                                     TickTime newPosition,
                                                     const Timeline& timeline)
    : clipId_(clipId), newLaneId_(newLaneId), newPosition_(newPosition) {
    if (const AutomationClip* c = timeline.getAutomationClip(clipId)) {
        oldLaneId_   = c->laneId;
        oldPosition_ = c->position;
    }
}

void MoveAutomationClipCommand::execute(Timeline& timeline) {
    accepted_ = timeline.moveAutomationClip(clipId_, newLaneId_, newPosition_);
}

void MoveAutomationClipCommand::undo(Timeline& timeline) {
    if (accepted_) timeline.moveAutomationClip(clipId_, oldLaneId_, oldPosition_);
}

std::string MoveAutomationClipCommand::describe() const {
    return "Move automation clip";
}

// ─── ResizeAutomationClipCommand ──────────────────────────────────────────────

ResizeAutomationClipCommand::ResizeAutomationClipCommand(int clipId, TickTime newDuration,
                                                         const Timeline& timeline)
    : clipId_(clipId), newDuration_(newDuration) {
    if (const AutomationClip* c = timeline.getAutomationClip(clipId))
        oldDuration_ = c->duration;
}

void ResizeAutomationClipCommand::execute(Timeline& timeline) {
    accepted_ = timeline.resizeAutomationClip(clipId_, newDuration_);
}

void ResizeAutomationClipCommand::undo(Timeline& timeline) {
    if (accepted_) timeline.resizeAutomationClip(clipId_, oldDuration_);
}

std::string ResizeAutomationClipCommand::describe() const {
    return "Resize automation clip";
}

// ─── ResizeAutomationClipLeftCommand ──────────────────────────────────────────

ResizeAutomationClipLeftCommand::ResizeAutomationClipLeftCommand(
    int clipId, TickTime newPosition, TickTime newDuration, TickTime newOffset,
    const Timeline& timeline)
    : clipId_(clipId), newPosition_(newPosition), newDuration_(newDuration),
      newOffset_(newOffset) {
    if (const AutomationClip* c = timeline.getAutomationClip(clipId)) {
        oldPosition_ = c->position;
        oldDuration_ = c->duration;
        oldOffset_   = c->offset;
    }
}

void ResizeAutomationClipLeftCommand::execute(Timeline& timeline) {
    accepted_ = timeline.resizeAutomationClipLeft(clipId_, newPosition_, newDuration_, newOffset_);
}

void ResizeAutomationClipLeftCommand::undo(Timeline& timeline) {
    if (accepted_)
        timeline.resizeAutomationClipLeft(clipId_, oldPosition_, oldDuration_, oldOffset_);
}

std::string ResizeAutomationClipLeftCommand::describe() const {
    return "Trim automation clip";
}

// ─── MakeAutomationClipUniqueCommand ──────────────────────────────────────────

MakeAutomationClipUniqueCommand::MakeAutomationClipUniqueCommand(int clipId,
                                                                 const Timeline& timeline)
    : clipId_(clipId) {
    if (const AutomationClip* c = timeline.getAutomationClip(clipId))
        oldEnvelopeId_ = c->envelopeId;
}

void MakeAutomationClipUniqueCommand::execute(Timeline& timeline) {
    if (firstExecute_) {
        newEnvelopeId_ = timeline.makeAutomationClipUnique(clipId_);
        if (newEnvelopeId_ < 0) { accepted_ = false; return; }
        if (const AutomationEnvelope* e = timeline.getAutomationEnvelope(newEnvelopeId_))
            duplicate_ = *e;
        accepted_     = true;
        firstExecute_ = false;
        return;
    }
    // Redo: put the SAME duplicate back rather than minting a new envelope,
    // which would leak one envelope per undo/redo cycle.
    timeline.restoreAutomationEnvelope(duplicate_);
    if (const AutomationClip* c = timeline.getAutomationClip(clipId_)) {
        AutomationClip copy = *c;
        copy.envelopeId = newEnvelopeId_;
        timeline.removeAutomationClip(clipId_);
        timeline.restoreAutomationClip(copy);
    }
}

void MakeAutomationClipUniqueCommand::undo(Timeline& timeline) {
    if (!accepted_) return;
    if (const AutomationClip* c = timeline.getAutomationClip(clipId_)) {
        AutomationClip copy = *c;
        copy.envelopeId = oldEnvelopeId_;
        timeline.removeAutomationClip(clipId_);
        timeline.restoreAutomationClip(copy);
    }
    timeline.removeAutomationEnvelope(newEnvelopeId_);
}

std::string MakeAutomationClipUniqueCommand::describe() const {
    return "Make automation clip unique";
}

// ─── AddAutomationLaneCommand ─────────────────────────────────────────────────

AddAutomationLaneCommand::AddAutomationLaneCommand(int ownerTrackId, int index) {
    lane_.ownerTrackId = ownerTrackId;
    lane_.index        = index;   // < 0 = append, resolved by Timeline
}

void AddAutomationLaneCommand::execute(Timeline& timeline) {
    if (firstExecute_) {
        const int id = timeline.addAutomationLane(lane_);
        if (id < 0) { lane_.id = -1; accepted_ = false; return; }
        if (const AutomationLane* l = timeline.getAutomationLane(id)) lane_ = *l;
        accepted_     = true;
        firstExecute_ = false;
    } else {
        timeline.restoreAutomationLane(lane_);
    }
}

void AddAutomationLaneCommand::undo(Timeline& timeline) {
    if (accepted_) timeline.removeAutomationLane(lane_.id);
}

std::string AddAutomationLaneCommand::describe() const {
    return "Add automation lane";
}

// ─── RemoveAutomationLaneCommand ──────────────────────────────────────────────

RemoveAutomationLaneCommand::RemoveAutomationLaneCommand(int laneId, const Timeline& timeline) {
    if (const AutomationLane* l = timeline.getAutomationLane(laneId)) {
        lane_  = *l;
        found_ = true;
        for (const AutomationClip* c : timeline.getAutomationClipsOnLane(laneId))
            clips_.push_back(*c);
    }
}

void RemoveAutomationLaneCommand::execute(Timeline& timeline) {
    if (found_) timeline.removeAutomationLane(lane_.id);   // cascades to clips_
}

void RemoveAutomationLaneCommand::undo(Timeline& timeline) {
    if (!found_) return;
    timeline.restoreAutomationLane(lane_);                 // lane first: clips need it
    for (const auto& c : clips_) timeline.restoreAutomationClip(c);
}

std::string RemoveAutomationLaneCommand::describe() const {
    return "Remove automation lane";
}

// ─── AddAutomationEnvelopeCommand ─────────────────────────────────────────────

AddAutomationEnvelopeCommand::AddAutomationEnvelopeCommand(AutomationBinding binding,
                                                           std::vector<AutomationPoint> points) {
    envelope_.binding = std::move(binding);
    envelope_.points  = std::move(points);
}

void AddAutomationEnvelopeCommand::execute(Timeline& timeline) {
    if (firstExecute_) {
        const int id = timeline.addAutomationEnvelope(envelope_);
        if (id < 0) { envelope_.id = -1; accepted_ = false; return; }
        if (const AutomationEnvelope* e = timeline.getAutomationEnvelope(id)) envelope_ = *e;
        accepted_     = true;
        firstExecute_ = false;
    } else {
        timeline.restoreAutomationEnvelope(envelope_);
    }
}

void AddAutomationEnvelopeCommand::undo(Timeline& timeline) {
    if (accepted_) timeline.removeAutomationEnvelope(envelope_.id);
}

std::string AddAutomationEnvelopeCommand::describe() const {
    return "Add automation envelope";
}

// ─── AutomationPointEditCommand ───────────────────────────────────────────────

AutomationPointEditCommand::AutomationPointEditCommand(Kind kind, int envelopeId,
                                                       const Timeline& timeline)
    : kind_(kind), envelopeId_(envelopeId) {
    if (const AutomationEnvelope* e = timeline.getAutomationEnvelope(envelopeId))
        before_ = e->points;
}

std::unique_ptr<AutomationPointEditCommand> AutomationPointEditCommand::add(
    int envelopeId, AutomationPoint point, const Timeline& timeline) {
    std::unique_ptr<AutomationPointEditCommand> cmd(
        new AutomationPointEditCommand(Kind::Add, envelopeId, timeline));
    cmd->point_ = point;
    return cmd;
}

std::unique_ptr<AutomationPointEditCommand> AutomationPointEditCommand::remove(
    int envelopeId, int pointIndex, const Timeline& timeline) {
    std::unique_ptr<AutomationPointEditCommand> cmd(
        new AutomationPointEditCommand(Kind::Remove, envelopeId, timeline));
    cmd->pointIndex_ = pointIndex;
    return cmd;
}

std::unique_ptr<AutomationPointEditCommand> AutomationPointEditCommand::move(
    int envelopeId, int pointIndex, TickTime newTick, double newValue,
    const Timeline& timeline) {
    std::unique_ptr<AutomationPointEditCommand> cmd(
        new AutomationPointEditCommand(Kind::Move, envelopeId, timeline));
    cmd->pointIndex_ = pointIndex;
    cmd->newTick_    = newTick;
    cmd->newValue_   = newValue;
    return cmd;
}

std::unique_ptr<AutomationPointEditCommand> AutomationPointEditCommand::setCurve(
    int envelopeId, int pointIndex, AutomationCurveType curveType, double tension,
    const Timeline& timeline) {
    std::unique_ptr<AutomationPointEditCommand> cmd(
        new AutomationPointEditCommand(Kind::SetCurve, envelopeId, timeline));
    cmd->pointIndex_ = pointIndex;
    cmd->curveType_  = curveType;
    cmd->tension_    = tension;
    return cmd;
}

std::unique_ptr<AutomationPointEditCommand> AutomationPointEditCommand::replaceAll(
    int envelopeId, std::vector<AutomationPoint> points, const Timeline& timeline) {
    std::unique_ptr<AutomationPointEditCommand> cmd(
        new AutomationPointEditCommand(Kind::ReplaceAll, envelopeId, timeline));
    cmd->replacement_ = std::move(points);
    return cmd;
}

void AutomationPointEditCommand::execute(Timeline& timeline) {
    if (haveAfter_) {
        // Redo: replay the recorded result rather than re-deriving it, so an
        // index-based edit cannot land differently the second time around.
        accepted_ = timeline.setAutomationEnvelopePoints(envelopeId_, after_);
        return;
    }

    bool ok = false;
    switch (kind_) {
        case Kind::Add:
            ok = timeline.addAutomationPoint(envelopeId_, point_);
            break;
        case Kind::Remove:
            ok = timeline.removeAutomationPoint(envelopeId_, pointIndex_);
            break;
        case Kind::Move:
            ok = timeline.moveAutomationPoint(envelopeId_, pointIndex_, newTick_, newValue_);
            break;
        case Kind::SetCurve:
            ok = timeline.setAutomationPointCurve(envelopeId_, pointIndex_, curveType_, tension_);
            break;
        case Kind::ReplaceAll:
            ok = timeline.setAutomationEnvelopePoints(envelopeId_, replacement_);
            break;
    }
    accepted_ = ok;
    if (!ok) return;

    if (const AutomationEnvelope* e = timeline.getAutomationEnvelope(envelopeId_)) {
        after_     = e->points;
        haveAfter_ = true;
    }
}

void AutomationPointEditCommand::undo(Timeline& timeline) {
    if (accepted_) timeline.setAutomationEnvelopePoints(envelopeId_, before_);
}

std::string AutomationPointEditCommand::describe() const {
    switch (kind_) {
        case Kind::Add:      return "Add automation point";
        case Kind::Remove:   return "Delete automation point";
        case Kind::Move:     return "Move automation point";
        case Kind::SetCurve: return "Set automation curve";
        default:             return "Edit automation envelope";
    }
}

// ─── RemoveAutomationForEffectInstanceCommand ─────────────────────────────────

RemoveAutomationForEffectInstanceCommand::RemoveAutomationForEffectInstanceCommand(
    int ownerTrackId, const std::string& effectInstanceId, const Timeline& timeline)
    : ownerTrackId_(ownerTrackId), effectInstanceId_(effectInstanceId) {

    std::set<int> touchedLanes;
    for (const AutomationClip* c :
         timeline.getAutomationClipsForEffectInstance(ownerTrackId, effectInstanceId)) {
        clips_.push_back(*c);
        touchedLanes.insert(c->laneId);
    }

    // A lane is taken with the clips only when NOTHING else lives on it — a lane
    // that also carries a clip bound to a different parameter has to survive.
    for (int laneId : touchedLanes) {
        const auto onLane = timeline.getAutomationClipsOnLane(laneId);
        std::size_t doomed = 0;
        for (const AutomationClip* c : onLane)
            for (const auto& d : clips_)
                if (d.id == c->id) { ++doomed; break; }
        if (doomed == onLane.size())
            if (const AutomationLane* l = timeline.getAutomationLane(laneId))
                emptiedLanes_.push_back(*l);
    }
}

void RemoveAutomationForEffectInstanceCommand::execute(Timeline& timeline) {
    for (const auto& c : clips_)        timeline.removeAutomationClip(c.id);
    for (const auto& l : emptiedLanes_) timeline.removeAutomationLane(l.id);
}

void RemoveAutomationForEffectInstanceCommand::undo(Timeline& timeline) {
    for (const auto& l : emptiedLanes_) timeline.restoreAutomationLane(l);
    for (const auto& c : clips_)        timeline.restoreAutomationClip(c);
}

std::string RemoveAutomationForEffectInstanceCommand::describe() const {
    return "Delete automation for effect";
}

// ─── SetAutomationBaseValueCommand ────────────────────────────────────────────

SetAutomationBaseValueCommand::SetAutomationBaseValueCommand(AutomationBinding binding,
                                                             double value,
                                                             const Timeline& timeline)
    : binding_(std::move(binding)), newValue_(value) {
    oldValue_ = timeline.getAutomationBaseValue(binding_, &hadOld_);
}

void SetAutomationBaseValueCommand::execute(Timeline& timeline) {
    if (!binding_.valid()) { accepted_ = false; return; }
    timeline.setAutomationBaseValue(binding_, newValue_);
    accepted_ = true;
}

void SetAutomationBaseValueCommand::undo(Timeline& timeline) {
    if (!accepted_) return;
    if (hadOld_) timeline.setAutomationBaseValue(binding_, oldValue_);
    else         timeline.clearAutomationBaseValue(binding_);
}

std::string SetAutomationBaseValueCommand::describe() const {
    return "Set automation base value";
}

// ─── SetClipLensCommand ──────────────────────────────────────────────────────

SetClipLensCommand::SetClipLensCommand(int clipId, const LensParams& newLens,
                                       const Timeline& timeline, bool isReset)
    : clipId_(clipId), newLens_(newLens), isReset_(isReset)
{
    const Clip* c = timeline.getClip(clipId);
    oldLens_ = c ? c->lens.base : LensParams{};
}

void SetClipLensCommand::execute(Timeline& timeline) {
    if (Clip* c = timeline.getClipMutable(clipId_)) c->lens.base = newLens_;
}

void SetClipLensCommand::undo(Timeline& timeline) {
    if (Clip* c = timeline.getClipMutable(clipId_)) c->lens.base = oldLens_;
}

std::string SetClipLensCommand::describe() const {
    return std::string(isReset_ ? "Reset" : "Set") + " Clip Lens (clip="
         + std::to_string(clipId_) + ")";
}

// ─── SetClipLensKeysCommand ──────────────────────────────────────────────────

SetClipLensKeysCommand::SetClipLensKeysCommand(int clipId, std::vector<LensKey> keys,
                                               const Timeline& timeline)
    : clipId_(clipId), newKeys_(std::move(keys))
{
    if (const Clip* c = timeline.getClip(clipId)) oldKeys_ = c->lens.keys;
}

void SetClipLensKeysCommand::execute(Timeline& timeline) {
    if (Clip* c = timeline.getClipMutable(clipId_)) c->lens.keys = newKeys_;
}

void SetClipLensKeysCommand::undo(Timeline& timeline) {
    if (Clip* c = timeline.getClipMutable(clipId_)) c->lens.keys = oldKeys_;
}

std::string SetClipLensKeysCommand::describe() const {
    return "Set Clip Lens keys (clip=" + std::to_string(clipId_) + ", "
         + std::to_string(newKeys_.size()) + " keys)";
}

// ─── SetTrackLensCommand ─────────────────────────────────────────────────────

SetTrackLensCommand::SetTrackLensCommand(int trackId, int regionId, const LensParams& newLens,
                                         const Timeline& timeline, bool isReset)
    : trackId_(trackId), regionId_(regionId), newLens_(newLens), isReset_(isReset)
{
    if (const TrackInfo* t = timeline.getTrack(trackId)) {
        const auto it = t->trackLens.find(regionId);
        if (it != t->trackLens.end()) {
            hadEntry_ = true;
            oldEntry_ = it->second;
        }
    }
}

void SetTrackLensCommand::execute(Timeline& timeline) {
    if (TrackInfo* t = timeline.getTrackMutable(trackId_)) {
        // A new entry starts from the old one (keys/hitCurve kept), or empty.
        LensTrack& entry = t->trackLens[regionId_];
        if (!hadEntry_) entry = LensTrack{};
        entry.base = newLens_;
    }
}

void SetTrackLensCommand::undo(Timeline& timeline) {
    if (TrackInfo* t = timeline.getTrackMutable(trackId_)) {
        if (hadEntry_) t->trackLens[regionId_] = oldEntry_;
        else           t->trackLens.erase(regionId_);
    }
}

std::string SetTrackLensCommand::describe() const {
    return std::string(isReset_ ? "Reset" : "Set") + " Track Lens (track="
         + std::to_string(trackId_) + ", region=" + std::to_string(regionId_) + ")";
}

// ─── SetTrackRoamCommand ─────────────────────────────────────────────────────

SetTrackRoamCommand::SetTrackRoamCommand(int trackId, const RoamParams& newRoam,
                                         const Timeline& timeline, bool isReset)
    : trackId_(trackId), newRoam_(newRoam), isReset_(isReset)
{
    const TrackInfo* t = timeline.getTrack(trackId);
    oldRoam_ = t ? t->roam.base : RoamParams{};
}

void SetTrackRoamCommand::execute(Timeline& timeline) {
    if (TrackInfo* t = timeline.getTrackMutable(trackId_)) t->roam.base = newRoam_;
}

void SetTrackRoamCommand::undo(Timeline& timeline) {
    if (TrackInfo* t = timeline.getTrackMutable(trackId_)) t->roam.base = oldRoam_;
}

std::string SetTrackRoamCommand::describe() const {
    return std::string(isReset_ ? "Reset" : "Set") + " Track Roam (track="
         + std::to_string(trackId_) + ")";
}

// ─── SetTrackRoamKeysCommand ─────────────────────────────────────────────────

SetTrackRoamKeysCommand::SetTrackRoamKeysCommand(int trackId, std::vector<RoamKey> keys,
                                                 const Timeline& timeline)
    : trackId_(trackId), newKeys_(std::move(keys))
{
    if (const TrackInfo* t = timeline.getTrack(trackId)) oldKeys_ = t->roam.keys;
}

void SetTrackRoamKeysCommand::execute(Timeline& timeline) {
    if (TrackInfo* t = timeline.getTrackMutable(trackId_)) t->roam.keys = newKeys_;
}

void SetTrackRoamKeysCommand::undo(Timeline& timeline) {
    if (TrackInfo* t = timeline.getTrackMutable(trackId_)) t->roam.keys = oldKeys_;
}

std::string SetTrackRoamKeysCommand::describe() const {
    return "Set Track Roam keys (track=" + std::to_string(trackId_) + ", "
         + std::to_string(newKeys_.size()) + " keys)";
}

// ─── SetTrackSweepKeysCommand (P11) ──────────────────────────────────────────

SetTrackSweepKeysCommand::SetTrackSweepKeysCommand(int trackId, std::vector<LensKey> keys,
                                                   const Timeline& timeline)
    : trackId_(trackId), newKeys_(std::move(keys))
{
    if (const TrackInfo* t = timeline.getTrack(trackId)) oldKeys_ = t->sweep.keys;
}

void SetTrackSweepKeysCommand::execute(Timeline& timeline) {
    if (TrackInfo* t = timeline.getTrackMutable(trackId_)) t->sweep.keys = newKeys_;
}

void SetTrackSweepKeysCommand::undo(Timeline& timeline) {
    if (TrackInfo* t = timeline.getTrackMutable(trackId_)) t->sweep.keys = oldKeys_;
}

std::string SetTrackSweepKeysCommand::describe() const {
    return "Set Track Sweep keys (track=" + std::to_string(trackId_) + ", "
         + std::to_string(newKeys_.size()) + " keys)";
}

// ─── SetTrackFxKeysCommand (Motion view: video effect param keys) ────────────

SetTrackFxKeysCommand::SetTrackFxKeysCommand(int trackId, std::vector<FxKey> keys, const Timeline& timeline)
    : trackId_(trackId), newKeys_(std::move(keys))
{
    if (const TrackInfo* t = timeline.getTrack(trackId)) oldKeys_ = t->fxKeys;
}

void SetTrackFxKeysCommand::execute(Timeline& timeline) {
    if (TrackInfo* t = timeline.getTrackMutable(trackId_)) t->fxKeys = newKeys_;
}

void SetTrackFxKeysCommand::undo(Timeline& timeline) {
    if (TrackInfo* t = timeline.getTrackMutable(trackId_)) t->fxKeys = oldKeys_;
}

std::string SetTrackFxKeysCommand::describe() const {
    return "Set Track effect keys (track=" + std::to_string(trackId_) + ", "
         + std::to_string(newKeys_.size()) + " keys)";
}

// ─── Motion view: SetTrackParentCommand ──────────────────────────────────────

SetTrackParentCommand::SetTrackParentCommand(int trackId, int newParentTrackId,
                                             const Timeline& timeline,
                                             std::optional<RoamParams> newBase)
    : trackId_(trackId), newParent_(newParentTrackId < 0 ? -1 : newParentTrackId),
      newBase_(std::move(newBase))
{
    if (const TrackInfo* t = timeline.getTrack(trackId)) {
        oldParent_ = t->parentTrackId;
        oldBase_   = t->roam.base;
    }
}

void SetTrackParentCommand::execute(Timeline& timeline) {
    TrackInfo* t = timeline.getTrackMutable(trackId_);
    if (!t || parentmath::validateParent(timeline, trackId_, newParent_) != parentmath::ParentReject::None) {
        setApplied(false);
        return;
    }
    t->parentTrackId = newParent_;
    if (newBase_) t->roam.base = *newBase_;
}

void SetTrackParentCommand::undo(Timeline& timeline) {
    if (TrackInfo* t = timeline.getTrackMutable(trackId_)) {
        t->parentTrackId = oldParent_;
        if (newBase_) t->roam.base = oldBase_;
    }
}

std::string SetTrackParentCommand::describe() const {
    std::string s = newParent_ < 0
        ? "Detach Track " + std::to_string(trackId_) + " from its parent"
        : "Set Parent of Track " + std::to_string(trackId_) + " to Track " + std::to_string(newParent_);
    if (newBase_) s += " (keep on screen)";
    return s;
}

// ─── Motion view: SetTrackMasksCommand ───────────────────────────────────────

SetTrackMasksCommand::SetTrackMasksCommand(int trackId, std::vector<RoamMask> masks,
                                           const Timeline& timeline)
    : trackId_(trackId), newMasks_(std::move(masks))
{
    if (const TrackInfo* t = timeline.getTrack(trackId)) oldMasks_ = t->roam.masks;
}

void SetTrackMasksCommand::execute(Timeline& timeline) {
    if (TrackInfo* t = timeline.getTrackMutable(trackId_)) t->roam.masks = newMasks_;
    else setApplied(false);
}

void SetTrackMasksCommand::undo(Timeline& timeline) {
    if (TrackInfo* t = timeline.getTrackMutable(trackId_)) t->roam.masks = oldMasks_;
}

std::string SetTrackMasksCommand::describe() const {
    return "Set Track Masks (track=" + std::to_string(trackId_) + ", "
         + std::to_string(newMasks_.size()) + " mask(s))";
}

// ─── Lens + Roam P8: per-note overrides ──────────────────────────────────────

namespace {

PatternNote* findLensNote(Timeline& timeline, const NoteLensRef& ref) {
    Pattern* p = timeline.getPatternMutable(ref.patternId);
    if (!p) return nullptr;
    for (PatternNote& n : p->notes)
        if (n.id == ref.noteId) return &n;
    return nullptr;
}

const PatternNote* findLensNote(const Timeline& timeline, const NoteLensRef& ref) {
    const Pattern* p = timeline.getPattern(ref.patternId);
    if (!p) return nullptr;
    for (const PatternNote& n : p->notes)
        if (n.id == ref.noteId) return &n;
    return nullptr;
}

const char* noteLensModeName(NoteLensMode m) {
    switch (m) {
        case NoteLensMode::Nudge: return "Nudge";
        case NoteLensMode::Own:   return "Own";
        default:                  return "Follow";
    }
}

std::string noteCountLabel(std::size_t n) {
    return std::to_string(n) + (n == 1 ? " note" : " notes");
}

} // namespace

LensNoteOverridePtr noteLensOverrideOf(const Timeline& timeline, const NoteLensRef& ref) {
    const PatternNote* n = findLensNote(timeline, ref);
    return n ? n->lensOverride : nullptr;
}

NoteLensOverrideCommand::Swap* NoteLensOverrideCommand::addNote(const Timeline& timeline,
                                                                const NoteLensRef& ref) {
    const PatternNote* n = findLensNote(timeline, ref);
    if (!n) return nullptr;
    for (const Swap& s : swaps_)
        if (s.ref == ref) return nullptr;
    swaps_.push_back(Swap{ ref, n->lensOverride, n->lensOverride });
    return &swaps_.back();
}

void NoteLensOverrideCommand::execute(Timeline& timeline) {
    for (const Swap& s : swaps_)
        if (PatternNote* n = findLensNote(timeline, s.ref)) n->lensOverride = s.after;
}

void NoteLensOverrideCommand::undo(Timeline& timeline) {
    for (auto it = swaps_.rbegin(); it != swaps_.rend(); ++it)
        if (PatternNote* n = findLensNote(timeline, it->ref)) n->lensOverride = it->before;
}

bool NoteLensOverrideCommand::changesAnything() const {
    for (const Swap& s : swaps_)
        if (!sameLensOverride(s.before, s.after)) return true;
    return false;
}

std::vector<NoteLensRef> NoteLensOverrideCommand::notes() const {
    std::vector<NoteLensRef> out;
    out.reserve(swaps_.size());
    for (const Swap& s : swaps_) out.push_back(s.ref);
    return out;
}

SetNoteLensModeCommand::SetNoteLensModeCommand(const std::vector<NoteLensRef>& notes,
                                               NoteLensMode mode, const Timeline& timeline) {
    for (const NoteLensRef& ref : notes) {
        Swap* s = addNote(timeline, ref);
        if (!s) continue;
        if (mode == NoteLensMode::Follow) { s->after = nullptr; continue; }
        const LensOverrideMode m = mode == NoteLensMode::Own ? LensOverrideMode::Own
                                                             : LensOverrideMode::Nudge;
        if (s->before && s->before->mode == m) continue;          // already in that mode
        auto o = std::make_shared<LensNoteOverride>();
        o->mode = m;
        if (s->before) o->keys = s->before->keys;                 // the keys carry over
        s->after = std::move(o);
    }
    label_ = std::string("Set note Lens mode ") + noteLensModeName(mode) + " ("
           + noteCountLabel(swaps_.size()) + ")";
}

SetNoteLensKeysCommand::SetNoteLensKeysCommand(const NoteLensRef& note, std::vector<LensKey> keys,
                                               const Timeline& timeline) {
    if (Swap* s = addNote(timeline, note)) {
        auto o = std::make_shared<LensNoteOverride>();
        o->mode = s->before ? s->before->mode : LensOverrideMode::Nudge;
        o->keys = std::move(keys);
        s->after = std::move(o);
    }
    label_ = "Set note Lens keys (pattern=" + std::to_string(note.patternId)
           + ", note=" + std::to_string(note.noteId) + ")";
}

SetNoteLensKeysCommand::SetNoteLensKeysCommand(
    const std::vector<std::pair<NoteLensRef, std::vector<LensKey>>>& entries, const Timeline& timeline) {
    for (const auto& e : entries) {
        Swap* s = addNote(timeline, e.first);
        if (!s) continue;
        auto o = std::make_shared<LensNoteOverride>();
        o->mode = s->before ? s->before->mode : LensOverrideMode::Nudge;
        o->keys = e.second;
        s->after = std::move(o);
    }
    label_ = "Set note Lens keys (" + noteCountLabel(swaps_.size()) + ")";
}

RevertNotesToFollowCommand::RevertNotesToFollowCommand(const std::vector<NoteLensRef>& notes,
                                                       const Timeline& timeline) {
    for (const NoteLensRef& ref : notes)
        if (Swap* s = addNote(timeline, ref)) s->after = nullptr;
    label_ = "Revert " + noteCountLabel(swaps_.size()) + " to Follow";
}

// ─── SetHitCurveCommand ──────────────────────────────────────────────────────

SetHitCurveCommand::SetHitCurveCommand(int trackId, int regionId, std::vector<LensKey> keys,
                                       const xleth::keycurve::NoteZones* zones,
                                       const Timeline& timeline, std::string label)
    : trackId_(trackId), regionId_(regionId), label_(std::move(label))
{
    if (const TrackInfo* t = timeline.getTrack(trackId)) {
        const auto it = t->trackLens.find(regionId);
        if (it != t->trackLens.end()) {
            hadEntry_ = true;
            oldEntry_ = it->second;
        }
    }
    // A new entry keeps rendering what the absent one did (newContentDefault).
    newEntry_ = hadEntry_ ? oldEntry_ : LensTrack{};
    if (!hadEntry_) newEntry_.base = LensParams::newContentDefault();
    newEntry_.keys = std::move(keys);
    if (zones) newEntry_.zones = *zones;
}

void SetHitCurveCommand::execute(Timeline& timeline) {
    if (TrackInfo* t = timeline.getTrackMutable(trackId_)) t->trackLens[regionId_] = newEntry_;
}

void SetHitCurveCommand::undo(Timeline& timeline) {
    if (TrackInfo* t = timeline.getTrackMutable(trackId_)) {
        if (hadEntry_) t->trackLens[regionId_] = oldEntry_;
        else           t->trackLens.erase(regionId_);
    }
}

bool SetHitCurveCommand::changesAnything() const {
    if (!hadEntry_) return true;   // materialising the entry is itself a change
    return newEntry_.keys != oldEntry_.keys || newEntry_.zones != oldEntry_.zones;
}
