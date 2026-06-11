#pragma once

// ─── SidechainCapability ────────────────────────────────────────────────────
// Session-only description of whether an effect node can receive an external
// sidechain key on a second input bus. POD, no dependencies, so it can live on
// AudioGraph::GraphNode and be returned from GuardedPluginWrapper without
// pulling in JUCE headers.
//
// IMPORTANT: capability is RUNTIME-DISCOVERED and NEVER persisted as project
// truth. Plugins lie and change across hosts/versions, so it must be re-probed
// every instantiation. Only the stable effectInstanceId is persisted; the
// capability is recomputed on load. See docs/dev/vst-sidechain-architecture-audit.md.

namespace xleth
{
    struct SidechainCapability
    {
        // The node can expose a usable sidechain input bus (a stock effect that
        // overrides supportsExternalSidechain(), or a wrapped plugin whose probe
        // found an acceptable aux input layout). Stereo-only plugins are false.
        bool supported = false;

        // Detected sidechain bus channel count when enabled (usually 1 or 2).
        // 0 means no usable sidechain bus was found.
        int channels = 0;

        // The sidechain bus is currently active/enabled at runtime. Probing must
        // never leave the bus enabled by default; this only becomes true once a
        // route lazily enables it (VST-SC.3) or a test toggles it.
        bool enabled = false;
    };
}
