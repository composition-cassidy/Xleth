#include "project/ProxyManager.h"

#include "ProxyTranscoder.h"

#include <algorithm>
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
    Job(Request req, ProxyManager* owner, int epoch)
        : juce::ThreadPoolJob("ProxyTranscode")
        , req_(std::move(req))
        , owner_(owner)
        , epoch_(epoch)
    {}

    JobStatus runJob() override
    {
        ProxyManager::Result r;
        r.regionId   = req_.regionId;
        r.outputPath = req_.outputPath;
        r.startTime  = req_.startTime;
        r.endTime    = req_.endTime;
        r.migration  = req_.migration;

        std::cout << "[Proxy] region=" << req_.regionId
                  << " transcode started ["
                  << req_.startTime << ", " << req_.endTime << ") "
                  << req_.targetW << "x" << req_.targetH << "\n";

        // Respect juce-requested early exit — pool_->removeAllJobs(true, ...)
        // (cancelAll / shutdown) sets shouldExit(). The transcode polls it once
        // per frame through the cancel predicate, so a running job returns
        // promptly and discards its partial .tmp.
        if (shouldExit())
        {
            owner_->publishResult(std::move(r), epoch_);   // ok=false default
            return jobHasFinished;
        }

        bool ok = ProxyTranscoder::transcodeRange(
            req_.inputPath, req_.outputPath,
            req_.startTime, req_.endTime,
            req_.targetW,   req_.targetH,
            /*progressCallback=*/nullptr,
            req_.codec,
            [this] { return shouldExit(); });

        r.ok = ok;
        owner_->publishResult(std::move(r), epoch_);
        return jobHasFinished;
    }

private:
    Request       req_;
    ProxyManager* owner_;
    int           epoch_;
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
    SourcePreviewJob(SourcePreviewRequest req, ProxyManager* owner, int epoch)
        : juce::ThreadPoolJob("SourcePreviewProxy")
        , req_(std::move(req))
        , owner_(owner)
        , epoch_(epoch)
    {}

    JobStatus runJob() override
    {
        ProxyManager::SourcePreviewResult r;
        r.sourceId    = req_.sourceId;
        r.outputPath  = req_.outputPath;
        r.proxyHeight = req_.proxyHeight;
        r.migration   = req_.migration;

        std::cout << "[SourceProxy] source=" << req_.sourceId
                  << (req_.migration ? " codec MIGRATION"
                                     : req_.rebuild ? " whole-source preview proxy REBUILD"
                                                    : " whole-source preview proxy")
                  << " started (" << req_.proxyHeight << "p, "
                  << ProxyTranscoder::codecTag(req_.codec) << ") -> "
                  << req_.outputPath << "\n";

        if (shouldExit())
        {
            owner_->publishSourcePreviewResult(std::move(r), epoch_);   // ok=false default
            return jobHasFinished;
        }

        const int     sourceId = req_.sourceId;
        const int     epoch    = epoch_;
        ProxyManager* owner    = owner_;
        r.ok = ProxyTranscoder::transcodeSourcePreview(
            req_.inputPath, req_.outputPath, req_.proxyHeight,
            /*highBitDepth=*/false,   // preview is always 8-bit
            [owner, sourceId, epoch](float p) {
                owner->publishSourcePreviewProgress(sourceId, p, epoch);
            },
            req_.codec,
            [this] { return shouldExit(); });
        owner_->publishSourcePreviewResult(std::move(r), epoch_);
        return jobHasFinished;
    }

private:
    SourcePreviewRequest req_;
    ProxyManager*        owner_;
    int                  epoch_;
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
    // the caller registers the region decoder. `force` opts out: the region's
    // INPUT changed (video swap/revert), so an existing file at outputPath is
    // the PREVIOUS video's pixels, not a reusable result.
    if (!req.force && !req.outputPath.empty() && fs::exists(req.outputPath))
    {
        Result r;
        r.regionId   = req.regionId;
        r.ok         = true;
        r.outputPath = req.outputPath;
        r.startTime  = req.startTime;
        r.endTime    = req.endTime;
        r.migration  = req.migration;
        std::cout << "[Proxy] region=" << req.regionId
                  << " already on disk, skipping transcode ("
                  << req.outputPath << ")\n";
        // Count the region in the session total; publishResult bumps completed_
        // to match, so pending stays balanced (opening an already-proxied
        // project reports pending==0 throughout).
        int epoch = 0;
        {
            std::lock_guard<std::mutex> lk(resultMtx_);
            ++total_;
            if (req.migration) ++migrationTotal_;
            if (req.rebuild && rebuildingRegions_.insert(req.regionId).second) ++rebuildTotal_;
            epoch = epoch_;
        }
        publishResult(std::move(r), epoch);
        return;
    }

    int epoch = 0;
    {
        std::lock_guard<std::mutex> lk(resultMtx_);
        // Tag the region as part of the rebuild batch BEFORE the dedup below: when
        // a job for it is already running (enqueued unflagged by the video
        // thread's lazy path), that job's result then completes the tag.
        if (req.rebuild && rebuildingRegions_.insert(req.regionId).second) ++rebuildTotal_;
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
        if (req.migration) ++migrationTotal_;
        epoch = epoch_;
    }

    // addJob with takeOwnership=true means the pool deletes the job after run.
    pool_->addJob(new Job(req, this, epoch), /*takeOwnership=*/true);
}

void ProxyManager::publishResult(Result&& r, int epoch)
{
    std::lock_guard<std::mutex> lk(resultMtx_);
    if (epoch != epoch_) return;   // scheduled before cancelAll(): stale project
    inFlight_.erase(r.regionId);
    ++completed_;   // matches the total_ bump from enqueue (real or on-disk)
    if (r.migration) {
        ++migrationCompleted_;
        if (!r.ok) ++migrationFailed_;
    }
    if (rebuildingRegions_.erase(r.regionId) > 0) {
        ++rebuildCompleted_;
        if (!r.ok) ++rebuildFailed_;
    }
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
        r.migration   = req.migration;
        std::cout << "[SourceProxy] source=" << req.sourceId
                  << " preview proxy already on disk, skipping transcode ("
                  << req.outputPath << ")\n";
        int epoch = 0;
        {
            std::lock_guard<std::mutex> lk(resultMtx_);
            if (req.migration) { ++migrationTotal_; migratingSources_.insert(req.sourceId); }
            if (req.rebuild && rebuildingSources_.insert(req.sourceId).second) ++rebuildTotal_;
            epoch = epoch_;
        }
        publishSourcePreviewResult(std::move(r), epoch);
        return;
    }

    int epoch = 0;
    {
        std::lock_guard<std::mutex> lk(resultMtx_);
        // Tag before the dedup (see enqueue()): a running unflagged job for this
        // source still completes the tag.
        if (req.rebuild && rebuildingSources_.insert(req.sourceId).second) ++rebuildTotal_;
        if (inFlightSourcePreview_.count(req.sourceId) > 0)
            return;   // a preview-proxy transcode is already running for this source
        inFlightSourcePreview_.insert(req.sourceId);
        sourcePreviewProgress_[req.sourceId] = 0.0f;
        if (req.migration) { ++migrationTotal_; migratingSources_.insert(req.sourceId); }
        epoch = epoch_;
    }

    pool_->addJob(new SourcePreviewJob(req, this, epoch), /*takeOwnership=*/true);
}

void ProxyManager::publishSourcePreviewProgress(int sourceId, float progress, int epoch)
{
    std::lock_guard<std::mutex> lk(resultMtx_);
    if (epoch != epoch_) return;
    sourcePreviewProgress_[sourceId] = progress;
}

void ProxyManager::publishSourcePreviewResult(SourcePreviewResult&& r, int epoch)
{
    std::lock_guard<std::mutex> lk(resultMtx_);
    if (epoch != epoch_) return;   // scheduled before cancelAll(): stale project
    inFlightSourcePreview_.erase(r.sourceId);
    sourcePreviewProgress_.erase(r.sourceId);
    if (r.migration) {
        migratingSources_.erase(r.sourceId);
        ++migrationCompleted_;
        if (!r.ok) ++migrationFailed_;
    }
    if (rebuildingSources_.erase(r.sourceId) > 0) {
        ++rebuildCompleted_;
        if (!r.ok) ++rebuildFailed_;
    }
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

ProxyManager::MigrationStatus ProxyManager::batchStatusLocked(
    int total, int completed, int failed,
    const std::unordered_set<int>& liveSources) const
{
    MigrationStatus m;
    m.total     = total;
    m.completed = completed;
    m.failed    = failed;
    if (m.total > 0) {
        double done = m.completed;
        for (int id : liveSources) {
            auto it = sourcePreviewProgress_.find(id);
            if (it != sourcePreviewProgress_.end()) done += it->second;
        }
        m.progress = static_cast<float>(std::min(1.0, done / m.total));
    }
    return m;
}

ProxyManager::MigrationStatus ProxyManager::getMigrationStatus() const
{
    std::lock_guard<std::mutex> lk(resultMtx_);
    return batchStatusLocked(migrationTotal_, migrationCompleted_, migrationFailed_,
                             migratingSources_);
}

ProxyManager::RebuildStatus ProxyManager::getRebuildStatus() const
{
    std::lock_guard<std::mutex> lk(resultMtx_);
    return batchStatusLocked(rebuildTotal_, rebuildCompleted_, rebuildFailed_,
                             rebuildingSources_);
}

bool ProxyManager::hasActiveJobs() const
{
    std::lock_guard<std::mutex> lk(resultMtx_);
    return !inFlight_.empty() || !inFlightPosters_.empty() || !inFlightSourcePreview_.empty();
}

void ProxyManager::cancelAll()
{
    if (shutdown_ || !pool_) return;

    // Bump the epoch FIRST so anything a job publishes from here on (its
    // cancelled ok=false result, a last progress tick) is dropped instead of
    // being drained into the next project.
    {
        std::lock_guard<std::mutex> lk(resultMtx_);
        ++epoch_;
    }

    // Removes queued jobs and signals running ones (shouldExit → the transcode's
    // per-frame cancel poll), then waits for them to return. With cancellation
    // that is one frame's decode+encode, not the rest of the source.
    if (!pool_->removeAllJobs(/*interruptRunningJobs=*/true, /*timeOutMs=*/10000))
        std::cerr << "[Proxy] cancelAll: a job did not stop within 10 s\n";

    std::lock_guard<std::mutex> lk(resultMtx_);
    finished_.clear();
    inFlight_.clear();
    total_     = 0;
    completed_ = 0;
    finishedPosters_.clear();
    inFlightPosters_.clear();
    finishedSourcePreview_.clear();
    inFlightSourcePreview_.clear();
    sourcePreviewProgress_.clear();
    migrationTotal_     = 0;
    migrationCompleted_ = 0;
    migrationFailed_    = 0;
    migratingSources_.clear();
    rebuildTotal_       = 0;
    rebuildCompleted_   = 0;
    rebuildFailed_      = 0;
    rebuildingRegions_.clear();
    rebuildingSources_.clear();

    std::cout << "[Proxy] cancelAll: pending proxy work abandoned (project change)\n";
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
    migrationTotal_     = 0;
    migrationCompleted_ = 0;
    migrationFailed_    = 0;
    migratingSources_.clear();
    rebuildTotal_       = 0;
    rebuildCompleted_   = 0;
    rebuildFailed_      = 0;
    rebuildingRegions_.clear();
    rebuildingSources_.clear();

    std::cout << "[Proxy] ProxyManager shut down\n";
}
