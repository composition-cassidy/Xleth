#include "Timeline.h"
#include <algorithm>
#include <cmath>
#include <iostream>
#include <set>

namespace {
int sanitizeProjectGlobalStretchMethod(int method) {
    switch (static_cast<StretchMethod>(method)) {
        case StretchMethod::PSOLA:
        case StretchMethod::Rubber:
        case StretchMethod::WSOLA:
        case StretchMethod::PhaseVocoder:
        case StretchMethod::WORLD:
            return method;
        case StretchMethod::Global:
        default:
            return static_cast<int>(StretchMethod::PSOLA);
    }
}
}

// ─── SourceMedia JSON (defined here; no separate SourceMedia.h/.cpp) ──────────

static void sourceToJson(nlohmann::json& j, const SourceMedia& s) {
    j = nlohmann::json{
        {"id",          s.id},
        {"filePath",    s.filePath},
        {"proxyPath",   s.proxyPath},
        {"fileName",    s.fileName},
        {"width",       s.width},
        {"height",      s.height},
        {"fps",         s.fps},
        {"duration",    s.duration},
        {"totalFrames", s.totalFrames},
        {"hasVideo",    s.hasVideo},
        {"proxyReady",  s.proxyReady},
        {"posterPath",  s.posterPath},
        {"posterReady", s.posterReady},
        {"previewProxyPath",   s.previewProxyPath},
        {"previewProxyReady",  s.previewProxyReady},
        {"previewProxyHeight", s.previewProxyHeight}
    };
}

static void sourceFromJson(const nlohmann::json& j, SourceMedia& s) {
    j.at("id").get_to(s.id);
    j.at("filePath").get_to(s.filePath);
    j.at("proxyPath").get_to(s.proxyPath);
    j.at("fileName").get_to(s.fileName);
    j.at("width").get_to(s.width);
    j.at("height").get_to(s.height);
    j.at("fps").get_to(s.fps);
    j.at("duration").get_to(s.duration);
    j.at("totalFrames").get_to(s.totalFrames);
    j.at("hasVideo").get_to(s.hasVideo);
    j.at("proxyReady").get_to(s.proxyReady);
    // Poster fields are newer than the original schema — read defensively so
    // projects written before poster preview mode still load. posterReady is
    // re-validated against disk by the caller, so a stale `true` is harmless.
    s.posterPath  = j.value("posterPath", std::string{});
    s.posterReady = j.value("posterReady", false);
    // Whole-source preview proxy — newer than the original schema; read
    // defensively. previewProxyReady is re-validated against disk by the loader
    // (ProjectManager::resolveMediaPaths), so a stale `true` is harmless.
    s.previewProxyPath   = j.value("previewProxyPath", std::string{});
    s.previewProxyReady  = j.value("previewProxyReady", false);
    s.previewProxyHeight = j.value("previewProxyHeight", 0);
}

// ─── Constructor ──────────────────────────────────────────────────────────────

Timeline::Timeline(double bpm, double sampleRate, int timeSigNum, int timeSigDen)
    : m_bpm(bpm), m_sampleRate(sampleRate),
      m_timeSigNum(timeSigNum), m_timeSigDen(timeSigDen),
      m_nextId(1)
{
    m_gridSnapshots.push_back(
        makeGridSnapshot(m_gridLayout, m_activeSnapshotId, m_activeSnapshotName));
    std::cout << "[Timeline] Created new timeline: BPM=" << bpm
              << ", SR=" << sampleRate
              << ", TimeSig=" << timeSigNum << "/" << timeSigDen << "\n";
}

int Timeline::getNextId() {
    return m_nextId++;
}

// ─── Sources ──────────────────────────────────────────────────────────────────

int Timeline::addSource(SourceMedia media) {
    media.id = getNextId();
    m_sources[media.id] = media;
    std::cout << "[Timeline] Added source id=" << media.id
              << " fileName=\"" << media.fileName << "\""
              << " path=\"" << media.filePath << "\""
              << " " << media.width << "x" << media.height
              << " fps=" << media.fps << "\n";
    return media.id;
}

const SourceMedia* Timeline::getSource(int id) const {
    auto it = m_sources.find(id);
    return (it != m_sources.end()) ? &it->second : nullptr;
}

SourceMedia* Timeline::getSourceMutable(int id) {
    auto it = m_sources.find(id);
    return (it != m_sources.end()) ? &it->second : nullptr;
}

std::vector<const SourceMedia*> Timeline::getAllSources() const {
    std::vector<const SourceMedia*> out;
    out.reserve(m_sources.size());
    for (const auto& [id, src] : m_sources)
        out.push_back(&src);
    return out;
}

bool Timeline::removeSource(int id) {
    auto it = m_sources.find(id);
    if (it == m_sources.end()) {
        std::cout << "[Timeline] ERROR removeSource: id=" << id << " not found\n";
        return false;
    }
    std::cout << "[Timeline] Removed source id=" << id
              << " fileName=\"" << it->second.fileName << "\"\n";
    m_sources.erase(it);
    return true;
}

// ─── Regions ──────────────────────────────────────────────────────────────────

int Timeline::addRegion(SampleRegion region) {
    region.id = getNextId();
    m_regions[region.id] = region;
    std::cout << "[Timeline] Added region id=" << region.id
              << " name=\"" << region.name << "\""
              << " label=" << sampleLabelToString(region.label)
              << " sourceId=" << region.sourceId
              << " audio=\"" << region.audioFilePath << "\""
              << " syllables=" << region.syllables.size() << "\n";
    return region.id;
}

const SampleRegion* Timeline::getRegion(int id) const {
    auto it = m_regions.find(id);
    return (it != m_regions.end()) ? &it->second : nullptr;
}

SampleRegion* Timeline::getRegionMutable(int id) {
    auto it = m_regions.find(id);
    return (it != m_regions.end()) ? &it->second : nullptr;
}

std::vector<const SampleRegion*> Timeline::getAllRegions() const {
    std::vector<const SampleRegion*> out;
    out.reserve(m_regions.size());
    for (const auto& [id, r] : m_regions)
        out.push_back(&r);
    return out;
}

std::vector<SampleRegion*> Timeline::getAllRegionsMutable() {
    std::vector<SampleRegion*> out;
    out.reserve(m_regions.size());
    for (auto& [id, r] : m_regions)
        out.push_back(&r);
    return out;
}

bool Timeline::removeRegion(int id) {
    auto it = m_regions.find(id);
    if (it == m_regions.end()) {
        std::cout << "[Timeline] ERROR removeRegion: id=" << id << " not found\n";
        return false;
    }
    std::cout << "[Timeline] Removed region id=" << id
              << " name=\"" << it->second.name << "\"\n";
    m_regions.erase(it);
    return true;
}

std::vector<const SampleRegion*> Timeline::getRegionsByLabel(SampleLabel label) const {
    std::vector<const SampleRegion*> out;
    for (const auto& [id, r] : m_regions)
        if (r.label == label)
            out.push_back(&r);
    return out;
}

// ─── Tracks ───────────────────────────────────────────────────────────────────

int Timeline::addTrack(TrackInfo track) {
    track.id = getNextId();
    m_tracks[track.id] = track;
    std::cout << "[Timeline] Added track id=" << track.id
              << " name=\"" << track.name << "\""
              << " order=" << track.order
              << " vol=" << track.volume << " pan=" << track.pan << "\n";
    return track.id;
}

const TrackInfo* Timeline::getTrack(int id) const {
    auto it = m_tracks.find(id);
    return (it != m_tracks.end()) ? &it->second : nullptr;
}

TrackInfo* Timeline::getTrackMutable(int id) {
    auto it = m_tracks.find(id);
    return (it != m_tracks.end()) ? &it->second : nullptr;
}

std::vector<const TrackInfo*> Timeline::getAllTracks() const {
    std::vector<const TrackInfo*> out;
    out.reserve(m_tracks.size());
    for (const auto& [id, t] : m_tracks)
        out.push_back(&t);
    std::stable_sort(out.begin(), out.end(), [](const TrackInfo* a, const TrackInfo* b) {
        if (a->order != b->order)
            return a->order < b->order;
        return a->id < b->id;
    });
    return out;
}

bool Timeline::setTrackOrder(const std::vector<int>& trackIdsInOrder) {
    if (trackIdsInOrder.size() != m_tracks.size())
        return false;

    std::set<int> seen;
    for (int trackId : trackIdsInOrder) {
        if (m_tracks.find(trackId) == m_tracks.end() || !seen.insert(trackId).second)
            return false;
    }

    for (size_t i = 0; i < trackIdsInOrder.size(); ++i)
        m_tracks[trackIdsInOrder[i]].order = static_cast<int>(i);
    return true;
}

bool Timeline::removeTrack(int id) {
    auto it = m_tracks.find(id);
    if (it == m_tracks.end()) {
        std::cout << "[Timeline] ERROR removeTrack: id=" << id << " not found\n";
        return false;
    }
    std::cout << "[Timeline] Removed track id=" << id
              << " name=\"" << it->second.name << "\"\n";
    m_tracks.erase(it);
    return true;
}

// ─── Clips ────────────────────────────────────────────────────────────────────

int Timeline::addClip(Clip clip) {
    if (m_tracks.find(clip.trackId) == m_tracks.end()) {
        std::cout << "[Timeline] ERROR addClip: trackId=" << clip.trackId << " not found\n";
        return -1;
    }
    if (m_regions.find(clip.regionId) == m_regions.end()) {
        std::cout << "[Timeline] ERROR addClip: regionId=" << clip.regionId << " not found\n";
        return -1;
    }
    normalizeClipFadePercents(clip);
    clip.id = getNextId();
    m_clips[clip.id] = clip;
    std::cout << "[Timeline] Added clip id=" << clip.id
              << " trackId=" << clip.trackId
              << " regionId=" << clip.regionId
              << " position=" << clip.position.ticks
              << " duration=" << clip.duration.ticks
              << " syllable=" << clip.syllableIndex
              << " vel=" << clip.velocity << "\n";
#ifdef XLETH_DEBUG
    // Log the clip AS STORED in m_clips — catches "bridge received it correctly
    // but the copy-in clobbered/defaulted it" failures. Safe from this call site:
    // Timeline::addClip is only invoked by AddClipCommand::execute on the Node
    // main thread (via the bridge handler); the audio thread only reads clips.
    const Clip& stored = m_clips[clip.id];
    fprintf(stderr,
        "[Timeline_ClipConstruct] stored id=%d trackId=%d regionId=%d "
        "pos=%lld dur=%lld regionOffset=%lld syll=%d vel=%.3f "
        "pitchOffset=%d pitchCents=%d reversed=%d stretchRatio=%.3f "
        "stretchMethod=%d formantPreserve=%d "
        "fadeIn=%.2f fadeOut=%.2f bezierIn=[%.2f,%.2f,%.2f,%.2f] "
        "bezierOut=[%.2f,%.2f,%.2f,%.2f]\n",
        stored.id, stored.trackId, stored.regionId,
        (long long)stored.position.ticks, (long long)stored.duration.ticks,
        (long long)stored.regionOffset.ticks, stored.syllableIndex, stored.velocity,
        stored.pitchOffset, stored.pitchOffsetCents,
        stored.reversed ? 1 : 0, stored.stretchRatio,
        (int)stored.stretchMethod, stored.formantPreserve ? 1 : 0,
        stored.fadeInPercent, stored.fadeOutPercent,
        stored.fadeInX1, stored.fadeInY1, stored.fadeInX2, stored.fadeInY2,
        stored.fadeOutX1, stored.fadeOutY1, stored.fadeOutX2, stored.fadeOutY2);
#endif
    // Contract: after addClip returns, the clip is stored AND its render
    // state is queued. MixEngine::invalidateClipCache is async (ThreadPool)
    // and short-circuits cheaply on identity clips, so this call is always
    // safe to make unconditionally.
    if (m_clipCacheInvalidator) {
        m_clipCacheInvalidator(clip.id, "addClip");
    }
#ifdef XLETH_DEBUG
    fprintf(stderr,
        "[CacheQueue] addClip clip=%d enqueued "
        "(stretch=%.3f reversed=%d pitch=%d cents=%d)\n",
        clip.id, clip.stretchRatio, clip.reversed ? 1 : 0,
        clip.pitchOffset, clip.pitchOffsetCents);
    fflush(stderr);
#endif
    return clip.id;
}

const Clip* Timeline::getClip(int id) const {
    auto it = m_clips.find(id);
    return (it != m_clips.end()) ? &it->second : nullptr;
}

Clip* Timeline::getClipMutable(int id) {
    auto it = m_clips.find(id);
    return (it != m_clips.end()) ? &it->second : nullptr;
}

std::vector<const Clip*> Timeline::getAllClips() const {
    std::vector<const Clip*> out;
    out.reserve(m_clips.size());
    for (const auto& [id, c] : m_clips)
        out.push_back(&c);
    return out;
}

bool Timeline::removeClip(int id) {
    auto it = m_clips.find(id);
    if (it == m_clips.end()) {
        std::cout << "[Timeline] ERROR removeClip: id=" << id << " not found\n";
        return false;
    }
    std::cout << "[Timeline] Removed clip id=" << id
              << " trackId=" << it->second.trackId
              << " position=" << it->second.position.ticks << "\n";
    m_clips.erase(it);
    return true;
}

std::vector<const Clip*> Timeline::getClipsOnTrack(int trackId) const {
    std::vector<const Clip*> out;
    for (const auto& [id, c] : m_clips)
        if (c.trackId == trackId)
            out.push_back(&c);
    return out;
}

std::vector<const Clip*> Timeline::getClipsInRange(TickTime start, TickTime end) const {
    std::vector<const Clip*> out;
    for (const auto& [id, c] : m_clips)
        if (!(c.position < start) && c.position < end)  // position in [start, end)
            out.push_back(&c);
    return out;
}

bool Timeline::moveClip(int clipId, TickTime newPosition) {
    auto it = m_clips.find(clipId);
    if (it == m_clips.end()) {
        std::cout << "[Timeline] ERROR moveClip: id=" << clipId << " not found\n";
        return false;
    }
    TickTime oldPos = it->second.position;
    it->second.position = newPosition;
    std::cout << "[Timeline] Moved clip id=" << clipId
              << " from=" << oldPos.ticks
              << " to=" << newPosition.ticks << "\n";
    return true;
}

bool Timeline::resizeClip(int clipId, TickTime newDuration) {
    auto it = m_clips.find(clipId);
    if (it == m_clips.end()) {
        std::cout << "[Timeline] ERROR resizeClip: id=" << clipId << " not found\n";
        return false;
    }
    TickTime oldDur = it->second.duration;
    it->second.duration = newDuration;
    std::cout << "[Timeline] Resized clip id=" << clipId
              << " from=" << oldDur.ticks
              << " to=" << newDuration.ticks << "\n";
    return true;
}

bool Timeline::resizeClipLeft(int clipId, TickTime newPosition,
                               TickTime newDuration, TickTime newRegionOffset) {
    auto it = m_clips.find(clipId);
    if (it == m_clips.end()) {
        std::cout << "[Timeline] ERROR resizeClipLeft: id=" << clipId << " not found\n";
        return false;
    }
    it->second.position     = newPosition;
    it->second.duration     = newDuration;
    it->second.regionOffset = newRegionOffset;
    std::cout << "[Timeline] ResizeClipLeft id=" << clipId
              << " pos=" << newPosition.ticks
              << " dur=" << newDuration.ticks
              << " offset=" << newRegionOffset.ticks << "\n";
    return true;
}

// ─── Patterns ─────────────────────────────────────────────────────────────────

int Timeline::addPattern(Pattern pattern) {
    if (pattern.regionId >= 0 && m_regions.find(pattern.regionId) == m_regions.end()) {
        std::cout << "[Timeline] ERROR addPattern: regionId="
                  << pattern.regionId << " not found\n";
        return -1;
    }
    pattern.id = getNextId();
    m_patterns[pattern.id] = pattern;
    std::cout << "[Timeline] Added pattern id=" << pattern.id
              << " name=\"" << pattern.name << "\""
              << " regionId=" << pattern.regionId
              << " length=" << pattern.length.ticks
              << " notes=" << pattern.notes.size() << "\n";
    return pattern.id;
}

const Pattern* Timeline::getPattern(int id) const {
    auto it = m_patterns.find(id);
    return (it != m_patterns.end()) ? &it->second : nullptr;
}

Pattern* Timeline::getPatternMutable(int id) {
    auto it = m_patterns.find(id);
    return (it != m_patterns.end()) ? &it->second : nullptr;
}

bool Timeline::removePattern(int id) {
    auto it = m_patterns.find(id);
    if (it == m_patterns.end()) {
        std::cout << "[Timeline] ERROR removePattern: id=" << id << " not found\n";
        return false;
    }
    std::cout << "[Timeline] Removed pattern id=" << id
              << " name=\"" << it->second.name << "\"\n";
    m_patterns.erase(it);
    return true;
}

// ─── PatternBlocks ────────────────────────────────────────────────────────────

int Timeline::addPatternBlock(PatternBlock block) {
    if (m_tracks.find(block.trackId) == m_tracks.end()) {
        std::cout << "[Timeline] ERROR addPatternBlock: trackId="
                  << block.trackId << " not found\n";
        return -1;
    }
    if (m_patterns.find(block.patternId) == m_patterns.end()) {
        std::cout << "[Timeline] ERROR addPatternBlock: patternId="
                  << block.patternId << " not found\n";
        return -1;
    }
    block.id = getNextId();
    m_patternBlocks[block.id] = block;
    std::cout << "[Timeline] Added patternBlock id=" << block.id
              << " trackId=" << block.trackId
              << " patternId=" << block.patternId
              << " position=" << block.position.ticks
              << " duration=" << block.duration.ticks
              << " offset=" << block.offset.ticks << "\n";
    return block.id;
}

const PatternBlock* Timeline::getPatternBlock(int id) const {
    auto it = m_patternBlocks.find(id);
    return (it != m_patternBlocks.end()) ? &it->second : nullptr;
}

PatternBlock* Timeline::getPatternBlockMutable(int id) {
    auto it = m_patternBlocks.find(id);
    return (it != m_patternBlocks.end()) ? &it->second : nullptr;
}

std::vector<const PatternBlock*> Timeline::getAllPatternBlocks() const {
    std::vector<const PatternBlock*> out;
    out.reserve(m_patternBlocks.size());
    for (const auto& [id, b] : m_patternBlocks)
        out.push_back(&b);
    return out;
}

std::vector<const PatternBlock*> Timeline::getPatternBlocksOnTrack(int trackId) const {
    std::vector<const PatternBlock*> out;
    for (const auto& [id, b] : m_patternBlocks)
        if (b.trackId == trackId)
            out.push_back(&b);
    return out;
}

std::vector<const PatternBlock*> Timeline::getPatternBlocksInRange(TickTime start, TickTime end) const {
    std::vector<const PatternBlock*> out;
    for (const auto& [id, b] : m_patternBlocks)
        if (!(b.position < start) && b.position < end)  // position in [start, end)
            out.push_back(&b);
    return out;
}

bool Timeline::removePatternBlock(int id) {
    auto it = m_patternBlocks.find(id);
    if (it == m_patternBlocks.end()) {
        std::cout << "[Timeline] ERROR removePatternBlock: id=" << id << " not found\n";
        return false;
    }
    std::cout << "[Timeline] Removed patternBlock id=" << id
              << " trackId=" << it->second.trackId
              << " position=" << it->second.position.ticks << "\n";
    m_patternBlocks.erase(it);
    return true;
}

bool Timeline::movePatternBlock(int id, int newTrackId, TickTime newPosition) {
    auto it = m_patternBlocks.find(id);
    if (it == m_patternBlocks.end()) {
        std::cout << "[Timeline] ERROR movePatternBlock: id=" << id << " not found\n";
        return false;
    }
    if (m_tracks.find(newTrackId) == m_tracks.end()) {
        std::cout << "[Timeline] ERROR movePatternBlock: trackId="
                  << newTrackId << " not found\n";
        return false;
    }
    int oldTrackId = it->second.trackId;
    TickTime oldPos = it->second.position;
    it->second.trackId  = newTrackId;
    it->second.position = newPosition;
    std::cout << "[Timeline] Moved patternBlock id=" << id
              << " track " << oldTrackId << "→" << newTrackId
              << " pos " << oldPos.ticks << "→" << newPosition.ticks << "\n";
    return true;
}

bool Timeline::resizePatternBlock(int id, TickTime newDuration) {
    auto it = m_patternBlocks.find(id);
    if (it == m_patternBlocks.end()) {
        std::cout << "[Timeline] ERROR resizePatternBlock: id=" << id << " not found\n";
        return false;
    }
    TickTime oldDur = it->second.duration;
    it->second.duration = newDuration;
    std::cout << "[Timeline] Resized patternBlock id=" << id
              << " from=" << oldDur.ticks
              << " to=" << newDuration.ticks << "\n";
    return true;
}

bool Timeline::resizePatternBlockLeft(int id, TickTime newPosition, TickTime newDuration, TickTime newOffset) {
    auto it = m_patternBlocks.find(id);
    if (it == m_patternBlocks.end()) {
        std::cout << "[Timeline] ERROR resizePatternBlockLeft: id=" << id << " not found\n";
        return false;
    }
    it->second.position = newPosition;
    it->second.duration = newDuration;
    it->second.offset   = newOffset;
    std::cout << "[Timeline] Left-resized patternBlock id=" << id
              << " pos=" << newPosition.ticks
              << " dur=" << newDuration.ticks
              << " offset=" << newOffset.ticks << "\n";
    return true;
}

bool Timeline::setPatternBlockLoopEnabled(int id, bool enabled) {
    auto it = m_patternBlocks.find(id);
    if (it == m_patternBlocks.end()) {
        std::cout << "[Timeline] ERROR setPatternBlockLoopEnabled: id=" << id << " not found\n";
        return false;
    }
    it->second.loopEnabled = enabled;
    std::cout << "[Timeline] patternBlock id=" << id
              << " loopEnabled=" << (enabled ? "true" : "false") << "\n";
    return true;
}

// ─── Pattern notes ────────────────────────────────────────────────────────────

// Derived state: pattern.length is the extent of the rightmost note end,
// rounded up to the nearest whole bar (960 PPQ * 4 = 3840 ticks), min 1 bar.
// Cascades the new length to any PatternBlocks whose duration was equal to
// the old length (i.e. were in-sync / untrimmed by the user).
void Timeline::recalcPatternLength(int patternId) {
    auto it = m_patterns.find(patternId);
    if (it == m_patterns.end()) return;
    Pattern& pat = it->second;

    constexpr int64_t BAR_TICKS = 3840; // 960 PPQ * 4 beats
    int64_t rightmost = 0;
    for (const auto& n : pat.notes) {
        const int64_t end = n.position.ticks + n.duration.ticks;
        if (end > rightmost) rightmost = end;
    }
    int64_t bars = (rightmost + BAR_TICKS - 1) / BAR_TICKS;
    if (bars < 1) bars = 1;
    const int64_t oldLength = pat.length.ticks;
    const int64_t newLength = bars * BAR_TICKS;
    if (newLength == oldLength) return;
    pat.length.ticks = newLength;

    std::cout << "[Timeline] recalcPatternLength pattern=" << patternId
              << " old=" << oldLength << " new=" << newLength << "\n";

    cascadeBlockDurations(patternId, oldLength, newLength);
}

void Timeline::cascadeBlockDurations(int patternId, int64_t oldLength, int64_t newLength) {
    for (auto& [blockId, block] : m_patternBlocks) {
        if (block.patternId != patternId) continue;
        if (block.duration.ticks == oldLength) {
            block.duration.ticks = newLength;
            std::cout << "[Timeline] cascadeBlockDurations block=" << blockId
                      << " dur " << oldLength << " -> " << newLength << "\n";
        }
    }
}

int Timeline::addNoteToPattern(int patternId, PatternNote note) {
    auto it = m_patterns.find(patternId);
    if (it == m_patterns.end()) {
        std::cout << "[Timeline] ERROR addNoteToPattern: patternId="
                  << patternId << " not found\n";
        return -1;
    }
    note.id = it->second.nextNoteId++;
    it->second.notes.push_back(note);
    std::cout << "[Timeline] Added note id=" << note.id
              << " to pattern=" << patternId
              << " pitch=" << note.pitch
              << " pos=" << note.position.ticks
              << " dur=" << note.duration.ticks
              << " vel=" << note.velocity << "\n";
    recalcPatternLength(patternId);
    return note.id;
}

bool Timeline::addNotesToPatternBulk(int patternId, std::vector<PatternNote>& notes) {
    auto it = m_patterns.find(patternId);
    if (it == m_patterns.end()) {
        std::cout << "[Timeline] ERROR addNotesToPatternBulk: patternId="
                  << patternId << " not found\n";
        return false;
    }
    if (notes.empty()) {
        return true;
    }

    Pattern& pattern = it->second;
    pattern.notes.reserve(pattern.notes.size() + notes.size());
    for (auto& note : notes) {
        note.id = pattern.nextNoteId++;
        pattern.notes.push_back(note);
    }

    std::cout << "[Timeline] Added " << notes.size()
              << " notes to pattern=" << patternId
              << " (bulk)\n";
    recalcPatternLength(patternId);
    return true;
}

bool Timeline::removeNoteFromPattern(int patternId, int noteId) {
    auto it = m_patterns.find(patternId);
    if (it == m_patterns.end()) {
        std::cout << "[Timeline] ERROR removeNoteFromPattern: patternId="
                  << patternId << " not found\n";
        return false;
    }
    auto& notes = it->second.notes;
    auto nit = std::find_if(notes.begin(), notes.end(),
        [noteId](const PatternNote& n) { return n.id == noteId; });
    if (nit == notes.end()) {
        std::cout << "[Timeline] ERROR removeNoteFromPattern: noteId="
                  << noteId << " not found in pattern=" << patternId << "\n";
        return false;
    }
    notes.erase(nit);
    std::cout << "[Timeline] Removed note id=" << noteId
              << " from pattern=" << patternId << "\n";
    recalcPatternLength(patternId);
    return true;
}

bool Timeline::moveNote(int patternId, int noteId, TickTime newPosition, int newPitch) {
    auto it = m_patterns.find(patternId);
    if (it == m_patterns.end()) return false;
    for (auto& n : it->second.notes) {
        if (n.id == noteId) {
            n.position = newPosition;
            n.pitch    = newPitch;
            std::cout << "[Timeline] Moved note id=" << noteId
                      << " in pattern=" << patternId
                      << " pos=" << newPosition.ticks
                      << " pitch=" << newPitch << "\n";
            recalcPatternLength(patternId);
            return true;
        }
    }
    return false;
}

bool Timeline::resizeNote(int patternId, int noteId, TickTime newDuration) {
    auto it = m_patterns.find(patternId);
    if (it == m_patterns.end()) return false;
    for (auto& n : it->second.notes) {
        if (n.id == noteId) {
            n.duration = newDuration;
            std::cout << "[Timeline] Resized note id=" << noteId
                      << " in pattern=" << patternId
                      << " dur=" << newDuration.ticks << "\n";
            recalcPatternLength(patternId);
            return true;
        }
    }
    return false;
}

bool Timeline::setNoteVelocity(int patternId, int noteId, float velocity) {
    auto it = m_patterns.find(patternId);
    if (it == m_patterns.end()) return false;
    for (auto& n : it->second.notes) {
        if (n.id == noteId) {
            n.velocity = velocity;
            std::cout << "[Timeline] Set note id=" << noteId
                      << " in pattern=" << patternId
                      << " vel=" << velocity << "\n";
            return true;
        }
    }
    return false;
}

// ─── Track type / sampler ─────────────────────────────────────────────────────

bool Timeline::convertToPatternTrack(int trackId) {
    auto it = m_tracks.find(trackId);
    if (it == m_tracks.end()) {
        std::cout << "[Timeline] ERROR convertToPatternTrack: trackId="
                  << trackId << " not found\n";
        return false;
    }
    it->second.type = TrackInfo::Type::Pattern;
    std::cout << "[Timeline] Converted track id=" << trackId << " to Pattern\n";
    return true;
}

bool Timeline::convertToClipTrack(int trackId) {
    auto it = m_tracks.find(trackId);
    if (it == m_tracks.end()) {
        std::cout << "[Timeline] ERROR convertToClipTrack: trackId="
                  << trackId << " not found\n";
        return false;
    }
    it->second.type = TrackInfo::Type::Clip;
    std::cout << "[Timeline] Converted track id=" << trackId << " to Clip\n";
    return true;
}

bool Timeline::setTrackVideoFlipConfig(int trackId, const VideoFlipConfig& config) {
    auto it = m_tracks.find(trackId);
    if (it == m_tracks.end()) {
        std::cout << "[Timeline] ERROR setTrackVideoFlipConfig: trackId="
                  << trackId << " not found\n";
        return false;
    }
    it->second.videoFlipConfig = config;
    std::cout << "[Timeline] Set track id=" << trackId
              << " videoFlipConfig(enabled=" << config.enabled
              << " states=" << config.states.size()
              << " modifier=" << videoFlipModifierTypeToString(config.modifier.type)
              << " startIdx=" << config.startStateIndex << ")\n";
    return true;
}

bool Timeline::setTrackVideoHoldLastFrame(int trackId, bool hold) {
    auto it = m_tracks.find(trackId);
    if (it == m_tracks.end()) {
        std::cout << "[Timeline] ERROR setTrackVideoHoldLastFrame: trackId="
                  << trackId << " not found\n";
        return false;
    }
    it->second.videoHoldLastFrame = hold;
    std::cout << "[Timeline] Set track id=" << trackId
              << " videoHoldLastFrame=" << (hold ? "true" : "false") << "\n";
    return true;
}

bool Timeline::setTrackFxMode(int trackId, TrackFxMode mode) {
    auto it = m_tracks.find(trackId);
    if (it == m_tracks.end()) {
        std::cout << "[Timeline] ERROR setTrackFxMode: trackId="
                  << trackId << " not found\n";
        return false;
    }
    it->second.fxMode = mode;
    std::cout << "[Timeline] Set track id=" << trackId
              << " fxMode=" << trackFxModeToString(mode) << "\n";
    return true;
}

bool Timeline::setTrackGraphState(int trackId, const nlohmann::json& graphState) {
    auto it = m_tracks.find(trackId);
    if (it == m_tracks.end()) {
        std::cout << "[Timeline] ERROR setTrackGraphState: trackId="
                  << trackId << " not found\n";
        return false;
    }
    if (graphState.is_null()) {
        it->second.hasGraphState = false;
        it->second.graphState = nlohmann::json();
    } else {
        it->second.hasGraphState = true;
        it->second.graphState = graphState;
    }
    std::cout << "[Timeline] Set track id=" << trackId
              << " graphState=" << (it->second.hasGraphState ? "present" : "cleared") << "\n";
    return true;
}

bool Timeline::setTrackCornerRadius(int trackId, float radius) {
    auto it = m_tracks.find(trackId);
    if (it == m_tracks.end()) {
        std::cout << "[Timeline] ERROR setTrackCornerRadius: trackId=" << trackId << " not found\n";
        return false;
    }
    it->second.cornerRadius = radius;
    std::cout << "[Timeline] Set track id=" << trackId << " cornerRadius=" << radius << "\n";
    return true;
}

bool Timeline::setTrackGapScaleOverride(int trackId, float gapScale) {
    auto it = m_tracks.find(trackId);
    if (it == m_tracks.end()) {
        std::cout << "[Timeline] ERROR setTrackGapScaleOverride: trackId=" << trackId << " not found\n";
        return false;
    }
    it->second.gapScaleOverride = gapScale;
    std::cout << "[Timeline] Set track id=" << trackId << " gapScaleOverride=" << gapScale << "\n";
    return true;
}

bool Timeline::setTrackSubdivisionFactor(int trackId, int factor) {
    auto it = m_tracks.find(trackId);
    if (it == m_tracks.end()) {
        std::cout << "[Timeline] ERROR setTrackSubdivisionFactor: trackId=" << trackId << " not found\n";
        return false;
    }
    if (factor != 1 && factor != 2 && factor != 4 && factor != 8) {
        std::cout << "[Timeline] ERROR setTrackSubdivisionFactor: invalid factor=" << factor
                  << " (must be 1, 2, 4, or 8)\n";
        return false;
    }
    it->second.subdivisionFactor = factor;
    std::cout << "[Timeline] Set track id=" << trackId << " subdivisionFactor=" << factor << "\n";
    return true;
}

bool Timeline::setTrackColor(int trackId,
                             TrackColorMode mode,
                             int slot,
                             const std::string& customColor) {
    auto it = m_tracks.find(trackId);
    if (it == m_tracks.end()) {
        std::cout << "[Timeline] ERROR setTrackColor: trackId=" << trackId << " not found\n";
        return false;
    }
    // Sanitize: PaletteSlot needs slot 1..16; Custom needs valid #RRGGBB.
    // Any other combination falls back to Auto with cleared slot/custom so
    // corrupted callers cannot leave the project in a bad state.
    const std::string customNorm = normalizeTrackCustomColor(customColor);
    if (mode == TrackColorMode::PaletteSlot && slot >= 1 && slot <= 16) {
        it->second.trackColorMode   = TrackColorMode::PaletteSlot;
        it->second.trackColorSlot   = slot;
        it->second.trackColorCustom.clear();
    } else if (mode == TrackColorMode::Custom && !customNorm.empty()) {
        it->second.trackColorMode   = TrackColorMode::Custom;
        it->second.trackColorSlot   = 0;
        it->second.trackColorCustom = customNorm;
    } else {
        it->second.trackColorMode   = TrackColorMode::Auto;
        it->second.trackColorSlot   = 0;
        it->second.trackColorCustom.clear();
    }
    std::cout << "[Timeline] Set track id=" << trackId
              << " trackColorMode=" << trackColorModeToString(it->second.trackColorMode)
              << " trackColorSlot=" << it->second.trackColorSlot
              << " trackColorCustom=" << it->second.trackColorCustom << "\n";
    return true;
}

bool Timeline::setTrackBounceSettings(int trackId, const BounceSettings& settings) {
    auto it = m_tracks.find(trackId);
    if (it == m_tracks.end()) {
        std::cout << "[Timeline] ERROR setTrackBounceSettings: trackId=" << trackId << " not found\n";
        return false;
    }
    it->second.bounce = settings;
    std::cout << "[Timeline] Set track id=" << trackId
              << " bounce.enabled=" << settings.enabled
              << " dir=" << settings.directionDeg
              << " dist=" << settings.distance << "\n";
    return true;
}

bool Timeline::setTrackZoomPanRotSettings(int trackId, const ZoomPanRotSettings& settings) {
    auto it = m_tracks.find(trackId);
    if (it == m_tracks.end()) return false;
    it->second.zoomPanRot = settings;
    return true;
}

bool Timeline::setTrackPingPongSettings(int trackId, const PingPongSettings& settings) {
    auto it = m_tracks.find(trackId);
    if (it == m_tracks.end()) return false;
    it->second.pingPong = settings;
    return true;
}

bool Timeline::setTrackSlideNoteEffectSettings(int trackId, const SlideNoteEffectSettings& settings) {
    auto it = m_tracks.find(trackId);
    if (it == m_tracks.end()) return false;
    it->second.slideNoteEffect = settings;
    return true;
}

bool Timeline::setNoteSlide(int patternId, int noteId, bool isSlide, float curveCx, float curveCy) {
    auto it = m_patterns.find(patternId);
    if (it == m_patterns.end()) return false;
    for (auto& n : it->second.notes) {
        if (n.id == noteId) {
            n.isSlide      = isSlide;
            n.slideCurveCx = curveCx;
            n.slideCurveCy = curveCy;
            return true;
        }
    }
    return false;
}

// ─── Visual Effect Chain ──────────────────────────────────────────────────────

int Timeline::addVisualEffect(int trackId, VisualEffect::Type type)
{
    auto it = m_tracks.find(trackId);
    if (it == m_tracks.end()) return -1;
    auto& chain = it->second.visualEffectChain;
    if (static_cast<int>(chain.size()) >= 16) return -1;  // enforce max chain length

    VisualEffect fx;
    fx.type     = type;
    fx.bypassed = false;
    // Initialize sensible defaults per effect type
    std::fill(std::begin(fx.params), std::end(fx.params), 0.0f);
    switch (type) {
        case VisualEffect::Type::Desaturation:
            fx.params[0] = 1.0f;   // full desaturation by default
            break;
        case VisualEffect::Type::Tint:
            fx.params[0] = 1.0f;   // r (warm sepia)
            fx.params[1] = 0.85f;  // g
            fx.params[2] = 0.6f;   // b
            fx.params[3] = 0.5f;   // strength
            fx.params[4] = 0.15f;  // lightnessFloor (keeps blacks black)
            fx.params[5] = 1.0f;   // lightnessCeiling (tints everything above floor)
            break;
        case VisualEffect::Type::BrightnessContrast:
            fx.params[0] = 0.0f;   // brightness (neutral)
            fx.params[1] = 0.0f;   // contrast (neutral)
            break;
        case VisualEffect::Type::TVSimulator:
            fx.params[0] = 0.5f;    // intensity
            fx.params[1] = 1.0f;    // rollSpeed
            fx.params[2] = 0.3f;    // scanlineAlpha
            fx.params[3] = 0.003f;  // chromaOffset
            fx.params[4] = 0.0f;    // staticNoise (off by default)
            fx.params[5] = 2.0f;    // jitterFreq
            fx.params[6] = 0.0f;    // colorBleed (off by default)
            break;
        case VisualEffect::Type::ZoomPanRotation:
            fx.params[0]  = 1.0f;       // startZoom
            fx.params[1]  = 1.0f;       // targetZoom
            fx.params[2]  = 0.0f;       // startPanX
            fx.params[3]  = 0.0f;       // startPanY
            fx.params[4]  = 0.0f;       // targetPanX
            fx.params[5]  = 0.0f;       // targetPanY
            fx.params[6]  = 0.0f;       // startRotation (degrees)
            fx.params[7]  = 0.0f;       // targetRotation (degrees)
            fx.params[8]  = 300.0f;     // durationMs
            fx.params[9]  = 1.0f;       // zoomEasing (1=EaseOut)
            fx.params[10] = 1.0f;       // panEasing
            fx.params[11] = 1.0f;       // rotEasing
            fx.params[12] = 1.70158f;   // overshoot
            break;
        default:
            break;
    }
    chain.push_back(fx);
    return static_cast<int>(chain.size()) - 1;
}

bool Timeline::removeVisualEffect(int trackId, int effectIndex)
{
    auto it = m_tracks.find(trackId);
    if (it == m_tracks.end()) return false;
    auto& chain = it->second.visualEffectChain;
    if (effectIndex < 0 || effectIndex >= static_cast<int>(chain.size())) return false;
    chain.erase(chain.begin() + effectIndex);
    return true;
}

bool Timeline::reorderVisualEffect(int trackId, int fromIndex, int toIndex)
{
    auto it = m_tracks.find(trackId);
    if (it == m_tracks.end()) return false;
    auto& chain = it->second.visualEffectChain;
    int sz = static_cast<int>(chain.size());
    if (fromIndex < 0 || fromIndex >= sz) return false;
    if (toIndex   < 0 || toIndex   >= sz) return false;
    if (fromIndex == toIndex) return true;

    VisualEffect moved = chain[fromIndex];
    chain.erase(chain.begin() + fromIndex);
    // Adjust toIndex if it shifted due to the erase
    int insertAt = (toIndex > fromIndex) ? toIndex - 1 : toIndex;
    chain.insert(chain.begin() + insertAt, moved);
    return true;
}

bool Timeline::setTrackVisualEffectChainOrder(int trackId, const std::vector<int>& newOrder)
{
    auto it = m_tracks.find(trackId);
    if (it == m_tracks.end()) return false;
    auto& chain = it->second.visualEffectChain;
    int sz = static_cast<int>(chain.size());
    if (static_cast<int>(newOrder.size()) != sz) return false;
    std::vector<bool> seen(sz, false);
    for (int idx : newOrder) {
        if (idx < 0 || idx >= sz || seen[idx]) return false;
        seen[idx] = true;
    }
    std::vector<VisualEffect> reordered;
    reordered.reserve(sz);
    for (int idx : newOrder) reordered.push_back(chain[idx]);
    chain = std::move(reordered);
    return true;
}

bool Timeline::setVisualEffectParam(int trackId, int effectIndex, int paramIndex, float value)
{
    auto it = m_tracks.find(trackId);
    if (it == m_tracks.end()) return false;
    auto& chain = it->second.visualEffectChain;
    if (effectIndex < 0 || effectIndex >= static_cast<int>(chain.size())) return false;
    if (paramIndex  < 0 || paramIndex  >= 16) return false;
    chain[effectIndex].params[paramIndex] = value;
    return true;
}

bool Timeline::setVisualEffectBypassed(int trackId, int effectIndex, bool bypassed)
{
    auto it = m_tracks.find(trackId);
    if (it == m_tracks.end()) return false;
    auto& chain = it->second.visualEffectChain;
    if (effectIndex < 0 || effectIndex >= static_cast<int>(chain.size())) return false;
    chain[effectIndex].bypassed = bypassed;
    return true;
}

bool Timeline::insertVisualEffectAt(int trackId, int index, const VisualEffect& fx)
{
    auto it = m_tracks.find(trackId);
    if (it == m_tracks.end()) return false;
    auto& chain = it->second.visualEffectChain;
    if (index < 0 || index > static_cast<int>(chain.size())) return false;
    chain.insert(chain.begin() + index, fx);
    return true;
}

const std::vector<VisualEffect>* Timeline::getVisualEffectChain(int trackId) const
{
    auto it = m_tracks.find(trackId);
    if (it == m_tracks.end()) return nullptr;
    return &it->second.visualEffectChain;
}

// ─── Transport ────────────────────────────────────────────────────────────────

void Timeline::setBPM(double bpm) {
    m_bpm = bpm;
    std::cout << "[Timeline] Set BPM=" << bpm << "\n";
}

void Timeline::setSampleRate(double sr) {
    m_sampleRate = sr;
    std::cout << "[Timeline] Set SampleRate=" << sr << "\n";
}

void Timeline::setLoopRegion(const LoopRegion& region, int64_t minLengthTicks) {
    // Mutation-layer invariant enforcement: zero/negative length is unreachable.
    m_loopRegion = normalizeLoopRegion(region, minLengthTicks);
#ifdef XLETH_DEBUG
    std::cout << "[LoopRegion] set start=" << m_loopRegion.startTick
              << " end=" << m_loopRegion.endTick
              << " enabled=" << (m_loopRegion.loopEnabled ? 1 : 0)
              << " minLen=" << minLengthTicks << "\n";
#endif
}

void Timeline::setTimeSignature(int numerator, int denominator) {
    m_timeSigNum = numerator;
    m_timeSigDen = denominator;
    std::cout << "[Timeline] Set TimeSig=" << numerator << "/" << denominator << "\n";
}

void Timeline::setDeclickMs(double ms) {
    m_declickMs = (ms < 0.0) ? 0.0 : (ms > 5.0) ? 5.0 : ms;
}

// ─── Grid Layout ──────────────────────────────────────────────────────────────

void Timeline::syncActiveToVector() {
    auto it = std::find_if(m_gridSnapshots.begin(), m_gridSnapshots.end(),
        [&](const GridSnapshot& s) { return s.id == m_activeSnapshotId; });
    if (it == m_gridSnapshots.end()) return;

    // eventActions are deliberately absent from the flat bridge DTO. Preserve
    // opaque actions for matching placements when a DTO mutation rebuilds them.
    for (auto& slot : m_gridLayout.slots) {
        if (!slot.eventActions.empty()) continue;
        auto old = std::find_if(it->slots.begin(), it->slots.end(),
            [&](const GridSlot& s) { return s.trackId == slot.trackId; });
        if (old != it->slots.end()) slot.eventActions = old->eventActions;
    }
    std::vector<bool> used(it->fullscreenLayers.size(), false);
    for (auto& layer : m_gridLayout.fullscreenLayers) {
        for (size_t i = 0; i < it->fullscreenLayers.size(); ++i) {
            const auto& old = it->fullscreenLayers[i];
            if (!used[i] && old.trackId == layer.trackId
                && old.placement == layer.placement) {
                used[i] = true;
                if (layer.eventActions.empty())
                    layer.eventActions = old.eventActions;
                break;
            }
        }
    }
    *it = makeGridSnapshot(m_gridLayout, it->id, it->name);
}

void Timeline::materializeActive() {
    auto it = std::find_if(m_gridSnapshots.begin(), m_gridSnapshots.end(),
        [&](const GridSnapshot& s) { return s.id == m_activeSnapshotId; });
    if (it == m_gridSnapshots.end()) {
        if (m_gridSnapshots.empty()) {
            m_activeSnapshotId = generateSnapshotId();
            m_activeSnapshotName = "Base";
            m_gridSnapshots.push_back(
                makeGridSnapshot(m_gridLayout, m_activeSnapshotId, m_activeSnapshotName));
            it = m_gridSnapshots.begin();
        } else {
            // Invalid persisted activeSnapshotId clamps to the first entry.
            it = m_gridSnapshots.begin();
            m_activeSnapshotId = it->id;
        }
    }
    m_activeSnapshotName = it->name;
    applyGridSnapshot(m_gridLayout, *it);
    for (const auto& layer : m_gridLayout.fullscreenLayers) {
        if (layer.placement != FullscreenLayerPlacement::BehindGrid
            || layer.trackId < 0) continue;
        auto track = m_tracks.find(layer.trackId);
        if (track != m_tracks.end()) track->second.videoHoldLastFrame = true;
    }
}

std::string Timeline::createGridSnapshot(bool cloneActive, const std::string& name) {
    GridSnapshot snap;
    if (cloneActive) {
        auto active = std::find_if(m_gridSnapshots.begin(), m_gridSnapshots.end(),
            [&](const GridSnapshot& s) { return s.id == m_activeSnapshotId; });
        snap = (active != m_gridSnapshots.end())
             ? *active : makeGridSnapshot(m_gridLayout, {}, {});
    } else {
        snap.columns = m_gridLayout.columns;
        snap.rows = m_gridLayout.rows;
        snap.gapScale = m_gridLayout.gapScale;
    }
    snap.id = generateSnapshotId();
    snap.name = name;
    m_gridSnapshots.push_back(std::move(snap));
    m_activeSnapshotId = m_gridSnapshots.back().id;
    m_activeSnapshotName = m_gridSnapshots.back().name;
    materializeActive();
    return m_activeSnapshotId;
}

bool Timeline::renameGridSnapshot(const std::string& id, const std::string& name) {
    auto it = std::find_if(m_gridSnapshots.begin(), m_gridSnapshots.end(),
        [&](const GridSnapshot& s) { return s.id == id; });
    if (it == m_gridSnapshots.end()) return false; // unknown id: zero mutation
    it->name = name; // duplicate display names are intentionally allowed
    if (id == m_activeSnapshotId) m_activeSnapshotName = name;
    return true;
}

bool Timeline::deleteGridSnapshot(const std::string& id) {
    auto it = std::find_if(m_gridSnapshots.begin(), m_gridSnapshots.end(),
        [&](const GridSnapshot& s) { return s.id == id; });
    if (it == m_gridSnapshots.end()) return false; // unknown id: zero mutation
    if (m_gridSnapshots.size() == 1) return false; // block last-snapshot deletion
    const bool deletingActive = id == m_activeSnapshotId;
    m_gridSnapshots.erase(it);
    // Prune every cue that referenced the deleted snapshot so the render-path
    // resolver never sees a dangling id (it tolerates one, but we don't keep it).
    m_gridCues.erase(std::remove_if(m_gridCues.begin(), m_gridCues.end(),
        [&](const GridCue& cue) { return cue.snapshotId == id; }),
        m_gridCues.end());
    // If the deleted snapshot was the default ("Base"), re-point the default to
    // the first survivor so gridLayoutAt keeps a valid explicit fallback.
    if (id == m_defaultSnapshotId && !m_gridSnapshots.empty())
        m_defaultSnapshotId = m_gridSnapshots.front().id;
    if (deletingActive) {
        // Active deletion selects the first survivor and rematerializes its DTO.
        m_activeSnapshotId = m_gridSnapshots.front().id;
        m_activeSnapshotName = m_gridSnapshots.front().name;
        materializeActive();
    }
    return true;
}

bool Timeline::setActiveGridSnapshot(const std::string& id) {
    auto it = std::find_if(m_gridSnapshots.begin(), m_gridSnapshots.end(),
        [&](const GridSnapshot& s) { return s.id == id; });
    if (it == m_gridSnapshots.end()) return false; // unknown id: zero mutation
    m_activeSnapshotId = it->id;
    m_activeSnapshotName = it->name;
    materializeActive();
    return true;
}

const GridSnapshot* Timeline::findSnapshot(const std::string& id) const {
    if (id.empty()) return nullptr;
    for (const auto& s : m_gridSnapshots)
        if (s.id == id) return &s;
    return nullptr;
}

// ── Time-based snapshot resolution (RENDER path only) ─────────────────────────
GridLayout Timeline::gridLayoutAt(TickTime t) const {
    // Start from the flat active layout: this seeds the GLOBAL fields
    // (canvas*, previewFps) — identical regardless of tick — which do NOT live
    // on snapshots. The arrangement portion is then overwritten below by the
    // resolved snapshot (or left as the active arrangement if nothing resolves).
    // This is a value copy the caller (render thread) owns outright; we never
    // return a reference into m_gridLayout.
    GridLayout out = m_gridLayout;

    // Walk cues in ascending tick order, keeping the LAST cue whose tick <= t
    // that still resolves to a live snapshot. A cue pointing at a deleted
    // snapshot is skipped (treated as absent), so the previous valid cue wins.
    const GridSnapshot* chosen = nullptr;
    for (const auto& cue : m_gridCues) {
        if (cue.tick > t) break;                 // cues are sorted; no later match
        if (const GridSnapshot* s = findSnapshot(cue.snapshotId))
            chosen = s;
    }

    // No cue at/before t (or all such cues dangled) → the default ("Base")
    // snapshot, falling back to the first live snapshot when the default id is
    // absent or dangling.
    if (!chosen) {
        chosen = findSnapshot(m_defaultSnapshotId);
        if (!chosen && !m_gridSnapshots.empty())
            chosen = &m_gridSnapshots.front();
    }

    // applyGridSnapshot overwrites ONLY the arrangement (columns/rows/gapScale/
    // slots/fullscreenLayers), leaving the global fields seeded above untouched.
    // GridSlot/FullscreenLayer eventActions ride along via the snapshot copy.
    if (chosen) applyGridSnapshot(out, *chosen);
    return out;
}

void Timeline::addGridCue(TickTime tick, const std::string& snapshotId) {
    auto pos = std::lower_bound(m_gridCues.begin(), m_gridCues.end(), tick,
        [](const GridCue& c, TickTime tk) { return c.tick < tk; });
    if (pos != m_gridCues.end() && pos->tick == tick)
        pos->snapshotId = snapshotId;            // replace the cue at this exact tick
    else
        m_gridCues.insert(pos, GridCue{ tick, snapshotId });
}

bool Timeline::moveGridCue(TickTime oldTick, TickTime newTick) {
    auto pos = std::lower_bound(m_gridCues.begin(), m_gridCues.end(), oldTick,
        [](const GridCue& c, TickTime tk) { return c.tick < tk; });
    if (pos == m_gridCues.end() || !(pos->tick == oldTick)) return false;
    if (oldTick == newTick) return true;         // no-op move
    std::string id = std::move(pos->snapshotId);
    m_gridCues.erase(pos);
    addGridCue(newTick, id);                     // sorted insert; replaces on collision
    return true;
}

bool Timeline::removeGridCue(TickTime tick) {
    auto pos = std::lower_bound(m_gridCues.begin(), m_gridCues.end(), tick,
        [](const GridCue& c, TickTime tk) { return c.tick < tk; });
    if (pos == m_gridCues.end() || !(pos->tick == tick)) return false;
    m_gridCues.erase(pos);
    return true;
}

void Timeline::setCueTransition(TickTime cueTick, const SnapshotTransition& tr) {
    auto pos = std::lower_bound(m_gridCues.begin(), m_gridCues.end(), cueTick,
        [](const GridCue& c, TickTime tk) { return c.tick < tk; });
    if (pos == m_gridCues.end() || !(pos->tick == cueTick)) return;  // no cue here
    pos->transition = tr;
}

// ── Time-based transition resolution (RENDER path only) ───────────────────────
Timeline::ResolvedTransition Timeline::transitionAt(TickTime t) const {
    ResolvedTransition out;

    // Cues are tick-sorted; scan for the LATEST-pinned enabled window that
    // contains t. "Latest wins" mirrors gridLayoutAt so overlapping windows
    // resolve consistently. We take a value copy of the winning cue's transition
    // fields — never a pointer into m_gridCues — before touching layouts.
    const GridCue* winner = nullptr;
    for (const auto& cue : m_gridCues) {
        if (!cue.transition.enabled) continue;
        const TickTime start{ cue.tick.ticks - cue.transition.startOffsetTicks };
        const TickTime end  { cue.tick.ticks + cue.transition.endOffsetTicks };
        if (t >= start && t <= end)
            winner = &cue;                       // keep scanning; later pin overrides
    }
    if (!winner) return out;                     // active stays false

    // Copy scalar fields by value, then release the pointer conceptually: the
    // gridLayoutAt calls below only read stable snapshot/cue data.
    const SnapshotTransition tr = winner->transition;
    out.active         = true;
    out.pinTick        = winner->tick;
    out.startTick      = TickTime{ winner->tick.ticks - tr.startOffsetTicks };
    out.endTick        = TickTime{ winner->tick.ticks + tr.endOffsetTicks };
    out.type           = tr.type;
    out.freezeOutgoing = tr.freezeOutgoing;
    out.geomAngleDeg   = tr.geomAngleDeg;

    // Outgoing = the arrangement just BEFORE the pin; incoming = at the pin. Each
    // resolves through gridLayoutAt (by value), so layoutA/layoutB carry their own
    // columns/rows/gapScale.
    out.layoutA = gridLayoutAt(TickTime{ winner->tick.ticks - 1 });
    out.layoutB = gridLayoutAt(winner->tick);
    return out;
}

void Timeline::setGridLayout(const GridLayout& layout) {
    m_gridLayout = layout;
    syncActiveToVector();
    std::cout << "[Timeline] Set GridLayout " << layout.columns << "x" << layout.rows
              << " slots=" << layout.slots.size()
              << " fsLayers=" << layout.fullscreenLayers.size()
              << " fps=" << layout.previewFps << "\n";
}

void Timeline::assignTrackToGrid(int trackId, int gridX, int gridY, int spanX, int spanY) {
    // Remove any existing slot for this track first (move semantics).
    m_gridLayout.slots.erase(
        std::remove_if(m_gridLayout.slots.begin(), m_gridLayout.slots.end(),
                       [trackId](const GridSlot& s) { return s.trackId == trackId; }),
        m_gridLayout.slots.end());

    GridSlot s;
    s.trackId = trackId;
    s.gridX   = gridX;
    s.gridY   = gridY;
    s.spanX   = spanX;
    s.spanY   = spanY;
    s.opacity = 1.0f;
    s.zOrder  = 0;
    m_gridLayout.slots.push_back(s);
    syncActiveToVector();
    std::cout << "[Timeline] Grid assign track " << trackId
              << " @ (" << gridX << "," << gridY << ") span "
              << spanX << "x" << spanY << "\n";
}

void Timeline::assignTrackToGridWithZOrder(int trackId, int gridX, int gridY,
                                            int spanX, int spanY, int zOrder) {
    // Same move semantics as assignTrackToGrid — drop any prior slot for the
    // same track, then insert the new one. The only difference is that
    // zOrder is supplied by the caller instead of hardcoded to 0.
    m_gridLayout.slots.erase(
        std::remove_if(m_gridLayout.slots.begin(), m_gridLayout.slots.end(),
                       [trackId](const GridSlot& s) { return s.trackId == trackId; }),
        m_gridLayout.slots.end());

    GridSlot s;
    s.trackId = trackId;
    s.gridX   = gridX;
    s.gridY   = gridY;
    s.spanX   = spanX;
    s.spanY   = spanY;
    s.opacity = 1.0f;
    s.zOrder  = zOrder;
    m_gridLayout.slots.push_back(s);
    syncActiveToVector();
    std::cout << "[Timeline] Grid assign track " << trackId
              << " @ (" << gridX << "," << gridY << ") span "
              << spanX << "x" << spanY << " zOrder " << zOrder << "\n";
}

void Timeline::removeTrackFromGrid(int trackId) {
    auto before = m_gridLayout.slots.size();
    m_gridLayout.slots.erase(
        std::remove_if(m_gridLayout.slots.begin(), m_gridLayout.slots.end(),
                       [trackId](const GridSlot& s) { return s.trackId == trackId; }),
        m_gridLayout.slots.end());
    syncActiveToVector();
    std::cout << "[Timeline] Grid remove track " << trackId
              << " (removed " << (before - m_gridLayout.slots.size()) << " slot(s))\n";
}

Timeline::PlacementKind Timeline::setPlacementZOrder(int trackId, int zOrder) {
    // Grid placement wins (a track is grid-slotted OR fullscreen, never both).
    for (auto& s : m_gridLayout.slots) {
        if (s.trackId == trackId) {
            s.zOrder = zOrder;
            syncActiveToVector();
            std::cout << "[Timeline] Set placement zOrder track " << trackId
                      << " (grid) = " << zOrder << "\n";
            return PlacementKind::Grid;
        }
    }
    bool touched = false;
    for (auto& fl : m_gridLayout.fullscreenLayers) {
        if (fl.trackId == trackId) { fl.zOrder = zOrder; touched = true; }
    }
    if (touched) {
        syncActiveToVector();
        std::cout << "[Timeline] Set placement zOrder track " << trackId
                  << " (fullscreen) = " << zOrder << "\n";
        return PlacementKind::Fullscreen;
    }
    return PlacementKind::None;
}

void Timeline::setFullscreenLayers(std::vector<FullscreenLayer> layers) {
    m_gridLayout.fullscreenLayers = std::move(layers);
    syncActiveToVector();
    // Auto-enable hold-last-frame on every BehindGrid layer's track — every
    // Sparta Remix expects the backdrop to persist through gaps.
    for (const auto& fl : m_gridLayout.fullscreenLayers) {
        if (fl.placement != FullscreenLayerPlacement::BehindGrid) continue;
        if (fl.trackId < 0) continue;
        auto it = m_tracks.find(fl.trackId);
        if (it != m_tracks.end())
            it->second.videoHoldLastFrame = true;
    }
    std::cout << "[Timeline] Set fullscreen layers count="
              << m_gridLayout.fullscreenLayers.size() << "\n";
}

void Timeline::removeFullscreenLayersForTrack(int trackId) {
    auto& v = m_gridLayout.fullscreenLayers;
    auto before = v.size();
    v.erase(std::remove_if(v.begin(), v.end(),
                [trackId](const FullscreenLayer& fl) { return fl.trackId == trackId; }),
            v.end());
    syncActiveToVector();
    std::cout << "[Timeline] Removed " << (before - v.size())
              << " fullscreen layer(s) for track " << trackId << "\n";
}

void Timeline::restoreFullscreenLayer(size_t index, const FullscreenLayer& layer) {
    auto& v = m_gridLayout.fullscreenLayers;
    if (index > v.size()) index = v.size();
    v.insert(v.begin() + static_cast<std::ptrdiff_t>(index), layer);
    syncActiveToVector();
    if (layer.placement == FullscreenLayerPlacement::BehindGrid && layer.trackId >= 0) {
        auto it = m_tracks.find(layer.trackId);
        if (it != m_tracks.end())
            it->second.videoHoldLastFrame = true;
    }
}

void Timeline::setPreviewFps(int fps) {
    if (fps < 1)   fps = 1;
    if (fps > 120) fps = 120;
    m_gridLayout.previewFps = fps;
    std::cout << "[Timeline] Set preview FPS=" << fps << "\n";
}

void Timeline::setGlobalStretchMethod(int method) {
    m_globalStretchMethod = sanitizeProjectGlobalStretchMethod(method);
}

// ─── Restore (undo/redo) ──────────────────────────────────────────────────────

bool Timeline::restoreClip(const Clip& clip) {
    Clip normalized = clip;
    normalizeClipFadePercents(normalized);
    m_clips[normalized.id] = normalized;
    if (normalized.id >= m_nextId) m_nextId = normalized.id + 1;
    std::cout << "[Timeline] Restored clip id=" << clip.id
              << " trackId=" << clip.trackId
              << " regionId=" << clip.regionId
              << " position=" << clip.position.ticks << "\n";
    // Same contract as addClip: undo/redo must re-queue the render cache, or
    // a redone paste leaves the clip present but with stale/absent cache slot.
    if (m_clipCacheInvalidator) {
        m_clipCacheInvalidator(clip.id, "restoreClip");
    }
#ifdef XLETH_DEBUG
    fprintf(stderr,
        "[CacheQueue] restoreClip clip=%d enqueued "
        "(stretch=%.3f reversed=%d pitch=%d cents=%d)\n",
        clip.id, clip.stretchRatio, clip.reversed ? 1 : 0,
        clip.pitchOffset, clip.pitchOffsetCents);
    fflush(stderr);
#endif
    return true;
}

bool Timeline::restoreTrack(const TrackInfo& track) {
    m_tracks[track.id] = track;
    if (track.id >= m_nextId) m_nextId = track.id + 1;
    std::cout << "[Timeline] Restored track id=" << track.id
              << " name=\"" << track.name << "\"\n";
    return true;
}

bool Timeline::restoreRegion(const SampleRegion& region) {
    m_regions[region.id] = region;
    if (region.id >= m_nextId) m_nextId = region.id + 1;
    std::cout << "[Timeline] Restored region id=" << region.id
              << " name=\"" << region.name << "\"\n";
    return true;
}

bool Timeline::restorePattern(const Pattern& pattern) {
    m_patterns[pattern.id] = pattern;
    if (pattern.id >= m_nextId) m_nextId = pattern.id + 1;
    std::cout << "[Timeline] Restored pattern id=" << pattern.id
              << " name=\"" << pattern.name << "\""
              << " notes=" << pattern.notes.size() << "\n";
    return true;
}

bool Timeline::restorePatternBlock(const PatternBlock& block) {
    m_patternBlocks[block.id] = block;
    if (block.id >= m_nextId) m_nextId = block.id + 1;
    std::cout << "[Timeline] Restored patternBlock id=" << block.id
              << " trackId=" << block.trackId
              << " patternId=" << block.patternId << "\n";
    return true;
}

bool Timeline::restoreNoteInPattern(int patternId, const PatternNote& note) {
    auto it = m_patterns.find(patternId);
    if (it == m_patterns.end()) {
        std::cout << "[Timeline] ERROR restoreNoteInPattern: patternId="
                  << patternId << " not found\n";
        return false;
    }
    // Keep nextNoteId ahead of any restored note's id.
    if (note.id >= it->second.nextNoteId) it->second.nextNoteId = note.id + 1;
    it->second.notes.push_back(note);
    std::cout << "[Timeline] Restored note id=" << note.id
              << " in pattern=" << patternId << "\n";
    recalcPatternLength(patternId);
    return true;
}

// ─── Serialization ────────────────────────────────────────────────────────────

nlohmann::json Timeline::toJSON() const {
    nlohmann::json j;
    j["projectFileVersion"] = kProjectFileVersion;
    j["bpm"]           = m_bpm;
    j["sampleRate"]    = m_sampleRate;
    j["timeSigNum"]    = m_timeSigNum;
    j["timeSigDen"]    = m_timeSigDen;
    j["declickMs"]     = m_declickMs;
    j["globalStretchMethod"] = m_globalStretchMethod;
    j["tempoLocked"]   = m_tempoLocked;
    j["nextId"]        = m_nextId;

    j["sources"] = nlohmann::json::array();
    for (const auto& [id, src] : m_sources) {
        nlohmann::json s;
        sourceToJson(s, src);
        j["sources"].push_back(s);
    }

    j["regions"] = nlohmann::json::array();
    for (const auto& [id, r] : m_regions) {
        nlohmann::json rj = r;  // ADL calls to_json(j, const SampleRegion&)
        j["regions"].push_back(rj);
    }

    j["tracks"] = nlohmann::json::array();
    for (const auto& [id, t] : m_tracks) {
        nlohmann::json tj = t;  // ADL calls to_json(j, const TrackInfo&)
        j["tracks"].push_back(tj);
    }

    j["clips"] = nlohmann::json::array();
    for (const auto& [id, c] : m_clips) {
        nlohmann::json cj = c;  // ADL calls to_json(j, const Clip&)
        j["clips"].push_back(cj);
    }

    j["patterns"] = nlohmann::json::array();
    for (const auto& [id, p] : m_patterns) {
        nlohmann::json pj = p;  // ADL calls to_json(j, const Pattern&)
        j["patterns"].push_back(pj);
    }

    j["patternBlocks"] = nlohmann::json::array();
    for (const auto& [id, b] : m_patternBlocks) {
        nlohmann::json bj = b;  // ADL calls to_json(j, const PatternBlock&)
        j["patternBlocks"].push_back(bj);
    }

    // ── Grid layout — snapshot container ──────────────────────────────────────
    // The persisted `gridLayout` is a snapshot container, not the flat GridLayout:
    //   • GLOBAL fields (canvas*, previewFps) stay at the container top level;
    //   • the arrangement (columns/rows/gapScale/slots/fullscreenLayers) is nested
    //     inside snapshots[] for every live snapshot,
    //     from the live authoritative vector (N entries supported);
    //   • activeSnapshotId names the active entry; cues[] is reserved (empty now).
    // The flat GridLayout is recovered on load by applyGridSnapshot() (see
    // fromJSON), so this shape change is invisible to every runtime consumer.
    // Legacy loaders that expect the old flat shape are gone (the engine owns
    // project.json); readers of THIS build detect the container via `snapshots`.
    nlohmann::json gl;
    // gridLayoutVersion: 3 == fine-grid coords + unified fullscreenLayers. The
    // snapshot container is detected structurally (presence of `snapshots`), so
    // no version bump is required; v<2 slot-coordinate migration still keys off
    // this value on the legacy flat path in fromJSON.
    gl["gridLayoutVersion"] = kGridLayoutVersionFineUnits;
    // GLOBAL project video canvas + preview/frame rate — one per project, never
    // per-snapshot. Absent fields default on load for old projects.
    gl["canvasWidth"]        = m_gridLayout.canvasWidth;
    gl["canvasHeight"]       = m_gridLayout.canvasHeight;
    gl["canvasAspectRatio"]  = m_gridLayout.canvasAspectRatio;
    gl["previewFps"]         = m_gridLayout.previewFps;
    gl["activeSnapshotId"]   = m_activeSnapshotId;
    // Default ("Base") snapshot id — the render-path fallback before the first
    // cue. Persisted explicitly so it is stable across edits (not index 0).
    gl["defaultSnapshotId"]  = m_defaultSnapshotId;

    // Serialize every live snapshot; the flat active layout is only a cache.
    gl["snapshots"] = nlohmann::json::array();
    for (const auto& active : m_gridSnapshots) {

    nlohmann::json snapJson;
    snapJson["id"]       = active.id;
    snapJson["name"]     = active.name;
    snapJson["columns"]  = active.columns;
    snapJson["rows"]     = active.rows;
    snapJson["gapScale"] = active.gapScale;
    snapJson["fullscreenLayers"] = nlohmann::json::array();
    for (const auto& fl : active.fullscreenLayers) {
        nlohmann::json flj;
        flj["trackId"]   = fl.trackId;
        flj["placement"] = (fl.placement == FullscreenLayerPlacement::BehindGrid)
                              ? "behind" : "front";
        flj["opacity"]   = fl.opacity;
        // zOrder: the global compositing key. New readers use it verbatim so a
        // project that interleaves a fullscreen layer between grid cells round-
        // trips exactly. Its absence is what triggers load-time canonicalization.
        flj["zOrder"]    = fl.zOrder;
        // Reserved keyframe seam — empty today; round-tripped for forward compat.
        flj["eventActions"] = fl.eventActions;
        snapJson["fullscreenLayers"].push_back(flj);
    }
    snapJson["slots"] = nlohmann::json::array();
    for (const auto& s : active.slots) {
        nlohmann::json sj;
        sj["trackId"] = s.trackId;
        sj["gridX"]   = s.gridX;
        sj["gridY"]   = s.gridY;
        sj["spanX"]   = s.spanX;
        sj["spanY"]   = s.spanY;
        sj["opacity"] = s.opacity;
        sj["zOrder"]  = s.zOrder;
        // Reserved keyframe seam — empty today; round-tripped for forward compat.
        sj["eventActions"] = s.eventActions;
        snapJson["slots"].push_back(sj);
    }

        gl["snapshots"].push_back(std::move(snapJson));
    }
    // Typed snapshot cue list (time-based render automation). Serialized as an
    // array of { tick, snapshotId }; empty when the project has no cues. A cue's
    // boundary animation is written ADDITIVELY as a `transition` object and ONLY
    // when enabled — a hard cut omits the key entirely, so pre-transition
    // projects round-trip byte-for-byte and forward-load unchanged.
    gl["cues"] = nlohmann::json::array();
    for (const auto& cue : m_gridCues) {
        nlohmann::json cj;
        cj["tick"]       = cue.tick.ticks;
        cj["snapshotId"] = cue.snapshotId;
        if (cue.transition.enabled) {
            nlohmann::json tj;
            tj["enabled"]          = cue.transition.enabled;
            tj["startOffsetTicks"] = cue.transition.startOffsetTicks;
            tj["endOffsetTicks"]   = cue.transition.endOffsetTicks;
            tj["type"]             = snapshotTransitionTypeToString(cue.transition.type);
            tj["freezeOutgoing"]   = cue.transition.freezeOutgoing;
            tj["geomAngleDeg"]     = cue.transition.geomAngleDeg;
            cj["transition"] = std::move(tj);
        }
        gl["cues"].push_back(std::move(cj));
    }
    j["gridLayout"] = gl;

    // Loop / render region (single global). renderScoped is derived, never
    // serialized. tail* / renderOrigin are inert Phase-1 fields persisted for
    // forward compatibility.
    nlohmann::json lr;
    lr["startTick"]       = m_loopRegion.startTick;
    lr["endTick"]         = m_loopRegion.endTick;
    lr["loopEnabled"]     = m_loopRegion.loopEnabled;
    lr["renderOrigin"]    = loopRenderOriginToString(m_loopRegion.renderOrigin);
    lr["tailMode"]        = loopTailModeToString(m_loopRegion.tailMode);
    lr["tailThresholdDb"] = m_loopRegion.tailThresholdDb;
    lr["tailMaxSeconds"]  = m_loopRegion.tailMaxSeconds;
    j["loopRegion"] = lr;

    std::cout << "[Timeline] Serialized: "
              << m_sources.size()       << " sources, "
              << m_regions.size()       << " regions, "
              << m_tracks.size()        << " tracks, "
              << m_clips.size()         << " clips, "
              << m_patterns.size()      << " patterns, "
              << m_patternBlocks.size() << " patternBlocks\n";
    return j;
}

bool Timeline::fromJSON(const nlohmann::json& j) {
    try {
        const int fileVersion = j.value("projectFileVersion", 1);
        if (fileVersion < kProjectFileVersion) {
            std::cout << "[Timeline] Loading project file v" << fileVersion
                      << " (current=" << kProjectFileVersion
                      << "); legacy fields will be migrated on save.\n";
        }
        j.at("bpm").get_to(m_bpm);
        j.at("sampleRate").get_to(m_sampleRate);
        j.at("timeSigNum").get_to(m_timeSigNum);
        j.at("timeSigDen").get_to(m_timeSigDen);
        j.at("nextId").get_to(m_nextId);
        if (j.contains("declickMs"))
            j.at("declickMs").get_to(m_declickMs);
        else
            m_declickMs = 0.0; // old project: default disabled (backward-compat)
        if (j.contains("tempoLocked"))
            j.at("tempoLocked").get_to(m_tempoLocked);
        else
            m_tempoLocked = true; // old project: default on (preserves prior behavior)
        setGlobalStretchMethod(j.value("globalStretchMethod",
            static_cast<int>(StretchMethod::PSOLA)));

        m_sources.clear();
        for (const auto& s : j.at("sources")) {
            SourceMedia src;
            sourceFromJson(s, src);
            m_sources[src.id] = src;
        }

        m_regions.clear();
        for (const auto& r : j.at("regions")) {
            SampleRegion region = r.get<SampleRegion>();  // ADL from_json
            m_regions[region.id] = region;
        }

        m_tracks.clear();
        for (const auto& t : j.at("tracks")) {
            TrackInfo track = t.get<TrackInfo>();  // ADL from_json
            m_tracks[track.id] = track;
        }

        m_clips.clear();
        // Project-load bulk insert: intentionally bypasses addClip/restoreClip
        // (and therefore m_clipCacheInvalidator). Cache enqueue for loaded
        // clips is handled in bulk by refreshAllClipCaches() which the bridge
        // calls after deserialization completes. Going through the per-clip
        // callback here would fire thousands of redundant invalidations before
        // MixEngine's Timeline pointer and region audio are even in place.
        for (const auto& c : j.at("clips")) {
            Clip clip = c.get<Clip>();  // ADL from_json
            m_clips[clip.id] = clip;
        }

        m_patterns.clear();
        // Track which regions we've already migrated to so a second pattern
        // referencing the same region doesn't clobber values with possibly
        // divergent legacy settings (first pattern wins; log if divergent).
        std::set<int> migratedRegions;
        if (j.contains("patterns")) {
            for (const auto& pj : j.at("patterns")) {
                Pattern p = pj.get<Pattern>();  // ADL from_json
                m_patterns[p.id] = p;

                // ── Legacy migration: sampler fields moved Pattern → SampleRegion.
                // If this pattern JSON carries any of the old per-pattern sampler
                // fields, copy them onto the matching region (first writer wins).
                const bool legacy = pj.contains("rootNote") || pj.contains("attackMs")
                                 || pj.contains("decayMs")  || pj.contains("sustain")
                                 || pj.contains("releaseMs") || pj.contains("loopEnabled")
                                 || pj.contains("loopStart") || pj.contains("loopEnd")
                                 || pj.contains("crossfadeEnabled");
                if (!legacy) continue;
                auto rit = m_regions.find(p.regionId);
                if (rit == m_regions.end()) continue;
                SampleRegion& r = rit->second;
                if (migratedRegions.count(p.regionId)) {
                    std::cout << "[Timeline] WARN legacy sampler migration: pattern "
                              << p.id << " has sampler fields but region " << p.regionId
                              << " already migrated from another pattern; ignoring\n";
                    continue;
                }
                migratedRegions.insert(p.regionId);
                if (pj.contains("rootNote"))         pj.at("rootNote").get_to(r.rootNote);
                if (pj.contains("attackMs"))         pj.at("attackMs").get_to(r.attackMs);
                if (pj.contains("decayMs"))          pj.at("decayMs").get_to(r.decayMs);
                if (pj.contains("sustain"))          pj.at("sustain").get_to(r.sustain);
                if (pj.contains("releaseMs"))        pj.at("releaseMs").get_to(r.releaseMs);
                if (pj.contains("loopEnabled"))      pj.at("loopEnabled").get_to(r.loopEnabled);
                if (pj.contains("loopStart"))        pj.at("loopStart").get_to(r.loopStart);
                if (pj.contains("loopEnd"))          pj.at("loopEnd").get_to(r.loopEnd);
                if (pj.contains("crossfadeEnabled")) pj.at("crossfadeEnabled").get_to(r.crossfadeEnabled);
            }
        }

        m_patternBlocks.clear();
        if (j.contains("patternBlocks")) {
            for (const auto& bj : j.at("patternBlocks")) {
                PatternBlock b = bj.get<PatternBlock>();  // ADL from_json
                m_patternBlocks[b.id] = b;
            }
        }

        // ── Grid layout — snapshot container (+ legacy flat migration) ────────
        // The persisted `gridLayout` is a snapshot container (see toJSON). This
        // build loads every snapshot and materializes the ACTIVE entry into the
        // unchanged flat m_gridLayout cache. Pre-snapshot
        // project files carry the arrangement fields (columns/rows/slots/
        // fullscreenLayers or the even older chorus/crash flats) directly on the
        // gridLayout object with no `snapshots` array — those are wrapped as the
        // single "Base" snapshot, so old projects load and render identically.
        m_gridLayout         = GridLayout{};          // reset to defaults
        m_activeSnapshotId   = generateSnapshotId();  // fresh Base identity unless a
        m_activeSnapshotName = "Base";                // snapshot supplies its own
        m_defaultSnapshotId  = m_activeSnapshotId;    // overridden by gl below / validated
        m_gridSnapshots.clear();
        m_gridCues.clear();
        if (j.contains("gridLayout")) {
            const auto& gl = j.at("gridLayout");

            // GLOBAL fields live at the container top level in BOTH the snapshot
            // format and the pre-snapshot flat format, so read them the same way.
            // Old projects (pre-canvas) omit the canvas fields; the GridLayout
            // defaults (1920×1080 / "16:9") then stand. Dimensions normalize to
            // the supported even-pixel range so a corrupt value can't reach the
            // encoder.
            if (gl.contains("previewFps"))    gl.at("previewFps").get_to(m_gridLayout.previewFps);
            if (gl.contains("canvasWidth"))
                m_gridLayout.canvasWidth = normalizeCanvasDim(
                    gl.value("canvasWidth", m_gridLayout.canvasWidth),
                    kCanvasMinWidth, kCanvasMaxWidth);
            if (gl.contains("canvasHeight"))
                m_gridLayout.canvasHeight = normalizeCanvasDim(
                    gl.value("canvasHeight", m_gridLayout.canvasHeight),
                    kCanvasMinHeight, kCanvasMaxHeight);
            if (gl.contains("canvasAspectRatio") && gl.at("canvasAspectRatio").is_string())
                gl.at("canvasAspectRatio").get_to(m_gridLayout.canvasAspectRatio);

            // Persisted default ("Base") snapshot id; validated against the loaded
            // snapshot set after they are parsed (falls back to the first snapshot).
            if (gl.contains("defaultSnapshotId") && gl.at("defaultSnapshotId").is_string())
                gl.at("defaultSnapshotId").get_to(m_defaultSnapshotId);

            // Typed snapshot cue list. Parse { tick, snapshotId } entries; tolerate
            // an empty/legacy array (the pre-typed stub always wrote []). Entries
            // without a usable snapshotId are dropped; dangling snapshot refs are
            // kept (the resolver skips them and deleteGridSnapshot prunes them).
            if (gl.contains("cues") && gl.at("cues").is_array()) {
                for (const auto& c : gl.at("cues")) {
                    if (!c.is_object()) continue;
                    GridCue cue;
                    if (c.contains("tick") && c.at("tick").is_number())
                        cue.tick.ticks = c.at("tick").get<int64_t>();
                    cue.snapshotId = c.value("snapshotId", std::string());
                    if (cue.snapshotId.empty()) continue;   // unusable / legacy stub
                    // Additive transition object; absent => hard cut (default).
                    if (c.contains("transition") && c.at("transition").is_object()) {
                        const auto& tj = c.at("transition");
                        SnapshotTransition tr;
                        tr.enabled          = tj.value("enabled", false);
                        tr.startOffsetTicks = tj.value("startOffsetTicks", int64_t{0});
                        tr.endOffsetTicks   = tj.value("endOffsetTicks",   int64_t{0});
                        tr.type             = stringToSnapshotTransitionType(
                                                  tj.value("type", std::string("crossfade")));
                        tr.freezeOutgoing   = tj.value("freezeOutgoing", true);
                        tr.geomAngleDeg     = tj.value("geomAngleDeg", 0.0f);
                        cue.transition = tr;
                    }
                    m_gridCues.push_back(std::move(cue));
                }
                // Enforce the sorted-by-tick invariant regardless of file order.
                std::stable_sort(m_gridCues.begin(), m_gridCues.end(),
                    [](const GridCue& a, const GridCue& b) { return a.tick < b.tick; });
            }

            // Tracks whether ANY fullscreen layer arrived without a per-layer
            // zOrder. Old files (pre-unified-zOrder) and the legacy chorus/crash
            // synthesis path have none, so their draw order must be reconstructed
            // from placement + array order via assignCanonicalFullscreenZOrders
            // once the grid slots are known (done after the slots block below).
            bool anyLayerMissingZOrder = false;

            // Parse one fullscreen-layer JSON object into the active layout,
            // dropping dangling track refs. Shared by both formats (the legacy
            // format simply lacks the eventActions key, which is guarded).
            auto parseFullscreenLayer = [&](const nlohmann::json& flj) {
                FullscreenLayer fl;
                if (flj.contains("trackId") && flj.at("trackId").is_number())
                    flj.at("trackId").get_to(fl.trackId);
                if (flj.contains("placement") && flj.at("placement").is_string()) {
                    // Unknown placement strings default to BehindGrid for forward
                    // compatibility with future placement values.
                    const std::string p = flj.at("placement").get<std::string>();
                    fl.placement = (p == "front")
                        ? FullscreenLayerPlacement::InFrontOfGrid
                        : FullscreenLayerPlacement::BehindGrid;
                }
                if (flj.contains("opacity") && flj.at("opacity").is_number())
                    fl.opacity = std::clamp(flj.at("opacity").get<float>(), 0.0f, 1.0f);
                if (flj.contains("zOrder") && flj.at("zOrder").is_number())
                    flj.at("zOrder").get_to(fl.zOrder);
                else
                    anyLayerMissingZOrder = true;   // old-format layer
                if (flj.contains("eventActions") && flj.at("eventActions").is_array())
                    for (const auto& a : flj.at("eventActions")) fl.eventActions.push_back(a);
                // Drop dangling track refs silently — the source track may have
                // been deleted before this project was saved.
                if (fl.trackId < 0 || m_tracks.find(fl.trackId) == m_tracks.end())
                    return;
                m_gridLayout.fullscreenLayers.push_back(std::move(fl));
            };

            // Parse one slot JSON object into the active layout. coordScale is 1
            // for the fine-grid snapshot format; the legacy pre-v2 flat path
            // passes kGridLegacyToFineScale to upscale half-grid coordinates.
            auto parseSlot = [&](const nlohmann::json& sj, int coordScale) {
                GridSlot s;
                if (sj.contains("trackId")) sj.at("trackId").get_to(s.trackId);
                if (sj.contains("gridX"))   sj.at("gridX").get_to(s.gridX);
                if (sj.contains("gridY"))   sj.at("gridY").get_to(s.gridY);
                if (sj.contains("spanX"))   sj.at("spanX").get_to(s.spanX);
                if (sj.contains("spanY"))   sj.at("spanY").get_to(s.spanY);
                if (sj.contains("opacity")) sj.at("opacity").get_to(s.opacity);
                if (sj.contains("zOrder"))  sj.at("zOrder").get_to(s.zOrder);
                if (sj.contains("eventActions") && sj.at("eventActions").is_array())
                    for (const auto& a : sj.at("eventActions")) s.eventActions.push_back(a);
                s.gridX *= coordScale;
                s.gridY *= coordScale;
                s.spanX *= coordScale;
                s.spanY *= coordScale;
                m_gridLayout.slots.push_back(std::move(s));
            };

            const bool hasSnapshots = gl.contains("snapshots")
                                   && gl.at("snapshots").is_array()
                                   && !gl.at("snapshots").empty();
            if (hasSnapshots) {
                // ── Snapshot-container format ─────────────────────────────────
                // Choose the snapshot named by activeSnapshotId; fall back to the
                // first entry. Only the active snapshot is projected into the
                // runtime layout this phase (inactive snapshots do not exist yet).
                const std::string wantId = gl.value("activeSnapshotId", std::string());
                std::set<std::string> seenSnapshotIds;
                for (const auto& snap : gl.at("snapshots")) {
                    if (!snap.is_object()) continue;
                    m_gridLayout.columns = 3;
                    m_gridLayout.rows = 3;
                    m_gridLayout.gapScale = 0.0f;
                    m_gridLayout.slots.clear();
                    m_gridLayout.fullscreenLayers.clear();
                    anyLayerMissingZOrder = false;

                    std::string id = snap.value("id", std::string());
                    while (id.empty() || seenSnapshotIds.count(id) != 0)
                        id = generateSnapshotId();
                    seenSnapshotIds.insert(id);
                    const std::string name = snap.value("name", std::string("Base"));
                    if (snap.contains("columns")) snap.at("columns").get_to(m_gridLayout.columns);
                    if (snap.contains("rows"))    snap.at("rows").get_to(m_gridLayout.rows);
                    if (snap.contains("gapScale") && snap.at("gapScale").is_number())
                        m_gridLayout.gapScale =
                            std::clamp(snap.at("gapScale").get<float>(), 0.0f, 0.5f);
                    if (snap.contains("fullscreenLayers") && snap.at("fullscreenLayers").is_array())
                        for (const auto& flj : snap.at("fullscreenLayers"))
                            parseFullscreenLayer(flj);
                    if (snap.contains("slots") && snap.at("slots").is_array())
                        for (const auto& sj : snap.at("slots"))
                            parseSlot(sj, /*coordScale=*/1);
                    if (anyLayerMissingZOrder && !m_gridLayout.fullscreenLayers.empty())
                        assignCanonicalFullscreenZOrders(m_gridLayout.fullscreenLayers,
                                                         m_gridLayout.slots);
                    m_gridSnapshots.push_back(
                        makeGridSnapshot(m_gridLayout, std::move(id), name));
                }
                m_activeSnapshotId = wantId;
                materializeActive(); // clamps missing active id to the first entry
                anyLayerMissingZOrder = false; // each snapshot was migrated above
            } else {
                // ── Legacy pre-snapshot flat format ───────────────────────────
                // The arrangement fields sit directly on the gridLayout object.
                // Coordinate migration: pre-v2 projects stored slot coordinates in
                // half-grid units (2 per column); v2+ uses fine-grid units. Layer
                // migration: pre-v3 projects stored a single chorus backdrop
                // (chorusTrackId) + optional crash overlay (crashEnabled/
                // crashTrackId/crashOpacity); v3+ unifies them into fullscreenLayers.
                if (gl.contains("columns")) gl.at("columns").get_to(m_gridLayout.columns);
                if (gl.contains("rows"))    gl.at("rows").get_to(m_gridLayout.rows);
                // gapScale was never written by pre-snapshot builds (so it
                // defaults to 0.0, exactly as before), but honor it if a hand-
                // authored legacy file supplies one. Clamped to [0.0, 0.5].
                if (gl.contains("gapScale") && gl.at("gapScale").is_number())
                    m_gridLayout.gapScale =
                        std::clamp(gl.at("gapScale").get<float>(), 0.0f, 0.5f);

                const int gridLayoutVersion = gl.value("gridLayoutVersion", 1);
                const int coordScale = (gridLayoutVersion < 2)
                                     ? kGridLegacyToFineScale : 1;
                if (coordScale != 1) {
                    std::cout << "[Timeline] Migrating gridLayout slots from v"
                              << gridLayoutVersion << " (half-grid) to fine-grid (x"
                              << coordScale << ")\n";
                }

                if (gl.contains("fullscreenLayers") && gl.at("fullscreenLayers").is_array()) {
                    for (const auto& flj : gl.at("fullscreenLayers"))
                        parseFullscreenLayer(flj);
                } else {
                    // Legacy v≤2 path: synthesize layers from the old flat fields.
                    if (gl.contains("chorusTrackId")) {
                        int cid = -1;
                        gl.at("chorusTrackId").get_to(cid);
                        if (cid >= 0 && m_tracks.find(cid) != m_tracks.end()) {
                            FullscreenLayer fl;
                            fl.trackId   = cid;
                            fl.placement = FullscreenLayerPlacement::BehindGrid;
                            fl.opacity   = 1.0f;
                            m_gridLayout.fullscreenLayers.push_back(fl);
                        }
                    }
                    bool  legacyCrashEnabled = false;
                    int   legacyCrashTrack   = -1;
                    float legacyCrashOp      = 0.7f;
                    if (gl.contains("crashEnabled")) gl.at("crashEnabled").get_to(legacyCrashEnabled);
                    if (gl.contains("crashTrackId")) gl.at("crashTrackId").get_to(legacyCrashTrack);
                    if (gl.contains("crashOpacity")) gl.at("crashOpacity").get_to(legacyCrashOp);
                    if (legacyCrashEnabled && legacyCrashTrack >= 0
                        && m_tracks.find(legacyCrashTrack) != m_tracks.end()) {
                        FullscreenLayer fl;
                        fl.trackId   = legacyCrashTrack;
                        fl.placement = FullscreenLayerPlacement::InFrontOfGrid;
                        fl.opacity   = std::clamp(legacyCrashOp, 0.0f, 1.0f);
                        m_gridLayout.fullscreenLayers.push_back(fl);
                    }
                    if (!m_gridLayout.fullscreenLayers.empty()) {
                        // Synthesized legacy layers carry no zOrder → canonicalize below.
                        anyLayerMissingZOrder = true;
                        std::cout << "[Timeline] Migrated " << m_gridLayout.fullscreenLayers.size()
                                  << " legacy chorus/crash entries into fullscreenLayers\n";
                    }
                }

                if (gl.contains("slots"))
                    for (const auto& sj : gl.at("slots"))
                        parseSlot(sj, coordScale);

                m_gridSnapshots.push_back(makeGridSnapshot(
                    m_gridLayout, m_activeSnapshotId, m_activeSnapshotName));
            }

            // ── Post-processing shared by both formats ────────────────────────
            // Auto-enable hold-last-frame on every BehindGrid track (the
            // setFullscreenLayers() invariant) without going through the setter
            // — the setter logs and we don't want to double-log on load.
            for (const auto& fl : m_gridLayout.fullscreenLayers) {
                if (fl.placement != FullscreenLayerPlacement::BehindGrid) continue;
                if (fl.trackId < 0) continue;
                auto it = m_tracks.find(fl.trackId);
                if (it != m_tracks.end()) it->second.videoHoldLastFrame = true;
            }

            // ── zOrder migration (lossless) ──────────────────────────────────
            // Old projects (and legacy chorus/crash synthesis) have no per-layer
            // zOrder. Reconstruct the exact legacy "behind < grid < front" draw
            // order from placement + array position now that the grid slots (and
            // therefore their min/max zOrder) are known. Files that already carry
            // per-layer zOrder are used verbatim so interleaved orderings survive.
            if (anyLayerMissingZOrder && !m_gridLayout.fullscreenLayers.empty()) {
                assignCanonicalFullscreenZOrders(m_gridLayout.fullscreenLayers,
                                                 m_gridLayout.slots);
                std::cout << "[ZOrderMigration] Assigned canonical fullscreen zOrders for "
                          << m_gridLayout.fullscreenLayers.size() << " layer(s)\n";
            }
        }

        // Loop / render region. Absent in pre-loop projects → keep defaults.
        // renderScoped is never read from JSON (it is derived from loopEnabled).
        if (m_gridSnapshots.empty()) {
            m_activeSnapshotId = generateSnapshotId();
            m_activeSnapshotName = "Base";
            m_gridSnapshots.push_back(makeGridSnapshot(
                m_gridLayout, m_activeSnapshotId, m_activeSnapshotName));
        } else {
            syncActiveToVector();
        }
        materializeActive();

        // Resolve the default ("Base") snapshot id now that m_gridSnapshots is
        // finalized. When the persisted id is absent or dangling (legacy files,
        // regenerated-on-collision ids), fall back to the first live snapshot so
        // gridLayoutAt always has an explicit Base.
        if (findSnapshot(m_defaultSnapshotId) == nullptr)
            m_defaultSnapshotId = m_gridSnapshots.empty()
                ? std::string() : m_gridSnapshots.front().id;

        m_loopRegion = LoopRegion{};
        if (j.contains("loopRegion")) {
            const auto& lr = j.at("loopRegion");
            LoopRegion region;
            region.startTick   = lr.value("startTick", region.startTick);
            region.endTick     = lr.value("endTick", region.endTick);
            region.loopEnabled = lr.value("loopEnabled", false);
            region.renderOrigin = stringToLoopRenderOrigin(lr.value("renderOrigin", std::string("absolute")));
            region.tailMode     = stringToLoopTailMode(lr.value("tailMode", std::string("tailClamp")));
            region.tailThresholdDb = lr.value("tailThresholdDb", region.tailThresholdDb);
            region.tailMaxSeconds  = lr.value("tailMaxSeconds", region.tailMaxSeconds);
            // Re-assert the hard length invariant on load (1-tick floor).
            m_loopRegion = normalizeLoopRegion(region, 1);
        }

        std::cout << "[Timeline] Deserialized: "
                  << m_sources.size()       << " sources, "
                  << m_regions.size()       << " regions, "
                  << m_tracks.size()        << " tracks, "
                  << m_clips.size()         << " clips, "
                  << m_patterns.size()      << " patterns, "
                  << m_patternBlocks.size() << " patternBlocks\n";
        return true;
    } catch (const std::exception& e) {
        std::cout << "[Timeline] ERROR fromJSON: " << e.what() << "\n";
        return false;
    }
}

// ─── Reset ────────────────────────────────────────────────────────────────────

void Timeline::clear() {
    const auto nSrc  = m_sources.size();
    const auto nReg  = m_regions.size();
    const auto nTrk  = m_tracks.size();
    const auto nClp  = m_clips.size();
    const auto nPat  = m_patterns.size();
    const auto nBlk  = m_patternBlocks.size();

    m_sources.clear();
    m_regions.clear();
    m_tracks.clear();
    m_clips.clear();
    m_patterns.clear();
    m_patternBlocks.clear();

    m_gridLayout         = GridLayout{};
    m_activeSnapshotId   = generateSnapshotId();  // fresh "Base" snapshot identity
    m_activeSnapshotName = "Base";
    m_defaultSnapshotId  = m_activeSnapshotId;    // the remitted Base is the default
    m_gridSnapshots.clear();
    m_gridSnapshots.push_back(
        makeGridSnapshot(m_gridLayout, m_activeSnapshotId, m_activeSnapshotName));
    m_gridCues.clear();
    m_loopRegion = LoopRegion{};

    m_bpm        = 140.0;
    m_sampleRate = 44100.0;
    m_timeSigNum = 4;
    m_timeSigDen = 4;
    m_declickMs  = 0.5;
    m_globalStretchMethod = static_cast<int>(StretchMethod::PSOLA);
    m_nextId     = 1;

    std::cout << "[Timeline] Cleared ("
              << nSrc << " sources, " << nReg << " regions, "
              << nTrk << " tracks, "  << nClp << " clips, "
              << nPat << " patterns, " << nBlk << " patternBlocks)\n";
}

// ─── Mixer output routing (Prompt 2A) ────────────────────────────────────────

xleth::RoutingValidationResult Timeline::setTrackOutputRoute(int sourceTrackId,
                                                              int targetTrackId)
{
    auto result = xleth::validateTrackOutputRoute(*this, sourceTrackId, targetTrackId);
    if (!result.ok())
        return result;
    TrackInfo* t = getTrackMutable(sourceTrackId);
    if (!t)
        return { xleth::RoutingValidationReason::unknown_track };
    t->outputRoute.targetTrackId = targetTrackId;
    return result;
}

TrackOutputRoute Timeline::getTrackOutputRoute(int sourceTrackId) const
{
    const TrackInfo* t = getTrack(sourceTrackId);
    return t ? t->outputRoute : TrackOutputRoute{};
}

// ─── Sidechain routes (Prompt 4B) ────────────────────────────────────────────

xleth::RoutingValidationResult Timeline::addSidechainRoute(
    int sourceTrackId, const SidechainRoute& route,
    const xleth::SidechainEffectResolver& resolver,
    const xleth::SidechainCapabilityResolver& capabilityResolver)
{
    auto result = xleth::validateSidechainRoute(*this, sourceTrackId, route, resolver,
                                                capabilityResolver);
    if (!result.ok())
        return result;
    TrackInfo* t = getTrackMutable(sourceTrackId);
    if (!t)
        return { xleth::RoutingValidationReason::unknown_source_track };
    SidechainRoute stored = route;
    stored.gain = xleth::clampSidechainGain(route.gain);
    t->sidechainRoutes.push_back(stored);
    return result;
}

xleth::RoutingValidationResult Timeline::removeSidechainRoute(
    int sourceTrackId, const std::string& routeId)
{
    TrackInfo* t = getTrackMutable(sourceTrackId);
    if (!t)
        return { xleth::RoutingValidationReason::unknown_source_track };
    auto& routes = t->sidechainRoutes;
    auto it = std::find_if(routes.begin(), routes.end(),
                           [&](const SidechainRoute& r) { return r.routeId == routeId; });
    if (it == routes.end())
        return { xleth::RoutingValidationReason::unknown_route };
    routes.erase(it);
    return { xleth::RoutingValidationReason::ok };
}

xleth::RoutingValidationResult Timeline::setSidechainRouteParams(
    int sourceTrackId, const std::string& routeId,
    const xleth::SidechainRouteParams& params)
{
    if (!std::isfinite(params.gain))
        return { xleth::RoutingValidationReason::invalid_gain };
    TrackInfo* t = getTrackMutable(sourceTrackId);
    if (!t)
        return { xleth::RoutingValidationReason::unknown_source_track };
    for (auto& r : t->sidechainRoutes) {
        if (r.routeId != routeId) continue;
        r.gain     = xleth::clampSidechainGain(params.gain);
        r.preFader = params.preFader;
        r.enabled  = params.enabled;
        return { xleth::RoutingValidationReason::ok };
    }
    return { xleth::RoutingValidationReason::unknown_route };
}

std::vector<SidechainRoute> Timeline::getSidechainRoutes(int sourceTrackId) const
{
    const TrackInfo* t = getTrack(sourceTrackId);
    return t ? t->sidechainRoutes : std::vector<SidechainRoute>{};
}
