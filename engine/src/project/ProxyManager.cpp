#include "project/ProxyManager.h"

#include "ProxyTranscoder.h"

#include <filesystem>
#include <iostream>
#include <utility>

namespace fs = std::filesystem;

// ─── ProxyManager::Job ───────────────────────────────────────────────────────
// A single transcode running on a juce::ThreadPool worker. Blocks in
// ProxyTranscoder::transcodeRange() (which spawns an ffmpeg subprocess), then
// publishes the Result back to the owning ProxyManager.
class ProxyManager::Job : public juce::ThreadPoolJob
{
public:
    Job(Request req, ProxyManager* owner)
        : juce::ThreadPoolJob("ProxyTranscode")
        , req_(std::move(req))
        , owner_(owner)
    {}

    JobStatus runJob() override
    {
        ProxyManager::Result r;
        r.regionId   = req_.regionId;
        r.outputPath = req_.outputPath;
        r.startTime  = req_.startTime;
        r.endTime    = req_.endTime;

        std::cout << "[Proxy] region=" << req_.regionId
                  << " transcode started ["
                  << req_.startTime << ", " << req_.endTime << ") "
                  << req_.targetW << "x" << req_.targetH << "\n";

        // Respect juce-requested early exit — aborts started via
        // pool_->removeAllJobs(true, ...) call shouldExit() = true and cause
        // transcodeRange() to keep running; we cannot preempt ffmpeg mid-run.
        // The pool's interruptTimeout will block up to the timeout, then kill.
        if (shouldExit())
        {
            owner_->publishResult(std::move(r));   // ok=false default
            return jobHasFinished;
        }

        bool ok = ProxyTranscoder::transcodeRange(
            req_.inputPath, req_.outputPath,
            req_.startTime, req_.endTime,
            req_.targetW,   req_.targetH);

        r.ok = ok;
        owner_->publishResult(std::move(r));
        return jobHasFinished;
    }

private:
    Request       req_;
    ProxyManager* owner_;
};

// ─── ProxyManager ────────────────────────────────────────────────────────────

ProxyManager::ProxyManager()
    : pool_(std::make_unique<juce::ThreadPool>(kWorkers))
{
    std::cout << "[Proxy] ProxyManager started with " << kWorkers
              << " worker(s)\n";
}

ProxyManager::~ProxyManager()
{
    shutdown();
}

void ProxyManager::enqueue(const Request& req)
{
    if (shutdown_ || !pool_) return;

    // Idempotent restart: if the target file is already present, assume a
    // prior session produced it and short-circuit to a synthetic success so
    // the caller registers the region decoder.
    if (!req.outputPath.empty() && fs::exists(req.outputPath))
    {
        Result r;
        r.regionId   = req.regionId;
        r.ok         = true;
        r.outputPath = req.outputPath;
        r.startTime  = req.startTime;
        r.endTime    = req.endTime;
        std::cout << "[Proxy] region=" << req.regionId
                  << " already on disk, skipping transcode ("
                  << req.outputPath << ")\n";
        publishResult(std::move(r));
        return;
    }

    {
        std::lock_guard<std::mutex> lk(resultMtx_);
        if (inFlight_.count(req.regionId) > 0)
        {
            // Another transcode is already running for this regionId.
            // We intentionally drop the new request — callers who wanted a
            // fresh transcode after invalidation must first ensure the
            // previous job completes and is drained.
            return;
        }
        inFlight_.insert(req.regionId);
    }

    // addJob with takeOwnership=true means the pool deletes the job after run.
    pool_->addJob(new Job(req, this), /*takeOwnership=*/true);
}

void ProxyManager::publishResult(Result&& r)
{
    std::lock_guard<std::mutex> lk(resultMtx_);
    inFlight_.erase(r.regionId);
    finished_.push_back(std::move(r));
}

std::vector<ProxyManager::Result> ProxyManager::drainResults()
{
    std::vector<Result> out;
    {
        std::lock_guard<std::mutex> lk(resultMtx_);
        out.swap(finished_);
    }
    return out;
}

void ProxyManager::shutdown()
{
    if (shutdown_) return;
    shutdown_ = true;

    if (pool_)
    {
        // Interrupt running jobs and wait up to 10 s for ffmpeg subprocesses
        // to finish. ProxyTranscoder cannot be preempted mid-transcode, so
        // in-flight jobs must be allowed to complete naturally.
        pool_->removeAllJobs(true, 10000);
        pool_.reset();
    }

    std::lock_guard<std::mutex> lk(resultMtx_);
    finished_.clear();
    inFlight_.clear();

    std::cout << "[Proxy] ProxyManager shut down\n";
}
