use std::sync::Once;

use windows::core::w;
use windows::Win32::Foundation::{HINSTANCE, HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::Graphics::Gdi::{GetStockObject, HBRUSH, NULL_BRUSH};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, RegisterClassW, SetWindowPos, CS_OWNDC, HMENU, HWND_BOTTOM,
    SWP_NOACTIVATE, WM_ERASEBKGND, WNDCLASSW, WS_CHILD, WS_EX_NOACTIVATE, WS_VISIBLE,
};

const CLASS_NAME: windows::core::PCWSTR = w!("XlethVideoSurface");
static REGISTER: Once = Once::new();

pub struct OverlayWindow {
    pub hwnd: HWND,
}

unsafe extern "system" fn wnd_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    match msg {
        WM_ERASEBKGND => LRESULT(1),
        _ => DefWindowProcW(hwnd, msg, wparam, lparam),
    }
}

fn register_class() -> Result<HINSTANCE, String> {
    let hinstance: HINSTANCE = unsafe {
        GetModuleHandleW(None)
            .map_err(|e| format!("GetModuleHandleW failed: {e}"))?
            .into()
    };

    let mut result = Ok(());
    REGISTER.call_once(|| {
        let brush = HBRUSH(unsafe { GetStockObject(NULL_BRUSH) }.0);
        let wc = WNDCLASSW {
            style: CS_OWNDC,
            lpfnWndProc: Some(wnd_proc),
            hInstance: hinstance,
            lpszClassName: CLASS_NAME,
            hbrBackground: brush,
            ..Default::default()
        };
        if unsafe { RegisterClassW(&wc) } == 0 {
            result = Err(format!(
                "RegisterClassW failed: {:?}",
                windows::core::Error::from_win32()
            ));
        }
    });
    result?;
    Ok(hinstance)
}

pub fn create_video_child_hwnd(
    parent: HWND,
    x: i32,
    y: i32,
    w: i32,
    h: i32,
) -> Result<OverlayWindow, String> {
    let hinstance = register_class()?;
    let hwnd = unsafe {
        CreateWindowExW(
            WS_EX_NOACTIVATE,
            CLASS_NAME,
            w!("XlethVideoSurface"),
            WS_CHILD | WS_VISIBLE,
            x,
            y,
            w,
            h,
            parent,
            HMENU::default(),
            hinstance,
            None,
        )
    }
    .map_err(|e| format!("CreateWindowExW failed: {e}"))?;

    unsafe {
        let _ = SetWindowPos(hwnd, HWND_BOTTOM, x, y, w, h, SWP_NOACTIVATE);
    }
    Ok(OverlayWindow { hwnd })
}
