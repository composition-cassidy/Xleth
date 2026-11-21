// Shim: JUCE includes <pluginterfaces/vst2.x/aeffectx.h>. FST ships its own compat header of that name
// (third_party/fst/fst/aeffectx.h), so this file only forwards to it. No VST2 definitions live here.
//
// FST 0.115.0 defines FST_DEPRECATE_UNKNOWN(x) only for GCC/clang, so under MSVC every "unknown" opcode
// fails to compile. FST_DONT_DEPRECATE_UNKNOWN is the switch FST itself documents for this (it makes the
// macro expand to plain x); it only drops the deprecation marker, it does not change any value.
#ifndef FST_DONT_DEPRECATE_UNKNOWN
 #define FST_DONT_DEPRECATE_UNKNOWN 1
#endif
#include "../../../fst/fst/aeffectx.h"
