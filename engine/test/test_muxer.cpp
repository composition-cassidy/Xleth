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
#include <cstdint>
#include <string>
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

// One demuxed packet, reduced to what has to match between two encodes of the
// same input: which stream it belongs to, its timestamps, and its bytes.
struct ProbedPacket {
    int                  streamIndex = -1;
    int64_t              pts         = 0;
    int64_t              dts         = 0;
    std::vector<uint8_t> data;
};

// Read every packet out of `path` in file order. Used by Test 6 to compare the
// serial and pipelined encodes byte-for-byte.
static std::vector<ProbedPacket> probePackets(const std::string& path)
{
    std::vector<ProbedPacket> out;
    AVFormatContext* fmt = nullptr;
    if (avformat_open_input(&fmt, path.c_str(), nullptr, nullptr) < 0)
        return out;
    if (avformat_find_stream_info(fmt, nullptr) < 0) {
        avformat_close_input(&fmt);
        return out;
    }
    AVPacket* pkt = av_packet_alloc();
    while (av_read_frame(fmt, pkt) >= 0) {
        ProbedPacket p;
        p.streamIndex = pkt->stream_index;
        p.pts         = pkt->pts;
        p.dts         = pkt->dts;
        p.data.assign(pkt->data, pkt->data + pkt->size);
        out.push_back(std::move(p));
        av_packet_unref(pkt);
    }
    av_packet_free(&pkt);
    avformat_close_input(&fmt);
    return out;
}

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

    // ── Test 5: Rate-control resolution (pure, no encoder needed) ────────────
    {
        std::fprintf(stderr, "\n[TEST:Muxer] --- Test 5: resolveRateControl ---\n");
        using RC = ExportSettings::RateControl;

        // (a) Software CRF mode → libx264 sets the "crf" private option, no bitrate.
        {
            ExportSettings s;
            s.rateControl = RC::CRF;
            s.crf = 18;
            s.videoBitrate = 0;
            ResolvedRateControl r = resolveRateControl("libx264", s);
            assert(!r.bitrateMode && "CRF mode should not be bitrate mode");
            assert(r.setCrfPrivOpt && r.crf == 18 && "libx264 should set crf=18");
            assert(r.bitrate == 0 && "CRF mode must not set a bitrate for libx264");
        }

        // (b) Bitrate mode → bitrate honored, CRF never applied (the core bug).
        {
            ExportSettings s;
            s.rateControl = RC::Bitrate;
            s.crf = 23;               // default leak — must be ignored in bitrate mode
            s.videoBitrate = 20'000'000;
            ResolvedRateControl r = resolveRateControl("libx264", s);
            assert(r.bitrateMode && "Bitrate mode flag");
            assert(!r.setCrfPrivOpt && "Bitrate mode must NOT set crf");
            assert(r.bitrate == 20'000'000 && "Requested bitrate must survive");
        }

        // (c) Bitrate mode with 0 → resolution-scaled default, never proxy-grade.
        {
            ExportSettings s;
            s.rateControl = RC::Bitrate;
            s.videoBitrate = 0;
            s.width = 1920; s.height = 1080; s.fpsNum = 30; s.fpsDen = 1;
            ResolvedRateControl r = resolveRateControl("libx264", s);
            assert(r.bitrate >= 2'000'000 && "Default bitrate must be sane (>=2 Mbps)");
        }

        // (d) NVENC CRF mode → constqp + qp (no fake "crf" private option).
        {
            ExportSettings s;
            s.rateControl = RC::CRF;
            s.crf = 20;
            ResolvedRateControl r = resolveRateControl("h264_nvenc", s);
            assert(!r.setCrfPrivOpt && "NVENC must not pretend to support crf");
            assert(r.rcModeKey && std::strcmp(r.rcModeKey, "rc") == 0);
            assert(r.rcModeVal && std::strcmp(r.rcModeVal, "constqp") == 0);
            assert(r.qpOptKey && std::strcmp(r.qpOptKey, "qp") == 0 && r.qpValue == 20);
        }

        // (e) AMF CRF mode → cqp + triple QP.
        {
            ExportSettings s;
            s.rateControl = RC::CRF;
            s.crf = 22;
            ResolvedRateControl r = resolveRateControl("h264_amf", s);
            assert(!r.setCrfPrivOpt);
            assert(r.qpOptKey && std::strcmp(r.qpOptKey, "qp_i") == 0 && r.qpValue == 22);
            assert(r.amfTripleQp && "AMF should also set qp_p/qp_b");
        }

        // (f) QSV CRF mode → ICQ via global_quality.
        {
            ExportSettings s;
            s.rateControl = RC::CRF;
            s.crf = 24;
            ResolvedRateControl r = resolveRateControl("h264_qsv", s);
            assert(r.useGlobalQuality && r.globalQuality == 24);
        }

        // (g) Legacy crf<0 sentinel still means "use bitrate" even in CRF mode.
        {
            ExportSettings s;
            s.rateControl = RC::CRF;
            s.crf = -1;
            s.videoBitrate = 500'000;
            ResolvedRateControl r = resolveRateControl("libx264", s);
            assert(r.bitrateMode && r.bitrate == 500'000 && "crf<0 sentinel → bitrate");
        }

        // (h) No-CRF codec (mpeg4) in CRF mode → falls back to a sane bitrate.
        {
            ExportSettings s;
            s.rateControl = RC::CRF;
            s.crf = 18;
            s.videoBitrate = 0;
            s.width = 1920; s.height = 1080; s.fpsNum = 30; s.fpsDen = 1;
            ResolvedRateControl r = resolveRateControl("mpeg4", s);
            assert(r.bitrateMode && r.bitrate >= 2'000'000 && "mpeg4 CRF→default bitrate");
        }

        std::fprintf(stderr, "[TEST:Muxer] Test 5: PASSED\n");
    }

    // ── Test 6: async video encode is bit-identical to the serial path ──────
    // RENDER_PERF_AUDIT Finding 6a moves [convert + encode + mux] onto a worker
    // thread. The whole point of the bounded FIFO is that the encoder still
    // receives the same frames in the same order, so the two runs must produce
    // byte-identical packets. Anything else means the split reordered or
    // dropped a frame.
    {
        std::fprintf(stderr, "\n[TEST:Muxer] --- Test 6: async == serial ---\n");

        const int kFrames = 40;

        // Content that CHANGES per frame, so the encoder does real inter-frame
        // work and a reordered or dropped frame cannot go unnoticed.
        auto fillFrame = [](std::vector<uint8_t>& bgra, int f) {
            for (int y = 0; y < HEIGHT; ++y) {
                for (int x = 0; x < WIDTH; ++x) {
                    const size_t i = (static_cast<size_t>(y) * WIDTH + x) * 4;
                    bgra[i + 0] = static_cast<uint8_t>((x + f * 3) & 0xFF);
                    bgra[i + 1] = static_cast<uint8_t>((y + f * 5) & 0xFF);
                    bgra[i + 2] = static_cast<uint8_t>((x ^ y) + f * 7);
                    bgra[i + 3] = 255;
                }
            }
        };

        const int samplesPerFrame = SR / FPS;
        std::vector<float> audio(static_cast<size_t>(samplesPerFrame) * kFrames);
        for (size_t i = 0; i < audio.size(); ++i)
            audio[i] = static_cast<float>(std::sin(2.0 * M_PI * FREQ * (double)i / SR)) * 0.5f;

        auto runExport = [&](const std::string& path, int queueDepth) {
            ExportSettings s;
            s.outputPath   = path;
            s.videoCodec   = ExportSettings::VideoCodec::MPEG4;
            s.width        = WIDTH;
            s.height       = HEIGHT;
            s.fpsNum       = FPS;
            s.fpsDen       = 1;
            s.crf          = -1;
            s.videoBitrate = 800000;
            s.audioCodec   = ExportSettings::AudioCodec::AAC;
            s.sampleRate   = SR;
            s.audioBitrate = 128;

            FFmpegMuxer muxer;
            assert(muxer.init(s));
            muxer.enableAsyncVideo(queueDepth);
            assert(muxer.isAsyncVideo() == (queueDepth > 0)
                   && "enableAsyncVideo should start a worker iff depth > 0");

            std::vector<uint8_t> bgra(static_cast<size_t>(WIDTH) * HEIGHT * 4);
            for (int f = 0; f < kFrames; ++f) {
                fillFrame(bgra, f);
                assert(muxer.writeVideo(bgra.data(), WIDTH * 4, f));

                const int pos = f * samplesPerFrame;
                const float* ch[2] = { audio.data() + pos, audio.data() + pos };
                assert(muxer.writeAudio(ch, samplesPerFrame, pos));
            }
            assert(muxer.finalize());
            assert(!muxer.isAsyncVideo() && "finalize must join the worker");
        };

        const std::string serialPath = "test_muxer_serial.mp4";
        const std::string asyncPath  = "test_muxer_async.mp4";
        runExport(serialPath, 0);   // strictly serial: the reference
        runExport(asyncPath,  3);   // pipelined, depth 3

        auto a = probePackets(serialPath);
        auto b = probePackets(asyncPath);

        std::fprintf(stderr, "[TEST:Muxer] serial=%zu packets, async=%zu packets\n",
                     a.size(), b.size());
        assert(!a.empty() && "serial encode produced no packets");
        assert(a.size() == b.size() && "async encode changed the packet count");

        size_t comparedBytes = 0;
        for (size_t i = 0; i < a.size(); ++i) {
            assert(a[i].streamIndex == b[i].streamIndex && "packet stream order differs");
            assert(a[i].pts == b[i].pts && "packet pts differs");
            assert(a[i].dts == b[i].dts && "packet dts differs");
            assert(a[i].data.size() == b[i].data.size() && "packet size differs");
            assert(a[i].data == b[i].data && "packet payload differs - NOT bit-identical");
            comparedBytes += a[i].data.size();
        }
        std::fprintf(stderr,
                     "[TEST:Muxer] %zu packets / %zu bytes identical between serial "
                     "and pipelined encode\n", a.size(), comparedBytes);

        std::filesystem::remove(serialPath);
        std::filesystem::remove(asyncPath);
        std::fprintf(stderr, "[TEST:Muxer] Test 6: PASSED\n");
    }

    // ── Cleanup ─────────────────────────────────────────────────────────────
    std::filesystem::remove(outPath);
    std::filesystem::remove(fragPath);

    std::fprintf(stderr, "\n[TEST:Muxer] ALL TESTS PASSED\n");
    std::_Exit(0);
}
