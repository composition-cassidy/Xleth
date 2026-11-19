// test_muxer.cpp — Verifies FFmpegMuxer with built-in mpeg4 + aac encoders.
// Generates 1 second of 320x240 30fps solid-color video + 440Hz sine audio,
// muxes to MP4, then probes the output to verify stream counts and duration.

#include "export/FFmpegMuxer.h"

extern "C" {
#include <libavformat/avformat.h>
#include <libavcodec/avcodec.h>
#include <libswscale/swscale.h>
#include <libavutil/mathematics.h>
#include <libavutil/pixfmt.h>
}

// Force assert even in Release builds (NDEBUG is defined)
#undef NDEBUG
#include <algorithm>
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

// Decode the first audio stream of `path` and return its left channel as float.
// Goes through the demuxer + decoder the way a player does, so container edit
// lists and codec priming (skip-samples side data) are applied: sample 0 of the
// result is sample 0 of the presented audio.
static std::vector<float> decodeAudioLeft(const std::string& path, int* outRate)
{
    std::vector<float> out;
    AVFormatContext* fmt = nullptr;
    if (avformat_open_input(&fmt, path.c_str(), nullptr, nullptr) < 0) return out;
    if (avformat_find_stream_info(fmt, nullptr) < 0) { avformat_close_input(&fmt); return out; }
    const int si = av_find_best_stream(fmt, AVMEDIA_TYPE_AUDIO, -1, -1, nullptr, 0);
    if (si < 0) { avformat_close_input(&fmt); return out; }
    AVStream* st = fmt->streams[si];
    const AVCodec* dec = avcodec_find_decoder(st->codecpar->codec_id);
    AVCodecContext* ctx = dec ? avcodec_alloc_context3(dec) : nullptr;
    if (!ctx) { avformat_close_input(&fmt); return out; }
    avcodec_parameters_to_context(ctx, st->codecpar);
    ctx->pkt_timebase = st->time_base;
    if (avcodec_open2(ctx, dec, nullptr) < 0) {
        avcodec_free_context(&ctx); avformat_close_input(&fmt); return out;
    }
    if (outRate) *outRate = ctx->sample_rate;

    AVPacket* pkt = av_packet_alloc();
    AVFrame*  frm = av_frame_alloc();
    auto take = [&]() {
        while (avcodec_receive_frame(ctx, frm) >= 0) {
            const int n = frm->nb_samples;
            const uint8_t* d = frm->extended_data[0];
            switch (static_cast<AVSampleFormat>(frm->format)) {
                case AV_SAMPLE_FMT_FLT: case AV_SAMPLE_FMT_FLTP: {
                    const int step = (frm->format == AV_SAMPLE_FMT_FLT) ? frm->ch_layout.nb_channels : 1;
                    const float* p = reinterpret_cast<const float*>(d);
                    for (int i = 0; i < n; ++i) out.push_back(p[i * step]);
                    break; }
                case AV_SAMPLE_FMT_S16: case AV_SAMPLE_FMT_S16P: {
                    const int step = (frm->format == AV_SAMPLE_FMT_S16) ? frm->ch_layout.nb_channels : 1;
                    const int16_t* p = reinterpret_cast<const int16_t*>(d);
                    for (int i = 0; i < n; ++i) out.push_back(p[i * step] / 32768.0f);
                    break; }
                case AV_SAMPLE_FMT_S32: case AV_SAMPLE_FMT_S32P: {
                    const int step = (frm->format == AV_SAMPLE_FMT_S32) ? frm->ch_layout.nb_channels : 1;
                    const int32_t* p = reinterpret_cast<const int32_t*>(d);
                    for (int i = 0; i < n; ++i) out.push_back(static_cast<float>(p[i * step] / 2147483648.0));
                    break; }
                default: break;
            }
            av_frame_unref(frm);
        }
    };
    while (av_read_frame(fmt, pkt) >= 0) {
        if (pkt->stream_index == si && avcodec_send_packet(ctx, pkt) >= 0) take();
        av_packet_unref(pkt);
    }
    avcodec_send_packet(ctx, nullptr);
    take();

    av_frame_free(&frm);
    av_packet_free(&pkt);
    avcodec_free_context(&ctx);
    avformat_close_input(&fmt);
    return out;
}

// Decode the first video frame of `path` and convert its centre pixel to RGB
// with the given YUV matrix (limited range). Reports the matrix the stream is
// tagged with through *taggedSpace.
static bool decodeCentrePixel(const std::string& path, AVColorSpace decodeWith,
                              AVColorSpace* taggedSpace, uint8_t rgb[3])
{
    AVFormatContext* fmt = nullptr;
    if (avformat_open_input(&fmt, path.c_str(), nullptr, nullptr) < 0) return false;
    if (avformat_find_stream_info(fmt, nullptr) < 0) { avformat_close_input(&fmt); return false; }
    const int si = av_find_best_stream(fmt, AVMEDIA_TYPE_VIDEO, -1, -1, nullptr, 0);
    if (si < 0) { avformat_close_input(&fmt); return false; }
    AVStream* st = fmt->streams[si];
    if (taggedSpace) *taggedSpace = st->codecpar->color_space;
    const AVCodec* dec = avcodec_find_decoder(st->codecpar->codec_id);
    AVCodecContext* ctx = dec ? avcodec_alloc_context3(dec) : nullptr;
    if (!ctx) { avformat_close_input(&fmt); return false; }
    avcodec_parameters_to_context(ctx, st->codecpar);
    bool ok = false;
    if (avcodec_open2(ctx, dec, nullptr) >= 0) {
        AVPacket* pkt = av_packet_alloc();
        AVFrame*  frm = av_frame_alloc();
        auto convert = [&]() {
            SwsContext* sws = sws_getContext(frm->width, frm->height,
                                             static_cast<AVPixelFormat>(frm->format),
                                             frm->width, frm->height, AV_PIX_FMT_RGB24,
                                             SWS_BILINEAR, nullptr, nullptr, nullptr);
            if (!sws) return;
            const int* coeffs = sws_getCoefficients(
                decodeWith == AVCOL_SPC_BT709 ? SWS_CS_ITU709 : SWS_CS_ITU601);
            int* inv = nullptr; int* tbl = nullptr; int sr = 0, dr = 0, b = 0, c = 0, sat = 0;
            sws_getColorspaceDetails(sws, &inv, &sr, &tbl, &dr, &b, &c, &sat);
            sws_setColorspaceDetails(sws, coeffs, /*src limited*/0, coeffs, /*dst full*/1, b, c, sat);
            std::vector<uint8_t> buf(static_cast<size_t>(frm->width) * frm->height * 3);
            uint8_t* dstData[4] = { buf.data(), nullptr, nullptr, nullptr };
            int dstLines[4] = { frm->width * 3, 0, 0, 0 };
            sws_scale(sws, frm->data, frm->linesize, 0, frm->height, dstData, dstLines);
            const uint8_t* p = buf.data() + (static_cast<size_t>(frm->height / 2) * frm->width
                                             + frm->width / 2) * 3;
            rgb[0] = p[0]; rgb[1] = p[1]; rgb[2] = p[2];
            sws_freeContext(sws);
            ok = true;
        };
        while (!ok && av_read_frame(fmt, pkt) >= 0) {
            if (pkt->stream_index == si && avcodec_send_packet(ctx, pkt) >= 0
                && avcodec_receive_frame(ctx, frm) >= 0)
                convert();
            av_packet_unref(pkt);
        }
        if (!ok) {
            avcodec_send_packet(ctx, nullptr);
            if (avcodec_receive_frame(ctx, frm) >= 0) convert();
        }
        av_frame_free(&frm);
        av_packet_free(&pkt);
    }
    avcodec_free_context(&ctx);
    avformat_close_input(&fmt);
    return ok;
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

    // ── Test 7: mix rate != encode rate — length and alignment ─────────────
    // The engine mixes at the session rate and the muxer resamples to the
    // encoded rate. An impulse placed at a known time must come back at the
    // same TIME in the file, and the stream must last as long as the input:
    // the old per-frame swr call capped its output at one encoder frame, so at
    // 44.1 -> 48 kHz it left 8% of the audio inside the resampler and the
    // track ran progressively late and ended early.
    {
        std::fprintf(stderr, "\n[TEST:Muxer] --- Test 7: resample length + alignment ---\n");

        struct Case { int mixRate; int outRate; ExportSettings::AudioCodec codec; const char* name;
                      int tolSamples; };
        const Case cases[] = {
            { 48000, 44100, ExportSettings::AudioCodec::FLAC, "48k->44.1k flac", 1 },
            { 44100, 48000, ExportSettings::AudioCodec::FLAC, "44.1k->48k flac", 1 },
            { 96000, 48000, ExportSettings::AudioCodec::FLAC, "96k->48k flac",   1 },
            { 48000, 48000, ExportSettings::AudioCodec::FLAC, "48k->48k flac",   0 },
            { 48000, 44100, ExportSettings::AudioCodec::AAC,  "48k->44.1k aac",  48 },
            { 48000, 48000, ExportSettings::AudioCodec::AAC,  "48k->48k aac",    48 },
        };

        for (const Case& c : cases) {
            const std::string path = "test_muxer_resample.mp4";
            ExportSettings s;
            s.outputPath    = path;
            s.videoCodec    = ExportSettings::VideoCodec::MPEG4;
            s.width = WIDTH; s.height = HEIGHT; s.fpsNum = FPS; s.fpsDen = 1;
            s.crf = -1; s.videoBitrate = 500000;
            s.audioCodec    = c.codec;
            s.sampleRate    = c.outRate;
            s.mixSampleRate = c.mixRate;
            s.audioBitrate  = 256;
            s.fragmentedMP4 = true;     // the export's real container mode

            FFmpegMuxer muxer;
            assert(muxer.init(s) && "resample init should succeed");
            assert(muxer.audioEncoderSampleRate() == c.outRate);

            const int64_t total = static_cast<int64_t>(c.mixRate) * 2;          // 2 s
            const int64_t impulseAt = static_cast<int64_t>(c.mixRate * 0.7) + 3; // off any block edge
            std::vector<float> sig(static_cast<size_t>(total), 0.0f);
            sig[static_cast<size_t>(impulseAt)] = 0.8f;

            std::vector<uint8_t> bgra(WIDTH * HEIGHT * 4, 90);
            const int chunkSizes[] = { 512, 137, 1024, 33, 2048 };   // deliberately ragged
            int64_t pos = 0; int ci = 0; int64_t frame = 0;
            while (pos < total) {
                const int n = static_cast<int>(std::min<int64_t>(chunkSizes[ci++ % 5], total - pos));
                const float* ch[2] = { sig.data() + pos, sig.data() + pos };
                assert(muxer.writeAudio(ch, n, pos));
                pos += n;
                while (frame * c.mixRate < pos * FPS) {        // keep video in step
                    assert(muxer.writeVideo(bgra.data(), WIDTH * 4, frame));
                    ++frame;
                }
            }
            assert(muxer.finalize());

            int rate = 0;
            const std::vector<float> dec = decodeAudioLeft(path, &rate);
            assert(rate == c.outRate && "encoded stream is at the requested rate");
            assert(!dec.empty());

            // Length: the whole 2 s is there (lossy codecs may round to a frame).
            const int64_t expectLen = total * c.outRate / c.mixRate;
            const int64_t lenTol = (c.codec == ExportSettings::AudioCodec::AAC) ? 1100 : 96;
            const int64_t gotLen = static_cast<int64_t>(dec.size());
            std::fprintf(stderr, "[TEST:Muxer] %-16s len=%lld (expect %lld)",
                         c.name, (long long)gotLen, (long long)expectLen);
            assert(std::llabs(gotLen - expectLen) <= lenTol && "audio length preserved");

            // Alignment: the impulse lands where it was put, in TIME.
            size_t peak = 0;
            for (size_t i = 1; i < dec.size(); ++i)
                if (std::fabs(dec[i]) > std::fabs(dec[peak])) peak = i;
            const double expectPeak = static_cast<double>(impulseAt) * c.outRate / c.mixRate;
            std::fprintf(stderr, "  peak=%zu (expect %.1f)\n", peak, expectPeak);
            assert(std::fabs(static_cast<double>(peak) - expectPeak) <= c.tolSamples + 0.6
                   && "impulse is time-aligned after resampling + codec priming");

            std::filesystem::remove(path);
        }
        std::fprintf(stderr, "[TEST:Muxer] Test 7: PASSED\n");
    }

    // ── Test 8: an Opus request never reaches FFmpeg's experimental encoder ─
    // Without libopus, AV_CODEC_ID_OPUS resolves to the built-in "opus"
    // encoder, which overruns its lookahead queue on ordinary 20 ms frames and
    // drops most of the audio. The muxer must use libopus or fall back to AAC,
    // and either way the audio that goes in must come out.
    {
        std::fprintf(stderr, "\n[TEST:Muxer] --- Test 8: Opus request ---\n");
        const std::string path = "test_muxer_opus.mp4";
        ExportSettings s;
        s.outputPath    = path;
        s.videoCodec    = ExportSettings::VideoCodec::MPEG4;
        s.width = WIDTH; s.height = HEIGHT; s.fpsNum = FPS; s.fpsDen = 1;
        s.crf = -1; s.videoBitrate = 500000;
        s.audioCodec    = ExportSettings::AudioCodec::OPUS;
        s.sampleRate    = 44100;        // what the old Discord preset asked for
        s.mixSampleRate = 44100;
        s.audioBitrate  = 256;

        FFmpegMuxer muxer;
        assert(muxer.init(s) && "an Opus request must still produce a file");
        const std::string enc = muxer.audioEncoderName();
        std::fprintf(stderr, "[TEST:Muxer] Opus request -> encoder '%s' @ %d Hz (fallback=%d)\n",
                     enc.c_str(), muxer.audioEncoderSampleRate(), (int)muxer.isAudioCodecFallback());
        assert(enc != "opus" && "the experimental built-in Opus encoder must never be used");
        assert((enc == "libopus") != muxer.isAudioCodecFallback()
               && "fallback flag reports exactly the substituted case");
        if (enc == "libopus") assert(muxer.audioEncoderSampleRate() == 48000);

        const int total = 44100 * 2;
        std::vector<float> sig(total);
        for (int i = 0; i < total; ++i)
            sig[i] = 0.5f * static_cast<float>(std::sin(2.0 * M_PI * FREQ * i / 44100.0));
        std::vector<uint8_t> bgra(WIDTH * HEIGHT * 4, 90);
        for (int f = 0; f < FPS * 2; ++f) {
            assert(muxer.writeVideo(bgra.data(), WIDTH * 4, f));
            const float* ch[2] = { sig.data() + f * 1470, sig.data() + f * 1470 };
            assert(muxer.writeAudio(ch, 1470, f * 1470));
        }
        assert(muxer.finalize());

        int rate = 0;
        const std::vector<float> dec = decodeAudioLeft(path, &rate);
        assert(rate > 0 && !dec.empty());
        const double seconds = static_cast<double>(dec.size()) / rate;
        // RMS over the LAST half second: the broken encoder kept the first
        // second or so and lost the rest.
        double acc = 0.0; const size_t from = dec.size() - static_cast<size_t>(rate / 2);
        for (size_t i = from; i < dec.size() - static_cast<size_t>(rate / 20); ++i)
            acc += static_cast<double>(dec[i]) * dec[i];
        const double rms = std::sqrt(acc / (dec.size() - rate / 20 - from));
        std::fprintf(stderr, "[TEST:Muxer] decoded %.3fs, tail RMS=%.4f (input 0.3536)\n", seconds, rms);
        assert(seconds > 1.95 && seconds < 2.08 && "all two seconds of audio are in the file");
        assert(rms > 0.30 && rms < 0.40 && "the audio at the END is the audio that went in");

        std::filesystem::remove(path);
        std::fprintf(stderr, "[TEST:Muxer] Test 8: PASSED\n");
    }

    // ── Test 9: zero-copy submit == writeVideo, serial and pipelined ───────
    {
        std::fprintf(stderr, "\n[TEST:Muxer] --- Test 9: acquire/submit == writeVideo ---\n");
        const int kFrames = 40;
        auto fill = [&](uint8_t* dst, int f) {
            for (int y = 0; y < HEIGHT; ++y)
                for (int x = 0; x < WIDTH; ++x) {
                    uint8_t* p = dst + (y * WIDTH + x) * 4;
                    p[0] = static_cast<uint8_t>(x + f * 3);
                    p[1] = static_cast<uint8_t>(y * 2 + f * 5);
                    p[2] = static_cast<uint8_t>((x ^ y) + f * 7);
                    p[3] = 255;
                }
        };
        auto runExport = [&](const std::string& path, int queueDepth, bool zeroCopy) {
            ExportSettings s;
            s.outputPath    = path;
            s.videoCodec    = ExportSettings::VideoCodec::MPEG4;
            s.width = WIDTH; s.height = HEIGHT; s.fpsNum = FPS; s.fpsDen = 1;
            s.crf = -1; s.videoBitrate = 800000;
            s.audioCodec    = ExportSettings::AudioCodec::AAC;
            s.sampleRate    = SR;
            FFmpegMuxer muxer;
            assert(muxer.init(s));
            muxer.enableAsyncVideo(queueDepth);
            assert(muxer.videoBufferBytes() == static_cast<size_t>(WIDTH) * HEIGHT * 4);
            std::vector<uint8_t> bgra(WIDTH * HEIGHT * 4);
            std::vector<float> silence(SR / FPS, 0.0f);
            for (int f = 0; f < kFrames; ++f) {
                if (zeroCopy) {
                    if (f == 5) {                       // an abandoned buffer costs nothing
                        uint8_t* junk = muxer.acquireVideoBuffer();
                        assert(junk != nullptr);
                        muxer.releaseVideoBuffer();
                    }
                    uint8_t* dst = muxer.acquireVideoBuffer();
                    assert(dst != nullptr);
                    assert(muxer.acquireVideoBuffer() == nullptr && "only one buffer out at a time");
                    fill(dst, f);
                    assert(muxer.submitVideoBuffer(f));
                    assert(!muxer.submitVideoBuffer(f) && "nothing held after a submit");
                } else {
                    fill(bgra.data(), f);
                    assert(muxer.writeVideo(bgra.data(), WIDTH * 4, f));
                }
                const float* ch[2] = { silence.data(), silence.data() };
                assert(muxer.writeAudio(ch, SR / FPS, static_cast<int64_t>(f) * (SR / FPS)));
            }
            assert(muxer.finalize());
        };

        const std::string refPath = "test_muxer_zc_ref.mp4";
        runExport(refPath, 0, false);
        const auto ref = probePackets(refPath);
        assert(!ref.empty());
        const struct { int depth; const char* name; } variants[] = {
            { 0, "zero-copy serial" }, { 3, "zero-copy pipelined" } };
        for (const auto& v : variants) {
            const std::string path = "test_muxer_zc.mp4";
            runExport(path, v.depth, true);
            const auto got = probePackets(path);
            assert(got.size() == ref.size() && "zero-copy changed the packet count");
            for (size_t i = 0; i < ref.size(); ++i) {
                assert(got[i].streamIndex == ref[i].streamIndex);
                assert(got[i].pts == ref[i].pts && got[i].dts == ref[i].dts);
                assert(got[i].data == ref[i].data && "zero-copy payload differs");
            }
            std::fprintf(stderr, "[TEST:Muxer] %s: %zu packets identical to writeVideo\n",
                         v.name, got.size());
            std::filesystem::remove(path);
        }
        std::filesystem::remove(refPath);
        std::fprintf(stderr, "[TEST:Muxer] Test 9: PASSED\n");
    }

    // ── Test 10: the stream says what its YUV means, and it is true ────────
    // HD output is tagged BT.709 and converted with BT.709; SD with BT.601.
    // Decoding with the tagged matrix must give back the RGB that went in.
    {
        std::fprintf(stderr, "\n[TEST:Muxer] --- Test 10: colour tagging ---\n");
        struct Case { int w, h; AVColorSpace space; const char* name; };
        const Case cases[] = {
            { 1280, 720, AVCOL_SPC_BT709,     "720p -> BT.709" },
            {  320, 240, AVCOL_SPC_SMPTE170M, "240p -> BT.601" },
        };
        const uint8_t inB = 60, inG = 200, inR = 40;   // saturated green: 601 vs 709 differ most
        for (const Case& c : cases) {
            const std::string path = "test_muxer_colour.mp4";
            ExportSettings s;
            s.outputPath    = path;
            s.videoCodec    = ExportSettings::VideoCodec::MPEG4;
            s.width = c.w; s.height = c.h; s.fpsNum = FPS; s.fpsDen = 1;
            s.crf = -1; s.videoBitrate = 8000000;
            s.audioCodec    = ExportSettings::AudioCodec::AAC;
            s.sampleRate    = SR;
            FFmpegMuxer muxer;
            assert(muxer.init(s));
            std::vector<uint8_t> bgra(static_cast<size_t>(c.w) * c.h * 4);
            for (size_t i = 0; i < bgra.size(); i += 4) {
                bgra[i] = inB; bgra[i + 1] = inG; bgra[i + 2] = inR; bgra[i + 3] = 255;
            }
            std::vector<float> silence(SR / FPS, 0.0f);
            for (int f = 0; f < 6; ++f) {
                assert(muxer.writeVideo(bgra.data(), c.w * 4, f));
                const float* ch[2] = { silence.data(), silence.data() };
                assert(muxer.writeAudio(ch, SR / FPS, static_cast<int64_t>(f) * (SR / FPS)));
            }
            assert(muxer.finalize());

            AVColorSpace taggedSpace = AVCOL_SPC_UNSPECIFIED;
            uint8_t rgbTagged[3] = {0, 0, 0}, rgbOther[3] = {0, 0, 0};
            const AVColorSpace other = (c.space == AVCOL_SPC_BT709) ? AVCOL_SPC_SMPTE170M
                                                                    : AVCOL_SPC_BT709;
            assert(decodeCentrePixel(path, c.space, &taggedSpace, rgbTagged));
            assert(decodeCentrePixel(path, other,   nullptr,      rgbOther));
            std::fprintf(stderr,
                "[TEST:Muxer] %-15s tag=%d  in=(%d,%d,%d)  tagged-matrix=(%d,%d,%d)  "
                "other-matrix=(%d,%d,%d)\n", c.name, (int)taggedSpace, inR, inG, inB,
                rgbTagged[0], rgbTagged[1], rgbTagged[2], rgbOther[0], rgbOther[1], rgbOther[2]);
            assert(taggedSpace == c.space && "stream carries the expected colour-matrix tag");
            const int tol = 6;
            assert(std::abs(rgbTagged[0] - inR) <= tol && std::abs(rgbTagged[1] - inG) <= tol
                   && std::abs(rgbTagged[2] - inB) <= tol
                   && "decoding with the tagged matrix returns the input colour");
            const int wrongErr = std::max({ std::abs(rgbOther[0] - inR), std::abs(rgbOther[1] - inG),
                                            std::abs(rgbOther[2] - inB) });
            assert(wrongErr > tol && "the matrix matters: the other one visibly shifts this colour");
            std::filesystem::remove(path);
        }
        std::fprintf(stderr, "[TEST:Muxer] Test 10: PASSED\n");
    }

    // ── Cleanup ─────────────────────────────────────────────────────────────
    std::filesystem::remove(outPath);
    std::filesystem::remove(fragPath);

    std::fprintf(stderr, "\n[TEST:Muxer] ALL TESTS PASSED\n");
    std::_Exit(0);
}
