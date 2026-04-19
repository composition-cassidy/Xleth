#pragma once

// ─── PluginCrashGuard ───────────────────────────────────────────────────────
// Structured Exception Handling (SEH) wrapper for third-party VST plugin calls.
//
// Third-party VST3 plugins are untrusted native code: any callback (processBlock,
// createEditor, get/setStateInformation, even prepareToPlay) may raise an access
// violation, divide-by-zero, or other SEH exception.  On the audio thread, such
// a fault would normally take down the entire engine (and the Electron app).
//
// Usage:
//     if (!pluginGuardCall([&]{ plugin->processBlock(buffer, midi); }))
//         handleCrash();   // plugin faulted — contain and mark bypassed
//
// CRITICAL CONSTRAINT (MSVC):
//   C++ objects with non-trivial destructors cannot be constructed inside
//   __try blocks.  The template body only references `fn` (a reference — no
//   destruction), and invokes it.  The caller's lambda object lives in the
//   caller's scope, not inside __try, so its captures are not affected.
//   The return value is a primitive (bool) with trivial destruction.
//
// Xleth is Windows-only and built with MSVC.  The non-MSVC fallback exists
// only so the translation unit compiles in non-Windows CI checks.

#ifdef _MSC_VER
  // Prevent <windows.h> from polluting std::min / std::max, and skip the large
  // set of RPC/Winsock/etc. headers we do not use.  Both macros must be defined
  // before every <windows.h> include — we force them here so anyone who pulls
  // in this guard header transitively gets clean min/max.
  #ifndef NOMINMAX
    #define NOMINMAX
  #endif
  #ifndef WIN32_LEAN_AND_MEAN
    #define WIN32_LEAN_AND_MEAN
  #endif
  #include <windows.h>   // for EXCEPTION_EXECUTE_HANDLER
#endif

namespace xleth
{

#ifdef _MSC_VER

template <typename Func>
inline bool pluginGuardCall(Func&& fn) noexcept
{
    __try
    {
        fn();
        return true;
    }
    __except (EXCEPTION_EXECUTE_HANDLER)
    {
        return false;
    }
}

#else   // non-MSVC: pass-through (never exercised — Xleth is Windows-only)

template <typename Func>
inline bool pluginGuardCall(Func&& fn) noexcept
{
    fn();
    return true;
}

#endif

} // namespace xleth
