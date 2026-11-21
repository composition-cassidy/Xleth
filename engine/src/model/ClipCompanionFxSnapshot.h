#pragma once

// ClipCompanionFxSnapshot — plain per-frame clip-local visual modulation data.
//
// Compositor-agnostic POD: no D3D11, no FrameCollector coupling, no FFmpeg, no
// bridge dependencies. Lives in model/ so it stays a pure data contract between
// the builder and whatever consumes it. Preview and export both run through
// FrameCollector → GridCompositor, so there is one filler and one kernel; the
// second (OpenGL VideoCompositor) path was retired — see Issue 10 in
// VIDEO_PREVIEW_AUDIT.txt.

struct ClipCompanionFxSnapshot {
    bool vibratoSwirlEnabled = false;
    bool scratchWaveEnabled  = false;

    float vibratoLfo     = 0.0f;
    float vibratoPhase01 = 0.0f;
    float vibratoCents   = 0.0f;

    float scratchRateMultiplier = 1.0f;
    float scratchPhase01        = 0.0f;
    float scratchIntensity01    = 0.0f;

    float swirlAmount  = 0.0f;
    float swirlRadius  = 0.45f;
    float swirlCenterX = 0.5f;
    float swirlCenterY = 0.5f;

    float waveAmount             = 0.0f;
    float waveFrequency          = 8.0f;
    float smearAmount            = 0.0f;
    bool  reverseWaveWithScratch = true;
};
