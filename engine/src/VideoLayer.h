#pragma once

// VideoLayer — layout/blend properties for a single compositor layer.
// Defined here (no GL includes) so SyncManager and other CPU-side code
// can reference it without pulling in GLFW/GLEW headers.

struct VideoLayer {
    int   sourceTextureSet = 0; // index into compositor's texture-set array
    float x       = 0.0f;      // horizontal centre, normalised (-1 .. 1)
    float y       = 0.0f;      // vertical centre,   normalised (-1 .. 1)
    float width   = 1.0f;      // normalised width
    float height  = 1.0f;      // normalised height
    float opacity = 1.0f;      // 0 = transparent, 1 = opaque
    int   zOrder  = 0;         // higher = drawn on top
    bool  visible = true;
};
