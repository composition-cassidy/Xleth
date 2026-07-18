// XlethSvcShared.h — cross-cutting declarations shared across the engine-service
// translation units (S2 Stage 1).
//
// INTERNAL header (engine/src/service/, NOT engine/include/). Holds the small
// pieces that nearly every handler needs but that are not global *state*:
//   • the IPC slow-call diagnostic macros,
//   • isInitialised(),
//   • the BridgeCallLog timing wrapper,
//   • the syncTransportLoopFromTimeline forward declaration.
//
// These moved out of XlethEngineService.cpp verbatim; no behavior changed.

#pragma once

#include <chrono>
#include <cstdio>
#include <iostream>
#include <string>

#include "service/XlethSvcGlobals.h"  // for xleth::svc::audioEngine (isInitialised)

// ─────────────────────────────────────────────────────────────────────────────
// IPC slow-call diagnostic
// ─────────────────────────────────────────────────────────────────────────────
// The host bridge main thread is also the JUCE message thread.  Any host bridge call that
// blocks this thread for >5ms delays JUCE timer/paint dispatch for VST editors.
// At 30+ IPC calls/second (peak meter loop) even 5ms stalls add up and can cause
// Win32 to mark the Electron main window as "Not Responding".
//
// IPC_TIME_START / IPC_TIME_END bracket a function's body.  If the call exceeds
// IPC_SLOW_THRESHOLD_US microseconds, a [IPC-SLOW] line is printed to stderr so
// you can identify which function is the bottleneck in production.
#ifdef XLETH_DEBUG
  #define IPC_SLOW_THRESHOLD_US  10000   // 10 ms
  #define IPC_TIME_START \
    const auto _ipc_t0 = std::chrono::steady_clock::now()
  #define IPC_TIME_END(name) \
    do { \
        const auto _ipc_dt = std::chrono::duration_cast<std::chrono::microseconds>( \
            std::chrono::steady_clock::now() - _ipc_t0).count(); \
        if (_ipc_dt > IPC_SLOW_THRESHOLD_US) \
            std::fprintf(stderr, "[IPC-SLOW] %s took %lld us\n", \
                         (name), static_cast<long long>(_ipc_dt)); \
    } while(0)
  // IPC_GAP_CHECK(fname) — tracks wall-clock gaps between successive calls to
  // the same host bridge function.  A gap > 1 s means the host bridge thread (= JUCE
  // message thread) was blocked for that interval between polls.
  #define IPC_GAP_CHECK(fname) \
    do { \
        static auto _gap_last = std::chrono::steady_clock::now(); \
        auto _gap_now = std::chrono::steady_clock::now(); \
        auto _gap_ms  = std::chrono::duration_cast<std::chrono::milliseconds>( \
                          _gap_now - _gap_last).count(); \
        _gap_last = _gap_now; \
        if (_gap_ms > 1000) \
            std::fprintf(stderr, \
                "[MsgThread] Gap of %lldms between calls to %s — host bridge thread was blocked\n", \
                (long long)_gap_ms, (fname)); \
    } while(0)
#else
  #define IPC_TIME_START      do {} while(0)
  #define IPC_TIME_END(name)  do {} while(0)
  #define IPC_GAP_CHECK(fname) do {} while(0)
#endif

// Push the committed LoopRegion (ticks) into the live transport (samples). Must
// run after every loop mutation, undo/redo, project load, and BPM change so the
// audio-thread playback trap always matches the model. Message-thread only.
// Defined below near the loop-region handlers; forward-declared here so the
// earlier project-load path can call it.
static void syncTransportLoopFromTimeline();

inline bool isInitialised() { return xleth::svc::audioEngine != nullptr; }

// Simple timing wrapper for debug logging
struct BridgeCallLog {
    const char* name;
    std::chrono::high_resolution_clock::time_point t0;
    explicit BridgeCallLog(const char* n) : name(n) {
        t0 = std::chrono::high_resolution_clock::now();
        std::cout << "[Bridge] → " << name << "\n" << std::flush;
    }
    void done(const std::string& summary = "") {
        auto us = std::chrono::duration_cast<std::chrono::microseconds>(
            std::chrono::high_resolution_clock::now() - t0).count();
        std::cout << "[Bridge] ← " << name
                  << (summary.empty() ? "" : " = " + summary)
                  << " (" << us << "µs)\n" << std::flush;
    }
};
