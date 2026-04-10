// Windows named-shared-memory reader for the Electron renderer.
//
// Electron 41's V8 forbids external ArrayBuffers/Buffers in renderer contexts,
// so we cannot expose the file-mapped view directly to JS. Instead, this
// addon keeps the mapping internal and provides a memcpy function that reads
// from the (external) mapped pages into a renderer-owned Uint8Array.
//
// The memcpy runs in the renderer process (no IPC) at ~10 GB/s; for 960x540
// RGBA (2 MB) at 60 fps that's ~120 MB/s, well below that limit.

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <napi.h>
#include <string>
#include <cstring>
#include <vector>
#include <memory>

namespace {

struct Mapping {
    HANDLE hMap = nullptr;
    uint8_t* view = nullptr;
    size_t size = 0;

    ~Mapping() {
        if (view)  UnmapViewOfFile(view);
        if (hMap)  CloseHandle(hMap);
    }
};

// Registry so JS holds a plain number handle instead of an External ref
// (Externals also sometimes run afoul of renderer restrictions).
std::vector<std::unique_ptr<Mapping>> g_mappings;

} // namespace

// openSharedMemory(name: string, size: number) → handle (number)
Napi::Value OpenSharedMemory(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 2 || !info[0].IsString() || !info[1].IsNumber()) {
        Napi::TypeError::New(env, "openSharedMemory(name: string, size: number)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }

    std::string name = info[0].As<Napi::String>().Utf8Value();
    size_t size = static_cast<size_t>(info[1].As<Napi::Number>().Int64Value());

    HANDLE hMap = OpenFileMappingA(FILE_MAP_READ | FILE_MAP_WRITE, FALSE, name.c_str());
    if (!hMap) {
        DWORD err = GetLastError();
        Napi::Error::New(env, "OpenFileMappingA failed: " + std::to_string(err))
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }

    void* view = MapViewOfFile(hMap, FILE_MAP_READ | FILE_MAP_WRITE, 0, 0, size);
    if (!view) {
        DWORD err = GetLastError();
        CloseHandle(hMap);
        Napi::Error::New(env, "MapViewOfFile failed: " + std::to_string(err))
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }

    auto m = std::make_unique<Mapping>();
    m->hMap = hMap;
    m->view = static_cast<uint8_t*>(view);
    m->size = size;
    g_mappings.push_back(std::move(m));
    return Napi::Number::New(env, static_cast<double>(g_mappings.size() - 1));
}

// readBytes(handle, dst: Uint8Array, srcOffset: number, length: number) → void
//
// Copies `length` bytes from the mapping at `srcOffset` into `dst` (at dst's
// byteOffset 0). The destination is a renderer-owned Uint8Array; no external
// memory crosses the V8 boundary.
Napi::Value ReadBytes(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 4 || !info[0].IsNumber() || !info[1].IsTypedArray()
        || !info[2].IsNumber() || !info[3].IsNumber()) {
        Napi::TypeError::New(env, "readBytes(handle, dst: Uint8Array, srcOffset, length)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }
    size_t handle = static_cast<size_t>(info[0].As<Napi::Number>().Int64Value());
    Napi::Uint8Array dst = info[1].As<Napi::Uint8Array>();
    size_t srcOffset = static_cast<size_t>(info[2].As<Napi::Number>().Int64Value());
    size_t length    = static_cast<size_t>(info[3].As<Napi::Number>().Int64Value());

    if (handle >= g_mappings.size() || !g_mappings[handle]) {
        Napi::Error::New(env, "invalid handle").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    Mapping* m = g_mappings[handle].get();
    if (srcOffset + length > m->size || length > dst.ByteLength()) {
        Napi::RangeError::New(env, "readBytes out of range").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    std::memcpy(dst.Data(), m->view + srcOffset, length);
    return env.Undefined();
}

// readInt32(handle, srcOffset) → number
//
// Plain aligned int32 read; used to poll the double-buffer control word
// without having to memcpy 2 MB of pixels unnecessarily.
Napi::Value ReadInt32(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsNumber()) {
        Napi::TypeError::New(env, "readInt32(handle, offset)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }
    size_t handle = static_cast<size_t>(info[0].As<Napi::Number>().Int64Value());
    size_t off    = static_cast<size_t>(info[1].As<Napi::Number>().Int64Value());
    if (handle >= g_mappings.size() || !g_mappings[handle]) {
        Napi::Error::New(env, "invalid handle").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    Mapping* m = g_mappings[handle].get();
    if (off + 4 > m->size) {
        Napi::RangeError::New(env, "readInt32 out of range").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    int32_t v;
    std::memcpy(&v, m->view + off, 4);
    return Napi::Number::New(env, v);
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set("openSharedMemory", Napi::Function::New(env, OpenSharedMemory));
    exports.Set("readBytes",        Napi::Function::New(env, ReadBytes));
    exports.Set("readInt32",        Napi::Function::New(env, ReadInt32));
    return exports;
}

NODE_API_MODULE(shm_helper, Init)
