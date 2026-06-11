#pragma once

#include <atomic>
#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdarg>
#include <cstdio>
#include <cstdlib>
#include <ctime>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <mutex>
#include <sstream>
#include <string>

namespace xleth::sidechain_diag {

inline std::mutex& logMutex()
{
    static std::mutex m;
    return m;
}

inline std::atomic<int>& audioBlockBudget()
{
    static std::atomic<int> budget {0};
    return budget;
}

inline std::string logPath()
{
#if defined(_WIN32)
    char* env = nullptr;
    size_t len = 0;
    if (_dupenv_s(&env, &len, "XLETH_SIDECHAIN_DIAG_PATH") == 0 && env != nullptr)
    {
        std::string value(env);
        std::free(env);
        if (!value.empty())
            return value;
    }
#else
    if (const char* env = std::getenv("XLETH_SIDECHAIN_DIAG_PATH"))
        if (*env != '\0')
            return std::string(env);
#endif
    return (std::filesystem::current_path() / "sidechain-diagnostic-log.txt").string();
}

inline std::string timestampUtc()
{
    using clock = std::chrono::system_clock;
    const auto now = clock::now();
    const auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(
        now.time_since_epoch()) % 1000;
    const std::time_t tt = clock::to_time_t(now);
    std::tm tm {};
#if defined(_WIN32)
    gmtime_s(&tm, &tt);
#else
    gmtime_r(&tt, &tm);
#endif
    std::ostringstream os;
    os << std::put_time(&tm, "%Y-%m-%dT%H:%M:%S")
       << '.' << std::setfill('0') << std::setw(3) << ms.count() << 'Z';
    return os.str();
}

inline void append(const char* subsystem, const char* eventName, const std::string& fields)
{
    std::lock_guard<std::mutex> lock(logMutex());
    try {
        std::ofstream out(logPath(), std::ios::out | std::ios::app);
        if (!out) return;
        out << timestampUtc()
            << " [SidechainDiag][" << (subsystem ? subsystem : "Native") << "] "
            << (eventName ? eventName : "event");
        if (!fields.empty())
            out << ' ' << fields;
        out << '\n';
    } catch (...) {
    }
}

inline void appendf(const char* subsystem, const char* eventName, const char* fmt, ...)
{
    char buf[1024];
    va_list args;
    va_start(args, fmt);
    std::vsnprintf(buf, sizeof(buf), fmt, args);
    va_end(args);
    append(subsystem, eventName, buf);
}

inline void activateAudioBlocks(int blocks, const char* reason)
{
    if (blocks <= 0) return;
    auto& budget = audioBlockBudget();
    int cur = budget.load(std::memory_order_relaxed);
    while (cur < blocks &&
           !budget.compare_exchange_weak(cur, blocks,
                                         std::memory_order_relaxed,
                                         std::memory_order_relaxed))
    {
    }
    appendf("Audio", "activateAudioBlockDiagnostics",
            "blocks=%d reason=%s", blocks, reason ? reason : "unknown");
}

inline bool audioBlockActive()
{
    return audioBlockBudget().load(std::memory_order_relaxed) > 0;
}

inline bool consumeAudioBlock()
{
    auto& budget = audioBlockBudget();
    int cur = budget.load(std::memory_order_relaxed);
    while (cur > 0)
    {
        if (budget.compare_exchange_weak(cur, cur - 1,
                                         std::memory_order_relaxed,
                                         std::memory_order_relaxed))
            return true;
    }
    return false;
}

inline float peak(const float* data, int n) noexcept
{
    float p = 0.0f;
    if (data == nullptr || n <= 0) return p;
    for (int i = 0; i < n; ++i)
        p = std::max(p, std::abs(data[i]));
    return p;
}

inline float rms(const float* data, int n) noexcept
{
    if (data == nullptr || n <= 0) return 0.0f;
    double sum = 0.0;
    for (int i = 0; i < n; ++i)
        sum += static_cast<double>(data[i]) * static_cast<double>(data[i]);
    return static_cast<float>(std::sqrt(sum / static_cast<double>(n)));
}

} // namespace xleth::sidechain_diag
