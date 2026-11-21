#include "audio/PluginBinaryInspector.h"

#include <algorithm>
#include <cctype>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <map>
#include <system_error>

// PE layout constants (winnt.h values, spelled out so this TU needs no Windows
// headers and can never pull in anything that loads a module).
namespace {

constexpr std::uint16_t kDosMagic        = 0x5A4D;     // "MZ"
constexpr std::uint32_t kPeSignature     = 0x00004550; // "PE\0\0"
constexpr std::uint16_t kMachineI386     = 0x014C;
constexpr std::uint16_t kMachineAmd64    = 0x8664;
constexpr std::uint16_t kMachineArm64    = 0xAA64;
constexpr std::uint16_t kOptMagicPE32    = 0x010B;
constexpr std::uint16_t kOptMagicPE32Plus = 0x020B;
constexpr std::uint32_t kDirExport       = 0;          // IMAGE_DIRECTORY_ENTRY_EXPORT
constexpr std::uint32_t kSectionHeaderSize = 40;
constexpr std::uint32_t kExportDirSize   = 40;

// Sanity caps: a real plugin never comes close; a hostile file cannot make
// the parser loop for long or allocate much.
constexpr std::uint32_t kMaxSections   = 96;     // PE loader limit
constexpr std::uint32_t kMaxNames      = 65536;
constexpr std::size_t   kMaxNameLength = 1024;

// Required export per format. ONE line per format — a new format is one entry.
const std::map<std::string, std::vector<std::string>>& exportTable()
{
    static const std::map<std::string, std::vector<std::string>> table = {
        { "VST3", { "GetPluginFactory" } },
        { "VST",  { "VSTPluginMain", "main" } },
        { "CLAP", { "clap_entry" } },
    };
    return table;
}

// Bounded random-access reader over one file.
class FileReader
{
public:
    explicit FileReader(const std::filesystem::path& p)
    {
        std::error_code ec;
        size_ = std::filesystem::file_size(p, ec);
        if (ec) { size_ = 0; return; }
        in_.open(p, std::ios::binary);
    }

    bool        ok()   const { return in_.is_open() && in_.good(); }
    std::uint64_t size() const { return size_; }

    // Reads exactly n bytes at offset. False if any byte lies outside the file.
    bool read(std::uint64_t offset, void* dst, std::uint64_t n)
    {
        if (n == 0) return true;
        if (offset > size_ || n > size_ - offset) return false;
        in_.clear();
        in_.seekg(static_cast<std::streamoff>(offset), std::ios::beg);
        if (!in_) return false;
        in_.read(static_cast<char*>(dst), static_cast<std::streamsize>(n));
        return static_cast<std::uint64_t>(in_.gcount()) == n;
    }

    template <typename T>
    bool readValue(std::uint64_t offset, T& out) { return read(offset, &out, sizeof(T)); }

    // NUL-terminated ASCII string at offset, capped. False if no NUL before
    // the cap or end of file.
    bool readCString(std::uint64_t offset, std::string& out)
    {
        out.clear();
        if (offset >= size_) return false;
        const std::uint64_t avail = std::min<std::uint64_t>(size_ - offset, kMaxNameLength);
        std::string buf(static_cast<std::size_t>(avail), '\0');
        if (!read(offset, buf.data(), avail)) return false;
        const auto nul = buf.find('\0');
        if (nul == std::string::npos) return false;
        out.assign(buf.data(), nul);
        return true;
    }

private:
    std::ifstream in_;
    std::uint64_t size_ = 0;
};

struct Section
{
    std::uint32_t virtualAddress = 0;
    std::uint32_t virtualSize    = 0;
    std::uint32_t rawSize        = 0;
    std::uint32_t rawPointer     = 0;
};

// RVA → file offset over the section table. False if the RVA maps to no file
// bytes (e.g. lies in a section's zero-filled tail, or outside every section).
bool rvaToOffset(std::uint32_t rva, const std::vector<Section>& sections,
                 std::uint32_t sizeOfHeaders, std::uint64_t& out)
{
    for (const auto& s : sections)
    {
        const std::uint64_t span = std::max(s.virtualSize, s.rawSize);
        if (rva >= s.virtualAddress && static_cast<std::uint64_t>(rva) < static_cast<std::uint64_t>(s.virtualAddress) + span)
        {
            const std::uint64_t delta = static_cast<std::uint64_t>(rva) - s.virtualAddress;
            if (delta >= s.rawSize) return false;   // zero-fill tail: not on disk
            out = static_cast<std::uint64_t>(s.rawPointer) + delta;
            return true;
        }
    }
    if (rva < sizeOfHeaders)   // inside the headers, mapped 1:1
    {
        out = rva;
        return true;
    }
    return false;
}

std::string machineName(std::uint16_t m)
{
    switch (m)
    {
        case kMachineAmd64: return "AMD64";
        case kMachineI386:  return "I386";
        case kMachineArm64: return "ARM64";
        default:
        {
            char buf[16];
            std::snprintf(buf, sizeof(buf), "0x%04X", static_cast<unsigned>(m));
            return buf;
        }
    }
}

// C++20: path::u8string() is std::u8string; the API speaks UTF-8 std::string.
std::string toUtf8(const std::filesystem::path& p)
{
    const auto u = p.u8string();
    return std::string(u.begin(), u.end());
}

std::filesystem::path fromUtf8(const std::string& s)
{
    return std::filesystem::path(std::u8string(s.begin(), s.end()));
}

std::string lower(std::string s)
{
    for (auto& c : s) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    return s;
}

// Parses one PE file. formatName empty = no entry-point requirement.
PluginBinaryInfo inspectFile(const std::filesystem::path& file, const std::string& formatName)
{
    PluginBinaryInfo info;
    info.binaryPath = toUtf8(file);

    std::error_code ec;
    if (!std::filesystem::is_regular_file(file, ec))
    {
        info.status = PluginBinaryInfo::Status::Unreadable;
        return info;
    }

    FileReader r(file);
    if (!r.ok())
    {
        info.status = PluginBinaryInfo::Status::Unreadable;
        return info;
    }

    auto notPE = [&]() { info.status = PluginBinaryInfo::Status::NotPE; return info; };

    // ── DOS header ───────────────────────────────────────────────────────────
    std::uint16_t dosMagic = 0;
    std::uint32_t lfanew   = 0;
    if (!r.readValue(0, dosMagic) || dosMagic != kDosMagic) return notPE();
    if (!r.readValue(0x3C, lfanew)) return notPE();

    // ── PE signature + COFF file header ─────────────────────────────────────
    std::uint32_t sig = 0;
    if (!r.readValue(lfanew, sig) || sig != kPeSignature) return notPE();
    const std::uint64_t coff = static_cast<std::uint64_t>(lfanew) + 4;

    std::uint16_t machine = 0, numSections = 0, sizeOfOptional = 0;
    if (!r.readValue(coff + 0, machine)
        || !r.readValue(coff + 2, numSections)
        || !r.readValue(coff + 16, sizeOfOptional))
        return notPE();

    info.machine = machineName(machine);
    if (machine == kMachineI386)
    {
        info.status = PluginBinaryInfo::Status::WrongArch32;
        return info;
    }
    if (machine == kMachineArm64)
    {
        info.status = PluginBinaryInfo::Status::WrongArchArm64;
        return info;
    }
    if (machine != kMachineAmd64)
        return notPE();   // some other architecture: not a binary we could ever load

    // ── Optional header ─────────────────────────────────────────────────────
    const std::uint64_t opt = coff + 20;
    std::uint16_t optMagic = 0;
    if (!r.readValue(opt, optMagic)) return notPE();

    std::uint64_t dirsAt = 0, numDirsAt = 0;
    if (optMagic == kOptMagicPE32Plus)      { numDirsAt = opt + 108; dirsAt = opt + 112; }
    else if (optMagic == kOptMagicPE32)     { numDirsAt = opt + 92;  dirsAt = opt + 96;  }
    else return notPE();

    std::uint32_t sizeOfHeaders = 0, numDirs = 0;
    if (!r.readValue(opt + 60, sizeOfHeaders)) return notPE();
    if (!r.readValue(numDirsAt, numDirs)) return notPE();
    // The data directories must fit inside the declared optional header.
    if (dirsAt + 8ull * std::min<std::uint32_t>(numDirs, 16) > opt + sizeOfOptional) return notPE();

    // ── Section table ────────────────────────────────────────────────────────
    if (numSections == 0 || numSections > kMaxSections) return notPE();
    const std::uint64_t secAt = opt + sizeOfOptional;
    std::vector<Section> sections;
    sections.reserve(numSections);
    for (std::uint32_t i = 0; i < numSections; ++i)
    {
        std::uint8_t raw[kSectionHeaderSize];
        if (!r.read(secAt + static_cast<std::uint64_t>(i) * kSectionHeaderSize, raw, sizeof(raw)))
            return notPE();
        Section s;
        std::memcpy(&s.virtualSize,    raw + 8,  4);
        std::memcpy(&s.virtualAddress, raw + 12, 4);
        std::memcpy(&s.rawSize,        raw + 16, 4);
        std::memcpy(&s.rawPointer,     raw + 20, 4);
        sections.push_back(s);
    }

    // ── Export directory ─────────────────────────────────────────────────────
    std::uint32_t expRva = 0, expSize = 0;
    if (numDirs > kDirExport)
    {
        if (!r.readValue(dirsAt + 8ull * kDirExport, expRva)
            || !r.readValue(dirsAt + 8ull * kDirExport + 4, expSize))
            return notPE();
    }

    if (expRva != 0 && expSize != 0)
    {
        std::uint64_t expOff = 0;
        if (!rvaToOffset(expRva, sections, sizeOfHeaders, expOff)) return notPE();

        std::uint8_t dir[kExportDirSize];
        if (!r.read(expOff, dir, sizeof(dir))) return notPE();
        std::uint32_t numNames = 0, namesRva = 0;
        std::memcpy(&numNames, dir + 24, 4);
        std::memcpy(&namesRva, dir + 32, 4);
        if (numNames > kMaxNames) return notPE();

        if (numNames > 0)
        {
            std::uint64_t namesOff = 0;
            if (!rvaToOffset(namesRva, sections, sizeOfHeaders, namesOff)) return notPE();
            std::vector<std::uint32_t> nameRvas(numNames);
            if (!r.read(namesOff, nameRvas.data(), 4ull * numNames)) return notPE();

            info.exports.reserve(numNames);
            for (std::uint32_t nameRva : nameRvas)
            {
                std::uint64_t nameOff = 0;
                std::string name;
                if (!rvaToOffset(nameRva, sections, sizeOfHeaders, nameOff)
                    || !r.readCString(nameOff, name))
                    return notPE();
                info.exports.push_back(std::move(name));
            }
        }
    }

    // ── Entry point for the format ──────────────────────────────────────────
    const auto& required = PluginBinaryInspector::requiredExports(formatName);
    if (!required.empty())
    {
        const bool found = std::any_of(required.begin(), required.end(), [&](const std::string& e) {
            return std::find(info.exports.begin(), info.exports.end(), e) != info.exports.end();
        });
        if (!found)
        {
            info.status = PluginBinaryInfo::Status::NoEntryPoint;
            return info;
        }
    }

    info.status = PluginBinaryInfo::Status::Ok;
    return info;
}

// VST3 bundle directory → the inner binary to parse, or a final status.
bool resolveVst3Bundle(const std::filesystem::path& bundle, std::filesystem::path& out,
                       PluginBinaryInfo& early)
{
    std::error_code ec;
    const auto contents = bundle / "Contents";
    const auto stem     = bundle.stem();   // "Foo" of "Foo.vst3"

    const auto x64 = contents / "x86_64-win";
    if (std::filesystem::is_directory(x64, ec))
    {
        auto exact = x64 / stem;
        exact += ".vst3";
        if (std::filesystem::is_regular_file(exact, ec)) { out = exact; return true; }

        // Bundle renamed after build: the spec requires the inner name to match,
        // but hosts in the wild accept the single .vst3 inside. Take the first.
        for (const auto& e : std::filesystem::directory_iterator(x64, ec))
        {
            if (e.is_regular_file(ec) && lower(toUtf8(e.path().extension())) == ".vst3")
            {
                out = e.path();
                return true;
            }
        }
    }

    early.binaryPath = toUtf8(bundle);
    if (std::filesystem::is_directory(contents / "x86-win", ec))
    {
        early.status  = PluginBinaryInfo::Status::WrongArch32;
        early.machine = "I386";
        return false;
    }
    if (std::filesystem::is_directory(contents / "arm64-win", ec)
        || std::filesystem::is_directory(contents / "arm64ec-win", ec)
        || std::filesystem::is_directory(contents / "arm64x-win", ec))
    {
        early.status  = PluginBinaryInfo::Status::WrongArchArm64;
        early.machine = "ARM64";
        return false;
    }
    early.status = PluginBinaryInfo::Status::NotPE;   // bundle with no Windows binary
    return false;
}

PluginBinaryInfo inspectPath(const std::filesystem::path& path, const std::string& formatName)
{
    std::error_code ec;
    if (std::filesystem::is_directory(path, ec))
    {
        PluginBinaryInfo early;
        std::filesystem::path inner;
        if (lower(toUtf8(path.extension())) != ".vst3")
        {
            early.binaryPath = toUtf8(path);
            early.status     = PluginBinaryInfo::Status::NotPE;
            return early;
        }
        if (!resolveVst3Bundle(path, inner, early))
            return early;
        return inspectFile(inner, formatName);
    }
    if (!std::filesystem::exists(path, ec))
    {
        PluginBinaryInfo info;
        info.binaryPath = toUtf8(path);
        info.status     = PluginBinaryInfo::Status::Unreadable;
        return info;
    }
    return inspectFile(path, formatName);
}

} // namespace

namespace PluginBinaryInspector
{

PluginBinaryInfo inspect(const std::string& path, const std::string& formatName)
{
    return inspectPath(fromUtf8(path), formatName);
}

PluginBinaryInfo inspect(const std::wstring& path, const std::string& formatName)
{
    return inspectPath(std::filesystem::path(path), formatName);
}

const std::vector<std::string>& requiredExports(const std::string& formatName)
{
    static const std::vector<std::string> none;
    const auto& t  = exportTable();
    const auto  it = t.find(formatName);
    return it != t.end() ? it->second : none;
}

const char* failureReason(PluginBinaryInfo::Status status)
{
    switch (status)
    {
        case PluginBinaryInfo::Status::Ok:             return "";
        case PluginBinaryInfo::Status::NotPE:          return "not-a-binary";
        case PluginBinaryInfo::Status::WrongArch32:    return "not-64bit";
        case PluginBinaryInfo::Status::WrongArchArm64: return "arm64";
        case PluginBinaryInfo::Status::NoEntryPoint:   return "no-entry-point";
        case PluginBinaryInfo::Status::Unreadable:     return "unreadable";
    }
    return "unreadable";
}

const char* statusName(PluginBinaryInfo::Status status)
{
    switch (status)
    {
        case PluginBinaryInfo::Status::Ok:             return "Ok";
        case PluginBinaryInfo::Status::NotPE:          return "NotPE";
        case PluginBinaryInfo::Status::WrongArch32:    return "WrongArch32";
        case PluginBinaryInfo::Status::WrongArchArm64: return "WrongArchArm64";
        case PluginBinaryInfo::Status::NoEntryPoint:   return "NoEntryPoint";
        case PluginBinaryInfo::Status::Unreadable:     return "Unreadable";
    }
    return "?";
}

} // namespace PluginBinaryInspector
