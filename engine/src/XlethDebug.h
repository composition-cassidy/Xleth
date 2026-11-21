#pragma once

// ─── XlethDebug.h ─────────────────────────────────────────────────────────────
// Shared debug utilities gated by XLETH_DEBUG.
// Include this in any engine .cpp that needs structured debug logging.
//
// ThrottledLog: message/worker thread only — uses a mutex, NEVER call from
// the audio thread (processBlock).  For audio-thread logs use the lock-free
// atomic-counter pattern shown in MixEngine.cpp.

#include <cstdlib>

// A single runtime switch (the XLETH_RENDER_LOG env var) for stderr/stdout
// writes that sit next to — but are not currently inside — a per-frame or
// per-block hot path (e.g. RTPool pair creation, export progress lines, a
// per-clip Timeline mutation log). Unconditional, like the per-file
// `kRenderLog` statics in FrameCollector.cpp/GridCompositor.cpp that this
// shares its env var with: XLETH_DEBUG is defined unconditionally in this
// build, so gating on it alone would never compile anything away here.
// Centralizing the switch means a log call that later moves INTO an actual
// hot path inherits the gate automatically, rather than depending on
// whoever does the moving to remember to add one. See RENDER_PERF_AUDIT.txt
// Finding 12.
inline bool xlethRenderLogEnabled() {
    static const bool enabled = std::getenv("XLETH_RENDER_LOG") != nullptr;
    return enabled;
}

#define XLETH_RENDER_LOG(stmt) \
    do { if (xlethRenderLogEnabled()) { stmt; } } while (0)

// XLETH_RT_TRACE — opt-in compile flag for stderr traces INSIDE the audio
// callback (per-note trigger traces, per-block effect metering). Never defined
// by the build. XLETH_DEBUG is on in every build, Release included, so gating
// an audio-thread fprintf on it leaves the CRT stream lock and a blocking pipe
// write on the real-time path. Define XLETH_RT_TRACE only for a local
// diagnostic build, and expect xruns while it is on.

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
