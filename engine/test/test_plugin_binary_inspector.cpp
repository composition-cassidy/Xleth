// test_plugin_binary_inspector — PE preflight parser (P2, docs/PLUGIN_HOSTING_LOG.md).
//
// Inputs (all real files, nothing synthesised by hand):
//   1. a real x64 DLL from System32                  → Ok (no format) / NoEntryPoint (VST3)
//   2. a 32-bit DLL from SysWOW64                     → WrongArch32
//   3. a text file renamed .dll                       → NotPE
//   4. a truncated copy (first 512 bytes) of (1)      → NotPE, no crash
// plus VST3 bundle resolution (x86_64-win, x86-win only), a missing path, and
// prefixes of the real DLL's first 4 KiB in 16-byte steps (must never crash).
//
// Pure std + <filesystem>; no JUCE. Runs in Release, so checks never use assert().

#include "audio/PluginBinaryInspector.h"

#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <string>
#include <vector>

namespace fs = std::filesystem;
using Status = PluginBinaryInfo::Status;

static int g_failures = 0;
static int g_checks   = 0;

#define CHECK(cond, ...)                                                      \
    do {                                                                      \
        ++g_checks;                                                           \
        if (!(cond)) {                                                        \
            ++g_failures;                                                     \
            std::fprintf(stderr, "FAIL %s:%d: %s — ", __FILE__, __LINE__, #cond); \
            std::fprintf(stderr, __VA_ARGS__);                                \
            std::fprintf(stderr, "\n");                                       \
        }                                                                     \
    } while (0)

static std::string u8(const fs::path& p)
{
    const auto s = p.u8string();
    return std::string(s.begin(), s.end());
}

static fs::path windowsDir()
{
    const char* w = std::getenv("SystemRoot");
    return fs::path(w ? w : "C:\\Windows");
}

static bool copyPrefix(const fs::path& src, const fs::path& dst, std::size_t n)
{
    std::ifstream in(src, std::ios::binary);
    if (!in) return false;
    std::vector<char> buf(n);
    in.read(buf.data(), static_cast<std::streamsize>(n));
    const auto got = static_cast<std::size_t>(in.gcount());
    std::ofstream out(dst, std::ios::binary | std::ios::trunc);
    out.write(buf.data(), static_cast<std::streamsize>(got));
    return static_cast<bool>(out);
}

int main()
{
    std::printf("=== test_plugin_binary_inspector ===\n");

    const fs::path sys64  = windowsDir() / "System32" / "kernel32.dll";
    const fs::path sys32  = windowsDir() / "SysWOW64" / "kernel32.dll";
    const fs::path tmpDir = fs::temp_directory_path() / ("xleth_pbi_test_" + std::to_string(std::rand()) + "_"
                                                         + std::to_string(static_cast<long long>(
                                                               fs::file_time_type::clock::now().time_since_epoch().count())));
    std::error_code ec;
    fs::create_directories(tmpDir, ec);
    CHECK(!ec, "could not create %s", u8(tmpDir).c_str());

    // ── 1. Real x64 DLL ──────────────────────────────────────────────────────
    {
        std::printf("Test 1: x64 DLL (%s)\n", u8(sys64).c_str());
        CHECK(fs::exists(sys64), "missing %s", u8(sys64).c_str());

        const auto any = PluginBinaryInspector::inspect(u8(sys64), "");
        CHECK(any.status == Status::Ok, "status %s", PluginBinaryInspector::statusName(any.status));
        CHECK(any.machine == "AMD64", "machine %s", any.machine.c_str());
        CHECK(any.exports.size() > 500, "only %zu exports", any.exports.size());
        const bool hasCreateFileW =
            std::find(any.exports.begin(), any.exports.end(), "CreateFileW") != any.exports.end();
        CHECK(hasCreateFileW, "CreateFileW not among %zu exports", any.exports.size());

        const auto vst3 = PluginBinaryInspector::inspect(u8(sys64), "VST3");
        CHECK(vst3.status == Status::NoEntryPoint, "VST3 status %s",
              PluginBinaryInspector::statusName(vst3.status));
        CHECK(std::string(PluginBinaryInspector::failureReason(vst3.status)) == "no-entry-point",
              "reason %s", PluginBinaryInspector::failureReason(vst3.status));

        const auto clap = PluginBinaryInspector::inspect(u8(sys64), "CLAP");
        CHECK(clap.status == Status::NoEntryPoint, "CLAP status %s",
              PluginBinaryInspector::statusName(clap.status));

        // Wide-path overload agrees.
        const auto wide = PluginBinaryInspector::inspect(sys64.wstring(), "");
        CHECK(wide.status == Status::Ok && wide.exports.size() == any.exports.size(),
              "wide overload: %s, %zu exports", PluginBinaryInspector::statusName(wide.status),
              wide.exports.size());
    }

    // ── 2. 32-bit DLL ────────────────────────────────────────────────────────
    {
        std::printf("Test 2: x86 DLL (%s)\n", u8(sys32).c_str());
        CHECK(fs::exists(sys32), "missing %s", u8(sys32).c_str());
        const auto info = PluginBinaryInspector::inspect(u8(sys32), "VST3");
        CHECK(info.status == Status::WrongArch32, "status %s",
              PluginBinaryInspector::statusName(info.status));
        CHECK(info.machine == "I386", "machine %s", info.machine.c_str());
        CHECK(std::string(PluginBinaryInspector::failureReason(info.status)) == "not-64bit",
              "reason %s", PluginBinaryInspector::failureReason(info.status));
    }

    // ── 3. Text file renamed .dll ────────────────────────────────────────────
    {
        std::printf("Test 3: text file renamed .dll\n");
        const auto txt = tmpDir / "NotAPlugin.dll";
        {
            std::ofstream o(txt, std::ios::binary);
            o << "This is a text file, not a PE image.\r\nMZ appears later but not at offset 0.\r\n";
        }
        const auto info = PluginBinaryInspector::inspect(u8(txt), "VST3");
        CHECK(info.status == Status::NotPE, "status %s", PluginBinaryInspector::statusName(info.status));
        CHECK(std::string(PluginBinaryInspector::failureReason(info.status)) == "not-a-binary",
              "reason %s", PluginBinaryInspector::failureReason(info.status));

        // "MZ" + garbage: DOS magic right, everything after it wrong.
        const auto mz = tmpDir / "MzGarbage.dll";
        {
            std::ofstream o(mz, std::ios::binary);
            o << "MZ";
            for (int i = 0; i < 200; ++i) o.put(static_cast<char>(0xFF));
        }
        const auto info2 = PluginBinaryInspector::inspect(u8(mz), "VST3");
        CHECK(info2.status == Status::NotPE, "MZ+garbage status %s",
              PluginBinaryInspector::statusName(info2.status));
    }

    // ── 4. Truncated copy of the real DLL (first 512 bytes) ─────────────────
    {
        std::printf("Test 4: truncated DLL (512 bytes)\n");
        const auto cut = tmpDir / "Truncated.dll";
        CHECK(copyPrefix(sys64, cut, 512), "copy failed");
        CHECK(fs::file_size(cut, ec) == 512, "size %llu", (unsigned long long)fs::file_size(cut, ec));
        const auto info = PluginBinaryInspector::inspect(u8(cut), "VST3");
        CHECK(info.status == Status::NotPE, "status %s", PluginBinaryInspector::statusName(info.status));
        const auto info2 = PluginBinaryInspector::inspect(u8(cut), "");
        CHECK(info2.status == Status::NotPE, "no-format status %s",
              PluginBinaryInspector::statusName(info2.status));

        // Robustness sweep: prefix lengths 0..4096 (step 16 — every write of a
        // PE-looking file is AV-scanned, step 1 took 50 s) must return without
        // crashing, and none of them may claim Ok with an entry point.
        std::printf("Test 4b: prefix sweep 0..4096 step 16\n");
        int okCount = 0;
        for (std::size_t n = 0; n <= 4096; n += 16)
        {
            if (!copyPrefix(sys64, cut, n)) { CHECK(false, "copy %zu failed", n); break; }
            const auto r = PluginBinaryInspector::inspect(u8(cut), "VST3");
            if (r.status == Status::Ok) ++okCount;
        }
        CHECK(okCount == 0, "%d prefixes reported Ok", okCount);
    }

    // ── 5. VST3 bundle resolution ───────────────────────────────────────────
    {
        std::printf("Test 5: VST3 bundles\n");
        const auto good = tmpDir / "Good.vst3";
        fs::create_directories(good / "Contents" / "x86_64-win", ec);
        fs::copy_file(sys64, good / "Contents" / "x86_64-win" / "Good.vst3",
                      fs::copy_options::overwrite_existing, ec);
        const auto g = PluginBinaryInspector::inspect(u8(good), "VST3");
        CHECK(g.status == Status::NoEntryPoint, "x64 bundle status %s",
              PluginBinaryInspector::statusName(g.status));
        CHECK(g.binaryPath.find("x86_64-win") != std::string::npos, "binaryPath %s", g.binaryPath.c_str());

        const auto old = tmpDir / "Old32.vst3";
        fs::create_directories(old / "Contents" / "x86-win", ec);
        fs::copy_file(sys32, old / "Contents" / "x86-win" / "Old32.vst3",
                      fs::copy_options::overwrite_existing, ec);
        const auto o = PluginBinaryInspector::inspect(u8(old), "VST3");
        CHECK(o.status == Status::WrongArch32, "x86-only bundle status %s",
              PluginBinaryInspector::statusName(o.status));

        const auto empty = tmpDir / "Empty.vst3";
        fs::create_directories(empty / "Contents" / "Resources", ec);
        const auto e = PluginBinaryInspector::inspect(u8(empty), "VST3");
        CHECK(e.status == Status::NotPE, "no-binary bundle status %s",
              PluginBinaryInspector::statusName(e.status));
    }

    // ── 6. Missing path ──────────────────────────────────────────────────────
    {
        std::printf("Test 6: missing path\n");
        const auto info = PluginBinaryInspector::inspect(u8(tmpDir / "DoesNotExist.vst3"), "VST3");
        CHECK(info.status == Status::Unreadable, "status %s",
              PluginBinaryInspector::statusName(info.status));
    }

    // ── 7. Format table ─────────────────────────────────────────────────────
    {
        std::printf("Test 7: format table\n");
        CHECK(PluginBinaryInspector::requiredExports("VST3").size() == 1, "VST3");
        CHECK(PluginBinaryInspector::requiredExports("VST").size() == 2, "VST");
        CHECK(PluginBinaryInspector::requiredExports("CLAP").size() == 1, "CLAP");
        CHECK(PluginBinaryInspector::requiredExports("AU").empty(), "AU");
    }

    // ── 8. A real VST3, if one is installed (informational) ─────────────────
    {
        const fs::path uni = "C:\\Program Files\\Common Files\\VST3\\XLETH\\UniFlange.vst3";
        if (fs::exists(uni, ec))
        {
            std::printf("Test 8: real VST3 bundle (%s)\n", u8(uni).c_str());
            const auto info = PluginBinaryInspector::inspect(u8(uni), "VST3");
            CHECK(info.status == Status::Ok, "status %s", PluginBinaryInspector::statusName(info.status));
        }
        else
        {
            std::printf("Test 8: skipped (no UniFlange.vst3 installed)\n");
        }
    }

    fs::remove_all(tmpDir, ec);

    if (g_failures == 0)
    {
        std::printf("ALL TESTS PASSED (%d checks)\n", g_checks);
        return 0;
    }
    std::printf("%d of %d checks FAILED\n", g_failures, g_checks);
    return 1;
}
