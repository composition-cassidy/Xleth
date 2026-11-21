#pragma once

extern "C" {
#include <libavutil/pixdesc.h>
}

// Proxies (H.264 / DNxHR), JPEG posters and the D3D11VA -> NV12 path all drop
// alpha. A source whose pixels can be transparent (PNG-as-BMP, WebP, GIF's
// palette) skips them and is decoded straight to BGRA, which the compositor
// blends with its per-pixel alpha.
inline bool pixFmtMayHaveAlpha(int fmt)
{
    const AVPixFmtDescriptor* d = av_pix_fmt_desc_get(static_cast<AVPixelFormat>(fmt));
    return d && (d->flags & (AV_PIX_FMT_FLAG_ALPHA | AV_PIX_FMT_FLAG_PAL));
}
