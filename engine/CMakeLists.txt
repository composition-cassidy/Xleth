# ── JUCE ─────────────────────────────────────────────────────────────────────
# Try a local install first, fall back to FetchContent
include(FetchContent)

# ── Vendored vcpkg packages ───────────────────────────────────────────────────
# vcpkg installs to <build-root>/vcpkg_installed when the toolchain is active.
# Point at that canonical location so incremental configures (no toolchain
# needed) can reuse already-installed packages.
set(_VCPKG_INSTALLED "${CMAKE_CURRENT_SOURCE_DIR}/../build/vcpkg_installed/x64-windows"
    CACHE PATH "Pre-installed vcpkg packages in the main build directory")

if(NOT EXISTS "${_VCPKG_INSTALLED}"
   AND EXISTS "${CMAKE_BINARY_DIR}/vcpkg_installed/x64-windows")
    set(_VCPKG_INSTALLED "${CMAKE_BINARY_DIR}/vcpkg_installed/x64-windows")
endif()

if(EXISTS "${_VCPKG_INSTALLED}")
    list(APPEND CMAKE_PREFIX_PATH "${_VCPKG_INSTALLED}")
    list(APPEND CMAKE_PREFIX_PATH "${_VCPKG_INSTALLED}/debug")
    list(APPEND CMAKE_MODULE_PATH "${_VCPKG_INSTALLED}/share/ffmpeg")
    # Only force manifest mode OFF when NO vcpkg toolchain is driving this build
    # directory. If a toolchain is active (VCPKG_ROOT in the environment, or a
    # CMAKE_TOOLCHAIN_FILE cached from the first configure), it owns manifest
    # mode for the lifetime of the build dir — and it already ran a manifest
    # install into ${CMAKE_BINARY_DIR}/vcpkg_installed. Flipping the mode OFF
    # underneath it writes an inconsistent cache; the very next configure then
    # dies in vcpkg.cmake with "manifest mode was disabled for a build directory
    # where it was initially enabled". Leave the toolchain in charge instead
    # (find_package still resolves the installed packages, manifest stays ON).
    if(NOT DEFINED CMAKE_TOOLCHAIN_FILE)
        set(VCPKG_MANIFEST_MODE OFF CACHE BOOL "" FORCE)
    endif()
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

# No OpenGL/GLEW/GLFW discovery here on purpose. The realtime GL preview path
# (VideoCompositor + the Main.cpp --video-display / --composite-test / --av-sync
# entry points) was retired — see Issue 10 in VIDEO_PREVIEW_AUDIT.txt. All
# compositing, preview and export alike, goes through FrameCollector +
# GridCompositor on D3D11.

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
# Pure C++ data model: no JUCE, no GL. Links against nlohmann/json and libavutil
# only. Safe to link from the bridge, the engine, or standalone tools.
# Defined BEFORE XlethEngineCore because MixEngine depends on Timeline/Clip/Track.
#
# The libavutil dependency is RenderClock (render/RenderClock.cpp), the single
# owner of every sample <-> tick <-> beat conversion in the engine. It sits at
# this tier because AutomationPlan — model-only for testability — has to convert
# a sample position to a tick, and that conversion must be the SAME one
# MixEngine's note scheduler uses, or the two disagree by a tick at every
# boundary. libavutil is a leaf C library (av_rescale_q / av_rescale_rnd only);
# it carries none of the Electron GPU-process conflict risk that keeps JUCE and
# GL out of this tier, and every engine ctest target already gets the vcpkg bin
# directory prepended to PATH.
add_library(XlethEngineModel STATIC
    src/model/ParamTrack.cpp
    src/model/LensRoam.cpp
    src/model/ParentMath.cpp
    src/model/Clone.cpp
    src/model/ColorGrade.cpp
    src/model/ColorGradeSnapshot.cpp
    src/model/TimelineSnapshot.cpp
    src/model/AutomationEnvelope.cpp
    src/model/SampleRegion.cpp
    src/model/SamplerModulationConfig.cpp
    src/model/SamplerLegacyMigration.cpp
    src/model/Track.cpp
    src/model/Clip.cpp
    src/model/Pattern.cpp
    src/model/PatternBlock.cpp
    src/model/Timeline.cpp
    src/model/VideoFlipResolver.cpp
    src/model/EnvelopeParameterModulation.cpp
    src/model/LfoParameterModulation.cpp
    src/model/ClipModulationEvaluator.cpp
    src/model/ClipCompanionFxBuilder.cpp
    src/import/FscScoreParser.cpp
    src/project/ProjectManager.cpp
    src/project/RegenerableFiles.cpp
    src/commands/UndoManager.cpp
    src/commands/TimelineCommands.cpp
    src/commands/ColorGradeCommands.cpp
    src/commands/QuantizeClipsBatchCommand.cpp
    src/commands/AddNotesBatchCommand.cpp
    src/commands/AddClipsBatchCommand.cpp
    src/commands/ClipBatchCommands.cpp
    src/commands/PatternBlockBatchCommands.cpp
    src/commands/AutomationBatchCommands.cpp
    src/commands/EffectChainCommands.cpp
    src/audio/TrackRouting.cpp
    src/audio/AutomationPlan.cpp
    src/render/RenderClock.cpp
    # Sample Sandbox model tier: op descriptors, the workspace that owns the
    # stacks, and the undo commands that mutate them. Pure data — the buffers
    # and the DSP live in SandboxRenderer over in XlethEngineCore, which is what
    # keeps the whole edit model unit-testable with no audio device.
    src/sandbox/SandboxOp.cpp
    src/sandbox/SandboxCore.cpp
    src/sandbox/SandboxCommands.cpp
    # AUTOTUNE correction curve (P5-2): pure math turning a PitchTrackAnalysis
    # result + scale/key + the six AUTOTUNE controls into a per-frame target-f0
    # curve. Only consumes PitchFrame/NoteSegment (plain structs, no JUCE) from
    # dsp/PitchTrackAnalysis.h, so it belongs at this tier alongside the rest
    # of the sandbox model rather than in XlethEngineCore with the JUCE-using
    # detector that produces its input.
    src/dsp/CorrectionCurve.cpp
    # PITCH's Resample (varispeed) mode. Model tier for the same reason
    # CorrectionCurve is — plain math over float pointers, no JUCE — but here
    # it is load-bearing rather than tidy: SandboxOp::outputLength predicts the
    # resulting length at THIS tier, and SandboxRenderer must produce exactly
    # that many samples over in XlethEngineCore. One file, one length rule.
    src/dsp/VarispeedResample.cpp
)

target_include_directories(XlethEngineModel PUBLIC
    ${CMAKE_CURRENT_SOURCE_DIR}/src
)

target_include_directories(XlethEngineModel PRIVATE
    ${FFMPEG_INCLUDE_DIRS}
)

target_link_directories(XlethEngineModel PRIVATE
    ${FFMPEG_LIBRARY_DIRS}
)

target_link_libraries(XlethEngineModel PUBLIC
    nlohmann_json::nlohmann_json
)

target_link_libraries(XlethEngineModel PRIVATE
    ${FFMPEG_LIBRARIES}
)

target_compile_definitions(XlethEngineModel PRIVATE
    XLETH_DEBUG                       # enable structured debug logging to stderr
)

# ── XlethEngineCore ───────────────────────────────────────────────────────────
# CPU/D3D11 static library — no GLFW/GLEW/OpenGL anywhere. This is what the
# Node.js bridge links against, so the resulting .node DLL does NOT import
# glfw3.dll or glew32.dll, which would conflict with Electron/Chromium's GPU
# process initialisation.
#
# This used to be enforced by an XLETH_CORE_ONLY compile definition that
# compiled the GL calls out of SyncManager.cpp. That guard is gone with the GL
# path itself (Issue 10) — there is no longer any GL code to guard, in this
# target or anywhere else.
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
    src/audio/PluginLoadBreadcrumb.cpp
    src/audio/PluginEditorHost.cpp
    src/audio/EditorProcessCoordinator.cpp
    src/audio/ClipRenderCache.cpp
    src/audio/ClipModulatedReader.cpp
    src/audio/ClipVibratoIntegrator.cpp
    src/model/ClipVideoModulationTiming.cpp
    src/audio/TrackMixer.cpp
    src/audio/SourcePlayer.cpp
    src/audio/Metronome.cpp
    src/audio/MetronomeSamples.cpp
    src/audio/Sampler.cpp
    src/audio/Arpeggiator.cpp
    src/audio/SampleProcessor.cpp
    src/audio/EffectChainManager.cpp
    src/audio/SourceTransformTable.cpp
    src/audio/AudioGraph.cpp
    src/audio/GraphEffectParameters.cpp
    # Pitch Shifter stock effect. Wraps the two P1 DSP modules below
    # (GranularShifter / LiveShifterWrapper) as a stock insert effect; Clip mode
    # is a pass-through until its offline path lands.
    src/audio/XlethPitchShifterEffect.cpp
    src/audio/GuardedPluginWrapper.cpp
    src/audio/NamedAudioRing.cpp
    src/audio/WaveformMipmap.cpp
    src/dsp/DeclickEnvelope.cpp
    src/dsp/LoudnessAnalyzer.cpp
    src/dsp/LoopAnalysis.cpp
    src/dsp/LoopOptimizer.cpp
    src/dsp/AutoLoopPolicy.cpp
    src/dsp/PitchTrackAnalysis.cpp
    # AUTOTUNE renderer (P5-3): time-varying TD-PSOLA driven by a
    # CorrectionCurve. Separate from TDPSOLA.cpp below, which is a
    # constant-ratio, per-channel-independent shifter — see
    # dsp/AutotuneRender.h for why those cannot be the same function.
    src/dsp/AutotuneRender.cpp
    src/dsp/TDPSOLA.cpp
    src/dsp/RubberBandWrapper.cpp
    # Realtime pitch-shift DSP foundation (Pitch Shifter effect, P1). Both are
    # standalone modules with no engine dependencies beyond juce_audio_basics;
    # LiveShifterWrapper wraps RubberBandLiveShifter, which rubberband_static
    # already compiles.
    src/dsp/GranularShifter.cpp
    src/dsp/LiveShifterWrapper.cpp
    src/dsp/WSOLA.cpp
    src/dsp/PhaseVocoder.cpp
    src/dsp/WORLD.cpp
    # Pitch Shifter Clip mode: dry/wet lag measurement for the shifted render.
    src/dsp/DryWetAlign.cpp
    # Shared resonance detector / gain computer / spectral renderer (resonance-suppressor
    # rewrite stage 1, docs/RESONANCE_SUPPRESSOR_AUDIT.md s6). Not wired into any effect yet.
    src/dsp/ResonanceCore.cpp
    # Mono-safe pseudo-stereo side generator (xleth-spread-spec.md). Fedda is its stock-effect face.
    src/dsp/stereoize/StereoizeCore.cpp
    # Transport-locked granular reverse pitch echo (xleth-crystal-shift-research.md). Szkrezh is its stock-effect face.
    src/dsp/szkrezh/SzkrezhCore.cpp
    src/audio/WorldStretchCache.cpp
    src/audio/SlotBakeCache.cpp
    src/audio/RealtimeWorkerPool.cpp
    # Sample Sandbox offline renderer. Sits here rather than in the model tier
    # because it owns juce::AudioBuffer and a ThreadPool; the op-stack it
    # evaluates comes from XlethEngineModel.
    src/sandbox/SandboxRenderer.cpp
    src/sandbox/SandboxSpectrogram.cpp
    src/sandbox/SandboxPitchTrack.cpp
    src/video/FrameOutput.cpp
    src/video/FrameServer.cpp
    src/video/GradeFrameSampler.cpp
    src/FrameCache.cpp
    src/VideoDecoder.cpp
    src/ProxyTranscoder.cpp
    src/SyncManager.cpp
    src/project/ProjectManager.cpp
    src/project/ProxyManager.cpp
    src/export/AudioExporter.cpp
    src/export/FFmpegMuxer.cpp
    src/render/GpuDeviceManager.cpp
    src/render/FrameCache.cpp
    src/render/FrameCollector.cpp
    src/render/VisualEchoTypes.cpp
    src/render/VideoFlipApplier.cpp
    src/render/RenderVideoDecoder.cpp
    src/render/Nv12Converter.cpp
    src/render/GridCompositor.cpp
    src/render/SnapshotTransitionRenderer.cpp
    src/render/LandingRenderer.cpp
    src/render/VisualFrameDiagnostics.cpp
    src/render/HwEncoderDetector.cpp
    src/render/OfflineRenderer.cpp
    src/render/ArpVideoExpander.cpp
    src/render/VideoEventBuilder.cpp
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
    # No juce_audio_utils here — kept off the bridge link graph to prevent
    # Electron GPU process conflicts. (GL is gone from the whole tree.)
)

# MixEngine uses Timeline/Clip/TrackInfo from XlethEngineModel.
# PUBLIC so consumers of XlethEngineCore (e.g. bridge addon) get the symbols.
target_link_libraries(XlethEngineCore PUBLIC
    XlethEngineModel
)

# ── XlethPluginInspect ────────────────────────────────────────────────────────
# PE preflight for plugin binaries (P2, docs/PLUGIN_HOSTING_LOG.md): machine
# type + export names, parsed from bytes — never LoadLibrary. Pure std, no JUCE,
# so any target (scanner, tests) can link it without XlethEngineCore.
add_library(XlethPluginInspect STATIC
    src/audio/PluginBinaryInspector.cpp
)
target_include_directories(XlethPluginInspect PUBLIC
    ${CMAKE_CURRENT_SOURCE_DIR}/src
)
target_link_libraries(XlethEngineCore PUBLIC
    XlethPluginInspect
)

# ── XlethEngineHeaders ────────────────────────────────────────────────────────
# INTERFACE library: propagates only include directories and compile definitions
# to consumers (e.g. the Node.js addon) without adding any compiled sources.
# No GL headers exist in the tree, so this interface cannot pull GLFW/GLEW
# headers into consumers.
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

# ── XlethEngineService ────────────────────────────────────────────────────────
# Host-neutral orchestration and command dispatch. Keeping this in its own
# archive ensures neither Node headers nor node.lib enter the reusable service.
add_library(XlethEngineService STATIC
    src/XlethEngineService.cpp
)

target_include_directories(XlethEngineService
    PUBLIC
        ${CMAKE_CURRENT_SOURCE_DIR}/include
    PRIVATE
        ${CMAKE_CURRENT_SOURCE_DIR}/src
)

target_compile_definitions(XlethEngineService PRIVATE
    XLETH_DEBUG
)

target_link_libraries(XlethEngineService PUBLIC
    XlethEngineCore
    XlethEngineHeaders
    nlohmann_json::nlohmann_json
)

# ── Standalone executable ─────────────────────────────────────────────────────
# Developer harness only — the shipping app never spawns this; Electron forks
# addon-worker.js against xleth_native.node instead. What remains here is the
# GL-free set: --video-test, --cache-bench, --proxy-bench, and the interactive
# Phase 0 audio demo. The three OpenGL modes (--video-display, --composite-test,
# --av-sync) and VideoCompositor.cpp went with Issue 10.
juce_add_console_app(XlethEngine
    PRODUCT_NAME "Xleth Engine"
    VERSION      "0.0.1"
)

target_sources(XlethEngine PRIVATE
    src/Main.cpp
)

# JUCE_STANDALONE_APPLICATION activates START_JUCE_APPLICATION/main() synthesis.
# Must ONLY appear on the executable, never on the library or addon.
target_compile_definitions(XlethEngine PRIVATE
    JUCE_STANDALONE_APPLICATION=1
)

target_link_libraries(XlethEngine PRIVATE
    XlethEngineCore
    XlethEngineHeaders
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

# ── test_landing ──────────────────────────────────────────────────────────────
# Landing model + resolver (docs/XLETH_LANDING_SPEC.md): normalize, JSON, cue
# CRUD, landingsAt windows and skips, From rects, the seam, Reflow. Model-only,
# like test_timeline — the resolver and LandingMath.h need no GPU.
add_executable(test_landing
    test/test_landing.cpp
)

target_link_libraries(test_landing PRIVATE
    XlethEngineModel
)

# RenderClock.h pulls in libavutil headers (the seam test converts ticks to
# samples exactly as the render path does).
target_include_directories(test_landing PRIVATE
    ${FFMPEG_INCLUDE_DIRS}
)

# ── test_grid_rect_math ───────────────────────────────────────────────────────
# Rect parity for render/GridRectMath.h (Landing spec §6.1): the promoted
# slot -> canvas rect function against a frozen copy of the compositor's old
# arithmetic, bit for bit, across every grid size, placement and gap. Header-
# only maths; links the model tier only for TimelineTypes.h's include path.
add_executable(test_grid_rect_math
    test/test_grid_rect_math.cpp
)

target_link_libraries(test_grid_rect_math PRIVATE
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

# RenderClock.h pulls in libavutil headers (the seam-rounding test asserts the
# loop bounds and the pattern-note dispatch share one tick->sample domain).
target_include_directories(test_loop_region PRIVATE
    ${FFMPEG_INCLUDE_DIRS}
)

# ── test_metronome ────────────────────────────────────────────────────────────
# Click-track beat grid / bar accent / +3 st resampling. Pure std — no JUCE.
add_executable(test_metronome
    test/test_metronome.cpp
    src/audio/Metronome.cpp
    src/audio/MetronomeSamples.cpp
)

target_include_directories(test_metronome PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/src
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

# ── test_effect_chain_commands ────────────────────────────────────────────────
# LoadEffectChainCommand: the single undoable step behind an FX Chain Library
# load / drag-drop. The command takes its chain swap as an injected callable, so
# this is model-only — the MixEngine wiring is exercised through the RPC layer.
add_executable(test_effect_chain_commands
    test/test_effect_chain_commands.cpp
)

target_link_libraries(test_effect_chain_commands PRIVATE
    XlethEngineModel
)

# ── test_envelope_parameter_modulation ────────────────────────────────────────
# Pure evaluator for the FX Graph Envelope Controller as a graph-owned parameter
# modulation source: graphState parse, gate-region merge, closed-form ADSR, and
# the base + signed-depth mapping. Model-only — links solely against
# XlethEngineModel. The MixEngine integration is covered by test_mix.
add_executable(test_envelope_parameter_modulation
    test/test_envelope_parameter_modulation.cpp
)

target_link_libraries(test_envelope_parameter_modulation PRIVATE
    XlethEngineModel
)

# ── test_lfo_parameter_modulation ─────────────────────────────────────────────
# Pure evaluator for the FX Graph LFO Modulator as a graph-owned parameter
# modulation source: graphState parse, tempo-sync/free rate, waveform evaluation,
# position purity, and the base + signed-depth mapping. Model-only — links
# solely against XlethEngineModel. The MixEngine integration is covered by
# test_lfo_modulation_engine.
add_executable(test_lfo_parameter_modulation
    test/test_lfo_parameter_modulation.cpp
)

target_link_libraries(test_lfo_parameter_modulation PRIVATE
    XlethEngineModel
)

# ── test_render_clock ─────────────────────────────────────────────────────────
# The shared sample <-> tick <-> beat clock (render/RenderClock.h) that every
# engine timing conversion now goes through. Pure arithmetic, model-only:
# RenderClock lives in XlethEngineModel so AutomationPlan can share it.
add_executable(test_render_clock
    test/test_render_clock.cpp
)

target_link_libraries(test_render_clock PRIVATE
    XlethEngineModel
)

target_include_directories(test_render_clock PRIVATE
    ${FFMPEG_INCLUDE_DIRS}
)

# ── test_automation_clips ─────────────────────────────────────────
# Automation clip engine + model (Phase A): point invariants, tick-absolute
# envelope evaluation, plan build/overlap resolution, undo commands, the effect
# deletion contract and serialization. Model-only — links solely against
# XlethEngineModel. The MixEngine integration is exercised through the bridge
# smoke test (bridge/test_automation_clips_bridge.js).
add_executable(test_automation_clips
    test/test_automation_clips.cpp
)

target_link_libraries(test_automation_clips PRIVATE
    XlethEngineModel
)

# ── test_sandbox ──────────────────────────────────────────────────────────────
# Sample Sandbox engine core (SB-1): the typed op-stack model, its JSON
# round-trip, the undo commands for every stack mutation, and the offline
# SandboxRenderer — including the headline property, that editing op k of an
# N-op stack re-renders only ops k..N.
#
# Links Core as well as Model because SandboxRenderer owns juce::AudioBuffer.
# Offline throughout: no audio device is opened.
add_executable(test_sandbox
    test/test_sandbox.cpp
)

target_link_libraries(test_sandbox PRIVATE
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

# ── test_correction_curve ────────────────────────────────────────────────────
# AUTOTUNE correction curve (P5-2): scale/key tables, quantization, the
# jumpiness-hold/retune-speed/smoothness state machine, and the Preserve
# Vibrato low-pass split. Pure math — no JUCE, no FFmpeg, no GL. Links only
# XlethEngineModel (dsp/CorrectionCurve.cpp lives there; PitchFrame/NoteSegment
# come along for free as plain structs from dsp/PitchTrackAnalysis.h).
add_executable(test_correction_curve
    test/test_correction_curve.cpp
)

target_link_libraries(test_correction_curve PRIVATE
    XlethEngineModel
)

# ── test_autotune_render ──────────────────────────────────────────────────────
# The AUTOTUNE renderer (P5-3): TD-PSOLA resynthesis onto a CorrectionCurve.
# Needs XlethEngineCore (dsp/AutotuneRender.cpp + the JUCE-using NSDF detector
# in dsp/PitchTrackAnalysis.cpp) as well as XlethEngineModel (the correction
# math). juce_audio_formats is for the OPTIONAL listening-QA pass: pass a WAV
# path on argv[1] and it renders both deliverable settings out for a listen.
# The automated run takes no arguments and touches no files.
add_executable(test_autotune_render
    test/test_autotune_render.cpp
)

target_link_libraries(test_autotune_render PRIVATE
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

# ── test_canvas_fit ───────────────────────────────────────────────────────────
# Pure geometry for crop/stretch/letterbox of the project canvas into an export
# of a different aspect ratio (render/CanvasFit.h). Header-only, no GPU — links
# nothing but is given XlethEngineModel for a uniform test target shape.
add_executable(test_canvas_fit
    test/test_canvas_fit.cpp
)

target_link_libraries(test_canvas_fit PRIVATE
    XlethEngineModel
)

# ── test_presentation_clock_smoother ─────────────────────────────────────────
# The preview's continuous audio clock (render/PresentationClockSmoother.h):
# header-only arithmetic, driven with synthetic callback staircases.
add_executable(test_presentation_clock_smoother
    test/test_presentation_clock_smoother.cpp
)

target_link_libraries(test_presentation_clock_smoother PRIVATE
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

# ── test_video_event_builder ─────────────────────────────────────────────────
# The one timeline -> VideoEvent builder shared by live preview and export:
# note clamp at the block end, no loop wrap with looping off, slide events,
# clip anchoring, and export == preview.
add_executable(test_video_event_builder
    test/test_video_event_builder.cpp
)

target_link_libraries(test_video_event_builder PRIVATE
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

target_compile_definitions(test_video_event_builder PRIVATE
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

# ── test_regenerable_files ────────────────────────────────────────────────────
# Safety contract of the regenerable-file registry (purge-on-close, Clean up
# project, on-open .tmp sweep): only recognised files go, offline-media proxies
# are retained, source media / project.json are never touched.
# No JUCE, no FFmpeg, no GL — pure model + filesystem.
add_executable(test_regenerable_files
    test/test_regenerable_files.cpp
)

target_link_libraries(test_regenerable_files PRIVATE
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

# ── test_sidechain_routes ─────────────────────────────────────────────────────
# Prompt 4B: persistent/validated/undoable sidechain route model. Pure model +
# commands + TrackRouting validation — no JUCE, no FFmpeg, no GL, no MixEngine.
add_executable(test_sidechain_routes
    test/test_sidechain_routes.cpp
)

target_link_libraries(test_sidechain_routes PRIVATE
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
# Phase E.3: shared ClipCompanionFxSnapshot builder feeding FrameCollector →
# GridCompositor, which is now the single compositing path for both preview and
# export. Verifies gating + signed propagation. Model-only — no JUCE or FFmpeg.
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

# ── test_envelope_modulation_engine ──────────────────────────────────────────
# MixEngine-level tests for the FX Graph Envelope Controller → parameter
# modulation path: authoritative gate derivation from the Timeline, snapshot
# construction (graph mode / mute / solo), and the audio-thread published values
# across play-start, loop wrap, seek and stop. Same link/stack shape as test_mix.
add_executable(test_envelope_modulation_engine
    test/test_envelope_modulation_engine.cpp
)

target_link_libraries(test_envelope_modulation_engine PRIVATE
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

target_compile_definitions(test_envelope_modulation_engine PRIVATE
    JUCE_GLOBAL_MODULE_SETTINGS_INCLUDED=1
    JUCE_USE_CURL=0
    JUCE_WEB_BROWSER=0
    JUCE_MODAL_LOOPS_PERMITTED=1
    JUCE_DIRECTSOUND=0
    JUCE_USE_WINDOWS_MEDIA_FORMAT=0
    JUCE_STANDALONE_APPLICATION=1
)

target_link_options(test_envelope_modulation_engine PRIVATE /STACK:8388608)

# ── test_lfo_modulation_engine ────────────────────────────────────────────────
# MixEngine-level tests for the FX Graph LFO Modulator → parameter modulation
# path: snapshot construction (graph mode / chain mode), audio-thread published
# values across play-start/oscillation, the stop and mute/solo "go inert"
# behaviors, and the RCU concurrent snapshot-swap stress test. Same link/stack
# shape as test_envelope_modulation_engine.
add_executable(test_lfo_modulation_engine
    test/test_lfo_modulation_engine.cpp
)

target_link_libraries(test_lfo_modulation_engine PRIVATE
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

target_compile_definitions(test_lfo_modulation_engine PRIVATE
    JUCE_GLOBAL_MODULE_SETTINGS_INCLUDED=1
    JUCE_USE_CURL=0
    JUCE_WEB_BROWSER=0
    JUCE_MODAL_LOOPS_PERMITTED=1
    JUCE_DIRECTSOUND=0
    JUCE_USE_WINDOWS_MEDIA_FORMAT=0
    JUCE_STANDALONE_APPLICATION=1
)

target_link_options(test_lfo_modulation_engine PRIVATE /STACK:8388608)

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

# ── test_sidechain_runtime ───────────────────────────────────────────────────
# Prompt 4C+4D: runtime silent sidechain key transport + SidechainSourceProcessor
# injection groundwork. Drives MixEngine::processBlock with a test-only
# sidechain-capable receiver to prove key delivery, silence guarantees, gain /
# pre-fader / disabled / muted / stale behaviour, and solo feedsSidechainOnly.
# Requires JUCE audio_processors (AudioProcessor-based test receiver).
add_executable(test_sidechain_runtime
    test/test_sidechain_runtime.cpp
)

target_link_libraries(test_sidechain_runtime PRIVATE
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

target_compile_definitions(test_sidechain_runtime PRIVATE
    JUCE_GLOBAL_MODULE_SETTINGS_INCLUDED=1
    JUCE_USE_CURL=0
    JUCE_WEB_BROWSER=0
    JUCE_MODAL_LOOPS_PERMITTED=1
    JUCE_DIRECTSOUND=0
    JUCE_USE_WINDOWS_MEDIA_FORMAT=0
    JUCE_STANDALONE_APPLICATION=1
)

target_link_options(test_sidechain_runtime PRIVATE /STACK:8388608)

# ── test_stock_compressor_sidechain ──────────────────────────────────────────
# Prompt 5A: stock XlethCompressorEffect external sidechain consumption. Drives
# MixEngine::processBlock with the REAL stock compressor and a sidechain route to
# prove external-key ducking, sc_external=0 legacy behavior, silence-on-no-key,
# per-instance targeting, gain scaling, multi-source summing, and bypass/no-leak.
add_executable(test_stock_compressor_sidechain
    test/test_stock_compressor_sidechain.cpp
)

target_link_libraries(test_stock_compressor_sidechain PRIVATE
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

target_compile_definitions(test_stock_compressor_sidechain PRIVATE
    JUCE_GLOBAL_MODULE_SETTINGS_INCLUDED=1
    JUCE_USE_CURL=0
    JUCE_WEB_BROWSER=0
    JUCE_MODAL_LOOPS_PERMITTED=1
    JUCE_DIRECTSOUND=0
    JUCE_USE_WINDOWS_MEDIA_FORMAT=0
    JUCE_STANDALONE_APPLICATION=1
)

target_link_options(test_stock_compressor_sidechain PRIVATE /STACK:8388608)

# ── test_vst_sidechain ───────────────────────────────────────────────────────
# VST-SC.2: GuardedPluginWrapper bus mirroring + session-only sidechain
# capability probing, proven with FAKE plugins (no real VST3 dependency). Drives
# AudioGraph + GuardedPluginWrapper directly to prove capability probing, bus
# mirroring, key delivery on bus 1 only, no main-output leakage, crash
# passthrough, layout-rejecting fallback, and that capability is never persisted.
add_executable(test_vst_sidechain
    test/test_vst_sidechain.cpp
)

target_link_libraries(test_vst_sidechain PRIVATE
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

target_compile_definitions(test_vst_sidechain PRIVATE
    JUCE_GLOBAL_MODULE_SETTINGS_INCLUDED=1
    JUCE_USE_CURL=0
    JUCE_WEB_BROWSER=0
    JUCE_MODAL_LOOPS_PERMITTED=1
    JUCE_DIRECTSOUND=0
    JUCE_USE_WINDOWS_MEDIA_FORMAT=0
    JUCE_STANDALONE_APPLICATION=1
)

target_link_options(test_vst_sidechain PRIVATE /STACK:8388608)

# ── test_fxgraph_sidechain_input ─────────────────────────────────────────────
# Prompt 6C: FX Graph Sidechain Input binds to the EXISTING sidechain route/key
# transport. Drives MixEngine::processBlock with a GRAPH-OWNED stock compressor
# (addGraphEffectNode + syncGraphTopology) and a route targeting it by stable
# effectInstanceId to prove external-key ducking, no key leakage, wrong-instance /
# non-compressor no-ops, and sc_external=0 legacy behavior — all through the
# proven native stack (no second sidechain engine).
add_executable(test_fxgraph_sidechain_input
    test/test_fxgraph_sidechain_input.cpp
)

target_link_libraries(test_fxgraph_sidechain_input PRIVATE
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

target_compile_definitions(test_fxgraph_sidechain_input PRIVATE
    JUCE_GLOBAL_MODULE_SETTINGS_INCLUDED=1
    JUCE_USE_CURL=0
    JUCE_WEB_BROWSER=0
    JUCE_MODAL_LOOPS_PERMITTED=1
    JUCE_DIRECTSOUND=0
    JUCE_USE_WINDOWS_MEDIA_FORMAT=0
    JUCE_STANDALONE_APPLICATION=1
)

target_link_options(test_fxgraph_sidechain_input PRIVATE /STACK:8388608)

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

# ── xleth_rs_quality_bench ───────────────────────────────────────────────────
# Offline quality bench for the resonance suppressors (RS LL / HQ x3, EQ
# Spectral): latency, transparency, suppression accuracy, musical-noise jitter,
# pre-echo, block-size dependence, CPU; writes CSV + summary.md + listening WAVs
# under bench_out/. Tool-only (not a ctest); run from the repo root with a
# Release build. Console prefix: [RSBench]. See docs/RESONANCE_SUPPRESSOR_AUDIT.md s4.
add_executable(xleth_rs_quality_bench
    tools/xleth_rs_quality_bench.cpp
)

target_link_libraries(xleth_rs_quality_bench PRIVATE
    XlethEngineCore
    XlethEngineModel
    juce::juce_core
    juce::juce_audio_basics
    juce::juce_audio_formats
    juce::juce_audio_processors
    juce::juce_dsp
    juce::juce_events
    juce::juce_gui_basics
    juce::juce_recommended_config_flags
    juce::juce_recommended_warning_flags
)

target_include_directories(xleth_rs_quality_bench PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/src
)

target_compile_definitions(xleth_rs_quality_bench PRIVATE
    JUCE_GLOBAL_MODULE_SETTINGS_INCLUDED=1
    JUCE_USE_CURL=0
    JUCE_WEB_BROWSER=0
    JUCE_MODAL_LOOPS_PERMITTED=1
    JUCE_DIRECTSOUND=0
    JUCE_USE_WINDOWS_MEDIA_FORMAT=0
    JUCE_STANDALONE_APPLICATION=1
    NOMINMAX
)

target_link_options(xleth_rs_quality_bench PRIVATE /STACK:33554432)

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

# ── test_sampler_preview_route ───────────────────────────────────────────────
# Which track's effect rack an auditioned sample is heard through: dedicated
# track detection, shared-bus fallback, and the mode switch. Header-only logic —
# links nothing. The MixEngine render integration is exercised by test_mix.
add_executable(test_sampler_preview_route
    test/test_sampler_preview_route.cpp
)

target_include_directories(test_sampler_preview_route PRIVATE src)

# ── test_sampler_legacy_migration ────────────────────────────────────────────
# Schema 3 → 4 migration of the hardcoded pitch envelope and the three drawable
# LFOs into the general route list, plus the voicing cap and the bipolar ring
# math the routing UI draws against.
add_executable(test_sampler_legacy_migration
    test/test_sampler_legacy_migration.cpp
)

target_link_libraries(test_sampler_legacy_migration PRIVATE
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

target_compile_definitions(test_sampler_legacy_migration PRIVATE
    JUCE_GLOBAL_MODULE_SETTINGS_INCLUDED=1
    JUCE_USE_CURL=0
    JUCE_WEB_BROWSER=0
    JUCE_MODAL_LOOPS_PERMITTED=1
    JUCE_DIRECTSOUND=0
    JUCE_USE_WINDOWS_MEDIA_FORMAT=0
    JUCE_STANDALONE_APPLICATION=1
)

# ── test_sample_bank_batch ───────────────────────────────────────────────────
# SampleBank::loadSamplesFromSources (the parallel region-audio loader project
# load uses) against one-at-a-time loadSampleFromSource: same ids, same PCM bit
# for bit, at every thread count, with failing requests in the mix. Set
# XLETH_TEST_MEDIA (+ XLETH_TEST_MEDIA_SECONDS) to also run it on a real
# compressed file. Output prefix: [SampleBankBatch].
add_executable(test_sample_bank_batch
    test/test_sample_bank_batch.cpp
)

target_link_libraries(test_sample_bank_batch PRIVATE
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

target_include_directories(test_sample_bank_batch PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/src
)

target_compile_definitions(test_sample_bank_batch PRIVATE
    JUCE_GLOBAL_MODULE_SETTINGS_INCLUDED=1
    JUCE_USE_CURL=0
    JUCE_WEB_BROWSER=0
    JUCE_MODAL_LOOPS_PERMITTED=1
    JUCE_DIRECTSOUND=0
    JUCE_USE_WINDOWS_MEDIA_FORMAT=0
    JUCE_STANDALONE_APPLICATION=1
)

add_test(NAME test_sample_bank_batch COMMAND test_sample_bank_batch)

# ── test_sampler_modulation ──────────────────────────────────────────────────
# The modulation system: 6 envelopes, 6 LFOs, VELO/NOTE response curves and the
# route graph. Exercises the pure evaluators in SamplerModulation.h directly
# (timing, shape, graph ordering, cycle latency) AND a real Sampler rendering
# audio, plus the JSON schema round trip.
add_executable(test_sampler_modulation
    test/test_sampler_modulation.cpp
)

target_link_libraries(test_sampler_modulation PRIVATE
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

target_compile_definitions(test_sampler_modulation PRIVATE
    JUCE_GLOBAL_MODULE_SETTINGS_INCLUDED=1
    JUCE_USE_CURL=0
    JUCE_WEB_BROWSER=0
    JUCE_MODAL_LOOPS_PERMITTED=1
    JUCE_DIRECTSOUND=0
    JUCE_USE_WINDOWS_MEDIA_FORMAT=0
    JUCE_STANDALONE_APPLICATION=1
)

# ── test_mangle ──────────────────────────────────────────────────────────────
# MANGLE, the per-note per-slot warp FX: the pure shapers and read-head planner
# in MangleDsp.h driven directly, plus the per-note claim asserted through a
# real Sampler (chord == sum of independently mangled notes).
add_executable(test_mangle
    test/test_mangle.cpp
)

target_link_libraries(test_mangle PRIVATE
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

target_compile_definitions(test_mangle PRIVATE
    JUCE_GLOBAL_MODULE_SETTINGS_INCLUDED=1
    JUCE_USE_CURL=0
    JUCE_WEB_BROWSER=0
    JUCE_MODAL_LOOPS_PERMITTED=1
    JUCE_DIRECTSOUND=0
    JUCE_USE_WINDOWS_MEDIA_FORMAT=0
    JUCE_STANDALONE_APPLICATION=1
)

# ── test_slot_prep ───────────────────────────────────────────────────────────
# Per-slot PREP: SlotBakeCache determinism / disk tier / rebuild-on-missing-file,
# and the Sampler's three loop modes plus exit-loop-on-release. Sampler and cache
# are exercised directly — no Timeline / MixEngine.
add_executable(test_slot_prep
    test/test_slot_prep.cpp
)

target_link_libraries(test_slot_prep PRIVATE
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

target_compile_definitions(test_slot_prep PRIVATE
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

# ── test_tdpsola ─────────────────────────────────────────────────────────────
# Pins TDPSOLA time-stretch output against a baseline captured before the
# LoopAnalysis.h extraction, so that refactor is provably behaviour-preserving.
add_executable(test_tdpsola
    test/test_tdpsola.cpp
)

target_link_libraries(test_tdpsola PRIVATE
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

target_compile_definitions(test_tdpsola PRIVATE
    _CRT_SECURE_NO_WARNINGS=1
    JUCE_GLOBAL_MODULE_SETTINGS_INCLUDED=1
    JUCE_USE_CURL=0
    JUCE_WEB_BROWSER=0
    JUCE_MODAL_LOOPS_PERMITTED=1
    JUCE_DIRECTSOUND=0
    JUCE_USE_WINDOWS_MEDIA_FORMAT=0
    JUCE_STANDALONE_APPLICATION=1
)

# ── test_pitch_shift_dsp ─────────────────────────────────────────────────────
# Realtime pitch-shift DSP foundation (Pitch Shifter P1): dsp/GranularShifter
# and dsp/LiveShifterWrapper. Covers spectral quality, click freedom, the
# LATENCY INVARIANCE requirement (constant across +/-24 st and the whole grain
# size range), and zero allocation in both process() calls.
add_executable(test_pitch_shift_dsp
    test/test_pitch_shift_dsp.cpp
)

target_link_libraries(test_pitch_shift_dsp PRIVATE
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

target_compile_definitions(test_pitch_shift_dsp PRIVATE
    _CRT_SECURE_NO_WARNINGS=1
    JUCE_GLOBAL_MODULE_SETTINGS_INCLUDED=1
    JUCE_USE_CURL=0
    JUCE_WEB_BROWSER=0
    JUCE_MODAL_LOOPS_PERMITTED=1
    JUCE_DIRECTSOUND=0
    JUCE_USE_WINDOWS_MEDIA_FORMAT=0
    JUCE_STANDALONE_APPLICATION=1
)

# ── test_loop_analysis ───────────────────────────────────────────────────────
# Unit-tests the seam-similarity primitives in dsp/LoopAnalysis.h (NCC, phase-
# alignment search, spectral distance) against synthetic signals with known
# closed-form answers. These feed the Auto Loop Optimizer's cost function.
add_executable(test_loop_analysis
    test/test_loop_analysis.cpp
)

target_link_libraries(test_loop_analysis PRIVATE
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

target_compile_definitions(test_loop_analysis PRIVATE
    _CRT_SECURE_NO_WARNINGS=1
    JUCE_GLOBAL_MODULE_SETTINGS_INCLUDED=1
    JUCE_USE_CURL=0
    JUCE_WEB_BROWSER=0
    JUCE_MODAL_LOOPS_PERMITTED=1
    JUCE_DIRECTSOUND=0
    JUCE_USE_WINDOWS_MEDIA_FORMAT=0
    JUCE_STANDALONE_APPLICATION=1
)

# ── test_loop_optimizer ──────────────────────────────────────────────────────
# Unit-tests the Auto Loop Optimizer's steady-state window detection and loop-
# candidate generation (dsp/LoopOptimizer.h) against synthetic signals with known
# correct answers. This is the highest-risk phase in the feature, so the cases
# assert real numeric answers (true period within a sample, k=1 seam ≈ 1, no
# harmonic lock on additive tones) rather than pinning a captured baseline.
#
# The same executable doubles as a standalone diagnostic: run with a path to a
# mono 16-bit WAV as argv[1] and it prints the detected window, period and every
# candidate to stdout instead of running the unit tests. That mode is a real-
# material sanity tool, not a pass/fail gate.
add_executable(test_loop_optimizer
    test/test_loop_optimizer.cpp
)

target_link_libraries(test_loop_optimizer PRIVATE
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

target_compile_definitions(test_loop_optimizer PRIVATE
    _CRT_SECURE_NO_WARNINGS=1
    JUCE_GLOBAL_MODULE_SETTINGS_INCLUDED=1
    JUCE_USE_CURL=0
    JUCE_WEB_BROWSER=0
    JUCE_MODAL_LOOPS_PERMITTED=1
    JUCE_DIRECTSOUND=0
    JUCE_USE_WINDOWS_MEDIA_FORMAT=0
    JUCE_STANDALONE_APPLICATION=1
)

# ── test_auto_loop_policy ─────────────────────────────────────────────────────
# Unit-tests the selection-first AUTO loop policy (dsp/AutoLoopPolicy.h), the C++
# port of loop_optimizer's policy v2. Doubles as the parity/diagnostic CLI: given
# a raw float32 mono buffer + selection it prints the chosen loop as JSON (see the
# file header). The buffer-in-JSON-out shape is what the Python parity harness
# drives to compare C++ output against the reference optimizer sample-for-sample.
add_executable(test_auto_loop_policy
    test/test_auto_loop_policy.cpp
)

target_link_libraries(test_auto_loop_policy PRIVATE
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

target_compile_definitions(test_auto_loop_policy PRIVATE
    _CRT_SECURE_NO_WARNINGS=1
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

# ── test_pitch_shifter_effect ────────────────────────────────────────────────
# The Pitch Shifter STOCK EFFECT (P2) that wraps the P1 DSP modules. Covers
# latency conformance per mode, the smoothed +/-24 st sweep that justifies
# routing pitch through the base class smoother, mode-switch PDC, zero
# allocation in processBlock, and Clip's sample-exact pass-through.
add_executable(test_pitch_shifter_effect
    test/test_pitch_shifter_effect.cpp
)

target_link_libraries(test_pitch_shifter_effect PRIVATE
    XlethEngineCore
    XlethEngineModel
    juce::juce_core
    juce::juce_audio_basics
    juce::juce_audio_formats
    juce::juce_audio_processors
    juce::juce_dsp
    juce::juce_events
    juce::juce_gui_basics
    juce::juce_recommended_config_flags
    juce::juce_recommended_warning_flags
)

target_compile_definitions(test_pitch_shifter_effect PRIVATE
    _CRT_SECURE_NO_WARNINGS=1
    JUCE_GLOBAL_MODULE_SETTINGS_INCLUDED=1
    JUCE_USE_CURL=0
    JUCE_WEB_BROWSER=0
    JUCE_MODAL_LOOPS_PERMITTED=1
    JUCE_DIRECTSOUND=0
    JUCE_USE_WINDOWS_MEDIA_FORMAT=0
    JUCE_STANDALONE_APPLICATION=1
)

# ── test_clip_fx_transform ──────────────────────────────────────────────────────────
# Pitch Shifter Clip mode (mode 4) for audio clips: CacheKey fx lane, dual
# lookup + Mix blend in the MixEngine clip loop (Mix 0 golden-hashed against the
# pre-change engine), dry/wet alignment + no-notch, settle debounce, LRU cap and
# retirement, allocation-free blend, export parity.
add_executable(test_clip_fx_transform
    test/test_clip_fx_transform.cpp
)

target_link_libraries(test_clip_fx_transform PRIVATE
    XlethEngineCore
    XlethEngineModel
    juce::juce_core
    juce::juce_audio_basics
    juce::juce_audio_formats
    juce::juce_audio_processors
    juce::juce_dsp
    juce::juce_events
    juce::juce_gui_basics
    juce::juce_recommended_config_flags
    juce::juce_recommended_warning_flags
)

target_compile_definitions(test_clip_fx_transform PRIVATE
    _CRT_SECURE_NO_WARNINGS=1
    JUCE_GLOBAL_MODULE_SETTINGS_INCLUDED=1
    JUCE_USE_CURL=0
    JUCE_WEB_BROWSER=0
    JUCE_MODAL_LOOPS_PERMITTED=1
    JUCE_DIRECTSOUND=0
    JUCE_USE_WINDOWS_MEDIA_FORMAT=0
    JUCE_STANDALONE_APPLICATION=1
)

target_link_options(test_clip_fx_transform PRIVATE /STACK:8388608)

# ── test_pattern_fx_transpose ────────────────────────────────────────────────
# Pitch Shifter Clip mode (mode 4) on PATTERN tracks: Sampler voice-spawn
# transpose from the per-block transform table. Measured fundamental per
# semis/cents, voice pairing (mono, slides, mid-phrase table changes), video
# event gate, Pattern.notes/undo untouched, differential allocation count.
add_executable(test_pattern_fx_transpose
    test/test_pattern_fx_transpose.cpp
)

target_link_libraries(test_pattern_fx_transpose PRIVATE
    XlethEngineCore
    XlethEngineModel
    juce::juce_core
    juce::juce_audio_basics
    juce::juce_audio_formats
    juce::juce_audio_processors
    juce::juce_dsp
    juce::juce_events
    juce::juce_gui_basics
    juce::juce_recommended_config_flags
    juce::juce_recommended_warning_flags
)

target_compile_definitions(test_pattern_fx_transpose PRIVATE
    _CRT_SECURE_NO_WARNINGS=1
    JUCE_GLOBAL_MODULE_SETTINGS_INCLUDED=1
    JUCE_USE_CURL=0
    JUCE_WEB_BROWSER=0
    JUCE_MODAL_LOOPS_PERMITTED=1
    JUCE_DIRECTSOUND=0
    JUCE_USE_WINDOWS_MEDIA_FORMAT=0
    JUCE_STANDALONE_APPLICATION=1
)

target_link_options(test_pattern_fx_transpose PRIVATE /STACK:8388608)

# ── test_clip_fx_perf_gate ───────────────────────────────────────────────────
# Pitch Shifter Clip mode (mode 4): permanent perf regression gate. 64-clip
# track semitone sweep bounded on job count AND peak RSS delta; 100-clip
# session differential zero-allocation check on the audio path. See the file
# header for the bound justifications.
add_executable(test_clip_fx_perf_gate
    test/test_clip_fx_perf_gate.cpp
)

target_link_libraries(test_clip_fx_perf_gate PRIVATE
    XlethEngineCore
    XlethEngineModel
    juce::juce_core
    juce::juce_audio_basics
    juce::juce_audio_formats
    juce::juce_audio_processors
    juce::juce_dsp
    juce::juce_events
    juce::juce_gui_basics
    juce::juce_recommended_config_flags
    juce::juce_recommended_warning_flags
)

if (WIN32)
    target_link_libraries(test_clip_fx_perf_gate PRIVATE Psapi.lib)
endif()

target_compile_definitions(test_clip_fx_perf_gate PRIVATE
    _CRT_SECURE_NO_WARNINGS=1
    JUCE_GLOBAL_MODULE_SETTINGS_INCLUDED=1
    JUCE_USE_CURL=0
    JUCE_WEB_BROWSER=0
    JUCE_MODAL_LOOPS_PERMITTED=1
    JUCE_DIRECTSOUND=0
    JUCE_USE_WINDOWS_MEDIA_FORMAT=0
    JUCE_STANDALONE_APPLICATION=1
)

target_link_options(test_clip_fx_perf_gate PRIVATE /STACK:8388608)

# ── test_source_transform_table ──────────────────────────────────────────────
# Pitch Shifter Clip mode plumbing: SourceTransform capability, the pure
# per-track table builder (last-in-chain-order wins, track chains only, bypass
# and removal clear), and MixEngine's epoch-driven lock-free publisher
# (unchanged poll = no republish and no allocation; one bump = one republish).
add_executable(test_source_transform_table
    test/test_source_transform_table.cpp
)

target_link_libraries(test_source_transform_table PRIVATE
    XlethEngineCore
    XlethEngineModel
    juce::juce_core
    juce::juce_audio_basics
    juce::juce_audio_formats
    juce::juce_audio_processors
    juce::juce_dsp
    juce::juce_events
    juce::juce_gui_basics
    juce::juce_recommended_config_flags
    juce::juce_recommended_warning_flags
)

target_compile_definitions(test_source_transform_table PRIVATE
    _CRT_SECURE_NO_WARNINGS=1
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

# ── test_chain_snapshot_lockfree ─────────────────────────────────────────────
# RENDER_PERF_AUDIT Finding 9: the realtime audio thread must read effect chains
# through the immutable ChainSnapshot instead of try_lock'ing chainsMutex_, so a
# contended lock can no longer drop a whole block of effects. Also pins the
# nonRealtime_ blocking branch, which an offline export depends on.
add_executable(test_chain_snapshot_lockfree
    test/test_chain_snapshot_lockfree.cpp
)

target_link_libraries(test_chain_snapshot_lockfree PRIVATE
    XlethEngineCore
    XlethEngineModel
    juce::juce_core
    juce::juce_audio_basics
    juce::juce_audio_formats
    juce::juce_audio_processors
    juce::juce_dsp
    juce::juce_events
    juce::juce_gui_basics
    juce::juce_recommended_config_flags
    juce::juce_recommended_warning_flags
)

target_compile_definitions(test_chain_snapshot_lockfree PRIVATE
    JUCE_GLOBAL_MODULE_SETTINGS_INCLUDED=1
    JUCE_USE_CURL=0
    JUCE_WEB_BROWSER=0
    JUCE_MODAL_LOOPS_PERMITTED=1
    JUCE_DIRECTSOUND=0
    JUCE_USE_WINDOWS_MEDIA_FORMAT=0
    JUCE_STANDALONE_APPLICATION=1
)

add_test(NAME test_chain_snapshot_lockfree COMMAND test_chain_snapshot_lockfree)

# ── test_plugin_binary_inspector ─────────────────────────────────────────────
# PE preflight parser: System32 x64 DLL, SysWOW64 x86 DLL, text renamed .dll,
# truncated DLL, VST3 bundle resolution. Pure std — no JUCE, no FFmpeg.
add_executable(test_plugin_binary_inspector
    test/test_plugin_binary_inspector.cpp
)
target_link_libraries(test_plugin_binary_inspector PRIVATE
    XlethPluginInspect
)
add_test(NAME test_plugin_binary_inspector COMMAND test_plugin_binary_inspector)
add_test(NAME test_metronome COMMAND test_metronome)

# ── test_effect_audio_thread_reset ──────────────────────────────────────────
# A live transport jump resets effect chains ON THE AUDIO THREAD, in the block
# that clears the PDC delay lines, via XlethEffectBase::resetOnAudioThread().
# Holds every stock effect to that contract (zero allocations, bounded time),
# and the Pitch Shifter to declining when its spare is not primed.
add_executable(test_effect_audio_thread_reset
    test/test_effect_audio_thread_reset.cpp
)

target_link_libraries(test_effect_audio_thread_reset PRIVATE
    XlethEngineCore
    XlethEngineModel
    juce::juce_core
    juce::juce_audio_basics
    juce::juce_audio_formats
    juce::juce_audio_processors
    juce::juce_dsp
    juce::juce_events
    juce::juce_gui_basics
    juce::juce_recommended_config_flags
    juce::juce_recommended_warning_flags
)

target_compile_definitions(test_effect_audio_thread_reset PRIVATE
    JUCE_GLOBAL_MODULE_SETTINGS_INCLUDED=1
    JUCE_USE_CURL=0
    JUCE_WEB_BROWSER=0
    JUCE_MODAL_LOOPS_PERMITTED=1
    JUCE_DIRECTSOUND=0
    JUCE_USE_WINDOWS_MEDIA_FORMAT=0
    JUCE_STANDALONE_APPLICATION=1
)

add_test(NAME test_effect_audio_thread_reset COMMAND test_effect_audio_thread_reset)

# ── test_effect_processblock_alloc ──────────────────────────────────────────
# Resonance-suppressor rewrite P0 (docs/RESONANCE_SUPPRESSOR_AUDIT.md RT10):
# counts operator new around processBlock() for RS Low Latency (static and
# parameter-sweep cases), RS High Quality (Normal) and EQ Spectral; all assert
# zero. Also the Low Latency null test against fixtures captured from the
# pre-P1a implementation (test/fixtures/rs_ll, via XLETH_RS_LL_FIXTURE_DIR).
# Output prefix: [RSLLAlloc].
add_executable(test_effect_processblock_alloc
    test/test_effect_processblock_alloc.cpp
)

target_link_libraries(test_effect_processblock_alloc PRIVATE
    XlethEngineCore
    XlethEngineModel
    juce::juce_core
    juce::juce_audio_basics
    juce::juce_audio_formats
    juce::juce_audio_processors
    juce::juce_dsp
    juce::juce_events
    juce::juce_gui_basics
    juce::juce_recommended_config_flags
    juce::juce_recommended_warning_flags
)

target_compile_definitions(test_effect_processblock_alloc PRIVATE
    XLETH_RS_LL_FIXTURE_DIR="${CMAKE_CURRENT_SOURCE_DIR}/test/fixtures/rs_ll"
    JUCE_GLOBAL_MODULE_SETTINGS_INCLUDED=1
    JUCE_USE_CURL=0
    JUCE_WEB_BROWSER=0
    JUCE_MODAL_LOOPS_PERMITTED=1
    JUCE_DIRECTSOUND=0
    JUCE_USE_WINDOWS_MEDIA_FORMAT=0
    JUCE_STANDALONE_APPLICATION=1
)

add_test(NAME test_effect_processblock_alloc COMMAND test_effect_processblock_alloc)

# ── test_resonance_core ─────────────────────────────────────────────────────
# xleth::dsp::resonance::Core (src/dsp/ResonanceCore.*): latency = N, depth-0
# identity / COLA at several block sizes, impulse, zero operator new in
# process() (incl. parameter changes every block), block-size independence with
# the detector active, reset, mono. Output prefix: [ResCore].
add_executable(test_resonance_core
    test/test_resonance_core.cpp
)

target_link_libraries(test_resonance_core PRIVATE
    XlethEngineCore
    XlethEngineModel
    juce::juce_core
    juce::juce_audio_basics
    juce::juce_audio_formats
    juce::juce_audio_processors
    juce::juce_dsp
    juce::juce_events
    juce::juce_gui_basics
    juce::juce_recommended_config_flags
    juce::juce_recommended_warning_flags
)

target_include_directories(test_resonance_core PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/src
)

target_compile_definitions(test_resonance_core PRIVATE
    JUCE_GLOBAL_MODULE_SETTINGS_INCLUDED=1
    JUCE_USE_CURL=0
    JUCE_WEB_BROWSER=0
    JUCE_MODAL_LOOPS_PERMITTED=1
    JUCE_DIRECTSOUND=0
    JUCE_USE_WINDOWS_MEDIA_FORMAT=0
    JUCE_STANDALONE_APPLICATION=1
)

add_test(NAME test_resonance_core COMMAND test_resonance_core)

# ── test_stereoize_core / test_fedda ────────────────────────────────────────
# xleth::dsp::stereoize::Core (src/dsp/stereoize/StereoizeCore.*) headless: mono null, correlation
# calibration, block-size independence, automation zipper, sample rates, denormals, CPU, seed
# decorrelation, zero operator new. test_fedda: the XlethFeddaEffect wrapper (parameter contract,
# state round-trip, zero latency, monitors forced off non-realtime). Output prefixes:
# [StereoizeCore], [Fedda].
foreach(_fedda_test test_stereoize_core test_fedda)
    add_executable(${_fedda_test}
        test/${_fedda_test}.cpp
    )

    target_link_libraries(${_fedda_test} PRIVATE
        XlethEngineCore
        XlethEngineModel
        juce::juce_core
        juce::juce_audio_basics
        juce::juce_audio_formats
        juce::juce_audio_processors
        juce::juce_dsp
        juce::juce_events
        juce::juce_gui_basics
        juce::juce_recommended_config_flags
        juce::juce_recommended_warning_flags
    )

    target_include_directories(${_fedda_test} PRIVATE
        ${CMAKE_CURRENT_SOURCE_DIR}/src
    )

    target_compile_definitions(${_fedda_test} PRIVATE
        JUCE_GLOBAL_MODULE_SETTINGS_INCLUDED=1
        JUCE_USE_CURL=0
        JUCE_WEB_BROWSER=0
        JUCE_MODAL_LOOPS_PERMITTED=1
        JUCE_DIRECTSOUND=0
        JUCE_USE_WINDOWS_MEDIA_FORMAT=0
        JUCE_STANDALONE_APPLICATION=1
    )

    add_test(NAME ${_fedda_test} COMMAND ${_fedda_test})
endforeach()

# ── test_szkrezh_core / test_szkrezh ────────────────────────────────────────
# xleth::dsp::szkrezh::Core (src/dsp/szkrezh/SzkrezhCore.*) headless: identity, reverse impulse,
# recycle staircase, aliasing (Vintage vs Clean), runaway, per-grain latching, transport-locked
# splice grid (free + sync + bar cut), block-size independence, skipped-block equivalence, Harmony and
# Keys pitch, gate/duck, freeze, tail hold, zero operator new, CPU. test_szkrezh: the
# XlethSzkrezhEffect wrapper (parameter contract, state round-trip, zero latency, MIDI channel
# filter, cross-track Keys lookup, tail-hold flag). Output prefixes: [SzkrezhCore], [Szkrezh].
foreach(_szkrezh_test test_szkrezh_core test_szkrezh)
    add_executable(${_szkrezh_test}
        test/${_szkrezh_test}.cpp
    )

    target_link_libraries(${_szkrezh_test} PRIVATE
        XlethEngineCore
        XlethEngineModel
        juce::juce_core
        juce::juce_audio_basics
        juce::juce_audio_formats
        juce::juce_audio_processors
        juce::juce_dsp
        juce::juce_events
        juce::juce_gui_basics
        juce::juce_recommended_config_flags
        juce::juce_recommended_warning_flags
    )

    target_include_directories(${_szkrezh_test} PRIVATE
        ${CMAKE_CURRENT_SOURCE_DIR}/src
    )

    target_compile_definitions(${_szkrezh_test} PRIVATE
        JUCE_GLOBAL_MODULE_SETTINGS_INCLUDED=1
        JUCE_USE_CURL=0
        JUCE_WEB_BROWSER=0
        JUCE_MODAL_LOOPS_PERMITTED=1
        JUCE_DIRECTSOUND=0
        JUCE_USE_WINDOWS_MEDIA_FORMAT=0
        JUCE_STANDALONE_APPLICATION=1
    )

    add_test(NAME ${_szkrezh_test} COMMAND ${_szkrezh_test})
endforeach()

# ── test_chain_effect_identity ────────────────────────────────────────────────
# Prompt 4A: stable chain-mode effectInstanceId — creation, lookup, move, bypass,
# parameter edit, save/load across APG uid remap, old-project generation,
# duplicate repair, and graph-ownership isolation.
add_executable(test_chain_effect_identity
    test/test_chain_effect_identity.cpp
)

target_link_libraries(test_chain_effect_identity PRIVATE
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

target_compile_definitions(test_chain_effect_identity PRIVATE
    JUCE_GLOBAL_MODULE_SETTINGS_INCLUDED=1
    JUCE_USE_CURL=0
    JUCE_WEB_BROWSER=0
    JUCE_MODAL_LOOPS_PERMITTED=1
    JUCE_DIRECTSOUND=0
    JUCE_USE_WINDOWS_MEDIA_FORMAT=0
    JUCE_STANDALONE_APPLICATION=1
)

target_link_options(test_chain_effect_identity PRIVATE /STACK:8388608)

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

# Audio device-health watchdog policy. Drives the pure decision function, so it
# needs no audio hardware and is safe on headless CI.
add_executable(test_device_watchdog
    test/test_device_watchdog.cpp
)

target_link_libraries(test_device_watchdog PRIVATE
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

target_compile_definitions(test_device_watchdog PRIVATE
    JUCE_GLOBAL_MODULE_SETTINGS_INCLUDED=1
    JUCE_USE_CURL=0
    JUCE_WEB_BROWSER=0
    JUCE_MODAL_LOOPS_PERMITTED=1
    JUCE_DIRECTSOUND=0
    JUCE_USE_WINDOWS_MEDIA_FORMAT=0
    JUCE_STANDALONE_APPLICATION=1
)

# SourcePlayer buffer lifetime: a callback thread reads while the main thread
# loads/unloads constant-valued WAVs. Needs FFmpeg DLLs (ctest sets PATH).
add_executable(test_source_player_unload
    test/test_source_player_unload.cpp
)

target_link_libraries(test_source_player_unload PRIVATE
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

target_compile_definitions(test_source_player_unload PRIVATE
    JUCE_GLOBAL_MODULE_SETTINGS_INCLUDED=1
    JUCE_USE_CURL=0
    JUCE_WEB_BROWSER=0
    JUCE_MODAL_LOOPS_PERMITTED=1
    JUCE_DIRECTSOUND=0
    JUCE_USE_WINDOWS_MEDIA_FORMAT=0
    JUCE_STANDALONE_APPLICATION=1
)

# Sampler set snapshot + sampler event queue: a second thread rebuilds, replaces
# and plays samplers while blocks render. Also the RtPublished / SpscRing units.
add_executable(test_sampler_set_handoff
    test/test_sampler_set_handoff.cpp
)

target_link_libraries(test_sampler_set_handoff PRIVATE
    XlethEngineCore
    XlethEngineModel
    juce::juce_core
    juce::juce_audio_basics
    juce::juce_audio_formats
    juce::juce_audio_processors
    juce::juce_dsp
    juce::juce_events
    juce::juce_gui_basics
    juce::juce_recommended_config_flags
    juce::juce_recommended_warning_flags
)

target_compile_definitions(test_sampler_set_handoff PRIVATE
    JUCE_GLOBAL_MODULE_SETTINGS_INCLUDED=1
    JUCE_USE_CURL=0
    JUCE_WEB_BROWSER=0
    JUCE_MODAL_LOOPS_PERMITTED=1
    JUCE_DIRECTSOUND=0
    JUCE_USE_WINDOWS_MEDIA_FORMAT=0
    JUCE_STANDALONE_APPLICATION=1
)

target_link_options(test_sampler_set_handoff PRIVATE /STACK:8388608)

# ── test_automation_runtime_lifetime ─────────────────────────────────────────
# An automation plan resolved against one effect chain must never write into a
# chain built after it (project load reuses node ids and, often, the freed
# effect's address). Was a 0xC0000005 in applyAutomationForBlock.
add_executable(test_automation_runtime_lifetime
    test/test_automation_runtime_lifetime.cpp
)

target_link_libraries(test_automation_runtime_lifetime PRIVATE
    XlethEngineCore
    XlethEngineModel
    juce::juce_core
    juce::juce_audio_basics
    juce::juce_audio_formats
    juce::juce_audio_processors
    juce::juce_dsp
    juce::juce_events
    juce::juce_gui_basics
    juce::juce_recommended_config_flags
    juce::juce_recommended_warning_flags
)

target_compile_definitions(test_automation_runtime_lifetime PRIVATE
    JUCE_GLOBAL_MODULE_SETTINGS_INCLUDED=1
    JUCE_USE_CURL=0
    JUCE_WEB_BROWSER=0
    JUCE_MODAL_LOOPS_PERMITTED=1
    JUCE_DIRECTSOUND=0
    JUCE_USE_WINDOWS_MEDIA_FORMAT=0
    JUCE_STANDALONE_APPLICATION=1
)

target_link_options(test_automation_runtime_lifetime PRIVATE /STACK:8388608)

# ── test_source_transform_stamp_aba ──────────────────────────────────────────
# A rebuilt chain whose Pitch Shifter reuses the freed one's address and node id
# must still republish the SourceTransform table (the stamp carries the graph serial).
add_executable(test_source_transform_stamp_aba
    test/test_source_transform_stamp_aba.cpp
)

target_link_libraries(test_source_transform_stamp_aba PRIVATE
    XlethEngineCore
    XlethEngineModel
    juce::juce_core
    juce::juce_audio_basics
    juce::juce_audio_formats
    juce::juce_audio_processors
    juce::juce_dsp
    juce::juce_events
    juce::juce_gui_basics
    juce::juce_recommended_config_flags
    juce::juce_recommended_warning_flags
)

target_compile_definitions(test_source_transform_stamp_aba PRIVATE
    JUCE_GLOBAL_MODULE_SETTINGS_INCLUDED=1
    JUCE_USE_CURL=0
    JUCE_WEB_BROWSER=0
    JUCE_MODAL_LOOPS_PERMITTED=1
    JUCE_DIRECTSOUND=0
    JUCE_USE_WINDOWS_MEDIA_FORMAT=0
    JUCE_STANDALONE_APPLICATION=1
)

target_link_options(test_source_transform_stamp_aba PRIVATE /STACK:8388608)

# ── test_automation_plan_rebind ──────────────────────────────────────────────
# After any chain or timeline mutation and its undo, one envelope applier pass
# leaves automation driving its parameter again (no site has to remember to
# mark the plan dirty).
add_executable(test_automation_plan_rebind
    test/test_automation_plan_rebind.cpp
)

target_link_libraries(test_automation_plan_rebind PRIVATE
    XlethEngineCore
    XlethEngineModel
    juce::juce_core
    juce::juce_audio_basics
    juce::juce_audio_formats
    juce::juce_audio_processors
    juce::juce_dsp
    juce::juce_events
    juce::juce_gui_basics
    juce::juce_recommended_config_flags
    juce::juce_recommended_warning_flags
)

target_compile_definitions(test_automation_plan_rebind PRIVATE
    JUCE_GLOBAL_MODULE_SETTINGS_INCLUDED=1
    JUCE_USE_CURL=0
    JUCE_WEB_BROWSER=0
    JUCE_MODAL_LOOPS_PERMITTED=1
    JUCE_DIRECTSOUND=0
    JUCE_USE_WINDOWS_MEDIA_FORMAT=0
    JUCE_STANDALONE_APPLICATION=1
)

target_link_options(test_automation_plan_rebind PRIVATE /STACK:8388608)

# ── test_automation_plan_snapshot ────────────────────────────────────────────
# The envelope applier builds the automation plan from the published timeline
# snapshot, never the live Timeline the bridge thread edits, replaces on project
# load and swaps for an export's frozen copy.
add_executable(test_automation_plan_snapshot
    test/test_automation_plan_snapshot.cpp
)

target_link_libraries(test_automation_plan_snapshot PRIVATE
    XlethEngineCore
    XlethEngineModel
    juce::juce_core
    juce::juce_audio_basics
    juce::juce_audio_formats
    juce::juce_audio_processors
    juce::juce_dsp
    juce::juce_events
    juce::juce_gui_basics
    juce::juce_recommended_config_flags
    juce::juce_recommended_warning_flags
)

target_compile_definitions(test_automation_plan_snapshot PRIVATE
    JUCE_GLOBAL_MODULE_SETTINGS_INCLUDED=1
    JUCE_USE_CURL=0
    JUCE_WEB_BROWSER=0
    JUCE_MODAL_LOOPS_PERMITTED=1
    JUCE_DIRECTSOUND=0
    JUCE_USE_WINDOWS_MEDIA_FORMAT=0
    JUCE_STANDALONE_APPLICATION=1
)

target_link_options(test_automation_plan_snapshot PRIVATE /STACK:8388608)

# Timeline reads on the audio thread: a second thread adds, removes and moves
# blocks, clips and notes and undoes/redoes them while blocks render.
add_executable(test_timeline_read_lifetime
    test/test_timeline_read_lifetime.cpp
)

target_link_libraries(test_timeline_read_lifetime PRIVATE
    XlethEngineCore
    XlethEngineModel
    juce::juce_core
    juce::juce_audio_basics
    juce::juce_audio_formats
    juce::juce_audio_processors
    juce::juce_dsp
    juce::juce_events
    juce::juce_gui_basics
    juce::juce_recommended_config_flags
    juce::juce_recommended_warning_flags
)

target_compile_definitions(test_timeline_read_lifetime PRIVATE
    JUCE_GLOBAL_MODULE_SETTINGS_INCLUDED=1
    JUCE_USE_CURL=0
    JUCE_WEB_BROWSER=0
    JUCE_MODAL_LOOPS_PERMITTED=1
    JUCE_DIRECTSOUND=0
    JUCE_USE_WINDOWS_MEDIA_FORMAT=0
    JUCE_STANDALONE_APPLICATION=1
)

target_link_options(test_timeline_read_lifetime PRIVATE /STACK:8388608)

# SampleBank buffers on the audio thread: a second thread loads, remaps and
# unloads samples (and replaces the whole bank, as project load does) while
# blocks render audio clips, samplers and manual voices from them.
add_executable(test_sample_bank_lifetime
    test/test_sample_bank_lifetime.cpp
)

target_link_libraries(test_sample_bank_lifetime PRIVATE
    XlethEngineCore
    XlethEngineModel
    juce::juce_core
    juce::juce_audio_basics
    juce::juce_audio_formats
    juce::juce_audio_processors
    juce::juce_dsp
    juce::juce_events
    juce::juce_gui_basics
    juce::juce_recommended_config_flags
    juce::juce_recommended_warning_flags
)

target_compile_definitions(test_sample_bank_lifetime PRIVATE
    JUCE_GLOBAL_MODULE_SETTINGS_INCLUDED=1
    JUCE_USE_CURL=0
    JUCE_WEB_BROWSER=0
    JUCE_MODAL_LOOPS_PERMITTED=1
    JUCE_DIRECTSOUND=0
    JUCE_USE_WINDOWS_MEDIA_FORMAT=0
    JUCE_STANDALONE_APPLICATION=1
)

target_link_options(test_sample_bank_lifetime PRIVATE /STACK:8388608)

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

# ── test_phanjer ─────────────────────────────────────────────────────────────
# PhanjerEffect (parallel flanger + phaser with analytic collision leveling).
# Verifies: the 23-id parameter contract, state round-trip, silence in all three
# modes x five LFO shapes, a 192 kHz worst-case fuzz pass, the SMART-vs-WILD
# leveling money test, and the pure resolveRateHz / computeCollisionMetric
# helpers.
add_executable(test_phanjer
    test/test_phanjer.cpp
)

target_link_libraries(test_phanjer PRIVATE
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

target_compile_definitions(test_phanjer PRIVATE
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

# ── test_amp ─────────────────────────────────────────────────────────────────
# XlethAmpEffect ("Amp Stack") — docs/amp spec.docx §10 acceptance tests 1-4:
# aliasing sweep at max Drive per model, bypass null against latency-compensated
# dry, per-stage element isolation, and per-instance CPU at the measured engine
# rate. Also checks the §7 parameter surface and the placeholder cabinet IRs
# against the numeric character notes in §6.
add_executable(test_amp
    test/test_amp.cpp
)

target_link_libraries(test_amp PRIVATE
    XlethEngineCore
    XlethEngineModel
    juce::juce_core
    juce::juce_audio_basics
    juce::juce_audio_formats
    juce::juce_audio_processors
    juce::juce_dsp
    juce::juce_events
    juce::juce_gui_basics
    juce::juce_recommended_config_flags
    juce::juce_recommended_warning_flags
)

target_compile_definitions(test_amp PRIVATE
    JUCE_GLOBAL_MODULE_SETTINGS_INCLUDED=1
    JUCE_USE_CURL=0
    JUCE_WEB_BROWSER=0
    JUCE_MODAL_LOOPS_PERMITTED=1
    JUCE_DIRECTSOUND=0
    JUCE_USE_WINDOWS_MEDIA_FORMAT=0
    JUCE_STANDALONE_APPLICATION=1
)

# ── test_uniflange ───────────────────────────────────────────────────────────
# Structural DSP tests for UniFlangeEffect (Fruity-Flangus-style unison/
# ensemble generator). Verifies: cross-matrix exactness, LEGACY-mode
# interpolator identity, no-feedback flatness in time, pan invariance vs
# DEPTH/SPEED, and delay-line bounds safety across sample rates/extremes.
# See uniflange/UNIFLANGE_HANDOFF.md §10 — structural correctness only, no
# null test against real Flangus renders (the parameter maps are unfitted
# placeholders pending round-3 renders).
add_executable(test_uniflange
    test/test_uniflange.cpp
)

target_link_libraries(test_uniflange PRIVATE
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

target_compile_definitions(test_uniflange PRIVATE
    JUCE_GLOBAL_MODULE_SETTINGS_INCLUDED=1
    JUCE_USE_CURL=0
    JUCE_WEB_BROWSER=0
    JUCE_MODAL_LOOPS_PERMITTED=1
    JUCE_DIRECTSOUND=0
    JUCE_USE_WINDOWS_MEDIA_FORMAT=0
    JUCE_STANDALONE_APPLICATION=1
)

# ── test_glue_compressor ─────────────────────────────────────────────────────
# CompressorCore template + the Glue VCA stock compressor ("glue"). Behaviour
# tests per docs/Compressor_Archetypes_Deep_Dive.md §10: static curve vs the
# gain computer, ballistics under one time-constant definition (incl. the
# tracked loop's closed-loop pole and oversampled coefficients), auto-release
# program dependence, stereo-link identity, stepped-control crossfade, RT
# safety (allocations, denormals, implicit-loop stability) and PDC latency.
add_executable(test_glue_compressor
    test/test_glue_compressor.cpp
)

target_link_libraries(test_glue_compressor PRIVATE
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

target_compile_definitions(test_glue_compressor PRIVATE
    JUCE_GLOBAL_MODULE_SETTINGS_INCLUDED=1
    JUCE_USE_CURL=0
    JUCE_WEB_BROWSER=0
    JUCE_MODAL_LOOPS_PERMITTED=1
    JUCE_DIRECTSOUND=0
    JUCE_USE_WINDOWS_MEDIA_FORMAT=0
    JUCE_STANDALONE_APPLICATION=1
)

# ── test_opto_compressor ─────────────────────────────────────────────────────
# Opto Comp ("opto"), the LA-2A-lineage model on CompressorCore. Behaviour tests
# per docs/Compressor_Archetypes_Deep_Dive.md §3.4/§10: the burst fitting
# procedure (release tails lengthen with burst length) with a single-tau
# negative control, static-curve sweep (soft, program-dependent knee,
# Compress vs Limit), stereo-link identity, Limit/Compress crossfade, 2x
# oversampling of the tube colour (aliasing), RT safety and PDC latency.
add_executable(test_opto_compressor
    test/test_opto_compressor.cpp
)

target_link_libraries(test_opto_compressor PRIVATE
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

target_compile_definitions(test_opto_compressor PRIVATE
    JUCE_GLOBAL_MODULE_SETTINGS_INCLUDED=1
    JUCE_USE_CURL=0
    JUCE_WEB_BROWSER=0
    JUCE_MODAL_LOOPS_PERMITTED=1
    JUCE_DIRECTSOUND=0
    JUCE_USE_WINDOWS_MEDIA_FORMAT=0
    JUCE_STANDALONE_APPLICATION=1
)

# ── test_fet_compressor ──────────────────────────────────────────────────────
# FET Comp ("fet"), the 1176-lineage model on CompressorCore. Behaviour tests
# per docs/Compressor_Archetypes_Deep_Dive.md §4/§10: static curve per ratio
# preset (the threshold moves with the ratio), THD vs gain reduction rising
# (the eps fit, with an eps = 0 negative control), ballistics measured at the
# 4x rate (1x negative control), aliasing sweep under fast heavy compression,
# All-buttons-in as its own mode, stereo link, RT safety and PDC latency.
add_executable(test_fet_compressor
    test/test_fet_compressor.cpp
)

target_link_libraries(test_fet_compressor PRIVATE
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

target_compile_definitions(test_fet_compressor PRIVATE
    JUCE_GLOBAL_MODULE_SETTINGS_INCLUDED=1
    JUCE_USE_CURL=0
    JUCE_WEB_BROWSER=0
    JUCE_MODAL_LOOPS_PERMITTED=1
    JUCE_DIRECTSOUND=0
    JUCE_USE_WINDOWS_MEDIA_FORMAT=0
    JUCE_STANDALONE_APPLICATION=1
)

# ── test_varimu_compressor ───────────────────────────────────────────────────
# Vari-Mu Comp ("varimu"), the Fairchild 660/670-lineage model on
# CompressorCore. Behaviour tests per docs/Compressor_Archetypes_Deep_Dive.md
# §5.4/§10: the ratio rising with level (negative control: a log-linear g_m),
# positions 5/6 program dependence (negative control: a fixed release), the
# §1.3 ÷3 time-constant normalisation (negative control: un-normalised),
# THD vs GR with push-pull even-order cancellation and no thump, aliasing at
# 1x/2x/4x, stereo link, Mid/Side independence and the mode crossfade, RT
# safety, PDC latency.
add_executable(test_varimu_compressor
    test/test_varimu_compressor.cpp
)

target_link_libraries(test_varimu_compressor PRIVATE
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

target_compile_definitions(test_varimu_compressor PRIVATE
    JUCE_GLOBAL_MODULE_SETTINGS_INCLUDED=1
    JUCE_USE_CURL=0
    JUCE_WEB_BROWSER=0
    JUCE_MODAL_LOOPS_PERMITTED=1
    JUCE_DIRECTSOUND=0
    JUCE_USE_WINDOWS_MEDIA_FORMAT=0
    JUCE_STANDALONE_APPLICATION=1
)

# ── test_apex ────────────────────────────────────────────────────────────────
# DSP-core contract tests for XlethApexEffect (the APEX multiband maximizer).
# Verifies: Linkwitz-Riley band-split reconstruction is magnitude-flat within
# +/-0.5 dB for every LR2/LR4 slope combination, LOOKAHEAD introduces exactly
# the latency APEX reports (impulse position AND a bit-exact band-leg shift),
# the BAND MIX dry leg is sample-aligned with the band leg (null test against
# the 0 %/100 % mean), 2x-oversampled saturation at +/-100 % leaves no aliasing
# product above -60 dBFS below 20 kHz, MUTED is digital silence and OFF is
# bit-transparent — plus the half-band oversampler primitive, curve-LUT
# compilation, and the parameter / latency / state-serialization surface.
add_executable(test_apex
    test/test_apex.cpp
)

target_link_libraries(test_apex PRIVATE
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

target_compile_definitions(test_apex PRIVATE
    JUCE_GLOBAL_MODULE_SETTINGS_INCLUDED=1
    JUCE_USE_CURL=0
    JUCE_WEB_BROWSER=0
    JUCE_MODAL_LOOPS_PERMITTED=1
    JUCE_DIRECTSOUND=0
    JUCE_USE_WINDOWS_MEDIA_FORMAT=0
    JUCE_STANDALONE_APPLICATION=1
)

# ── test_smart_balance ───────────────────────────────────────────────────────
# SmartBalanceEffect (the gentle 4-band leveller + Warmth). Verifies: balanced
# material is left alone, an over-bright / dull band is pulled toward the
# balanced layout within its lift / cut limits, an absent band and the gaps
# between notes are never lifted, Preserve keeps a hit's crest and stops the
# post-hit pump, loudness match holds the K-weighted level, Amount 0 / Mix 0 is
# magnitude-transparent, Warmth adds low-order harmonics below 800 Hz only and
# is level-independent, the low band never distorts at the fastest Response,
# block-size independence, robustness, the parameter contract and state.
# Header-only effect: links JUCE alone (no engine library, no FFmpeg DLLs), so
# the exe also runs directly: `test_smart_balance --render in.wav out.wav k=v`.
add_executable(test_smart_balance
    test/test_smart_balance.cpp
)

target_link_libraries(test_smart_balance PRIVATE
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
)

target_include_directories(test_smart_balance PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/src
)

target_compile_definitions(test_smart_balance PRIVATE
    JUCE_GLOBAL_MODULE_SETTINGS_INCLUDED=1
    JUCE_USE_CURL=0
    JUCE_WEB_BROWSER=0
    JUCE_MODAL_LOOPS_PERMITTED=1
    JUCE_DIRECTSOUND=0
    JUCE_USE_WINDOWS_MEDIA_FORMAT=0
    JUCE_STANDALONE_APPLICATION=1
)

# ── test_xlethfilter ─────────────────────────────────────────────────────────
# DSP-core contract tests for XlethFilterEffect (the multi-slot TPT/Cytomic SVF
# filter). Verifies the LP/HP/BP/notch/allpass/peak/shelf magnitudes against the
# closed-form digital response of the prewarped SVF, that morph is click-free
# and bounded across the whole sweep, that the 24/48 dB Butterworth cascades are
# measurably steeper than 12 dB AND still -3 dB at fc, that self-oscillation
# rings bounded without NaN, that a 100 Hz -> 10 kHz cutoff slam at Q = 20 stays
# stable (the TB-303 case a direct-form biquad cannot survive), that add/remove
# slot mid-stream is glitch-free and the slot count round-trips through state,
# and that the response-curve RPC payload matches the audio path.
add_executable(test_xlethfilter
    test/test_xlethfilter.cpp
)

target_link_libraries(test_xlethfilter PRIVATE
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

target_compile_definitions(test_xlethfilter PRIVATE
    JUCE_GLOBAL_MODULE_SETTINGS_INCLUDED=1
    JUCE_USE_CURL=0
    JUCE_WEB_BROWSER=0
    JUCE_MODAL_LOOPS_PERMITTED=1
    JUCE_DIRECTSOUND=0
    JUCE_USE_WINDOWS_MEDIA_FORMAT=0
    JUCE_STANDALONE_APPLICATION=1
)

# ── test_xlethfilter_analog ──────────────────────────────────────────────────
# Contract tests for the analog-modelled and character slot types layered on top
# of the SVF core: the moog24 transistor ladder (steeper than the 12 dB SVF,
# bounded at k = 4), the acid303 diode ladder (measurably a DIFFERENT filter from
# the moog at identical settings, and stable through an envelope-speed cutoff
# slam at high resonance), Sallen-Key (real resonant peak, gentler self-osc onset
# than a ladder), the Steiner-Parker injection modes (including the proof that
# HP-node injection reduces EXACTLY to lp12), the comb (peaks at fs/M, T60 decay
# matching the derived loop gain), the formant bank (an ah->ee morph really does
# move F1 from 730 Hz to 270 Hz, click-free) and the tilt EQ. Also prints a
# per-type CPU cost table against the lp12 baseline.
add_executable(test_xlethfilter_analog
    test/test_xlethfilter_analog.cpp
)

target_link_libraries(test_xlethfilter_analog PRIVATE
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

target_compile_definitions(test_xlethfilter_analog PRIVATE
    JUCE_GLOBAL_MODULE_SETTINGS_INCLUDED=1
    JUCE_USE_CURL=0
    JUCE_WEB_BROWSER=0
    JUCE_MODAL_LOOPS_PERMITTED=1
    JUCE_DIRECTSOUND=0
    JUCE_USE_WINDOWS_MEDIA_FORMAT=0
    JUCE_STANDALONE_APPLICATION=1
)

# ── test_xlethfilter_mod ─────────────────────────────────────────────────────
# Modulation-layer contract tests for XlethFilterEffect: the per-slot in-effect
# dynamics follower (detector -> ballistics -> exponential octave mapping ->
# clamped sum), the 303 accent lag's accumulation across rapid transients, the
# shallow Q route, and the proof that dyn_depth = 0 is bit-identical to having
# no follower at all. Also verifies that EVERY s{i}_* parameter is reachable as
# an FX-graph {"kind":"graph-parameter"} target and that driving s0_cutoff
# through the real xleth::lfomod -> xleth::envmod mapping produces a bounded,
# periodic sweep. Links EffectChainManager (Core) for the graph-parameter
# surface and XlethEngineModel for the modulation evaluators.
add_executable(test_xlethfilter_mod
    test/test_xlethfilter_mod.cpp
)

target_link_libraries(test_xlethfilter_mod PRIVATE
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

target_compile_definitions(test_xlethfilter_mod PRIVATE
    JUCE_GLOBAL_MODULE_SETTINGS_INCLUDED=1
    JUCE_USE_CURL=0
    JUCE_WEB_BROWSER=0
    JUCE_MODAL_LOOPS_PERMITTED=1
    JUCE_DIRECTSOUND=0
    JUCE_USE_WINDOWS_MEDIA_FORMAT=0
    JUCE_STANDALONE_APPLICATION=1
)

# ── test_limiter ─────────────────────────────────────────────────────────────
# Gain-computer tests for XlethLimiterEffect (two-stage transient + release).
# Verifies: parameter/meter surface unchanged, brickwall ceiling under hard
# drive for all three styles, no per-cycle amplitude modulation of low tones
# (the crackle regression), corner-free release curve, hold floor surviving a
# 10 ms release request, per-style lookahead latency reporting, and the
# MovingMinimum / soft-clip primitives.
add_executable(test_limiter
    test/test_limiter.cpp
)

target_link_libraries(test_limiter PRIVATE
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

target_compile_definitions(test_limiter PRIVATE
    JUCE_GLOBAL_MODULE_SETTINGS_INCLUDED=1
    JUCE_USE_CURL=0
    JUCE_WEB_BROWSER=0
    JUCE_MODAL_LOOPS_PERMITTED=1
    JUCE_DIRECTSOUND=0
    JUCE_USE_WINDOWS_MEDIA_FORMAT=0
    JUCE_STANDALONE_APPLICATION=1
)

# ── test_loudness ────────────────────────────────────────────────────────────
# ITU-R BS.1770-4 loudness + EBU Tech 3341/3342 compliance for dsp/LoudnessAnalyzer.
# Asserts the published 48 kHz K-weighting biquads against the coefficients this
# code derives from the analog prototype (so the un-published 44.1 kHz path is
# trustworthy too), then runs the EBU 3341 §2.1 calibration/gating signals and
# the 3342 §3 loudness-range signals at BOTH 44100 and 48000. True peak, gate
# isolation, streaming/offline equivalence and degenerate input are checked
# against closed-form answers.
add_executable(test_loudness
    test/test_loudness.cpp
)

target_link_libraries(test_loudness PRIVATE
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

target_compile_definitions(test_loudness PRIVATE
    JUCE_GLOBAL_MODULE_SETTINGS_INCLUDED=1
    JUCE_USE_CURL=0
    JUCE_WEB_BROWSER=0
    JUCE_MODAL_LOOPS_PERMITTED=1
    JUCE_DIRECTSOUND=0
    JUCE_USE_WINDOWS_MEDIA_FORMAT=0
    JUCE_STANDALONE_APPLICATION=1
)

# ── test_export_normalization ────────────────────────────────────────────────
# Loudness normalisation in export/AudioExporter: the pure gain plan
# (AudioExporter::planNormalization) branch by branch, a closed loop that applies
# the plan and re-measures it with dsp/LoudnessAnalyzer, and end-to-end exports on
# both the Phase 3A tail path and the Phase 3B wrap path — where the invariants
# are that normalizationEnabled = false leaves the render bit-identical and that
# an enabled export differs from it by exactly one static gain.
add_executable(test_export_normalization
    test/test_export_normalization.cpp
)

target_link_libraries(test_export_normalization PRIVATE
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

target_compile_definitions(test_export_normalization PRIVATE
    JUCE_GLOBAL_MODULE_SETTINGS_INCLUDED=1
    JUCE_USE_CURL=0
    JUCE_WEB_BROWSER=0
    JUCE_MODAL_LOOPS_PERMITTED=1
    JUCE_DIRECTSOUND=0
    JUCE_USE_WINDOWS_MEDIA_FORMAT=0
    JUCE_STANDALONE_APPLICATION=1
)

# ── hall_measure (reverb re-tune measurement + A/B render tool) ──────────────
# Not a ctest test — a diagnostic/render tool for the ongoing stock-reverb
# redesign (docs/plans/reverb-audit-and-redesign.md). Prints a backend's
# character metrics (crest, stereo corr, RT60-vs-knob, calibration wet RMS,
# echo density) and writes before/after stereo WAV snippets. Gated OFF by
# default so it does not add to the CI build; enable ad-hoc with
#   cmake -S . -B build -DXLETH_BUILD_HALL_MEASURE=ON
#   cmake --build build --config Release --target hall_measure
option(XLETH_BUILD_HALL_MEASURE "Build the reverb measurement/render tool" OFF)
if(XLETH_BUILD_HALL_MEASURE)
    add_executable(hall_measure
        test/hall_measure.cpp
    )
    target_link_libraries(hall_measure PRIVATE
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
    target_compile_definitions(hall_measure PRIVATE
        JUCE_GLOBAL_MODULE_SETTINGS_INCLUDED=1
        JUCE_USE_CURL=0
        JUCE_WEB_BROWSER=0
        JUCE_MODAL_LOOPS_PERMITTED=1
        JUCE_DIRECTSOUND=0
        JUCE_USE_WINDOWS_MEDIA_FORMAT=0
        JUCE_STANDALONE_APPLICATION=1
    )
endif()

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

# ── test_frame_timing ────────────────────────────────────────────────────────
# Verifies the time <-> frame <-> PTS conversions in render/FrameRateMath.h that
# both FrameCollector and RenderVideoDecoder share. Pure arithmetic: no GPU, no
# media files, no engine core — only libavutil for av_rescale_q / av_d2q.
add_executable(test_frame_timing
    test/test_frame_timing.cpp
)

target_link_libraries(test_frame_timing PRIVATE
    ${FFMPEG_LIBRARIES}
)

target_include_directories(test_frame_timing PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/src
    ${FFMPEG_INCLUDE_DIRS}
)

target_link_directories(test_frame_timing PRIVATE
    ${FFMPEG_LIBRARY_DIRS}
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

# ── bench_proxy_seek (tool, NOT a ctest test) ────────────────────────────────
# Seek-latency + GOP-boundary accuracy benchmark for preview proxy files through
# the live-preview RenderVideoDecoder. Needs a GPU and real proxy files:
#   bench_proxy_seek <proxy.mov> [<proxy.mov> ...]
add_executable(bench_proxy_seek
    test/bench_proxy_seek.cpp
)
target_link_libraries(bench_proxy_seek PRIVATE
    XlethEngineCore
    XlethEngineModel
    d3d11
    dxgi
    ${FFMPEG_LIBRARIES}
)
target_include_directories(bench_proxy_seek PRIVATE
    ${FFMPEG_INCLUDE_DIRS}
)
target_link_directories(bench_proxy_seek PRIVATE
    ${FFMPEG_LIBRARY_DIRS}
)
target_compile_definitions(bench_proxy_seek PRIVATE
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

# ── test_export_snapshot ─────────────────────────────────────────────────────
# The frozen timeline copy export reads (spec Ruling 7, model/TimelineSnapshot.h):
# complete, independent of live edits, never calls back into MixEngine, and the
# shared event builder gives identical events from it. Set
# XLETH_EXPORT_SNAPSHOT_PROJECT (a project directory) to time the copy on a real
# project against the 200 ms budget. Output prefix: [ExportSnapshot].
add_executable(test_export_snapshot
    test/test_export_snapshot.cpp
)

target_link_libraries(test_export_snapshot PRIVATE
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

target_include_directories(test_export_snapshot PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/src
)

target_compile_definitions(test_export_snapshot PRIVATE
    JUCE_GLOBAL_MODULE_SETTINGS_INCLUDED=1
    JUCE_USE_CURL=0
    JUCE_WEB_BROWSER=0
    JUCE_MODAL_LOOPS_PERMITTED=1
    JUCE_DIRECTSOUND=0
    JUCE_USE_WINDOWS_MEDIA_FORMAT=0
    JUCE_STANDALONE_APPLICATION=1
)

# ── test_lens_roam ───────────────────────────────────────────────────────────
# Lens + Roam P1 (model/LensRoam.h): identity defaults, JSON round-trip of
# clips/tracks/sources incl. stored keys, tolerant loading, the v7 -> v8
# migration through ProjectManager (old project = Stretch everywhere, new
# content = Cover), and the immutable snapshot every render request copies
# from (identity in -> identity snapshot for every track). Pure CPU.
add_executable(test_lens_roam
    test/test_lens_roam.cpp
)

target_link_libraries(test_lens_roam PRIVATE
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

target_include_directories(test_lens_roam PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/src
)

target_compile_definitions(test_lens_roam PRIVATE
    JUCE_GLOBAL_MODULE_SETTINGS_INCLUDED=1
    JUCE_USE_CURL=0
    JUCE_WEB_BROWSER=0
    JUCE_MODAL_LOOPS_PERMITTED=1
    JUCE_DIRECTSOUND=0
    JUCE_USE_WINDOWS_MEDIA_FORMAT=0
    JUCE_STANDALONE_APPLICATION=1
)

# ── test_clones ──────────────────────────────────────────────────────────────
# Clones (docs/XLETH_CLONE_SPEC.md, model/Clone.h): voice assignment rules,
# JSON, event routing to Voice clones, Trail snapshot entries, the collector
# (Voice cells, Idle, Trails at the delayed time, draw order, tint, mute
# independence) and the edit commands. Pure CPU.
add_executable(test_clones
    test/test_clones.cpp
)

target_link_libraries(test_clones PRIVATE
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

target_include_directories(test_clones PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/src
)

target_compile_definitions(test_clones PRIVATE
    JUCE_GLOBAL_MODULE_SETTINGS_INCLUDED=1
    JUCE_USE_CURL=0
    JUCE_WEB_BROWSER=0
    JUCE_MODAL_LOOPS_PERMITTED=1
    JUCE_DIRECTSOUND=0
    JUCE_USE_WINDOWS_MEDIA_FORMAT=0
    JUCE_STANDALONE_APPLICATION=1
)

# ── test_color_grade ─────────────────────────────────────────────────────────
# Color Grade (model/ColorGrade.h): neutral = no pass, curve monotonicity, the
# baked transfer against the direct math, level order, owners and independence,
# one undo step per action incl. bulk apply, save/load at all four levels through
# ProjectManager, the snapshot every render request copies from, .cube LUT
# import, and the Auto helper on synthetic aged footage. Pure CPU.
add_executable(test_color_grade
    test/test_color_grade.cpp
)

target_link_libraries(test_color_grade PRIVATE
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

target_include_directories(test_color_grade PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/src
)

target_compile_definitions(test_color_grade PRIVATE
    JUCE_GLOBAL_MODULE_SETTINGS_INCLUDED=1
    JUCE_USE_CURL=0
    JUCE_WEB_BROWSER=0
    JUCE_MODAL_LOOPS_PERMITTED=1
    JUCE_DIRECTSOUND=0
    JUCE_USE_WINDOWS_MEDIA_FORMAT=0
    JUCE_STANDALONE_APPLICATION=1
)

# ── test_key_curve ───────────────────────────────────────────────────────────
# The shared keyframe curve engine (model/KeyCurve.h, Lens + Roam P7): empty
# keys = base, Hold/Linear/EaseOut, Head/Body/Tail anchor mapping for every
# note length 30..3840 under Squash and Cut, keys on zone boundaries, and no
# allocation while evaluating. Header-only, pure CPU, no JUCE.
add_executable(test_key_curve
    test/test_key_curve.cpp
)

target_include_directories(test_key_curve PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/src
)

# ── test_param_track ─────────────────────────────────────────────────────────
# Verifies the ParamTrack keyframe core and the Zoom/Pan/Rot migration onto it:
# bezier solve accuracy, the identity-in-x fast path, unclamped overshoot, the
# exact legacy-easing mapping, unwrapped rotation, log2 zoom space, and v1/v2
# payload handling. Pure CPU — no GPU or decoder.
add_executable(test_param_track
    test/test_param_track.cpp
)

target_link_libraries(test_param_track PRIVATE
    XlethEngineModel
    juce::juce_core
    juce::juce_audio_basics
    juce::juce_audio_formats
    juce::juce_events
    juce::juce_gui_basics
    juce::juce_recommended_config_flags
    juce::juce_recommended_warning_flags
)

target_compile_definitions(test_param_track PRIVATE
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

# main() holds dozens of CellFrameRequests (each carries a mask frame, motion samples
# and a parent chain): the default 1 MB stack is exhausted by one more test block.
target_link_options(test_compositor PRIVATE /STACK:8388608)

target_compile_definitions(test_compositor PRIVATE
    JUCE_GLOBAL_MODULE_SETTINGS_INCLUDED=1
    JUCE_USE_CURL=0
    JUCE_WEB_BROWSER=0
    JUCE_MODAL_LOOPS_PERMITTED=1
    JUCE_DIRECTSOUND=0
    JUCE_USE_WINDOWS_MEDIA_FORMAT=0
    JUCE_STANDALONE_APPLICATION=1
)

# ── test_color_grade_gpu ─────────────────────────────────────────────────────
# Color Grade on a real D3D11 device, through GridCompositor: the shader against
# the CPU reference (applyBakedGrade) to one 8-bit step, neutral = bit-identical,
# level order incl. Master, Master over empty areas, exact bypass, two
# compositors (preview / export) byte-identical, LUT, alpha, texture eviction.
add_executable(test_color_grade_gpu
    test/test_color_grade_gpu.cpp
)

target_link_libraries(test_color_grade_gpu PRIVATE
    XlethEngineCore
    XlethEngineModel
    d3d11
    dxgi
)

target_compile_definitions(test_color_grade_gpu PRIVATE
    JUCE_GLOBAL_MODULE_SETTINGS_INCLUDED=1
    JUCE_USE_CURL=0
    JUCE_WEB_BROWSER=0
    JUCE_MODAL_LOOPS_PERMITTED=1
    JUCE_DIRECTSOUND=0
    JUCE_USE_WINDOWS_MEDIA_FORMAT=0
    JUCE_STANDALONE_APPLICATION=1
)

# ── test_lens_roam_verify ─────────────────────────────────────────────────
# Lens + Roam P12 verification: live vs export parity per feature, zero added
# render-path allocations, 8x8 / 2,000-note stress timings (reported only).
add_executable(test_lens_roam_verify
    test/test_lens_roam_verify.cpp
)

target_link_libraries(test_lens_roam_verify PRIVATE
    XlethEngineCore
    XlethEngineModel
    d3d11
    dxgi
)

target_compile_definitions(test_lens_roam_verify PRIVATE
    JUCE_GLOBAL_MODULE_SETTINGS_INCLUDED=1
    JUCE_USE_CURL=0
    JUCE_WEB_BROWSER=0
    JUCE_MODAL_LOOPS_PERMITTED=1
    JUCE_DIRECTSOUND=0
    JUCE_USE_WINDOWS_MEDIA_FORMAT=0
    JUCE_STANDALONE_APPLICATION=1
)

# ── test_visual_echo ─────────────────────────────────────────────────────────
# Visual Echo end-to-end: tap gain/orientation math, ring mechanics, and the
# timing claim that matters — that a tap shows the frame from D frames ago,
# measured by encoding the frame number into the composited pixels.
add_executable(test_visual_echo
    test/test_visual_echo.cpp
)

target_link_libraries(test_visual_echo PRIVATE
    XlethEngineCore
    XlethEngineModel
    d3d11
    dxgi
)

target_compile_definitions(test_visual_echo PRIVATE
    JUCE_GLOBAL_MODULE_SETTINGS_INCLUDED=1
    JUCE_USE_CURL=0
    JUCE_WEB_BROWSER=0
    JUCE_MODAL_LOOPS_PERMITTED=1
    JUCE_DIRECTSOUND=0
    JUCE_USE_WINDOWS_MEDIA_FORMAT=0
    JUCE_STANDALONE_APPLICATION=1
)

# ── test_snapshot_transition ─────────────────────────────────────────────────
# Verifies the two-target whole-frame transition pass with real D3D11 rendering.
add_executable(test_snapshot_transition
    test/test_snapshot_transition.cpp
)

target_link_libraries(test_snapshot_transition PRIVATE
    XlethEngineCore
    XlethEngineModel
    d3d11
    dxgi
)

target_compile_definitions(test_snapshot_transition PRIVATE
    JUCE_GLOBAL_MODULE_SETTINGS_INCLUDED=1
    JUCE_USE_CURL=0
    JUCE_WEB_BROWSER=0
    JUCE_MODAL_LOOPS_PERMITTED=1
    JUCE_DIRECTSOUND=0
    JUCE_USE_WINDOWS_MEDIA_FORMAT=0
    JUCE_STANDALONE_APPLICATION=1
)

# ── test_landing_render ──────────────────────────────────────────────────────
# Landing on a real D3D11 device (docs/XLETH_LANDING_SPEC.md §9): the carry
# geometry, the pixel-identical seam at the pin, preview==export determinism
# through LandingRenderer (the helper both seams call), carried tracks across
# Push / crossfade, hold-last-frame through the extra collects, the perf floor.
add_executable(test_landing_render
    test/test_landing_render.cpp
)

target_link_libraries(test_landing_render PRIVATE
    XlethEngineCore
    XlethEngineModel
    d3d11
    dxgi
)

target_compile_definitions(test_landing_render PRIVATE
    JUCE_GLOBAL_MODULE_SETTINGS_INCLUDED=1
    JUCE_USE_CURL=0
    JUCE_WEB_BROWSER=0
    JUCE_MODAL_LOOPS_PERMITTED=1
    JUCE_DIRECTSOUND=0
    JUCE_USE_WINDOWS_MEDIA_FORMAT=0
    JUCE_STANDALONE_APPLICATION=1
)

# ── test_landing_floor ───────────────────────────────────────────────────────
# The Landing perf floor as a cross-build probe (spec ruling 9): a fixed
# project with cues and NO landings, one hash per frame, written against the
# pre-feature API only so the same file also builds on the commit before
# Landings. docs/XLETH_LANDING_VERIFY.md records the two digests matching.
add_executable(test_landing_floor
    test/test_landing_floor.cpp
)

target_link_libraries(test_landing_floor PRIVATE
    XlethEngineCore
    XlethEngineModel
    d3d11
    dxgi
)

target_compile_definitions(test_landing_floor PRIVATE
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

# main() holds Timeline + SampleBank + MixEngine as stack locals; together they
# overflow the 1 MB default on this toolchain before the first fprintf runs
# (0xC00000FD, reported by ctest as SEGFAULT with no output at all). 16 MB.
if(MSVC)
    target_link_options(test_real_render PRIVATE /STACK:16777216)
endif()

target_compile_definitions(test_real_render PRIVATE
    JUCE_GLOBAL_MODULE_SETTINGS_INCLUDED=1
    JUCE_USE_CURL=0
    JUCE_WEB_BROWSER=0
    JUCE_MODAL_LOOPS_PERMITTED=1
    JUCE_DIRECTSOUND=0
    JUCE_USE_WINDOWS_MEDIA_FORMAT=0
    JUCE_STANDALONE_APPLICATION=1
)

# ── CTest registration ────────────────────────────────────────────────────────
# Every self-test executable declared above, runnable in one command:
#     ctest --test-dir build -C Release          (from the repo root)
# WORKING_DIRECTORY is the repo root to match how build.bat has always invoked
# them (some tests resolve paths relative to the repo root, e.g. test_real_render
# loads the XLETH\test project). enable_testing() lives in the top-level
# CMakeLists.txt; the fallback below keeps standalone engine-only configures
# (cmake -S engine ...) working too.
if(CMAKE_SOURCE_DIR STREQUAL CMAKE_CURRENT_SOURCE_DIR)
    enable_testing()
endif()

set(XLETH_ENGINE_TESTS
    test_timeline
    test_landing
    test_grid_rect_math
    test_loop_region
    test_render_scope
    test_tail_render
    test_video_flip_resolver
    test_envelope_parameter_modulation
    test_envelope_modulation_engine
    test_lfo_parameter_modulation
    test_lfo_modulation_engine
    test_canvas_fit
    test_presentation_clock_smoother
    test_correction_curve
    test_autotune_render
    test_video_flip_applier
    test_flip_determinism
    test_video_event_builder
    test_flip_orientation_golden
    test_project
    test_regenerable_files
    test_undo
    test_effect_chain_commands
    test_track_routing
    test_sidechain_routes
    test_clip_modulation_evaluator
    test_clip_companion_fx_builder
    test_clip_video_modulation_timing
    test_clip_modulated_reader
    test_mix
    test_mixer_bus_routing
    test_mixer_routing_pdc
    test_sidechain_runtime
    test_stock_compressor_sidechain
    test_vst_sidechain
    test_fxgraph_sidechain_input
    test_clip_sr
    test_audio_telemetry
    test_audio_perf_scenarios
    test_sampler
    test_sampler_preview_route
    test_sampler_legacy_migration
    test_sampler_modulation
    test_mangle
    test_slot_prep
    test_world_stretch
    test_tdpsola
    test_loop_analysis
    test_loop_optimizer
    test_pitch_shift_dsp
    test_pitch_shifter_effect
    test_source_transform_table
    test_clip_fx_transform
    test_pattern_fx_transpose
    test_clip_fx_perf_gate
    test_auto_loop_policy
    test_midi_importer
    test_fsc_score_parser
    test_effects
    test_chain_effect_identity
    test_pdc_stage1
    test_device_watchdog
    test_source_player_unload
    test_sampler_set_handoff
    test_automation_runtime_lifetime
    test_source_transform_stamp_aba
    test_automation_plan_rebind
    test_automation_plan_snapshot
    test_timeline_read_lifetime
    test_sample_bank_lifetime
    test_distortion
    test_phanjer
    test_reverb
    test_amp
    test_uniflange
    test_limiter
    test_apex
    test_smart_balance
    test_glue_compressor
    test_opto_compressor
    test_fet_compressor
    test_varimu_compressor
    test_xlethfilter
    test_xlethfilter_analog
    test_xlethfilter_mod
    test_loudness
    test_export_normalization
    test_graph_effect_parameters
    test_frame_cache
    test_frame_collector
    test_frame_timing
    test_render_decoder
    test_animation_manager
    test_param_track
    test_lens_roam
    test_clones
    test_color_grade
    test_key_curve
    test_export_snapshot
    test_render_clock
    test_automation_clips
    test_sandbox
    test_compositor
    test_color_grade_gpu
    test_lens_roam_verify
    test_visual_echo
    test_snapshot_transition
    test_landing_render
    test_landing_floor
    test_muxer
    test_hw_detect
    test_offline_render
    test_real_render
)

foreach(_xleth_test IN LISTS XLETH_ENGINE_TESTS)
    add_test(NAME ${_xleth_test}
        COMMAND ${_xleth_test}
        WORKING_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR}/..
    )
    # FFmpeg-linked tests need the vcpkg DLLs (avcodec etc.) on PATH — the
    # manual invocations relied on this too; without it they die on startup
    # with 0xc0000135 (STATUS_DLL_NOT_FOUND).
    if(EXISTS "${_VCPKG_INSTALLED}/bin")
        set_tests_properties(${_xleth_test} PROPERTIES
            ENVIRONMENT_MODIFICATION "PATH=path_list_prepend:${_VCPKG_INSTALLED}/bin"
        )
    endif()
endforeach()

# test_mix runs with the audio helper threads off. Its [RT 1] checks read
# per-plugin telemetry, which MixEngine only records when a track's chain runs
# on the callback thread; with helpers on, a helper often takes the chain and
# "pluginCallCount > 0" over 8 blocks failed about 3 runs in 40.
#
# test_mix_parallel is the same binary with helpers forced ON, so the routing,
# send, sidechain, PDC and tail assertions still run through the parallel track
# scheduler on any machine. There the three per-plugin checks fall back to what
# is guaranteed on any thread (the chain ran and was never skipped). The two
# share temp directories, hence the lock.
set_tests_properties(test_mix PROPERTIES
    ENVIRONMENT "XLETH_HW_AUDIO_WORKERS=0"
    RESOURCE_LOCK test_mix_tempdirs
)
add_test(NAME test_mix_parallel
    COMMAND test_mix
    WORKING_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR}/..
)
set_tests_properties(test_mix_parallel PROPERTIES
    ENVIRONMENT "XLETH_HW_AUDIO_WORKERS=4"
    RESOURCE_LOCK test_mix_tempdirs
)
if(EXISTS "${_VCPKG_INSTALLED}/bin")
    set_tests_properties(test_mix_parallel PROPERTIES
        ENVIRONMENT_MODIFICATION "PATH=path_list_prepend:${_VCPKG_INSTALLED}/bin"
    )
endif()

# Live-vs-export timing repro for Pitch-Shifter tracks under PDC. Tool-only:
# loads a machine-local project copy, so it is not registered with ctest.
add_executable(xleth_pitch_pdc_timing_repro
    tools/xleth_pitch_pdc_timing_repro.cpp
)
target_link_libraries(xleth_pitch_pdc_timing_repro PRIVATE
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
    winmm
)
target_include_directories(xleth_pitch_pdc_timing_repro PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/src)
target_compile_definitions(xleth_pitch_pdc_timing_repro PRIVATE
    JUCE_GLOBAL_MODULE_SETTINGS_INCLUDED=1
    JUCE_USE_CURL=0
    JUCE_WEB_BROWSER=0
    JUCE_MODAL_LOOPS_PERMITTED=1
    JUCE_DIRECTSOUND=0
    JUCE_USE_WINDOWS_MEDIA_FORMAT=0
    JUCE_STANDALONE_APPLICATION=1
    NOMINMAX
)
target_link_options(xleth_pitch_pdc_timing_repro PRIVATE /STACK:33554432)
