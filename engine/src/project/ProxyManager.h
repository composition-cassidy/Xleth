#pragma once

#include <juce_core/juce_core.h>

#include "ProxyTranscoder.h"   // ProxyCodec

#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>

// ─── ProxyManager ─────────────────────────────────────────────────────────────
// On-demand, quote-region-scoped proxy generation.
//
// A caller (XlethAddon bridge) enqueues a Request when a SampleRegion lands on
// a non-Chorus/non-Crash grid cell. ProxyManager runs at most kWorkers worker
// transcodes concurrently (juce::ThreadPool). Each worker calls
// ProxyTranscoder::transcodeRange() to produce a proxy (H.264 <id>.h264.mov or
// legacy intra <id>.mxf, per Request::codec) covering exactly
// [startTime, endTime) of the source, scaled to targetW × targetH.
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
        std::string outputPath;    // ProxyTranscoder::getRegionProxyPath(dir, id, codec)
        double      startTime  = 0.0;
        double      endTime    = 0.0;
        int         targetW    = 0;
        int         targetH    = 0;
        ProxyCodec  codec      = ProxyCodec::Intra;
        // Skip the "output already on disk → synthetic success" short-circuit.
        // Set by callers re-transcoding a region whose INPUT changed (a video
        // swap/revert), where an existing file at outputPath holds the old
        // video's pixels rather than a usable result from a prior session.
        bool        force      = false;
        // On-open migration of an existing intra proxy to H.264. The region keeps
        // its current proxy while this runs; a FAILED migration must leave that
        // proxy engaged rather than drop the region to live decode. Counted in
        // getMigrationStatus().
        bool        migration  = false;
        // The file is being (re)built because it was MISSING when the project was
        // opened — purged earlier, never generated, or deleted while the app was
        // closed. Counted in getRebuildStatus() so the UI can show progress.
        // The tag belongs to the REGION, not to this request: if a job for the
        // region is already running (the video thread's lazy path can enqueue one
        // a moment before the open pass does) the region is still counted, and the
        // running job's result completes it. See rebuildingRegions_.
        bool        rebuild    = false;
    };

    struct Result {
        int         regionId   = 0;
        bool        ok         = false;
        std::string outputPath;
        double      startTime  = 0.0;
        double      endTime    = 0.0;
        bool        migration  = false;   // echoed from the request
    };

    // ── Poster (single representative frame) jobs ────────────────────────────
    // Source-keyed (NOT region-keyed) — one poster JPEG per SourceMedia, reused
    // by every cell that references the source. Rides the same worker pool as
    // region proxies so a slow ffmpeg poster extraction never blocks the audio
    // or video thread. Used by the lazy self-heal path: when poster preview
    // mode encounters a source whose poster was never generated (e.g. a project
    // imported before poster support existed), the video thread enqueues one
    // here and installs the result on a later drain.
    struct PosterRequest {
        int         sourceId   = 0;
        std::string inputPath;     // original source file
        std::string outputPath;    // <proxiesDir>/<stem>.xlposter.jpg (or .t<bucket>.)
        // Per-offset thumbnail support: atTimeSec<0 → base poster (10% heuristic);
        // atTimeSec>=0 → thumbnail decoded at that source time. frameBucket is the
        // coarse bucket key echoed back so the drain installs into the right slot
        // (-1 = base poster).
        double      atTimeSec  = -1.0;
        int         frameBucket = -1;
    };

    struct PosterResult {
        int         sourceId   = 0;
        bool        ok         = false;
        std::string outputPath;
        int         frameBucket = -1;   // echoed from the request
    };

    // ── Whole-source preview proxy jobs ──────────────────────────────────────
    // Source-keyed (one whole-source all-intra preview proxy per source). This is
    // the single artifact ALL preview decode reads from (grid + fullscreen). Rides
    // the same worker pool as posters/region proxies so the long whole-source
    // transcode never blocks the audio or video thread. Progress is published
    // while building so the UI can show an indicator; preview falls back to the
    // poster/original until the proxy is ready.
    struct SourcePreviewRequest {
        int         sourceId    = 0;
        std::string inputPath;     // original source file
        std::string outputPath;    // getSourcePreviewProxyPath(src, dir, h, false, codec)
        int         proxyHeight  = 720;
        ProxyCodec  codec        = ProxyCodec::Intra;
        // On-open migration: re-encode an existing intra proxy (still engaged
        // for preview meanwhile) to H.264. See Request::migration.
        bool        migration    = false;
        // Missing-on-open rebuild — see Request::rebuild.
        bool        rebuild      = false;
    };

    struct SourcePreviewResult {
        int         sourceId    = 0;
        bool        ok          = false;
        std::string outputPath;
        int         proxyHeight = 0;       // echoed from the request
        bool        migration   = false;   // echoed from the request
    };

    // ── Codec migration progress (whole-session aggregate) ────────────────────
    // On-open re-encodes of legacy intra proxies to H.264 (region + whole-source
    // jobs flagged `migration`). For the UI's non-blocking progress badge.
    //   total      — migration jobs scheduled this session
    //   completed  — migration jobs that published a result (ok or failed)
    //   failed     — of those, how many failed (the old proxy stays in use)
    //   progress   — 0..1 over the whole batch: finished jobs count 1, the
    //                in-flight whole-source job(s) count their live progress
    struct MigrationStatus {
        int   total     = 0;
        int   completed = 0;
        int   failed    = 0;
        float progress  = 0.0f;
        bool  active() const { return completed < total; }
    };

    // ── Missing-file rebuild progress (whole-session aggregate) ───────────────
    // On-open rebuilds of proxies that were missing (jobs flagged `rebuild`).
    // Same shape and semantics as MigrationStatus: `progress` blends finished jobs
    // with the live progress of in-flight whole-source jobs. Drives the video
    // panel's "Rebuilding previews" badge.
    using RebuildStatus = MigrationStatus;

    // Live build state for one source's preview proxy (status/progress polling).
    struct SourcePreviewStatus {
        bool  building = false;   // a job is currently in flight for this source
        float progress = 0.0f;    // 0..1, last reported transcode progress
    };

    // ── Region-proxy build status (whole-session aggregate) ───────────────────
    // A snapshot of region-proxy transcode progress for the current session,
    // used by the UI to show a "building previews…" indicator and by callers
    // that want to wait until pending==0 before the first playback (so preview
    // is already smooth on play #1 instead of choppy until the proxies warm up).
    //   total     — region transcodes scheduled this session (monotonic)
    //   completed — region transcodes that have published a result (monotonic)
    //   inFlight  — transcodes currently running on the worker pool
    //   pending   — total - completed (queued + in-flight, i.e. not yet done)
    struct ProxyStatus {
        int pending   = 0;
        int inFlight  = 0;
        int completed = 0;
        int total     = 0;
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

    // Thread-safe snapshot of region-proxy build progress for this session.
    // Safe to call from any non-audio thread (e.g. the status reader). Guarded
    // by resultMtx_, so it never blocks the worker pool for longer than a couple
    // of integer reads.
    ProxyStatus getStatus() const;

    // Enqueue a single-frame poster extraction. No-op if:
    //   - A poster job for `req.sourceId` is already in flight
    //   - `req.outputPath` already exists on disk (synthetic success enqueued)
    // Safe to call from the video thread.
    void enqueuePoster(const PosterRequest& req);

    // Swap out all finished poster Results produced since the last drain.
    std::vector<PosterResult> drainPosterResults();

    // Enqueue a whole-source preview-proxy transcode. No-op if:
    //   - A preview-proxy job for `req.sourceId` is already in flight
    //   - `req.outputPath` already exists on disk (synthetic success enqueued)
    // Safe to call from the video thread.
    void enqueueSourcePreview(const SourcePreviewRequest& req);

    // Swap out all finished preview-proxy Results produced since the last drain.
    std::vector<SourcePreviewResult> drainSourcePreviewResults();

    // Current build state (building flag + 0..1 progress) for one source's
    // preview proxy. Safe to call from any non-audio thread (e.g. the status
    // reader). Returns {false, 0} when nothing is in flight for the source.
    SourcePreviewStatus sourcePreviewStatus(int sourceId);

    // Snapshot of this session's codec-migration batch (see MigrationStatus).
    MigrationStatus getMigrationStatus() const;

    // Snapshot of this session's missing-file rebuild batch (see RebuildStatus).
    RebuildStatus getRebuildStatus() const;

    // True while any region / poster / source-preview job is queued or running.
    // A running job owns a <target>.tmp, so "Clean up project" must not treat
    // .tmp files as leftovers while this is true.
    bool hasActiveJobs() const;

    // Abandon every queued and running job and forget all results/counters,
    // keeping this ProxyManager (and its pool) alive for the next project.
    // Running transcodes observe their cancel flag within one frame, delete
    // their partial .tmp and return, so this does not wait out a multi-minute
    // encode. Called on project load so a job started for the PREVIOUS project
    // can never publish a result keyed by an id the new project reuses. Keeps
    // object identity (unlike shutdown()+reset) because the video thread drains
    // through the same g_proxyManager pointer without a lock.
    void cancelAll();

    // Join all worker jobs and tear down the pool.
    // Idempotent — calling after shutdown is a no-op.
    void shutdown();

private:
    class Job;
    class PosterJob;
    class SourcePreviewJob;
    friend class Job;
    friend class PosterJob;
    friend class SourcePreviewJob;

    // Called by Job::runJob() on a worker thread once a transcode finishes.
    // `epoch` is the epoch_ the job was scheduled in; a mismatch (cancelAll ran
    // since) drops the result.
    void publishResult(Result&& r, int epoch);
    // Called by PosterJob::runJob() on a worker thread once extraction finishes.
    void publishPosterResult(PosterResult&& r);
    // Called by SourcePreviewJob on a worker thread (progress + completion).
    void publishSourcePreviewProgress(int sourceId, float progress, int epoch);
    void publishSourcePreviewResult(SourcePreviewResult&& r, int epoch);

    std::unique_ptr<juce::ThreadPool> pool_;
    bool                              shutdown_ = false;

    // mutable so the read-only getStatus() const can take the lock for its
    // snapshot. All other state below is also guarded by this one mutex.
    mutable std::mutex                resultMtx_;
    std::vector<Result>               finished_;      // guarded by resultMtx_
    std::unordered_set<int>           inFlight_;      // guarded by resultMtx_

    // Region-proxy session counters (guarded by resultMtx_). total_ is bumped
    // when a region transcode is scheduled (real job) or short-circuited as an
    // already-on-disk synthetic success; completed_ is bumped in publishResult.
    // Both are monotonic for the session, so pending = total_ - completed_ is
    // never negative. In-flight dedup drops bump neither (the region was already
    // counted). See enqueue()/publishResult() in ProxyManager.cpp.
    int                               total_     = 0; // guarded by resultMtx_
    int                               completed_ = 0; // guarded by resultMtx_

    // Poster jobs share pool_ but keep their own result queue + in-flight set
    // so source-keyed poster ids never collide with region-keyed proxy ids.
    // Keyed on (sourceId, frameBucket) via posterKey() so per-offset thumbnails
    // of the same source don't dedup against each other.
    std::vector<PosterResult>         finishedPosters_;  // guarded by resultMtx_
    std::unordered_set<long long>     inFlightPosters_;  // guarded by resultMtx_

    // Whole-source preview-proxy jobs: own result queue, in-flight set (also the
    // "building" indicator), and a sourceId→progress map. All guarded by
    // resultMtx_ so a single short-held lock covers enqueue/drain/status.
    std::vector<SourcePreviewResult>  finishedSourcePreview_;             // guarded
    std::unordered_set<int>           inFlightSourcePreview_;             // guarded
    std::unordered_map<int, float>    sourcePreviewProgress_;             // guarded

    // Codec-migration batch counters (guarded by resultMtx_). Source ids of
    // in-flight whole-source migrations feed the live-progress term.
    int                               migrationTotal_     = 0;   // guarded
    int                               migrationCompleted_ = 0;   // guarded
    int                               migrationFailed_    = 0;   // guarded
    std::unordered_set<int>           migratingSources_;         // guarded

    // Missing-file rebuild batch counters — same scheme as the migration ones.
    int                               rebuildTotal_     = 0;     // guarded
    int                               rebuildCompleted_ = 0;     // guarded
    int                               rebuildFailed_    = 0;     // guarded
    // Regions / sources tagged as part of the rebuild batch and not yet finished.
    // Membership — not the flag on whichever request happened to win an enqueue
    // race — decides whether a finished job counts as a rebuild. rebuildingSources_
    // doubles as the live-progress term for whole-source jobs.
    std::unordered_set<int>           rebuildingRegions_;        // guarded
    std::unordered_set<int>           rebuildingSources_;        // guarded

    // Bumped by cancelAll(). A job captures the epoch it was scheduled in and
    // drops its result if the epoch has moved on (it belongs to a previous
    // project). Guarded by resultMtx_.
    int                               epoch_ = 0;

    // Shared by getMigrationStatus / getRebuildStatus (caller holds resultMtx_).
    MigrationStatus batchStatusLocked(int total, int completed, int failed,
                                      const std::unordered_set<int>& liveSources) const;

    static long long posterKey(int sourceId, int frameBucket) {
        // +1 so the base poster (bucket -1) maps to 0 and never collides.
        return (static_cast<long long>(sourceId) << 32)
             | static_cast<unsigned int>(frameBucket + 1);
    }
};
