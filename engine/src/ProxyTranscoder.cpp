#ifdef _MSC_VER
  #define _CRT_SECURE_NO_WARNINGS
#endif

#include "ProxyTranscoder.h"

#include <algorithm>
#include <chrono>
#include <cstdio>
#include <deque>
#include <filesystem>
#include <iostream>
#include <regex>
#include <sstream>

#if defined(_WIN32) || defined(_WIN64)
  #define WIN32_LEAN_AND_MEAN
  #define NOMINMAX
  #include <windows.h>
#else
  #include <cstdlib>
#endif

namespace fs = std::filesystem;

// ── helpers ──────────────────────────────────────────────────────────────────

// Parse "HH:MM:SS.xx" into seconds
static double parseTimeString(const std::string& t)
{
    int h = 0, m = 0;
    double s = 0.0;
    if (std::sscanf(t.c_str(), "%d:%d:%lf", &h, &m, &s) >= 3)
        return h * 3600.0 + m * 60.0 + s;
    if (std::sscanf(t.c_str(), "%d:%lf", &m, &s) >= 2)
        return m * 60.0 + s;
    return 0.0;
}

// Probe source duration using ffprobe / ffmpeg -i (quick & reliable)
static double probeDuration(const std::string& inputPath)
{
    // Use ffprobe if available, fall back to ffmpeg -i
    std::string cmd = "ffprobe -v error -show_entries format=duration "
                      "-of default=noprint_wrappers=1:nokey=1 \"" + inputPath + "\" 2>&1";

#if defined(_WIN32) || defined(_WIN64)
    FILE* pipe = _popen(cmd.c_str(), "r");
#else
    FILE* pipe = popen(cmd.c_str(), "r");
#endif
    if (!pipe) return 0.0;

    char buf[128];
    std::string result;
    while (fgets(buf, sizeof(buf), pipe))
        result += buf;

#if defined(_WIN32) || defined(_WIN64)
    _pclose(pipe);
#else
    pclose(pipe);
#endif

    try   { return std::stod(result); }
    catch (...) { return 0.0; }
}

// ── getProxyPath ─────────────────────────────────────────────────────────────

std::string ProxyTranscoder::getProxyPath(const std::string& sourcePath,
                                          const std::string& outputDir)
{
    fs::path src(sourcePath);
    fs::path out(outputDir);
    std::string stem = src.stem().string();
    return (out / (stem + ".dnxhr.mov")).string();
}

// ── proxyExists ──────────────────────────────────────────────────────────────

bool ProxyTranscoder::proxyExists(const std::string& sourcePath,
                                  const std::string& outputDir)
{
    std::string proxy = getProxyPath(sourcePath, outputDir);
    if (!fs::exists(proxy)) return false;

    // Proxy must be newer than source
    auto srcTime   = fs::last_write_time(sourcePath);
    auto proxyTime = fs::last_write_time(proxy);
    return proxyTime >= srcTime;
}

// ── buildCommand ─────────────────────────────────────────────────────────────

std::string ProxyTranscoder::buildCommand(const std::string& input,
                                          const std::string& output)
{
    // -y            overwrite without asking
    // -c:v dnxhd    DNxHR codec family
    // -profile:v    dnxhr_lb  Low Bandwidth (~22 Mbps @ 1080p)
    // -pix_fmt      yuv422p   required for DNxHR
    // -an           strip audio
    std::ostringstream ss;
    ss << "ffmpeg -y -i \"" << input << "\" "
       << "-c:v dnxhd -profile:v dnxhr_lb -pix_fmt yuv422p -an "
       << "\"" << output << "\"";
    return ss.str();
}

// ── buildRangeCommand ────────────────────────────────────────────────────────
// -ss before -i  : fast keyframe-level input-side seek (no full decode)
// -to after -i   : exclusive end cutoff (measured from source time 0)
// -vf scale=W:H  : downscale to target resolution
std::string ProxyTranscoder::buildRangeCommand(const std::string& input,
                                               const std::string& output,
                                               double startTimeSec,
                                               double endTimeSec,
                                               int targetWidth,
                                               int targetHeight)
{
    std::ostringstream ss;
    ss.setf(std::ios::fixed);
    ss.precision(3);
    ss << "ffmpeg -y "
       << "-ss " << startTimeSec << " "
       << "-to " << endTimeSec   << " "
       << "-i \"" << input << "\" "
       << "-vf scale=" << targetWidth << ":" << targetHeight << " "
       << "-c:v dnxhd -profile:v dnxhr_lb -pix_fmt yuv422p -an "
       << "\"" << output << "\"";
    return ss.str();
}

// ── runFFmpegAndWait ─────────────────────────────────────────────────────────
// Shared subprocess runner used by both transcode() and transcodeRange().
// Returns FFmpeg's exit code (0 = success). Streams stderr, parses the
// `time=HH:MM:SS.xx` tokens, and feeds progressCallback with the fraction of
// expectedDurationSec (>0 required for progress — 0 disables callback).
int ProxyTranscoder::runFFmpegAndWait(const std::string& cmd,
                                      double expectedDurationSec,
                                      std::function<void(float)> progressCallback)
{
#if defined(_WIN32) || defined(_WIN64)

    SECURITY_ATTRIBUTES sa{};
    sa.nLength              = sizeof(sa);
    sa.bInheritHandle       = TRUE;
    sa.lpSecurityDescriptor = nullptr;

    HANDLE hReadPipe  = nullptr;
    HANDLE hWritePipe = nullptr;
    if (!CreatePipe(&hReadPipe, &hWritePipe, &sa, 0))
    {
        std::cerr << "[ProxyTranscoder] CreatePipe failed\n";
        return -1;
    }
    SetHandleInformation(hReadPipe, HANDLE_FLAG_INHERIT, 0);

    STARTUPINFOA si{};
    si.cb          = sizeof(si);
    si.dwFlags     = STARTF_USESTDHANDLES;
    si.hStdInput   = GetStdHandle(STD_INPUT_HANDLE);
    si.hStdOutput  = GetStdHandle(STD_OUTPUT_HANDLE);
    si.hStdError   = hWritePipe;

    PROCESS_INFORMATION pi{};
    std::string mutableCmd = cmd;

    BOOL ok = CreateProcessA(
        nullptr,
        mutableCmd.data(),
        nullptr, nullptr,
        TRUE,
        CREATE_NO_WINDOW,
        nullptr, nullptr,
        &si, &pi);

    CloseHandle(hWritePipe);

    if (!ok)
    {
        std::cerr << "[ProxyTranscoder] CreateProcess failed (error "
                  << GetLastError() << ")\n";
        CloseHandle(hReadPipe);
        return -1;
    }

    std::regex timeRegex(R"(time=(\d+:\d+:\d+\.\d+))");
    char readBuf[4096];
    std::string residual;
    DWORD bytesRead = 0;
    constexpr size_t kStderrTailMax = 40;
    std::deque<std::string> stderrTail;

    while (ReadFile(hReadPipe, readBuf, sizeof(readBuf) - 1, &bytesRead, nullptr)
           && bytesRead > 0)
    {
        readBuf[bytesRead] = '\0';
        residual += readBuf;

        std::string::size_type pos;
        while ((pos = residual.find('\r')) != std::string::npos ||
               (pos = residual.find('\n')) != std::string::npos)
        {
            std::string line = residual.substr(0, pos);
            residual.erase(0, pos + 1);

            if (!line.empty()) {
                stderrTail.push_back(line);
                if (stderrTail.size() > kStderrTailMax)
                    stderrTail.pop_front();
            }

            std::smatch match;
            if (std::regex_search(line, match, timeRegex) && expectedDurationSec > 0.0)
            {
                double t = parseTimeString(match[1].str());
                float  p = static_cast<float>(std::clamp(t / expectedDurationSec, 0.0, 1.0));
                if (progressCallback) progressCallback(p);
            }
        }
    }

    WaitForSingleObject(pi.hProcess, INFINITE);

    DWORD exitCode = 1;
    GetExitCodeProcess(pi.hProcess, &exitCode);

    CloseHandle(pi.hProcess);
    CloseHandle(pi.hThread);
    CloseHandle(hReadPipe);

    if (exitCode != 0) {
        std::cerr << "[ProxyTranscoder] FFmpeg failed (exit=" << exitCode
                  << "). Last " << stderrTail.size() << " stderr lines:\n";
        for (const auto& line : stderrTail)
            std::cerr << "  | " << line << "\n";
    }

    return static_cast<int>(exitCode);

#else

    std::string pipeCmd = cmd + " 2>&1";
    FILE* pipe = popen(pipeCmd.c_str(), "r");
    if (!pipe)
    {
        std::cerr << "[ProxyTranscoder] popen failed\n";
        return -1;
    }

    std::regex timeRegex(R"(time=(\d+:\d+:\d+\.\d+))");
    char readBuf[4096];
    constexpr size_t kStderrTailMax = 40;
    std::deque<std::string> stderrTail;

    while (fgets(readBuf, sizeof(readBuf), pipe))
    {
        std::string line(readBuf);
        if (!line.empty() && line.back() == '\n') line.pop_back();
        if (!line.empty()) {
            stderrTail.push_back(line);
            if (stderrTail.size() > kStderrTailMax)
                stderrTail.pop_front();
        }
        std::smatch match;
        if (std::regex_search(line, match, timeRegex) && expectedDurationSec > 0.0)
        {
            double t = parseTimeString(match[1].str());
            float  p = static_cast<float>(std::clamp(t / expectedDurationSec, 0.0, 1.0));
            if (progressCallback) progressCallback(p);
        }
    }

    int exitCode = pclose(pipe);
    if (exitCode != 0) {
        std::cerr << "[ProxyTranscoder] FFmpeg failed (exit=" << exitCode
                  << "). Last " << stderrTail.size() << " stderr lines:\n";
        for (const auto& line : stderrTail)
            std::cerr << "  | " << line << "\n";
    }
    return exitCode;

#endif
}

// ── transcode ────────────────────────────────────────────────────────────────

std::string ProxyTranscoder::transcode(
    const std::string& inputPath,
    const std::string& outputDir,
    std::function<void(float progress)> progressCallback)
{
    if (!fs::exists(inputPath))
    {
        std::cerr << "[ProxyTranscoder] Source not found: " << inputPath << "\n";
        return {};
    }

    fs::create_directories(outputDir);

    std::string outputPath = getProxyPath(inputPath, outputDir);
    std::string cmd        = buildCommand(inputPath, outputPath);

    double srcDuration = probeDuration(inputPath);

    std::cout << "[ProxyTranscoder] Input : " << inputPath  << "\n"
              << "[ProxyTranscoder] Output: " << outputPath << "\n"
              << "[ProxyTranscoder] Duration: " << srcDuration << " s\n"
              << "[ProxyTranscoder] Command: " << cmd << "\n";

    auto t0 = std::chrono::high_resolution_clock::now();

    if (progressCallback) progressCallback(0.0f);

    int exitCode = runFFmpegAndWait(cmd, srcDuration, progressCallback);
    if (exitCode != 0)
    {
        std::cerr << "[ProxyTranscoder] FFmpeg exited with code " << exitCode << "\n";
        return {};
    }

    if (progressCallback) progressCallback(1.0f);

    auto t1 = std::chrono::high_resolution_clock::now();
    double elapsedSec = std::chrono::duration<double>(t1 - t0).count();

    // Log results
    auto srcSize   = static_cast<double>(fs::file_size(inputPath))  / (1024.0 * 1024.0);
    auto proxySize = static_cast<double>(fs::file_size(outputPath)) / (1024.0 * 1024.0);

    std::printf("[ProxyTranscoder] Done in %.1f s\n", elapsedSec);
    std::printf("[ProxyTranscoder] Source: %.1f MB  Proxy: %.1f MB  Ratio: %.2fx\n",
                srcSize, proxySize, proxySize / (srcSize > 0 ? srcSize : 1.0));

    return outputPath;
}

// ── transcodeRange ───────────────────────────────────────────────────────────

bool ProxyTranscoder::transcodeRange(
    const std::string& inputPath,
    const std::string& outputPath,
    double             startTimeSec,
    double             endTimeSec,
    int                targetWidth,
    int                targetHeight,
    std::function<void(float progress)> progressCallback)
{
    if (!fs::exists(inputPath))
    {
        std::cerr << "[ProxyTranscoder] Source not found: " << inputPath << "\n";
        return false;
    }
    if (endTimeSec <= startTimeSec)
    {
        std::cerr << "[ProxyTranscoder] Invalid range: start=" << startTimeSec
                  << " end=" << endTimeSec << "\n";
        return false;
    }
    if (targetWidth <= 0 || targetHeight <= 0)
    {
        std::cerr << "[ProxyTranscoder] Invalid target size: "
                  << targetWidth << "x" << targetHeight << "\n";
        return false;
    }

    // Create parent directory for outputPath
    try {
        fs::path out(outputPath);
        if (out.has_parent_path())
            fs::create_directories(out.parent_path());
    } catch (const std::exception& e) {
        std::cerr << "[ProxyTranscoder] create_directories failed: " << e.what() << "\n";
        return false;
    }

    std::string cmd = buildRangeCommand(inputPath, outputPath,
                                        startTimeSec, endTimeSec,
                                        targetWidth, targetHeight);

    double rangeDuration = endTimeSec - startTimeSec;

    std::cout << "[ProxyTranscoder] Range Input : " << inputPath  << "\n"
              << "[ProxyTranscoder] Range Output: " << outputPath << "\n"
              << "[ProxyTranscoder] Range: [" << startTimeSec << ", "
                                              << endTimeSec << ") ("
                                              << rangeDuration << " s)\n"
              << "[ProxyTranscoder] Target size: " << targetWidth << "x"
                                                  << targetHeight << "\n"
              << "[ProxyTranscoder] Command: " << cmd << "\n";

    auto t0 = std::chrono::high_resolution_clock::now();

    if (progressCallback) progressCallback(0.0f);

    int exitCode = runFFmpegAndWait(cmd, rangeDuration, progressCallback);
    if (exitCode != 0)
    {
        std::cerr << "[ProxyTranscoder] Range FFmpeg exited with code "
                  << exitCode << "\n";
        // Clean up any partial output so isFilePresent checks stay correct
        std::error_code ec;
        fs::remove(outputPath, ec);
        return false;
    }

    if (progressCallback) progressCallback(1.0f);

    auto t1 = std::chrono::high_resolution_clock::now();
    double elapsedSec = std::chrono::duration<double>(t1 - t0).count();

    // Log results (guard in case file didn't actually get written)
    double proxySizeMB = 0.0;
    std::error_code ec;
    auto sz = fs::file_size(outputPath, ec);
    if (!ec) proxySizeMB = static_cast<double>(sz) / (1024.0 * 1024.0);

    std::printf("[ProxyTranscoder] Range done in %.1f s — %.1f MB\n",
                elapsedSec, proxySizeMB);

    return true;
}
