#pragma once

#include "util/SpscRing.h"

struct TriggerEvent
{
    int   sampleId = -1;
    float velocity = 1.0f;
};

// Producer (GUI/input thread) calls push(); consumer (audio thread) calls pop().
using TriggerQueue = xleth::util::SpscRing<TriggerEvent>;
