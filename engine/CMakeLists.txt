# ── JUCE ─────────────────────────────────────────────────────────────────────
# Try a local install first, fall back to FetchContent
if(EXISTS "C:/JUCE/CMakeLists.txt")
    add_subdirectory("C:/JUCE" "${CMAKE_BINARY_DIR}/JUCE" EXCLUDE_FROM_ALL)
else()
    include(FetchContent)
    FetchContent_Declare(
        JUCE
        GIT_REPOSITORY https://github.com/juce-framework/JUCE.git
        GIT_TAG        8.0.6
        GIT_SHALLOW    TRUE
    )
    FetchContent_MakeAvailable(JUCE)
endif()

# ── nlohmann/json ────────────────────────────────────────────────────────────
find_package(nlohmann_json CONFIG REQUIRED)

# ── FFmpeg ───────────────────────────────────────────────────────────────────
find_package(FFMPEG REQUIRED)

# ── OpenGL + GLEW + GLFW (only used by the standalone executable) ─────────────
find_package(OpenGL REQUIRED)
find_package(GLEW REQUIRED)
find_package(glfw3 CONFIG REQUIRED)

# ── Rubber Band (R3, static, builtin FFT + resampler) ────────────────────────
# Rubber Band uses Meson, not CMake, so we cannot use FetchContent_MakeAvailable.
# Instead we populate the source tree ourselves and define a static library target
# that compiles only the sources we need with USE_BUILTIN_FFT/RESAMPLER.
include(FetchContent)
FetchContent_Declare(
    rubberband_src
    GIT_REPOSITORY https://github.com/breakfastquay/rubberband.git
    GIT_TAG        v4.0.0
    GIT_SHALLOW    TRUE
)
FetchContent_GetProperties(rubberband_src)
if(NOT rubberband_src_POPULATED)
    FetchContent_Populate(rubberband_src)
endif()

add_library(rubberband_static STATIC
    ${rubberband_src_SOURCE_DIR}/src/rubberband-c.cpp
    ${rubberband_src_SOURCE_DIR}/src/RubberBandStretcher.cpp
    ${rubberband_src_SOURCE_DIR}/src/RubberBandLiveShifter.cpp
    ${rubberband_src_SOURCE_DIR}/src/faster/AudioCurveCalculator.cpp
    ${rubberband_src_SOURCE_DIR}/src/faster/CompoundAudioCurve.cpp
    ${rubberband_src_SOURCE_DIR}/src/faster/HighFrequencyAudioCurve.cpp
    ${rubberband_src_SOURCE_DIR}/src/faster/SilentAudioCurve.cpp
    ${rubberband_src_SOURCE_DIR}/src/faster/PercussiveAudioCurve.cpp
    ${rubberband_src_SOURCE_DIR}/src/faster/R2Stretcher.cpp
    ${rubberband_src_SOURCE_DIR}/src/faster/StretcherChannelData.cpp
    ${rubberband_src_SOURCE_DIR}/src/faster/StretcherProcess.cpp
    ${rubberband_src_SOURCE_DIR}/src/common/Allocators.cpp
    ${rubberband_src_SOURCE_DIR}/src/common/BQResampler.cpp
    ${rubberband_src_SOURCE_DIR}/src/common/FFT.cpp
    ${rubberband_src_SOURCE_DIR}/src/common/Log.cpp
    ${rubberband_src_SOURCE_DIR}/src/common/Profiler.cpp
    ${rubberband_src_SOURCE_DIR}/src/common/Resampler.cpp
    ${rubberband_src_SOURCE_DIR}/src/common/StretchCalculator.cpp
    ${rubberband_src_SOURCE_DIR}/src/common/sysutils.cpp
    ${rubberband_src_SOURCE_DIR}/src/common/mathmisc.cpp
    ${rubberband_src_SOURCE_DIR}/src/common/Thread.cpp
    ${rubberband_src_SOURCE_DIR}/src/finer/R3Stretcher.cpp
    ${rubberband_src_SOURCE_DIR}/src/finer/R3LiveShifter.cpp
)

# PUBLIC: consumers can #include <rubberband/RubberBandStretcher.h>
target_include_directories(rubberband_static PUBLIC
    ${rubberband_src_SOURCE_DIR}
)
# PRIVATE: internal rubberband source-tree headers
target_include_directories(rubberband_static PRIVATE
    ${rubberband_src_SOURCE_DIR}/src
)

target_compile_definitions(rubberband_static PRIVATE
    USE_BUILTIN_FFT    # no FFTW3 / SLEEF / IPP dependency
    USE_BQRESAMPLER    # builtin BQ resampler — no libsamplerate / speex dependency
    NOMINMAX           # prevent Windows min/max macro conflicts
    _USE_MATH_DEFINES  # M_PI etc. under MSVC
)

if(MSVC)
    # Suppress warnings from third-party rubberband source
    target_compile_options(rubberband_static PRIVATE /W0)
endif()

# ── ASIO (optional) ──────────────────────────────────────────────────────────
option(XLETH_ASIO "Enable ASIO support (requires ASIO SDK at C:/ASIOSDK)" OFF)
if(XLETH_ASIO)
    if(EXISTS "C:/ASIOSDK")
        message(STATUS "ASIO SDK found at C:/ASIOSDK — enabling ASIO")
        set(JUCE_ASIO_SUPPORT ON CACHE BOOL "" FORCE)
        include_directories("C:/ASIOSDK/common")
    else()
        message(WARNING "XLETH_ASIO requested but C:/ASIOSDK not found — disabling ASIO")
    endif()
endif()

# ── XlethEngineModel ──────────────────────────────────────────────────────────
# Pure C++ data model: no JUCE, no FFmpeg, no GL. Links against nlohmann/json
# only. Safe to link from the bridge, the engine, or standalone tools.
# Defined BEFORE XlethEngineCore because MixEngine depends on Timeline/Clip/Track.
add_library(XlethEngineModel STATIC
    src/model/SampleRegion.cpp
    src/model/Track.cpp
    src/model/Clip.cpp
    src/model/Pattern.cpp
    src/model/PatternBlock.cpp
    src/model/Timeline.cpp
    src/project/ProjectManager.cpp
    src/commands/UndoManager.cpp
    src/commands/TimelineCommands.cpp
)

target_include_directories(XlethEngineModel PUBLIC
    ${CMAKE_CURRENT_SOURCE_DIR}/src
)

target_link_libraries(XlethEngineModel PUBLIC
    nlohmann_json::nlohmann_json
)

# ── XlethEngineCore ───────────────────────────────────────────────────────────
# CPU-only static library — no VideoCompositor, no GLFW/GLEW/OpenGL.
# This is what the Node.js bridge links against, so the resulting .node DLL
# does NOT import glfw3.dll or glew32.dll, which would conflict with
# Electron/Chromium's GPU process initialisation.
#
# XLETH_CORE_ONLY is defined here; SyncManager.cpp uses it to compile-out
# all VideoCompositor method calls, avoiding any linker references to GL syms.
add_library(XlethEngineCore STATIC
    src/AudioEngine.cpp
    src/AudioScheduler.cpp
    src/Transport.cpp
    src/SampleBank.cpp
    src/VoiceManager.cpp
    src/audio/MixEngine.cpp
    src/audio/ClipRenderCache.cpp
    src/audio/TrackMixer.cpp
    src/audio/SourcePlayer.cpp
    src/audio/Sampler.cpp
    src/audio/Arpeggiator.cpp
    src/audio/SampleProcessor.cpp
    src/audio/EffectChainManager.cpp
    src/audio/AudioGraph.cpp
    src/audio/WaveformMipmap.cpp
    src/dsp/TDPSOLA.cpp
    src/dsp/RubberBandWrapper.cpp
    src/dsp/WSOLA.cpp
    src/dsp/PhaseVocoder.cpp
    src/video/FrameOutput.cpp
    src/video/FrameServer.cpp
    src/FrameCache.cpp
    src/VideoDecoder.cpp
    src/ProxyTranscoder.cpp
    src/SyncManager.cpp
    src/project/ProjectManager.cpp
    src/export/AudioExporter.cpp
    src/export/FFmpegMuxer.cpp
    src/render/RenderClock.cpp
    src/render/GpuDeviceManager.cpp
    src/render/FrameCache.cpp
    src/render/FrameCollector.cpp
    src/render/RenderVideoDecoder.cpp
    src/render/GridCompositor.cpp
    src/render/HwEncoderDetector.cpp
    src/render/OfflineRenderer.cpp
    src/render/ArpVideoExpander.cpp
)

target_include_directories(XlethEngineCore PUBLIC
    ${CMAKE_CURRENT_SOURCE_DIR}/src
)

target_include_directories(XlethEngineCore PRIVATE
    ${FFMPEG_INCLUDE_DIRS}
)

target_link_directories(XlethEngineCore PRIVATE
    ${FFMPEG_LIBRARY_DIRS}
)

target_compile_definitions(XlethEngineCore PRIVATE
    XLETH_DEBUG                       # enable structured debug logging to stderr
    XLETH_CORE_ONLY                   # disables VideoCompositor/GL calls in SyncManager.cpp
    XLETH_HAS_DECODER                 # enables VideoDecoder/ProxyTranscoder in ProjectManager.cpp
    JUCE_USE_CURL=0
    JUCE_WEB_BROWSER=0
    JUCE_MODAL_LOOPS_PERMITTED=1
    # Disable legacy/conflicting Windows subsystems — we want WASAPI-only audio
    # and FFmpeg-only video; DirectSound and WMF both conflict with Electron's
    # media pipeline when their DLLs are loaded into the same process.
    JUCE_DIRECTSOUND=0                # removes dsound.dll from import table
    JUCE_USE_WINDOWS_MEDIA_FORMAT=0   # removes wmvcore.dll from import table
    $<$<BOOL:${XLETH_ASIO}>:JUCE_ASIO=1>
)

# JUCE modules PRIVATE — compiled once here, not re-compiled by consumers
target_link_libraries(XlethEngineCore PRIVATE
    juce::juce_core
    juce::juce_audio_basics
    juce::juce_audio_devices
    juce::juce_audio_formats
    juce::juce_audio_processors
    # juce_audio_processors brings juce_gui_extra → juce_gui_basics → juce_graphics.
    # Safe here because the native addon runs in a forked child process (addon-worker.js),
    # fully isolated from Electron's Chromium/GPU process. The D2D/DXGI DLLs are
    # loaded into the worker only — no conflict with the renderer.
    juce::juce_events
    juce::juce_dsp
    juce::juce_recommended_config_flags
    juce::juce_recommended_warning_flags
    ${FFMPEG_LIBRARIES}
    # D3D11/DXGI for GpuDeviceManager (hardware video decode + GPU compositing).
    # These are Windows system DLLs — no conflict with Electron's GPU process
    # because the addon runs in a forked child process (addon-worker.js).
    d3d11
    dxgi
    rubberband_static   # Rubber Band R3 pitch/time-stretch (static, builtin FFT)
    # No OpenGL::GL, GLEW::GLEW, glfw, or juce_audio_utils here —
    # kept off the bridge link graph to prevent Electron GPU process conflicts.
)

# MixEngine uses Timeline/Clip/TrackInfo from XlethEngineModel.
# PUBLIC so consumers of XlethEngineCore (e.g. bridge addon) get the symbols.
target_link_libraries(XlethEngineCore PUBLIC
    XlethEngineModel
)

# ── XlethEngineHeaders ────────────────────────────────────────────────────────
# INTERFACE library: propagates only include directories and compile definitions
# to consumers (e.g. the Node.js addon) without adding any compiled sources.
# SyncManager.h no longer includes VideoCompositor.h, so this interface
# does not pull in GLFW/GLEW headers for consumers.
add_library(XlethEngineHeaders INTERFACE)

target_include_directories(XlethEngineHeaders INTERFACE
    ${CMAKE_CURRENT_SOURCE_DIR}/src
    ${FFMPEG_INCLUDE_DIRS}
    $<TARGET_PROPERTY:juce::juce_core,INTERFACE_INCLUDE_DIRECTORIES>
    $<TARGET_PROPERTY:juce::juce_audio_basics,INTERFACE_INCLUDE_DIRECTORIES>
    $<TARGET_PROPERTY:juce::juce_audio_devices,INTERFACE_INCLUDE_DIRECTORIES>
    $<TARGET_PROPERTY:juce::juce_audio_formats,INTERFACE_INCLUDE_DIRECTORIES>
    $<TARGET_PROPERTY:juce::juce_events,INTERFACE_INCLUDE_DIRECTORIES>
    $<TARGET_PROPERTY:juce::juce_audio_processors,INTERFACE_INCLUDE_DIRECTORIES>
    $<TARGET_PROPERTY:juce::juce_dsp,INTERFACE_INCLUDE_DIRECTORIES>
    $<TARGET_PROPERTY:juce::juce_gui_basics,INTERFACE_INCLUDE_DIRECTORIES>
    $<TARGET_PROPERTY:juce::juce_gui_extra,INTERFACE_INCLUDE_DIRECTORIES>
    $<TARGET_PROPERTY:juce::juce_graphics,INTERFACE_INCLUDE_DIRECTORIES>
    $<TARGET_PROPERTY:juce::juce_data_structures,INTERFACE_INCLUDE_DIRECTORIES>
    # juce_audio_processors needed for EffectChainManager (AudioProcessorGraph).
    # Include paths are exposed so consumers can compile headers that transitively
    # reference juce_audio_processors types, but no link-time deps are propagated.
)

target_compile_definitions(XlethEngineHeaders INTERFACE
    # Must be defined when including JUCE headers outside a juce_add_*() target
    JUCE_GLOBAL_MODULE_SETTINGS_INCLUDED=1
    JUCE_USE_CURL=0
    JUCE_WEB_BROWSER=0
    JUCE_MODAL_LOOPS_PERMITTED=1
    $<$<BOOL:${XLETH_ASIO}>:JUCE_ASIO=1>
)

# ── Standalone executable ─────────────────────────────────────────────────────
# Thin shell linking XlethEngineCore + VideoCompositor.cpp (GPU).
# VideoCompositor.cpp is compiled ONLY here so GLFW/GLEW/OpenGL symbols
# remain absent from the Node.js addon link graph.
juce_add_console_app(XlethEngine
    PRODUCT_NAME "Xleth Engine"
    VERSION      "0.0.1"
)

target_sources(XlethEngine PRIVATE
    src/Main.cpp
    src/VideoCompositor.cpp   # GPU path — compiled only into the executable
)

# JUCE_STANDALONE_APPLICATION activates START_JUCE_APPLICATION/main() synthesis.
# Must ONLY appear on the executable, never on the library or addon.
target_compile_definitions(XlethEngine PRIVATE
    JUCE_STANDALONE_APPLICATION=1
    # No XLETH_CORE_ONLY here — the executable gets the full compositor
)

target_link_libraries(XlethEngine PRIVATE
    XlethEngineCore
    XlethEngineHeaders
    OpenGL::GL
    GLEW::GLEW
    glfw
    juce::juce_recommended_config_flags
    juce::juce_recommended_warning_flags
)

# ── test_timeline ─────────────────────────────────────────────────────────────
# Self-verification executable. Run after build to confirm "ALL TESTS PASSED".
# No JUCE, no FFmpeg, no GL — compiles and links in seconds.
add_executable(test_timeline
    test/test_timeline.cpp
)

target_link_libraries(test_timeline PRIVATE
    XlethEngineModel
)

# ── test_project ──────────────────────────────────────────────────────────────
# Self-verification executable for ProjectManager persistence.
# Tests createProject, saveProject, loadProject, and validateMedia.
# No JUCE, no FFmpeg, no GL — importSource stub only (XLETH_HAS_DECODER absent).
add_executable(test_project
    test/test_project.cpp
)

target_link_libraries(test_project PRIVATE
    XlethEngineModel
)

# ── test_undo ─────────────────────────────────────────────────────────────────
# Self-verification for the Command-pattern undo/redo system.
# No JUCE, no FFmpeg, no GL — pure model + commands.
add_executable(test_undo
    test/test_undo.cpp
)

target_link_libraries(test_undo PRIVATE
    XlethEngineModel
)

# ── test_mix ─────────────────────────────────────────────────────────────────
# Self-verification for Phase 1 multi-track MixEngine.
# Tests: offline render, panning, mute, solo, peak meters, debug logging.
# Requires JUCE (audio formats for WAV generation + SampleBank).
add_executable(test_mix
    test/test_mix.cpp
)

target_link_libraries(test_mix PRIVATE
    XlethEngineCore
    XlethEngineModel
    juce::juce_core
    juce::juce_audio_basics
    juce::juce_audio_formats
    juce::juce_events
    juce::juce_gui_basics
    juce::juce_recommended_config_flags
    juce::juce_recommended_warning_flags
)

target_compile_definitions(test_mix PRIVATE
    JUCE_GLOBAL_MODULE_SETTINGS_INCLUDED=1
    JUCE_USE_CURL=0
    JUCE_WEB_BROWSER=0
    JUCE_MODAL_LOOPS_PERMITTED=1
    JUCE_DIRECTSOUND=0
    JUCE_USE_WINDOWS_MEDIA_FORMAT=0
    JUCE_STANDALONE_APPLICATION=1
)

# ── test_sampler ─────────────────────────────────────────────────────────────
# Self-verification for the Sampler DSP (pitch shift, ADSR, loop, polyphony).
# No Timeline / MixEngine — tests the Sampler class directly with synthetic
# sine-wave sample data generated at runtime.
add_executable(test_sampler
    test/test_sampler.cpp
)

target_link_libraries(test_sampler PRIVATE
    XlethEngineCore
    XlethEngineModel
    juce::juce_core
    juce::juce_audio_basics
    juce::juce_audio_formats
    juce::juce_events
    juce::juce_gui_basics
    juce::juce_recommended_config_flags
    juce::juce_recommended_warning_flags
)

target_compile_definitions(test_sampler PRIVATE
    JUCE_GLOBAL_MODULE_SETTINGS_INCLUDED=1
    JUCE_USE_CURL=0
    JUCE_WEB_BROWSER=0
    JUCE_MODAL_LOOPS_PERMITTED=1
    JUCE_DIRECTSOUND=0
    JUCE_USE_WINDOWS_MEDIA_FORMAT=0
    JUCE_STANDALONE_APPLICATION=1
)

# ── test_effects ──────────────────────────────────────────────────────────────
# Verifies XlethEffectBase (APVTS, smoothing, metering, serialization, bypass)
# using TestGainEffect as the concrete subclass.
add_executable(test_effects
    test/test_effects.cpp
)

target_link_libraries(test_effects PRIVATE
    XlethEngineCore
    XlethEngineModel
    juce::juce_core
    juce::juce_audio_basics
    juce::juce_audio_processors
    juce::juce_dsp
    juce::juce_events
    juce::juce_gui_basics
    juce::juce_recommended_config_flags
    juce::juce_recommended_warning_flags
)

target_compile_definitions(test_effects PRIVATE
    JUCE_GLOBAL_MODULE_SETTINGS_INCLUDED=1
    JUCE_USE_CURL=0
    JUCE_WEB_BROWSER=0
    JUCE_MODAL_LOOPS_PERMITTED=1
    JUCE_DIRECTSOUND=0
    JUCE_USE_WINDOWS_MEDIA_FORMAT=0
    JUCE_STANDALONE_APPLICATION=1
)

# ── test_frame_cache ─────────────────────────────────────────────────────────
# Verifies the render-pipeline LRU FrameCache with real D3D11 textures.
# Requires a GPU (D3D11 device) — runs on the build machine.
add_executable(test_frame_cache
    test/test_frame_cache.cpp
)

target_link_libraries(test_frame_cache PRIVATE
    XlethEngineCore
    XlethEngineModel
    d3d11
    dxgi
)

target_compile_definitions(test_frame_cache PRIVATE
    JUCE_GLOBAL_MODULE_SETTINGS_INCLUDED=1
    JUCE_USE_CURL=0
    JUCE_WEB_BROWSER=0
    JUCE_MODAL_LOOPS_PERMITTED=1
    JUCE_DIRECTSOUND=0
    JUCE_USE_WINDOWS_MEDIA_FORMAT=0
    JUCE_STANDALONE_APPLICATION=1
)

# ── test_frame_collector ─────────────────────────────────────────────────────
# Verifies FrameCollector collection + deduplication with mock timeline data.
# No GPU needed — pure CPU test.
add_executable(test_frame_collector
    test/test_frame_collector.cpp
)

target_link_libraries(test_frame_collector PRIVATE
    XlethEngineCore
    XlethEngineModel
    juce::juce_core
    juce::juce_audio_basics
    juce::juce_audio_formats
    juce::juce_events
    juce::juce_gui_basics
    juce::juce_recommended_config_flags
    juce::juce_recommended_warning_flags
)

target_compile_definitions(test_frame_collector PRIVATE
    JUCE_GLOBAL_MODULE_SETTINGS_INCLUDED=1
    JUCE_USE_CURL=0
    JUCE_WEB_BROWSER=0
    JUCE_MODAL_LOOPS_PERMITTED=1
    JUCE_DIRECTSOUND=0
    JUCE_USE_WINDOWS_MEDIA_FORMAT=0
    JUCE_STANDALONE_APPLICATION=1
)

# ── test_render_decoder ──────────────────────────────────────────────────────
# Verifies RenderVideoDecoder with real D3D11 GPU + DNxHR proxy file.
# Requires a GPU and a test proxy video generated by ffmpeg.
add_executable(test_render_decoder
    test/test_render_decoder.cpp
)

target_link_libraries(test_render_decoder PRIVATE
    XlethEngineCore
    XlethEngineModel
    d3d11
    dxgi
    ${FFMPEG_LIBRARIES}
)

target_include_directories(test_render_decoder PRIVATE
    ${FFMPEG_INCLUDE_DIRS}
)

target_link_directories(test_render_decoder PRIVATE
    ${FFMPEG_LIBRARY_DIRS}
)

target_compile_definitions(test_render_decoder PRIVATE
    JUCE_GLOBAL_MODULE_SETTINGS_INCLUDED=1
    JUCE_USE_CURL=0
    JUCE_WEB_BROWSER=0
    JUCE_MODAL_LOOPS_PERMITTED=1
    JUCE_DIRECTSOUND=0
    JUCE_USE_WINDOWS_MEDIA_FORMAT=0
    JUCE_STANDALONE_APPLICATION=1
)

# ── test_compositor ──────────────────────────────────────────────────────────
# Verifies GridCompositor with real D3D11 GPU rendering.
# Creates solid-color textures, composites them, reads back pixels.
add_executable(test_compositor
    test/test_compositor.cpp
)

target_link_libraries(test_compositor PRIVATE
    XlethEngineCore
    XlethEngineModel
    d3d11
    dxgi
)

target_compile_definitions(test_compositor PRIVATE
    JUCE_GLOBAL_MODULE_SETTINGS_INCLUDED=1
    JUCE_USE_CURL=0
    JUCE_WEB_BROWSER=0
    JUCE_MODAL_LOOPS_PERMITTED=1
    JUCE_DIRECTSOUND=0
    JUCE_USE_WINDOWS_MEDIA_FORMAT=0
    JUCE_STANDALONE_APPLICATION=1
)

# ── test_muxer ───────────────────────────────────────────────────────────────
# Verifies FFmpegMuxer with built-in mpeg4 + aac encoders.
# No GPU needed — uses only FFmpeg C API.
add_executable(test_muxer
    test/test_muxer.cpp
)

target_link_libraries(test_muxer PRIVATE
    XlethEngineCore
    XlethEngineModel
    ${FFMPEG_LIBRARIES}
)

target_include_directories(test_muxer PRIVATE
    ${FFMPEG_INCLUDE_DIRS}
)

target_link_directories(test_muxer PRIVATE
    ${FFMPEG_LIBRARY_DIRS}
)

target_compile_definitions(test_muxer PRIVATE
    JUCE_GLOBAL_MODULE_SETTINGS_INCLUDED=1
    JUCE_USE_CURL=0
    JUCE_WEB_BROWSER=0
    JUCE_MODAL_LOOPS_PERMITTED=1
    JUCE_DIRECTSOUND=0
    JUCE_USE_WINDOWS_MEDIA_FORMAT=0
    JUCE_STANDALONE_APPLICATION=1
)

# ── test_hw_detect ────────────────────────────────────────────────────────────
# Verifies HwEncoderDetector probes encoders and reports real availability.
# Requires FFmpeg — no GPU or D3D11 needed (encoder probing uses CPU-only test).
add_executable(test_hw_detect
    test/test_hw_detect.cpp
)

target_link_libraries(test_hw_detect PRIVATE
    XlethEngineCore
    XlethEngineModel
    ${FFMPEG_LIBRARIES}
)

target_include_directories(test_hw_detect PRIVATE
    ${FFMPEG_INCLUDE_DIRS}
)

target_link_directories(test_hw_detect PRIVATE
    ${FFMPEG_LIBRARY_DIRS}
)

target_compile_definitions(test_hw_detect PRIVATE
    JUCE_GLOBAL_MODULE_SETTINGS_INCLUDED=1
    JUCE_USE_CURL=0
    JUCE_WEB_BROWSER=0
    JUCE_MODAL_LOOPS_PERMITTED=1
    JUCE_DIRECTSOUND=0
    JUCE_USE_WINDOWS_MEDIA_FORMAT=0
    JUCE_STANDALONE_APPLICATION=1
)

# ── test_offline_render ───────────────────────────────────────────────────────
# Integration test for the OfflineRenderer pipeline.
# Requires JUCE (MixEngine), FFmpeg (muxer), D3D11 (compositor, decoder).
add_executable(test_offline_render
    test/test_offline_render.cpp
)

target_link_libraries(test_offline_render PRIVATE
    XlethEngineCore
    XlethEngineModel
    XlethEngineHeaders
    ${FFMPEG_LIBRARIES}
    d3d11
    dxgi
)

target_include_directories(test_offline_render PRIVATE
    ${FFMPEG_INCLUDE_DIRS}
)

target_link_directories(test_offline_render PRIVATE
    ${FFMPEG_LIBRARY_DIRS}
)

target_compile_definitions(test_offline_render PRIVATE
    JUCE_GLOBAL_MODULE_SETTINGS_INCLUDED=1
    JUCE_USE_CURL=0
    JUCE_WEB_BROWSER=0
    JUCE_MODAL_LOOPS_PERMITTED=1
    JUCE_DIRECTSOUND=0
    JUCE_USE_WINDOWS_MEDIA_FORMAT=0
    JUCE_STANDALONE_APPLICATION=1
)

# ── test_real_render ──────────────────────────────────────────────────────
# Real project integration test: loads XLETH\test project, renders bars 1-17.
add_executable(test_real_render
    test/test_real_render.cpp
)

target_link_libraries(test_real_render PRIVATE
    XlethEngineCore
    XlethEngineModel
    XlethEngineHeaders
    ${FFMPEG_LIBRARIES}
    d3d11
    dxgi
)

target_include_directories(test_real_render PRIVATE
    ${FFMPEG_INCLUDE_DIRS}
)

target_link_directories(test_real_render PRIVATE
    ${FFMPEG_LIBRARY_DIRS}
)

target_compile_definitions(test_real_render PRIVATE
    JUCE_GLOBAL_MODULE_SETTINGS_INCLUDED=1
    JUCE_USE_CURL=0
    JUCE_WEB_BROWSER=0
    JUCE_MODAL_LOOPS_PERMITTED=1
    JUCE_DIRECTSOUND=0
    JUCE_USE_WINDOWS_MEDIA_FORMAT=0
    JUCE_STANDALONE_APPLICATION=1
)
