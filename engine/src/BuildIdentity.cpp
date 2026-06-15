#include "BuildIdentity.h"

#ifndef XLETH_BUILD_GIT_SHA
#  define XLETH_BUILD_GIT_SHA "unknown"
#endif

#ifndef XLETH_BUILD_UTC
#  define XLETH_BUILD_UTC "unknown"
#endif

namespace xleth {

namespace {

BuildIdentity make(const char* target)
{
    BuildIdentity id;
    id.target = target;
#if defined(XLETH_BUILD_CONFIG)
    id.config = XLETH_BUILD_CONFIG;
#elif defined(NDEBUG)
    id.config = "Release";
#else
    id.config = "Debug";
#endif
    id.gitSha       = XLETH_BUILD_GIT_SHA;
    id.buildUtc     = XLETH_BUILD_UTC;
    id.compilerDate = __DATE__;
    id.compilerTime = __TIME__;
    return id;
}

}

BuildIdentity getEngineCoreBuildIdentity()
{
    return make("engine-core");
}

BuildIdentity getCurrentBuildIdentity()
{
#ifdef XLETH_BUILD_TARGET
    return make(XLETH_BUILD_TARGET);
#else
    return make("engine-core");
#endif
}

}
