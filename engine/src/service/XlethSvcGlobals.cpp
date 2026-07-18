// XlethSvcGlobals.cpp — the ONE definition of every engine-service global.
//
// S2 Stage 1. Every name below used to be a variable in the XlethEngineService.cpp
// anonymous namespace, or one of the five scattered file-scope static clusters.
// They are defined here, exactly once, in their original relative order.
//
// DO NOT reorder and DO NOT split these definitions across translation units.
// The order is the static construction order; reverse of it is the static
// destruction order, which is the backstop to XlethEngineService::Shutdown()
// (juceInit destroyed last for COM; g_videoRenderer/syncManager torn down before
// the g_timeline/MixEngine/g_gpuDevice/frameCache they reference). See
// docs/S2_SPLIT_PLAN.md §2c.
//
// Order authority: main @8818117's XlethEngineService.cpp. Each definition below
// carries the line it came from, so the order is auditable against that file.

#include "service/XlethSvcGlobals.h"

namespace xleth::svc {

// ── Main block (was: anonymous namespace, XlethEngineService.cpp 169–656) ──
std::unique_ptr<juce::ScopedJuceInitialiser_GUI> juceInit;            // 174

std::unique_ptr<SampleBank>  sampleBank;                             // 176
std::unique_ptr<AudioEngine> audioEngine;                            // 177
std::unique_ptr<FrameCache>  frameCache;                             // 178

std::unique_ptr<WaveformMipmapCache> g_mipmapCache;                  // 182

std::unique_ptr<Timeline>       g_timeline;                          // 185
std::unique_ptr<UndoManager>    g_undoManager;                       // 186
std::unique_ptr<ProjectManager> g_projectManager;                    // 187

std::unique_ptr<FrameServer> g_frameServer;                          // 190

std::deque<std::unique_ptr<VideoDecoder>> decoderOwner;              // 199
std::vector<VideoDecoder*>                decoderPtrs;               // 200

std::unordered_map<int, std::unique_ptr<VideoDecoder>> regionDecoderOwner;  // 207
std::unordered_map<int, VideoDecoder*>                 regionDecoderPtrs;   // 208

std::unique_ptr<ProxyManager> g_proxyManager;                        // 210

std::unique_ptr<SyncManager> syncManager;                            // 212

std::thread       videoThread;                                       // 215
std::atomic<bool> videoRunning{false};                               // 216
std::atomic<uint64_t> videoThreadCompletedTicks{0};                  // 217
std::atomic<bool> g_previewDirty{false};                             // 218
std::atomic<uint64_t> g_latestStoppedPreviewSeq{0};                  // 219
std::atomic<uint64_t> g_pendingStoppedPreviewSeq{0};                 // 220
std::atomic<uint64_t> g_publishedStoppedPreviewSeq{0};               // 221
std::atomic<uint64_t> g_discardedStoppedPreviewSeq{0};               // 222
std::atomic<int64_t>  g_pendingStoppedPreviewSample{0};              // 223

std::mutex syncEventsMutex;                                          // 227

FrameOutput frameOutput;                                             // 230

std::unique_ptr<GpuDeviceManager> g_gpuDevice;                       // 233

std::unique_ptr<GridCompositor>     g_previewCompositor;             // 236
std::unique_ptr<RenderFrameCache>   g_previewRenderCache;            // 237
std::unique_ptr<RenderVideoDecoder> g_previewRenderDecoder;          // 238
std::unique_ptr<AnimationManager>   g_previewAnimMgr;                // 239
std::unique_ptr<FrameCollector>     g_previewCollector;              // 240

// Must stay AFTER g_previewCompositor — it observes that object's render target
// (see the declaration-order note in XlethSvcGlobals.h).
xleth::TransitionFreezeState        g_previewTransitionFreeze;       // 245

std::mutex          g_previewCompositorMutex;                        // 247
std::atomic<bool>   g_previewCompositorReady{false};                 // 248
std::atomic<bool>   g_previewPauseForExport{false};                  // 249
std::atomic<bool>   g_previewPauseForVisibility{false};              // 250
std::atomic<bool>   g_previewPauseForPosterLoad{false};              // 256

PreviewDiagCounters g_previewDiag;                                   // 355

std::unique_ptr<HwEncoderDetector> g_hwEncoderDetector;              // 417

float g_previewResolutionScale = 1.0f;                               // 428
bool  g_previewEffectsBypass   = false;                              // 429
bool  g_previewPosterMode      = true;                               // 435

// Poster prepass cluster — must stay contiguous, and g_posterPrepassMtx must
// stay FIRST so it outlives the four it guards (reverse-order destruction).
std::mutex g_posterPrepassMtx;                                       // 442
int        g_posterPrepassTotal     = 0;                             // 443
int        g_posterPrepassCompleted = 0;                             // 444
std::atomic<bool> g_posterPrepassActive{false};                      // 445
std::unordered_set<long long> g_posterPrepassPending;                // 454

int   g_previewProxyTargetHeight = 720;                              // 462

std::unordered_map<int, ScalerEntry> scalerCache;                    // 470

std::mutex    statsMutex;                                            // 635
StatsSnapshot statsSnapshot;                                         // 636

std::mutex                   g_exportStateMutex;                     // 646
ExportProgressSnapshot       g_exportProgress;                       // 647
std::atomic<bool>            g_exportCancel{false};                  // 648
std::atomic<bool>            g_exportRunning{false};                 // 649
std::unique_ptr<std::thread> g_exportThread;                         // 650

std::unique_ptr<OfflineRenderer> g_videoRenderer;                    // 653
std::atomic<bool>                g_audioSuspendedForExport{false};   // 654

// ── Audio-health diagnostic trace statics (was: anon namespace @ 678–687) ──
std::mutex   g_audioTraceMutex;                                      // 680
std::ofstream g_audioTraceFile;                                      // 681
bool         g_audioTraceInit = false;                               // 682

std::thread       g_audioHealthThread;                               // 684
std::atomic<bool> g_audioHealthStop{false};                          // 685

// ── Poster/proxy/thumbnail self-heal sets (was: file-scope statics @ 1589–1619)
std::unordered_set<int> g_posterEnqueued;                            // 1589
std::unordered_set<int> g_proxyEnqueuedRegions;                      // 1597
std::unordered_map<int,int> g_genFailCount;                          // 1608
std::unordered_set<int>     g_genDisabled;                           // 1609
std::unordered_set<long long> g_thumbnailEnqueued;                   // 1614
std::unordered_set<int> g_sourcePreviewEnqueued;                     // 1619

// ── Audio performance capture statics (was: anon namespace @ 11003–11009) ──
std::mutex g_audioPerformanceCaptureMutex;                           // 11003
AudioPerformanceCaptureState g_audioPerformanceCapture;              // 11004
nlohmann::json g_lastAudioPerformanceCaptureReport;                  // 11005
std::string g_lastAudioPerformanceCaptureJsonPath;                   // 11006
std::string g_lastAudioPerformanceCaptureMarkdownPath;               // 11007
std::thread g_audioPerformanceCaptureDrainThread;                    // 11008
std::atomic<bool> g_audioPerformanceCaptureDrainStop{false};         // 11009

// ── Main window HWND (was: file-scope static @ 13367) ──────────────────────
#ifdef _WIN32
std::atomic<uintptr_t> g_mainXlethHwnd{0};                           // 13367
#endif

}  // namespace xleth::svc
