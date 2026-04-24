# ── xleth-plugin-scanner ──────────────────────────────────────────────────────
# Out-of-process VST3 scanner. Launched by PluginRegistry as a child process;
# if a plugin crashes during scan only this process dies — the coordinator
# detects the connection loss and marks that plugin as failed.
#
# Must be added AFTER engine/ (which sets up JUCE targets).
# Intended to be included from bridge/CMakeLists.txt (cmake-js build), which
# puts the .exe next to xleth_native.node in bridge/build/Release/.

if(NOT TARGET juce::juce_core)
    message(FATAL_ERROR
        "xleth-plugin-scanner must be added after engine/ — JUCE targets are "
        "not yet available.")
endif()

add_executable(xleth-plugin-scanner
    src/ScannerMain.cpp
)

target_compile_definitions(xleth-plugin-scanner PRIVATE
    JUCE_GLOBAL_MODULE_SETTINGS_INCLUDED=1
    JUCE_USE_CURL=0
    JUCE_WEB_BROWSER=0
    JUCE_MODAL_LOOPS_PERMITTED=1
    JUCE_PLUGINHOST_VST3=1
    JUCE_USE_WINDOWS_MEDIA_FORMAT=0
    JUCE_DIRECTSOUND=0
)

# Does NOT link XlethEngineCore — scanner must be fully isolated.
target_link_libraries(xleth-plugin-scanner PRIVATE
    juce::juce_core
    juce::juce_events
    juce::juce_audio_basics
    juce::juce_audio_processors
    juce::juce_recommended_config_flags
    juce::juce_recommended_warning_flags
)

# Output alongside xleth_native.node so PluginRegistry can find it as a sibling.
# cmake-js sets CMAKE_BINARY_DIR = bridge/build, so Release/ matches .node.
set_target_properties(xleth-plugin-scanner PROPERTIES
    RUNTIME_OUTPUT_DIRECTORY_RELEASE "${CMAKE_BINARY_DIR}/Release"
    RUNTIME_OUTPUT_DIRECTORY_DEBUG   "${CMAKE_BINARY_DIR}/Debug"
    RUNTIME_OUTPUT_DIRECTORY         "${CMAKE_BINARY_DIR}"
)
