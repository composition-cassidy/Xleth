#pragma once

// ─── Color Grade ──────────────────────────────────────────────────────────────
// Colour correction and adjustment at four levels, always applied in this
// order:
//
//   Source -> Clip -> Layer -> (existing compositing) -> Master
//
//   Source  SourceMedia::colorGrade   every use of that source inherits it
//   Clip    Clip::colorGrade          one clip on a Clip Track
//           SampleRegion::colorGrade  one region on a Pattern Track
//   Layer   TrackInfo::colorGrade     the track's cell on the video grid
//   Master  Timeline (project)        the final composited frame
//
// The same ColorGrade struct exists at every level. A default-constructed
// grade is NEUTRAL: it changes no pixel, and the render path does not run a
// pass for it at all, so a project without grades renders bit-identically to
// one from before this feature.
//
// Pure math, Model tier: no JUCE, no GPU, no Timeline lookups.
//
// ── How a grade is evaluated ─────────────────────────────────────────────────
// One fixed order, the same in preview and export and on the CPU reference
// (applyBakedGrade, which the tests pin the shader against):
//
//   1. exposure               gain in LINEAR light (stops)
//   2. temperature / tint     per-channel gain in linear light, luma-neutral
//   3. lift / gamma / gain    out = (gain * (x + lift * (1 - x))) ^ (1 / gamma)
//   4. contrast               power sigmoid about mid grey; 0 and 1 stay fixed
//   5. curves                 channel(master(x))
//   6. vibrance               saturation that favours muted colours
//   7. saturation, hue        one 3x3 matrix
//   8. LUT                    optional imported .cube, blended by lutAmount
//
// Steps 1-5 are per-channel functions of one variable, so bakeColorGrade folds
// them into ONE transfer table per channel. The shader then costs three table
// lookups, a few multiplies and (optionally) one 3D lookup per level, whatever
// the grade contains. That is what keeps four levels on a populated grid
// inside the low-end laptop's frame budget.
//
// A level's output is clamped to [0, 1] before the next level reads it. Inside
// one render pass the value is carried in float, so chained levels never
// quantise to 8 bits in between.
//
// Every control is a plain number (or a short list of points), which is what
// lets the planned modulation graph and animation system drive any of them
// later: a driven grade is just a different ColorGrade baked for that frame.

#include <array>
#include <cstdint>
#include <memory>
#include <string>
#include <utility>
#include <vector>

#include <nlohmann/json.hpp>

class Timeline;

namespace xleth::grade {

// Who owns a grade. Clip and Region are the same LEVEL of the stack (the one
// instance): Clip on a Clip Track, Region on a Pattern Track.
enum class Level : uint8_t { Source = 0, Clip = 1, Region = 2, Layer = 3, Master = 4 };

/** "source" | "clip" | "region" | "layer" | "master" (the bridge's spelling). */
const char* levelName(Level level);
bool        levelFromName(const std::string& name, Level& out);

// ── Ranges (shared with the UI; ui/src/colorGrade/gradeModel.js mirrors them) ─
constexpr float kExposureRange    = 4.0f;    // stops, +/-
constexpr float kHueRangeDeg      = 180.0f;  // degrees, +/-
constexpr int   kMaxCurvePoints   = 16;
constexpr float kMinCurvePointGap = 1.0f / 512.0f;
constexpr int   kTransferLutSize  = 4096;    // entries per channel
constexpr int   kMaxLut3DSize     = 65;      // per axis

// How far the tonal controls reach at +/-1.
constexpr float kLiftLumScale     = 0.35f;   // lift at luminance 1
constexpr float kLiftChromaScale  = 0.15f;   // lift tint at wheel radius 1
constexpr float kGammaLumScale    = 1.0f;    // log2 of gamma at luminance 1
constexpr float kGammaChromaScale = 0.35f;
constexpr float kGainLumScale     = 1.0f;    // log2 of gain at luminance 1
constexpr float kGainChromaScale  = 0.35f;
constexpr float kContrastScale    = 1.5f;    // log2 of the sigmoid exponent at 1
constexpr float kWhiteBalanceScale = 0.5f;   // log2 of the R/B (or G) gain at 1

// Rec.709 luma weights, used everywhere a grade needs "brightness".
constexpr float kLumaR = 0.2126f;
constexpr float kLumaG = 0.7152f;
constexpr float kLumaB = 0.0722f;

struct CurvePoint {
    float x = 0.0f;
    float y = 0.0f;
    bool operator==(const CurvePoint& o) const { return x == o.x && y == o.y; }
};

// A tone curve: points sorted by x, strictly increasing. Fewer than two points
// (including the default, none) is the straight diagonal, "no change".
struct Curve {
    std::vector<CurvePoint> points;

    bool isIdentity() const;
    bool operator==(const Curve& o) const { return points == o.points; }
};

// One tonal range: a colour wheel position (x = blue-yellow, y = red-cyan, in
// the unit disc) plus a luminance control. All zero = neutral.
struct Wheel {
    float x   = 0.0f;
    float y   = 0.0f;
    float lum = 0.0f;

    bool isNeutral() const { return x == 0.0f && y == 0.0f && lum == 0.0f; }
    bool operator==(const Wheel& o) const { return x == o.x && y == o.y && lum == o.lum; }
};

struct ColorGrade {
    bool  bypassed    = false;   // this level's on/off (off = the grade is kept, not applied)

    // Basics. 0 = neutral for every one of them.
    float exposure    = 0.0f;    // stops, -4..4
    float contrast    = 0.0f;    // -1..1
    float saturation  = 0.0f;    // -1..1  (-1 = greyscale, 1 = double)
    float vibrance    = 0.0f;    // -1..1
    float temperature = 0.0f;    // -1 (cool) .. 1 (warm)
    float tint        = 0.0f;    // -1 (green) .. 1 (magenta)
    float hue         = 0.0f;    // degrees, -180..180

    // Tonal balance.
    Wheel lift;                  // shadows
    Wheel gamma;                 // midtones
    Wheel gain;                  // highlights

    // Curves.
    Curve curveMaster;
    Curve curveR;
    Curve curveG;
    Curve curveB;

    // Imported look (.cube). Empty path = none.
    std::string lutPath;
    float       lutAmount = 1.0f;   // 0..1

    /** True when the VALUES change no pixel (the bypass flag is not a value). */
    bool isNeutral() const;
    /** True when this grade has to be rendered: not bypassed and not neutral. */
    bool isActive() const { return !bypassed && !isNeutral(); }
    /** True when nothing needs saving: neutral and not bypassed. */
    bool isDefault() const { return !bypassed && isNeutral(); }

    bool operator==(const ColorGrade& o) const;
    bool operator!=(const ColorGrade& o) const { return !(*this == o); }
};

/** Clamp every value into range and repair the curves (sorted, strictly
 *  increasing x, at most kMaxCurvePoints, inside [0,1]). Values arrive from
 *  JSON and from the bridge; both can carry anything. */
void sanitizeColorGrade(ColorGrade& g);
void sanitizeCurve(Curve& c);

/** Evaluate a tone curve at x in [0,1]. Monotone cubic (Fritsch-Carlson): it
 *  passes through every point, never overshoots between two of them, and so
 *  can never reverse or ring however the points are placed. Flat outside the
 *  first and last point. ui/src/colorGrade/curveMath.js is the same function. */
float evaluateCurve(const Curve& c, float x);

nlohmann::json colorGradeToJson(const ColorGrade& g);
ColorGrade     colorGradeFromJson(const nlohmann::json& j);

// ── Imported 3D LUT (.cube) ──────────────────────────────────────────────────
struct Lut3D {
    uint64_t           serial = 0;     // unique per loaded table (GPU cache key)
    int                size   = 0;     // entries per axis
    std::vector<float> rgb;            // size^3 * 3, red varies fastest
    float              domainMin[3] = { 0.0f, 0.0f, 0.0f };
    float              domainMax[3] = { 1.0f, 1.0f, 1.0f };
    std::string        title;
};

/** Parse .cube text. Returns nullptr and fills `error` when it is not a usable
 *  3D LUT (a 1D LUT, a size outside 2..kMaxLut3DSize, missing rows). */
std::shared_ptr<const Lut3D> parseCubeLut(const std::string& text, std::string& error);

/** Load a .cube file (UTF-8 path). nullptr + error on failure. */
std::shared_ptr<const Lut3D> loadCubeLutFile(const std::string& utf8Path, std::string& error);

/** Trilinear lookup, rgb in and out, [0,1]. */
void sampleLut3D(const Lut3D& lut, const float in[3], float out[3]);

// Loaded LUTs by path. Message thread only (bake time); the render thread only
// ever sees the shared_ptr a BakedGrade holds.
class Lut3DLibrary {
public:
    /** The table for a path, loading it on first use. nullptr when the file is
     *  missing or unreadable; the failure is remembered so a missing file is
     *  not re-read on every bake (forget() or clear() retries). */
    std::shared_ptr<const Lut3D> get(const std::string& utf8Path);
    /** Why the last load of this path failed; empty when it is loaded. */
    std::string errorFor(const std::string& utf8Path) const;
    void forget(const std::string& utf8Path);
    void clear();

private:
    struct Entry { std::shared_ptr<const Lut3D> lut; std::string error; };
    std::vector<std::pair<std::string, Entry>> entries_;
};

// ── Baked grade: what the render path reads ──────────────────────────────────
// Immutable once built. Shared (shared_ptr<const>) between the published
// snapshot, every frame request that uses it, and the compositor's texture
// cache, so no thread ever reads a grade another thread can still change.
struct BakedGrade {
    uint64_t   serial = 0;          // unique per bake (GPU texture cache key)
    ColorGrade grade;               // the values this was baked from

    // Steps 1-5: per-channel transfer, kTransferLutSize entries of RGBA16
    // (A unused). Empty when those steps are the identity.
    bool                  hasTransfer = false;
    std::vector<uint16_t> transfer;

    // Step 6.
    float vibrance = 0.0f;

    // Step 7: row-major 3x3, out = M * rgb.
    bool  hasMatrix = false;
    float matrix[9] = { 1,0,0, 0,1,0, 0,0,1 };

    // Step 8.
    std::shared_ptr<const Lut3D> lut3d;   // nullptr = none (or the file is missing)
    float                        lutAmount = 0.0f;
};

/** Bake a grade. `luts` resolves lutPath; nullptr = the grade's LUT is ignored.
 *  Returns nullptr for a grade that is not active (bypassed or neutral): the
 *  render path treats "no baked grade" as "leave the pixels alone". */
std::shared_ptr<const BakedGrade> bakeColorGrade(const ColorGrade& g, Lut3DLibrary* luts);

/** CPU reference of exactly what the shader does for one level. rgb in and
 *  out, [0,1]. Used by the tests, by Auto's verification, and as the written
 *  definition the GPU pass is checked against. */
void applyBakedGrade(const BakedGrade& b, float rgb[3]);

/** One channel's transfer (steps 1-5) evaluated directly, without the table.
 *  channel 0/1/2 = R/G/B. */
float evaluateTransfer(const ColorGrade& g, int channel, float x);

// ── Auto helper ──────────────────────────────────────────────────────────────
// Statistics of a whole source (every sampled frame accumulated into one set),
// so Auto produces ONE steady grade for the source and can never pump between
// cuts or scenes. Also what the curves histogram draws at the Source level.
struct GradeAnalysis {
    static constexpr int kBins = 256;
    std::array<uint64_t, kBins> histR{};
    std::array<uint64_t, kBins> histG{};
    std::array<uint64_t, kBins> histB{};
    std::array<uint64_t, kBins> histLuma{};
    std::array<uint64_t, kBins> histChroma{};   // max(r,g,b) - min(r,g,b)
    uint64_t pixels = 0;
    int      frames = 0;

    /** Accumulate one frame. `bytesPerPixel` 3 or 4; channel order by offsets. */
    void addFrame(const uint8_t* data, int width, int height, int stride,
                  int bytesPerPixel, int rOffset, int gOffset, int bOffset);

    /** Value in [0,1] below which `fraction` of the samples fall. */
    static double percentile(const std::array<uint64_t, kBins>& hist, double fraction);
    static double mean(const std::array<uint64_t, kBins>& hist);

    bool empty() const { return pixels == 0; }
};

nlohmann::json gradeAnalysisToJson(const GradeAnalysis& a);

/** The correction Auto proposes at FULL strength, as ordinary controls on an
 *  otherwise neutral grade: lift / gamma / gain (levels and cast) plus
 *  vibrance or saturation. Deterministic: the same statistics give the same
 *  grade. Healthy footage (blacks near black, whites near white, channels
 *  aligned, ordinary saturation) comes out essentially neutral. */
ColorGrade autoGradeFromAnalysis(const GradeAnalysis& a);

/** Write Auto's controls into `base` at a strength of 0..1 (0 = those
 *  controls neutral, 1 = `autoFull`). Only the controls Auto owns are
 *  touched: the wheels, saturation and vibrance. Everything else in `base`
 *  (exposure, curves, LUT, bypass...) is kept. */
ColorGrade applyAutoGrade(const ColorGrade& base, const ColorGrade& autoFull, float strength);

// ── Snapshot: every active grade, resolved for the render path ───────────────
// Built on the message thread after any edit, published under the model lock,
// read by the frame collector while it holds that lock. Holds only ACTIVE
// grades; a lookup miss means "no grade at that level".
struct ColorGradeSnapshot {
    using Baked = std::shared_ptr<const BakedGrade>;
    using Table = std::vector<std::pair<int, Baked>>;   // sorted by id

    Table sources;
    Table clips;
    Table regions;
    Table tracks;
    Baked master;

    static const Baked& find(const Table& t, int id);

    const Baked& source(int sourceId) const { return find(sources, sourceId); }
    const Baked& clip(int clipId)     const { return find(clips, clipId); }
    const Baked& region(int regionId) const { return find(regions, regionId); }
    const Baked& track(int trackId)   const { return find(tracks, trackId); }

    bool empty() const {
        return sources.empty() && clips.empty() && regions.empty()
            && tracks.empty() && !master;
    }
};

/** Bake `g` for a snapshot, reusing `previous` when it was baked from the same
 *  values AND the same LUT table (so an unrelated edit does not re-bake or
 *  re-upload anything). nullptr when the grade is not active. */
std::shared_ptr<const BakedGrade> bakeOrReuse(const ColorGrade& g,
                                              const std::shared_ptr<const BakedGrade>& previous,
                                              Lut3DLibrary* luts);

/** Resolve every active grade in the timeline (model/ColorGradeSnapshot.cpp).
 *  `previous` (may be null) is the snapshot being replaced: an owner whose
 *  grade did not change keeps its baked entry, so editing one grade re-bakes
 *  one grade. Message thread, under the model lock. */
std::shared_ptr<const ColorGradeSnapshot> buildColorGradeSnapshot(
    const ::Timeline& timeline, const ColorGradeSnapshot* previous, Lut3DLibrary* luts);

} // namespace xleth::grade

using ColorGrade = xleth::grade::ColorGrade;
