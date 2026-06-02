#include "EnvelopeVoiceEvents.h"

#include <algorithm>
#include <unordered_map>

// EnvelopeVoiceEvents — pure enumeration of per-voice Envelope trigger
// occurrences (EVC.4). See EnvelopeVoiceEvents.h for the design contract.

namespace {

// Sample conversion identical to MixEngine's: TickTime::toSamples(bpm, sr) at
// 960 PPQ. Negative ticks (e.g. a block offset that rolls a candidate onset
// before t=0) are clamped to 0 so downstream sample math never goes negative —
// those candidates are window-filtered out anyway.
int64_t tickToSampleClamped(int64_t tick, double bpm, double sampleRate) {
    if (tick <= 0) return 0;
    return TickTime{tick}.toSamples(bpm, sampleRate);
}

}  // namespace

bool envelopeVoiceEventLess(const EnvelopeVoiceEvent& a, const EnvelopeVoiceEvent& b) {
    if (a.onsetTick != b.onsetTick) return a.onsetTick < b.onsetTick;
    if (a.sourceKind != b.sourceKind)
        return static_cast<int>(a.sourceKind) < static_cast<int>(b.sourceKind);
    if (a.trackId != b.trackId) return a.trackId < b.trackId;
    if (a.patternBlockId != b.patternBlockId) return a.patternBlockId < b.patternBlockId;
    if (a.loopIteration != b.loopIteration) return a.loopIteration < b.loopIteration;
    if (a.pitch != b.pitch) return a.pitch < b.pitch;
    return a.sourceId < b.sourceId;
}

// ─── Timeline clip occurrences ────────────────────────────────────────────────

std::vector<EnvelopeVoiceEvent> enumerateEnvelopeClipOccurrences(
    const std::vector<Clip>& clips,
    int                      parentTrackId,
    const EnvelopeQueryWindow& window,
    double                   bpm,
    double                   sampleRate)
{
    std::vector<EnvelopeVoiceEvent> out;
    if (window.isEmpty()) return out;

    for (const Clip& clip : clips) {
        if (clip.trackId != parentTrackId) continue;

        const int64_t onsetTick   = clip.position.ticks;
        const int64_t gateEndTick = (clip.position + clip.duration).ticks;

        // Overlap test, mirroring MixEngine::findActiveClips
        // (skip when gateEnd <= start || onset >= end). A zero/negative-length
        // clip has no real gate span; admit it only when its onset lands inside
        // the window so it is not silently lost (handled-safely rule).
        const bool degenerate = gateEndTick <= onsetTick;
        const bool overlaps = degenerate
            ? (onsetTick >= window.startTick && onsetTick < window.endTick)
            : (gateEndTick > window.startTick && onsetTick < window.endTick);
        if (!overlaps) continue;

        EnvelopeVoiceEvent ev;
        ev.trackId      = clip.trackId;
        ev.sourceKind   = EnvelopeVoiceSourceKind::TimelineClip;
        ev.sourceId     = clip.id;
        ev.onsetTick    = onsetTick;
        ev.gateEndTick  = gateEndTick < onsetTick ? onsetTick : gateEndTick;
        ev.onsetSample   = tickToSampleClamped(ev.onsetTick, bpm, sampleRate);
        ev.gateEndSample = tickToSampleClamped(ev.gateEndTick, bpm, sampleRate);
        ev.loopIteration  = 0;
        ev.pitch          = clip.pitchOffset;   // semitone offset (clip-track convention)
        ev.velocity       = clip.velocity;
        ev.regionId       = clip.regionId;
        ev.patternId      = -1;
        ev.patternBlockId = -1;

        ev.key.trackId        = clip.trackId;
        ev.key.sourceKind     = EnvelopeVoiceSourceKind::TimelineClip;
        ev.key.sourceId       = clip.id;
        ev.key.onsetTick      = ev.onsetTick;
        ev.key.loopIteration  = 0;
        ev.key.patternBlockId = -1;

        out.push_back(ev);
    }

    std::sort(out.begin(), out.end(), envelopeVoiceEventLess);
    return out;
}

// ─── Pattern note occurrences ─────────────────────────────────────────────────

std::vector<EnvelopeVoiceEvent> enumerateEnvelopePatternNoteOccurrences(
    const std::vector<PatternBlock>& blocks,
    const std::vector<Pattern>&      patterns,
    int                              parentTrackId,
    const EnvelopeQueryWindow&       window,
    double                           bpm,
    double                           sampleRate)
{
    std::vector<EnvelopeVoiceEvent> out;
    if (window.isEmpty()) return out;

    // patternId → Pattern lookup (pure; built once per call).
    std::unordered_map<int, const Pattern*> patternById;
    patternById.reserve(patterns.size());
    for (const Pattern& p : patterns) patternById[p.id] = &p;

    for (const PatternBlock& block : blocks) {
        if (block.trackId != parentTrackId) continue;

        auto pit = patternById.find(block.patternId);
        if (pit == patternById.end()) continue;
        const Pattern* pattern = pit->second;
        if (pattern == nullptr || pattern->regionId < 0) continue;

        const int64_t patternLenTicks = pattern->length.ticks;
        if (patternLenTicks <= 0) continue;   // matches triggerPatternNotes guard

        const int64_t blockPosTicks    = block.position.ticks;
        const int64_t blockOffsetTicks = block.offset.ticks;
        const int64_t blockEndTicks    = blockPosTicks + block.duration.ticks;

        // Clamp the scan to the intersection of the query window and the block's
        // own [position, position+duration) span (triggerPatternNotes semantics).
        const int64_t windowStart = std::max<int64_t>(window.startTick, blockPosTicks);
        const int64_t windowEnd   = std::min<int64_t>(window.endTick,   blockEndTicks);
        if (windowEnd <= windowStart) continue;

        // Loop-iteration range over the pattern-local time axis (same math as
        // triggerPatternNotes: clamp first iteration to >= 0).
        const int64_t firstLoopIdx = std::max<int64_t>(
            0, (windowStart - blockPosTicks + blockOffsetTicks) / patternLenTicks);
        int64_t lastLoopIdx =
            (windowEnd - blockPosTicks + blockOffsetTicks) / patternLenTicks;

        // loopEnabled == false → only iteration 0 plays; notes past the pattern
        // boundary become silence (the visible "empty space").
        if (!block.loopEnabled)
            lastLoopIdx = std::min<int64_t>(lastLoopIdx, 0);

        for (const PatternNote& note : pattern->notes) {
            // Slide notes are silent pitch-target markers — no audible voice, so
            // no envelope voice occurrence (matches triggerPatternNotes, which
            // emits no NoteOn/NoteOff for them).
            if (note.isSlide) continue;

            for (int64_t L = firstLoopIdx; L <= lastLoopIdx; ++L) {
                const int64_t absNoteOn = blockPosTicks - blockOffsetTicks
                                          + L * patternLenTicks + note.position.ticks;

                // Onset-in-window (live-trigger semantics; EVC.4b adds held-note
                // reconstruction). Half-open [windowStart, windowEnd).
                if (absNoteOn < windowStart || absNoteOn >= windowEnd) continue;

                // Note-off clamped to the block end so a note reaching/exceeding
                // the block boundary still releases instead of ringing past it.
                const int64_t rawNoteOff = absNoteOn + note.duration.ticks;
                const int64_t absNoteOff = std::min<int64_t>(rawNoteOff, blockEndTicks);
                const int64_t gateEndTick = absNoteOff < absNoteOn ? absNoteOn : absNoteOff;

                EnvelopeVoiceEvent ev;
                ev.trackId      = block.trackId;
                ev.sourceKind   = EnvelopeVoiceSourceKind::PatternNote;
                ev.sourceId     = note.id;
                ev.onsetTick    = absNoteOn;
                ev.gateEndTick  = gateEndTick;
                ev.onsetSample   = tickToSampleClamped(absNoteOn, bpm, sampleRate);
                ev.gateEndSample = tickToSampleClamped(gateEndTick, bpm, sampleRate);
                ev.loopIteration  = L;
                ev.pitch          = note.pitch;
                ev.velocity       = note.velocity;
                ev.regionId       = pattern->regionId;
                ev.patternId      = pattern->id;
                ev.patternBlockId = block.id;

                ev.key.trackId        = block.trackId;
                ev.key.sourceKind     = EnvelopeVoiceSourceKind::PatternNote;
                ev.key.sourceId       = note.id;
                ev.key.onsetTick      = absNoteOn;
                ev.key.loopIteration  = L;
                ev.key.patternBlockId = block.id;

                out.push_back(ev);
            }
        }
    }

    std::sort(out.begin(), out.end(), envelopeVoiceEventLess);
    return out;
}

// ─── Combined enumeration ─────────────────────────────────────────────────────

std::vector<EnvelopeVoiceEvent> enumerateEnvelopeVoiceOccurrences(
    const std::vector<Clip>&         clips,
    const std::vector<PatternBlock>& blocks,
    const std::vector<Pattern>&      patterns,
    int                              parentTrackId,
    EnvelopeTriggerEvents            events,
    const EnvelopeQueryWindow&       window,
    double                           bpm,
    double                           sampleRate)
{
    std::vector<EnvelopeVoiceEvent> out;
    if (window.isEmpty()) return out;

    const bool wantNotes = events == EnvelopeTriggerEvents::Notes
                        || events == EnvelopeTriggerEvents::NotesAndClips;
    const bool wantClips = events == EnvelopeTriggerEvents::Clips
                        || events == EnvelopeTriggerEvents::NotesAndClips;

    if (wantNotes) {
        auto notes = enumerateEnvelopePatternNoteOccurrences(
            blocks, patterns, parentTrackId, window, bpm, sampleRate);
        out.insert(out.end(), notes.begin(), notes.end());
    }
    if (wantClips) {
        auto clipEvents = enumerateEnvelopeClipOccurrences(
            clips, parentTrackId, window, bpm, sampleRate);
        out.insert(out.end(), clipEvents.begin(), clipEvents.end());
    }

    std::sort(out.begin(), out.end(), envelopeVoiceEventLess);
    return out;
}
