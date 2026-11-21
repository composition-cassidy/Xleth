// TEST FIXTURE — never shipped. See tools/test-plugins/CMakeLists.txt.
// A VST3-shaped module whose factory entry point never returns. The engine's
// 10 s per-file wait must expire, record the bundle as `timeout`, and drop the
// scanner (which then exits itself once the pipe closes).

#define WIN32_LEAN_AND_MEAN
#include <windows.h>

extern "C" __declspec(dllexport) void* GetPluginFactory()
{
    for (;;)
        ::Sleep(INFINITE);
}
