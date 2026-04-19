#pragma once

#include <functional>
#include <string>

class ProxyTranscoder {
public:
    // Transcode source video to DNxHR LB proxy.
    // BLOCKING call — runs FFmpeg as a subprocess.
    // Returns path to proxy file on success, empty string on failure.
    static std::string transcode(
        const std::string& inputPath,
        const std::string& outputDir,
        std::function<void(float progress)> progressCallback = nullptr
    );

    // Transcode a time range [startTimeSec, endTimeSec) of inputPath to
    // outputPath as DNxHR LB at (targetWidth × targetHeight). BLOCKING.
    // Returns true on success. Creates parent dirs. Uses -ss before -i
    // (fast keyframe seek) + -to after -i + -vf scale=w:h.
    static bool transcodeRange(
        const std::string& inputPath,
        const std::string& outputPath,
        double             startTimeSec,
        double             endTimeSec,
        int                targetWidth,
        int                targetHeight,
        std::function<void(float progress)> progressCallback = nullptr
    );

    // Check if a valid proxy already exists (and is newer than source)
    static bool proxyExists(const std::string& sourcePath, const std::string& outputDir);

    // Get the expected proxy path for a source file
    static std::string getProxyPath(const std::string& sourcePath, const std::string& outputDir);

private:
    static std::string buildCommand(const std::string& input, const std::string& output);
    static std::string buildRangeCommand(const std::string& input,
                                         const std::string& output,
                                         double startTimeSec,
                                         double endTimeSec,
                                         int targetWidth,
                                         int targetHeight);
    // Shared subprocess runner — launches cmd, tees stderr, calls progressCallback
    // with fraction of expectedDurationSec. Returns exit code (0 = success).
    static int runFFmpegAndWait(const std::string& cmd,
                                double expectedDurationSec,
                                std::function<void(float)> progressCallback);
};
