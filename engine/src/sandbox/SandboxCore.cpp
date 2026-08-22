#include "sandbox/SandboxCore.h"

#include <algorithm>

namespace xleth::sandbox {

// ─── SandboxLayer ─────────────────────────────────────────────────────────────

size_t SandboxLayer::firstDirtyIndex() const {
    for (size_t i = 0; i < ops.size(); ++i) {
        if (ops[i].dirty) return i;
    }
    return ops.size();
}

int SandboxLayer::indexOfOp(int opId) const {
    for (size_t i = 0; i < ops.size(); ++i) {
        if (ops[i].id == opId) return static_cast<int>(i);
    }
    return -1;
}

const SandboxOp* SandboxLayer::findOp(int opId) const {
    const int idx = indexOfOp(opId);
    return idx < 0 ? nullptr : &ops[static_cast<size_t>(idx)];
}

SandboxOp* SandboxLayer::findOp(int opId) {
    const int idx = indexOfOp(opId);
    return idx < 0 ? nullptr : &ops[static_cast<size_t>(idx)];
}

// ─── SandboxCore — layers ─────────────────────────────────────────────────────

int SandboxCore::addLayer(const std::string& name, int sourceBufferId, double bufferSampleRate) {
    SandboxLayer layer;
    layer.id               = nextLayerId_++;
    layer.name             = name;
    layer.sourceBufferId   = sourceBufferId;
    layer.bufferSampleRate = bufferSampleRate;
    const int id = layer.id;
    layers_.push_back(std::move(layer));
    fireChange(id);
    return id;
}

bool SandboxCore::restoreLayer(const SandboxLayer& layer, int atIndex) {
    if (findLayer(layer.id) != nullptr) return false;

    const size_t pos = (atIndex < 0 || static_cast<size_t>(atIndex) > layers_.size())
                     ? layers_.size()
                     : static_cast<size_t>(atIndex);
    layers_.insert(layers_.begin() + static_cast<std::ptrdiff_t>(pos), layer);

    // A restored layer's id must never be handed out again.
    nextLayerId_ = std::max(nextLayerId_, layer.id + 1);
    fireChange(layer.id);
    return true;
}

bool SandboxCore::removeLayer(int layerId, SandboxLayer* outRemoved, int* outIndex) {
    for (size_t i = 0; i < layers_.size(); ++i) {
        if (layers_[i].id != layerId) continue;
        if (outRemoved) *outRemoved = layers_[i];
        if (outIndex)   *outIndex   = static_cast<int>(i);
        layers_.erase(layers_.begin() + static_cast<std::ptrdiff_t>(i));
        fireChange(layerId);
        return true;
    }
    return false;
}

const SandboxLayer* SandboxCore::findLayer(int layerId) const {
    for (const auto& l : layers_) if (l.id == layerId) return &l;
    return nullptr;
}

SandboxLayer* SandboxCore::findLayer(int layerId) {
    for (auto& l : layers_) if (l.id == layerId) return &l;
    return nullptr;
}

// ─── SandboxCore — stack mutations ────────────────────────────────────────────

void SandboxCore::dirtyFrom(SandboxLayer& layer, size_t fromIndex) {
    for (size_t i = fromIndex; i < layer.ops.size(); ++i) layer.ops[i].dirty = true;
}

bool SandboxCore::addOp(int layerId, SandboxOp op, int index, int* outOpId) {
    SandboxLayer* layer = findLayer(layerId);
    if (layer == nullptr) return false;

    // A variant that disagrees with the declared type would render as a
    // pass-through forever. Refuse it at the door instead.
    if (!op.consistent()) return false;

    if (op.id == 0) {
        op.id = layer->nextOpId++;
    } else {
        // Redo path: the original id comes back so later commands still resolve.
        if (layer->findOp(op.id) != nullptr) return false;
        layer->nextOpId = std::max(layer->nextOpId, op.id + 1);
    }
    op.dirty = true;

    const size_t pos = (index < 0 || static_cast<size_t>(index) > layer->ops.size())
                     ? layer->ops.size()
                     : static_cast<size_t>(index);

    const int assignedId = op.id;
    layer->ops.insert(layer->ops.begin() + static_cast<std::ptrdiff_t>(pos), std::move(op));

    // Everything from the insertion point down now sees different input.
    dirtyFrom(*layer, pos);

    if (outOpId) *outOpId = assignedId;
    fireChange(layerId);
    return true;
}

bool SandboxCore::removeOp(int layerId, int opId, SandboxOp* outRemoved, int* outIndex) {
    SandboxLayer* layer = findLayer(layerId);
    if (layer == nullptr) return false;

    const int idx = layer->indexOfOp(opId);
    if (idx < 0) return false;

    const size_t pos = static_cast<size_t>(idx);
    if (outRemoved) *outRemoved = layer->ops[pos];
    if (outIndex)   *outIndex   = idx;

    layer->ops.erase(layer->ops.begin() + static_cast<std::ptrdiff_t>(pos));
    dirtyFrom(*layer, pos);
    fireChange(layerId);
    return true;
}

bool SandboxCore::reorderOp(int layerId, int fromIndex, int toIndex) {
    SandboxLayer* layer = findLayer(layerId);
    if (layer == nullptr) return false;

    const int n = static_cast<int>(layer->ops.size());
    if (fromIndex < 0 || fromIndex >= n) return false;
    if (toIndex   < 0 || toIndex   >= n) return false;
    if (fromIndex == toIndex) return false;   // not an edit — do not record it

    SandboxOp moved = layer->ops[static_cast<size_t>(fromIndex)];
    layer->ops.erase(layer->ops.begin() + fromIndex);
    layer->ops.insert(layer->ops.begin() + toIndex, std::move(moved));

    // Only the span between the two positions changes its input; anything above
    // the earlier of them is untouched and keeps its cached prefix.
    dirtyFrom(*layer, static_cast<size_t>(std::min(fromIndex, toIndex)));
    fireChange(layerId);
    return true;
}

bool SandboxCore::setOpParams(int layerId, int opId, const SandboxOpParams& params) {
    SandboxLayer* layer = findLayer(layerId);
    if (layer == nullptr) return false;

    const int idx = layer->indexOfOp(opId);
    if (idx < 0) return false;

    SandboxOp& op = layer->ops[static_cast<size_t>(idx)];

    // The incoming variant must be the alternative this op's type declares.
    if (static_cast<int>(params.index()) != static_cast<int>(op.type)) return false;

    // Writing the value it already holds is not an edit.
    if (op.params == params) return false;

    op.params = params;
    dirtyFrom(*layer, static_cast<size_t>(idx));
    fireChange(layerId);
    return true;
}

bool SandboxCore::setOpBypassed(int layerId, int opId, bool bypassed) {
    SandboxLayer* layer = findLayer(layerId);
    if (layer == nullptr) return false;

    const int idx = layer->indexOfOp(opId);
    if (idx < 0) return false;

    SandboxOp& op = layer->ops[static_cast<size_t>(idx)];
    if (op.enabled == !bypassed) return false;   // already there

    op.enabled = !bypassed;
    dirtyFrom(*layer, static_cast<size_t>(idx));
    fireChange(layerId);
    return true;
}

// ─── SandboxCore — mix params ─────────────────────────────────────────────────
// None of these dirty the stack: mix params are applied when layers are summed
// into the composite, so a rendered layer buffer survives a level drag.

bool SandboxCore::setLayerMix(int layerId, double gainDb, double pan, int64_t offsetSamples) {
    SandboxLayer* layer = findLayer(layerId);
    if (layer == nullptr) return false;
    if (layer->gainDb == gainDb && layer->pan == pan && layer->offsetSamples == offsetSamples)
        return false;
    layer->gainDb        = gainDb;
    layer->pan           = std::clamp(pan, -1.0, 1.0);
    layer->offsetSamples = offsetSamples;
    fireChange(layerId);
    return true;
}

bool SandboxCore::setLayerMuted(int layerId, bool muted) {
    SandboxLayer* layer = findLayer(layerId);
    if (layer == nullptr || layer->muted == muted) return false;
    layer->muted = muted;
    fireChange(layerId);
    return true;
}

bool SandboxCore::setLayerSoloed(int layerId, bool soloed) {
    SandboxLayer* layer = findLayer(layerId);
    if (layer == nullptr || layer->soloed == soloed) return false;
    layer->soloed = soloed;
    fireChange(layerId);
    return true;
}

bool SandboxCore::setLayerSource(int layerId, int sourceBufferId, double bufferSampleRate) {
    SandboxLayer* layer = findLayer(layerId);
    if (layer == nullptr) return false;
    if (layer->sourceBufferId == sourceBufferId && layer->bufferSampleRate == bufferSampleRate)
        return false;
    layer->sourceBufferId   = sourceBufferId;
    layer->bufferSampleRate = bufferSampleRate;
    // A new source invalidates every cached prefix on this layer.
    dirtyFrom(*layer, 0);
    fireChange(layerId);
    return true;
}

// ─── SandboxCore — dirty bookkeeping ──────────────────────────────────────────

void SandboxCore::markLayerRendered(int layerId) {
    SandboxLayer* layer = findLayer(layerId);
    if (layer == nullptr) return;
    for (auto& op : layer->ops) op.dirty = false;
    // Deliberately no change hook: clearing dirty is the renderer reporting
    // back, not an edit. Firing here would loop the renderer into itself.
}

void SandboxCore::markLayerDirty(int layerId) {
    SandboxLayer* layer = findLayer(layerId);
    if (layer == nullptr) return;
    dirtyFrom(*layer, 0);
    fireChange(layerId);
}

// ─── SandboxCore — serialization ──────────────────────────────────────────────

nlohmann::json SandboxCore::toJson() const {
    nlohmann::json j = nlohmann::json::object();
    j["sandboxStackVersion"] = kSandboxStackVersion;
    j["nextLayerId"]         = nextLayerId_;

    nlohmann::json arr = nlohmann::json::array();
    for (const auto& l : layers_) {
        nlohmann::json lj = nlohmann::json::object();
        lj["id"]               = l.id;
        lj["name"]             = l.name;
        lj["sourceBufferId"]   = l.sourceBufferId;
        lj["bufferSampleRate"] = l.bufferSampleRate;
        lj["gainDb"]           = l.gainDb;
        lj["pan"]              = l.pan;
        lj["offsetSamples"]    = l.offsetSamples;
        lj["muted"]            = l.muted;
        lj["soloed"]           = l.soloed;
        lj["nextOpId"]         = l.nextOpId;

        nlohmann::json ops = nlohmann::json::array();
        for (const auto& op : l.ops) ops.push_back(opToJson(op));
        lj["ops"] = std::move(ops);

        arr.push_back(std::move(lj));
    }
    j["layers"] = std::move(arr);
    return j;
}

bool SandboxCore::fromJson(const nlohmann::json& j, int* versionOut, int* skippedOps) {
    if (!j.is_object()) return false;

    clear();

    int version = 1;
    if (auto it = j.find("sandboxStackVersion"); it != j.end() && it->is_number_integer())
        version = it->get<int>();

    int skipped = 0;

    if (auto la = j.find("layers"); la != j.end() && la->is_array()) {
        for (const auto& lj : *la) {
            if (!lj.is_object()) continue;

            SandboxLayer l;
            l.id               = lj.value("id", 0);
            l.name             = lj.value("name", std::string{});
            l.sourceBufferId   = lj.value("sourceBufferId", -1);
            l.bufferSampleRate = lj.value("bufferSampleRate", 0.0);
            l.gainDb           = lj.value("gainDb", 0.0);
            l.pan              = lj.value("pan", 0.0);
            l.offsetSamples    = lj.value("offsetSamples", static_cast<int64_t>(0));
            l.muted            = lj.value("muted", false);
            l.soloed           = lj.value("soloed", false);
            l.nextOpId         = lj.value("nextOpId", 1);

            if (auto oa = lj.find("ops"); oa != lj.end() && oa->is_array()) {
                int stackSkipped = 0;
                if (stackFromJson(*oa, l.ops, nullptr, &stackSkipped)) skipped += stackSkipped;
            }

            // Repair the id counters rather than trusting the file: a stack
            // whose nextOpId was written stale would hand out a colliding id on
            // the very next add, and a duplicate op id silently breaks every
            // command that addresses an op by id.
            for (const auto& op : l.ops) l.nextOpId = std::max(l.nextOpId, op.id + 1);

            nextLayerId_ = std::max(nextLayerId_, l.id + 1);
            layers_.push_back(std::move(l));
        }
    }

    if (auto it = j.find("nextLayerId"); it != j.end() && it->is_number_integer())
        nextLayerId_ = std::max(nextLayerId_, it->get<int>());

    if (versionOut) *versionOut = version;
    if (skippedOps) *skippedOps = skipped;
    return true;
}

void SandboxCore::clear() {
    layers_.clear();
    nextLayerId_ = 1;
}

void SandboxCore::fireChange(int layerId) const {
    if (changeHook_) changeHook_(layerId);
}

} // namespace xleth::sandbox
