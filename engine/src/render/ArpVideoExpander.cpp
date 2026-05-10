#include "ArpVideoExpander.h"

#include <algorithm>
#include <cstdio>

// ===========================================================================
// getNextArpNote — line-for-line port of Arpeggiator::getNextNote()
// ===========================================================================

int ArpVideoExpander::getNextArpNote(ArpSimState& s)
{
    if (s.heldNotes.empty()) return 60;

    const int n = static_cast<int>(s.heldNotes.size());
    const int totalSteps = n * s.range; // total notes across all octaves

    // Clamp currentStep into valid range
    if (s.currentStep < 0) s.currentStep = 0;

    // Compute note index and octave from currentStep
    int noteIdx  = s.currentStep % n;
    int octave   = s.currentStep / n;

    int basePitch;

    switch (s.direction) {
    case 0: // Up
        basePitch = s.heldNotes[noteIdx];
        break;

    case 1: // Down
    {
        // Reverse: step 0 = highest octave highest note
        int revStep = (totalSteps - 1) - s.currentStep;
        if (revStep < 0) revStep = 0;
        noteIdx = revStep % n;
        octave  = revStep / n;
        basePitch = s.heldNotes[noteIdx];
        break;
    }

    case 2: // UpDown
    {
        // Sequence length: up (totalSteps) + down (totalSteps - 2) to avoid
        // repeating top and bottom notes.
        int seqLen = totalSteps > 1 ? (totalSteps * 2 - 2) : 1;
        int pos = s.currentStep % seqLen;
        int linearStep;
        if (pos < totalSteps) {
            linearStep = pos; // ascending
        } else {
            linearStep = totalSteps * 2 - 2 - pos; // descending
        }
        noteIdx = linearStep % n;
        octave  = linearStep / n;
        basePitch = s.heldNotes[noteIdx];
        break;
    }

    case 3: // UpDownSticky
    {
        // Sequence length: up (totalSteps) + down (totalSteps) — top and
        // bottom notes repeat.
        int seqLen = totalSteps > 1 ? (totalSteps * 2) : 1;
        int pos = s.currentStep % seqLen;
        int linearStep;
        if (pos < totalSteps) {
            linearStep = pos; // ascending
        } else {
            linearStep = totalSteps * 2 - 1 - pos; // descending
        }
        noteIdx = linearStep % n;
        octave  = linearStep / n;
        basePitch = s.heldNotes[noteIdx];
        break;
    }

    default:
        basePitch = s.heldNotes[0];
        break;
    }

    // Advance step for next call
    s.currentStep++;

    // Wrap based on direction
    switch (s.direction) {
    case 0: // Up
    case 1: // Down
        if (s.currentStep >= totalSteps)
            s.currentStep = 0;
        break;
    case 2: // UpDown
    {
        int seqLen = totalSteps > 1 ? (totalSteps * 2 - 2) : 1;
        if (s.currentStep >= seqLen) s.currentStep = 0;
        break;
    }
    case 3: // UpDownSticky
    {
        int seqLen = totalSteps > 1 ? (totalSteps * 2) : 1;
        if (s.currentStep >= seqLen) s.currentStep = 0;
        break;
    }
    }

    const int finalPitch = basePitch + octave * 12;
    return finalPitch;
}

// ===========================================================================
// expandArpVideoEvents — beat-space arp simulation → VideoEvent list
// ===========================================================================

std::vector<VideoEvent> ArpVideoExpander::expandArpVideoEvents(
    const std::vector<const PatternNote*>& notes,
    int64_t blockPosTicks,
    int64_t blockDurationTicks,
    int64_t patternLenTicks,
    bool    loopEnabled,
    int64_t firstLoopIdx,
    int64_t lastLoopIdx,
    int64_t windowStart,
    int64_t windowEnd,
    bool    arpTempoSync,
    int     arpDivision,
    float   arpFreeTimeMs,
    float   arpGate,
    int     arpRange,
    int     arpDirection,
    double  bpm,
    int     sourceId,
    int     trackId,
    int     regionId,
    double  sourceStartTime,
    double  sourceEndTime,
    int&    counter)
{
    std::vector<VideoEvent> result;

    // ── 1. Build sorted note-event timeline ─────────────────────────────────
    std::vector<ArpNoteEvent> events;
    events.reserve(notes.size() * 2 * static_cast<size_t>(lastLoopIdx - firstLoopIdx + 1));

    const double blockEndBeats = static_cast<double>(blockPosTicks + blockDurationTicks) / 960.0;

    for (int64_t L = firstLoopIdx; L <= lastLoopIdx; ++L) {
        for (const PatternNote* note : notes) {
            const int64_t tapePos = L * patternLenTicks + note->position.ticks;
            if (tapePos < windowStart) continue;
            if (tapePos >= windowEnd)  continue;

            const int64_t noteOnTicks  = blockPosTicks + (tapePos - windowStart);
            const int64_t rawOffTicks  = noteOnTicks + note->duration.ticks;
            const int64_t blockEndTicks = blockPosTicks + blockDurationTicks;
            const int64_t noteOffTicks = std::min(rawOffTicks, blockEndTicks);

            events.push_back({ static_cast<double>(noteOnTicks)  / 960.0,
                               note->pitch, note->velocity, true });
            events.push_back({ static_cast<double>(noteOffTicks) / 960.0,
                               note->pitch, 0.0f, false });
        }
    }

    if (events.empty()) return result;

    // Sort: by beatPos, then noteOff before noteOn at the same position.
    std::sort(events.begin(), events.end(),
        [](const ArpNoteEvent& a, const ArpNoteEvent& b) {
            if (a.beatPos != b.beatPos) return a.beatPos < b.beatPos;
            return !a.isNoteOn && b.isNoteOn; // noteOff < noteOn
        });

    // ── 2. Compute arp step duration in beats ───────────────────────────────
    double stepBeats;
    if (arpTempoSync) {
        stepBeats = 4.0 / static_cast<double>(arpDivision > 0 ? arpDivision : 8);
    } else {
        // Free time: convert ms to beats using BPM
        const double safeBpm = bpm > 0.0 ? bpm : 120.0;
        stepBeats = (static_cast<double>(arpFreeTimeMs) / 1000.0) * (safeBpm / 60.0);
    }
    if (stepBeats <= 0.0) stepBeats = 0.5; // safety fallback

    const double gateDurationBeats = stepBeats * static_cast<double>(arpGate);

    // ── 3. Walk the timeline, emitting arp steps ────────────────────────────
    ArpSimState state;
    state.direction = arpDirection;
    state.range     = arpRange > 0 ? arpRange : 1;

    double arpCursor = -1.0; // beat position of next arp step (-1 = inactive)
    int added = 0;
    static constexpr int kMaxArpSteps = 100000; // safety bound

    for (size_t i = 0; i <= events.size(); ++i) {
        const double nextEventBeat = (i < events.size()) ? events[i].beatPos : blockEndBeats;

        // Emit arp steps from arpCursor until the next note event
        while (arpCursor >= 0.0 && arpCursor < nextEventBeat
               && !state.heldNotes.empty() && added < kMaxArpSteps)
        {
            // Resolved arp-step pitch — flows into the flip-v2 resolver as
            // the trigger pitch for new-note / specific-pitches modifiers.
            const int stepPitch = getNextArpNote(state);

            VideoEvent ve;
            ve.startBeat       = arpCursor;
            ve.durationBeats   = std::min(gateDurationBeats, blockEndBeats - arpCursor);
            ve.sourceId        = sourceId;
            ve.trackId         = trackId;
            ve.regionId        = regionId;   // route to per-region proxy
            ve.sourceStartTime = sourceStartTime;
            ve.sourceEndTime   = sourceEndTime;
            ve.layerIndex      = 0;
            ve.x = 0.0f; ve.y = 0.0f;
            ve.width = 1.0f; ve.height = 1.0f;
            ve.opacity         = state.storedVelocity;
            const int emissionOrder = counter++;
            ve.globalNoteIndex = emissionOrder;
            ve.hasSourceTriggerOrder = true;
            ve.sourceTriggerOrder = emissionOrder;
            ve.originalEmissionOrder = emissionOrder;
            ve.pitch           = stepPitch;
            result.push_back(ve);
            ++added;

            arpCursor += stepBeats;
        }

        // Process the note event
        if (i < events.size()) {
            const auto& e = events[i];
            if (e.isNoteOn) {
                const bool wasEmpty = state.heldNotes.empty();
                // Insert sorted, skip duplicates — mirrors Arpeggiator::noteOn()
                auto it = std::lower_bound(state.heldNotes.begin(),
                                           state.heldNotes.end(), e.pitch);
                if (it == state.heldNotes.end() || *it != e.pitch)
                    state.heldNotes.insert(it, e.pitch);
                state.storedVelocity = e.velocity;
                if (wasEmpty) {
                    // First note resets arp — step fires immediately
                    state.currentStep = 0;
                    arpCursor = e.beatPos;
                }
            } else {
                // noteOff — mirrors Arpeggiator::noteOff()
                auto it = std::lower_bound(state.heldNotes.begin(),
                                           state.heldNotes.end(), e.pitch);
                if (it != state.heldNotes.end() && *it == e.pitch)
                    state.heldNotes.erase(it);
                if (state.heldNotes.empty()) {
                    arpCursor = -1.0; // stop stepping
                    state.currentStep = 0;
                }
            }
        }
    }

    std::fprintf(stderr, "[ArpExpander] Track %d block at beat %.2f: %zu notes -> %d arp events"
                 " (mode=%d step=%.3f gate=%.2f)\n",
                 trackId, static_cast<double>(blockPosTicks) / 960.0,
                 notes.size(), added,
                 arpDirection, stepBeats, arpGate);

    return result;
}
