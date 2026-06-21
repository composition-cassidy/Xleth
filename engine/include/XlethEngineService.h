#pragma once

#include <nlohmann/json_fwd.hpp>

#include <string>

// Process-wide orchestration facade shared by native hosts. The implementation
// deliberately keeps command handlers translation-unit local: they own several
// long-lived worker threads and pointer graphs whose addresses must remain stable.
// Public callers see one structured dispatch boundary and no host-runtime types.
class XlethEngineService
{
public:
    static XlethEngineService& getInstance();

    nlohmann::json dispatch(const std::string& method,
                            const nlohmann::json& args);

    // ── Audio-health diagnostic trace sink (read-only instrumentation) ────────
    // Thread-safe. Writes the bracket-tagged line to stderr (so it lands in the
    // host's engine log) and, when the XLETH_AUDIO_TRACE env var is set, also
    // appends it to a trace file. If XLETH_AUDIO_TRACE=="1" the file defaults to
    // <temp>/xleth-audio-trace.log; otherwise its value is used as the path.
    // Used by the engine's 1s health sampler so the whole per-second trace
    // lands in one file.
    static void audioTrace(const std::string& line);
    static bool audioTraceEnabled();

private:
    XlethEngineService() = default;
    ~XlethEngineService() = default;

    XlethEngineService(const XlethEngineService&) = delete;
    XlethEngineService& operator=(const XlethEngineService&) = delete;
};
