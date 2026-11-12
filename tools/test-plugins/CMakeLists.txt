# ── Scanner failure-path fixtures (TEST ONLY — never shipped) ─────────────────
# Two minimal VST3-shaped bundles for smoke-testing xleth-plugin-scanner's
# failure handling (docs/PLUGIN_HOSTING_LOG.md, P1):
#
#   XlethTestCrash.vst3   GetPluginFactory dereferences null → scanner dies → `crash`
#   XlethTestHang.vst3    GetPluginFactory sleeps forever    → 10 s wait   → `timeout`
#
# Neither has Contents\Resources\moduleinfo.json, so JUCE takes the slow path
# and actually loads the DLL. No JUCE / VST3 SDK dependency.
#
# Enabled from the root CMakeLists.txt with -DXLETH_BUILD_TEST_PLUGINS=ON (default
# OFF, not part of build.bat), or built standalone:
#   cmake -S tools/test-plugins -B build-test-plugins
#   cmake --build build-test-plugins --config Release
# Bundles land in <build dir>/test-plugins/ (override XLETH_TEST_PLUGINS_OUT).
# Later phases add VST2 / CLAP variants here.

cmake_minimum_required(VERSION 3.20)

if(CMAKE_SOURCE_DIR STREQUAL CMAKE_CURRENT_SOURCE_DIR)
    project(XlethTestPlugins LANGUAGES CXX)
endif()

if(NOT WIN32)
    message(STATUS "XlethTestPlugins: Windows-only fixtures, skipped")
    return()
endif()

set(XLETH_TEST_PLUGINS_OUT "${CMAKE_BINARY_DIR}/test-plugins"
    CACHE PATH "Where the fixture .vst3 bundles are written")

function(xleth_add_test_vst3 name source)
    add_library(${name} MODULE ${source})
    # Bundle layout: <name>.vst3/Contents/x86_64-win/<name>.vst3
    # `$<0:>` stops multi-config generators appending /Release.
    set(binDir "${XLETH_TEST_PLUGINS_OUT}/${name}.vst3/Contents/x86_64-win$<0:>")
    set_target_properties(${name} PROPERTIES
        PREFIX ""
        SUFFIX ".vst3"
        LIBRARY_OUTPUT_DIRECTORY "${binDir}"
        RUNTIME_OUTPUT_DIRECTORY "${binDir}"
        MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>"
    )
endfunction()

xleth_add_test_vst3(XlethTestCrash src/XlethTestCrash.cpp)
xleth_add_test_vst3(XlethTestHang  src/XlethTestHang.cpp)
