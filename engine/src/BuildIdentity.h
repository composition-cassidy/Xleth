#pragma once

#include <string>

namespace xleth {

struct BuildIdentity
{
    std::string target;
    std::string config;
    std::string gitSha;
    std::string buildUtc;
    std::string compilerDate;
    std::string compilerTime;
};

BuildIdentity getCurrentBuildIdentity();
BuildIdentity getEngineCoreBuildIdentity();

}
