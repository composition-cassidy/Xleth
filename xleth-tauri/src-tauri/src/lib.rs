mod d3d_layer;
mod engine_client;
mod frame_reader;
mod overlay_window;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{Emitter, Manager, State};
use windows::Win32::Foundation::HWND;
use windows::Win32::UI::WindowsAndMessaging::{SetWindowPos, HWND_BOTTOM, SWP_NOACTIVATE};

use d3d_layer::D3dLayer;
use engine_client::EngineClient;
use frame_reader::FrameReader;
use overlay_window::create_video_child_hwnd;

const VIDEO_FRACTION: f64 = 0.667;
const VIDEO_WIDTH: u32 = 960;
const VIDEO_HEIGHT: u32 = 540;

#[derive(Default)]
struct ResizeControl {
    width: AtomicU32,
    height: AtomicU32,
    pending: AtomicBool,
}

struct SendLayer(D3dLayer);
unsafe impl Send for SendLayer {}

#[tauri::command]
async fn engine_call(
    method: String,
    args: Value,
    client: State<'_, Arc<EngineClient>>,
) -> Result<Value, String> {
    client.call(&method, args).await
}

fn find_engine() -> Result<PathBuf, String> {
    let current_exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let current_dir = std::env::current_dir().map_err(|e| e.to_string())?;
    let candidates = [
        current_exe.parent().unwrap().join("xleth-engine.exe"),
        current_dir.join(r"..\build\engine\Release\xleth-engine.exe"),
        current_dir.join(r"..\build\xleth-engine.exe"),
        current_dir.join(r"build\engine\Release\xleth-engine.exe"),
    ];
    candidates
        .into_iter()
        .find(|p| p.exists())
        .ok_or_else(|| "xleth-engine.exe not found; build it with build.bat engine-exe".to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let resize = Arc::new(ResizeControl::default());
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![engine_call])
        .setup({
            let resize = resize.clone();
            move |app| {
                let engine_path = find_engine()?;
                eprintln!("Using engine: {}", engine_path.display());
                let client = tauri::async_runtime::block_on(EngineClient::start(&engine_path))?;
                tauri::async_runtime::block_on(async {
                    client.call("initialize", json!([])).await?;
                    client
                        .call(
                            "initVideoSharedMemory",
                            json!(["XlethFrameBuffer", VIDEO_WIDTH, VIDEO_HEIGHT]),
                        )
                        .await?;
                    Ok::<(), String>(())
                })?;
                app.manage(client.clone());

                let mut fatal = client.subscribe_fatal();
                let app_handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    while let Ok(message) = fatal.recv().await {
                        let _ = app_handle.emit("engine-fatal", message);
                    }
                });

                let window = app
                    .get_webview_window("main")
                    .ok_or("main window missing")?;
                let tauri_hwnd = window.hwnd().map_err(|e| e.to_string())?;
                let parent = HWND(tauri_hwnd.0 as _);
                let size = window.inner_size().map_err(|e| e.to_string())?;
                let scale = window.scale_factor().map_err(|e| e.to_string())?;
                // Tauri reports physical pixels while this child Win32 call is DPI
                // virtualized on this WebView host, so cross both scaling boundaries.
                let coordinate_scale = scale * scale;
                let video_w = (size.width as f64 * VIDEO_FRACTION / coordinate_scale) as i32;
                let video_h = (size.height as f64 / coordinate_scale) as i32;
                eprintln!(
                    "Video surface: inner={}x{} scale={scale:.2} child={}x{}",
                    size.width, size.height, video_w, video_h
                );
                let overlay = create_video_child_hwnd(parent, 0, 0, video_w, video_h)?;
                let child_hwnd = overlay.hwnd;
                let frame_reader = FrameReader::open(VIDEO_WIDTH, VIDEO_HEIGHT)?;
                let d3d = D3dLayer::new(
                    child_hwnd,
                    video_w.max(1) as u32,
                    video_h.max(1) as u32,
                    VIDEO_WIDTH,
                    VIDEO_HEIGHT,
                )?;
                let layer = SendLayer(d3d);
                let resize_rt = resize.clone();
                std::thread::spawn(move || {
                    let mut d3d = layer.0;
                    let mut frames = frame_reader;
                    loop {
                        if resize_rt.pending.swap(false, Ordering::AcqRel) {
                            d3d.resize(
                                resize_rt.width.load(Ordering::Acquire),
                                resize_rt.height.load(Ordering::Acquire),
                            );
                        }
                        if d3d.render(&mut frames) {
                            std::thread::sleep(Duration::from_millis(16));
                        }
                    }
                });

                let child_ptr = child_hwnd.0 as usize;
                let resize_evt = resize.clone();
                let resize_scale = coordinate_scale;
                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::Resized(size) = event {
                        let w = (size.width as f64 * VIDEO_FRACTION / resize_scale) as i32;
                        let h = (size.height as f64 / resize_scale) as i32;
                        let child = HWND(child_ptr as *mut core::ffi::c_void);
                        unsafe {
                            let _ = SetWindowPos(
                                child,
                                HWND_BOTTOM,
                                0,
                                0,
                                w.max(0),
                                h.max(0),
                                SWP_NOACTIVATE,
                            );
                        }
                        resize_evt.width.store(w.max(0) as u32, Ordering::Release);
                        resize_evt.height.store(h.max(0) as u32, Ordering::Release);
                        resize_evt.pending.store(true, Ordering::Release);
                    }
                });
                Ok(())
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running XLETH Tauri shell");
}
