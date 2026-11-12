// Nv12ToBgra.hlsl — one-pass NV12 (D3D11VA decode output) → BGRA conversion.
//
// Compile with fxc (from this directory):
//   fxc /nologo /T vs_5_0 /E VSMain /Vn g_Nv12ToBgraVS /Fh Nv12ToBgraVS.h Nv12ToBgra.hlsl
//   fxc /nologo /T ps_5_0 /E PSMain /Vn g_Nv12ToBgraPS /Fh Nv12ToBgraPS.h Nv12ToBgra.hlsl
//
// Used by render/Nv12Converter: a hardware-decoded frame is copied
// (GPU→GPU) into a standalone NV12 texture, viewed as two planes — luma as
// R8_UNORM, interleaved chroma as R8G8_UNORM at half resolution — and drawn
// through this shader into the BGRA texture the frame cache stores. This
// replaces the per-frame av_hwframe_transfer_data + sws_scale + upload
// detour, so a decoded frame never leaves the GPU.
//
// The YUV→RGB matrix (BT.601 / BT.709 / BT.2020 / SMPTE 240M, limited or
// full range) is folded by the CPU into three affine rows so one shader
// serves every source; see Nv12Converter::yuvToRgbRows. The output size is
// whatever render target is bound: when it is smaller than the source (the
// preview's setMaxOutputSize cap) the linear sampler downscales in the same
// pass, as sws_scale's SWS_BILINEAR did on the CPU path.

cbuffer Nv12Constants : register(b0)
{
    float4 rowR;          // R = dot(rowR, float4(Y, Cb, Cr, 1))
    float4 rowG;
    float4 rowB;
    float4 chromaShift;   // xy: UV offset applied to the chroma sample for the
                          // stream's chroma siting (H.264/MPEG-2 4:2:0 sites
                          // chroma on the even luma column: +0.5 luma px in x)
};

Texture2D<float>  lumaTex       : register(t0);   // R8_UNORM view of the NV12 texture
Texture2D<float2> chromaTex     : register(t1);   // R8G8_UNORM view (half res)
SamplerState      linearSampler : register(s0);

struct VSOutput
{
    float4 pos : SV_Position;
    float2 uv  : TEXCOORD0;
};

// Fullscreen triangle from SV_VertexID — no vertex buffer, no input layout.
VSOutput VSMain(uint id : SV_VertexID)
{
    VSOutput o;
    float2 uv = float2((id << 1) & 2, id & 2);     // (0,0) (2,0) (0,2)
    o.uv  = uv;
    o.pos = float4(uv.x * 2.0f - 1.0f, 1.0f - uv.y * 2.0f, 0.0f, 1.0f);
    return o;
}

float4 PSMain(VSOutput input) : SV_Target
{
    float  y  = lumaTex.Sample(linearSampler, input.uv);
    float2 c  = chromaTex.Sample(linearSampler, input.uv + chromaShift.xy);
    float4 yuv1 = float4(y, c.x, c.y, 1.0f);
    float3 rgb = float3(dot(rowR, yuv1), dot(rowG, yuv1), dot(rowB, yuv1));
    return float4(saturate(rgb), 1.0f);
}
