#pragma once

#include <nlohmann/json.hpp>

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <memory>
#include <stdexcept>
#include <string>
#include <type_traits>
#include <utility>
#include <vector>

// A small, structured-value facade used only inside XlethEngineService.cpp.
// Its API mirrors the value operations used by the former host bridge so the
// command bodies can move without changing their engine-side behaviour.
namespace JsonApi
{
namespace detail
{
inline constexpr const char* kType = "$xlethType";
inline constexpr const char* kData = "data";
inline constexpr const char* kAddress = "address";
inline constexpr const char* kByteLength = "byteLength";
inline constexpr const char* kUndefined = "undefined";
inline constexpr const char* kArrayBuffer = "ArrayBuffer";
inline constexpr const char* kBuffer = "Buffer";
inline constexpr const char* kUint8Array = "Uint8Array";
inline constexpr const char* kFloat32Array = "Float32Array";

inline bool hasType(const nlohmann::json& value, const char* type)
{
    return value.is_object()
        && value.value(kType, std::string{}) == type;
}

inline bool isBinaryType(const nlohmann::json& value)
{
    if (!value.is_object()) return false;
    const auto type = value.value(kType, std::string{});
    return type == kArrayBuffer || type == kBuffer
        || type == kUint8Array || type == kFloat32Array;
}

inline nlohmann::json makeOwnedBinary(const char* type,
                                      const std::uint8_t* data,
                                      std::size_t size)
{
    std::vector<std::uint8_t> bytes(size);
    if (size > 0 && data != nullptr)
        std::memcpy(bytes.data(), data, size);
    return {
        {kType, type},
        {kByteLength, size},
        {kData, nlohmann::json::binary(std::move(bytes))},
    };
}

inline nlohmann::json makeExternalBinary(const char* type,
                                         void* data,
                                         std::size_t size)
{
    return {
        {kType, type},
        {kAddress, static_cast<std::uint64_t>(reinterpret_cast<std::uintptr_t>(data))},
        {kByteLength, size},
    };
}
} // namespace detail

class Value;

class Env
{
public:
    Value Undefined() const;
    Value Null() const;
};

class Value
{
public:
    Value()
        : value_(std::make_shared<nlohmann::json>(nlohmann::json{
              {detail::kType, detail::kUndefined}}))
    {
    }

    Value(std::nullptr_t)
        : value_(std::make_shared<nlohmann::json>(nullptr))
    {
    }

    Value(bool value)
        : value_(std::make_shared<nlohmann::json>(value))
    {
    }

    template <typename Number,
              typename = std::enable_if_t<std::is_arithmetic_v<Number>
                                          && !std::is_same_v<Number, bool>>>
    Value(Number value)
        : value_(std::make_shared<nlohmann::json>(value))
    {
    }

    Value(const char* value)
        : value_(std::make_shared<nlohmann::json>(value ? value : ""))
    {
    }

    Value(const std::string& value)
        : value_(std::make_shared<nlohmann::json>(value))
    {
    }

    explicit Value(nlohmann::json value)
        : value_(std::make_shared<nlohmann::json>(std::move(value)))
    {
    }

    bool IsUndefined() const { return detail::hasType(raw(), detail::kUndefined); }
    bool IsNull() const { return raw().is_null(); }
    bool IsBoolean() const { return raw().is_boolean(); }
    bool IsNumber() const { return raw().is_number(); }
    bool IsString() const { return raw().is_string(); }
    bool IsArray() const { return raw().is_array(); }
    bool IsObject() const { return raw().is_object(); }
    bool IsArrayBuffer() const { return detail::hasType(raw(), detail::kArrayBuffer); }
    bool IsBuffer() const { return detail::hasType(raw(), detail::kBuffer); }
    bool IsTypedArray() const
    {
        return IsBuffer()
            || detail::hasType(raw(), detail::kUint8Array)
            || detail::hasType(raw(), detail::kFloat32Array);
    }

    template <typename T>
    T As() const { return T(*this); }

    const nlohmann::json& raw() const { return *value_; }
    nlohmann::json& raw() { return *value_; }

protected:
    explicit Value(std::shared_ptr<nlohmann::json> value)
        : value_(std::move(value))
    {
    }

    std::shared_ptr<nlohmann::json> value_;
};

inline Value Env::Undefined() const { return Value(); }
inline Value Env::Null() const { return Value(nullptr); }

class Boolean : public Value
{
public:
    explicit Boolean(const JsonApi::Value& value) : JsonApi::Value(value) {}
    static Boolean New(Env, bool value) { return Boolean(JsonApi::Value(value)); }
    bool Value() const { return raw().get<bool>(); }
};

class Number : public Value
{
public:
    explicit Number(const Value& value) : Value(value) {}
    static Number New(Env, double value) { return Number(JsonApi::Value(value)); }
    double DoubleValue() const { return raw().get<double>(); }
    float FloatValue() const { return static_cast<float>(DoubleValue()); }
    std::int32_t Int32Value() const { return static_cast<std::int32_t>(DoubleValue()); }
    std::int64_t Int64Value() const { return static_cast<std::int64_t>(DoubleValue()); }
    std::uint32_t Uint32Value() const { return static_cast<std::uint32_t>(DoubleValue()); }
};

class String : public Value
{
public:
    explicit String(const Value& value) : Value(value) {}
    static String New(Env, const std::string& value) { return String(JsonApi::Value(value)); }
    static String New(Env env, const char* value) { return New(env, std::string(value ? value : "")); }
    std::string Utf8Value() const { return raw().get<std::string>(); }
};

class Array;

class Object : public Value
{
public:
    explicit Object(const Value& value) : Value(value) {}
    static Object New(Env) { return Object(JsonApi::Value(nlohmann::json::object())); }

    bool Has(const std::string& key) const
    {
        return raw().is_object() && raw().contains(key);
    }

    Value Get(const std::string& key) const
    {
        if (!Has(key)) return Value();
        return Value(raw().at(key));
    }

    template <typename T>
    void Set(const std::string& key, T&& value)
    {
        JsonApi::Value wrapped(std::forward<T>(value));
        raw()[key] = wrapped.raw();
    }

    template <typename T>
    void Set(std::uint32_t key, T&& value)
    {
        Set(std::to_string(key), std::forward<T>(value));
    }

    Array GetPropertyNames() const;
};

class Array : public Value
{
public:
    explicit Array(const Value& value) : Value(value) {}
    static Array New(Env, std::size_t size = 0)
    {
        nlohmann::json value = nlohmann::json::array();
        while (value.size() < size) value.push_back(nullptr);
        return Array(JsonApi::Value(std::move(value)));
    }

    Array() : Value(nlohmann::json::array()) {}

    std::uint32_t Length() const { return static_cast<std::uint32_t>(raw().size()); }

    Value Get(std::uint32_t index) const
    {
        if (!raw().is_array() || index >= raw().size()) return Value();
        return Value(raw().at(index));
    }

    template <typename T>
    void Set(std::uint32_t index, T&& value)
    {
        while (raw().size() <= index) raw().push_back(nullptr);
        JsonApi::Value wrapped(std::forward<T>(value));
        raw()[index] = wrapped.raw();
    }

    class ElementProxy
    {
    public:
        ElementProxy(Array& array, std::uint32_t index) : array_(array), index_(index) {}

        template <typename T>
        ElementProxy& operator=(T&& value)
        {
            array_.Set(index_, std::forward<T>(value));
            return *this;
        }

        operator Value() const { return array_.Get(index_); }

    private:
        Array& array_;
        std::uint32_t index_;
    };

    ElementProxy operator[](std::uint32_t index) { return ElementProxy(*this, index); }
    Value operator[](std::uint32_t index) const { return Get(index); }
};

inline Array Object::GetPropertyNames() const
{
    Array keys = Array::New(Env{});
    if (!raw().is_object()) return keys;
    std::uint32_t index = 0;
    for (auto it = raw().begin(); it != raw().end(); ++it)
        keys.Set(index++, String::New(Env{}, it.key()));
    return keys;
}

class ArrayBuffer : public Value
{
public:
    explicit ArrayBuffer(const Value& value) : Value(value) {}

    static ArrayBuffer New(Env, std::size_t size)
    {
        std::vector<std::uint8_t> bytes(size);
        nlohmann::json value = {
            {detail::kType, detail::kArrayBuffer},
            {detail::kByteLength, size},
            {detail::kData, nlohmann::json::binary(std::move(bytes))},
        };
        return ArrayBuffer(JsonApi::Value(std::move(value)));
    }

    static ArrayBuffer New(Env, void* data, std::size_t size)
    {
        return ArrayBuffer(JsonApi::Value(
            detail::makeExternalBinary(detail::kArrayBuffer, data, size)));
    }

    void* Data()
    {
        if (raw().contains(detail::kAddress)) {
            const auto address = raw().at(detail::kAddress).get<std::uint64_t>();
            return reinterpret_cast<void*>(static_cast<std::uintptr_t>(address));
        }
        auto& bytes = raw().at(detail::kData).get_binary();
        return bytes.empty() ? nullptr : bytes.data();
    }

    const void* Data() const { return const_cast<ArrayBuffer*>(this)->Data(); }
    std::size_t ByteLength() const { return raw().value(detail::kByteLength, std::size_t{0}); }
};

class TypedArray : public Value
{
public:
    explicit TypedArray(const Value& value) : Value(value) {}

    std::size_t ByteOffset() const { return 0; }
    std::size_t ByteLength() const { return raw().value(detail::kByteLength, std::size_t{0}); }

    ArrayBuffer ArrayBuffer() const
    {
        if (raw().contains(detail::kAddress)) {
            const auto address = raw().at(detail::kAddress).get<std::uint64_t>();
            return JsonApi::ArrayBuffer::New(
                Env{}, reinterpret_cast<void*>(static_cast<std::uintptr_t>(address)), ByteLength());
        }
        nlohmann::json value = raw();
        value[detail::kType] = detail::kArrayBuffer;
        return JsonApi::ArrayBuffer(JsonApi::Value(std::move(value)));
    }
};

class Uint8Array : public TypedArray
{
public:
    explicit Uint8Array(const Value& value) : TypedArray(value) {}

    static Uint8Array New(Env, std::size_t length, const JsonApi::ArrayBuffer& buffer,
                          std::size_t byteOffset)
    {
        const auto* src = static_cast<const std::uint8_t*>(buffer.Data());
        return Uint8Array(JsonApi::Value(detail::makeOwnedBinary(
            detail::kUint8Array, src ? src + byteOffset : nullptr, length)));
    }

    std::uint8_t* Data()
    {
        if (raw().contains(detail::kAddress)) {
            const auto address = raw().at(detail::kAddress).get<std::uint64_t>();
            return reinterpret_cast<std::uint8_t*>(static_cast<std::uintptr_t>(address));
        }
        auto& bytes = raw().at(detail::kData).get_binary();
        return bytes.empty() ? nullptr : bytes.data();
    }

    const std::uint8_t* Data() const { return const_cast<Uint8Array*>(this)->Data(); }
};

class Float32Array : public TypedArray
{
public:
    explicit Float32Array(const Value& value) : TypedArray(value) {}

    static Float32Array New(Env, std::size_t length,
                            const JsonApi::ArrayBuffer& buffer,
                            std::size_t byteOffset)
    {
        const std::size_t byteLength = length * sizeof(float);
        const auto* src = static_cast<const std::uint8_t*>(buffer.Data());
        return Float32Array(JsonApi::Value(detail::makeOwnedBinary(
            detail::kFloat32Array, src ? src + byteOffset : nullptr, byteLength)));
    }
};

template <typename T>
class Buffer : public TypedArray
{
public:
    explicit Buffer(const JsonApi::Value& value) : TypedArray(value) {}

    static Buffer New(Env, std::size_t length)
    {
        return Buffer(JsonApi::Value(detail::makeOwnedBinary(
            detail::kBuffer, nullptr, length * sizeof(T))));
    }

    static Buffer Copy(Env, const T* data, std::size_t length)
    {
        return Buffer(JsonApi::Value(detail::makeOwnedBinary(
            detail::kBuffer,
            reinterpret_cast<const std::uint8_t*>(data),
            length * sizeof(T))));
    }

    T* Data()
    {
        if (this->raw().contains(detail::kAddress)) {
            const auto address = this->raw().at(detail::kAddress).template get<std::uint64_t>();
            return reinterpret_cast<T*>(static_cast<std::uintptr_t>(address));
        }
        auto& bytes = this->raw().at(detail::kData).get_binary();
        return bytes.empty() ? nullptr : reinterpret_cast<T*>(bytes.data());
    }

    const T* Data() const { return const_cast<Buffer*>(this)->Data(); }
    std::size_t Length() const { return this->ByteLength() / sizeof(T); }
};

class CallbackInfo
{
public:
    explicit CallbackInfo(const nlohmann::json& args)
    {
        if (!args.is_array())
            throw std::runtime_error("command args must be an array");
        values_.reserve(args.size());
        for (const auto& arg : args)
            values_.emplace_back(arg);
    }

    std::size_t Length() const { return values_.size(); }
    Value operator[](std::size_t index) const
    {
        return index < values_.size() ? values_[index] : Value();
    }
    JsonApi::Env Env() const { return {}; }

private:
    std::vector<Value> values_;
};

class Error
{
public:
    static Error New(Env, const std::string& message) { return Error(message); }
    static Error New(Env env, const char* message) { return New(env, std::string(message ? message : "")); }

    [[noreturn]] void ThrowAsJavaScriptException() const
    {
        throw std::runtime_error(message_);
    }

protected:
    explicit Error(std::string message) : message_(std::move(message)) {}
    std::string message_;
};

class TypeError : public Error
{
public:
    static TypeError New(Env, const std::string& message) { return TypeError(message); }
    static TypeError New(Env env, const char* message) { return New(env, std::string(message ? message : "")); }

private:
    explicit TypeError(std::string message) : Error(std::move(message)) {}
};

class RangeError : public Error
{
public:
    static RangeError New(Env, const std::string& message) { return RangeError(message); }
    static RangeError New(Env env, const char* message) { return New(env, std::string(message ? message : "")); }

private:
    explicit RangeError(std::string message) : Error(std::move(message)) {}
};
} // namespace JsonApi
