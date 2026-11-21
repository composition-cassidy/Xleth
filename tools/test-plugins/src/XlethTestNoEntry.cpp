// TEST FIXTURE — never shipped. See tools/test-plugins/CMakeLists.txt.
// A well-formed x64 VST3-shaped bundle whose DLL has NO GetPluginFactory
// export. The engine's PE preflight (P2) must record it as `no-entry-point`
// without ever spawning the scanner for it.

extern "C" __declspec(dllexport) int XlethTestNotTheFactory()
{
    return 0x5C4A;
}
