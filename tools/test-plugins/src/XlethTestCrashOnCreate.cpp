// TEST FIXTURE — never shipped. See tools/test-plugins/CMakeLists.txt.
//
// A VST3 module that SCANS fine and crashes when the host INSTANTIATES it:
//   • The bundle ships Contents\Resources\moduleinfo.json, so JUCE's scan takes
//     the fast path (DescriptionLister::findDescriptionsFast) and never loads
//     the DLL or calls createInstance.
//   • GetPluginFactory returns a minimal IPluginFactory (hand-rolled vtable, no
//     VST3 SDK) with one "Audio Module Class". Its createInstance writes through
//     a null pointer — the first call JUCE's createPluginInstance makes into the
//     plugin after matching the class.
//
// XLETH_TEST_CRASH_HARD=1 in the environment replaces the null write with
// __fastfail (uncatchable by SEH: the process dies at once). That exercises the
// engine-death branch of the P2 load breadcrumb on demand.

#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <intrin.h>

namespace {

using int32   = std::int32_t;
using tresult = int32;
using TUID    = char[16];

constexpr tresult kResultOk    = 0;
constexpr tresult kNoInterface = static_cast<tresult>(0x80004002L);   // E_NOINTERFACE
constexpr tresult kInvalidArg  = static_cast<tresult>(0x80070057L);   // E_INVALIDARG

// Steinberg INLINE_UID with COM_COMPATIBLE (Windows) byte order.
#define XT_UID(l1, l2, l3, l4) {                                                        \
    (char)((l1) & 0xFF), (char)(((l1) >> 8) & 0xFF), (char)(((l1) >> 16) & 0xFF), (char)(((l1) >> 24) & 0xFF), \
    (char)(((l2) >> 16) & 0xFF), (char)(((l2) >> 24) & 0xFF), (char)((l2) & 0xFF), (char)(((l2) >> 8) & 0xFF), \
    (char)(((l3) >> 24) & 0xFF), (char)(((l3) >> 16) & 0xFF), (char)(((l3) >> 8) & 0xFF), (char)((l3) & 0xFF), \
    (char)(((l4) >> 24) & 0xFF), (char)(((l4) >> 16) & 0xFF), (char)(((l4) >> 8) & 0xFF), (char)((l4) & 0xFF) }

const TUID kFUnknownIID       = XT_UID(0x00000000, 0x00000000, 0xC0000000, 0x00000046);
const TUID kIPluginFactoryIID = XT_UID(0x7A4D811C, 0x52114A1F, 0xAED9D2EE, 0x0B43BF9F);
// MUST match "CID" in moduleinfo.json (XlethTestCrashOnCreate.moduleinfo.json).
const TUID kClassCID          = XT_UID(0x58C1E7A0, 0x2C0D4E11, 0x9A51C4A5, 0x0CC0FFEE);

struct PFactoryInfo
{
    char  vendor[64];
    char  url[256];
    char  email[128];
    int32 flags;
};

struct PClassInfo
{
    TUID  cid;
    int32 cardinality;
    char  category[32];
    char  name[64];
};

// IPluginFactory vtable layout: FUnknown (queryInterface, addRef, release),
// then getFactoryInfo, countClasses, getClassInfo, createInstance.
class Factory
{
public:
    virtual tresult  __stdcall queryInterface(const TUID iid, void** obj)
    {
        if (obj == nullptr) return kInvalidArg;
        if (std::memcmp(iid, kFUnknownIID, 16) == 0 || std::memcmp(iid, kIPluginFactoryIID, 16) == 0)
        {
            *obj = this;
            return kResultOk;
        }
        *obj = nullptr;
        return kNoInterface;
    }
    virtual std::uint32_t __stdcall addRef()  { return 1; }   // static object
    virtual std::uint32_t __stdcall release() { return 1; }

    virtual tresult __stdcall getFactoryInfo(PFactoryInfo* info)
    {
        if (info == nullptr) return kInvalidArg;
        std::memset(info, 0, sizeof(*info));
        std::strcpy(info->vendor, "Xleth Test");
        info->flags = 0;
        return kResultOk;
    }
    virtual int32 __stdcall countClasses() { return 1; }
    virtual tresult __stdcall getClassInfo(int32 index, PClassInfo* info)
    {
        if (index != 0 || info == nullptr) return kInvalidArg;
        std::memset(info, 0, sizeof(*info));
        std::memcpy(info->cid, kClassCID, 16);
        info->cardinality = 0x7FFFFFFF;
        std::strcpy(info->category, "Audio Module Class");
        std::strcpy(info->name, "XlethTestCrashOnCreate");
        return kResultOk;
    }
    virtual tresult __stdcall createInstance(const char* /*cid*/, const char* /*iid*/, void** /*obj*/)
    {
        const char* hard = std::getenv("XLETH_TEST_CRASH_HARD");
        if (hard != nullptr && hard[0] == '1')
            __fastfail(7);   // FAST_FAIL_FATAL_APP_EXIT — not catchable by __try/__except

        volatile int* p = nullptr;
        *p = 0xC0DE;          // access violation inside the plugin's factory
        return kResultOk;
    }
};

Factory g_factory;

} // namespace

extern "C" __declspec(dllexport) void* GetPluginFactory()
{
    return &g_factory;
}
