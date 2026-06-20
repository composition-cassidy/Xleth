use std::sync::atomic::{AtomicI32, Ordering};

use windows::core::s;
use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::System::Memory::{
    MapViewOfFile, OpenFileMappingA, UnmapViewOfFile, FILE_MAP_READ, MEMORY_MAPPED_VIEW_ADDRESS,
};

const CONTROL_REGION_SIZE: usize = 64;

pub struct FrameReader {
    mapping_handle: HANDLE,
    view_ptr: *mut u8,
    total_size: usize,
    width: u32,
    height: u32,
    last_seen_index: u32,
}

impl FrameReader {
    pub fn open(width: u32, height: u32) -> Result<Self, String> {
        let frame_size = width as usize * height as usize * 4;
        let total_size = frame_size * 2 + CONTROL_REGION_SIZE;
        let mapping_handle =
            unsafe { OpenFileMappingA(FILE_MAP_READ.0, false, s!("XlethFrameBuffer")) }
                .map_err(|e| format!("OpenFileMappingA(XlethFrameBuffer) failed: {e}"))?;
        let view = unsafe { MapViewOfFile(mapping_handle, FILE_MAP_READ, 0, 0, total_size) };
        if view.Value.is_null() {
            unsafe {
                let _ = CloseHandle(mapping_handle);
            }
            return Err(format!(
                "MapViewOfFile failed: {:?}",
                windows::core::Error::from_win32()
            ));
        }
        Ok(Self {
            mapping_handle,
            view_ptr: view.Value.cast(),
            total_size,
            width,
            height,
            last_seen_index: u32::MAX,
        })
    }

    pub fn has_new_frame(&mut self) -> bool {
        let index_ptr =
            unsafe { self.view_ptr.add(self.frame_byte_size() * 2) }.cast::<AtomicI32>();
        let index = unsafe { &*index_ptr }.load(Ordering::Acquire) as u32;
        if (index == 0 || index == 1) && index != self.last_seen_index {
            self.last_seen_index = index;
            true
        } else {
            false
        }
    }

    pub unsafe fn active_frame_ptr(&self) -> *const u8 {
        let index = self.last_seen_index.min(1) as usize;
        debug_assert!((index + 1) * self.frame_byte_size() <= self.total_size);
        self.view_ptr
            .add(index * self.frame_byte_size())
            .cast_const()
    }

    pub fn frame_byte_size(&self) -> usize {
        self.width as usize * self.height as usize * 4
    }

    pub fn dimensions(&self) -> (u32, u32) {
        (self.width, self.height)
    }
}

impl Drop for FrameReader {
    fn drop(&mut self) {
        unsafe {
            let _ = UnmapViewOfFile(MEMORY_MAPPED_VIEW_ADDRESS {
                Value: self.view_ptr.cast(),
            });
            let _ = CloseHandle(self.mapping_handle);
        }
    }
}

unsafe impl Send for FrameReader {}
