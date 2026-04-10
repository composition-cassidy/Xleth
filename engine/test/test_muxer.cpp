// test_muxer.cpp — Verifies FFmpegMuxer with built-in mpeg4 + aac encoders.
// Generates 1 second of 320x240 30fps solid-color video + 440Hz sine audio,
// muxes to MP4, then probes the output to verify stream counts and duration.

#include "export/FFmpegMuxer.h"

extern "C" {
#include <libavformat/avformat.h>
#include <libavutil/mathematics.h>
}

// Force assert even in Release builds (NDEBUG is defined)
#undef NDEBUG
#include <cassert>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <vector>

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

static constexpr int WIDTH  = 320;
static constexpr int HEIGHT = 240;
static constexpr int FPS    = 30;
static constexpr int SR     = 48000;
static constexpr int DURATION_SEC = 1;
static constexpr double FREQ = 440.0;

int main()
{
    std::fprintf(stderr, "\n[TEST:Muxer] Starting muxer tests...\n");

    std::string outPath  = "test_muxer_output.mp4";
    std::string fragPath = "test_muxer_frag.mp4";

    // ── Test 1: Basic A/V mux (1 second) ────────────────────────────────────
    {
        std::fprintf(stderr, "\n[TEST:Muxer] --- Test 1: Basic A/V mux ---\n");

        ExportSettings s;
        s.outputPath   = outPath;
        s.videoCodec   = ExportSettings::VideoCodec::MPEG4;   // always built-in
        s.width        = WIDTH;
        s.height       = HEIGHT;
        s.fpsNum       = FPS;
        s.fpsDen       = 1;
        s.crf          = -1;           // disable CRF, use bitrate
        s.videoBitrate = 500000;       // 500 kbps
        s.audioCodec   = ExportSettings::AudioCodec::AAC;
        s.sampleRate   = SR;
        s.audioBitrate = 128;          // kbps

        FFmpegMuxer muxer;
        assert(muxer.init(s) && "init should succeed");

        std::fprintf(stderr, "[TEST:Muxer] Video encoder: %s\n", muxer.videoEncoderName());
        std::fprintf(stderr, "[TEST:Muxer] Audio encoder: %s\n", muxer.audioEncoderName());

        // Generate BGRA pixels: solid green
        std::vector<uint8_t> bgra(static_cast<size_t>(WIDTH) * HEIGHT * 4);
        for (int i = 0; i < WIDTH * HEIGHT; ++i) {
            bgra[i * 4 + 0] = 0;      // B
            bgra[i * 4 + 1] = 255;    // G
            bgra[i * 4 + 2] = 0;      // R
            bgra[i * 4 + 3] = 255;    // A
        }

        // Generate audio: 440 Hz sine wave, stereo, 48000 Hz
        const int totalSamples = SR * DURATION_SEC;
        std::vector<float> audioL(totalSamples);
        std::vector<float> audioR(totalSamples);
        for (int i = 0; i < totalSamples; ++i) {
            float v = static_cast<float>(std::sin(2.0 * M_PI * FREQ * i / SR)) * 0.5f;
            audioL[i] = v;
            audioR[i] = v;
        }

        // Write interleaved: 1 video frame + corresponding audio chunk per iteration
        const int totalFrames = FPS * DURATION_SEC;
        const int samplesPerFrame = SR / FPS;  // 1600
        int audioPos = 0;

        for (int f = 0; f < totalFrames; ++f) {
            // Write video frame
            assert(muxer.writeVideo(bgra.data(), WIDTH * 4, f));

            // Write corresponding audio chunk
            const float* ch[2] = { audioL.data() + audioPos,
                                    audioR.data() + audioPos };
            int n = std::min(samplesPerFrame, totalSamples - audioPos);
            assert(muxer.writeAudio(ch, n, audioPos));
            audioPos += n;
        }

        // Write any remaining audio samples
        if (audioPos < totalSamples) {
            const float* ch[2] = { audioL.data() + audioPos,
                                    audioR.data() + audioPos };
            assert(muxer.writeAudio(ch, totalSamples - audioPos, audioPos));
        }

        assert(muxer.finalize() && "finalize should succeed");

        // Verify file exists and has non-zero size
        assert(std::filesystem::exists(outPath));
        auto fileSize = std::filesystem::file_size(outPath);
        std::fprintf(stderr, "[TEST:Muxer] Output file: %llu bytes\n",
                     (unsigned long long)fileSize);
        assert(fileSize > 0 && "Output file should have non-zero size");

        std::fprintf(stderr, "[TEST:Muxer] Test 1: PASSED\n");
    }

    // ── Test 2: Probe output file ───────────────────────────────────────────
    {
        std::fprintf(stderr, "\n[TEST:Muxer] --- Test 2: Probe output ---\n");

        AVFormatContext* probeFmt = nullptr;
        int ret = avformat_open_input(&probeFmt, outPath.c_str(), nullptr, nullptr);
        assert(ret == 0 && "avformat_open_input should succeed");

        ret = avformat_find_stream_info(probeFmt, nullptr);
        assert(ret >= 0 && "avformat_find_stream_info should succeed");

        std::fprintf(stderr, "[TEST:Muxer] Streams: %d\n", probeFmt->nb_streams);
        assert(probeFmt->nb_streams == 2 && "Should have exactly 2 streams");

        bool hasVideo = false, hasAudio = false;
        for (unsigned i = 0; i < probeFmt->nb_streams; ++i) {
            AVStream* st = probeFmt->streams[i];
            if (st->codecpar->codec_type == AVMEDIA_TYPE_VIDEO) {
                hasVideo = true;
                std::fprintf(stderr, "[TEST:Muxer] Video: %dx%d codec_id=%d\n",
                             st->codecpar->width, st->codecpar->height,
                             st->codecpar->codec_id);
                assert(st->codecpar->width == WIDTH);
                assert(st->codecpar->height == HEIGHT);
            } else if (st->codecpar->codec_type == AVMEDIA_TYPE_AUDIO) {
                hasAudio = true;
                std::fprintf(stderr, "[TEST:Muxer] Audio: %d Hz, %d ch, codec_id=%d\n",
                             st->codecpar->sample_rate,
                             st->codecpar->ch_layout.nb_channels,
                             st->codecpar->codec_id);
                assert(st->codecpar->sample_rate == SR);
                assert(st->codecpar->ch_layout.nb_channels == 2);
            }
        }
        assert(hasVideo && "Must have video stream");
        assert(hasAudio && "Must have audio stream");

        // Check duration is approximately 1 second
        double duration = static_cast<double>(probeFmt->duration) / AV_TIME_BASE;
        std::fprintf(stderr, "[TEST:Muxer] Duration: %.3f sec\n", duration);
        assert(duration > 0.8 && duration < 1.5 && "Duration should be ~1 second");

        avformat_close_input(&probeFmt);

        std::fprintf(stderr, "[TEST:Muxer] Test 2: PASSED\n");
    }

    // ── Test 3: Fragmented MP4 ──────────────────────────────────────────────
    {
        std::fprintf(stderr, "\n[TEST:Muxer] --- Test 3: Fragmented MP4 ---\n");

        ExportSettings s;
        s.outputPath    = fragPath;
        s.videoCodec    = ExportSettings::VideoCodec::MPEG4;
        s.width         = WIDTH;
        s.height        = HEIGHT;
        s.fpsNum        = FPS;
        s.fpsDen        = 1;
        s.crf           = -1;
        s.videoBitrate  = 500000;
        s.audioCodec    = ExportSettings::AudioCodec::AAC;
        s.sampleRate    = SR;
        s.audioBitrate  = 128;
        s.fragmentedMP4 = true;

        FFmpegMuxer muxer;
        assert(muxer.init(s) && "fragmented init should succeed");

        // Write just 5 frames
        std::vector<uint8_t> bgra(static_cast<size_t>(WIDTH) * HEIGHT * 4, 128);
        std::vector<float> silence(1600, 0.0f);
        const float* ch[2] = { silence.data(), silence.data() };

        for (int f = 0; f < 5; ++f) {
            assert(muxer.writeVideo(bgra.data(), WIDTH * 4, f));
            assert(muxer.writeAudio(ch, 1600, f * 1600));
        }
        assert(muxer.finalize() && "fragmented finalize should succeed");

        // Probe: should still have 2 streams
        AVFormatContext* probeFmt = nullptr;
        assert(avformat_open_input(&probeFmt, fragPath.c_str(), nullptr, nullptr) == 0);
        assert(avformat_find_stream_info(probeFmt, nullptr) >= 0);
        std::fprintf(stderr, "[TEST:Muxer] Fragmented streams: %d\n", probeFmt->nb_streams);
        assert(probeFmt->nb_streams == 2 && "Fragmented MP4 should have 2 streams");
        avformat_close_input(&probeFmt);

        std::fprintf(stderr, "[TEST:Muxer] Test 3: PASSED\n");
    }

    // ── Test 4: shouldWriteVideo interleaving ───────────────────────────────
    {
        std::fprintf(stderr, "\n[TEST:Muxer] --- Test 4: shouldWriteVideo ---\n");

        std::string path4 = "test_muxer_interleave.mp4";
        ExportSettings s;
        s.outputPath   = path4;
        s.videoCodec   = ExportSettings::VideoCodec::MPEG4;
        s.width        = WIDTH;
        s.height       = HEIGHT;
        s.fpsNum       = FPS;
        s.fpsDen       = 1;
        s.crf          = -1;
        s.videoBitrate = 500000;
        s.audioCodec   = ExportSettings::AudioCodec::AAC;
        s.sampleRate   = SR;
        s.audioBitrate = 128;

        FFmpegMuxer muxer;
        assert(muxer.init(s));

        // Initially video should be behind
        assert(muxer.shouldWriteVideo() && "Initially should write video");

        std::vector<uint8_t> bgra(static_cast<size_t>(WIDTH) * HEIGHT * 4, 100);
        std::vector<float> audio(SR, 0.0f);
        const float* ch[2] = { audio.data(), audio.data() };

        // Use shouldWriteVideo to drive interleaving for 10 frames
        int videoFrames = 0, audioChunks = 0;
        int audioPos = 0;
        const int samplesPerFrame = SR / FPS;

        for (int i = 0; i < 30; ++i) {
            if (muxer.shouldWriteVideo()) {
                assert(muxer.writeVideo(bgra.data(), WIDTH * 4, videoFrames));
                ++videoFrames;
            } else {
                int n = std::min(samplesPerFrame, static_cast<int>(audio.size()) - audioPos);
                if (n > 0) {
                    const float* chp[2] = { audio.data() + audioPos, audio.data() + audioPos };
                    assert(muxer.writeAudio(chp, n, audioPos));
                    audioPos += n;
                    ++audioChunks;
                }
            }
        }

        std::fprintf(stderr, "[TEST:Muxer] Interleaved: %d video frames, %d audio chunks\n",
                     videoFrames, audioChunks);
        assert(videoFrames > 0 && audioChunks > 0 && "Both streams should have data");

        assert(muxer.finalize());
        std::filesystem::remove(path4);

        std::fprintf(stderr, "[TEST:Muxer] Test 4: PASSED\n");
    }

    // ── Cleanup ─────────────────────────────────────────────────────────────
    std::filesystem::remove(outPath);
    std::filesystem::remove(fragPath);

    std::fprintf(stderr, "\n[TEST:Muxer] ALL TESTS PASSED\n");
    std::_Exit(0);
}
