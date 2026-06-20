// Threading model: Case B. XlethEngineService has no direct callAsync calls,
// but editor-host callbacks are fire-and-forget and several service operations
// explicitly require the JUCE message thread. The pipe thread therefore uses
// callFunctionOnMessageThread() for every synchronous dispatch.

#ifndef NOMINMAX
#define NOMINMAX
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif

#include <windows.h>

#include <juce_events/juce_events.h>
#include <juce_gui_basics/juce_gui_basics.h>
#include <nlohmann/json.hpp>

#include "XlethEngineService.h"

#include <algorithm>
#include <array>
#include <atomic>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <exception>
#include <limits>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

namespace {

constexpr wchar_t kPipeName[] = LR"(\\.\pipe\XlethEngine)";
constexpr std::uint32_t kMaxFrameBytes = 64U * 1024U * 1024U;

std::string base64Encode(const std::uint8_t* data, std::size_t size)
{
    static constexpr char alphabet[] =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string out;
    out.reserve(((size + 2U) / 3U) * 4U);
    for (std::size_t i = 0; i < size; i += 3U) {
        const std::uint32_t a = data[i];
        const std::uint32_t b = i + 1U < size ? data[i + 1U] : 0U;
        const std::uint32_t c = i + 2U < size ? data[i + 2U] : 0U;
        const std::uint32_t value = (a << 16U) | (b << 8U) | c;
        out.push_back(alphabet[(value >> 18U) & 0x3fU]);
        out.push_back(alphabet[(value >> 12U) & 0x3fU]);
        out.push_back(i + 1U < size ? alphabet[(value >> 6U) & 0x3fU] : '=');
        out.push_back(i + 2U < size ? alphabet[value & 0x3fU] : '=');
    }
    return out;
}

std::vector<std::uint8_t> base64Decode(const std::string& text)
{
    static constexpr signed char invalid = -1;
    static const auto table = [] {
        std::array<signed char, 256> values{};
        values.fill(invalid);
        const std::string alphabet =
            "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        for (std::size_t i = 0; i < alphabet.size(); ++i)
            values[static_cast<unsigned char>(alphabet[i])] = static_cast<signed char>(i);
        return values;
    }();

    if (text.size() % 4U != 0U)
        throw std::runtime_error("invalid base64 length");

    std::vector<std::uint8_t> out;
    out.reserve((text.size() / 4U) * 3U);
    for (std::size_t i = 0; i < text.size(); i += 4U) {
        const bool pad2 = text[i + 2U] == '=';
        const bool pad3 = text[i + 3U] == '=';
        if ((pad2 && !pad3) || (i + 4U != text.size() && (pad2 || pad3)))
            throw std::runtime_error("invalid base64 padding");

        const auto decode = [&](std::size_t index) -> std::uint32_t {
            if (text[index] == '=') return 0U;
            const auto value = table[static_cast<unsigned char>(text[index])];
            if (value == invalid) throw std::runtime_error("invalid base64 character");
            return static_cast<std::uint32_t>(value);
        };
        const std::uint32_t value = (decode(i) << 18U) | (decode(i + 1U) << 12U)
                                  | (decode(i + 2U) << 6U) | decode(i + 3U);
        out.push_back(static_cast<std::uint8_t>((value >> 16U) & 0xffU));
        if (!pad2) out.push_back(static_cast<std::uint8_t>((value >> 8U) & 0xffU));
        if (!pad3) out.push_back(static_cast<std::uint8_t>(value & 0xffU));
    }
    return out;
}

void decodeBinaryArguments(nlohmann::json& value)
{
    if (value.is_array()) {
        for (auto& item : value) decodeBinaryArguments(item);
        return;
    }
    if (!value.is_object()) return;

    if (value.size() == 1U && value.contains("__b64__")
        && value.at("__b64__").is_string()) {
        auto bytes = base64Decode(value.at("__b64__").get<std::string>());
        const auto size = bytes.size();
        value = {
            {"$xlethType", "Buffer"},
            {"byteLength", size},
            {"data", nlohmann::json::binary(std::move(bytes))},
        };
        return;
    }

    for (auto& [key, item] : value.items()) {
        (void)key;
        decodeBinaryArguments(item);
    }
}

std::vector<std::uint8_t> copyServiceBinary(const nlohmann::json& value)
{
    const auto byteLength = value.value("byteLength", std::size_t{0});
    if (byteLength > kMaxFrameBytes)
        throw std::runtime_error("binary result exceeds maximum frame size");

    if (value.contains("data") && value.at("data").is_binary()) {
        const auto& bytes = value.at("data").get_binary();
        return std::vector<std::uint8_t>(bytes.begin(), bytes.end());
    }
    if (value.contains("address")) {
        const auto address = value.at("address").get<std::uint64_t>();
        if (address == 0U || byteLength == 0U) return {};
        const auto* data = reinterpret_cast<const std::uint8_t*>(
            static_cast<std::uintptr_t>(address));
        return std::vector<std::uint8_t>(data, data + byteLength);
    }
    return {};
}

void encodeBinaryResults(nlohmann::json& value)
{
    if (value.is_array()) {
        for (auto& item : value) encodeBinaryResults(item);
        return;
    }
    if (!value.is_object()) return;

    const auto type = value.value("$xlethType", std::string{});
    if (type == "undefined") {
        value = nullptr;
        return;
    }
    if (type == "Buffer" || type == "ArrayBuffer"
        || type == "Uint8Array" || type == "Float32Array") {
        const auto bytes = copyServiceBinary(value);
        if (type == "Float32Array") {
            nlohmann::json numbers = nlohmann::json::array();
            numbers.get_ref<nlohmann::json::array_t&>().reserve(bytes.size() / sizeof(float));
            for (std::size_t offset = 0; offset + sizeof(float) <= bytes.size();
                 offset += sizeof(float)) {
                float number = 0.0f;
                std::memcpy(&number, bytes.data() + offset, sizeof(float));
                numbers.push_back(number);
            }
            value = std::move(numbers);
        } else if (type == "Uint8Array") {
            value = nlohmann::json::array();
            for (const auto byte : bytes) value.push_back(byte);
        } else {
            value = {{"__b64__", base64Encode(bytes.data(), bytes.size())}};
        }
        return;
    }

    for (auto& [key, item] : value.items()) {
        (void)key;
        encodeBinaryResults(item);
    }
}

bool readExact(HANDLE pipe, void* destination, std::size_t size)
{
    auto* out = static_cast<std::uint8_t*>(destination);
    std::size_t offset = 0;
    while (offset < size) {
        DWORD bytesRead = 0;
        const DWORD wanted = static_cast<DWORD>(std::min<std::size_t>(
            size - offset, std::numeric_limits<DWORD>::max()));
        if (!::ReadFile(pipe, out + offset, wanted, &bytesRead, nullptr)
            || bytesRead == 0U)
            return false;
        offset += bytesRead;
    }
    return true;
}

bool writeExact(HANDLE pipe, const void* source, std::size_t size)
{
    const auto* data = static_cast<const std::uint8_t*>(source);
    std::size_t offset = 0;
    while (offset < size) {
        DWORD bytesWritten = 0;
        const DWORD wanted = static_cast<DWORD>(std::min<std::size_t>(
            size - offset, std::numeric_limits<DWORD>::max()));
        if (!::WriteFile(pipe, data + offset, wanted, &bytesWritten, nullptr)
            || bytesWritten == 0U)
            return false;
        offset += bytesWritten;
    }
    return true;
}

bool readFrame(HANDLE pipe, std::string& payload)
{
    std::uint8_t header[4]{};
    if (!readExact(pipe, header, sizeof(header))) return false;
    const std::uint32_t size = static_cast<std::uint32_t>(header[0])
        | (static_cast<std::uint32_t>(header[1]) << 8U)
        | (static_cast<std::uint32_t>(header[2]) << 16U)
        | (static_cast<std::uint32_t>(header[3]) << 24U);
    if (size > kMaxFrameBytes)
        throw std::runtime_error("incoming frame exceeds 64 MiB");
    payload.resize(size);
    return size == 0U || readExact(pipe, payload.data(), size);
}

bool writeFrame(HANDLE pipe, const nlohmann::json& message)
{
    const std::string payload = message.dump();
    if (payload.size() > kMaxFrameBytes)
        throw std::runtime_error("outgoing frame exceeds 64 MiB");
    const auto size = static_cast<std::uint32_t>(payload.size());
    const std::uint8_t header[4] = {
        static_cast<std::uint8_t>(size & 0xffU),
        static_cast<std::uint8_t>((size >> 8U) & 0xffU),
        static_cast<std::uint8_t>((size >> 16U) & 0xffU),
        static_cast<std::uint8_t>((size >> 24U) & 0xffU),
    };
    return writeExact(pipe, header, sizeof(header))
        && writeExact(pipe, payload.data(), payload.size());
}

struct DispatchCall {
    std::string method;
    nlohmann::json args;
    nlohmann::json result;
    std::exception_ptr error;
};

void* dispatchOnMessageThread(void* userData)
{
    auto& call = *static_cast<DispatchCall*>(userData);
    try {
        call.result = XlethEngineService::getInstance().dispatch(call.method, call.args);
    } catch (...) {
        call.error = std::current_exception();
    }
    return nullptr;
}

nlohmann::json dispatchSynchronously(std::string method, nlohmann::json args)
{
    DispatchCall call{std::move(method), std::move(args), nullptr, nullptr};
    juce::MessageManager::getInstance()->callFunctionOnMessageThread(
        dispatchOnMessageThread, &call);
    if (call.error) std::rethrow_exception(call.error);
    return std::move(call.result);
}

bool isUnknownCommand(const std::exception& error)
{
    constexpr char prefix[] = "Unknown engine command:";
    return std::strncmp(error.what(), prefix, sizeof(prefix) - 1U) == 0;
}

void runPipeServer(std::atomic<bool>& stopped, std::atomic<bool>& serverFailed)
{
    HANDLE pipe = ::CreateNamedPipeW(
        kPipeName,
        PIPE_ACCESS_DUPLEX,
        PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
        1,
        65536,
        65536,
        0,
        nullptr);
    if (pipe == INVALID_HANDLE_VALUE) {
        std::fprintf(stderr, "[engine-sidecar] CreateNamedPipe failed: %lu\n",
                     static_cast<unsigned long>(::GetLastError()));
        serverFailed = true;
        stopped = true;
        juce::MessageManager::getInstance()->stopDispatchLoop();
        return;
    }

    while (!stopped.load()) {
        const BOOL connected = ::ConnectNamedPipe(pipe, nullptr)
            ? TRUE
            : (::GetLastError() == ERROR_PIPE_CONNECTED ? TRUE : FALSE);
        if (!connected) {
            if (!stopped.load())
                std::fprintf(stderr, "[engine-sidecar] ConnectNamedPipe failed: %lu\n",
                             static_cast<unsigned long>(::GetLastError()));
            ::DisconnectNamedPipe(pipe);
            continue;
        }
        std::fprintf(stderr, "[engine-sidecar] pipe client connected\n");

        bool keepClient = true;
        while (keepClient && !stopped.load()) {
            std::string payload;
            try {
                if (!readFrame(pipe, payload)) break;
                auto command = nlohmann::json::parse(payload);
                const auto id = command.at("id");
                const auto method = command.at("method").get<std::string>();
                auto args = command.value("args", nlohmann::json::array());
                if (!args.is_array()) throw std::runtime_error("command args must be an array");

                if (method == "sidecar_shutdown") {
                    keepClient = writeFrame(pipe, {{"id", id}, {"result", "ok"}});
                    stopped = true;
                    juce::MessageManager::getInstance()->stopDispatchLoop();
                    break;
                }

                decodeBinaryArguments(args);
                try {
                    auto result = dispatchSynchronously(method, std::move(args));
                    encodeBinaryResults(result);
                    keepClient = writeFrame(pipe, {{"id", id}, {"result", std::move(result)}});
                } catch (const std::exception& error) {
                    if (isUnknownCommand(error))
                        keepClient = writeFrame(pipe, {{"id", id}, {"notImplemented", true}});
                    else
                        keepClient = writeFrame(pipe, {{"id", id}, {"error", error.what()}});
                } catch (...) {
                    keepClient = writeFrame(
                        pipe, {{"id", id}, {"error", "unknown native exception"}});
                }
            } catch (const std::exception& error) {
                std::fprintf(stderr, "[engine-sidecar] command error: %s\n", error.what());
                // A malformed command may not have a usable id. Keep the stream
                // alive and use id 0 so a diagnostic client can observe the error.
                keepClient = writeFrame(pipe, {{"id", 0}, {"error", error.what()}});
            }
        }

        ::FlushFileBuffers(pipe);
        ::DisconnectNamedPipe(pipe);
        if (!stopped.load())
            std::fprintf(stderr, "[engine-sidecar] pipe client disconnected; waiting\n");
    }

    ::CloseHandle(pipe);
}

} // namespace

int main(int, char**)
{
    juce::ScopedJuceInitialiser_GUI juceInit;
    std::atomic<bool> stopped{false};
    std::atomic<bool> serverFailed{false};
    std::thread pipeThread([&] { runPipeServer(stopped, serverFailed); });

    juce::MessageManager::getInstance()->runDispatchLoop();

    stopped = true;
    if (pipeThread.joinable()) pipeThread.join();
    try {
        XlethEngineService::getInstance().dispatch("shutdown", nlohmann::json::array());
    } catch (const std::exception& error) {
        std::fprintf(stderr, "[engine-sidecar] shutdown error: %s\n", error.what());
    }
    return serverFailed.load() ? 1 : 0;
}
