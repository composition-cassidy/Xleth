# ── JUCE ─────────────────────────────────────────────────────────────────────
# Try a local install first, fall back to FetchContent
include(FetchContent)

# ── Vendored vcpkg packages ───────────────────────────────────────────────────
# Reuse the bridge's already-installed vcpkg packages when they exist so the
# standalone engine build can resolve FFmpeg/GLEW/GLFW without extra machine
# setup. This mirrors the bridge CMake configuration.
set(_VCPKG_INSTALLED "${CMAKE_CURRENT_SOURCE_DIR}/../bridge/build/vcpkg_installed/x64-windows"
    CACHE PATH "Pre-installed vcpkg packages shared with the bridge build")

if(EXISTS "${_VCPKG_INSTALLED}")
    list(APPEND CMAKE_PREFIX_PATH "${_VCPKG_INSTALLED}")
    list(APPEND CMAKE_PREFIX_PATH "${_VCPKG_INSTALLED}/debug")
    list(APPEND CMAKE_MODULE_PATH "${_VCPKG_INSTALLED}/share/ffmpeg")
    set(VCPKG_MANIFEST_MODE OFF CACHE BOOL "" FORCE)
    message(STATUS "Using pre-installed vcpkg packages at ${_VCPKG_INSTALLED}")
endif()

if(EXISTS "C:/JUCE/CMakeLists.txt")
    add_subdirectory("C:/JUCE" "${CMAKE_BINARY_DIR}/JUCE" EXCLUDE_FROM_ALL)
else()
    FetchContent_Declare(
        JUCE
        GIT_REPOSITORY https://github.com/juce-framework/JUCE.git
        GIT_TAG        8.0.6
        GIT_SHALLOW    TRUE
    )
    FetchContent_MakeAvailable(JUCE)
endif()

# ── nlohmann/json ────────────────────────────────────────────────────────────
find_package(nlohmann_json CONFIG QUIET)
if(NOT nlohmann_json_FOUND)
    FetchContent_Declare(
        nlohmann_json
        GIT_REPOSITORY https://github.com/nlohmann/json.git
        GIT_TAG        v3.11.3
        GIT_SHALLOW    TRUE
    )
    FetchContent_MakeAvailable(nlohmann_json)
endif()

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

# ── WORLD vocoder (Harvest + CheapTrick + D4C + Synthesis) ───────────────────
# Offline pitch/time-stretch with formant-aware reconstruction. Used as
# StretchMethod::WORLD; processing happens on the ClipRenderCache worker
# thread, results flow through the existing per-clip atomic publish path.
FetchContent_Declare(
    world_src
    GIT_REPOSITORY https://github.com/mmorise/World.git
    GIT_TAG        v1.0.1            # tag verified via git ls-remote 2026-04-27
    GIT_SHALLOW    TRUE
)
FetchContent_GetProperties(world_src)
if(NOT world_src_POPULATED)
    FetchContent_Populate(world_src)
endif()

add_library(world_static STATIC
    ${world_src_SOURCE_DIR}/src/cheaptrick.cpp
    # codec.cpp omitted — WORLD's WAV file I/O for CLI examples; we feed
    # JUCE buffers directly so it would compile dead.
    ${world_src_SOURCE_DIR}/src/common.cpp
    ${world_src_SOURCE_DIR}/src/d4c.cpp
    ${world_src_SOURCE_DIR}/src/dio.cpp
    ${world_src_SOURCE_DIR}/src/fft.cpp
    ${world_src_SOURCE_DIR}/src/harvest.cpp
    ${world_src_SOURCE_DIR}/src/matlabfunctions.cpp
    ${world_src_SOURCE_DIR}/src/stonemask.cpp
    ${world_src_SOURCE_DIR}/src/synthesis.cpp
    # synthesisrealtime.cpp: kept for completeness — Xleth uses offline
    # Synthesis only, so its symbols are never linked into the final binary.
    # Retained so anyone exploring WORLD's streaming API doesn't re-edit CMake.
    ${world_src_SOURCE_DIR}/src/synthesisrealtime.cpp
)

target_include_directories(world_static PUBLIC
    ${world_src_SOURCE_DIR}/src
)

target_compile_definitions(world_static PRIVATE
    NOMINMAX
    _USE_MATH_DEFINES
)

if(MSVC)
    target_compile_options(world_static PRIVATE /wd4996 /W0)
endif()

# ── xxHash (header-only, used by WorldStretchCache for content keying) ───────
FetchContent_Declare(
    xxhash_src
    GIT_REPOSITORY https://github.com/Cyan4973/xxHash.git
    GIT_TAG        v0.8.2
    GIT_SHALLOW    TRUE
)
FetchContent_GetProperties(xxhash_src)
if(NOT xxhash_src_POPULATED)
    FetchContent_Populate(xxhash_src)
endif()

add_library(xxhash_static INTERFACE)
target_include_directories(xxhash_static INTERFACE ${xxhash_src_SOURCE_DIR})

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
    src/model/VideoFlipResolver.cpp
    src/model/ClipModulationEvaluator.cpp
    src/model/ClipCompanionFxBuilder.cpp
    src/import/FscScoreParser.cpp
    src/project/ProjectManager.cpp
    src/commands/UndoManager.cpp
    src/commands/TimelineCommands.cpp
    src/commands/QuantizeClipsBatchCommand.cpp
    src/commands/AddNotesBatchCommand.cpp
    src/audio/TrackRouting.cpp
)

target_include_directories(XlethEngineModel PUBLIC
    ${CMAKE_CURRENT_SOURCE_DIR}/src
)

target_link_libraries(XlethEngineModel PUBLIC
    nlohmann_json::nlohmann_json
)

target_compile_definitions(XlethEngineModel PRIVATE
    XLETH_DEBUG                       # enable structured debug logging to stderr
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
    src/midi/MidiImporter.cpp
    src/commands/ImportMidiCommand.cpp
    src/VoiceManager.cpp
    src/audio/MixEngine.cpp
    src/audio/AudioPerformanceTelemetry.cpp
    src/audio/PluginRegistry.cpp
    src/audio/PluginEditorHost.cpp
    src/audio/EditorProcessCoordinator.cpp
    src/audio/ClipRenderCache.cpp
    src/audio/ClipModulatedReader.cpp
    src/audio/ClipVibratoIntegrator.cpp
    src/model/ClipVideoModulationTiming.cpp
    src/audio/TrackMixer.cpp
    src/audio/SourcePlayer.cpp
    src/audio/Sampler.cpp
    src/audio/Arpeggiator.cpp
    src/audio/SampleProcessor.cpp
    src/audio/EffectChainManager.cpp
    src/audio/AudioGraph.cpp
    src/audio/GraphEffectParameters.cpp
    src/audio/GuardedPluginWrapper.cpp
    src/audio/NamedAudioRing.cpp
    src/audio/WaveformMipmap.cpp
    src/dsp/DeclickEnvelope.cpp
    src/dsp/TDPSOLA.cpp
    src/dsp/RubberBandWrapper.cpp
    src/dsp/WSOLA.cpp
    src/dsp/PhaseVocoder.cpp
    src/dsp/WORLD.cpp
    src/audio/WorldStretchCache.cpp
    src/video/FrameOutput.cpp
    src/video/FrameServer.cpp
    src/FrameCache.cpp
    src/VideoDecoder.cpp
    src/ProxyTranscoder.cpp
    src/SyncManager.cpp
    src/project/ProjectManager.cpp
    src/project/ProxyManager.cpp
    src/export/AudioExporter.cpp
    src/export/FFmpegMuxer.cpp
    src/render/RenderClock.cpp
    src/render/GpuDeviceManager.cpp
    src/render/FrameCache.cpp
    src/render/FrameCollector.cpp
    src/render/VideoFlipApplier.cpp
    src/render/RenderVideoDecoder.cpp
    src/render/GridCompositor.cpp
    src/render/HwEncoderDetector.cpp
    src/render/OfflineRenderer.cpp
    src/render/ArpVideoExpander.cpp
    src/render/AnimationManager.cpp
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
    JUCE_PLUGINHOST_VST3=1            # enable VST3 plugin hosting
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
    world_static        # WORLD vocoder (StretchMethod::WORLD)
    xxhash_static       # content hashing for WorldStretchCache
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
    JUCE_PLUGINHOST_VST3=1
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

# ── test_loop_region ──────────────────────────────────────────────────────────
# LoopRegion data model + invariants + the pure LoopTrap playback state machine.
# Model-only (LoopTrap.h is header-only) — no JUCE, no FFmpeg, no GL.
add_executable(test_loop_region
    test/test_loop_region.cpp
)

target_link_libraries(test_loop_region PRIVATE
    XlethEngineModel
)

# ── test_render_scope ─────────────────────────────────────────────────────────
# Phase 2 render scoping + absolute warm-up policy. render/RenderScope.h is pure
# (depends only on LoopRegion), so this is model-only — no JUCE/FFmpeg/GL.
add_executable(test_render_scope
    test/test_render_scope.cpp
)

target_link_libraries(test_render_scope PRIVATE
    XlethEngineModel
)

# ── test_tail_render ──────────────────────────────────────────────────────────
# Phase 3A tail render policy (hardCut + tailClamp): tail-plan derivation, the
# pure sample-domain tail detector, sanitizers, and scope/estimate math.
# render/RenderScope.h is pure (LoopRegion only) — model-only, no JUCE/FFmpeg/GL.
add_executable(test_tail_render
    test/test_tail_render.cpp
)

target_link_libraries(test_tail_render PRIVATE
    XlethEngineModel
)

# ── test_video_flip_resolver ──────────────────────────────────────────────────
# Unit tests for the per-track flip state-machine evaluator (Phase 2 keystone).
# Covers all 4 v1 modifiers and every edge case in spec §4.4 / §7.
# Pure C++, model-only — links solely against XlethEngineModel.
add_executable(test_video_flip_resolver
    test/test_video_flip_resolver.cpp
)

target_link_libraries(test_video_flip_resolver PRIVATE
    XlethEngineModel
)

# ── test_video_flip_applier ───────────────────────────────────────────────────
# Phase 3 single-call-site wrapper: chord detection + per-track resolver.
# Includes SyncManager.h (which needs JUCE/FFmpeg transitively) so this test
# links against XlethEngineCore like test_frame_collector.
add_executable(test_video_flip_applier
    test/test_video_flip_applier.cpp
)

target_link_libraries(test_video_flip_applier PRIVATE
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

target_compile_definitions(test_video_flip_applier PRIVATE
    JUCE_GLOBAL_MODULE_SETTINGS_INCLUDED=1
    JUCE_USE_CURL=0
    JUCE_WEB_BROWSER=0
    JUCE_MODAL_LOOPS_PERMITTED=1
    JUCE_DIRECTSOUND=0
    JUCE_USE_WINDOWS_MEDIA_FORMAT=0
    JUCE_STANDALONE_APPLICATION=1
)

# ── test_flip_determinism ────────────────────────────────────────────────────
# Phase 6 harness: 6 fixture projects, repeated buildVideoEvents calls compared
# byte-for-byte (acceptance #7, #8), legacy migration end-to-end (acceptance #1),
# insertion-stability assertion (acceptance #11), state-count coverage smoke,
# and a perf budget check (acceptance #10). Calls OfflineRenderer::buildVideoEvents
# directly so it links against XlethEngineCore (and its JUCE/FFmpeg deps).
add_executable(test_flip_determinism
    test/test_flip_determinism.cpp
)

target_link_libraries(test_flip_determinism PRIVATE
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

target_compile_definitions(test_flip_determinism PRIVATE
    JUCE_GLOBAL_MODULE_SETTINGS_INCLUDED=1
    JUCE_USE_CURL=0
    JUCE_WEB_BROWSER=0
    JUCE_MODAL_LOOPS_PERMITTED=1
    JUCE_DIRECTSOUND=0
    JUCE_USE_WINDOWS_MEDIA_FORMAT=0
    JUCE_STANDALONE_APPLICATION=1
)

# ── test_flip_orientation_golden ─────────────────────────────────────────────
# Phase 6 GPU shader golden: 6 orientations × 4-quadrant test texture, real
# D3D11 readback. Skips cleanly if no GPU device is available.
add_executable(test_flip_orientation_golden
    test/test_flip_orientation_golden.cpp
)

target_link_libraries(test_flip_orientation_golden PRIVATE
    XlethEngineCore
    XlethEngineModel
    d3d11
    dxgi
)

target_compile_definitions(test_flip_orientation_golden PRIVATE
    JUCE_GLOBAL_MODULE_SETTINGS_INCLUDED=1
    JUCE_USE_CURL=0
    JUCE_WEB_BROWSER=0
    JUCE_MODAL_LOOPS_PERMITTED=1
    JUCE_DIRECTSOUND=0
    JUCE_USE_WINDOWS_MEDIA_FORMAT=0
    JUCE_STANDALONE_APPLICATION=1
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

# ── test_track_routing ────────────────────────────────────────────────────────
# Prompt 2A: output-routing model, validation, undo command, serialization.
# No JUCE, no FFmpeg, no GL — pure model + commands.
add_executable(test_track_routing
    test/test_track_routing.cpp
)

target_link_libraries(test_track_routing PRIVATE
    XlethEngineModel
)

# ── test_clip_modulation_evaluator ────────────────────────────────────────────
# Phase B: pure deterministic evaluator math for ClipModulation (vibrato +
# vinyl scratch). No JUCE, no FFmpeg, no GL — model-only.
add_executable(test_clip_modulation_evaluator
    test/test_clip_modulation_evaluator.cpp
)

target_link_libraries(test_clip_modulation_evaluator PRIVATE
    XlethEngineModel
)

# ── test_clip_companion_fx_builder ───────────────────────────────────────────
# Phase E.3: shared ClipCompanionFxSnapshot builder used by both the export
# pipeline (FrameCollector → GridCompositor) and the realtime preview path
# (SyncManager → VideoCompositor). Verifies gating + signed propagation so
# preview and export cannot drift apart. Model-only — no JUCE, FFmpeg, or GL.
add_executable(test_clip_companion_fx_builder
    test/test_clip_companion_fx_builder.cpp
)

target_link_libraries(test_clip_companion_fx_builder PRIVATE
    XlethEngineModel
)

# ── test_clip_modulated_reader ────────────────────────────────────────────────
# Phase E.1: shared video timing helper for Scratch/Vibrato source-time warp.
add_executable(test_clip_video_modulation_timing
    test/test_clip_video_modulation_timing.cpp
)

target_link_libraries(test_clip_video_modulation_timing PRIVATE
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

target_compile_definitions(test_clip_video_modulation_timing PRIVATE
    JUCE_GLOBAL_MODULE_SETTINGS_INCLUDED=1
    JUCE_USE_CURL=0
    JUCE_WEB_BROWSER=0
    JUCE_MODAL_LOOPS_PERMITTED=1
    JUCE_DIRECTSOUND=0
    JUCE_USE_WINDOWS_MEDIA_FORMAT=0
    JUCE_STANDALONE_APPLICATION=1
)

# Phase C: per-clip vibrato audio reader. Renders synthetic in-memory PCM and
# verifies static pitch ratio, depth-zero passthrough, block-size invariance,
# bounds clamping, and the unseen-state sweep. Needs juce_audio_basics for
# juce::AudioBuffer<float>.
add_executable(test_clip_modulated_reader
    test/test_clip_modulated_reader.cpp
)

target_link_libraries(test_clip_modulated_reader PRIVATE
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

target_compile_definitions(test_clip_modulated_reader PRIVATE
    JUCE_GLOBAL_MODULE_SETTINGS_INCLUDED=1
    JUCE_USE_CURL=0
    JUCE_WEB_BROWSER=0
    JUCE_MODAL_LOOPS_PERMITTED=1
    JUCE_DIRECTSOUND=0
    JUCE_USE_WINDOWS_MEDIA_FORMAT=0
    JUCE_STANDALONE_APPLICATION=1
)

target_link_options(test_clip_modulated_reader PRIVATE /STACK:33554432)

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

# MixEngine pulls in heavier JUCE + audio headers than the lighter test targets.
# 8 MB stack prevents STATUS_STACK_OVERFLOW during JUCE static initialisation.
target_link_options(test_mix PRIVATE /STACK:8388608)

# ── test_mixer_bus_routing ───────────────────────────────────────────────────
# Prompt 2B: audible output-route bus summing in MixEngine::processBlock.
# Verifies no-double-Master, topo order independence, bus-with/without own audio,
# nested routes, reset-to-Master, and route-aware mute/solo. Requires JUCE.
add_executable(test_mixer_bus_routing
    test/test_mixer_bus_routing.cpp
)

target_link_libraries(test_mixer_bus_routing PRIVATE
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

target_compile_definitions(test_mixer_bus_routing PRIVATE
    JUCE_GLOBAL_MODULE_SETTINGS_INCLUDED=1
    JUCE_USE_CURL=0
    JUCE_WEB_BROWSER=0
    JUCE_MODAL_LOOPS_PERMITTED=1
    JUCE_DIRECTSOUND=0
    JUCE_USE_WINDOWS_MEDIA_FORMAT=0
    JUCE_STANDALONE_APPLICATION=1
)

target_link_options(test_mixer_bus_routing PRIVATE /STACK:8388608)

# ── test_mixer_routing_pdc ───────────────────────────────────────────────────
# Prompt 2C: route-aware junction PDC + export pre-roll max path latency.
# Impulse-coincidence tests (latent bus chains, sibling sources, nested buses,
# mute/solo closure, route reset) plus AudioExporter pre-roll/parity probes
# that fail under the old flat per-track PDC model. Requires JUCE + FFmpeg
# (via XlethEngineCore for AudioExporter).
add_executable(test_mixer_routing_pdc
    test/test_mixer_routing_pdc.cpp
)

target_link_libraries(test_mixer_routing_pdc PRIVATE
    XlethEngineCore
    XlethEngineModel
    juce::juce_core
    juce::juce_audio_basics
    juce::juce_audio_formats
    juce::juce_audio_processors
    juce::juce_events
    juce::juce_gui_basics
    juce::juce_recommended_config_flags
    juce::juce_recommended_warning_flags
)

target_compile_definitions(test_mixer_routing_pdc PRIVATE
    JUCE_GLOBAL_MODULE_SETTINGS_INCLUDED=1
    JUCE_USE_CURL=0
    JUCE_WEB_BROWSER=0
    JUCE_MODAL_LOOPS_PERMITTED=1
    JUCE_DIRECTSOUND=0
    JUCE_USE_WINDOWS_MEDIA_FORMAT=0
    JUCE_STANDALONE_APPLICATION=1
)

target_link_options(test_mixer_routing_pdc PRIVATE /STACK:8388608)

# ── test_clip_sr ─────────────────────────────────────────────────────────────
# Regression for the export clip-pitch (sample-rate) bug: clips baked at one
# engine rate and exported at another must preserve pitch. Exercises the raw
# fallback, cache-hit, and modulated-reader clip read branches.
add_executable(test_clip_sr
    test/test_clip_sr.cpp
)

target_link_libraries(test_clip_sr PRIVATE
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

target_compile_definitions(test_clip_sr PRIVATE
    JUCE_GLOBAL_MODULE_SETTINGS_INCLUDED=1
    JUCE_USE_CURL=0
    JUCE_WEB_BROWSER=0
    JUCE_MODAL_LOOPS_PERMITTED=1
    JUCE_DIRECTSOUND=0
    JUCE_USE_WINDOWS_MEDIA_FORMAT=0
    JUCE_STANDALONE_APPLICATION=1
)

target_link_options(test_clip_sr PRIVATE /STACK:8388608)

# Audio performance telemetry unit tests. No JUCE dependency.
add_executable(test_audio_telemetry
    test/test_audio_telemetry.cpp
    src/audio/AudioPerformanceTelemetry.cpp
)

target_include_directories(test_audio_telemetry PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/src
)

target_compile_definitions(test_audio_telemetry PRIVATE
    NOMINMAX
)

# Audio performance scenario harness/report tests. This target is deterministic:
# it verifies report structure and soft classifications, not host wall-clock speed.
add_executable(test_audio_perf_scenarios
    test/test_audio_perf_scenarios.cpp
    src/audio/AudioPerformanceTelemetry.cpp
    src/audio/AudioPerformanceScenarioRunner.cpp
)

target_include_directories(test_audio_perf_scenarios PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/src
)

target_link_libraries(test_audio_perf_scenarios PRIVATE
    nlohmann_json::nlohmann_json
)

target_compile_definitions(test_audio_perf_scenarios PRIVATE
    NOMINMAX
)

# Manual audio performance report runner. This is intentionally not registered
# as a normal unit test: it drives real MixEngine processing and produces
# machine-local timing diagnostics without making CI depend on wall-clock speed.
add_executable(xleth_audio_perf_report
    tools/xleth_audio_perf_report.cpp
    src/audio/AudioPerformanceScenarioRunner.cpp
)

target_link_libraries(xleth_audio_perf_report PRIVATE
    XlethEngineCore
    XlethEngineModel
    nlohmann_json::nlohmann_json
    juce::juce_core
    juce::juce_audio_basics
    juce::juce_audio_formats
    juce::juce_events
    juce::juce_gui_basics
    juce::juce_recommended_config_flags
    juce::juce_recommended_warning_flags
)

target_include_directories(xleth_audio_perf_report PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/src
)

target_compile_definitions(xleth_audio_perf_report PRIVATE
    JUCE_GLOBAL_MODULE_SETTINGS_INCLUDED=1
    JUCE_USE_CURL=0
    JUCE_WEB_BROWSER=0
    JUCE_MODAL_LOOPS_PERMITTED=1
    JUCE_DIRECTSOUND=0
    JUCE_USE_WINDOWS_MEDIA_FORMAT=0
    JUCE_STANDALONE_APPLICATION=1
    NOMINMAX
)

target_link_options(xleth_audio_perf_report PRIVATE /STACK:33554432)

# Focused offline diagnostic for audible PDC/export accounting. Not registered
# as a unit test because it loads a machine-local project scratch copy and
# writes JSON/Markdown reports under diagnostics/.
add_executable(xleth_pdc_audible_diagnostic
    tools/xleth_pdc_audible_diagnostic.cpp
)

target_link_libraries(xleth_pdc_audible_diagnostic PRIVATE
    XlethEngineCore
    XlethEngineModel
    nlohmann_json::nlohmann_json
    juce::juce_core
    juce::juce_audio_basics
    juce::juce_audio_formats
    juce::juce_audio_processors
    juce::juce_dsp
    juce::juce_events
    juce::juce_gui_basics
    juce::juce_recommended_config_flags
    juce::juce_recommended_warning_flags
    advapi32
)

target_include_directories(xleth_pdc_audible_diagnostic PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/src
)

target_compile_definitions(xleth_pdc_audible_diagnostic PRIVATE
    JUCE_GLOBAL_MODULE_SETTINGS_INCLUDED=1
    JUCE_USE_CURL=0
    JUCE_WEB_BROWSER=0
    JUCE_MODAL_LOOPS_PERMITTED=1
    JUCE_DIRECTSOUND=0
    JUCE_USE_WINDOWS_MEDIA_FORMAT=0
    JUCE_STANDALONE_APPLICATION=1
    NOMINMAX
)

target_link_options(xleth_pdc_audible_diagnostic PRIVATE /STACK:33554432)

# Real-signal PDC tap diagnostic. Like Stage 8A, this is tool-only and writes
# JSON/Markdown reports rather than running as a normal unit test.
add_executable(xleth_pdc_real_signal_tap
    tools/xleth_pdc_real_signal_tap.cpp
)

target_link_libraries(xleth_pdc_real_signal_tap PRIVATE
    XlethEngineCore
    XlethEngineModel
    nlohmann_json::nlohmann_json
    juce::juce_core
    juce::juce_audio_basics
    juce::juce_audio_formats
    juce::juce_audio_processors
    juce::juce_dsp
    juce::juce_events
    juce::juce_gui_basics
    juce::juce_recommended_config_flags
    juce::juce_recommended_warning_flags
    advapi32
)

target_include_directories(xleth_pdc_real_signal_tap PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/src
)

target_compile_definitions(xleth_pdc_real_signal_tap PRIVATE
    JUCE_GLOBAL_MODULE_SETTINGS_INCLUDED=1
    JUCE_USE_CURL=0
    JUCE_WEB_BROWSER=0
    JUCE_MODAL_LOOPS_PERMITTED=1
    JUCE_DIRECTSOUND=0
    JUCE_USE_WINDOWS_MEDIA_FORMAT=0
    JUCE_STANDALONE_APPLICATION=1
    NOMINMAX
)

target_link_options(xleth_pdc_real_signal_tap PRIVATE /STACK:33554432)

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

# ── test_world_stretch ───────────────────────────────────────────────────────
# Verifies WORLD vocoder DSP (pitch shift + time stretch) and the
# WorldStretchCache LRU (hit, miss, multi-variant). No MixEngine required.
add_executable(test_world_stretch
    test/test_world_stretch.cpp
)

target_link_libraries(test_world_stretch PRIVATE
    XlethEngineCore
    XlethEngineModel
    juce::juce_core
    juce::juce_audio_basics
    juce::juce_audio_formats
    juce::juce_dsp
    juce::juce_events
    juce::juce_gui_basics
    juce::juce_recommended_config_flags
    juce::juce_recommended_warning_flags
)

target_compile_definitions(test_world_stretch PRIVATE
    JUCE_GLOBAL_MODULE_SETTINGS_INCLUDED=1
    JUCE_USE_CURL=0
    JUCE_WEB_BROWSER=0
    JUCE_MODAL_LOOPS_PERMITTED=1
    JUCE_DIRECTSOUND=0
    JUCE_USE_WINDOWS_MEDIA_FORMAT=0
    JUCE_STANDALONE_APPLICATION=1
)

# ── test_midi_importer ────────────────────────────────────────────────────────
# Smoke test for MIDI summary parsing using a tiny generated SMF fixture file.
add_executable(test_midi_importer
    test/test_midi_importer.cpp
)

target_link_libraries(test_midi_importer PRIVATE
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

target_compile_definitions(test_midi_importer PRIVATE
    JUCE_GLOBAL_MODULE_SETTINGS_INCLUDED=1
    JUCE_USE_CURL=0
    JUCE_WEB_BROWSER=0
    JUCE_MODAL_LOOPS_PERMITTED=1
    JUCE_DIRECTSOUND=0
    JUCE_USE_WINDOWS_MEDIA_FORMAT=0
    JUCE_STANDALONE_APPLICATION=1
)

# ── test_fsc_score_parser ─────────────────────────────────────────────────────
# Neutral FL Studio Score (.fsc) parser tests. The parser is pure C++ (no JUCE,
# no FFmpeg, no GL) and lives in XlethEngineModel, so this test links model-only
# like test_timeline. Real .fsc fixtures live under test/fixtures/fsc and are
# located at runtime via the XLETH_FSC_FIXTURE_DIR compile definition.
add_executable(test_fsc_score_parser
    test/test_fsc_score_parser.cpp
)

target_link_libraries(test_fsc_score_parser PRIVATE
    XlethEngineModel
)

target_compile_definitions(test_fsc_score_parser PRIVATE
    XLETH_FSC_FIXTURE_DIR="${CMAKE_CURRENT_SOURCE_DIR}/test/fixtures/fsc"
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

# ── test_distortion ──────────────────────────────────────────────────────────
# Focused Distortion diagnostics. Kept separate from test_effects so it can run
# independently while unrelated effect tests are being repaired.
# Latency observability and expected-fail Plugin Delay Compensation probes.
add_executable(test_pdc_stage1
    test/test_pdc_stage1.cpp
)

target_link_libraries(test_pdc_stage1 PRIVATE
    XlethEngineCore
    XlethEngineModel
    juce::juce_core
    juce::juce_audio_basics
    juce::juce_audio_devices
    juce::juce_audio_formats
    juce::juce_audio_processors
    juce::juce_dsp
    juce::juce_events
    juce::juce_gui_basics
    juce::juce_recommended_config_flags
    juce::juce_recommended_warning_flags
)

target_compile_definitions(test_pdc_stage1 PRIVATE
    JUCE_GLOBAL_MODULE_SETTINGS_INCLUDED=1
    JUCE_USE_CURL=0
    JUCE_WEB_BROWSER=0
    JUCE_MODAL_LOOPS_PERMITTED=1
    JUCE_DIRECTSOUND=0
    JUCE_USE_WINDOWS_MEDIA_FORMAT=0
    JUCE_STANDALONE_APPLICATION=1
)

add_executable(test_distortion
    test/test_distortion.cpp
)

target_link_libraries(test_distortion PRIVATE
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

target_compile_definitions(test_distortion PRIVATE
    JUCE_GLOBAL_MODULE_SETTINGS_INCLUDED=1
    JUCE_USE_CURL=0
    JUCE_WEB_BROWSER=0
    JUCE_MODAL_LOOPS_PERMITTED=1
    JUCE_DIRECTSOUND=0
    JUCE_USE_WINDOWS_MEDIA_FORMAT=0
    JUCE_STANDALONE_APPLICATION=1
)

# ── test_reverb ──────────────────────────────────────────────────────────────
# Stage 0 regression lock for XlethReverbEffect (Generic FDN algorithm).
# Verifies: parameter layout, finite output, wet non-zero, tail decay,
# determinism across fresh instances, predelay onset, serialization,
# bypass passthrough, and stable numerical signature.
add_executable(test_reverb
    test/test_reverb.cpp
)

target_link_libraries(test_reverb PRIVATE
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

target_compile_definitions(test_reverb PRIVATE
    JUCE_GLOBAL_MODULE_SETTINGS_INCLUDED=1
    JUCE_USE_CURL=0
    JUCE_WEB_BROWSER=0
    JUCE_MODAL_LOOPS_PERMITTED=1
    JUCE_DIRECTSOUND=0
    JUCE_USE_WINDOWS_MEDIA_FORMAT=0
    JUCE_STANDALONE_APPLICATION=1
)

# ── test_graph_effect_parameters ─────────────────────────────────────────────
# FXG.4-a: unified graph-owned parameter descriptor + normalized read/write
# foundation. Exercises stock (APVTS) enumeration, normalized clamping,
# parameterIndex fallback resolution, fail-safe error paths, and MixEngine
# track routing / master rejection. Third-party plugin enumeration shares the
# same descriptor path but needs scanned VST3 fixtures, so it is not unit-tested.
add_executable(test_graph_effect_parameters
    test/test_graph_effect_parameters.cpp
)

target_link_libraries(test_graph_effect_parameters PRIVATE
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

target_compile_definitions(test_graph_effect_parameters PRIVATE
    JUCE_GLOBAL_MODULE_SETTINGS_INCLUDED=1
    JUCE_USE_CURL=0
    JUCE_WEB_BROWSER=0
    JUCE_MODAL_LOOPS_PERMITTED=1
    JUCE_DIRECTSOUND=0
    JUCE_USE_WINDOWS_MEDIA_FORMAT=0
    JUCE_STANDALONE_APPLICATION=1
)

target_link_options(test_graph_effect_parameters PRIVATE /STACK:8388608)

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

# ── test_animation_manager ───────────────────────────────────────────────────
# Verifies the slide visual return system: latch-at-target, captured baseline,
# Instant / SmoothReverse return, NextSlideNote toggle/consume, TV ramp-UP.
# Pure CPU — no GPU or decoder.
add_executable(test_animation_manager
    test/test_animation_manager.cpp
)

target_link_libraries(test_animation_manager PRIVATE
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

target_compile_definitions(test_animation_manager PRIVATE
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

if(MSVC)
    # Debug builds of this integration harness instantiate several large
    # renderer/mixer/timeline objects across scoped tests. MSVC's Debug stack
    # probes can fault before main() prints diagnostics when the default 1 MB
    # stack is used, making the failure look like a silent exit.
    target_link_options(test_offline_render PRIVATE "/STACK:67108864")
endif()

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
