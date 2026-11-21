#pragma once

// PluginBinaryInspector — preflight a plugin binary WITHOUT loading it.
//
// Parses the PE file by reading bytes (no LoadLibrary, no
// LoadLibraryEx(DONT_RESOLVE_DLL_REFERENCES)): machine type and the export
// name table. Every offset is bounds-checked against the file size, so a
// malformed, truncated or hostile file yields a status, never a crash.
//
// Pure C++17 + <filesystem>; no JUCE, no engine dependencies. Built as the
// XlethPluginInspect static lib (engine/CMakeLists.txt) so any target can use
// it without linking XlethEngineCore.
//
// Thread-safe (no shared state). Never call it on the audio thread (file I/O).

#include <string>
#include <vector>

struct PluginBinaryInfo
{
    enum class Status { Ok, NotPE, WrongArch32, WrongArchArm64, NoEntryPoint, Unreadable };

    Status                   status = Status::Unreadable;
    std::string              machine;     // "AMD64" | "I386" | "ARM64" | "0x....", empty if unknown
    std::vector<std::string> exports;     // export NAMES (ordinal-only exports are not listed)
    std::string              binaryPath;  // the file actually parsed (bundle → inner binary)
};

namespace PluginBinaryInspector
{
    // Inspects `path` for plugin format `formatName` ("VST3", "VST", "CLAP";
    // empty = skip the entry-point check). A VST3 bundle directory is resolved
    // to Contents\x86_64-win\<name>.vst3; a bundle that only has
    // Contents\x86-win\ is WrongArch32 (Contents\arm64*-win\ only: WrongArchArm64).
    PluginBinaryInfo inspect(const std::string& path, const std::string& formatName);

    // Same, with the path given as UTF-16 (Windows paths outside the ANSI code page).
    PluginBinaryInfo inspect(const std::wstring& path, const std::string& formatName);

    // The export names that satisfy a format (any one of them is enough).
    // Unknown format → empty (no requirement).
    const std::vector<std::string>& requiredExports(const std::string& formatName);

    // Persisted failure reason for a non-Ok status:
    //   WrongArch32 → "not-64bit", WrongArchArm64 → "arm64",
    //   NoEntryPoint → "no-entry-point", NotPE → "not-a-binary",
    //   Unreadable → "unreadable", Ok → "".
    const char* failureReason(PluginBinaryInfo::Status status);

    // "Ok", "NotPE", ... (logging).
    const char* statusName(PluginBinaryInfo::Status status);
}
