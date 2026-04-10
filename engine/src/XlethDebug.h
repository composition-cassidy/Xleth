#pragma once

// ─── XlethDebug.h ─────────────────────────────────────────────────────────────
// Shared debug utilities gated by XLETH_DEBUG.
// Include this in any engine .cpp that needs structured debug logging.
//
// ThrottledLog: message/worker thread only — uses a mutex, NEVER call from
// the audio thread (processBlock).  For audio-thread logs use the lock-free
// atomic-counter pattern shown in MixEngine.cpp.

#ifdef XLETH_DEBUG

#include <chrono>
#include <cstdio>
#include <mutex>
#include <unordered_map>

struct ThrottledLog {
    std::unordered_map<int, std::chrono::steady_clock::time_point> lastLog_;
    std::mutex mutex_;

    // Returns true at most once every intervalSeconds for the given integer key.
    bool shouldLog(int key, int intervalSeconds = 5) {
        auto now = std::chrono::steady_clock::now();
        std::lock_guard<std::mutex> lock(mutex_);
        auto it = lastLog_.find(key);
        if (it == lastLog_.end() ||
            std::chrono::duration_cast<std::chrono::seconds>(
                now - it->second).count() >= intervalSeconds) {
            lastLog_[key] = now;
            return true;
        }
        return false;
    }
};

#endif // XLETH_DEBUG
