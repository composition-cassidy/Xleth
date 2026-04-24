# ── xleth-editor-host ─────────────────────────────────────────────────────────
# Out-of-process VST3 editor host. Each VST3 editor opens in its own dedicated
# process with its own JUCE MessageManager and Win32 message pump, eliminating
# the thread starvation that occurs when editor UI shares the worker's message
# thread with N-API traffic.
#
# Must be added AFTER engine/ (which sets up JUCE targets).
# Intended to be included from bridge/CMakeLists.txt (cmake-js build), which
# puts the .exe next to xleth_native.node in bridge/build/Release/.

if(NOT TARGET juce::juce_core)
    message(FATAL_ERROR
        "xleth-editor-host must be added after engine/ — JUCE targets are "
        "not yet available.")
endif()

juce_add_gui_app(xleth-editor-host
    PRODUCT_NAME "Xleth Editor Host"
    VERSION      "1.0.0"
)

target_sources(xleth-editor-host PRIVATE
    src/EditorHostMain.cpp
    src/AudioPumpThread.cpp
    # NamedAudioRing.cpp is owned by the engine but is self-contained (no
    # engine deps) and needs to be compiled into the editor-host too so both
    # processes share the same shared-memory layout. Compile it directly from
    # the engine source tree rather than duplicating.
    ${CMAKE_CURRENT_SOURCE_DIR}/../engine/src/audio/NamedAudioRing.cpp
)

# Allow #include "audio/NamedAudioRing.h" (same path shape as engine uses).
target_include_directories(xleth-editor-host PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/src
    ${CMAKE_CURRENT_SOURCE_DIR}/../engine/src
)

target_compile_definitions(xleth-editor-host PRIVATE
    JUCE_GLOBAL_MODULE_SETTINGS_INCLUDED=1
    JUCE_USE_CURL=0
    JUCE_WEB_BROWSER=0
    JUCE_MODAL_LOOPS_PERMITTED=1
    JUCE_PLUGINHOST_VST3=1
    JUCE_USE_WINDOWS_MEDIA_FORMAT=0
    JUCE_DIRECTSOUND=0
)

# Does NOT link XlethEngineCore — editor-host must be fully isolated from the
# worker's audio graph. It only needs JUCE audio-processor infrastructure for
# loading and editing plugins.
target_link_libraries(xleth-editor-host PRIVATE
    juce::juce_core
    juce::juce_events
    juce::juce_audio_basics
    juce::juce_audio_processors
    juce::juce_gui_basics
    juce::juce_recommended_config_flags
    juce::juce_recommended_warning_flags
)

# Output alongside xleth_native.node and xleth-plugin-scanner.exe so
# PluginRegistry (and later the editor IPC coordinator) can locate it as a
# sibling. cmake-js sets CMAKE_BINARY_DIR = bridge/build, so Release/ matches.
# OUTPUT_NAME overrides the PRODUCT_NAME-derived binary name (which has spaces).
set_target_properties(xleth-editor-host PROPERTIES
    OUTPUT_NAME                      "xleth-editor-host"
    RUNTIME_OUTPUT_DIRECTORY_RELEASE "${CMAKE_BINARY_DIR}/Release"
    RUNTIME_OUTPUT_DIRECTORY_DEBUG   "${CMAKE_BINARY_DIR}/Debug"
    RUNTIME_OUTPUT_DIRECTORY         "${CMAKE_BINARY_DIR}"
)
