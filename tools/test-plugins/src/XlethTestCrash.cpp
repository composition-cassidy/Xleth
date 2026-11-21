// TEST FIXTURE — never shipped. See tools/test-plugins/CMakeLists.txt.
// A VST3-shaped module whose factory entry point faults. Loading it in
// xleth-plugin-scanner must kill only the scanner, and the engine must record
// the bundle as `crash` in plugin-scan-failures.json.

extern "C" __declspec(dllexport) void* GetPluginFactory()
{
    volatile int* p = nullptr;
    *p = 0x5C4A; // access violation
    return nullptr;
}
