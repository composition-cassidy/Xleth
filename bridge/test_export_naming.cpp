// Standalone unit test for ExportNaming.h — no JUCE, NAPI, or FFmpeg required.
// Build: cmake --build bridge/build --target test_export_naming
// Run:   bridge\build\Release\test_export_naming.exe
#include "src/ExportNaming.h"
#include <cstdio>
#include <cstdlib>
#include <string>

static int passed = 0, failed = 0;

static void check(const std::string& actual, const std::string& expected, const char* label)
{
    if (actual == expected) {
        std::printf("  PASS  %s\n", label);
        ++passed;
    } else {
        std::printf("  FAIL  %s\n        expected: %s\n        actual:   %s\n",
                    label, expected.c_str(), actual.c_str());
        ++failed;
    }
}

int main()
{
    std::puts("[ buildExportFilename ]");

    // 1. Sample name only
    check(buildExportFilename("SML_Movie", "Quote", "NO_MAIL_AWH", "sampleNameOnly"),
          "NO_MAIL_AWH.wav",
          "sampleNameOnly → NAME.wav");

    // 2. Category + sample name
    check(buildExportFilename("SML_Movie", "Quote", "NO_MAIL_AWH", "categoryAndName"),
          "Quote_NO_MAIL_AWH.wav",
          "categoryAndName → LABEL_NAME.wav");

    // 3. Source + sample name
    check(buildExportFilename("SML_Movie", "Quote", "NO_MAIL_AWH", "sourceAndName"),
          "SML_Movie_NO_MAIL_AWH.wav",
          "sourceAndName → SRC_NAME.wav");

    // 4. Full legacy
    check(buildExportFilename("SML_Movie", "Quote", "NO_MAIL_AWH", "fullLegacy"),
          "SML_Movie_Quote_NO_MAIL_AWH.wav",
          "fullLegacy → SRC_LABEL_NAME.wav");

    // 5. Missing category does not produce double underscore
    check(buildExportFilename("SML_Movie", "", "NO_MAIL_AWH", "categoryAndName"),
          "NO_MAIL_AWH.wav",
          "categoryAndName + empty label → no leading underscore");

    // 6. Missing source does not produce double underscore
    check(buildExportFilename("", "Quote", "NO_MAIL_AWH", "sourceAndName"),
          "NO_MAIL_AWH.wav",
          "sourceAndName + empty src → no leading underscore");

    // 7. Missing name falls back to export.wav
    check(buildExportFilename("SML_Movie", "Quote", "", "sampleNameOnly"),
          "export.wav",
          "missing name → export.wav fallback");

    // 8. Unsafe characters are sanitized
    check(buildExportFilename("Src/File!", "Cat:ory", "Na!me", "fullLegacy"),
          "SrcFile_Catory_Name.wav",
          "unsafe chars stripped");

    // 9. Extension appears exactly once
    {
        const std::string result = buildExportFilename("Src", "Cat", "Name", "fullLegacy");
        const bool one_wav = result.rfind(".wav") == result.size() - 4 &&
                             result.find(".wav") == result.size() - 4;
        if (one_wav) {
            std::printf("  PASS  extension appears exactly once\n");
            ++passed;
        } else {
            std::printf("  FAIL  extension appears exactly once — got: %s\n", result.c_str());
            ++failed;
        }
    }

    std::printf("\n%s: %d/%d tests\n",
                failed == 0 ? "PASSED" : "FAILED",
                passed, passed + failed);
    return failed == 0 ? 0 : 1;
}
