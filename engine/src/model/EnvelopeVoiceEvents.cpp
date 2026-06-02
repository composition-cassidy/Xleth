#include "EnvelopeVoiceEvents.h"

#include <algorithm>
#include <cmath>
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

// ═══ EVC.4b: seek/reconstruction model ════════════════════════════════════════

// ─── Timing helpers ───────────────────────────────────────────────────────────

double envelopeTicksToMs(int64_t tickDelta, double bpm) {
    if (!(bpm > 0.0)) return 0.0;
    // ticks / 960 = beats; beats * (60000 / bpm) = ms. Mirrors TickTime::toSeconds.
    return (static_cast<double>(tickDelta) / 960.0) * (60000.0 / bpm);
}

int64_t envelopeReconstructionTailTicks(const EnvelopeAhdsrSettings& settings, double bpm) {
    const EnvelopeAhdsrSettings s = settings.normalized();
    if (!(bpm > 0.0) || s.releaseMs <= 0.0) return 0;
    // ms → ticks (inverse of envelopeTicksToMs). Round up so the release tail is
    // never under-counted (a voice exactly at the tail boundary stays included).
    const double ticks = (s.releaseMs / (60000.0 / bpm)) * 960.0;
    if (!std::isfinite(ticks) || ticks <= 0.0) return 0;
    return static_cast<int64_t>(std::ceil(ticks));
}

// ─── Reconstruction clip occurrences ──────────────────────────────────────────

std::vector<EnvelopeVoiceEvent> enumerateEnvelopeClipOccurrencesForReconstruction(
    const std::vector<Clip>&   clips,
    int                        parentTrackId,
    const EnvelopeQueryWindow& window,
    double                     bpm,
    double                     sampleRate,
    int64_t                    releaseTailTicks)
{
    std::vector<EnvelopeVoiceEvent> out;
    if (window.isEmpty()) return out;

    const int64_t tail = releaseTailTicks > 0 ? releaseTailTicks : 0;

    for (const Clip& clip : clips) {
        if (clip.trackId != parentTrackId) continue;

        const int64_t onsetTick   = clip.position.ticks;
        const int64_t rawGateEnd  = (clip.position + clip.duration).ticks;
        const int64_t gateEndTick = rawGateEnd < onsetTick ? onsetTick : rawGateEnd;

        // Reconstruction overlap: gate extended by the release tail overlaps the
        // window, so a clip still in its release segment after its body ended is
        // returned. A zero/negative-length clip is admitted by onset-in-window
        // (matching the live enumerator's degenerate rule).
        const bool degenerate = rawGateEnd <= onsetTick;
        const bool overlaps = degenerate
            ? (onsetTick >= window.startTick && onsetTick < window.endTick)
            : (onsetTick < window.endTick && (gateEndTick + tail) > window.startTick);
        if (!overlaps) continue;

        EnvelopeVoiceEvent ev;
        ev.trackId      = clip.trackId;
        ev.sourceKind   = EnvelopeVoiceSourceKind::TimelineClip;
        ev.sourceId     = clip.id;
        ev.onsetTick    = onsetTick;
        ev.gateEndTick  = gateEndTick;
        ev.onsetSample   = onsetTick   <= 0 ? 0 : TickTime{onsetTick}.toSamples(bpm, sampleRate);
        ev.gateEndSample = gateEndTick <= 0 ? 0 : TickTime{gateEndTick}.toSamples(bpm, sampleRate);
        ev.loopIteration  = 0;
        ev.pitch          = clip.pitchOffset;
        ev.velocity       = clip.velocity;
        ev.regionId       = clip.regionId;
        ev.patternId      = -1;
        ev.patternBlockId = -1;

        ev.key.trackId        = clip.trackId;
        ev.key.sourceKind     = EnvelopeVoiceSourceKind::TimelineClip;
        ev.key.sourceId       = clip.id;
        ev.key.onsetTick      = onsetTick;
        ev.key.loopIteration  = 0;
        ev.key.patternBlockId = -1;

        out.push_back(ev);
    }

    std::sort(out.begin(), out.end(), envelopeVoiceEventLess);
    return out;
}

// ─── Reconstruction pattern-note occurrences ──────────────────────────────────

std::vector<EnvelopeVoiceEvent> enumerateEnvelopePatternNoteOccurrencesForReconstruction(
    const std::vector<PatternBlock>& blocks,
    const std::vector<Pattern>&      patterns,
    int                              parentTrackId,
    const EnvelopeQueryWindow&       window,
    double                           bpm,
    double                           sampleRate,
    int64_t                          releaseTailTicks)
{
    std::vector<EnvelopeVoiceEvent> out;
    if (window.isEmpty()) return out;

    const int64_t tail = releaseTailTicks > 0 ? releaseTailTicks : 0;

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
        if (patternLenTicks <= 0) continue;

        const int64_t blockPosTicks    = block.position.ticks;
        const int64_t blockOffsetTicks = block.offset.ticks;
        const int64_t blockEndTicks    = blockPosTicks + block.duration.ticks;

        // Longest note in this pattern — the most a note's onset can precede the
        // query window and still be sounding/releasing at it.
        int64_t maxNoteDurTicks = 0;
        for (const PatternNote& note : pattern->notes) {
            if (note.isSlide) continue;
            if (note.duration.ticks > maxNoteDurTicks) maxNoteDurTicks = note.duration.ticks;
        }

        // Widen the candidate scan backward so notes that onset before the window
        // but remain active/releasing at it are found, then clamp to the block span
        // (same intersection rule as the live enumerator).
        const int64_t backTicks    = maxNoteDurTicks + tail;
        const int64_t scanStart    = window.startTick - backTicks;
        const int64_t windowStart  = std::max<int64_t>(scanStart,      blockPosTicks);
        const int64_t windowEnd    = std::min<int64_t>(window.endTick, blockEndTicks);
        if (windowEnd <= windowStart) continue;

        const int64_t firstLoopIdx = std::max<int64_t>(
            0, (windowStart - blockPosTicks + blockOffsetTicks) / patternLenTicks);
        int64_t lastLoopIdx =
            (windowEnd - blockPosTicks + blockOffsetTicks) / patternLenTicks;
        if (!block.loopEnabled)
            lastLoopIdx = std::min<int64_t>(lastLoopIdx, 0);

        for (const PatternNote& note : pattern->notes) {
            if (note.isSlide) continue;

            for (int64_t L = firstLoopIdx; L <= lastLoopIdx; ++L) {
                const int64_t absNoteOn = blockPosTicks - blockOffsetTicks
                                          + L * patternLenTicks + note.position.ticks;

                const int64_t rawNoteOff = absNoteOn + note.duration.ticks;
                const int64_t absNoteOff = std::min<int64_t>(rawNoteOff, blockEndTicks);
                const int64_t gateEndTick = absNoteOff < absNoteOn ? absNoteOn : absNoteOff;

                // Reconstruction overlap against the ORIGINAL query window (not the
                // widened scan): admit the occurrence if it is sounding or releasing
                // at the window. Zero-length notes use onset-in-window (degenerate).
                const bool degenerate = gateEndTick <= absNoteOn;
                const bool overlaps = degenerate
                    ? (absNoteOn >= window.startTick && absNoteOn < window.endTick)
                    : (absNoteOn < window.endTick && (gateEndTick + tail) > window.startTick);
                if (!overlaps) continue;

                EnvelopeVoiceEvent ev;
                ev.trackId      = block.trackId;
                ev.sourceKind   = EnvelopeVoiceSourceKind::PatternNote;
                ev.sourceId     = note.id;
                ev.onsetTick    = absNoteOn;
                ev.gateEndTick  = gateEndTick;
                ev.onsetSample   = absNoteOn   <= 0 ? 0 : TickTime{absNoteOn}.toSamples(bpm, sampleRate);
                ev.gateEndSample = gateEndTick <= 0 ? 0 : TickTime{gateEndTick}.toSamples(bpm, sampleRate);
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

// ─── Combined reconstruction enumeration ──────────────────────────────────────

std::vector<EnvelopeVoiceEvent> enumerateEnvelopeVoiceOccurrencesForReconstruction(
    const std::vector<Clip>&         clips,
    const std::vector<PatternBlock>& blocks,
    const std::vector<Pattern>&      patterns,
    int                              parentTrackId,
    EnvelopeTriggerEvents            events,
    const EnvelopeQueryWindow&       window,
    double                           bpm,
    double                           sampleRate,
    int64_t                          releaseTailTicks)
{
    std::vector<EnvelopeVoiceEvent> out;
    if (window.isEmpty()) return out;

    const bool wantNotes = events == EnvelopeTriggerEvents::Notes
                        || events == EnvelopeTriggerEvents::NotesAndClips;
    const bool wantClips = events == EnvelopeTriggerEvents::Clips
                        || events == EnvelopeTriggerEvents::NotesAndClips;

    if (wantNotes) {
        auto notes = enumerateEnvelopePatternNoteOccurrencesForReconstruction(
            blocks, patterns, parentTrackId, window, bpm, sampleRate, releaseTailTicks);
        out.insert(out.end(), notes.begin(), notes.end());
    }
    if (wantClips) {
        auto clipEvents = enumerateEnvelopeClipOccurrencesForReconstruction(
            clips, parentTrackId, window, bpm, sampleRate, releaseTailTicks);
        out.insert(out.end(), clipEvents.begin(), clipEvents.end());
    }

    std::sort(out.begin(), out.end(), envelopeVoiceEventLess);
    return out;
}

// ─── Per-voice state reconstruction ───────────────────────────────────────────

namespace {

EnvelopeReconstructedVoice reconstructOne(const EnvelopeVoiceEvent&    ev,
                                          const EnvelopeAhdsrSettings& settings,
                                          int64_t                      queryTick,
                                          double                       bpm) {
    EnvelopeReconstructedVoice v;
    v.key            = ev.key;
    v.sourceKind     = ev.sourceKind;
    v.trackId        = ev.trackId;
    v.sourceId       = ev.sourceId;
    v.onsetTick      = ev.onsetTick;
    v.gateEndTick    = ev.gateEndTick;
    v.queryTick      = queryTick;
    v.pitch          = ev.pitch;
    v.velocity       = ev.velocity;
    v.regionId       = ev.regionId;
    v.patternId      = ev.patternId;
    v.patternBlockId = ev.patternBlockId;

    const double elapsedMs    = envelopeTicksToMs(queryTick - ev.onsetTick, bpm);
    const double gateLengthMs = envelopeTicksToMs(ev.gateLengthTicks(),     bpm);
    v.env = evaluateEnvelopeAhdsr(settings, elapsedMs, gateLengthMs);
    return v;
}

}  // namespace

std::vector<EnvelopeReconstructedVoice> reconstructEnvelopeVoiceStates(
    const std::vector<EnvelopeVoiceEvent>& events,
    const EnvelopeAhdsrSettings&           settings,
    int64_t                                queryTick,
    double                                 bpm)
{
    std::vector<EnvelopeReconstructedVoice> out;
    out.reserve(events.size());
    for (const EnvelopeVoiceEvent& ev : events)
        out.push_back(reconstructOne(ev, settings, queryTick, bpm));
    return out;
}

std::vector<EnvelopeReconstructedVoice> reconstructActiveEnvelopeVoiceStates(
    const std::vector<EnvelopeVoiceEvent>& events,
    const EnvelopeAhdsrSettings&           settings,
    int64_t                                queryTick,
    double                                 bpm)
{
    std::vector<EnvelopeReconstructedVoice> out;
    for (const EnvelopeVoiceEvent& ev : events) {
        EnvelopeReconstructedVoice v = reconstructOne(ev, settings, queryTick, bpm);
        if (v.env.active) out.push_back(std::move(v));
    }
    return out;
}
