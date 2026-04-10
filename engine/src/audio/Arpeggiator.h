#pragma once

#include <algorithm>
#include <vector>

// ─── Arpeggiator ────────────────────────────────────────────────────────────
// Standalone arpeggiator that sits between note input and voice triggering.
// No JUCE dependency. Audio-thread safe: no alloc after noteOn populates the
// heldNotes vector (bounded by 128 MIDI notes max).

class Arpeggiator
{
public:
    enum class Direction { Up, Down, UpDown, UpDownSticky };

    struct ArpEvent
    {
        bool  noteOn      = false;
        bool  noteOff     = false;
        int   pitch       = 60;       // noteOn pitch
        int   noteOffPitch = -1;      // separate pitch for noteOff (may differ from noteOn)
        float velocity    = 1.0f;
    };

    // ── Configuration (main-thread setters) ─────────────────────────────────
    bool      enabled    = false;
    bool      tempoSync  = true;
    int       division   = 8;        // 4=quarter, 8=eighth, 16=16th, 32=32nd
    float     freeTimeMs = 125.0f;   // step time when tempoSync=false
    float     gate       = 0.8f;     // 0.0-1.0, portion of step note plays
    int       range      = 1;        // octave range (1=input only, 2=+1 oct, etc.)
    Direction direction  = Direction::Up;

    // ── Audio-thread API ────────────────────────────────────────────────────
    void noteOn(int pitch, float velocity);
    void noteOff(int pitch);
    void reset();

    // ── Queries (audio-thread safe) ─────────────────────────────────────────
    int  getActivePitch()    const { return noteActive_ ? lastArpPitch_ : -1; }
    bool hasHeldNotes()      const { return !heldNotes_.empty(); }
    bool isNoteActive()      const { return noteActive_; }
    int  getLastArpPitch()   const { return lastArpPitch_; }

    // Call once per audio sample. Returns an event (may be empty).
    ArpEvent processSample(double sampleRate, double bpm);

private:
    // Held-note tracking (sorted ascending)
    std::vector<int> heldNotes_;
    float storedVelocity_ = 1.0f;

    // Sequencer state
    int    currentStep_    = 0;   // index into the expanded note sequence
    int    currentOctave_  = 0;   // current octave offset (0..range-1)
    bool   goingUp_        = true;
    double stepTimer_      = 0.0; // samples remaining until next step
    double gateTimer_      = 0.0; // samples remaining until note-off
    bool   noteActive_     = false;
    int    lastArpPitch_   = -1;  // pitch of the currently playing arp note

    int  getNextNote();                                // advances step, returns MIDI pitch
    double stepDurationSamples(double sampleRate, double bpm) const;
};
