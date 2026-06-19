#pragma once

#include <cctype>
#include <string>
#include <vector>

inline std::string sanitizeFilename(const std::string& value)
{
    std::string out;
    out.reserve(value.size());
    for (unsigned char character : value) {
        if (std::isalnum(character) || character == '-' || character == '_')
            out += static_cast<char>(character);
        else if (character == ' ')
            out += '_';
    }
    return out;
}

inline std::string buildExportFilename(const std::string& sourceStem,
                                       const std::string& label,
                                       const std::string& regionName,
                                       const std::string& format)
{
    const std::string source = sanitizeFilename(sourceStem);
    const std::string category = sanitizeFilename(label);
    const std::string name = sanitizeFilename(regionName);

    std::vector<std::string> parts;
    if (format == "categoryAndName") {
        if (!category.empty()) parts.push_back(category);
        if (!name.empty()) parts.push_back(name);
    } else if (format == "sourceAndName") {
        if (!source.empty()) parts.push_back(source);
        if (!name.empty()) parts.push_back(name);
    } else if (format == "fullLegacy") {
        if (!source.empty()) parts.push_back(source);
        if (!category.empty()) parts.push_back(category);
        if (!name.empty()) parts.push_back(name);
    } else if (!name.empty()) {
        parts.push_back(name);
    }

    if (parts.empty()) return "export.wav";

    std::string stem;
    for (std::size_t i = 0; i < parts.size(); ++i) {
        if (i > 0) stem += '_';
        stem += parts[i];
    }
    return stem + ".wav";
}
