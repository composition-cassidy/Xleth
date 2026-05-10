#pragma once
#include <cctype>
#include <string>
#include <vector>

// Keep [a-zA-Z0-9\-_]; convert spaces to '_'; strip everything else.
// Mirrors the sanitisation that was previously inlined inside Audio_ExportRegion.
inline std::string sanitizeFilename(const std::string& s)
{
    std::string out;
    out.reserve(s.size());
    for (unsigned char c : s) {
        if (std::isalnum(c) || c == '-' || c == '_')
            out += static_cast<char>(c);
        else if (c == ' ')
            out += '_';
    }
    return out;
}

// Build an export filename (with ".wav" extension) from the three naming
// components and a format key.
//
// format values:
//   "sampleNameOnly"  (default) → NAME.wav
//   "categoryAndName"           → LABEL_NAME.wav
//   "sourceAndName"             → SRC_NAME.wav
//   "fullLegacy"                → SRC_LABEL_NAME.wav
//
// Empty components are omitted; underscore separators are never doubled.
// Returns "export.wav" when all components reduce to empty strings.
inline std::string buildExportFilename(
    const std::string& srcStem,
    const std::string& labelStr,
    const std::string& regionName,
    const std::string& format)
{
    const std::string s = sanitizeFilename(srcStem);
    const std::string c = sanitizeFilename(labelStr);
    const std::string n = sanitizeFilename(regionName);

    std::vector<std::string> parts;
    if (format == "categoryAndName") {
        if (!c.empty()) parts.push_back(c);
        if (!n.empty()) parts.push_back(n);
    } else if (format == "sourceAndName") {
        if (!s.empty()) parts.push_back(s);
        if (!n.empty()) parts.push_back(n);
    } else if (format == "fullLegacy") {
        if (!s.empty()) parts.push_back(s);
        if (!c.empty()) parts.push_back(c);
        if (!n.empty()) parts.push_back(n);
    } else {
        // sampleNameOnly (default — handles unknown format strings gracefully)
        if (!n.empty()) parts.push_back(n);
    }

    if (parts.empty()) return "export.wav";

    std::string stem;
    for (std::size_t i = 0; i < parts.size(); ++i) {
        if (i > 0) stem += '_';
        stem += parts[i];
    }
    return stem + ".wav";
}
