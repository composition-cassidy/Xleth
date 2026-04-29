#include "commands/TimelineCommands.h"
#include "model/Timeline.h"
#include "XlethDebug.h"
#include <algorithm>
#include <cstdio>
#include <iostream>

// ─── AddClipCommand ───────────────────────────────────────────────────────────

AddClipCommand::AddClipCommand(Clip clip) : clip_(std::move(clip)) {}

void AddClipCommand::execute(Timeline& timeline) {
    if (firstExecute_) {
        // Let the timeline assign the canonical ID on first use
        int id = timeline.addClip(clip_);
        if (id < 0) {
            std::cerr << "[Undo] ERROR AddClipCommand::execute: addClip failed"
                         " (check trackId/regionId exist)\n";
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
    timeline.removeClip(clip_.id);
}

void RemoveClipCommand::undo(Timeline& timeline) {
    timeline.restoreClip(clip_);
}

std::string RemoveClipCommand::describe() const {
    return "Remove Clip id=" + std::to_string(clip_.id);
}

// ─── MoveClipCommand ──────────────────────────────────────────────────────────

MoveClipCommand::MoveClipCommand(int clipId, TickTime newPosition,
                                 const Timeline& timeline)
    : clipId_(clipId), newPosition_(newPosition)
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
    timeline.moveClip(clipId_, newPosition_);
}

void MoveClipCommand::undo(Timeline& timeline) {
    timeline.moveClip(clipId_, oldPosition_);
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

void ResizeClipCommand::execute(Timeline& timeline) {
    timeline.resizeClip(clipId_, newDuration_);
}

void ResizeClipCommand::undo(Timeline& timeline) {
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
    timeline.resizeClipLeft(clipId_, newPosition_, newDuration_, newRegionOffset_);
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
    Clip* c = timeline.getClipMutable(clipId_);
    if (!c) return;
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
    Clip* c = timeline.getClipMutable(clipId_);
    if (!c) return;
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
    fprintf(stderr, "[PITCHDBG] PitchShiftClip execute: clip=%d %dst+%dc → %dst+%dc\n",
            clipId_, oldSemis_, oldCents_, newSemis_, newCents_);
    fflush(stderr);
#ifdef XLETH_DEBUG
    fprintf(stderr, "[PitchCmd] execute: clip=%d pitch=%dst+%dc → %dst+%dc\n",
            clipId_, oldSemis_, oldCents_, newSemis_, newCents_);
#endif
    Clip* c = timeline.getClipMutable(clipId_);
    if (!c) {
        fprintf(stderr, "[PITCHDBG] PitchShiftClip execute: clip=%d NOT FOUND in timeline\n", clipId_);
        fflush(stderr);
        return;
    }
    c->pitchOffset      = newSemis_;
    c->pitchOffsetCents = newCents_;
    fprintf(stderr, "[PITCHDBG] PitchShiftClip execute DONE: clip=%d pitchSemi=%d cents=%d\n",
            clipId_, c->pitchOffset, c->pitchOffsetCents);
    fflush(stderr);
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
    Clip* c = timeline.getClipMutable(clipId_);
    if (!c) return;
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
        oldParams_.fadeInTicks      = c->fadeInTicks;
        oldParams_.fadeOutTicks     = c->fadeOutTicks;
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
    c->fadeInTicks      = p.fadeInTicks;
    c->fadeOutTicks     = p.fadeOutTicks;
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
    applyClipParams(timeline, clipId_, newParams_);
}

void SetClipParamsCommand::undo(Timeline& timeline) {
    applyClipParams(timeline, clipId_, oldParams_);
}

std::string SetClipParamsCommand::describe() const {
    return "Set Clip Params id=" + std::to_string(clipId_);
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

RemoveTrackCommand::RemoveTrackCommand(int trackId, const Timeline& timeline) {
    const TrackInfo* t = timeline.getTrack(trackId);
    if (t) {
        track_ = *t;
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
    if (gl.chorusTrackId == trackId) wasChorusTrack_ = true;
    if (gl.crashTrackId == trackId && gl.crashEnabled) {
        wasCrashTrack_   = true;
        oldCrashEnabled_ = gl.crashEnabled;
        oldCrashOpacity_ = gl.crashOpacity;
    }
}

void RemoveTrackCommand::execute(Timeline& timeline) {
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
    // Grid cascade: remove track's slot, reset chorus/crash if they referenced it.
    if (hadGridSlot_)
        timeline.removeTrackFromGrid(track_.id);
    if (wasChorusTrack_)
        timeline.setChorusTrack(-1);
    if (wasCrashTrack_)
        timeline.setCrashOverlay(false, -1, oldCrashOpacity_);
}

void RemoveTrackCommand::undo(Timeline& timeline) {
    // Restore track before clips/blocks (they logically belong to the track)
    timeline.restoreTrack(track_);
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
    if (wasChorusTrack_)
        timeline.setChorusTrack(track_.id);
    if (wasCrashTrack_)
        timeline.setCrashOverlay(oldCrashEnabled_, track_.id, oldCrashOpacity_);
}

std::string RemoveTrackCommand::describe() const {
    return "Remove Track '" + track_.name + "' (+"
         + std::to_string(clips_.size()) + " clip(s), +"
         + std::to_string(patternBlocks_.size()) + " block(s))";
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
    timeline.removeRegion(region_.id);
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
}

void SetBPMCommand::execute(Timeline& timeline) {
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
}

void SetBPMCommand::undo(Timeline& timeline) {
    timeline.setBPM(oldBpm_);
    for (const auto& [clipId, oldRatio] : savedStretchRatios_) {
        Clip* c = timeline.getClipMutable(clipId);
        if (c) c->stretchRatio = oldRatio;
    }
}

std::string SetBPMCommand::describe() const {
    return "Set BPM " + std::to_string((int)oldBpm_)
         + " → " + std::to_string((int)newBpm_);
}

// ─── SetTrackMutedCommand ─────────────────────────────────────────────────────

SetTrackMutedCommand::SetTrackMutedCommand(int trackId, bool newMuted, const Timeline& timeline)
    : trackId_(trackId), newMuted_(newMuted)
{
    const TrackInfo* t = timeline.getTrack(trackId);
    oldMuted_ = t ? t->muted : false;
}

void SetTrackMutedCommand::execute(Timeline& timeline) {
    if (TrackInfo* t = timeline.getTrackMutable(trackId_))
        t->muted = newMuted_;
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
    if (TrackInfo* t = timeline.getTrackMutable(trackId_))
        t->solo = newSolo_;
}

void SetTrackSoloCommand::undo(Timeline& timeline) {
    if (TrackInfo* t = timeline.getTrackMutable(trackId_))
        t->solo = oldSolo_;
}

std::string SetTrackSoloCommand::describe() const {
    return std::string(newSolo_ ? "Solo" : "Unsolo") + " Track " + std::to_string(trackId_);
}

// ─── SetTrackNameCommand ──────────────────────────────────────────────────────

SetTrackNameCommand::SetTrackNameCommand(int trackId, std::string newName, const Timeline& timeline)
    : trackId_(trackId), newName_(std::move(newName))
{
    const TrackInfo* t = timeline.getTrack(trackId);
    oldName_ = t ? t->name : std::string{};
}

void SetTrackNameCommand::execute(Timeline& timeline) {
    if (TrackInfo* t = timeline.getTrackMutable(trackId_))
        t->name = newName_;
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

// ─── SetChorusTrackCommand ────────────────────────────────────────────────────

SetChorusTrackCommand::SetChorusTrackCommand(int trackId, const Timeline& timeline)
    : oldTrackId_(timeline.getGridLayout().chorusTrackId), newTrackId_(trackId)
{
    // Snapshot the new track's hold state before auto-enable (for clean undo)
    if (const TrackInfo* t = timeline.getTrack(trackId))
        newTrackOldHold_ = t->videoHoldLastFrame;
}

void SetChorusTrackCommand::execute(Timeline& timeline) {
    // setChorusTrack auto-enables videoHoldLastFrame on the new track
    timeline.setChorusTrack(newTrackId_);
}

void SetChorusTrackCommand::undo(Timeline& timeline) {
    timeline.setChorusTrack(oldTrackId_);
    // Restore the new track's hold state to what it was before auto-enable
    if (TrackInfo* t = timeline.getTrackMutable(newTrackId_))
        t->videoHoldLastFrame = newTrackOldHold_;
}

std::string SetChorusTrackCommand::describe() const {
    return "Set Chorus Track " + std::to_string(newTrackId_);
}

// ─── SetCrashOverlayCommand ───────────────────────────────────────────────────

SetCrashOverlayCommand::SetCrashOverlayCommand(bool enabled, int trackId, float opacity,
                                               const Timeline& timeline)
    : newEnabled_(enabled), newTrackId_(trackId), newOpacity_(opacity)
{
    const GridLayout& gl = timeline.getGridLayout();
    oldEnabled_ = gl.crashEnabled;
    oldTrackId_ = gl.crashTrackId;
    oldOpacity_ = gl.crashOpacity;
}

void SetCrashOverlayCommand::execute(Timeline& timeline) {
    timeline.setCrashOverlay(newEnabled_, newTrackId_, newOpacity_);
}

void SetCrashOverlayCommand::undo(Timeline& timeline) {
    timeline.setCrashOverlay(oldEnabled_, oldTrackId_, oldOpacity_);
}

std::string SetCrashOverlayCommand::describe() const {
    return std::string("Set Crash Overlay ") + (newEnabled_ ? "on" : "off");
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
        oldSettings_.rootNote         = r->rootNote;
        oldSettings_.attackMs         = r->attackMs;
        oldSettings_.decayMs          = r->decayMs;
        oldSettings_.sustain          = r->sustain;
        oldSettings_.releaseMs        = r->releaseMs;
        oldSettings_.delayMs          = r->delayMs;
        oldSettings_.holdMs           = r->holdMs;
        oldSettings_.attackTension    = r->attackTension;
        oldSettings_.decayTension     = r->decayTension;
        oldSettings_.releaseTension   = r->releaseTension;
        oldSettings_.pitchEnvEnabled       = r->pitchEnvEnabled;
        oldSettings_.pitchEnvAmount        = r->pitchEnvAmount;
        oldSettings_.pitchEnvDelayMs       = r->pitchEnvDelayMs;
        oldSettings_.pitchEnvAttackMs      = r->pitchEnvAttackMs;
        oldSettings_.pitchEnvHoldMs        = r->pitchEnvHoldMs;
        oldSettings_.pitchEnvDecayMs       = r->pitchEnvDecayMs;
        oldSettings_.pitchEnvSustain       = r->pitchEnvSustain;
        oldSettings_.pitchEnvReleaseMs     = r->pitchEnvReleaseMs;
        oldSettings_.pitchEnvAttackTension = r->pitchEnvAttackTension;
        oldSettings_.pitchEnvDecayTension  = r->pitchEnvDecayTension;
        oldSettings_.pitchEnvReleaseTension = r->pitchEnvReleaseTension;
        oldSettings_.loopEnabled      = r->loopEnabled;
        oldSettings_.loopStart        = r->loopStart;
        oldSettings_.loopEnd          = r->loopEnd;
        oldSettings_.crossfadeEnabled = r->crossfadeEnabled;
        oldSettings_.smpStart         = r->smpStart;
        oldSettings_.smpLength        = r->smpLength;
        oldSettings_.declickMs         = r->declickMs;
        oldSettings_.fadeInMs         = r->fadeInMs;
        oldSettings_.fadeOutMs        = r->fadeOutMs;
        oldSettings_.crossfadeSamples = r->crossfadeSamples;
        oldSettings_.dcOffsetRemoved  = r->dcOffsetRemoved;
        oldSettings_.normalized       = r->normalized;
        oldSettings_.polarityReversed = r->polarityReversed;
        oldSettings_.reversed         = r->reversed;
        oldSettings_.monoEnabled       = r->monoEnabled;
        oldSettings_.portamentoEnabled = r->portamentoEnabled;
        oldSettings_.portamentoTimeMs  = r->portamentoTimeMs;
        oldSettings_.arpEnabled        = r->arpEnabled;
        oldSettings_.arpTempoSync      = r->arpTempoSync;
        oldSettings_.arpDivision       = r->arpDivision;
        oldSettings_.arpFreeTimeMs     = r->arpFreeTimeMs;
        oldSettings_.arpGate           = r->arpGate;
        oldSettings_.arpRange          = r->arpRange;
        oldSettings_.arpDirection      = r->arpDirection;
        // LFO
        oldSettings_.lfoVolEnabled       = r->lfoVolEnabled;
        oldSettings_.lfoVolAmount        = r->lfoVolAmount;
        oldSettings_.lfoVolSpeedHz       = r->lfoVolSpeedHz;
        oldSettings_.lfoVolTempoSync     = r->lfoVolTempoSync;
        oldSettings_.lfoVolTempoDivision = r->lfoVolTempoDivision;
        oldSettings_.lfoVolAttackMs      = r->lfoVolAttackMs;
        oldSettings_.lfoVolDelayMs       = r->lfoVolDelayMs;
        oldSettings_.lfoVolWaveform      = r->lfoVolWaveform;
        oldSettings_.lfoPanEnabled       = r->lfoPanEnabled;
        oldSettings_.lfoPanAmount        = r->lfoPanAmount;
        oldSettings_.lfoPanSpeedHz       = r->lfoPanSpeedHz;
        oldSettings_.lfoPanTempoSync     = r->lfoPanTempoSync;
        oldSettings_.lfoPanTempoDivision = r->lfoPanTempoDivision;
        oldSettings_.lfoPanAttackMs      = r->lfoPanAttackMs;
        oldSettings_.lfoPanDelayMs       = r->lfoPanDelayMs;
        oldSettings_.lfoPanWaveform      = r->lfoPanWaveform;
        oldSettings_.lfoPitchEnabled       = r->lfoPitchEnabled;
        oldSettings_.lfoPitchAmount        = r->lfoPitchAmount;
        oldSettings_.lfoPitchSpeedHz       = r->lfoPitchSpeedHz;
        oldSettings_.lfoPitchTempoSync     = r->lfoPitchTempoSync;
        oldSettings_.lfoPitchTempoDivision = r->lfoPitchTempoDivision;
        oldSettings_.lfoPitchAttackMs      = r->lfoPitchAttackMs;
        oldSettings_.lfoPitchDelayMs       = r->lfoPitchDelayMs;
        oldSettings_.lfoPitchWaveform      = r->lfoPitchWaveform;
    } else {
        std::cerr << "[Undo] ERROR SetSamplerSettingsCommand: region id=" << regionId
                  << " not found in timeline\n";
    }
}

static void applySamplerSettings(SampleRegion* r, const SamplerSettings& s) {
    r->rootNote         = s.rootNote;
    r->attackMs         = s.attackMs;
    r->decayMs          = s.decayMs;
    r->sustain          = s.sustain;
    r->releaseMs        = s.releaseMs;
    r->delayMs          = s.delayMs;
    r->holdMs           = s.holdMs;
    r->attackTension    = s.attackTension;
    r->decayTension     = s.decayTension;
    r->releaseTension   = s.releaseTension;
    r->pitchEnvEnabled       = s.pitchEnvEnabled;
    r->pitchEnvAmount        = s.pitchEnvAmount;
    r->pitchEnvDelayMs       = s.pitchEnvDelayMs;
    r->pitchEnvAttackMs      = s.pitchEnvAttackMs;
    r->pitchEnvHoldMs        = s.pitchEnvHoldMs;
    r->pitchEnvDecayMs       = s.pitchEnvDecayMs;
    r->pitchEnvSustain       = s.pitchEnvSustain;
    r->pitchEnvReleaseMs     = s.pitchEnvReleaseMs;
    r->pitchEnvAttackTension = s.pitchEnvAttackTension;
    r->pitchEnvDecayTension  = s.pitchEnvDecayTension;
    r->pitchEnvReleaseTension = s.pitchEnvReleaseTension;
    r->loopEnabled      = s.loopEnabled;
    r->loopStart        = s.loopStart;
    r->loopEnd          = s.loopEnd;
    r->crossfadeEnabled = s.crossfadeEnabled;
    r->smpStart         = s.smpStart;
    r->smpLength        = s.smpLength;
    r->declickMs         = s.declickMs;
    r->fadeInMs         = s.fadeInMs;
    r->fadeOutMs        = s.fadeOutMs;
    r->crossfadeSamples = s.crossfadeSamples;
    r->dcOffsetRemoved  = s.dcOffsetRemoved;
    r->normalized       = s.normalized;
    r->polarityReversed = s.polarityReversed;
    r->reversed         = s.reversed;
    r->monoEnabled       = s.monoEnabled;
    r->portamentoEnabled = s.portamentoEnabled;
    r->portamentoTimeMs  = s.portamentoTimeMs;
    r->arpEnabled        = s.arpEnabled;
    r->arpTempoSync      = s.arpTempoSync;
    r->arpDivision       = s.arpDivision;
    r->arpFreeTimeMs     = s.arpFreeTimeMs;
    r->arpGate           = s.arpGate;
    r->arpRange          = s.arpRange;
    r->arpDirection      = s.arpDirection;
    // LFO
    r->lfoVolEnabled       = s.lfoVolEnabled;
    r->lfoVolAmount        = s.lfoVolAmount;
    r->lfoVolSpeedHz       = s.lfoVolSpeedHz;
    r->lfoVolTempoSync     = s.lfoVolTempoSync;
    r->lfoVolTempoDivision = s.lfoVolTempoDivision;
    r->lfoVolAttackMs      = s.lfoVolAttackMs;
    r->lfoVolDelayMs       = s.lfoVolDelayMs;
    r->lfoVolWaveform      = s.lfoVolWaveform;
    r->lfoPanEnabled       = s.lfoPanEnabled;
    r->lfoPanAmount        = s.lfoPanAmount;
    r->lfoPanSpeedHz       = s.lfoPanSpeedHz;
    r->lfoPanTempoSync     = s.lfoPanTempoSync;
    r->lfoPanTempoDivision = s.lfoPanTempoDivision;
    r->lfoPanAttackMs      = s.lfoPanAttackMs;
    r->lfoPanDelayMs       = s.lfoPanDelayMs;
    r->lfoPanWaveform      = s.lfoPanWaveform;
    r->lfoPitchEnabled       = s.lfoPitchEnabled;
    r->lfoPitchAmount        = s.lfoPitchAmount;
    r->lfoPitchSpeedHz       = s.lfoPitchSpeedHz;
    r->lfoPitchTempoSync     = s.lfoPitchTempoSync;
    r->lfoPitchTempoDivision = s.lfoPitchTempoDivision;
    r->lfoPitchAttackMs      = s.lfoPitchAttackMs;
    r->lfoPitchDelayMs       = s.lfoPitchDelayMs;
    r->lfoPitchWaveform      = s.lfoPitchWaveform;
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
            std::cerr << "[Undo] ERROR AddPatternBlockCommand::execute: addPatternBlock"
                         " failed (check trackId/patternId exist)\n";
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
    timeline.removePatternBlock(block_.id);
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
    timeline.movePatternBlock(blockId_, newTrackId_, newPosition_);
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
    timeline.resizePatternBlock(blockId_, newDuration_);
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
    timeline.resizePatternBlockLeft(blockId_, newPosition_, newDuration_, newOffset_);
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
    timeline.setPatternBlockLoopEnabled(blockId_, newLoopEnabled_);
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
    timeline.removeNoteFromPattern(patternId_, note_.id);
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
    timeline.moveNote(patternId_, noteId_, newPosition_, newPitch_);
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
    timeline.resizeNote(patternId_, noteId_, newDuration_);
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
    timeline.setNoteVelocity(patternId_, noteId_, newVelocity_);
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
        oldType_          = t->type;
        oldVideoFlipMode_ = t->videoFlipMode;
    } else {
        std::cerr << "[Undo] ERROR ConvertTrackTypeCommand: trackId=" << trackId
                  << " not found in timeline\n";
        oldType_          = TrackInfo::Type::Clip;
        oldVideoFlipMode_ = VideoFlipMode::None;
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
        t->type          = oldType_;
        t->videoFlipMode = oldVideoFlipMode_;
    }
    // Restore any cascaded pattern-blocks.
    for (const auto& b : cascadedBlocks_)
        timeline.restorePatternBlock(b);
}

std::string ConvertTrackTypeCommand::describe() const {
    return "Convert Track " + std::to_string(trackId_) + " to "
         + (newType_ == TrackInfo::Type::Pattern ? "Pattern" : "Clip");
}

// ─── SetVideoFlipModeCommand ──────────────────────────────────────────────────

SetVideoFlipModeCommand::SetVideoFlipModeCommand(int trackId, VideoFlipMode newMode,
                                                 const Timeline& timeline)
    : trackId_(trackId), newMode_(newMode)
{
    const TrackInfo* t = timeline.getTrack(trackId);
    oldMode_ = t ? t->videoFlipMode : VideoFlipMode::None;
}

void SetVideoFlipModeCommand::execute(Timeline& timeline) {
    timeline.setTrackVideoFlipMode(trackId_, newMode_);
}

void SetVideoFlipModeCommand::undo(Timeline& timeline) {
    timeline.setTrackVideoFlipMode(trackId_, oldMode_);
}

std::string SetVideoFlipModeCommand::describe() const {
    return "Set VideoFlipMode (track=" + std::to_string(trackId_)
         + ") → " + videoFlipModeToString(newMode_);
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
    // Reverse: move from toIndex back to fromIndex
    // After execute, the item is at an adjusted position; use reverse move
    int insertAt = (toIndex_ > fromIndex_) ? toIndex_ - 1 : toIndex_;
    timeline.reorderVisualEffect(trackId_, insertAt, fromIndex_);
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
    timeline.setVisualEffectParam(trackId_, effectIndex_, paramIndex_, newValue_);
}

void SetVisualEffectParamCommand::undo(Timeline& timeline) {
    timeline.setVisualEffectParam(trackId_, effectIndex_, paramIndex_, oldValue_);
}

std::string SetVisualEffectParamCommand::describe() const {
    return "Set Visual Effect Param (track=" + std::to_string(trackId_)
           + " effect=" + std::to_string(effectIndex_)
           + " param=" + std::to_string(paramIndex_) + ")";
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
