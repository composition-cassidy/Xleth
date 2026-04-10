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

    // Check if a valid proxy already exists (and is newer than source)
    static bool proxyExists(const std::string& sourcePath, const std::string& outputDir);

    // Get the expected proxy path for a source file
    static std::string getProxyPath(const std::string& sourcePath, const std::string& outputDir);

private:
    static std::string buildCommand(const std::string& input, const std::string& output);
};
