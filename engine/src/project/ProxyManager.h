#pragma once

#include <juce_core/juce_core.h>

#include <memory>
#include <mutex>
#include <string>
#include <unordered_set>
#include <vector>

// ─── ProxyManager ─────────────────────────────────────────────────────────────
// On-demand, quote-region-scoped proxy generation.
//
// A caller (XlethAddon bridge) enqueues a Request when a SampleRegion lands on
// a non-Chorus/non-Crash grid cell. ProxyManager runs at most kWorkers worker
// transcodes concurrently (juce::ThreadPool). Each worker calls
// ProxyTranscoder::transcodeRange() to produce a DNxHR LB .mxf covering
// exactly [startTime, endTime) of the source, scaled to targetW × targetH.
//
// On completion, the worker pushes a Result onto an internal queue. The
// caller drains the queue on the video thread (or any non-audio thread) via
// drainResults(), then installs the resulting proxy file path and opens a
// VideoDecoder outside any mutex.
//
// inFlight_ dedups concurrent enqueue attempts for the same regionId.
class ProxyManager {
public:
    struct Request {
        int         regionId   = 0;
        std::string inputPath;     // original source file
        std::string outputPath;    // target path (<proxiesDir>/<regionId>.mxf)
        double      startTime  = 0.0;
        double      endTime    = 0.0;
        int         targetW    = 0;
        int         targetH    = 0;
    };

    struct Result {
        int         regionId   = 0;
        bool        ok         = false;
        std::string outputPath;
        double      startTime  = 0.0;
        double      endTime    = 0.0;
    };

    // Max concurrent transcodes. Two keeps disk/CPU/RAM under control while
    // still masking seek latency for a typical drop-a-few-samples workflow.
    static constexpr int kWorkers = 2;

    ProxyManager();
    ~ProxyManager();

    // Enqueue a proxy transcode. No-op if:
    //   - A job for `req.regionId` is already in flight
    //   - `req.outputPath` already exists on disk (idempotent restart)
    // Safe to call from the main thread.
    void enqueue(const Request& req);

    // Swap out all finished Results produced since the last drain.
    // Safe to call from any non-audio thread (typically the video thread).
    // O(n) under a short-held mutex — does not touch the thread pool.
    std::vector<Result> drainResults();

    // Join all worker jobs and tear down the pool.
    // Idempotent — calling after shutdown is a no-op.
    void shutdown();

private:
    class Job;
    friend class Job;

    // Called by Job::runJob() on a worker thread once a transcode finishes.
    void publishResult(Result&& r);

    std::unique_ptr<juce::ThreadPool> pool_;
    bool                              shutdown_ = false;

    std::mutex                        resultMtx_;
    std::vector<Result>               finished_;      // guarded by resultMtx_
    std::unordered_set<int>           inFlight_;      // guarded by resultMtx_
};
