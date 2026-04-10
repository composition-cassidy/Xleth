#ifdef _MSC_VER
  #define _CRT_SECURE_NO_WARNINGS
#endif

#include "ProxyTranscoder.h"

#include <algorithm>
#include <chrono>
#include <cstdio>
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

    // ── Windows: CreateProcess with stderr pipe ──────────────────────────────
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
        return {};
    }
    // Don't let the read end be inherited
    SetHandleInformation(hReadPipe, HANDLE_FLAG_INHERIT, 0);

    STARTUPINFOA si{};
    si.cb          = sizeof(si);
    si.dwFlags     = STARTF_USESTDHANDLES;
    si.hStdInput   = GetStdHandle(STD_INPUT_HANDLE);
    si.hStdOutput  = GetStdHandle(STD_OUTPUT_HANDLE);
    si.hStdError   = hWritePipe;  // FFmpeg writes progress to stderr

    PROCESS_INFORMATION pi{};

    // CreateProcessA needs a mutable command buffer
    std::string mutableCmd = cmd;

    BOOL ok = CreateProcessA(
        nullptr,
        mutableCmd.data(),
        nullptr, nullptr,
        TRUE,                       // inherit handles
        CREATE_NO_WINDOW,           // no console window
        nullptr, nullptr,
        &si, &pi);

    // Close write end in parent so ReadFile will eventually return 0
    CloseHandle(hWritePipe);

    if (!ok)
    {
        std::cerr << "[ProxyTranscoder] CreateProcess failed (error "
                  << GetLastError() << ")\n";
        CloseHandle(hReadPipe);
        return {};
    }

    // Read stderr for progress
    std::regex timeRegex(R"(time=(\d+:\d+:\d+\.\d+))");
    char readBuf[4096];
    std::string residual;
    DWORD bytesRead = 0;

    while (ReadFile(hReadPipe, readBuf, sizeof(readBuf) - 1, &bytesRead, nullptr)
           && bytesRead > 0)
    {
        readBuf[bytesRead] = '\0';
        residual += readBuf;

        // Process complete lines
        std::string::size_type pos;
        while ((pos = residual.find('\r')) != std::string::npos ||
               (pos = residual.find('\n')) != std::string::npos)
        {
            std::string line = residual.substr(0, pos);
            residual.erase(0, pos + 1);

            std::smatch match;
            if (std::regex_search(line, match, timeRegex) && srcDuration > 0.0)
            {
                double t = parseTimeString(match[1].str());
                float  p = static_cast<float>(std::clamp(t / srcDuration, 0.0, 1.0));
                if (progressCallback) progressCallback(p);
            }
        }
    }

    // Wait for FFmpeg to exit
    WaitForSingleObject(pi.hProcess, INFINITE);

    DWORD exitCode = 1;
    GetExitCodeProcess(pi.hProcess, &exitCode);

    CloseHandle(pi.hProcess);
    CloseHandle(pi.hThread);
    CloseHandle(hReadPipe);

    if (exitCode != 0)
    {
        std::cerr << "[ProxyTranscoder] FFmpeg exited with code " << exitCode << "\n";
        return {};
    }

    // ── Non-Windows: popen fallback ──────────────────────────────────────────
#else

    std::string pipeCmd = cmd + " 2>&1";
    FILE* pipe = popen(pipeCmd.c_str(), "r");
    if (!pipe)
    {
        std::cerr << "[ProxyTranscoder] popen failed\n";
        return {};
    }

    std::regex timeRegex(R"(time=(\d+:\d+:\d+\.\d+))");
    char readBuf[4096];

    while (fgets(readBuf, sizeof(readBuf), pipe))
    {
        std::string line(readBuf);
        std::smatch match;
        if (std::regex_search(line, match, timeRegex) && srcDuration > 0.0)
        {
            double t = parseTimeString(match[1].str());
            float  p = static_cast<float>(std::clamp(t / srcDuration, 0.0, 1.0));
            if (progressCallback) progressCallback(p);
        }
    }

    int ret = pclose(pipe);
    if (ret != 0)
    {
        std::cerr << "[ProxyTranscoder] FFmpeg exited with code " << ret << "\n";
        return {};
    }

#endif

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
