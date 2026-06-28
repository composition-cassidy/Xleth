#include "project/ProxyManager.h"

#include "ProxyTranscoder.h"

#include <filesystem>
#include <iostream>
#include <utility>

namespace fs = std::filesystem;

// ─── ProxyManager::Job ───────────────────────────────────────────────────────
// A single transcode running on a juce::ThreadPool worker. Blocks in
// ProxyTranscoder::transcodeRange() (in-process libav decode/encode — no
// subprocess), then publishes the Result back to the owning ProxyManager.
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

// ─── ProxyManager::PosterJob ─────────────────────────────────────────────────
// A single poster extraction running on a juce::ThreadPool worker. Blocks in
// ProxyTranscoder::extractPoster() (in-process libav single-frame decode +
// MJPEG encode — no subprocess), then publishes the PosterResult back to the
// owning ProxyManager.
class ProxyManager::PosterJob : public juce::ThreadPoolJob
{
public:
    PosterJob(PosterRequest req, ProxyManager* owner)
        : juce::ThreadPoolJob("PosterExtract")
        , req_(std::move(req))
        , owner_(owner)
    {}

    JobStatus runJob() override
    {
        ProxyManager::PosterResult r;
        r.sourceId    = req_.sourceId;
        r.outputPath  = req_.outputPath;
        r.frameBucket = req_.frameBucket;

        std::cout << "[Poster] source=" << req_.sourceId
                  << (req_.frameBucket >= 0
                          ? (" thumbnail bucket=" + std::to_string(req_.frameBucket))
                          : std::string(" base poster"))
                  << " extraction started -> " << req_.outputPath << "\n";

        if (shouldExit())
        {
            owner_->publishPosterResult(std::move(r));   // ok=false default
            return jobHasFinished;
        }

        r.ok = ProxyTranscoder::extractPoster(req_.inputPath, req_.outputPath,
                                              req_.atTimeSec);
        owner_->publishPosterResult(std::move(r));
        return jobHasFinished;
    }

private:
    PosterRequest req_;
    ProxyManager* owner_;
};

// ─── ProxyManager::SourcePreviewJob ──────────────────────────────────────────
// A single whole-source preview-proxy transcode running on a juce::ThreadPool
// worker. Blocks in ProxyTranscoder::transcodeSourcePreview() (in-process libav
// decode/encode — no subprocess), publishing progress as it goes, then publishes
// the SourcePreviewResult back to the owning ProxyManager.
class ProxyManager::SourcePreviewJob : public juce::ThreadPoolJob
{
public:
    SourcePreviewJob(SourcePreviewRequest req, ProxyManager* owner)
        : juce::ThreadPoolJob("SourcePreviewProxy")
        , req_(std::move(req))
        , owner_(owner)
    {}

    JobStatus runJob() override
    {
        ProxyManager::SourcePreviewResult r;
        r.sourceId    = req_.sourceId;
        r.outputPath  = req_.outputPath;
        r.proxyHeight = req_.proxyHeight;

        std::cout << "[SourceProxy] source=" << req_.sourceId
                  << " whole-source preview proxy started ("
                  << req_.proxyHeight << "p) -> " << req_.outputPath << "\n";

        if (shouldExit())
        {
            owner_->publishSourcePreviewResult(std::move(r));   // ok=false default
            return jobHasFinished;
        }

        const int     sourceId = req_.sourceId;
        ProxyManager* owner    = owner_;
        r.ok = ProxyTranscoder::transcodeSourcePreview(
            req_.inputPath, req_.outputPath, req_.proxyHeight,
            /*highBitDepth=*/false,   // preview is always 8-bit
            [owner, sourceId](float p) {
                owner->publishSourcePreviewProgress(sourceId, p);
            });
        owner_->publishSourcePreviewResult(std::move(r));
        return jobHasFinished;
    }

private:
    SourcePreviewRequest req_;
    ProxyManager*        owner_;
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
        // Count the region in the session total; publishResult bumps completed_
        // to match, so pending stays balanced (opening an already-proxied
        // project reports pending==0 throughout).
        {
            std::lock_guard<std::mutex> lk(resultMtx_);
            ++total_;
        }
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
            // previous job completes and is drained. Already counted in total_
            // by the original enqueue, so we leave the counters untouched here.
            return;
        }
        inFlight_.insert(req.regionId);
        // A real transcode is being scheduled — count it. publishResult bumps
        // completed_ when the worker finishes (or on early-exit abort).
        ++total_;
    }

    // addJob with takeOwnership=true means the pool deletes the job after run.
    pool_->addJob(new Job(req, this), /*takeOwnership=*/true);
}

void ProxyManager::publishResult(Result&& r)
{
    std::lock_guard<std::mutex> lk(resultMtx_);
    inFlight_.erase(r.regionId);
    ++completed_;   // matches the total_ bump from enqueue (real or on-disk)
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

ProxyManager::ProxyStatus ProxyManager::getStatus() const
{
    ProxyStatus s;
    std::lock_guard<std::mutex> lk(resultMtx_);
    s.inFlight  = static_cast<int>(inFlight_.size());
    s.completed = completed_;
    s.total     = total_;
    s.pending   = total_ - completed_;   // queued + in-flight, never negative
    return s;
}

// ─── Poster jobs ──────────────────────────────────────────────────────────────

void ProxyManager::enqueuePoster(const PosterRequest& req)
{
    if (shutdown_ || !pool_) return;

    // Idempotent restart: poster already on disk (this or a prior session) →
    // short-circuit to a synthetic success so the caller marks posterReady.
    if (!req.outputPath.empty() && fs::exists(req.outputPath))
    {
        PosterResult r;
        r.sourceId    = req.sourceId;
        r.ok          = true;
        r.outputPath  = req.outputPath;
        r.frameBucket = req.frameBucket;
        std::cout << "[Poster] source=" << req.sourceId
                  << (req.frameBucket >= 0
                          ? (" thumbnail bucket=" + std::to_string(req.frameBucket))
                          : std::string(" base poster"))
                  << " already on disk, skipping extraction ("
                  << req.outputPath << ")\n";
        publishPosterResult(std::move(r));
        return;
    }

    // Dedup on (sourceId, frameBucket) — NOT sourceId alone — so a source with
    // many per-offset thumbnails can have several in flight; otherwise only one
    // bucket per source would ever generate.
    const long long key = posterKey(req.sourceId, req.frameBucket);
    {
        std::lock_guard<std::mutex> lk(resultMtx_);
        if (inFlightPosters_.count(key) > 0)
            return;   // extraction already running for this (source, bucket)
        inFlightPosters_.insert(key);
    }

    pool_->addJob(new PosterJob(req, this), /*takeOwnership=*/true);
}

void ProxyManager::publishPosterResult(PosterResult&& r)
{
    std::lock_guard<std::mutex> lk(resultMtx_);
    inFlightPosters_.erase(posterKey(r.sourceId, r.frameBucket));
    finishedPosters_.push_back(std::move(r));
}

std::vector<ProxyManager::PosterResult> ProxyManager::drainPosterResults()
{
    std::vector<PosterResult> out;
    {
        std::lock_guard<std::mutex> lk(resultMtx_);
        out.swap(finishedPosters_);
    }
    return out;
}

// ─── Whole-source preview-proxy jobs ───────────────────────────────────────────

void ProxyManager::enqueueSourcePreview(const SourcePreviewRequest& req)
{
    if (shutdown_ || !pool_) return;

    // Idempotent restart: proxy already on disk (this or a prior session) →
    // short-circuit to a synthetic success so the caller engages it without a
    // rebuild.
    if (!req.outputPath.empty() && fs::exists(req.outputPath))
    {
        SourcePreviewResult r;
        r.sourceId    = req.sourceId;
        r.ok          = true;
        r.outputPath  = req.outputPath;
        r.proxyHeight = req.proxyHeight;
        std::cout << "[SourceProxy] source=" << req.sourceId
                  << " preview proxy already on disk, skipping transcode ("
                  << req.outputPath << ")\n";
        publishSourcePreviewResult(std::move(r));
        return;
    }

    {
        std::lock_guard<std::mutex> lk(resultMtx_);
        if (inFlightSourcePreview_.count(req.sourceId) > 0)
            return;   // a preview-proxy transcode is already running for this source
        inFlightSourcePreview_.insert(req.sourceId);
        sourcePreviewProgress_[req.sourceId] = 0.0f;
    }

    pool_->addJob(new SourcePreviewJob(req, this), /*takeOwnership=*/true);
}

void ProxyManager::publishSourcePreviewProgress(int sourceId, float progress)
{
    std::lock_guard<std::mutex> lk(resultMtx_);
    sourcePreviewProgress_[sourceId] = progress;
}

void ProxyManager::publishSourcePreviewResult(SourcePreviewResult&& r)
{
    std::lock_guard<std::mutex> lk(resultMtx_);
    inFlightSourcePreview_.erase(r.sourceId);
    sourcePreviewProgress_.erase(r.sourceId);
    finishedSourcePreview_.push_back(std::move(r));
}

std::vector<ProxyManager::SourcePreviewResult> ProxyManager::drainSourcePreviewResults()
{
    std::vector<SourcePreviewResult> out;
    {
        std::lock_guard<std::mutex> lk(resultMtx_);
        out.swap(finishedSourcePreview_);
    }
    return out;
}

ProxyManager::SourcePreviewStatus ProxyManager::sourcePreviewStatus(int sourceId)
{
    SourcePreviewStatus s;
    std::lock_guard<std::mutex> lk(resultMtx_);
    s.building = inFlightSourcePreview_.count(sourceId) > 0;
    auto it = sourcePreviewProgress_.find(sourceId);
    if (it != sourcePreviewProgress_.end()) s.progress = it->second;
    return s;
}

void ProxyManager::shutdown()
{
    if (shutdown_) return;
    shutdown_ = true;

    if (pool_)
    {
        // Interrupt running jobs and wait up to 10 s for in-flight in-process
        // transcodes to finish. ProxyTranscoder's libav decode/encode loop
        // cannot be preempted mid-frame, so in-flight jobs must be allowed to
        // complete naturally.
        pool_->removeAllJobs(true, 10000);
        pool_.reset();
    }

    std::lock_guard<std::mutex> lk(resultMtx_);
    finished_.clear();
    inFlight_.clear();
    total_     = 0;   // a shut-down manager reports an all-zero status snapshot
    completed_ = 0;
    finishedPosters_.clear();
    inFlightPosters_.clear();
    finishedSourcePreview_.clear();
    inFlightSourcePreview_.clear();
    sourcePreviewProgress_.clear();

    std::cout << "[Proxy] ProxyManager shut down\n";
}
