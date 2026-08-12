#include "audio/SlotBakeCache.h"

#include "dsp/PhaseVocoder.h"
#include "dsp/RubberBandWrapper.h"
#include "dsp/TDPSOLA.h"
#include "dsp/WORLD.h"
#include "dsp/WSOLA.h"
#include "model/TimelineTypes.h"
#include "XlethDebug.h"

#define XXH_INLINE_ALL
#include "xxhash.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstring>

namespace xleth::audio {

// ─── Disk entry format ───────────────────────────────────────────────────────
// A bake file is a fixed header followed by planar float32 data. Deliberately
// NOT a WAV: the header carries the full key, so a read can verify it got the
// bake it asked for rather than trusting the filename's 64-bit digest alone.

namespace {

constexpr uint32_t kBakeMagic   = 0x314B4258u;   // "XBK1" little-endian
constexpr uint32_t kBakeVersion = 1u;

#pragma pack(push, 1)
struct BakeFileHeader {
    uint32_t magic        = kBakeMagic;
    uint32_t version      = kBakeVersion;
    uint64_t sourceHash   = 0;
    int32_t  algorithm    = 0;
    int32_t  stretchMilli = 0;
    int32_t  shiftCents   = 0;
    int32_t  sampleRateHz = 0;
    int32_t  numChannels  = 0;
    int32_t  numSamples   = 0;
};
#pragma pack(pop)

static_assert(sizeof(BakeFileHeader) == 40, "bake header must stay wire-stable");

// Cents → the (semitone, cent) split TD-PSOLA wants, and the fractional
// semitones every other algorithm wants. trunc (not floor) so a negative shift
// splits symmetrically with a negative remainder.
inline int centsToSemis(int cents) noexcept { return cents / 100; }
inline int centsRemainder(int cents) noexcept { return cents - centsToSemis(cents) * 100; }

} // namespace

// ─── BakeKey ─────────────────────────────────────────────────────────────────

uint64_t BakeKey::digest() const noexcept {
    // Field-order-stable digest: pack into a POD and hash the bytes. Anything
    // that changes the rendered audio must be in here, or a stale disk entry
    // would be served for new parameters.
    struct Packed {
        uint64_t sourceHash;
        int32_t  algorithm;
        int32_t  stretchMilli;
        int32_t  shiftCents;
        int32_t  sampleRateHz;
        int32_t  numChannels;
        int32_t  pad;
    } p{ sourceHash, algorithm, stretchMilli, shiftCents,
         sampleRateHz, numChannels, 0 };
    return XXH3_64bits(&p, sizeof(p));
}

// ─── SlotBakeJob ─────────────────────────────────────────────────────────────

class SlotBakeJob : public juce::ThreadPoolJob {
public:
    SlotBakeJob(SlotBakeCache* owner, BakeKey key, juce::AudioBuffer<float> source)
        : juce::ThreadPoolJob("SlotBake")
        , owner_(owner), key_(key), source_(std::move(source)) {}

    JobStatus runJob() override {
        juce::ScopedNoDenormals noDenormals;
        owner_->getOrCompute(key_, source_);
        owner_->finishJob(key_);
        return JobStatus::jobHasFinished;
    }

private:
    SlotBakeCache*           owner_;
    BakeKey                  key_;
    juce::AudioBuffer<float> source_;
};

// ─── Construction ────────────────────────────────────────────────────────────

SlotBakeCache::SlotBakeCache(size_t maxBytes)
    : pool_(std::make_unique<juce::ThreadPool>(kThreads))
    , maxBytes_(maxBytes)
{}

SlotBakeCache::~SlotBakeCache() {
    if (pool_) pool_->removeAllJobs(true, 5000);
}

// ─── Cache dir ───────────────────────────────────────────────────────────────

void SlotBakeCache::setCacheDir(const std::string& dir) {
    std::lock_guard<std::mutex> lk(mu_);
    cacheDir_ = dir;
    if (!cacheDir_.empty())
        juce::File(juce::String(cacheDir_)).createDirectory();
}

std::string SlotBakeCache::cacheDir() const {
    std::lock_guard<std::mutex> lk(mu_);
    return cacheDir_;
}

std::string SlotBakeCache::filePathForKey(const BakeKey& key) const {
    std::lock_guard<std::mutex> lk(mu_);
    if (cacheDir_.empty()) return {};
    char name[40];
    std::snprintf(name, sizeof(name), "bake_%016llx.xbk",
                  static_cast<unsigned long long>(key.digest()));
    return juce::File(juce::String(cacheDir_)).getChildFile(name).getFullPathName().toStdString();
}

// ─── Memory tier ─────────────────────────────────────────────────────────────

size_t SlotBakeCache::bufferBytes(const juce::AudioBuffer<float>& b) noexcept {
    return static_cast<size_t>(std::max(0, b.getNumChannels()))
         * static_cast<size_t>(std::max(0, b.getNumSamples()))
         * sizeof(float);
}

size_t SlotBakeCache::entryCount() const noexcept {
    std::lock_guard<std::mutex> lk(mu_);
    return map_.size();
}

void SlotBakeCache::clearMemory() {
    std::lock_guard<std::mutex> lk(mu_);
    map_.clear();
    lruOrder_.clear();
    bytesNow_.store(0, std::memory_order_relaxed);
}

void SlotBakeCache::evictLocked() {
    const size_t cap = maxBytes_.load(std::memory_order_relaxed);
    while (bytesNow_.load(std::memory_order_relaxed) > cap && !lruOrder_.empty()) {
        const auto victim = lruOrder_.back();
        lruOrder_.pop_back();
        auto it = map_.find(victim);
        if (it != map_.end()) {
            bytesNow_.fetch_sub(it->second.bytes, std::memory_order_relaxed);
            map_.erase(it);
        }
    }
}

std::shared_ptr<const juce::AudioBuffer<float>>
SlotBakeCache::lookup(const BakeKey& key) {
    std::lock_guard<std::mutex> lk(mu_);
    auto it = map_.find(key);
    if (it == map_.end()) return nullptr;
    lruOrder_.erase(it->second.lruIt);          // promote to MRU
    lruOrder_.push_front(key);
    it->second.lruIt = lruOrder_.begin();
    return it->second.buffer;
}

void SlotBakeCache::insert(const BakeKey& key, BufferPtr buffer) {
    if (!buffer) return;
    const size_t bytes = bufferBytes(*buffer);
    std::lock_guard<std::mutex> lk(mu_);
    auto it = map_.find(key);
    if (it != map_.end()) {
        // Lost a race with another worker; keep the entry that won so every
        // holder of the buffer keeps pointing at the same audio.
        lruOrder_.erase(it->second.lruIt);
        lruOrder_.push_front(key);
        it->second.lruIt = lruOrder_.begin();
        return;
    }
    lruOrder_.push_front(key);
    Entry e;
    e.buffer = std::move(buffer);
    e.lruIt  = lruOrder_.begin();
    e.bytes  = bytes;
    bytesNow_.fetch_add(bytes, std::memory_order_relaxed);
    map_.emplace(key, std::move(e));
    evictLocked();
}

// ─── Pending / job queue ─────────────────────────────────────────────────────

bool SlotBakeCache::submit(const BakeKey& key, const juce::AudioBuffer<float>& source) {
    {
        std::lock_guard<std::mutex> lk(mu_);
        if (map_.count(key) || pending_.count(key)) return false;
        pending_.insert(key);
    }
    // Copy the source into the job: the caller's buffer is a working copy that
    // goes out of scope the moment buildSamplerForRegion returns.
    pool_->addJob(new SlotBakeJob(this, key, juce::AudioBuffer<float>(source)), true);
    return true;
}

void SlotBakeCache::finishJob(const BakeKey& key) {
    {
        std::lock_guard<std::mutex> lk(mu_);
        pending_.erase(key);
    }
    // Release AFTER the pending set is updated, so a main-thread reader that
    // sees the new epoch is guaranteed to also see the cleared pending flag.
    completionEpoch_.fetch_add(1, std::memory_order_release);
}

bool SlotBakeCache::isPending(const BakeKey& key) const {
    std::lock_guard<std::mutex> lk(mu_);
    return pending_.count(key) != 0;
}

size_t SlotBakeCache::pendingCount() const {
    std::lock_guard<std::mutex> lk(mu_);
    return pending_.size();
}

void SlotBakeCache::waitForPendingJobs(int timeoutMs) {
    if (!pool_) return;
    // Poll rather than removeAllJobs(): we want every queued bake to RUN, not
    // to be cancelled. Main thread / tests only.
    const auto deadline = juce::Time::getMillisecondCounter()
                        + static_cast<uint32_t>(std::max(0, timeoutMs));
    while (pool_->getNumJobs() > 0
           && juce::Time::getMillisecondCounter() < deadline) {
        juce::Thread::sleep(2);
    }
}

// ─── Hashing ─────────────────────────────────────────────────────────────────

uint64_t SlotBakeCache::hashPCM(const juce::AudioBuffer<float>& src) noexcept {
    XXH3_state_t* state = XXH3_createState();
    if (!state) return 0;
    XXH3_64bits_reset(state);

    const int numCh   = src.getNumChannels();
    const int numSamp = src.getNumSamples();
    const int32_t shape[2] = { numCh, numSamp };
    XXH3_64bits_update(state, shape, sizeof(shape));

    for (int ch = 0; ch < numCh; ++ch) {
        const float* p = src.getReadPointer(ch);
        if (p && numSamp > 0)
            XXH3_64bits_update(state, p, sizeof(float) * static_cast<size_t>(numSamp));
    }

    const uint64_t digest = XXH3_64bits_digest(state);
    XXH3_freeState(state);
    return digest;
}

// ─── Disk tier ───────────────────────────────────────────────────────────────

std::shared_ptr<juce::AudioBuffer<float>>
SlotBakeCache::readEntry(const BakeKey& key) {
    const std::string path = filePathForKey(key);
    if (path.empty()) return nullptr;

    juce::File f{ juce::String(path) };
    if (!f.existsAsFile()) return nullptr;

    juce::FileInputStream in(f);
    if (!in.openedOk()) return nullptr;

    BakeFileHeader h{};
    if (in.read(&h, sizeof(h)) != static_cast<int>(sizeof(h))) return nullptr;
    if (h.magic != kBakeMagic || h.version != kBakeVersion) return nullptr;

    // Verify the full key, not just the filename digest — a truncated write or
    // a digest collision must read as a MISS, never as the wrong audio.
    if (h.sourceHash   != key.sourceHash   || h.algorithm    != key.algorithm
     || h.stretchMilli != key.stretchMilli || h.shiftCents   != key.shiftCents
     || h.sampleRateHz != key.sampleRateHz || h.numChannels  != key.numChannels)
        return nullptr;

    if (h.numChannels <= 0 || h.numChannels > 64 || h.numSamples < 0) return nullptr;

    const int64_t expected = static_cast<int64_t>(sizeof(h))
                           + static_cast<int64_t>(h.numChannels)
                           * static_cast<int64_t>(h.numSamples) * 4;
    if (f.getSize() != expected) return nullptr;   // truncated / partial write

    auto buf = std::make_shared<juce::AudioBuffer<float>>(h.numChannels,
                                                          std::max(0, h.numSamples));
    buf->clear();
    for (int ch = 0; ch < h.numChannels; ++ch) {
        if (h.numSamples == 0) continue;
        const int wanted = static_cast<int>(sizeof(float)) * h.numSamples;
        if (in.read(buf->getWritePointer(ch), wanted) != wanted) return nullptr;
    }
    return buf;
}

bool SlotBakeCache::writeEntry(const BakeKey& key,
                               const juce::AudioBuffer<float>& buf) {
    const std::string path = filePathForKey(key);
    if (path.empty()) return false;

    juce::File f{ juce::String(path) };
    f.getParentDirectory().createDirectory();

    // Write to a sibling temp then move into place, so a crash mid-write can
    // never leave a half file that a later run would have to detect.
    juce::File tmp{ f.getFullPathName() + ".part" };
    tmp.deleteFile();
    {
        juce::FileOutputStream out(tmp);
        if (!out.openedOk()) return false;

        BakeFileHeader h{};
        h.sourceHash   = key.sourceHash;
        h.algorithm    = key.algorithm;
        h.stretchMilli = key.stretchMilli;
        h.shiftCents   = key.shiftCents;
        h.sampleRateHz = key.sampleRateHz;
        h.numChannels  = buf.getNumChannels();
        h.numSamples   = buf.getNumSamples();
        if (!out.write(&h, sizeof(h))) return false;

        for (int ch = 0; ch < buf.getNumChannels(); ++ch) {
            if (buf.getNumSamples() == 0) continue;
            if (!out.write(buf.getReadPointer(ch),
                           sizeof(float) * static_cast<size_t>(buf.getNumSamples())))
                return false;
        }
        out.flush();
    }
    f.deleteFile();
    if (!tmp.moveFileTo(f)) { tmp.deleteFile(); return false; }
    diskWriteCount_.fetch_add(1, std::memory_order_relaxed);
    return true;
}

// ─── Algorithm dispatch ──────────────────────────────────────────────────────
// Mirrors ClipRenderCache's dispatch so the sampler and the timeline reach the
// same five renderers with the same parameter conventions.

juce::AudioBuffer<float>
SlotBakeCache::runAlgorithm(const BakeKey& key, const juce::AudioBuffer<float>& source) {
    const double sr      = static_cast<double>(key.sampleRateHz);
    const double ratio   = static_cast<double>(key.stretchMilli) / 1000.0;
    const double semis   = static_cast<double>(key.shiftCents) / 100.0;

    switch (static_cast<StretchMethod>(key.algorithm)) {
        case StretchMethod::PSOLA: {
            dsp::PSOLAParams p;
            p.sampleRate       = sr;
            p.pitchOffsetSemis = centsToSemis(key.shiftCents);
            p.pitchOffsetCents = centsRemainder(key.shiftCents);
            p.stretchRatio     = ratio;
            return dsp::processTDPSOLA(source, p);
        }
        case StretchMethod::WSOLA: {
            dsp::WSOLAParams p;
            p.sampleRate          = sr;
            p.pitchShiftSemitones = semis;
            p.stretchRatio        = ratio;
            return dsp::processWSOLA(source, p);
        }
        case StretchMethod::PhaseVocoder: {
            dsp::PhaseVocoderParams p;
            p.sampleRate          = sr;
            p.pitchShiftSemitones = semis;
            p.stretchRatio        = ratio;
            return dsp::processPhaseVocoder(source, p);
        }
        case StretchMethod::WORLD: {
            dsp::WORLDParams p;
            p.sampleRate          = sr;
            p.pitchShiftSemitones = semis;
            p.stretchRatio        = ratio;
            return dsp::processWORLD(source, p);
        }
        case StretchMethod::Rubber:
        case StretchMethod::Global:
        default: {
            // Global is not a renderer — it is the timeline's "inherit the
            // preference" sentinel and has no meaning for a slot, so it lands
            // on Rubber Band, the general-purpose choice.
            dsp::RubberBandParams p;
            p.sampleRate          = sr;
            p.pitchShiftSemitones = semis;
            p.stretchRatio        = ratio;
            return dsp::processRubberBand(source, p);
        }
    }
}

// ─── getOrCompute ────────────────────────────────────────────────────────────

std::shared_ptr<const juce::AudioBuffer<float>>
SlotBakeCache::getOrCompute(const BakeKey& key, const juce::AudioBuffer<float>& source) {
    if (auto hit = lookup(key)) {
#ifdef XLETH_DEBUG
        fprintf(stderr, "[SlotBake] MEM HIT  key=%016llx\n",
                (unsigned long long)key.digest());
        fflush(stderr);
#endif
        return hit;
    }

    // Disk tier. A missing (or deleted, or truncated) file is just a miss —
    // we fall through and rebake, which is what heals a wiped cache folder.
    if (auto fromDisk = readEntry(key)) {
        diskHitCount_.fetch_add(1, std::memory_order_relaxed);
#ifdef XLETH_DEBUG
        fprintf(stderr, "[SlotBake] DISK HIT key=%016llx samples=%d\n",
                (unsigned long long)key.digest(), fromDisk->getNumSamples());
        fflush(stderr);
#endif
        BufferPtr shared = fromDisk;
        insert(key, shared);
        // insert() may have kept a racing winner; return whatever is resident.
        if (auto resident = lookup(key)) return resident;
        return shared;
    }

    computeCount_.fetch_add(1, std::memory_order_relaxed);
#ifdef XLETH_DEBUG
    fprintf(stderr, "[SlotBake] MISS key=%016llx algo=%d stretch=%d shift=%dc — baking\n",
            (unsigned long long)key.digest(), key.algorithm,
            key.stretchMilli, key.shiftCents);
    fflush(stderr);
#endif

    auto produced = std::make_shared<juce::AudioBuffer<float>>(runAlgorithm(key, source));
    writeEntry(key, *produced);

    BufferPtr shared = produced;
    insert(key, shared);
    if (auto resident = lookup(key)) return resident;
    return shared;
}

} // namespace xleth::audio
