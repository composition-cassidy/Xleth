// test_device_watchdog.cpp -- audio device-health watchdog policy probes.
//
// Covers the recovery path added for the sleep/resume failure: after a suspend,
// WASAPI invalidates the render client, so audioDeviceIOCallbackWithContext
// stops firing while juce::AudioDeviceManager still reports a healthy-looking
// device. The watchdog detects that by watching the callback counter go stale.
//
// These tests drive AudioEngine::shouldAttemptRecovery -- the exact policy
// function checkDeviceHealth() calls -- so no audio hardware is required.
//
// Build: cmake --build build --target test_device_watchdog --config Release
// Run:   build\engine\Release\test_device_watchdog.exe

#include "AudioEngine.h"

#include <juce_gui_basics/juce_gui_basics.h>

#include <iostream>
#include <memory>

static int g_passed = 0;
static int g_failed = 0;

#define CHECK(cond, msg)                                                      \
    do {                                                                      \
        if (cond) {                                                           \
            ++g_passed;                                                       \
        } else {                                                              \
            std::cerr << "  FAIL [" << __LINE__ << "] " << msg << "\n";       \
            ++g_failed;                                                       \
        }                                                                     \
    } while (0)

using Inputs = AudioEngine::WatchdogInputs;

// A device that is running normally: the counter moves every poll.
static void testHealthyDeviceIsNeverReopened()
{
    Inputs in;
    in.counterMoved    = true;
    in.msSinceProgress = 0;
    CHECK(!AudioEngine::shouldAttemptRecovery(in),
          "a callback that ran since the last poll must never trigger a reopen");

    // Even a long-lived session must not accumulate into a false positive as
    // long as the callback keeps reporting progress.
    in.msSinceProgress = 60 * 60 * 1000;
    CHECK(!AudioEngine::shouldAttemptRecovery(in),
          "counterMoved must dominate however old the previous progress stamp is");
}

// The core regression: a frozen counter past the starvation window.
static void testStarvedCallbackTriggersRecovery()
{
    Inputs in;
    in.counterMoved    = false;
    in.msSinceProgress = 500;
    CHECK(AudioEngine::shouldAttemptRecovery(in),
          "a callback frozen for the full starvation window must trigger a reopen");

    in.msSinceProgress = 5000;
    CHECK(AudioEngine::shouldAttemptRecovery(in),
          "a long-dead callback must still trigger a reopen");
}

// A scheduling hiccup or a poll landing between two buffers is not a dead
// device. The largest buffer period the engine ever opens is 512 @ 44100 Hz
// (~11.6 ms), so everything below that must be treated as healthy.
static void testTransientGapIsNotRecovered()
{
    Inputs in;
    in.counterMoved = false;

    for (int64_t gapMs : { int64_t{0}, int64_t{12}, int64_t{50},
                           int64_t{200}, int64_t{499} })
    {
        in.msSinceProgress = gapMs;
        CHECK(!AudioEngine::shouldAttemptRecovery(in),
              "gap of " << gapMs << " ms must not be read as a dead device");
    }
}

// Export detaches the callback on purpose via suspendCallback(). The watchdog
// must not fight it by reopening the device mid-render.
static void testSuspendedCallbackIsNeverRecovered()
{
    Inputs in;
    in.suspended       = true;
    in.counterMoved    = false;
    in.msSinceProgress = 10 * 60 * 1000; // a long export

    CHECK(!AudioEngine::shouldAttemptRecovery(in),
          "a deliberately suspended callback must never trigger a reopen");

    // Not even when a resume event lands during the export.
    in.resumeArmed = true;
    CHECK(!AudioEngine::shouldAttemptRecovery(in),
          "suspend must outrank a resume signal");
}

// After a system resume the device is very likely already gone, so the watchdog
// reacts on a shortened window -- but still long enough to clear one buffer.
static void testResumeShortensTheStarvationWindow()
{
    Inputs in;
    in.counterMoved    = false;
    in.resumeArmed     = true;
    in.msSinceProgress = 150;
    CHECK(AudioEngine::shouldAttemptRecovery(in),
          "post-resume starvation must be actioned at the shortened window");

    // The same age without a resume signal is still within the normal window.
    in.resumeArmed = false;
    CHECK(!AudioEngine::shouldAttemptRecovery(in),
          "the shortened window must apply only when a resume was observed");

    // The shortened window must not collapse to zero, or a poll landing between
    // two healthy buffers right after resume would reopen a working device.
    in.resumeArmed     = true;
    in.msSinceProgress = 20;
    CHECK(!AudioEngine::shouldAttemptRecovery(in),
          "one buffer period after resume must not be read as a dead device");
}

// When no device can be opened at all (interface unplugged for good), the
// watchdog must stop churning rather than reopening on every 250 ms poll.
static void testBackoffSuppressesRetries()
{
    Inputs in;
    in.counterMoved    = false;
    in.msSinceProgress = 5000;

    in.msUntilNextAttempt = 1800;
    CHECK(!AudioEngine::shouldAttemptRecovery(in),
          "a pending backoff must suppress the retry");

    in.msUntilNextAttempt = 0;
    CHECK(AudioEngine::shouldAttemptRecovery(in),
          "an elapsed backoff must allow the next retry");

    in.msUntilNextAttempt = -500; // deadline already passed
    CHECK(AudioEngine::shouldAttemptRecovery(in),
          "a backoff deadline in the past must allow the next retry");

    // Backoff must not override a healthy device either way.
    in.counterMoved       = true;
    in.msUntilNextAttempt = 0;
    CHECK(!AudioEngine::shouldAttemptRecovery(in),
          "backoff bookkeeping must not resurrect a reopen for a live callback");
}

// An engine that never opened a device (the state every headless test fixture
// is in) must be inert -- checkDeviceHealth() must not touch the device manager.
static void testUninitialisedEngineIsInert()
{
    // Heap-allocated: AudioEngine embeds MixEngine and friends and overflows a
    // default 1 MB thread stack as a local.
    auto engine = std::make_unique<AudioEngine>();

    for (int i = 0; i < 8; ++i)
        CHECK(!engine->checkDeviceHealth(),
              "an uninitialised engine must never attempt a device reopen");

    // The resume signal must be equally inert before initialize().
    engine->notifySystemResume();
    CHECK(!engine->checkDeviceHealth(),
          "a resume signal must not reopen a device on an uninitialised engine");
}

int main()
{
    // AudioEngine owns a juce::AudioDeviceManager, which needs the JUCE
    // subsystems up before it can be constructed.
    juce::ScopedJuceInitialiser_GUI juceInit;

    std::cout << "=== Device watchdog policy ===\n";

    testHealthyDeviceIsNeverReopened();
    testStarvedCallbackTriggersRecovery();
    testTransientGapIsNotRecovered();
    testSuspendedCallbackIsNeverRecovered();
    testResumeShortensTheStarvationWindow();
    testBackoffSuppressesRetries();
    testUninitialisedEngineIsInert();

    std::cout << "passed: " << g_passed << "  failed: " << g_failed << "\n";
    return g_failed == 0 ? 0 : 1;
}
