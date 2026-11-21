#include "ColorGrade.h"

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <sstream>

namespace xleth::grade {

namespace {

std::atomic<uint64_t> g_nextSerial{ 1 };

inline double clamp01(double v) { return v < 0.0 ? 0.0 : (v > 1.0 ? 1.0 : v); }
inline float  clampF(float v, float lo, float hi) { return v < lo ? lo : (v > hi ? hi : v); }
inline float  finiteOr(float v, float fallback) { return std::isfinite(v) ? v : fallback; }

// sRGB transfer. The linear segment is kept so 0 maps to 0 exactly; above 1
// the power law simply continues (an exposure push carries values past white
// until the clamp after lift/gamma/gain).
inline double srgbToLinear(double v) {
    if (v <= 0.0) return 0.0;
    return v <= 0.04045 ? v / 12.92 : std::pow((v + 0.055) / 1.055, 2.4);
}
inline double linearToSrgb(double l) {
    if (l <= 0.0) return 0.0;
    return l <= 0.0031308 ? l * 12.92 : 1.055 * std::pow(l, 1.0 / 2.4) - 0.055;
}

// A wheel position is a chroma offset with zero luma: x runs blue(+)/yellow(-),
// y runs red(+)/cyan(-), the Cb / Cr axes of Rec.709. So dragging a wheel
// tints its range without changing how bright it is, and the luminance
// control next to it changes brightness without tinting.
inline void wheelChroma(const Wheel& w, double out[3]) {
    out[0] =  1.5748 * w.y;
    out[1] = -0.1873 * w.x - 0.4681 * w.y;
    out[2] =  1.8556 * w.x;
}

// Per-channel white-balance gains in linear light, normalised so a neutral
// grey keeps its luma: warmer adds red and removes blue, tint trades green
// against magenta.
inline void whiteBalanceGains(float temperature, float tint, double out[3]) {
    const double t = static_cast<double>(temperature) * kWhiteBalanceScale;
    const double m = static_cast<double>(tint) * kWhiteBalanceScale;
    double r = std::exp2(t);
    double g = std::exp2(-m);
    double b = std::exp2(-t);
    const double n = kLumaR * r + kLumaG * g + kLumaB * b;
    out[0] = r / n; out[1] = g / n; out[2] = b / n;
}

// Contrast: a power sigmoid about mid grey. Unlike a straight scale about the
// pivot it keeps 0 and 1 fixed, so more contrast steepens the middle without
// clipping the ends, and less contrast flattens without greying black.
inline double contrastCurve(double v, double k) {
    const double p = 0.5;
    if (v < p) return p * std::pow(v / p, k);
    return 1.0 - (1.0 - p) * std::pow((1.0 - v) / (1.0 - p), k);
}

inline bool wheelsNeutral(const ColorGrade& g) {
    return g.lift.isNeutral() && g.gamma.isNeutral() && g.gain.isNeutral();
}

inline bool transferIsIdentity(const ColorGrade& g) {
    return g.exposure == 0.0f && g.temperature == 0.0f && g.tint == 0.0f
        && wheelsNeutral(g) && g.contrast == 0.0f
        && g.curveMaster.isIdentity() && g.curveR.isIdentity()
        && g.curveG.isIdentity() && g.curveB.isIdentity();
}

inline void sanitizeWheel(Wheel& w) {
    w.x   = finiteOr(w.x, 0.0f);
    w.y   = finiteOr(w.y, 0.0f);
    w.lum = clampF(finiteOr(w.lum, 0.0f), -1.0f, 1.0f);
    const float r = std::sqrt(w.x * w.x + w.y * w.y);
    if (r > 1.0f) { w.x /= r; w.y /= r; }
}

nlohmann::json wheelToJson(const Wheel& w) {
    return nlohmann::json{ {"x", w.x}, {"y", w.y}, {"lum", w.lum} };
}

Wheel wheelFromJson(const nlohmann::json& j) {
    Wheel w;
    if (!j.is_object()) return w;
    w.x   = j.value("x", 0.0f);
    w.y   = j.value("y", 0.0f);
    w.lum = j.value("lum", 0.0f);
    return w;
}

nlohmann::json curveToJson(const Curve& c) {
    nlohmann::json arr = nlohmann::json::array();
    for (const auto& p : c.points) arr.push_back(nlohmann::json::array({ p.x, p.y }));
    return arr;
}

Curve curveFromJson(const nlohmann::json& j) {
    Curve c;
    if (!j.is_array()) return c;
    for (const auto& e : j) {
        CurvePoint p;
        if (e.is_array() && e.size() >= 2 && e[0].is_number() && e[1].is_number()) {
            p.x = e[0].get<float>();
            p.y = e[1].get<float>();
        } else if (e.is_object()) {
            p.x = e.value("x", 0.0f);
            p.y = e.value("y", 0.0f);
        } else {
            continue;
        }
        c.points.push_back(p);
    }
    return c;
}

inline double smoothstep(double e0, double e1, double x) {
    if (e1 <= e0) return x >= e1 ? 1.0 : 0.0;
    const double t = clamp01((x - e0) / (e1 - e0));
    return t * t * (3.0 - 2.0 * t);
}

// How much of a channel's deviation `d` to correct: none below `ignore`, all
// of it (times `strength`) from `full` up, ramping smoothly in between, and
// never more than `cap`. Continuous, so a source just past a threshold gets a
// small correction and not a jump.
inline double castCorrection(double d, double ignore, double full, double cap, double strength) {
    const double a = std::abs(d);
    const double w = smoothstep(ignore, full, a) * strength;
    return (d < 0.0 ? -1.0 : 1.0) * std::min(a, cap) * w;
}

inline float round3(double v) {
    return static_cast<float>(std::round(v * 1000.0) / 1000.0);
}

// Turn three per-channel values into a luminance amount plus a wheel position,
// the inverse of how a Wheel is evaluated (luma-weighted mean = luminance, the
// zero-luma remainder = the chroma offset). Exact while the wheel stays inside
// the unit disc.
void channelsToWheel(const double v[3], double lumScale, double chromaScale, Wheel& out) {
    const double lum = kLumaR * v[0] + kLumaG * v[1] + kLumaB * v[2];
    const double dR = v[0] - lum;
    const double dB = v[2] - lum;
    double x = (dB / 1.8556) / chromaScale;
    double y = (dR / 1.5748) / chromaScale;
    const double r = std::sqrt(x * x + y * y);
    if (r > 1.0) { x /= r; y /= r; }
    out.lum = round3(std::clamp(lum / lumScale, -1.0, 1.0));
    out.x   = round3(x);
    out.y   = round3(y);
}

} // namespace

const char* levelName(Level level) {
    switch (level) {
        case Level::Source: return "source";
        case Level::Clip:   return "clip";
        case Level::Region: return "region";
        case Level::Layer:  return "layer";
        case Level::Master: return "master";
    }
    return "source";
}

bool levelFromName(const std::string& name, Level& out) {
    if (name == "source") { out = Level::Source; return true; }
    if (name == "clip")   { out = Level::Clip;   return true; }
    if (name == "region") { out = Level::Region; return true; }
    if (name == "layer")  { out = Level::Layer;  return true; }
    if (name == "master") { out = Level::Master; return true; }
    return false;
}

// ── Curve ────────────────────────────────────────────────────────────────────

bool Curve::isIdentity() const {
    if (points.size() < 2) return true;
    if (points.size() != 2) return false;
    return points[0].x == 0.0f && points[0].y == 0.0f
        && points[1].x == 1.0f && points[1].y == 1.0f;
}

void sanitizeCurve(Curve& c) {
    auto& p = c.points;
    p.erase(std::remove_if(p.begin(), p.end(), [](const CurvePoint& q) {
        return !std::isfinite(q.x) || !std::isfinite(q.y);
    }), p.end());
    for (auto& q : p) {
        q.x = clampF(q.x, 0.0f, 1.0f);
        q.y = clampF(q.y, 0.0f, 1.0f);
    }
    std::stable_sort(p.begin(), p.end(),
                     [](const CurvePoint& a, const CurvePoint& b) { return a.x < b.x; });
    // Strictly increasing x: a point dropped onto (or dragged past) its
    // neighbour is removed, so the curve stays a function of x.
    std::vector<CurvePoint> kept;
    kept.reserve(p.size());
    for (const auto& q : p) {
        if (!kept.empty() && q.x - kept.back().x < kMinCurvePointGap) continue;
        kept.push_back(q);
        if (static_cast<int>(kept.size()) >= kMaxCurvePoints) break;
    }
    if (kept.size() < 2) kept.clear();   // the diagonal
    p.swap(kept);
    if (c.isIdentity()) p.clear();       // one spelling of "no change"
}

float evaluateCurve(const Curve& c, float xIn) {
    const auto& p = c.points;
    const size_t n = p.size();
    const double x = clamp01(xIn);
    if (n < 2) return static_cast<float>(x);
    if (x <= p.front().x) return clampF(p.front().y, 0.0f, 1.0f);
    if (x >= p.back().x)  return clampF(p.back().y, 0.0f, 1.0f);

    // Segment k: p[k].x <= x < p[k+1].x
    size_t k = 0;
    {
        size_t lo = 0, hi = n - 1;
        while (hi - lo > 1) {
            const size_t mid = (lo + hi) / 2;
            if (p[mid].x <= x) lo = mid; else hi = mid;
        }
        k = lo;
    }

    auto secant = [&](size_t i) {
        return (static_cast<double>(p[i + 1].y) - p[i].y)
             / (static_cast<double>(p[i + 1].x) - p[i].x);
    };
    // Fritsch-Carlson tangents: zero at a local extremum, otherwise the
    // weighted harmonic mean of the two neighbouring slopes. That mean never
    // exceeds three times the smaller slope, which is the condition for the
    // Hermite segment to stay monotone between its ends.
    auto tangent = [&](size_t i) -> double {
        if (i == 0)     return secant(0);
        if (i == n - 1) return secant(n - 2);
        const double d0 = secant(i - 1);
        const double d1 = secant(i);
        if (d0 * d1 <= 0.0) return 0.0;
        const double h0 = static_cast<double>(p[i].x) - p[i - 1].x;
        const double h1 = static_cast<double>(p[i + 1].x) - p[i].x;
        const double w0 = 2.0 * h1 + h0;
        const double w1 = h1 + 2.0 * h0;
        return (w0 + w1) / (w0 / d0 + w1 / d1);
    };

    const double x0 = p[k].x, x1 = p[k + 1].x;
    const double y0 = p[k].y, y1 = p[k + 1].y;
    const double h  = x1 - x0;
    const double t  = (x - x0) / h;
    const double m0 = tangent(k), m1 = tangent(k + 1);
    const double t2 = t * t, t3 = t2 * t;
    const double y = (2.0 * t3 - 3.0 * t2 + 1.0) * y0
                   + (t3 - 2.0 * t2 + t) * h * m0
                   + (-2.0 * t3 + 3.0 * t2) * y1
                   + (t3 - t2) * h * m1;
    return static_cast<float>(clamp01(y));
}

// ── ColorGrade ───────────────────────────────────────────────────────────────

bool ColorGrade::isNeutral() const {
    const bool lutOff = lutPath.empty() || lutAmount <= 0.0f;
    return transferIsIdentity(*this)
        && saturation == 0.0f && vibrance == 0.0f && hue == 0.0f
        && lutOff;
}

bool ColorGrade::operator==(const ColorGrade& o) const {
    return bypassed == o.bypassed
        && exposure == o.exposure && contrast == o.contrast
        && saturation == o.saturation && vibrance == o.vibrance
        && temperature == o.temperature && tint == o.tint && hue == o.hue
        && lift == o.lift && gamma == o.gamma && gain == o.gain
        && curveMaster == o.curveMaster && curveR == o.curveR
        && curveG == o.curveG && curveB == o.curveB
        && lutPath == o.lutPath && lutAmount == o.lutAmount;
}

void sanitizeColorGrade(ColorGrade& g) {
    g.exposure    = clampF(finiteOr(g.exposure, 0.0f), -kExposureRange, kExposureRange);
    g.contrast    = clampF(finiteOr(g.contrast, 0.0f), -1.0f, 1.0f);
    g.saturation  = clampF(finiteOr(g.saturation, 0.0f), -1.0f, 1.0f);
    g.vibrance    = clampF(finiteOr(g.vibrance, 0.0f), -1.0f, 1.0f);
    g.temperature = clampF(finiteOr(g.temperature, 0.0f), -1.0f, 1.0f);
    g.tint        = clampF(finiteOr(g.tint, 0.0f), -1.0f, 1.0f);
    g.hue         = clampF(finiteOr(g.hue, 0.0f), -kHueRangeDeg, kHueRangeDeg);
    sanitizeWheel(g.lift);
    sanitizeWheel(g.gamma);
    sanitizeWheel(g.gain);
    sanitizeCurve(g.curveMaster);
    sanitizeCurve(g.curveR);
    sanitizeCurve(g.curveG);
    sanitizeCurve(g.curveB);
    g.lutAmount = clampF(finiteOr(g.lutAmount, 1.0f), 0.0f, 1.0f);
}

nlohmann::json colorGradeToJson(const ColorGrade& g) {
    nlohmann::json j = nlohmann::json::object();
    j["bypassed"]    = g.bypassed;
    j["exposure"]    = g.exposure;
    j["contrast"]    = g.contrast;
    j["saturation"]  = g.saturation;
    j["vibrance"]    = g.vibrance;
    j["temperature"] = g.temperature;
    j["tint"]        = g.tint;
    j["hue"]         = g.hue;
    j["lift"]        = wheelToJson(g.lift);
    j["gamma"]       = wheelToJson(g.gamma);
    j["gain"]        = wheelToJson(g.gain);
    // Every curve is always written, as its points; an empty list is the
    // diagonal. One shape for the reader, and a round trip keeps every point.
    j["curves"] = nlohmann::json{
        {"master", curveToJson(g.curveMaster)},
        {"r",      curveToJson(g.curveR)},
        {"g",      curveToJson(g.curveG)},
        {"b",      curveToJson(g.curveB)},
    };
    j["lut"] = nlohmann::json{ {"path", g.lutPath}, {"amount", g.lutAmount} };
    return j;
}

ColorGrade colorGradeFromJson(const nlohmann::json& j) {
    ColorGrade g;
    if (!j.is_object()) return g;
    auto num = [&](const char* key, float fallback) {
        const auto it = j.find(key);
        return (it != j.end() && it->is_number()) ? it->get<float>() : fallback;
    };
    {
        const auto it = j.find("bypassed");
        if (it != j.end() && it->is_boolean()) g.bypassed = it->get<bool>();
    }
    g.exposure    = num("exposure", 0.0f);
    g.contrast    = num("contrast", 0.0f);
    g.saturation  = num("saturation", 0.0f);
    g.vibrance    = num("vibrance", 0.0f);
    g.temperature = num("temperature", 0.0f);
    g.tint        = num("tint", 0.0f);
    g.hue         = num("hue", 0.0f);
    if (j.contains("lift"))  g.lift  = wheelFromJson(j["lift"]);
    if (j.contains("gamma")) g.gamma = wheelFromJson(j["gamma"]);
    if (j.contains("gain"))  g.gain  = wheelFromJson(j["gain"]);
    if (j.contains("curves") && j["curves"].is_object()) {
        const auto& c = j["curves"];
        if (c.contains("master")) g.curveMaster = curveFromJson(c["master"]);
        if (c.contains("r"))      g.curveR      = curveFromJson(c["r"]);
        if (c.contains("g"))      g.curveG      = curveFromJson(c["g"]);
        if (c.contains("b"))      g.curveB      = curveFromJson(c["b"]);
    }
    if (j.contains("lut") && j["lut"].is_object()) {
        const auto& l = j["lut"];
        const auto p = l.find("path");
        if (p != l.end() && p->is_string()) g.lutPath = p->get<std::string>();
        const auto a = l.find("amount");
        if (a != l.end() && a->is_number()) g.lutAmount = a->get<float>();
    }
    sanitizeColorGrade(g);
    return g;
}

// ── 3D LUT ───────────────────────────────────────────────────────────────────

std::shared_ptr<const Lut3D> parseCubeLut(const std::string& text, std::string& error) {
    error.clear();
    auto lut = std::make_shared<Lut3D>();
    std::istringstream in(text);
    std::string line;
    size_t expected = 0;
    bool is1D = false;

    while (std::getline(in, line)) {
        // Trim, drop comments and blank lines. Files written on Windows carry
        // a CR; files saved with a BOM carry three bytes before the first key.
        if (line.size() >= 3 && static_cast<unsigned char>(line[0]) == 0xEF
            && static_cast<unsigned char>(line[1]) == 0xBB
            && static_cast<unsigned char>(line[2]) == 0xBF)
            line.erase(0, 3);
        const size_t hash = line.find('#');
        if (hash != std::string::npos) line.erase(hash);
        const size_t b = line.find_first_not_of(" \t\r\n");
        if (b == std::string::npos) continue;
        const size_t e = line.find_last_not_of(" \t\r\n");
        line = line.substr(b, e - b + 1);

        const unsigned char first = static_cast<unsigned char>(line[0]);
        const bool isData = std::isdigit(first) || first == '-' || first == '+' || first == '.';
        if (!isData) {
            std::istringstream ls(line);
            std::string key;
            ls >> key;
            if (key == "TITLE") {
                const size_t q0 = line.find('"');
                const size_t q1 = line.rfind('"');
                if (q0 != std::string::npos && q1 > q0) lut->title = line.substr(q0 + 1, q1 - q0 - 1);
            } else if (key == "LUT_3D_SIZE") {
                int n = 0;
                ls >> n;
                if (n < 2 || n > kMaxLut3DSize) {
                    error = "LUT size " + std::to_string(n) + " is outside 2.."
                          + std::to_string(kMaxLut3DSize);
                    return nullptr;
                }
                lut->size = n;
                expected = static_cast<size_t>(n) * n * n;
                lut->rgb.reserve(expected * 3);
            } else if (key == "LUT_1D_SIZE") {
                is1D = true;
            } else if (key == "DOMAIN_MIN") {
                ls >> lut->domainMin[0] >> lut->domainMin[1] >> lut->domainMin[2];
            } else if (key == "DOMAIN_MAX") {
                ls >> lut->domainMax[0] >> lut->domainMax[1] >> lut->domainMax[2];
            }
            // Any other keyword (LUT_3D_INPUT_RANGE, vendor tags) is ignored.
            continue;
        }

        if (is1D) {
            error = "this is a 1D LUT; only 3D .cube LUTs can be imported";
            return nullptr;
        }
        if (lut->size == 0) {
            error = "LUT data appears before LUT_3D_SIZE";
            return nullptr;
        }
        std::istringstream ls(line);
        float r = 0.0f, g = 0.0f, bl = 0.0f;
        if (!(ls >> r >> g >> bl)) {
            error = "unreadable LUT row: " + line;
            return nullptr;
        }
        if (lut->rgb.size() < expected * 3) {
            lut->rgb.push_back(finiteOr(r, 0.0f));
            lut->rgb.push_back(finiteOr(g, 0.0f));
            lut->rgb.push_back(finiteOr(bl, 0.0f));
        }
    }

    if (is1D && lut->size == 0) {
        error = "this is a 1D LUT; only 3D .cube LUTs can be imported";
        return nullptr;
    }
    if (lut->size == 0) {
        error = "no LUT_3D_SIZE found; this does not look like a .cube LUT";
        return nullptr;
    }
    if (lut->rgb.size() != expected * 3) {
        error = "LUT has " + std::to_string(lut->rgb.size() / 3) + " rows, expected "
              + std::to_string(expected);
        return nullptr;
    }
    for (int c = 0; c < 3; ++c) {
        if (!std::isfinite(lut->domainMin[c]) || !std::isfinite(lut->domainMax[c])
            || lut->domainMax[c] - lut->domainMin[c] < 1e-6f) {
            lut->domainMin[c] = 0.0f;
            lut->domainMax[c] = 1.0f;
        }
    }
    lut->serial = g_nextSerial.fetch_add(1, std::memory_order_relaxed);
    return lut;
}

std::shared_ptr<const Lut3D> loadCubeLutFile(const std::string& utf8Path, std::string& error) {
    error.clear();
    std::ifstream f;
    try {
        const std::u8string u8(utf8Path.begin(), utf8Path.end());
        f.open(std::filesystem::path(u8), std::ios::binary);
    } catch (...) {
        error = "could not open the LUT file";
        return nullptr;
    }
    if (!f) {
        error = "could not open the LUT file";
        return nullptr;
    }
    std::ostringstream ss;
    ss << f.rdbuf();
    return parseCubeLut(ss.str(), error);
}

void sampleLut3D(const Lut3D& lut, const float in[3], float out[3]) {
    const int n = lut.size;
    if (n < 2 || lut.rgb.size() != static_cast<size_t>(n) * n * n * 3) {
        out[0] = in[0]; out[1] = in[1]; out[2] = in[2];
        return;
    }
    double f[3];
    int    i0[3], i1[3];
    for (int c = 0; c < 3; ++c) {
        const double u = clamp01((static_cast<double>(in[c]) - lut.domainMin[c])
                                 / (static_cast<double>(lut.domainMax[c]) - lut.domainMin[c]));
        const double p = u * (n - 1);
        i0[c] = std::min(n - 1, static_cast<int>(std::floor(p)));
        i1[c] = std::min(n - 1, i0[c] + 1);
        f[c]  = p - i0[c];
    }
    auto at = [&](int r, int g, int b, int ch) {
        return static_cast<double>(
            lut.rgb[(static_cast<size_t>(b) * n * n + static_cast<size_t>(g) * n + r) * 3 + ch]);
    };
    for (int ch = 0; ch < 3; ++ch) {
        const double c00 = at(i0[0], i0[1], i0[2], ch) * (1 - f[0]) + at(i1[0], i0[1], i0[2], ch) * f[0];
        const double c10 = at(i0[0], i1[1], i0[2], ch) * (1 - f[0]) + at(i1[0], i1[1], i0[2], ch) * f[0];
        const double c01 = at(i0[0], i0[1], i1[2], ch) * (1 - f[0]) + at(i1[0], i0[1], i1[2], ch) * f[0];
        const double c11 = at(i0[0], i1[1], i1[2], ch) * (1 - f[0]) + at(i1[0], i1[1], i1[2], ch) * f[0];
        const double c0  = c00 * (1 - f[1]) + c10 * f[1];
        const double c1  = c01 * (1 - f[1]) + c11 * f[1];
        out[ch] = static_cast<float>(c0 * (1 - f[2]) + c1 * f[2]);
    }
}

std::shared_ptr<const Lut3D> Lut3DLibrary::get(const std::string& utf8Path) {
    if (utf8Path.empty()) return nullptr;
    for (const auto& e : entries_)
        if (e.first == utf8Path) return e.second.lut;
    Entry entry;
    entry.lut = loadCubeLutFile(utf8Path, entry.error);
    entries_.emplace_back(utf8Path, entry);
    return entry.lut;
}

std::string Lut3DLibrary::errorFor(const std::string& utf8Path) const {
    for (const auto& e : entries_)
        if (e.first == utf8Path) return e.second.error;
    return {};
}

void Lut3DLibrary::forget(const std::string& utf8Path) {
    entries_.erase(std::remove_if(entries_.begin(), entries_.end(),
                                  [&](const auto& e) { return e.first == utf8Path; }),
                   entries_.end());
}

void Lut3DLibrary::clear() { entries_.clear(); }

// ── Baking ───────────────────────────────────────────────────────────────────

float evaluateTransfer(const ColorGrade& g, int channel, float xIn) {
    double v = clamp01(xIn);

    // 1 + 2: exposure and white balance, in linear light.
    if (g.exposure != 0.0f || g.temperature != 0.0f || g.tint != 0.0f) {
        double wb[3];
        whiteBalanceGains(g.temperature, g.tint, wb);
        const double lin = srgbToLinear(v) * std::exp2(static_cast<double>(g.exposure)) * wb[channel];
        v = linearToSrgb(lin);
    }

    // 3: lift / gamma / gain.
    if (!wheelsNeutral(g)) {
        double cl[3], cm[3], cg[3];
        wheelChroma(g.lift, cl);
        wheelChroma(g.gamma, cm);
        wheelChroma(g.gain, cg);
        const double lift  = kLiftLumScale * g.lift.lum + kLiftChromaScale * cl[channel];
        const double gamma = std::exp2(kGammaLumScale * g.gamma.lum + kGammaChromaScale * cm[channel]);
        const double gain  = std::exp2(kGainLumScale * g.gain.lum + kGainChromaScale * cg[channel]);
        v = gain * (v + lift * (1.0 - v));
        v = v <= 0.0 ? 0.0 : std::pow(v, 1.0 / gamma);
    }

    v = clamp01(v);

    // 4: contrast.
    if (g.contrast != 0.0f)
        v = contrastCurve(v, std::exp2(static_cast<double>(g.contrast) * kContrastScale));

    // 5: curves, master first.
    v = evaluateCurve(g.curveMaster, static_cast<float>(v));
    const Curve& ch = channel == 0 ? g.curveR : (channel == 1 ? g.curveG : g.curveB);
    v = evaluateCurve(ch, static_cast<float>(v));
    return static_cast<float>(clamp01(v));
}

std::shared_ptr<const BakedGrade> bakeColorGrade(const ColorGrade& gIn, Lut3DLibrary* luts) {
    if (!gIn.isActive()) return nullptr;
    ColorGrade g = gIn;
    sanitizeColorGrade(g);

    auto b = std::make_shared<BakedGrade>();
    b->grade = gIn;

    if (!transferIsIdentity(g)) {
        b->hasTransfer = true;
        b->transfer.resize(static_cast<size_t>(kTransferLutSize) * 4);
        for (int i = 0; i < kTransferLutSize; ++i) {
            const float x = static_cast<float>(i) / static_cast<float>(kTransferLutSize - 1);
            for (int c = 0; c < 3; ++c) {
                const float y = evaluateTransfer(g, c, x);
                b->transfer[static_cast<size_t>(i) * 4 + c] =
                    static_cast<uint16_t>(std::lround(clamp01(y) * 65535.0));
            }
            b->transfer[static_cast<size_t>(i) * 4 + 3] = 65535;
        }
    }

    b->vibrance = g.vibrance;

    if (g.saturation != 0.0f || g.hue != 0.0f) {
        b->hasMatrix = true;
        const double s = 1.0 + static_cast<double>(g.saturation);   // 0..2
        const double w[3] = { kLumaR, kLumaG, kLumaB };
        double S[3][3];
        for (int r = 0; r < 3; ++r)
            for (int c = 0; c < 3; ++c)
                S[r][c] = (1.0 - s) * w[c] + (r == c ? s : 0.0);
        // Hue: rotation about the grey axis. Positive turns red towards yellow.
        const double th = static_cast<double>(g.hue) * 3.14159265358979323846 / 180.0;
        const double cs = std::cos(th), sn = std::sin(th);
        const double a = (1.0 - cs) / 3.0;
        const double k = sn / std::sqrt(3.0);
        const double H[3][3] = {
            { cs + a, a - k,  a + k  },
            { a + k,  cs + a, a - k  },
            { a - k,  a + k,  cs + a },
        };
        for (int r = 0; r < 3; ++r)
            for (int c = 0; c < 3; ++c) {
                double v = 0.0;
                for (int i = 0; i < 3; ++i) v += H[r][i] * S[i][c];
                b->matrix[r * 3 + c] = static_cast<float>(v);
            }
    }

    if (!g.lutPath.empty() && g.lutAmount > 0.0f && luts) {
        b->lut3d = luts->get(g.lutPath);
        b->lutAmount = b->lut3d ? g.lutAmount : 0.0f;
    }

    // A grade whose only content is a LUT that could not be loaded renders as
    // nothing; say so by returning no baked grade at all.
    if (!b->hasTransfer && !b->hasMatrix && b->vibrance == 0.0f && !b->lut3d)
        return nullptr;

    b->serial = g_nextSerial.fetch_add(1, std::memory_order_relaxed);
    return b;
}

void applyBakedGrade(const BakedGrade& b, float rgb[3]) {
    double c[3] = { clamp01(rgb[0]), clamp01(rgb[1]), clamp01(rgb[2]) };

    if (b.hasTransfer && b.transfer.size() == static_cast<size_t>(kTransferLutSize) * 4) {
        for (int ch = 0; ch < 3; ++ch) {
            const double p  = c[ch] * (kTransferLutSize - 1);
            const int    i0 = std::min(kTransferLutSize - 1, static_cast<int>(std::floor(p)));
            const int    i1 = std::min(kTransferLutSize - 1, i0 + 1);
            const double f  = p - i0;
            const double a0 = b.transfer[static_cast<size_t>(i0) * 4 + ch] / 65535.0;
            const double a1 = b.transfer[static_cast<size_t>(i1) * 4 + ch] / 65535.0;
            c[ch] = a0 + (a1 - a0) * f;
        }
    }

    if (b.vibrance != 0.0f) {
        const double mx = std::max(c[0], std::max(c[1], c[2]));
        const double mn = std::min(c[0], std::min(c[1], c[2]));
        const double luma = kLumaR * c[0] + kLumaG * c[1] + kLumaB * c[2];
        const double f = std::max(0.0, 1.0 + static_cast<double>(b.vibrance) * (1.0 - (mx - mn)));
        for (int ch = 0; ch < 3; ++ch) c[ch] = luma + (c[ch] - luma) * f;
    }

    if (b.hasMatrix) {
        const double r = c[0], g = c[1], bl = c[2];
        for (int row = 0; row < 3; ++row)
            c[row] = b.matrix[row * 3 + 0] * r + b.matrix[row * 3 + 1] * g + b.matrix[row * 3 + 2] * bl;
    }

    for (int ch = 0; ch < 3; ++ch) c[ch] = clamp01(c[ch]);

    if (b.lut3d && b.lutAmount > 0.0f) {
        const float in[3] = { static_cast<float>(c[0]), static_cast<float>(c[1]), static_cast<float>(c[2]) };
        float out[3];
        sampleLut3D(*b.lut3d, in, out);
        for (int ch = 0; ch < 3; ++ch)
            c[ch] = clamp01(c[ch] + (static_cast<double>(out[ch]) - c[ch]) * b.lutAmount);
    }

    rgb[0] = static_cast<float>(c[0]);
    rgb[1] = static_cast<float>(c[1]);
    rgb[2] = static_cast<float>(c[2]);
}

// ── Auto ─────────────────────────────────────────────────────────────────────

void GradeAnalysis::addFrame(const uint8_t* data, int width, int height, int stride,
                             int bytesPerPixel, int rOffset, int gOffset, int bOffset) {
    if (!data || width <= 0 || height <= 0 || bytesPerPixel < 3) return;
    for (int y = 0; y < height; ++y) {
        const uint8_t* row = data + static_cast<size_t>(y) * stride;
        for (int x = 0; x < width; ++x) {
            const uint8_t* px = row + static_cast<size_t>(x) * bytesPerPixel;
            const int r = px[rOffset], g = px[gOffset], b = px[bOffset];
            ++histR[r];
            ++histG[g];
            ++histB[b];
            // Integer Rec.709 luma (weights sum to 1 << 15), so the statistics
            // are bit-identical on every machine.
            const int luma = (6966 * r + 23436 * g + 2366 * b + 16384) >> 15;
            ++histLuma[std::min(255, luma)];
            const int mx = std::max(r, std::max(g, b));
            const int mn = std::min(r, std::min(g, b));
            ++histChroma[mx - mn];
        }
    }
    pixels += static_cast<uint64_t>(width) * static_cast<uint64_t>(height);
    ++frames;
}

double GradeAnalysis::percentile(const std::array<uint64_t, kBins>& hist, double fraction) {
    uint64_t total = 0;
    for (uint64_t v : hist) total += v;
    if (total == 0) return 0.0;
    const double target = std::clamp(fraction, 0.0, 1.0) * static_cast<double>(total);
    double cum = 0.0;
    for (int i = 0; i < kBins; ++i) {
        const double next = cum + static_cast<double>(hist[i]);
        if (next >= target && hist[i] > 0) {
            const double within = (target - cum) / static_cast<double>(hist[i]);
            return std::clamp((i + within - 0.5) / 255.0, 0.0, 1.0);
        }
        cum = next;
    }
    return 1.0;
}

double GradeAnalysis::mean(const std::array<uint64_t, kBins>& hist) {
    uint64_t total = 0;
    double   sum = 0.0;
    for (int i = 0; i < kBins; ++i) {
        total += hist[i];
        sum += static_cast<double>(hist[i]) * i;
    }
    return total ? (sum / static_cast<double>(total)) / 255.0 : 0.0;
}

nlohmann::json gradeAnalysisToJson(const GradeAnalysis& a) {
    auto arr = [](const std::array<uint64_t, GradeAnalysis::kBins>& h) {
        nlohmann::json out = nlohmann::json::array();
        for (uint64_t v : h) out.push_back(v);
        return out;
    };
    return nlohmann::json{
        {"frames", a.frames},
        {"pixels", a.pixels},
        {"r", arr(a.histR)},
        {"g", arr(a.histG)},
        {"b", arr(a.histB)},
        {"luma", arr(a.histLuma)},
        {"blackPoint", GradeAnalysis::percentile(a.histLuma, 0.005)},
        {"whitePoint", GradeAnalysis::percentile(a.histLuma, 0.995)},
        {"median",     GradeAnalysis::percentile(a.histLuma, 0.5)},
        {"meanChroma", GradeAnalysis::mean(a.histChroma)},
    };
}

ColorGrade autoGradeFromAnalysis(const GradeAnalysis& a) {
    ColorGrade g;
    if (a.empty()) return g;

    // Where the picture's darkest and brightest half percent sit, overall and
    // per channel. Percentiles, not min/max: one stuck pixel or a burnt-in
    // caption must not decide the correction.
    const double kLo = 0.005, kHi = 0.995;
    const double loY = GradeAnalysis::percentile(a.histLuma, kLo);
    const double hiY = GradeAnalysis::percentile(a.histLuma, kHi);
    const double lo[3] = { GradeAnalysis::percentile(a.histR, kLo),
                           GradeAnalysis::percentile(a.histG, kLo),
                           GradeAnalysis::percentile(a.histB, kLo) };
    const double hi[3] = { GradeAnalysis::percentile(a.histR, kHi),
                           GradeAnalysis::percentile(a.histG, kHi),
                           GradeAnalysis::percentile(a.histB, kHi) };

    // Nearly flat footage (a title card, a solid colour) gives levels nothing
    // to hold on to; stretching it would only amplify noise.
    if (hiY - loY < 0.08) return g;

    // Where black and white should land. Just inside the range, so a
    // correction never clips what it is placing.
    const double tLo = 0.012, tHi = 0.985;

    // How much of each problem there is. Both ramp in from zero, so healthy
    // footage (blacks already near black, whites already near white) gets
    // nothing, and footage just past the threshold gets a little.
    const double wBlack = smoothstep(0.035, 0.10, loY);          // lifted / milky blacks
    const double wWhite = smoothstep(0.035, 0.12, 1.0 - hiY);    // dim / washed highlights

    double lift[3], gainLog[3];
    for (int c = 0; c < 3; ++c) {
        // Colour cast: a channel whose black (or white) point sits away from
        // the picture's overall one. Shadows are trusted more than highlights:
        // faded stock tints its blacks, while a bright coloured subject can
        // legitimately own the top of one channel.
        // A small deviation is ordinary picture content and is left alone; a
        // clear one is corrected in full (the weight ramps between the two, so
        // there is no threshold to jump across), up to a cap.
        const double castLo = castCorrection(lo[c] - loY, 0.006, 0.024, 0.12, 1.00);
        const double castHi = castCorrection(hi[c] - hiY, 0.012, 0.040, 0.08, 0.60);

        const double B = std::clamp(tLo + wBlack * (loY - tLo) + castLo, 0.0, 0.6);
        const double W = std::clamp(tHi + wWhite * (hiY - tHi) + castHi, B + 0.15, 1.0);

        // Solve out = gain * (x + lift * (1 - x)) for B -> tLo and W -> tHi.
        const double r = tLo / tHi;
        const double u = (B - r * W) / (r - 1.0);
        double l = u / (1.0 + u);
        l = std::clamp(l, -0.34, 0.20);
        double gn = tHi / (W * (1.0 - l) + l);
        gn = std::clamp(gn, 0.60, 2.40);
        lift[c]    = l;
        gainLog[c] = std::log2(gn);
    }

    channelsToWheel(lift, kLiftLumScale, kLiftChromaScale, g.lift);
    channelsToWheel(gainLog, kGainLumScale, kGainChromaScale, g.gain);

    // What the levels above do to brightness overall.
    const double liftY = kLumaR * lift[0] + kLumaG * lift[1] + kLumaB * lift[2];
    const double gainY = std::exp2(kLumaR * gainLog[0] + kLumaG * gainLog[1] + kLumaB * gainLog[2]);

    // Midtones: only when the corrected middle is clearly off, and only part of
    // the way. Dark-on-purpose footage should stay dark-ish.
    {
        const double med  = GradeAnalysis::percentile(a.histLuma, 0.5);
        const double medC = std::clamp(gainY * (med + liftY * (1.0 - med)), 0.02, 0.98);
        double want = medC;
        if (medC < 0.30)      want = medC + 0.5 * (0.30 - medC);
        else if (medC > 0.58) want = medC + 0.5 * (0.58 - medC);
        if (want != medC) {
            const double gm = std::clamp(std::log(medC) / std::log(want), 0.72, 1.45);
            g.gamma.lum = round3(std::clamp(std::log2(gm) / kGammaLumScale, -1.0, 1.0));
        }
    }

    // Saturation, judged as it will be after the levels above (stretching the
    // range stretches colour with it). Faded -> vibrance, which lifts muted
    // colours without pushing the strong ones; over-boosted -> saturation down.
    {
        const double chroma  = GradeAnalysis::mean(a.histChroma);
        const double stretch = std::clamp(gainY * (1.0 - liftY), 0.5, 2.5);
        const double c       = std::min(1.0, chroma * stretch);
        // Genuinely black-and-white footage has nothing to bring back.
        const double hasColour = smoothstep(0.010, 0.030, chroma);
        if (c < 0.10) {
            g.vibrance = round3(std::min(0.60, (0.10 - c) / 0.10 * 1.2) * hasColour);
        } else if (c > 0.40) {
            g.saturation = round3(-std::min(0.50, (c - 0.40) / 0.40));
        }
    }

    sanitizeColorGrade(g);
    return g;
}

ColorGrade applyAutoGrade(const ColorGrade& base, const ColorGrade& autoFull, float strength) {
    const float s = clampF(finiteOr(strength, 1.0f), 0.0f, 1.0f);
    ColorGrade out = base;
    auto blend = [s](const Wheel& w) {
        Wheel r;
        r.x = round3(w.x * s);
        r.y = round3(w.y * s);
        r.lum = round3(w.lum * s);
        return r;
    };
    out.lift       = blend(autoFull.lift);
    out.gamma      = blend(autoFull.gamma);
    out.gain       = blend(autoFull.gain);
    out.saturation = round3(autoFull.saturation * s);
    out.vibrance   = round3(autoFull.vibrance * s);
    sanitizeColorGrade(out);
    return out;
}

// ── Snapshot ─────────────────────────────────────────────────────────────────

const ColorGradeSnapshot::Baked& ColorGradeSnapshot::find(const Table& t, int id) {
    static const Baked kNone;
    const auto it = std::lower_bound(t.begin(), t.end(), id,
        [](const std::pair<int, Baked>& e, int key) { return e.first < key; });
    return (it != t.end() && it->first == id) ? it->second : kNone;
}

std::shared_ptr<const BakedGrade> bakeOrReuse(const ColorGrade& g,
                                              const std::shared_ptr<const BakedGrade>& previous,
                                              Lut3DLibrary* luts) {
    if (!g.isActive()) return nullptr;
    if (previous && previous->grade == g) {
        const std::shared_ptr<const Lut3D> lut =
            (luts && !g.lutPath.empty() && g.lutAmount > 0.0f) ? luts->get(g.lutPath) : nullptr;
        if (lut == previous->lut3d) return previous;
    }
    return bakeColorGrade(g, luts);
}

} // namespace xleth::grade
