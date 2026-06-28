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

void Timeline::setGridLayout(const GridLayout& layout) {
    m_gridLayout = layout;
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
    std::cout << "[Timeline] Grid remove track " << trackId
              << " (removed " << (before - m_gridLayout.slots.size()) << " slot(s))\n";
}

void Timeline::setFullscreenLayers(std::vector<FullscreenLayer> layers) {
    m_gridLayout.fullscreenLayers = std::move(layers);
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
    std::cout << "[Timeline] Removed " << (before - v.size())
              << " fullscreen layer(s) for track " << trackId << "\n";
}

void Timeline::restoreFullscreenLayer(size_t index, const FullscreenLayer& layer) {
    auto& v = m_gridLayout.fullscreenLayers;
    if (index > v.size()) index = v.size();
    v.insert(v.begin() + static_cast<std::ptrdiff_t>(index), layer);
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

    nlohmann::json gl;
    gl["columns"]       = m_gridLayout.columns;
    gl["rows"]          = m_gridLayout.rows;
    // gridLayoutVersion: bumped to 3 when the chorus/crash special-cases were
    // unified into fullscreenLayers. v<2 projects also need slot-coordinate
    // migration (half-grid → fine-grid) — see fromJSON.
    gl["gridLayoutVersion"] = kGridLayoutVersionFineUnits;
    gl["previewFps"]    = m_gridLayout.previewFps;
    // Project video canvas (added after gridLayoutVersion 3 — additive, so no
    // version bump is needed; absent fields default on load for old projects).
    gl["canvasWidth"]        = m_gridLayout.canvasWidth;
    gl["canvasHeight"]       = m_gridLayout.canvasHeight;
    gl["canvasAspectRatio"]  = m_gridLayout.canvasAspectRatio;
    gl["fullscreenLayers"] = nlohmann::json::array();
    for (const auto& fl : m_gridLayout.fullscreenLayers) {
        nlohmann::json flj;
        flj["trackId"]   = fl.trackId;
        flj["placement"] = (fl.placement == FullscreenLayerPlacement::BehindGrid)
                              ? "behind" : "front";
        flj["opacity"]   = fl.opacity;
        gl["fullscreenLayers"].push_back(flj);
    }
    gl["slots"] = nlohmann::json::array();
    for (const auto& s : m_gridLayout.slots) {
        nlohmann::json sj;
        sj["trackId"] = s.trackId;
        sj["gridX"]   = s.gridX;
        sj["gridY"]   = s.gridY;
        sj["spanX"]   = s.spanX;
        sj["spanY"]   = s.spanY;
        sj["opacity"] = s.opacity;
        sj["zOrder"]  = s.zOrder;
        gl["slots"].push_back(sj);
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

        m_gridLayout = GridLayout{};  // reset to defaults
        if (j.contains("gridLayout")) {
            const auto& gl = j.at("gridLayout");
            if (gl.contains("columns"))       gl.at("columns").get_to(m_gridLayout.columns);
            if (gl.contains("rows"))          gl.at("rows").get_to(m_gridLayout.rows);
            if (gl.contains("previewFps"))    gl.at("previewFps").get_to(m_gridLayout.previewFps);

            // Project video canvas. Old projects (pre-canvas) omit these; the
            // GridLayout defaults (1920×1080 / "16:9") then stand, preserving
            // backward compatibility. Dimensions are normalized to the supported
            // even-pixel range so a hand-edited or corrupt value can't reach the
            // encoder.
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

            // Coordinate space migration: pre-v2 projects stored slot
            // coordinates in half-grid units (2 per column). v2+ uses
            // fine-grid units (kGridSubUnitsPerColumn per column). Scale
            // legacy values up by kGridLegacyToFineScale so the same logical
            // placements survive intact.
            //
            // Layer model migration: pre-v3 projects stored a single chorus
            // backdrop (chorusTrackId) and an optional crash overlay
            // (crashEnabled / crashTrackId / crashOpacity) as flat fields.
            // v3+ unifies them into the fullscreenLayers array.
            const int gridLayoutVersion = gl.value("gridLayoutVersion", 1);
            const int coordScale = (gridLayoutVersion < 2)
                                 ? kGridLegacyToFineScale : 1;
            if (coordScale != 1) {
                std::cout << "[Timeline] Migrating gridLayout slots from v"
                          << gridLayoutVersion << " (half-grid) to fine-grid (x"
                          << coordScale << ")\n";
            }

            if (gl.contains("fullscreenLayers") && gl.at("fullscreenLayers").is_array()) {
                for (const auto& flj : gl.at("fullscreenLayers")) {
                    FullscreenLayer fl;
                    if (flj.contains("trackId") && flj.at("trackId").is_number())
                        flj.at("trackId").get_to(fl.trackId);
                    if (flj.contains("placement") && flj.at("placement").is_string()) {
                        // Unknown placement strings default to BehindGrid for
                        // forward compatibility with future placement values.
                        const std::string p = flj.at("placement").get<std::string>();
                        fl.placement = (p == "front")
                            ? FullscreenLayerPlacement::InFrontOfGrid
                            : FullscreenLayerPlacement::BehindGrid;
                    }
                    if (flj.contains("opacity") && flj.at("opacity").is_number()) {
                        float o = flj.at("opacity").get<float>();
                        fl.opacity = std::clamp(o, 0.0f, 1.0f);
                    }
                    // Drop dangling track refs silently — the source track
                    // may have been deleted before this project was saved.
                    if (fl.trackId < 0 || m_tracks.find(fl.trackId) == m_tracks.end())
                        continue;
                    m_gridLayout.fullscreenLayers.push_back(fl);
                }
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
                bool legacyCrashEnabled = false;
                int  legacyCrashTrack   = -1;
                float legacyCrashOp     = 0.7f;
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
                    std::cout << "[Timeline] Migrated " << m_gridLayout.fullscreenLayers.size()
                              << " legacy chorus/crash entries into fullscreenLayers\n";
                }
            }
            // Auto-enable hold-last-frame on every BehindGrid track (the
            // setFullscreenLayers() invariant) without going through the setter
            // — the setter logs and we don't want to double-log on load.
            for (const auto& fl : m_gridLayout.fullscreenLayers) {
                if (fl.placement != FullscreenLayerPlacement::BehindGrid) continue;
                if (fl.trackId < 0) continue;
                auto it = m_tracks.find(fl.trackId);
                if (it != m_tracks.end()) it->second.videoHoldLastFrame = true;
            }

            if (gl.contains("slots")) {
                for (const auto& sj : gl.at("slots")) {
                    GridSlot s;
                    if (sj.contains("trackId")) sj.at("trackId").get_to(s.trackId);
                    if (sj.contains("gridX"))   sj.at("gridX").get_to(s.gridX);
                    if (sj.contains("gridY"))   sj.at("gridY").get_to(s.gridY);
                    if (sj.contains("spanX"))   sj.at("spanX").get_to(s.spanX);
                    if (sj.contains("spanY"))   sj.at("spanY").get_to(s.spanY);
                    if (sj.contains("opacity")) sj.at("opacity").get_to(s.opacity);
                    if (sj.contains("zOrder"))  sj.at("zOrder").get_to(s.zOrder);
                    s.gridX *= coordScale;
                    s.gridY *= coordScale;
                    s.spanX *= coordScale;
                    s.spanY *= coordScale;
                    m_gridLayout.slots.push_back(s);
                }
            }
        }

        // Loop / render region. Absent in pre-loop projects → keep defaults.
        // renderScoped is never read from JSON (it is derived from loopEnabled).
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

    m_gridLayout = GridLayout{};
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
