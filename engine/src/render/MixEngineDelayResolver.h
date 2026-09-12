#pragma once

/**
 * MixEngineDelayResolver — the one adapter between the render path and the
 * audio graph for Visual Echo.
 *
 * Both the live preview video tick and the offline export renderer install one
 * of these on their FrameCollector, pointing at the SAME MixEngine the audio is
 * coming out of. That is what makes export echo output identical to preview:
 * neither path has its own copy of the delay-time math, and neither can drift
 * from the other, because there is exactly one source of the number.
 */

#include "render/VisualEchoTypes.h"
#include "audio/MixEngine.h"

namespace xleth::echo {

class MixEngineDelayResolver final : public IDelaySnapshotResolver {
public:
    explicit MixEngineDelayResolver(const MixEngine& mixer) : mixer_(&mixer) {}

    DelaySnapshot resolve(int trackId, int nodeId) const override {
        return mixer_->resolveDelaySnapshot(trackId, nodeId);
    }

private:
    const MixEngine* mixer_;   // not owned; outlives the collector in both callers
};

} // namespace xleth::echo
