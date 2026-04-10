#include "Arpeggiator.h"

#include <algorithm>

// ─── noteOn / noteOff ───────────────────────────────────────────────────────

void Arpeggiator::noteOn(int pitch, float velocity)
{
    storedVelocity_ = velocity;

    // Insert sorted (skip duplicates)
    auto it = std::lower_bound(heldNotes_.begin(), heldNotes_.end(), pitch);
    if (it != heldNotes_.end() && *it == pitch) return;
    heldNotes_.insert(it, pitch);

    // First note: reset sequencer so it starts immediately
    if (heldNotes_.size() == 1) {
        currentStep_   = 0;
        currentOctave_ = 0;
        goingUp_       = true;
        stepTimer_     = 0.0; // fire on next processSample
        gateTimer_     = 0.0;
        noteActive_    = false;
        lastArpPitch_  = -1;
    }
}

void Arpeggiator::noteOff(int pitch)
{
    auto it = std::lower_bound(heldNotes_.begin(), heldNotes_.end(), pitch);
    if (it != heldNotes_.end() && *it == pitch)
        heldNotes_.erase(it);

    if (heldNotes_.empty())
        reset();
}

void Arpeggiator::reset()
{
    heldNotes_.clear();
    currentStep_   = 0;
    currentOctave_ = 0;
    goingUp_       = true;
    stepTimer_     = 0.0;
    gateTimer_     = 0.0;
    noteActive_    = false;
    lastArpPitch_  = -1;
}

// ─── processSample ──────────────────────────────────────────────────────────

Arpeggiator::ArpEvent Arpeggiator::processSample(double sampleRate, double bpm)
{
    ArpEvent ev;
    if (heldNotes_.empty()) return ev;

    const double stepLen = stepDurationSamples(sampleRate, bpm);
    if (stepLen <= 0.0) return ev;

    // Gate-off: note has been playing long enough
    if (noteActive_ && gateTimer_ <= 0.0) {
        ev.noteOff     = true;
        ev.noteOffPitch = lastArpPitch_;
        noteActive_ = false;
    }

    // Step advance: time for the next note
    if (stepTimer_ <= 0.0) {
        // If a note is still active (gate >= 1.0), send note-off first
        if (noteActive_) {
            ev.noteOff     = true;
            ev.noteOffPitch = lastArpPitch_;
            noteActive_ = false;
        }

        int nextPitch = getNextNote();
        ev.noteOn   = true;
        ev.pitch    = nextPitch;
        ev.velocity = storedVelocity_;
        lastArpPitch_ = nextPitch;
        noteActive_   = true;

        stepTimer_ = stepLen;
        gateTimer_ = stepLen * static_cast<double>(gate);
    }

    stepTimer_ -= 1.0;
    if (noteActive_) gateTimer_ -= 1.0;

    return ev;
}

// ─── getNextNote ────────────────────────────────────────────────────────────
// Advances the step/octave counters and returns the next MIDI pitch.

int Arpeggiator::getNextNote()
{
    if (heldNotes_.empty()) return 60;

    const int n = static_cast<int>(heldNotes_.size());
    const int totalSteps = n * range; // total notes across all octaves

    // Clamp currentStep_ into valid range
    if (currentStep_ < 0) currentStep_ = 0;

    // Compute note index and octave from currentStep_
    int noteIdx  = currentStep_ % n;
    int octave   = currentStep_ / n;

    int basePitch;

    switch (direction) {
    case Direction::Up:
        basePitch = heldNotes_[noteIdx];
        break;

    case Direction::Down:
    {
        // Reverse: step 0 = highest octave highest note
        int revStep = (totalSteps - 1) - currentStep_;
        if (revStep < 0) revStep = 0;
        noteIdx = revStep % n;
        octave  = revStep / n;
        basePitch = heldNotes_[noteIdx];
        break;
    }

    case Direction::UpDown:
    {
        // Sequence length: up (totalSteps) + down (totalSteps - 2) to avoid
        // repeating top and bottom notes.
        int seqLen = totalSteps > 1 ? (totalSteps * 2 - 2) : 1;
        int pos = currentStep_ % seqLen;
        int linearStep;
        if (pos < totalSteps) {
            linearStep = pos; // ascending
        } else {
            linearStep = totalSteps * 2 - 2 - pos; // descending
        }
        noteIdx = linearStep % n;
        octave  = linearStep / n;
        basePitch = heldNotes_[noteIdx];
        break;
    }

    case Direction::UpDownSticky:
    {
        // Sequence length: up (totalSteps) + down (totalSteps) — top and
        // bottom notes repeat.
        int seqLen = totalSteps > 1 ? (totalSteps * 2) : 1;
        int pos = currentStep_ % seqLen;
        int linearStep;
        if (pos < totalSteps) {
            linearStep = pos; // ascending
        } else {
            linearStep = totalSteps * 2 - 1 - pos; // descending
        }
        noteIdx = linearStep % n;
        octave  = linearStep / n;
        basePitch = heldNotes_[noteIdx];
        break;
    }

    default:
        basePitch = heldNotes_[0];
        break;
    }

    // Advance step for next call
    currentStep_++;

    // Wrap based on direction
    switch (direction) {
    case Direction::Up:
    case Direction::Down:
        if (currentStep_ >= totalSteps)
            currentStep_ = 0;
        break;
    case Direction::UpDown:
    {
        int seqLen = totalSteps > 1 ? (totalSteps * 2 - 2) : 1;
        if (currentStep_ >= seqLen) currentStep_ = 0;
        break;
    }
    case Direction::UpDownSticky:
    {
        int seqLen = totalSteps > 1 ? (totalSteps * 2) : 1;
        if (currentStep_ >= seqLen) currentStep_ = 0;
        break;
    }
    }

    const int finalPitch = basePitch + octave * 12;
    return finalPitch;
}

// ─── stepDurationSamples ────────────────────────────────────────────────────

double Arpeggiator::stepDurationSamples(double sampleRate, double bpm) const
{
    if (tempoSync) {
        // division: 4=quarter, 8=eighth, 16=16th, 32=32nd
        // One beat (quarter note) = 60/bpm seconds
        // Step = (4/division) beats
        if (bpm <= 0.0) return sampleRate * 0.5; // fallback 120 BPM eighth
        const double beatsPerStep = 4.0 / static_cast<double>(division);
        return (60.0 / bpm) * beatsPerStep * sampleRate;
    }
    // Free time mode
    return static_cast<double>(freeTimeMs) * 0.001 * sampleRate;
}
