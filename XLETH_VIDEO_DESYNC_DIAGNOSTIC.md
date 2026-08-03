## Video frame desync grows with seek depth into source — XLETH Diagnostic Report

> Static analysis only. No runtime logs captured yet — the instrumentation step is listed under "What to try next".

### What we're trying to do

XLETH is a Windows YTPMV/Sparta-Remix DAW. A "region" is a user-selected slice of a video source, triggered as a sample on a timeline. When a region is triggered at source time T, the engine must decode and display the exact video frame that a normal video player would show at time T in that source file. Preview and offline render must agree frame-for-frame.

### What actually happens

The displayed frame is **earlier than the requested frame, by an amount proportional to how deep into the source file the region sits**. Sources under ~10 minutes look fine. Past ~20 minutes the error is obvious. The error does not accumulate during playback of a single clip — it is locked in at the moment of the seek, so it scales with the region's `startTime`, not with elapsed playback time.

Concrete case in the attached project: a region at `startTime = 916.7734480660205` s in a 1405.461 s source. Predicted delivered frame is 21 frames (0.876 s) early. User's subjective report was "a couple frames", which does not match the prediction — see "Open discrepancy" below.

### Environment

- OS: Windows 11
- Engine: C++ / CMake, D3D11 for frame upload, FFmpeg via vcpkg
- FFmpeg: **8.1** (`vcpkg.json` → `ffmpeg:x64-windows@8.1#2`; `LIBAVFORMAT_VERSION_MAJOR 62`, `LIBAVUTIL_VERSION_MAJOR 60`)
- UI: React (Vite), separate process, talks to engine over a bridge
- Source under test: HandBrake-encoded MP4, H.264, 1920x1080, **24000/1001 fps (23.976023976...)**, duration 1405.461 s, 33697 frames

Note: the "upgrade to FFmpeg 8.x" hypothesis is already satisfied — this build is on 8.1. FFmpeg version is not the variable here.

### Architecture Overview

```
UI (React) --bridge--> XlethEngineService
                            |
                            +-- FrameCollector          (decides WHICH source frame index is needed)
                            |        |
                            |        v
                            +-- RenderVideoDecoder      (frame index -> PTS -> av_seek_frame -> decode -> D3D11 texture)
                            |
                            +-- VideoDecoder            (older, seconds-based; used by ProjectManager / FrameServer / ProxyTranscoder)
                            +-- ProxyTranscoder         (builds preview proxies)
```

Critically, **live preview and offline render share `RenderVideoDecoder`** — `XlethEngineService.cpp:279` holds `std::unique_ptr<RenderVideoDecoder> g_previewRenderDecoder`, and `OfflineRenderer` uses the same class. So a bug in that class is not "an export bug"; it is both.

`FrameCollector` converts **time → frame index**. `RenderVideoDecoder` converts **frame index → PTS**. These two conversions are performed with different frame-rate values. That asymmetry is the core of this report.

### Code Involved

**`engine/src/render/FrameCollector.cpp`** — forward conversion, time → frame index. This is correct.

```cpp
// line 720
int64_t FrameCollector::computeSourceFrameFromTime(double sourceTimeSec, double sourceFps)
{
    const int64_t sourceTimeUs = static_cast<int64_t>(std::round(sourceTimeSec * 1000000.0));
    const int64_t fpsNum = static_cast<int64_t>(std::round(sourceFps * 1000.0));   // 23.976 -> 23976
    const int64_t fpsDen = 1000;

    int64_t frame = av_rescale(sourceTimeUs, fpsNum, fpsDen * 1000000LL);          // ~23.976 fps, OK
    if (frame < 0) frame = 0;
    return frame;
}
```

**`engine/src/render/RenderVideoDecoder.cpp`** — fps stored as a `double`, from `r_frame_rate`.

```cpp
// line 331
if (stream->r_frame_rate.den > 0)
    ctx.fps = av_q2d(stream->r_frame_rate);     // 23.976023976...  (double, rational discarded)
else
    ctx.fps = 30.0;
```

**`engine/src/render/RenderVideoDecoder.cpp`** — reverse conversion, frame index → PTS. **This is the bug.** Identical code appears twice: `seekToFrame()` at line 408 and `decodeFrame()` at line 430.

```cpp
// line 408 (seekToFrame) and line 430 (decodeFrame) — IDENTICAL
AVRational frameDur = {1, static_cast<int>(std::round(ctx.fps))};   // <-- round(23.976) == 24
int64_t targetPTS = av_rescale_q(frameIndex, frameDur, stream->time_base);
```

`std::round()` on a non-integer NTSC frame rate silently snaps 23.976 → 24 (and would snap 29.97 → 30, 59.94 → 60). `stream->start_time` is also never added, so any edit-list / non-zero-start stream is offset on top of this.

**`engine/src/render/RenderVideoDecoder.cpp`** — the error is then made permanent. `seekToFrame()` line 380:

```cpp
// Sequential fast path: if the requested frame is exactly lastDecodedFrame + 1,
// skip the seek entirely and just read forward.
if (ctx.lastDecodedFrame >= 0 && frameIndex == ctx.lastDecodedFrame + 1) {
    return true;
}
```

...and `decodeFrame()` line 489 records the frame that was **requested**, never the frame that was actually **decoded**:

```cpp
if (gotFrame) {
    ctx.lastDecodedFrame = frameIndex;   // <-- PROBLEM: frameIndex is the request, not the result.
                                         //     ctx.frame->pts was available right here and was ignored.
}
```

Consequence: once a seek lands on the wrong frame, `lastDecodedFrame` is wrong, the sequential fast path fires on every subsequent frame, and the decoder streams forward from the wrong position forever. Nothing in the loop ever compares decoded PTS against expected PTS, so the drift is never detected or corrected.

**`engine/src/VideoDecoder.cpp`** — the older seconds-based decoder has a separate, smaller rounding problem. Line 158:

```cpp
int64_t targetPTS = static_cast<int64_t>(timeSeconds / av_q2d(stream->time_base));  // truncates
// ... av_seek_frame(..., AVSEEK_FLAG_BACKWARD); avcodec_flush_buffers(...);
// then decodeUntilFrame() stops on:
if (pts >= targetPTS)
    reachedTarget = true;
```

Truncating the target and then accepting the first frame with `pts >= targetPTS` means the net behaviour is **ceil**, not floor. Any time value that is not exactly on a frame boundary yields the frame *after* the one a player would display. `stream->start_time` is likewise not added here.

**`engine/src/ProxyTranscoder.cpp`** — third independent fps source. Line 230:

```cpp
AVRational fr = (st->avg_frame_rate.num > 0 && st->avg_frame_rate.den > 0)
                    ? st->avg_frame_rate
                    : st->r_frame_rate;
```

So `ProxyTranscoder` prefers `avg_frame_rate`, `RenderVideoDecoder` uses `r_frame_rate`, and the project scanner persisted a third value into `project.json`. For a VFR source these three differ.

### Project + source data (in place of runtime logs)

From `project.json`:

```json
"sources": [{
  "id": 1,
  "fileName": "1_HANDBRAKE_SpongeBob SquarePants S09E15 ... .mp4",
  "duration": 1405.461,
  "fps": 23.976023976023978,      // <-- 24000/1001, stored as a double
  "totalFrames": 33697,
  "width": 1920, "height": 1080,
  "proxyPath": "",
  "proxyReady": true,             // <-- asserts ready with an empty path (see secondary issue)
  "previewProxyReady": false
}]

"regions": [{
  "sourceId": 1,
  "startTime": 916.7734480660205, // <-- float seconds, not a frame index
  "startFrame": 0,                // <-- never populated
  "endFrame": 0,
  "swappedAudioDurationSec": 0.479354
}]
```

Arithmetic trace for that region, replicating both code paths exactly (`time_base = 1/24000`):

```
FrameCollector:      frameIndex   = 916.7734 * 23976/1000        = 21980
RenderVideoDecoder:  targetPTS    = 21980 * 24000/24             = 21,980,000  ->  915.8333 s
correct:             targetPTS    = 21980 * 1001                 = 22,001,980  ->  916.7492 s

Real frames sit at pts = N * 1001. decodeFrame() accepts the first frame with pts >= targetPTS:
  ceil(21,980,000 / 1001) = frame 21959

REQUESTED 21980  ->  DELIVERED 21959  ->  21 frames early (0.876 s)
```

General form, for any NTSC-fractional source:

```
error_seconds = frameIndex / (fps_den_scaled)      e.g. frameIndex / 24000 for 24000/1001
error_frames  = frameIndex / 1001                  ~= 1 frame per 41.7 s of seek depth @ 23.976
                                                   ~= 1 frame per 33.4 s of seek depth @ 29.97

  seek depth    60 s  ->   -1 frames  (-0.042 s)
  seek depth   300 s  ->   -7 frames  (-0.292 s)
  seek depth   600 s  ->  -14 frames  (-0.584 s)
  seek depth   900 s  ->  -21 frames  (-0.876 s)
  seek depth  1200 s  ->  -28 frames  (-1.168 s)
  seek depth  1405 s  ->  -33 frames  (-1.376 s)
```

This curve matches the reported symptom shape exactly: invisible at short seek depths, obvious past ~20 minutes, zero at the start of the file.

### Open discrepancy (please weigh in on this)

Predicted error at 916.77 s is **21 frames / 0.876 s**. The user's subjective report was "a couple frames". These do not agree, and the report has not been reconciled by measurement yet.

Leading hypothesis: the user selected the region by scrubbing XLETH's own preview, which runs through the *same* `RenderVideoDecoder` and therefore the *same* wrong mapping. Picker and player would then cancel, leaving only a smaller second-order residual (the ceil bias, or the missing `start_time`). Under that hypothesis the 21-frame error is real but partly invisible, and would become fully visible the moment either side of the round trip is fixed in isolation — i.e. **fixing only `FrameCollector` or only `RenderVideoDecoder` would make the symptom worse, not better.** Both ends must move together.

Alternative hypotheses worth considering: `ctx.fps` is not actually 23.976 at runtime for this file (e.g. HandBrake wrote an unusual `r_frame_rate`); or a proxy with a different frame rate is substituted somewhere in the preview path and masks the arithmetic.

### What we've already tried

Nothing yet — this is the initial diagnosis, produced by static analysis plus arithmetic replication of the two conversion functions. Prior external advice was "the desync is an FFmpeg seeking bug, upgrade to FFmpeg 8.x". That advice is already satisfied: this build links FFmpeg 8.1. So FFmpeg version has been ruled out as the variable, and the observed error is fully explained by in-repo arithmetic without invoking any FFmpeg defect.

### Suspected root causes

1. **`std::round(ctx.fps)` destroys NTSC-fractional frame rates** (`RenderVideoDecoder.cpp:408` and `:430`). 23.976 → 24 gives a 1000/1001 = 0.1% error in every frame→PTS conversion. `FrameCollector` does the inverse conversion at the *correct* rate, so the round trip is asymmetric and the error is exactly proportional to `frameIndex`. Strongest hypothesis; the predicted magnitude and the "grows with depth into file" shape both match.
2. **`ctx.lastDecodedFrame = frameIndex` records the request, not the result** (`RenderVideoDecoder.cpp:489`), and the sequential fast path (`:380`) trusts it. This is what converts a one-time seek error into permanent, self-reinforcing desync with no resync path. Not the origin of the error, but the reason it is never corrected.
3. **`stream->start_time` never added to any seek target** (both decoders). HandBrake routinely writes edit lists; `av_seek_frame` operates on raw stream timestamps and does not apply them. Produces a constant offset, not drift — a good candidate for the residual "couple frames".
4. **Ceil-instead-of-floor frame selection** in `VideoDecoder::decodeUntilFrame` (truncated target + `pts >= target`). Consistent +1 frame for any non-boundary time. Also a residual-error candidate.
5. **Three independent fps sources of truth** — `r_frame_rate` (RenderVideoDecoder), `avg_frame_rate` (ProxyTranscoder), and a persisted double in `project.json`. These diverge on VFR sources.
6. **Source may be genuinely VFR.** HandBrake DVD/Blu-ray rips are frequently VFR. If `r_frame_rate != avg_frame_rate` for this file, no constant-fps model can be correct at all and a PTS index is mandatory rather than optional. Unverified — needs an `ffprobe` check on the original.

### Key files for the reader to examine

- `engine/src/render/RenderVideoDecoder.cpp` — lines 331, 380, 408, 430, 489 (primary)
- `engine/src/render/FrameCollector.cpp` — line 720 (`computeSourceFrameFromTime`), lines 170/194/246 (call sites)
- `engine/src/VideoDecoder.cpp` — lines 152–265 (`seekAndDecode`, `decodeUntilFrame`)
- `engine/src/ProxyTranscoder.cpp` — line 230 (fps derivation), lines 846–880 (encoder time_base)
- `engine/src/XlethEngineService.cpp` — line 279 (`g_previewRenderDecoder`), line 4334 (construction)

### What to try next

1. **Measure before changing anything.** In `decodeFrame()`, log `frameIndex`, `targetPTS`, the actual `ctx.frame->pts`, and `stream->time_base`. Scrub to 916.77 s in the attached project. If `pts / 1001` reads 21959 against a requested 21980, hypothesis 1 is confirmed end to end. If it reads ~21978, hypothesis 1 is being masked and the residual must be chased instead.
2. **Confirm CFR vs VFR on the original.** `ffprobe -v error -show_entries stream=r_frame_rate,avg_frame_rate,time_base,start_time,nb_frames -select_streams v "<source>.mp4"`. If `r_frame_rate != avg_frame_rate`, skip to step 6 — steps 3–5 are necessary but not sufficient.
3. **Carry the rational, delete the double.** Replace `double ctx.fps` with `AVRational ctx.frameRate`, populated as `avg_frame_rate` if valid else `r_frame_rate`. Then at both line 408 and line 430:
   ```cpp
   int64_t targetPTS = av_rescale_q(frameIndex, av_inv_q(ctx.frameRate), stream->time_base);
   if (stream->start_time != AV_NOPTS_VALUE) targetPTS += stream->start_time;
   ```
   Factor this into one helper so the two call sites cannot drift apart again.
4. **Make `lastDecodedFrame` honest.** Derive it from the decoded PTS instead of the request:
   ```cpp
   const int64_t base = (stream->start_time != AV_NOPTS_VALUE) ? stream->start_time : 0;
   ctx.lastDecodedFrame = av_rescale_q(pts - base, stream->time_base, av_inv_q(ctx.frameRate));
   ```
   The sequential fast path then becomes safe rather than load-bearing, and a wrong seek self-corrects on the next request.
5. **One fps authority.** Persist `{num, den}` in `project.json` and have every module read that single value. Fix `FrameCollector::computeSourceFrameFromTime` to take the `AVRational` too, so both directions of the round trip use bit-identical arithmetic. Add a unit test that asserts `frameToPts(ptsToFrame(p)) == p` across the full 33697-frame range for a 24000/1001 stream — this bug would have been caught by that test at frame 1001.
6. **If and only if the source is VFR: build a demux-only PTS index.** On first open, run `av_read_frame` over the video stream recording `pkt->pts`, discarding every packet without decoding. No decode means this runs at disk speed rather than decode speed — seconds for a 1.4 GB MP4, not minutes — so it can be unconditional rather than an opt-in feature. Persist the table keyed on file size + mtime. Frame lookup becomes a binary search over exact timestamps and is then correct independent of FFmpeg version, container, and frame-rate metadata. (Note: a decode-based index is the commonly suggested approach here and is what makes people gate it behind a toggle; demuxing alone is sufficient, because packet PTS is exactly what the seek target needs to match.)

### Secondary issue found while investigating (separate bug, same root category)

`EAT/proxies/1_HANDBRAKE_....preview.720p.mov.tmp` is a **1.4 GB file with no `moov` atom** — `ffprobe` reports `moov atom not found`. The transcode was never finalized and the file was never renamed off `.tmp`. Meanwhile `project.json` records `"proxyReady": true` alongside `"proxyPath": ""`.

Root category is the same as bug 2 above: a state flag asserting a fact that nothing ever validated against the artifact. Recommend that `proxyReady` be computed from a probe of the artifact (openable + non-empty `proxyPath` + `moov` present) rather than set by the code path that *started* the transcode, and that the transcoder write to `.tmp` then atomically rename only on successful `av_write_trailer`.
