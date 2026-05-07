#pragma once

// ClipCompanionFxSnapshot — plain per-frame clip-local visual modulation data.
//
// Compositor-agnostic POD: no D3D11, no OpenGL, no FrameCollector / VideoCompositor
// coupling, no FFmpeg, no bridge dependencies. Lives in model/ so both the export
// pipeline (FrameCollector → GridCompositor) and the realtime preview path
// (SyncManager → VideoCompositor) can fill the same struct from the same builder
// and stay in lockstep.

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
