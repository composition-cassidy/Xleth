#pragma once

#include <nlohmann/json_fwd.hpp>

#include <string>

// Process-wide orchestration facade shared by native hosts. The implementation
// deliberately keeps command handlers translation-unit local: they own several
// long-lived worker threads and pointer graphs whose addresses must remain stable.
// Public callers see one structured dispatch boundary and no host-runtime types.
class XlethEngineService
{
public:
    static XlethEngineService& getInstance();

    nlohmann::json dispatch(const std::string& method,
                            const nlohmann::json& args);

private:
    XlethEngineService() = default;
    ~XlethEngineService() = default;

    XlethEngineService(const XlethEngineService&) = delete;
    XlethEngineService& operator=(const XlethEngineService&) = delete;
};
