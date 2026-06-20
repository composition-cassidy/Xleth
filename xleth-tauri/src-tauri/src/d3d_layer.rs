use std::ptr;

use windows::core::{s, PCSTR};
use windows::Win32::Foundation::{HMODULE, HWND};
use windows::Win32::Graphics::Direct3D::Fxc::D3DCompile;
use windows::Win32::Graphics::Direct3D::{
    ID3DBlob, D3D_DRIVER_TYPE_HARDWARE, D3D_FEATURE_LEVEL, D3D_FEATURE_LEVEL_11_0,
    D3D_PRIMITIVE_TOPOLOGY_TRIANGLELIST,
};
use windows::Win32::Graphics::Direct3D11::{
    D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, ID3D11PixelShader,
    ID3D11RenderTargetView, ID3D11SamplerState, ID3D11ShaderResourceView, ID3D11Texture2D,
    ID3D11VertexShader, D3D11_BIND_SHADER_RESOURCE, D3D11_CPU_ACCESS_WRITE,
    D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_FILTER_MIN_MAG_MIP_LINEAR, D3D11_MAPPED_SUBRESOURCE,
    D3D11_MAP_WRITE, D3D11_SAMPLER_DESC, D3D11_SDK_VERSION, D3D11_TEXTURE2D_DESC,
    D3D11_TEXTURE_ADDRESS_CLAMP, D3D11_USAGE_DEFAULT, D3D11_USAGE_STAGING, D3D11_VIEWPORT,
};
use windows::Win32::Graphics::Dxgi::Common::{
    DXGI_ALPHA_MODE_IGNORE, DXGI_FORMAT_R8G8B8A8_UNORM, DXGI_FORMAT_UNKNOWN, DXGI_SAMPLE_DESC,
};
use windows::Win32::Graphics::Dxgi::{
    CreateDXGIFactory2, IDXGIFactory2, IDXGISwapChain1, DXGI_CREATE_FACTORY_FLAGS, DXGI_PRESENT,
    DXGI_SCALING_STRETCH, DXGI_SWAP_CHAIN_DESC1, DXGI_SWAP_CHAIN_FLAG,
    DXGI_SWAP_EFFECT_FLIP_DISCARD, DXGI_USAGE_RENDER_TARGET_OUTPUT,
};

use crate::frame_reader::FrameReader;

const VS_SOURCE: &str = r#"
void vs_main(uint id : SV_VertexID, out float4 pos : SV_Position, out float2 uv : TEXCOORD) {
    uv = float2((id & 1) ? 2.0 : 0.0, (id & 2) ? 2.0 : 0.0);
    pos = float4(uv * float2(2, -2) + float2(-1, 1), 0, 1);
}"#;
const PS_SOURCE: &str = r#"
Texture2D tex; SamplerState samp;
float4 ps_main(float4 pos : SV_Position, float2 uv : TEXCOORD) : SV_Target {
    return tex.Sample(samp, uv);
}"#;

struct Pipeline {
    staging: ID3D11Texture2D,
    gpu_texture: ID3D11Texture2D,
    srv: ID3D11ShaderResourceView,
    vertex_shader: ID3D11VertexShader,
    pixel_shader: ID3D11PixelShader,
    sampler: ID3D11SamplerState,
}

pub struct D3dLayer {
    device: ID3D11Device,
    context: ID3D11DeviceContext,
    swapchain: IDXGISwapChain1,
    rtv: Option<ID3D11RenderTargetView>,
    pipeline: Option<Pipeline>,
    width: u32,
    height: u32,
}

impl D3dLayer {
    pub fn new(
        hwnd: HWND,
        width: u32,
        height: u32,
        frame_width: u32,
        frame_height: u32,
    ) -> Result<Self, String> {
        let mut device = None;
        let mut context = None;
        let mut got_level = D3D_FEATURE_LEVEL::default();
        unsafe {
            D3D11CreateDevice(
                None,
                D3D_DRIVER_TYPE_HARDWARE,
                HMODULE::default(),
                D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                Some(&[D3D_FEATURE_LEVEL_11_0]),
                D3D11_SDK_VERSION,
                Some(&mut device),
                Some(&mut got_level),
                Some(&mut context),
            )
            .map_err(|e| format!("D3D11CreateDevice failed: {e}"))?;
        }
        let device = device.ok_or("D3D11CreateDevice returned a null device")?;
        let context = context.ok_or("D3D11CreateDevice returned a null context")?;
        let factory: IDXGIFactory2 = unsafe { CreateDXGIFactory2(DXGI_CREATE_FACTORY_FLAGS(0)) }
            .map_err(|e| format!("CreateDXGIFactory2 failed: {e}"))?;
        let desc = DXGI_SWAP_CHAIN_DESC1 {
            Width: width.max(1),
            Height: height.max(1),
            Format: DXGI_FORMAT_R8G8B8A8_UNORM,
            Stereo: false.into(),
            SampleDesc: DXGI_SAMPLE_DESC {
                Count: 1,
                Quality: 0,
            },
            BufferUsage: DXGI_USAGE_RENDER_TARGET_OUTPUT,
            BufferCount: 2,
            Scaling: DXGI_SCALING_STRETCH,
            SwapEffect: DXGI_SWAP_EFFECT_FLIP_DISCARD,
            AlphaMode: DXGI_ALPHA_MODE_IGNORE,
            Flags: 0,
        };
        let swapchain = unsafe { factory.CreateSwapChainForHwnd(&device, hwnd, &desc, None, None) }
            .map_err(|e| format!("CreateSwapChainForHwnd failed: {e}"))?;
        let pipeline = match Self::create_pipeline(&device, frame_width, frame_height) {
            Ok(pipeline) => Some(pipeline),
            Err(e) => {
                eprintln!("D3D shader pipeline unavailable; using clear fallback: {e}");
                None
            }
        };
        let mut layer = Self {
            device,
            context,
            swapchain,
            rtv: None,
            pipeline,
            width: width.max(1),
            height: height.max(1),
        };
        layer.create_rtv()?;
        eprintln!(
            "D3D11 device created successfully (feature level {:?})",
            got_level
        );
        Ok(layer)
    }

    fn create_pipeline(device: &ID3D11Device, width: u32, height: u32) -> Result<Pipeline, String> {
        let texture_desc = D3D11_TEXTURE2D_DESC {
            Width: width,
            Height: height,
            MipLevels: 1,
            ArraySize: 1,
            Format: DXGI_FORMAT_R8G8B8A8_UNORM,
            SampleDesc: DXGI_SAMPLE_DESC {
                Count: 1,
                Quality: 0,
            },
            Usage: D3D11_USAGE_STAGING,
            BindFlags: 0,
            CPUAccessFlags: D3D11_CPU_ACCESS_WRITE.0 as u32,
            MiscFlags: 0,
        };
        let mut staging = None;
        unsafe { device.CreateTexture2D(&texture_desc, None, Some(&mut staging)) }
            .map_err(|e| format!("create staging texture: {e}"))?;
        let mut gpu_desc = texture_desc;
        gpu_desc.Usage = D3D11_USAGE_DEFAULT;
        gpu_desc.BindFlags = D3D11_BIND_SHADER_RESOURCE.0 as u32;
        gpu_desc.CPUAccessFlags = 0;
        let mut gpu_texture = None;
        unsafe { device.CreateTexture2D(&gpu_desc, None, Some(&mut gpu_texture)) }
            .map_err(|e| format!("create GPU texture: {e}"))?;
        let staging = staging.ok_or("null staging texture")?;
        let gpu_texture = gpu_texture.ok_or("null GPU texture")?;
        let mut srv = None;
        unsafe { device.CreateShaderResourceView(&gpu_texture, None, Some(&mut srv)) }
            .map_err(|e| format!("create SRV: {e}"))?;

        let vs_blob = compile_shader(VS_SOURCE, s!("vs_main"), s!("vs_5_0"))?;
        let ps_blob = compile_shader(PS_SOURCE, s!("ps_main"), s!("ps_5_0"))?;
        let vs_bytes = unsafe {
            std::slice::from_raw_parts(
                vs_blob.GetBufferPointer().cast::<u8>(),
                vs_blob.GetBufferSize(),
            )
        };
        let ps_bytes = unsafe {
            std::slice::from_raw_parts(
                ps_blob.GetBufferPointer().cast::<u8>(),
                ps_blob.GetBufferSize(),
            )
        };
        let mut vertex_shader = None;
        let mut pixel_shader = None;
        unsafe {
            device
                .CreateVertexShader(vs_bytes, None, Some(&mut vertex_shader))
                .map_err(|e| format!("create vertex shader: {e}"))?;
            device
                .CreatePixelShader(ps_bytes, None, Some(&mut pixel_shader))
                .map_err(|e| format!("create pixel shader: {e}"))?;
        }
        let sampler_desc = D3D11_SAMPLER_DESC {
            Filter: D3D11_FILTER_MIN_MAG_MIP_LINEAR,
            AddressU: D3D11_TEXTURE_ADDRESS_CLAMP,
            AddressV: D3D11_TEXTURE_ADDRESS_CLAMP,
            AddressW: D3D11_TEXTURE_ADDRESS_CLAMP,
            MaxLOD: f32::MAX,
            ..Default::default()
        };
        let mut sampler = None;
        unsafe { device.CreateSamplerState(&sampler_desc, Some(&mut sampler)) }
            .map_err(|e| format!("create sampler: {e}"))?;
        Ok(Pipeline {
            staging,
            gpu_texture,
            srv: srv.ok_or("null SRV")?,
            vertex_shader: vertex_shader.ok_or("null vertex shader")?,
            pixel_shader: pixel_shader.ok_or("null pixel shader")?,
            sampler: sampler.ok_or("null sampler")?,
        })
    }

    fn create_rtv(&mut self) -> Result<(), String> {
        let backbuffer: ID3D11Texture2D = unsafe { self.swapchain.GetBuffer(0) }
            .map_err(|e| format!("GetBuffer(0) failed: {e}"))?;
        let mut rtv = None;
        unsafe {
            self.device
                .CreateRenderTargetView(&backbuffer, None, Some(&mut rtv))
        }
        .map_err(|e| format!("CreateRenderTargetView failed: {e}"))?;
        self.rtv = Some(rtv.ok_or("null render target view")?);
        Ok(())
    }

    pub fn render(&mut self, frame_reader: &mut FrameReader) -> bool {
        if frame_reader.has_new_frame() {
            if let Some(pipeline) = &self.pipeline {
                let (w, h) = frame_reader.dimensions();
                let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
                if unsafe {
                    self.context
                        .Map(&pipeline.staging, 0, D3D11_MAP_WRITE, 0, Some(&mut mapped))
                }
                .is_ok()
                {
                    let src = unsafe { frame_reader.active_frame_ptr() };
                    let src_pitch = w as usize * 4;
                    for row in 0..h as usize {
                        unsafe {
                            ptr::copy_nonoverlapping(
                                src.add(row * src_pitch),
                                mapped
                                    .pData
                                    .cast::<u8>()
                                    .add(row * mapped.RowPitch as usize),
                                src_pitch,
                            );
                        }
                    }
                    unsafe {
                        self.context.Unmap(&pipeline.staging, 0);
                        self.context
                            .CopyResource(&pipeline.gpu_texture, &pipeline.staging);
                    }
                }
            }
        }
        if let Some(rtv) = &self.rtv {
            unsafe {
                self.context
                    .OMSetRenderTargets(Some(&[Some(rtv.clone())]), None);
                self.context
                    .ClearRenderTargetView(rtv, &[0.0745, 0.0745, 0.0745, 1.0]);
                self.context.RSSetViewports(Some(&[D3D11_VIEWPORT {
                    Width: self.width as f32,
                    Height: self.height as f32,
                    MinDepth: 0.0,
                    MaxDepth: 1.0,
                    ..Default::default()
                }]));
                if let Some(pipeline) = &self.pipeline {
                    self.context.VSSetShader(&pipeline.vertex_shader, None);
                    self.context.PSSetShader(&pipeline.pixel_shader, None);
                    self.context
                        .PSSetShaderResources(0, Some(&[Some(pipeline.srv.clone())]));
                    self.context
                        .PSSetSamplers(0, Some(&[Some(pipeline.sampler.clone())]));
                    self.context
                        .IASetPrimitiveTopology(D3D_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
                    self.context.Draw(3, 0);
                }
            }
        }
        let hr = unsafe { self.swapchain.Present(1, DXGI_PRESENT(0)) };
        hr.0 == 0x087A_0001u32 as i32
    }

    pub fn resize(&mut self, width: u32, height: u32) {
        if width == 0 || height == 0 {
            return;
        }
        self.rtv = None;
        if let Err(e) = unsafe {
            self.swapchain.ResizeBuffers(
                0,
                width,
                height,
                DXGI_FORMAT_UNKNOWN,
                DXGI_SWAP_CHAIN_FLAG(0),
            )
        } {
            eprintln!("ResizeBuffers failed: {e}");
            return;
        }
        self.width = width;
        self.height = height;
        if let Err(e) = self.create_rtv() {
            eprintln!("re-create RTV failed: {e}");
        }
    }
}

fn compile_shader(source: &str, entry: PCSTR, target: PCSTR) -> Result<ID3DBlob, String> {
    let mut code = None;
    let mut errors = None;
    let result = unsafe {
        D3DCompile(
            source.as_ptr().cast(),
            source.len(),
            s!("xleth-inline.hlsl"),
            None,
            None,
            entry,
            target,
            0,
            0,
            &mut code,
            Some(&mut errors),
        )
    };
    if let Err(e) = result {
        let detail = errors
            .map(|blob| unsafe {
                let bytes = std::slice::from_raw_parts(
                    blob.GetBufferPointer().cast::<u8>(),
                    blob.GetBufferSize(),
                );
                String::from_utf8_lossy(bytes).into_owned()
            })
            .unwrap_or_default();
        return Err(format!("D3DCompile failed: {e}: {detail}"));
    }
    code.ok_or("D3DCompile returned null bytecode".into())
}
