cmake_minimum_required(VERSION 3.28)

# ── Vcpkg packages ────────────────────────────────────────────────────────────
# The engine's main build (in ../build) has already installed vcpkg packages
# (FFmpeg, GLEW, GLFW). Rather than re-running vcpkg manifest install (which
# requires a builtin-baseline in vcpkg.json), we reuse the pre-installed
# packages by adding them to CMAKE_PREFIX_PATH and disabling manifest mode.
set(_VCPKG_INSTALLED "${CMAKE_CURRENT_SOURCE_DIR}/../build/vcpkg_installed/x64-windows"
    CACHE PATH "Pre-installed vcpkg packages from the main build")

if(EXISTS "${_VCPKG_INSTALLED}")
    list(APPEND CMAKE_PREFIX_PATH "${_VCPKG_INSTALLED}")
    list(APPEND CMAKE_PREFIX_PATH "${_VCPKG_INSTALLED}/debug")
    # vcpkg Find-modules (like FindFFMPEG.cmake) live under share/
    list(APPEND CMAKE_MODULE_PATH "${_VCPKG_INSTALLED}/share/ffmpeg")
    set(VCPKG_MANIFEST_MODE OFF CACHE BOOL "" FORCE)
    message(STATUS "Using pre-installed vcpkg packages at ${_VCPKG_INSTALLED}")
else()
    # Fall back to vcpkg toolchain if packages aren't pre-built
    if(NOT DEFINED CMAKE_TOOLCHAIN_FILE)
        if(DEFINED ENV{VCPKG_ROOT})
            set(CMAKE_TOOLCHAIN_FILE
                "$ENV{VCPKG_ROOT}/scripts/buildsystems/vcpkg.cmake"
                CACHE STRING "vcpkg toolchain file")
        elseif(EXISTS "C:/Program Files/Microsoft Visual Studio/2022/Community/VC/vcpkg/scripts/buildsystems/vcpkg.cmake")
            set(CMAKE_TOOLCHAIN_FILE
                "C:/Program Files/Microsoft Visual Studio/2022/Community/VC/vcpkg/scripts/buildsystems/vcpkg.cmake"
                CACHE STRING "vcpkg toolchain file (VS2022 bundled)")
        endif()
    endif()
    if(NOT DEFINED VCPKG_MANIFEST_DIR)
        set(VCPKG_MANIFEST_DIR "${CMAKE_CURRENT_SOURCE_DIR}/.."
            CACHE PATH "Directory containing vcpkg.json")
    endif()
endif()

project(XlethBridge CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# ── CRT linkage ──────────────────────────────────────────────────────────────
# cmake-js v7 hardcodes -DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded (/MT).
# Electron uses /MD (dynamic CRT). Mixing /MT and /MD in the same process
# causes heap corruption on first napi call. FORCE overrides cmake-js's -D.
if(MSVC)
    set(CMAKE_MSVC_RUNTIME_LIBRARY
        "MultiThreaded$<$<CONFIG:Debug>:Debug>DLL"
        CACHE STRING "Use /MD to match Electron dynamic CRT" FORCE)
endif()

# ── Engine (XlethEngineCore + XlethEngineHeaders) ────────────────────────────
# This also sets up JUCE, finds FFmpeg/OpenGL/GLEW/GLFW, and builds XlethEngine.
# We only link against XlethEngineCore and XlethEngineHeaders from here.
# XlethEngineCore has no VideoCompositor/GLFW/GLEW/OpenGL — safe for Electron.
add_subdirectory(
    ${CMAKE_CURRENT_SOURCE_DIR}/../engine
    ${CMAKE_CURRENT_BINARY_DIR}/engine
)

# ── Plugin scanner executable ─────────────────────────────────────────────────
# Built here so xleth-plugin-scanner.exe lands in bridge/build/Release/
# alongside xleth_native.node, where PluginRegistry locates it at runtime.
add_subdirectory(
    ${CMAKE_CURRENT_SOURCE_DIR}/../scanner
    ${CMAKE_CURRENT_BINARY_DIR}/scanner
)

# ── Editor host executable ────────────────────────────────────────────────────
# Out-of-process VST3 editor host. Each plugin editor opens in its own process
# so its Win32 message pump is fully isolated from the worker's N-API traffic.
# Built here so xleth-editor-host.exe lands next to xleth_native.node.
add_subdirectory(
    ${CMAKE_CURRENT_SOURCE_DIR}/../editor-host
    ${CMAKE_CURRENT_BINARY_DIR}/editor-host
)

# ── node-addon-api include path ───────────────────────────────────────────────
# node-addon-api is a peer dep installed via npm install in bridge/.
# Its CMake-friendly include path is exposed via require('node-addon-api').include.
execute_process(
    COMMAND node -p "require('node-addon-api').include"
    WORKING_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR}
    OUTPUT_VARIABLE NODE_ADDON_API_DIR
    OUTPUT_STRIP_TRAILING_WHITESPACE
    COMMAND_ERROR_IS_FATAL ANY
)
# Strip surrounding quotes that Node may print
string(REPLACE "\"" "" NODE_ADDON_API_DIR "${NODE_ADDON_API_DIR}")

# ── Native addon target ───────────────────────────────────────────────────────
add_library(xleth_native MODULE
    src/XlethAddon.cpp
    ${CMAKE_JS_SRC}   # win_delay_load_hook.cc — required for Electron
)

# On all platforms the output must be a .node file with no lib prefix
set_target_properties(xleth_native PROPERTIES
    PREFIX ""
    SUFFIX ".node"
)

# cmake-js provides CMAKE_JS_INC (Node.js + N-API headers) and
# CMAKE_JS_LIB (node.lib on Windows / empty on Linux/macOS)
target_include_directories(xleth_native PRIVATE
    ${CMAKE_JS_INC}
    ${NODE_ADDON_API_DIR}
)

target_compile_definitions(xleth_native PRIVATE
    XLETH_DEBUG                       # enable structured debug logging to stderr
    # Disable C++ exception wrappers — use Napi::Error throw pattern instead
    NAPI_DISABLE_CPP_EXCEPTIONS
    NODE_ADDON_API_DISABLE_DEPRECATED
    NAPI_VERSION=8
)

target_link_libraries(xleth_native PRIVATE
    XlethEngineCore     # CPU-only engine (no VideoCompositor/GLFW/GLEW/OpenGL)
    XlethEngineHeaders  # JUCE/FFmpeg include paths only — no extra sources added
    ${CMAKE_JS_LIB}
)

# Ensure editor-host is always built alongside the bridge so the worker can
# spawn it. Without this, a build that touches only XlethAddon.cpp would skip
# the editor-host target.
add_dependencies(xleth_native xleth-editor-host)

# ── Export naming unit test (no external dependencies) ────────────────────────
add_executable(test_export_naming test_export_naming.cpp)
target_include_directories(test_export_naming PRIVATE src)
target_compile_features(test_export_naming PRIVATE cxx_std_20)
